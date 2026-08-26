import { pointInPolygon } from "./geo.js";
import { distanceMiles, round } from "./math.js";
import type { GeoPoint, WeatherRecord, WeatherStormArea } from "./types.js";

const MIN_SWATH_POINTS = 3;
const MAX_AREAS = 80;

export function buildStormAreas(property: GeoPoint, records: WeatherRecord[]): WeatherStormArea[] {
  const warningAreas = records.flatMap((record) => warningAreaFromRecord(property, record));
  const estimatedAreas = estimatedAreasFromRecords(property, records);
  return [...warningAreas, ...estimatedAreas]
    .sort((a, b) => {
      const containsDelta = Number(b.contains_property === true) - Number(a.contains_property === true);
      if (containsDelta !== 0) return containsDelta;
      const magnitudeDelta = (b.magnitude ?? -1) - (a.magnitude ?? -1);
      if (magnitudeDelta !== 0) return magnitudeDelta;
      return b.date.localeCompare(a.date);
    })
    .slice(0, MAX_AREAS);
}

function warningAreaFromRecord(property: GeoPoint, record: WeatherRecord): WeatherStormArea[] {
  const polygon = parsePolygon(record.raw.polygon_json);
  if (!polygon.length) return [];
  const contains = pointInPolygon(property, polygon);
  return [{
    id: stableAreaId(record, "warning_polygon"),
    date: recordDate(record),
    event_type: record.event_type ?? "warning",
    area_type: "warning_polygon",
    source: record.source,
    dataset: record.dataset,
    magnitude: record.magnitude ?? null,
    magnitude_unit: record.magnitude_unit ?? null,
    record_count: 1,
    contains_property: contains,
    nearest_distance_miles: round(nearestPolygonDistance(property, polygon), 2),
    confidence: contains ? "high" : "medium",
    basis: [`${record.source} ${record.dataset}`],
    coordinates: polygon
  }];
}

function estimatedAreasFromRecords(property: GeoPoint, records: WeatherRecord[]) {
  const byEvent = new Map<string, WeatherRecord[]>();
  for (const record of records) {
    if (record.lat == null || record.lon == null) continue;
    if (!isSwathCandidate(record)) continue;
    const key = `${recordDate(record)}|${eventFamily(record)}`;
    const existing = byEvent.get(key) ?? [];
    existing.push(record);
    byEvent.set(key, existing);
  }

  const areas: WeatherStormArea[] = [];
  for (const [key, dayRecords] of byEvent) {
    const [date = "unknown", eventType = "weather"] = key.split("|");
    const points = uniquePoints(dayRecords.map((record) => ({ lat: record.lat as number, lon: record.lon as number })));
    const magnitudes = dayRecords.map((record) => record.magnitude).filter((value): value is number => value != null);
    const distances = dayRecords.map((record) => record.distance_miles).filter((value): value is number => value != null);
    const maxMagnitude = magnitudes.length ? Math.max(...magnitudes) : null;
    const nearest = distances.length ? Math.min(...distances) : null;
    const basis = [...new Set(dayRecords.map((record) => `${record.source} ${record.dataset}`))];
    const polygon = points.length >= MIN_SWATH_POINTS
      ? expandPolygon(convexHull(points), bufferMilesForEvent(eventType, maxMagnitude))
      : circleAround(points[0] ?? property, bufferMilesForEvent(eventType, maxMagnitude));
    if (!polygon.length) continue;
    areas.push({
      id: `estimated-${date}-${eventType}`.replace(/[^a-zA-Z0-9_-]/g, "-"),
      date: date ?? "unknown",
      event_type: eventType ?? "weather",
      area_type: points.length >= MIN_SWATH_POINTS ? "estimated_swath" : "point_buffer",
      source: "FirstMate estimated storm footprint",
      dataset: "derived_swath",
      magnitude: round(maxMagnitude, 2),
      magnitude_unit: dayRecords.find((record) => record.magnitude_unit)?.magnitude_unit ?? null,
      record_count: dayRecords.length,
      contains_property: pointInPolygon(property, polygon),
      nearest_distance_miles: round(nearest, 2),
      confidence: basis.length > 1 ? "high" : points.length >= MIN_SWATH_POINTS ? "medium" : "low",
      basis,
      coordinates: polygon
    });
  }
  return areas.filter((area) => area.record_count >= 2 || area.contains_property === true);
}

function isSwathCandidate(record: WeatherRecord) {
  const family = eventFamily(record);
  return family === "hail" || family === "wind" || family === "tornado";
}

function eventFamily(record: WeatherRecord) {
  const haystack = `${record.dataset} ${record.event_type ?? ""} ${JSON.stringify(record.raw)}`.toLowerCase();
  if (haystack.includes("tornado") || haystack.includes("tvs") || haystack.includes("tornadic")) return "tornado";
  if (haystack.includes("wind") || haystack.includes("wnd") || haystack.includes("thunderstorm")) return "wind";
  if (haystack.includes("hail")) return "hail";
  return record.event_type ?? record.dataset;
}

function recordDate(record: WeatherRecord) {
  return String(record.observed_at ?? "unknown").slice(0, 10) || "unknown";
}

function uniquePoints(points: GeoPoint[]) {
  const seen = new Set<string>();
  const unique: GeoPoint[] = [];
  for (const point of points) {
    const key = `${point.lat.toFixed(4)},${point.lon.toFixed(4)}`;
    if (seen.has(key)) continue;
    seen.add(key);
    unique.push(point);
  }
  return unique;
}

function parsePolygon(value: unknown): GeoPoint[] {
  if (!value) return [];
  try {
    const parsed = JSON.parse(String(value)) as GeoPoint[];
    return Array.isArray(parsed)
      ? parsed.filter((point) => Number.isFinite(point.lat) && Number.isFinite(point.lon))
      : [];
  } catch {
    return [];
  }
}

function convexHull(points: GeoPoint[]) {
  const sorted = [...points].sort((a, b) => a.lon - b.lon || a.lat - b.lat);
  if (sorted.length <= 3) return sorted;
  const lower: GeoPoint[] = [];
  for (const point of sorted) {
    while (lower.length >= 2 && cross(lower[lower.length - 2] as GeoPoint, lower[lower.length - 1] as GeoPoint, point) <= 0) {
      lower.pop();
    }
    lower.push(point);
  }
  const upper: GeoPoint[] = [];
  for (let index = sorted.length - 1; index >= 0; index -= 1) {
    const point = sorted[index] as GeoPoint;
    while (upper.length >= 2 && cross(upper[upper.length - 2] as GeoPoint, upper[upper.length - 1] as GeoPoint, point) <= 0) {
      upper.pop();
    }
    upper.push(point);
  }
  upper.pop();
  lower.pop();
  return [...lower, ...upper];
}

function cross(origin: GeoPoint, a: GeoPoint, b: GeoPoint) {
  return (a.lon - origin.lon) * (b.lat - origin.lat) - (a.lat - origin.lat) * (b.lon - origin.lon);
}

function expandPolygon(points: GeoPoint[], bufferMiles: number) {
  if (!points.length) return [];
  const center = centroid(points);
  return points.map((point) => {
    const latDelta = point.lat - center.lat;
    const lonDelta = point.lon - center.lon;
    const length = Math.sqrt(latDelta ** 2 + lonDelta ** 2) || 1;
    const latBuffer = bufferMiles / 69;
    const lonBuffer = bufferMiles / Math.max(1, 69 * Math.cos((center.lat * Math.PI) / 180));
    return {
      lat: point.lat + (latDelta / length) * latBuffer,
      lon: point.lon + (lonDelta / length) * lonBuffer
    };
  });
}

function circleAround(center: GeoPoint, radiusMiles: number) {
  const points: GeoPoint[] = [];
  const latRadius = radiusMiles / 69;
  const lonRadius = radiusMiles / Math.max(1, 69 * Math.cos((center.lat * Math.PI) / 180));
  for (let index = 0; index < 20; index += 1) {
    const angle = (index / 20) * Math.PI * 2;
    points.push({
      lat: center.lat + Math.sin(angle) * latRadius,
      lon: center.lon + Math.cos(angle) * lonRadius
    });
  }
  return points;
}

function centroid(points: GeoPoint[]) {
  const total = points.reduce((sum, point) => ({ lat: sum.lat + point.lat, lon: sum.lon + point.lon }), { lat: 0, lon: 0 });
  return { lat: total.lat / points.length, lon: total.lon / points.length };
}

function nearestPolygonDistance(property: GeoPoint, polygon: GeoPoint[]) {
  if (pointInPolygon(property, polygon)) return 0;
  const distances = polygon.map((point) => distanceMiles(property, point));
  return distances.length ? Math.min(...distances) : null;
}

function bufferMilesForEvent(eventType: string, magnitude: number | null) {
  if (eventType === "tornado") return 1;
  if (eventType === "wind") return 1.5;
  if (magnitude != null && magnitude >= 1.5) return 1.25;
  return 0.75;
}

function stableAreaId(record: WeatherRecord, suffix: string) {
  return `${record.dataset}-${recordDate(record)}-${String(record.raw.product_id ?? record.raw.eventid ?? suffix)}`.replace(/[^a-zA-Z0-9_-]/g, "-");
}
