import type { GeoPoint } from "./types.js";

export function pointInPolygon(point: GeoPoint, polygon: GeoPoint[]) {
  if (polygon.length < 3) return false;
  let inside = false;
  for (let index = 0, previous = polygon.length - 1; index < polygon.length; previous = index, index += 1) {
    const a = polygon[index];
    const b = polygon[previous];
    if (!a || !b) continue;
    const intersects = ((a.lat > point.lat) !== (b.lat > point.lat))
      && (point.lon < ((b.lon - a.lon) * (point.lat - a.lat)) / ((b.lat - a.lat) || Number.EPSILON) + a.lon);
    if (intersects) inside = !inside;
  }
  return inside;
}

export function parseNwsLatLonPolygon(text: string): GeoPoint[] {
  const match = text.match(/LAT\.\.\.LON\s+([\s\S]*?)(?:\n\s*TIME\.\.\.|HAIL THREAT|WIND THREAT|TORNADO|&&|\$\$)/i);
  if (!match?.[1]) return [];
  const tokens = match[1].match(/\d{4}/g) ?? [];
  const points: GeoPoint[] = [];
  for (let index = 0; index + 1 < tokens.length; index += 2) {
    const latToken = tokens[index];
    const lonToken = tokens[index + 1];
    if (!latToken || !lonToken) continue;
    const lat = Number(`${latToken.slice(0, 2)}.${latToken.slice(2)}`);
    const lon = -Number(`${lonToken.slice(0, 2)}.${lonToken.slice(2)}`);
    if (Number.isFinite(lat) && Number.isFinite(lon)) points.push({ lat, lon });
  }
  return points;
}
