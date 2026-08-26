import { parseCsv } from "./csv.js";
import { parseNwsLatLonPolygon, pointInPolygon } from "./geo.js";
import { fetchText } from "./http.js";
import { bboxAround, distanceMiles, round } from "./math.js";
import type { GeoPoint, WeatherRecord, WeatherSource } from "./types.js";

type IemOptions = {
  point: GeoPoint;
  start: Date;
  end: Date;
  radiusMiles: number;
  timeoutMs: number;
};

const warningTextCache = new Map<string, Promise<string>>();

export async function fetchIemLocalStormReports(options: IemOptions): Promise<{ source: WeatherSource; records: WeatherRecord[] }> {
  const bbox = bboxAround(options.point, options.radiusMiles);
  const url = new URL("https://mesonet.agron.iastate.edu/cgi-bin/request/gis/lsr.py");
  url.searchParams.set("wfo", "ALL");
  url.searchParams.set("sts", formatIemDate(options.start));
  url.searchParams.set("ets", formatIemDate(options.end));
  url.searchParams.set("fmt", "csv");
  url.searchParams.set("north", String(bbox.maxLat));
  url.searchParams.set("south", String(bbox.minLat));
  url.searchParams.set("east", String(bbox.maxLon));
  url.searchParams.set("west", String(bbox.minLon));
  const accessedAt = new Date().toISOString();
  try {
    const rows = parseCsv(await fetchText(url.toString(), options.timeoutMs));
    const records = rows.map((row) => normalizeLsr(row, options.point))
      .filter((record) => record.distance_miles == null || record.distance_miles <= options.radiusMiles)
      .sort((a, b) => String(a.observed_at ?? "").localeCompare(String(b.observed_at ?? "")));
    return {
      source: {
        id: "iem-lsr",
        name: "IEM Local Storm Reports",
        url: url.toString(),
        accessed_at: accessedAt,
        status: "ok",
        record_count: records.length
      },
      records
    };
  } catch (error) {
    return {
      source: {
        id: "iem-lsr",
        name: "IEM Local Storm Reports",
        url: url.toString(),
        accessed_at: accessedAt,
        status: "error",
        error: error instanceof Error ? error.message : String(error)
      },
      records: []
    };
  }
}

export async function fetchIemWarnings(options: IemOptions): Promise<{ source: WeatherSource; records: WeatherRecord[] }> {
  const state = stateFromAddress(options.point.address);
  const url = new URL("https://mesonet.agron.iastate.edu/cgi-bin/request/gis/watchwarn.py");
  url.searchParams.set("accept", "csv");
  url.searchParams.set("sts", formatIemDate(options.start));
  url.searchParams.set("ets", formatIemDate(options.end));
  url.searchParams.set("limitps", "1");
  url.searchParams.set("phenomena", "SV,TO");
  url.searchParams.set("significance", "W,W");
  if (state) {
    url.searchParams.set("location_group", "states");
    url.searchParams.set("states", state);
  } else {
    url.searchParams.set("limit1", "1");
  }
  const accessedAt = new Date().toISOString();
  try {
    const rows = parseCsv(await fetchText(url.toString(), options.timeoutMs));
    const likelyRows = rows.filter((row) => {
      const issued = parseIemTimestamp(row.utc_issue);
      const expires = parseIemTimestamp(row.utc_expire);
      if (!issued || !expires) return true;
      return issued <= options.end && expires >= options.start;
    }).slice(0, 18);
    const enriched = await enrichWarningsWithText(likelyRows, options);
    return {
      source: {
        id: "iem-warnings",
        name: "IEM NWS Warnings",
        url: url.toString(),
        accessed_at: accessedAt,
        status: "ok",
        record_count: enriched.length
      },
      records: enriched
    };
  } catch (error) {
    return {
      source: {
        id: "iem-warnings",
        name: "IEM NWS Warnings",
        url: url.toString(),
        accessed_at: accessedAt,
        status: "error",
        error: error instanceof Error ? error.message : String(error)
      },
      records: []
    };
  }
}

async function enrichWarningsWithText(rows: Record<string, string>[], options: IemOptions) {
  const records: WeatherRecord[] = [];
  for (const row of rows) {
    const productId = row.product_id ?? "";
    const text = await fetchWarningText(row, options.timeoutMs).catch(() => "");
    const polygon = parseNwsLatLonPolygon(text);
    const contains = polygon.length ? pointInPolygon(options.point, polygon) : null;
    const nearestPolygonDistance = polygon.length ? nearestDistanceToPolygon(options.point, polygon) : null;
    const mentionsAddressCity = textMatchesAddress(text, options.point.address);
    if (contains === false && !mentionsAddressCity && nearestPolygonDistance != null && nearestPolygonDistance > options.radiusMiles) continue;
    records.push(normalizeWarning(row, text, contains, mentionsAddressCity, nearestPolygonDistance));
  }
  return records.sort((a, b) => String(a.observed_at ?? "").localeCompare(String(b.observed_at ?? "")));
}

async function fetchWarningText(row: Record<string, string>, timeoutMs: number) {
  const productId = row.product_id ?? "";
  const parts = productId.split("-");
  const center = parts[1];
  const pil = parts[3];
  const issued = parseIemTimestamp(row.utc_issue);
  if (!center || !pil || !issued) return "";
  const sdate = new Date(issued.getTime() - 2 * 60_000);
  const edate = new Date(issued.getTime() + 3 * 60_000);
  const url = new URL("https://mesonet.agron.iastate.edu/cgi-bin/afos/retrieve.py");
  url.searchParams.set("pil", pil);
  url.searchParams.set("center", center);
  url.searchParams.set("fmt", "text");
  url.searchParams.set("sdate", formatIemDate(sdate));
  url.searchParams.set("edate", formatIemDate(edate));
  url.searchParams.set("limit", "8");
  url.searchParams.set("order", "asc");
  const cacheKey = url.toString();
  if (!warningTextCache.has(cacheKey)) {
    warningTextCache.set(cacheKey, fetchWarningTextWithRetry(cacheKey, timeoutMs).then(cleanAfosText));
  }
  const text = await (warningTextCache.get(cacheKey) ?? Promise.resolve(""));
  return selectMatchingAfosProduct(text, row);
}

async function fetchWarningTextWithRetry(url: string, timeoutMs: number) {
  try {
    return await fetchText(url, timeoutMs);
  } catch (error) {
    await delay(1200);
    return fetchText(url, timeoutMs).catch(() => "");
  }
}

function delay(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function normalizeLsr(row: Record<string, string>, point: GeoPoint): WeatherRecord {
  const lat = readCoordinate(row.LAT);
  const lon = readCoordinate(row.LON);
  return {
    source: "IEM",
    dataset: "iem_lsr",
    observed_at: parseCompactUtc(row.VALID)?.toISOString() ?? row.VALID2 ?? null,
    event_type: row.TYPETEXT ?? "local_storm_report",
    magnitude: readMagnitude(row.MAG),
    magnitude_unit: isWindLsr(row.TYPETEXT) ? "mph" : "in",
    lat,
    lon,
    distance_miles: lat != null && lon != null ? round(distanceMiles(point, { lat, lon }), 2) : null,
    raw: row
  };
}

function isWindLsr(value: unknown) {
  const text = String(value ?? "").toLowerCase();
  return text.includes("wind") || text.includes("wnd");
}

function normalizeWarning(row: Record<string, string>, text: string, contains: boolean | null, mentionsAddressCity: boolean, nearestPolygonDistance: number | null): WeatherRecord {
  const polygon = parseNwsLatLonPolygon(text);
  return {
    source: "IEM",
    dataset: "iem_warning",
    observed_at: parseIemTimestamp(row.utc_issue)?.toISOString() ?? row.utc_issue ?? null,
    event_type: warningLabel(row),
    magnitude: readMagnitude(row.hailtag),
    magnitude_unit: readMagnitude(row.hailtag) == null ? null : "in",
    lat: null,
    lon: null,
    distance_miles: null,
    raw: {
      ...row,
      property_in_polygon: contains == null ? "" : String(contains),
      mentions_address_city: String(mentionsAddressCity),
      polygon_nearest_distance_miles: nearestPolygonDistance == null ? "" : String(round(nearestPolygonDistance, 2)),
      polygon_json: polygon.length ? JSON.stringify(polygon) : "",
      text: text.slice(0, 8000)
    }
  };
}

function nearestDistanceToPolygon(point: GeoPoint, polygon: GeoPoint[]) {
  if (pointInPolygon(point, polygon)) return 0;
  const distances = polygon.map((vertex) => distanceMiles(point, vertex));
  return distances.length ? Math.min(...distances) : null;
}

function warningLabel(row: Record<string, string>) {
  if (row.phenomena === "TO") return "tornado_warning";
  if (row.phenomena === "SV") return "severe_thunderstorm_warning";
  return "nws_warning";
}

function textMatchesAddress(text: string, address: string | null | undefined) {
  const firstCity = String(address ?? "").split(",")[1]?.trim().toLowerCase();
  return Boolean(firstCity && text.toLowerCase().includes(firstCity));
}

function stateFromAddress(address: string | null | undefined) {
  const match = String(address ?? "").match(/,\s*([A-Z]{2})\s+\d{5}/);
  return match?.[1] ?? null;
}

function formatIemDate(date: Date) {
  return date.toISOString().replace(".000", "").replace(/:\d{2}Z$/, "Z");
}

function parseCompactUtc(value: string | undefined) {
  if (!value || !/^\d{12}$/.test(value)) return null;
  return new Date(`${value.slice(0, 4)}-${value.slice(4, 6)}-${value.slice(6, 8)}T${value.slice(8, 10)}:${value.slice(10, 12)}:00Z`);
}

function parseIemTimestamp(value: string | undefined) {
  if (!value) return null;
  const normalized = value.includes("T") ? value : value.replace(" ", "T") + "Z";
  const parsed = new Date(normalized);
  return Number.isFinite(parsed.getTime()) ? parsed : null;
}

function readCoordinate(value: unknown): number | null {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= -900) return null;
  return parsed;
}

function readMagnitude(value: unknown): number | null {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0 || parsed <= -900) return null;
  return parsed;
}

function cleanAfosText(text: string) {
  return text.replace(/[\u0001\u0003]/g, "").trim();
}

function selectMatchingAfosProduct(text: string, row: Record<string, string>) {
  const eventId = Number(row.eventid);
  const phenomena = row.phenomena || "";
  const significance = row.significance || "";
  const vtecNeedle = Number.isFinite(eventId)
    ? `.${phenomena}.${significance}.${String(eventId).padStart(4, "0")}.`
    : "";
  const chunks = text.split(/\n(?=\d+\s+\n[A-Z]{4}\d{2}\sK[A-Z]{3}\s\d{6})/g).map((chunk) => chunk.trim()).filter(Boolean);
  if (vtecNeedle) {
    const match = chunks.find((chunk) => chunk.includes(vtecNeedle));
    if (match) return match;
  }
  return chunks[0] ?? text;
}
