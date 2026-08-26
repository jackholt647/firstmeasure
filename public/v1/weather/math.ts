import type { GeoPoint } from "./types.js";

const EARTH_RADIUS_MILES = 3958.7613;

export function toRadians(value: number) {
  return (value * Math.PI) / 180;
}

export function distanceMiles(a: GeoPoint, b: GeoPoint) {
  const dLat = toRadians(b.lat - a.lat);
  const dLon = toRadians(b.lon - a.lon);
  const lat1 = toRadians(a.lat);
  const lat2 = toRadians(b.lat);
  const hav = Math.sin(dLat / 2) ** 2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLon / 2) ** 2;
  return 2 * EARTH_RADIUS_MILES * Math.asin(Math.sqrt(hav));
}

export function bboxAround(point: GeoPoint, radiusMiles: number) {
  const latDelta = radiusMiles / 69;
  const lonDelta = radiusMiles / Math.max(1, 69 * Math.cos(toRadians(point.lat)));
  return {
    minLon: point.lon - lonDelta,
    minLat: point.lat - latDelta,
    maxLon: point.lon + lonDelta,
    maxLat: point.lat + latDelta
  };
}

export function round(value: number | null | undefined, digits = 2) {
  if (value == null || !Number.isFinite(value)) return null;
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}
