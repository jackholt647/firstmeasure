import crypto from "node:crypto";

import { previewSolarProperty } from "../lead-intake/solar.js";
import type { WeatherReportRequest, WeatherTier } from "./schemas.js";
import { buildStormEventSummaries } from "./events.js";
import { generateGeminiSummary } from "./gemini.js";
import { resolveProperty } from "./geocode.js";
import { buildHailTraceStyleHistory } from "./hailtrace_model.js";
import { fetchIemLocalStormReports, fetchIemWarnings } from "./iem.js";
import { round } from "./math.js";
import { fetchMrmsMesh } from "./mrms.js";
import { fetchSwdiDataset, mrmsArchiveLinks, nexradArchiveLinks, type SwdiDataset } from "./noaa.js";
import { saveWeatherReport } from "./storage.js";
import { buildStormAreas } from "./storm_areas.js";
import type { GeoPoint, WeatherFinding, WeatherRecord, WeatherReport, WeatherSolarPreview, WeatherSource, WeatherStormArea } from "./types.js";

const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_HISTORY_START_DATE = "2010-12-31";

export async function buildWeatherReport(input: WeatherReportRequest): Promise<{ report: WeatherReport; stored_path: string | null }> {
  const timeoutMs = input.source_timeout_ms ?? DEFAULT_TIMEOUT_MS;
  const property = await resolveProperty(input.property, timeoutMs);
  const range = resolveDateRange(input);
  const radiusMiles = input.radius_miles ?? defaultRadius(input.tier);
  const datasets = datasetsForTier(input.tier);
  const swdiDatasets = datasets.filter((dataset): dataset is SwdiDataset => isSwdiDataset(dataset));
  const swdiResults = await Promise.all(swdiDatasets.map((dataset) => fetchSwdiDataset({
    point: property,
    start: range.start,
    end: range.end,
    radiusMiles,
    dataset,
    timeoutMs
  })));
  const includeIemWarnings = datasets.includes("iem_warning") && shouldFetchIemWarnings(input.tier, range.start, range.end);
  const iemResults = await Promise.all([
    datasets.includes("iem_lsr") ? fetchIemLocalStormReports({ point: property, start: range.start, end: range.end, radiusMiles, timeoutMs }) : null,
    includeIemWarnings ? fetchIemWarnings({ point: property, start: range.start, end: range.end, radiusMiles, timeoutMs }) : skippedIemWarningsSource(input.tier, range.start, range.end)
  ]);
  const results = [...swdiResults, ...iemResults.filter((result): result is NonNullable<typeof result> => result != null)];
  const sourceResults: Array<{ source: WeatherSource; records: WeatherRecord[] }> = [...results];
  const records = results.flatMap((result) => result.records);
  const filteredBeforeMrms = filterPeril(records, input.peril);
  const mrmsResult = shouldFetchMrms(input.tier, input.peril)
    ? await fetchMrmsMesh({ point: property, start: range.start, end: range.end, radiusMiles, seedRecords: filteredBeforeMrms, timeoutMs })
    : null;
  if (mrmsResult) sourceResults.push({ source: mrmsResult.source, records: mrmsResult.records });
  const filtered = mrmsResult ? [...filteredBeforeMrms, ...mrmsResult.records] : filteredBeforeMrms;
  const findings = buildFindings(filtered);
  const stormEvents = buildStormEventSummaries(property, filtered);
  const modeledHistoryEvents = input.tier === "comprehensive"
    ? buildHailTraceStyleHistory(property, filtered)
    : [];
  const stormAreas = input.tier === "comprehensive" || input.tier === "complex" || input.peril === "all"
    ? sortStormAreas([...(mrmsResult?.stormAreas ?? []), ...buildStormAreas(property, filtered)])
    : [];
  const solarPreview = await buildSolarPreview(property);
  const summary = await buildSummary(input, findings, filtered, timeoutMs);
  const report: WeatherReport = {
    id: crypto.randomUUID(),
    tier: input.tier,
    generated_at: new Date().toISOString(),
    property,
    request: {
      ...input,
      source_timeout_ms: timeoutMs,
      radius_miles: radiusMiles,
      resolved_start: range.start.toISOString(),
      resolved_end: range.end.toISOString()
    },
    sources: sourceResults.map((result) => result.source),
    records: filtered,
    findings,
    storm_events: stormEvents,
    modeled_history_events: modeledHistoryEvents,
    storm_areas: stormAreas,
    solar_preview: solarPreview,
    summary,
    artifacts: artifactLinks(input.tier, property, filtered, range.start)
  };
  const storedPath = input.persist ? await saveWeatherReport(report) : null;
  return { report, stored_path: storedPath };
}

async function buildSolarPreview(property: GeoPoint): Promise<WeatherSolarPreview | null> {
  try {
    const result = await previewSolarProperty({
      address: property.address ?? undefined,
      latitude: property.lat,
      longitude: property.lon,
      tint: "#c82828",
      imageSource: "solar"
    }) as Record<string, unknown>;
    return {
      status: String(result.status ?? (result.ok ? "ready" : "unavailable")),
      source: stringOrNull(result.source),
      image: stringOrNull(result.image),
      mask: null,
      formatted_address: stringOrNull(result.formatted_address),
      imagery_quality: stringOrNull(result.imagery_quality),
      imagery_date: objectOrNull(result.imagery_date),
      error: stringOrNull(result.error)
    };
  } catch (error) {
    return {
      status: "error",
      error: error instanceof Error ? error.message : String(error)
    };
  }
}

export async function pullWeatherData(input: {
  property: { address?: string; lat?: number; lon?: number };
  start_date: string;
  end_date: string;
  radius_miles: number;
  datasets: Array<SwdiDataset | "iem_lsr" | "iem_warning">;
  source_timeout_ms?: number;
}) {
  const timeoutMs = input.source_timeout_ms ?? DEFAULT_TIMEOUT_MS;
  const property = await resolveProperty(input.property, timeoutMs);
  const start = parseDate(input.start_date, false);
  const end = parseDate(input.end_date, true);
  const swdiDatasets = input.datasets.filter((dataset): dataset is SwdiDataset => isSwdiDataset(dataset));
  const swdiResults = await Promise.all(swdiDatasets.map((dataset) => fetchSwdiDataset({
    point: property,
    start,
    end,
    radiusMiles: input.radius_miles,
    dataset,
    timeoutMs
  })));
  const iemResults = await Promise.all([
    input.datasets.includes("iem_lsr") ? fetchIemLocalStormReports({ point: property, start, end, radiusMiles: input.radius_miles, timeoutMs }) : null,
    input.datasets.includes("iem_warning") ? fetchIemWarnings({ point: property, start, end, radiusMiles: input.radius_miles, timeoutMs }) : null
  ]);
  const results = [...swdiResults, ...iemResults.filter((result): result is NonNullable<typeof result> => result != null)];
  return {
    property,
    start: start.toISOString(),
    end: end.toISOString(),
    radius_miles: input.radius_miles,
    sources: results.map((result) => result.source),
    records: results.flatMap((result) => result.records)
  };
}

function resolveDateRange(input: WeatherReportRequest) {
  if (input.tier === "history" || input.tier === "comprehensive") {
    const end = parseDate(input.end_date ?? new Date().toISOString(), true);
    const start = parseDate(input.start_date ?? input.date_of_loss ?? DEFAULT_HISTORY_START_DATE, false);
    return { start, end };
  }
  const loss = parseDate(input.date_of_loss ?? "", false);
  const start = new Date(loss.getTime() - 6 * 60 * 60 * 1000);
  const end = new Date(loss.getTime() + 18 * 60 * 60 * 1000);
  return { start, end };
}

function parseDate(value: string, endOfDay: boolean) {
  const normalized = /^\d{4}-\d{2}-\d{2}$/.test(value)
    ? `${value}T${endOfDay ? "23:59:59" : "00:00:00"}Z`
    : value;
  const date = new Date(normalized);
  if (!Number.isFinite(date.getTime())) {
    throw new Error(`Invalid date: ${value}`);
  }
  return date;
}

function defaultRadius(tier: WeatherTier) {
  if (tier === "history") return 8;
  if (tier === "comprehensive") return 12;
  if (tier === "reviewed") return 12;
  return 20;
}

function datasetsForTier(tier: WeatherTier): Array<SwdiDataset | "iem_lsr" | "iem_warning"> {
  if (tier === "history") return ["nx3hail", "plsr", "iem_lsr"];
  if (tier === "reviewed") return ["nx3hail", "plsr", "warn", "iem_lsr", "iem_warning"];
  if (tier === "comprehensive") return ["nx3hail", "plsr", "warn", "nx3structure", "nx3meso", "nx3tvs", "iem_lsr", "iem_warning"];
  return ["nx3hail", "plsr", "warn", "nx3structure", "nx3meso", "iem_lsr", "iem_warning"];
}

function isSwdiDataset(dataset: string): dataset is SwdiDataset {
  return dataset === "nx3hail" || dataset === "plsr" || dataset === "warn" || dataset === "nx3structure" || dataset === "nx3meso" || dataset === "nx3tvs";
}

function shouldFetchMrms(tier: WeatherTier, peril: WeatherReportRequest["peril"]) {
  return (tier === "comprehensive" || tier === "complex") && (peril === "all" || peril === "hail");
}

function sortStormAreas(areas: WeatherStormArea[]) {
  return areas
    .sort((a, b) => {
      const typeWeight = areaTypeWeight(b.area_type) - areaTypeWeight(a.area_type);
      if (typeWeight !== 0) return typeWeight;
      const containsDelta = Number(b.contains_property === true) - Number(a.contains_property === true);
      if (containsDelta !== 0) return containsDelta;
      const magnitudeDelta = (b.magnitude ?? -1) - (a.magnitude ?? -1);
      if (magnitudeDelta !== 0) return magnitudeDelta;
      return b.date.localeCompare(a.date);
    })
    .slice(0, 100);
}

function areaTypeWeight(type: WeatherStormArea["area_type"]) {
  if (type === "mrms_mesh_contour") return 4;
  if (type === "warning_polygon") return 3;
  if (type === "estimated_swath") return 2;
  return 1;
}

function filterPeril(records: WeatherRecord[], peril: WeatherReportRequest["peril"]) {
  if (peril === "all") return records;
  return records.filter((record) => {
    const haystack = `${record.dataset} ${record.event_type ?? ""} ${JSON.stringify(record.raw)}`.toLowerCase();
    return haystack.includes(peril);
  });
}

function buildFindings(records: WeatherRecord[]): WeatherFinding[] {
  const byDay = new Map<string, WeatherRecord[]>();
  for (const record of records) {
    const day = String(record.observed_at ?? "unknown").slice(0, 10) || "unknown";
    const existing = byDay.get(day) ?? [];
    existing.push(record);
    byDay.set(day, existing);
  }
  return [...byDay.entries()].map(([date, dayRecords]) => {
    const magnitudes = dayRecords.map((record) => record.magnitude).filter((value): value is number => value != null);
    const distances = dayRecords.map((record) => record.distance_miles).filter((value): value is number => value != null);
    const maxMagnitude = magnitudes.length ? Math.max(...magnitudes) : null;
    const nearest = distances.length ? Math.min(...distances) : null;
    const hasRadar = dayRecords.some((record) => record.dataset.startsWith("nx3"));
    const hasReport = dayRecords.some((record) => record.dataset === "plsr" || record.dataset === "iem_lsr");
    const hasWarning = dayRecords.some((record) => record.dataset === "iem_warning" && record.raw.property_in_polygon === "true");
    const confidence: WeatherFinding["confidence"] = hasRadar && (hasReport || hasWarning) ? "high" : hasRadar || hasReport || hasWarning ? "medium" : "low";
    return {
      date,
      event_type: dominantEventType(dayRecords),
      max_magnitude: round(maxMagnitude, 2),
      magnitude_unit: dayRecords.find((record) => record.magnitude_unit)?.magnitude_unit ?? null,
      record_count: dayRecords.length,
      nearest_distance_miles: round(nearest, 2),
      confidence,
      basis: [...new Set(dayRecords.map((record) => `${record.source} ${record.dataset}`))]
    };
  }).sort((a, b) => {
    const magnitudeDelta = (b.max_magnitude ?? -1) - (a.max_magnitude ?? -1);
    if (magnitudeDelta !== 0) return magnitudeDelta;
    const distanceDelta = (a.nearest_distance_miles ?? 999) - (b.nearest_distance_miles ?? 999);
    if (distanceDelta !== 0) return distanceDelta;
    return b.date.localeCompare(a.date);
  });
}

function dominantEventType(records: WeatherRecord[]) {
  const counts = new Map<string, number>();
  for (const record of records) {
    const key = record.event_type ?? record.dataset;
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return [...counts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? "weather";
}

async function buildSummary(input: WeatherReportRequest, findings: WeatherFinding[], records: WeatherRecord[], timeoutMs: number) {
  const strongest = findings[0];
  const headline = strongest
    ? `${input.tier} weather data found ${findings.length} event day(s); strongest nearby ${strongest.event_type} signal was ${strongest.max_magnitude ?? "unknown"}${strongest.magnitude_unit ?? ""} on ${strongest.date}.`
    : `${input.tier} weather data search found no matching event days in the requested window.`;
  const limitations = [
    "This is an automated, non-certified report assembled from public weather datasets.",
    "Radar-derived records indicate probable conditions and are not direct measurements at the structure.",
    "The absence of a public report near the property does not prove severe weather did not occur."
  ];
  const ai = input.include_ai_summary
    ? await generateGeminiSummary({ headline, findings, records: records.slice(0, 200), limitations }, timeoutMs)
    : null;
  return {
    headline,
    narrative: ai ?? defaultNarrative(input.tier, findings, records),
    limitations
  };
}

function defaultNarrative(tier: WeatherTier, findings: WeatherFinding[], records: WeatherRecord[]) {
  if (!findings.length) {
    return "No matching public severe-weather records were returned for the selected property, radius, and date range.";
  }
  const top = findings[0];
  if (!top) {
    return "No matching public severe-weather records were returned for the selected property, radius, and date range.";
  }
  const datasets = [...new Set(records.map((record) => record.dataset))].join(", ");
  const warnings = records.filter((record) => record.dataset === "iem_warning");
  const propertyWarnings = warnings.filter((record) => record.raw.property_in_polygon === "true" || record.raw.mentions_address_city === "true");
  const lsrs = records.filter((record) => record.dataset === "iem_lsr");
  const warningText = propertyWarnings.length
    ? ` ${propertyWarnings.length} NWS warning record(s) were identified as applying to or mentioning the property area.`
    : warnings.length
      ? ` ${warnings.length} NWS warning record(s) were found in the regional event window.`
      : "";
  const lsrText = lsrs.length
    ? ` ${lsrs.length} nearby Local Storm Report(s) were found.`
    : "";
  return `The ${tier} data pull found ${records.length} public severe-weather record(s) across ${findings.length} event day(s). The strongest grouped signal was ${top.event_type} on ${top.date}, with maximum reported or radar-estimated magnitude ${top.max_magnitude ?? "unknown"} ${top.magnitude_unit ?? ""} and nearest supporting record ${top.nearest_distance_miles ?? "unknown"} miles from the property.${warningText}${lsrText} Datasets used: ${datasets}.`;
}

function artifactLinks(tier: WeatherTier, property: GeoPoint, records: WeatherRecord[], start: Date) {
  if (tier !== "complex" && tier !== "comprehensive") return {};
  const radarSite = records.find((record) => record.raw.wsr_id || record.raw.WSR_ID)?.raw.wsr_id ?? null;
  return {
    nexrad_level2: nexradArchiveLinks(property, radarSite, start),
    mrms: mrmsArchiveLinks(start),
    iem: [
      {
        label: "IEM warning search by point",
        url: `https://mesonet.agron.iastate.edu/vtec/search.php?lat=${property.lat}&lon=${property.lon}`
      },
      {
        label: "IEM archived NWS text products",
        url: "https://mesonet.agron.iastate.edu/wx/afos/list.phtml"
      }
    ]
  };
}

function shouldFetchIemWarnings(tier: WeatherTier, start: Date, end: Date) {
  if (tier === "reviewed" || tier === "complex") return true;
  const days = (end.getTime() - start.getTime()) / 86_400_000;
  return tier === "comprehensive" && days <= 370;
}

function skippedIemWarningsSource(tier: WeatherTier, start: Date, end: Date): { source: WeatherSource; records: WeatherRecord[] } | null {
  if (tier !== "comprehensive") return null;
  const days = Math.ceil((end.getTime() - start.getTime()) / 86_400_000);
  return {
    source: {
      id: "iem-warnings",
      name: "IEM NWS Warnings",
      url: "https://mesonet.agron.iastate.edu/cgi-bin/request/gis/watchwarn.py",
      accessed_at: new Date().toISOString(),
      status: "skipped",
      record_count: 0,
      error: `Skipped warning text enrichment for ${days} day comprehensive history range; run a date-of-loss reviewed/complex report or a <=370 day comprehensive window for full warning text/polygons.`
    },
    records: []
  };
}

function stringOrNull(value: unknown) {
  const text = String(value ?? "").trim();
  return text || null;
}

function objectOrNull(value: unknown) {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}
