import { round } from "./math.js";
import type { GeoPoint, WeatherEventSummary, WeatherRecord } from "./types.js";

const EVENT_CLUSTER_WINDOW_MS = 3 * 60 * 60 * 1000;

type EventRecord = {
  record: WeatherRecord;
  family: WeatherEventSummary["event_type"];
  observedAt: Date | null;
  magnitude: number | null;
  unit: string | null;
};

export function buildStormEventSummaries(property: GeoPoint, records: WeatherRecord[]): WeatherEventSummary[] {
  const candidates = records
    .map((record) => eventRecord(record))
    .filter((candidate): candidate is EventRecord => candidate != null)
    .sort((a, b) => (a.observedAt?.getTime() ?? 0) - (b.observedAt?.getTime() ?? 0));

  const groups: EventRecord[][] = [];
  for (const candidate of candidates) {
    const date = eventDate(property, candidate.observedAt);
    const lastGroup = groups[groups.length - 1];
    const last = lastGroup?.[lastGroup.length - 1];
    if (
      lastGroup
      && last
      && candidate.family === last.family
      && eventDate(property, last.observedAt) === date
      && Math.abs((candidate.observedAt?.getTime() ?? 0) - (last.observedAt?.getTime() ?? 0)) <= EVENT_CLUSTER_WINDOW_MS
    ) {
      lastGroup.push(candidate);
    } else {
      groups.push([candidate]);
    }
  }

  return groups
    .map((group) => summarizeGroup(property, group))
    .sort((a, b) => b.date.localeCompare(a.date) || eventWeight(b.event_type) - eventWeight(a.event_type) || (b.max_magnitude ?? 0) - (a.max_magnitude ?? 0));
}

function summarizeGroup(property: GeoPoint, group: EventRecord[]): WeatherEventSummary {
  const first = group[0];
  const family = first?.family ?? "weather";
  const dates = group.map((item) => item.observedAt).filter((value): value is Date => value != null);
  const start = dates.length ? new Date(Math.min(...dates.map((date) => date.getTime()))) : null;
  const end = dates.length ? new Date(Math.max(...dates.map((date) => date.getTime()))) : null;
  const magnitudes = group.map((item) => item.magnitude).filter((value): value is number => value != null);
  const distances = group.map((item) => item.record.distance_miles).filter((value): value is number => value != null);
  const maxMagnitude = magnitudes.length ? Math.max(...magnitudes) : null;
  const nearest = distances.length ? Math.min(...distances) : null;
  const sources = [...new Set(group.map((item) => `${item.record.source} ${item.record.dataset}`))];
  const basis = group
    .map((item) => basisLabel(item))
    .filter(Boolean)
    .filter((value, index, all) => all.indexOf(value) === index)
    .slice(0, 8);
  const date = eventDate(property, start);
  return {
    id: `event-${date}-${family}-${start?.toISOString() ?? "unknown"}`.replace(/[^a-zA-Z0-9_-]/g, "-"),
    date,
    event_type: family,
    start_at: start?.toISOString() ?? null,
    end_at: end?.toISOString() ?? null,
    duration_minutes: start && end ? Math.max(0, Math.round((end.getTime() - start.getTime()) / 60_000)) : null,
    max_magnitude: round(maxMagnitude, 2),
    magnitude_unit: group.find((item) => item.unit)?.unit ?? null,
    nearest_distance_miles: round(nearest, 2),
    record_count: group.length,
    sources,
    basis
  };
}

function eventRecord(record: WeatherRecord): EventRecord | null {
  const family = eventFamily(record);
  if (family === "weather") return null;
  const observedAt = record.observed_at ? new Date(record.observed_at) : null;
  const magnitude = magnitudeForFamily(record, family);
  return {
    record,
    family,
    observedAt: observedAt && Number.isFinite(observedAt.getTime()) ? observedAt : null,
    magnitude: magnitude.value,
    unit: magnitude.unit
  };
}

function eventFamily(record: WeatherRecord): WeatherEventSummary["event_type"] {
  const haystack = `${record.dataset} ${record.event_type ?? ""} ${JSON.stringify(record.raw)}`.toLowerCase();
  if (haystack.includes("tornado")) return "tornado";
  if (haystack.includes("wind") || haystack.includes("wnd") || record.raw.windtag) return "wind";
  if (haystack.includes("hail") || record.dataset === "mrms_mesh") return "hail";
  return "weather";
}

function magnitudeForFamily(record: WeatherRecord, family: WeatherEventSummary["event_type"]) {
  if (family === "wind") {
    const windTag = readNumber(record.raw.windtag);
    if (windTag != null) return { value: windTag, unit: "mph" };
    if (record.magnitude != null && record.magnitude_unit === "mph") return { value: record.magnitude, unit: "mph" };
    return { value: null, unit: "mph" };
  }
  if (family === "hail") {
    return { value: record.magnitude ?? null, unit: record.magnitude_unit ?? "in" };
  }
  return { value: record.magnitude ?? null, unit: record.magnitude_unit ?? null };
}

function basisLabel(item: EventRecord) {
  const record = item.record;
  const city = record.raw.CITY ? ` ${record.raw.CITY}` : "";
  const distance = record.distance_miles != null ? ` ${record.distance_miles} mi` : "";
  const magnitude = item.magnitude != null ? ` ${item.magnitude}${item.unit === "in" ? "\"" : item.unit ? ` ${item.unit}` : ""}` : "";
  return `${record.dataset} ${record.event_type ?? item.family}${magnitude}${distance}${city}`.trim();
}

function eventDate(property: GeoPoint, date: Date | null) {
  if (!date) return "unknown";
  const local = new Date(date.getTime() + approximateUtcOffsetHours(property.lon) * 60 * 60 * 1000);
  return local.toISOString().slice(0, 10);
}

function approximateUtcOffsetHours(lon: number) {
  return Math.max(-12, Math.min(14, Math.round(lon / 15)));
}

function readNumber(value: unknown) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

function eventWeight(type: WeatherEventSummary["event_type"]) {
  if (type === "hail") return 4;
  if (type === "wind") return 3;
  if (type === "tornado") return 2;
  return 1;
}
