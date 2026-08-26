import { gunzipSync } from "node:zlib";

import { pointInPolygon } from "./geo.js";
import { distanceMiles, round } from "./math.js";
import type { GeoPoint, WeatherRecord, WeatherSource, WeatherStormArea } from "./types.js";

const MRMS_BUCKET_URL = "https://noaa-mrms-pds.s3.amazonaws.com";
const MRMS_ARCHIVE_START = Date.UTC(2020, 9, 14);
const MAX_EVENT_FRAMES = 12;
const MAX_DAILY_FRAMES = 5;
const MAX_CONTOUR_AREAS = 24;
const MESH_THRESHOLDS_IN = [0.5, 0.75, 1, 1.25, 1.5, 2, 2.5, 3, 4];
let sharpFactoryPromise: Promise<any> | null = null;

type MrmsProduct = "MESH_Max_60min_00.50" | "MESH_Max_1440min_00.50";

type MrmsFrame = {
  product: MrmsProduct;
  key: string;
  observed_at: string;
};

type MrmsGrid = {
  product: MrmsProduct;
  key: string;
  observed_at: string;
  width: number;
  height: number;
  lat1: number;
  lon1: number;
  lat2: number;
  lon2: number;
  di: number;
  dj: number;
  scanMode: number;
  referenceValue: number;
  binaryScale: number;
  decimalScale: number;
  data: Buffer;
};

type GridCell = {
  x: number;
  y: number;
  point: GeoPoint;
  meshIn: number;
  distance: number;
};

export async function fetchMrmsMesh(input: {
  point: GeoPoint;
  start: Date;
  end: Date;
  radiusMiles: number;
  seedRecords: WeatherRecord[];
  timeoutMs: number;
}): Promise<{ source: WeatherSource; records: WeatherRecord[]; stormAreas: WeatherStormArea[] }> {
  const accessedAt = new Date().toISOString();
  if (input.end.getTime() < MRMS_ARCHIVE_START) {
    return {
      source: mrmsSource(accessedAt, "skipped", 0, "MRMS public AWS archive starts on 2020-10-14 for the products used by this report."),
      records: [],
      stormAreas: []
    };
  }

  const errors: string[] = [];
  const frames = await selectMrmsFrames(input.start, input.end, input.seedRecords, input.timeoutMs).catch((error: unknown) => {
    errors.push(error instanceof Error ? error.message : String(error));
    return [] as MrmsFrame[];
  });

  const records: WeatherRecord[] = [];
  const stormAreas: WeatherStormArea[] = [];
  for (const frame of frames) {
    try {
      const grid = await fetchMrmsGrid(frame, input.timeoutMs);
      const analyzed = analyzeMrmsGrid(grid, input.point, input.radiusMiles);
      if (analyzed.record) records.push(analyzed.record);
      stormAreas.push(...analyzed.areas);
    } catch (error) {
      errors.push(`${frame.product} ${frame.observed_at}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  const limitedAreas = stormAreas
    .sort((a, b) => {
      const containsDelta = Number(b.contains_property === true) - Number(a.contains_property === true);
      if (containsDelta !== 0) return containsDelta;
      const magnitudeDelta = (b.magnitude ?? -1) - (a.magnitude ?? -1);
      if (magnitudeDelta !== 0) return magnitudeDelta;
      return b.date.localeCompare(a.date);
    })
    .slice(0, MAX_CONTOUR_AREAS);

  const status = errors.length && records.length ? "partial" : errors.length ? "error" : frames.length ? "ok" : "skipped";
  const error = errors.length
    ? errors.slice(0, 4).join("; ")
    : frames.length
      ? undefined
      : "No MRMS MESH frames were selected for this report window. A hail event seed or short date window is needed to avoid downloading full archive days.";

  return {
    source: mrmsSource(accessedAt, status, records.length, error),
    records,
    stormAreas: limitedAreas
  };
}

export async function selectMrmsFrames(start: Date, end: Date, seedRecords: WeatherRecord[], timeoutMs: number): Promise<MrmsFrame[]> {
  const eventSeeds = seedRecords
    .filter(isHailSeed)
    .filter((record) => {
      const observed = record.observed_at ? new Date(record.observed_at) : null;
      return observed && Number.isFinite(observed.getTime()) && observed.getTime() >= MRMS_ARCHIVE_START;
    })
    .sort((a, b) => (b.magnitude ?? -1) - (a.magnitude ?? -1) || (a.distance_miles ?? 999) - (b.distance_miles ?? 999))
    .slice(0, MAX_EVENT_FRAMES);

  const eventFrames = await framesForEventSeeds(eventSeeds, timeoutMs);
  const eventDays = uniqueDays(eventSeeds.map((record) => record.observed_at).filter((value): value is string => Boolean(value)));
  const fallbackDays = eventDays.length
    ? eventDays
    : daysInRange(start, end).filter((day) => day >= "2020-10-14").slice(0, MAX_DAILY_FRAMES);
  const dailyFrames = await framesForDailySwaths(fallbackDays, end, timeoutMs);
  const byKey = new Map<string, MrmsFrame>();
  for (const frame of [...eventFrames, ...dailyFrames]) byKey.set(frame.key, frame);
  return [...byKey.values()].sort((a, b) => a.observed_at.localeCompare(b.observed_at)).slice(0, MAX_EVENT_FRAMES + MAX_DAILY_FRAMES);
}

export async function decodeMrmsGrib2(buffer: Buffer, frame: MrmsFrame): Promise<MrmsGrid> {
  const unzipped = buffer.subarray(0, 4).toString() === "GRIB" ? buffer : gunzipSync(buffer);
  const sections = readGribSections(unzipped);
  const section3 = sections.get(3);
  const section5 = sections.get(5);
  const section7 = sections.get(7);
  if (!section3 || !section5 || !section7) throw new Error("MRMS GRIB2 file is missing required grid/data sections.");

  const gridTemplate = unzipped.readUInt16BE(section3 + 12);
  if (gridTemplate !== 0) throw new Error(`Unsupported MRMS grid template ${gridTemplate}.`);
  const dataTemplate = unzipped.readUInt16BE(section5 + 9);
  if (dataTemplate !== 41) throw new Error(`Unsupported MRMS data representation template ${dataTemplate}.`);

  const grid = parseLatLonGrid(unzipped, section3);
  const referenceValue = unzipped.readFloatBE(section5 + 11);
  const binaryScale = unzipped.readInt16BE(section5 + 15);
  const decimalScale = unzipped.readInt16BE(section5 + 17);
  const bitsPerValue = unzipped.readUInt8(section5 + 19);
  if (bitsPerValue !== 16) throw new Error(`Unsupported MRMS PNG bit depth ${bitsPerValue}.`);

  const section7Length = unzipped.readUInt32BE(section7);
  const png = unzipped.subarray(section7 + 5, section7 + section7Length);
  const sharp = await loadSharp();
  const decoded = await sharp(png).greyscale().raw({ depth: "ushort" }).toBuffer({ resolveWithObject: true });
  if (decoded.info.width !== grid.width || decoded.info.height !== grid.height || decoded.data.length !== grid.width * grid.height * 2) {
    throw new Error(`Decoded MRMS raster dimensions ${decoded.info.width}x${decoded.info.height} did not match GRIB grid ${grid.width}x${grid.height}.`);
  }

  return {
    ...grid,
    product: frame.product,
    key: frame.key,
    observed_at: frame.observed_at,
    referenceValue,
    binaryScale,
    decimalScale,
    data: decoded.data
  };
}

async function loadSharp() {
  sharpFactoryPromise ??= import("sharp").then((mod) => mod.default);
  return sharpFactoryPromise;
}

export function analyzeMrmsGrid(grid: MrmsGrid, property: GeoPoint, radiusMiles: number): { record: WeatherRecord | null; areas: WeatherStormArea[] } {
  const propertyValue = sampleMeshIn(grid, property);
  const cells = collectCellsWithinRadius(grid, property, radiusMiles);
  const validCells = cells.filter((cell) => cell.meshIn > 0);
  if (!validCells.length && (propertyValue == null || propertyValue <= 0)) return { record: null, areas: [] };

  const maxCell = validCells.sort((a, b) => b.meshIn - a.meshIn || a.distance - b.distance)[0] ?? null;
  const maxMeshIn = maxCell?.meshIn ?? propertyValue ?? null;
  const record: WeatherRecord | null = maxMeshIn != null && maxMeshIn > 0
    ? {
        source: "NOAA MRMS",
        dataset: "mrms_mesh",
        observed_at: grid.observed_at,
        event_type: "mrms_mesh",
        magnitude: round(maxMeshIn, 2),
        magnitude_unit: "in",
        lat: maxCell?.point.lat ?? property.lat,
        lon: maxCell?.point.lon ?? property.lon,
        distance_miles: round(maxCell?.distance ?? 0, 2),
        raw: {
          product: grid.product,
          object_key: grid.key,
          property_mesh_inches: String(round(propertyValue, 2) ?? 0),
          radius_max_mesh_inches: String(round(maxMeshIn, 2) ?? 0),
          radius_miles: String(radiusMiles)
        }
      }
    : null;

  const areas = buildContourAreas(grid, property, validCells, maxMeshIn ?? 0);
  return { record, areas };
}

function mrmsSource(accessedAt: string, status: WeatherSource["status"], recordCount: number, error?: string): WeatherSource {
  return {
    id: "noaa-mrms-mesh-raster",
    name: "NOAA MRMS MESH Raster",
    url: "https://registry.opendata.aws/noaa-mrms-pds/",
    accessed_at: accessedAt,
    status,
    record_count: recordCount,
    error
  };
}

async function framesForEventSeeds(seedRecords: WeatherRecord[], timeoutMs: number) {
  const targetsByDay = new Map<string, Date[]>();
  for (const record of seedRecords) {
    if (!record.observed_at) continue;
    const target = roundToMrmsMinute(new Date(record.observed_at));
    const day = dayString(target);
    targetsByDay.set(day, [...(targetsByDay.get(day) ?? []), target]);
  }
  const frames: MrmsFrame[] = [];
  for (const [day, targets] of targetsByDay) {
    const keys = await listMrmsKeys("MESH_Max_60min_00.50", day, timeoutMs);
    for (const target of targets) {
      const frame = nearestFrame("MESH_Max_60min_00.50", keys, target, 8 * 60_000);
      if (frame) frames.push(frame);
    }
  }
  return frames;
}

async function framesForDailySwaths(days: string[], end: Date, timeoutMs: number) {
  const frames: MrmsFrame[] = [];
  for (const day of days.slice(0, MAX_DAILY_FRAMES)) {
    const keys = await listMrmsKeys("MESH_Max_1440min_00.50", day, timeoutMs);
    const target = new Date(`${day}T23:58:00Z`);
    const cappedTarget = target.getTime() > end.getTime() && dayString(end) === day ? end : target;
    const frame = nearestFrame("MESH_Max_1440min_00.50", keys, cappedTarget, 45 * 60_000);
    if (frame) frames.push(frame);
  }
  return frames;
}

async function listMrmsKeys(product: MrmsProduct, day: string, timeoutMs: number) {
  const prefix = `CONUS/${product}/${day.replace(/-/g, "")}/`;
  const keys: string[] = [];
  let continuation: string | null = null;
  do {
    const params = new URLSearchParams({ "list-type": "2", prefix, "max-keys": "1000" });
    if (continuation) params.set("continuation-token", continuation);
    const response = await fetchWithTimeout(`${MRMS_BUCKET_URL}/?${params.toString()}`, timeoutMs);
    if (!response.ok) throw new Error(`MRMS S3 list failed ${response.status} for ${prefix}.`);
    const xml = await response.text();
    keys.push(...[...xml.matchAll(/<Key>(.*?)<\/Key>/g)].map((match) => decodeXml(match[1] ?? "")));
    continuation = ([...xml.matchAll(/<NextContinuationToken>(.*?)<\/NextContinuationToken>/g)][0]?.[1] ?? null);
  } while (continuation);
  return keys;
}

async function fetchMrmsGrid(frame: MrmsFrame, timeoutMs: number) {
  const response = await fetchWithTimeout(`${MRMS_BUCKET_URL}/${frame.key}`, timeoutMs);
  if (!response.ok) throw new Error(`MRMS S3 download failed ${response.status} for ${frame.key}.`);
  return decodeMrmsGrib2(Buffer.from(await response.arrayBuffer()), frame);
}

function nearestFrame(product: MrmsProduct, keys: string[], target: Date, toleranceMs: number): MrmsFrame | null {
  let best: { key: string; observedAt: Date; delta: number } | null = null;
  for (const key of keys) {
    const observedAt = parseMrmsKeyTime(key);
    if (!observedAt) continue;
    const delta = Math.abs(observedAt.getTime() - target.getTime());
    if (delta <= toleranceMs && (!best || delta < best.delta)) best = { key, observedAt, delta };
  }
  return best ? { product, key: best.key, observed_at: best.observedAt.toISOString() } : null;
}

function parseMrmsKeyTime(key: string) {
  const match = key.match(/_(\d{8})-(\d{6})\.grib2\.gz$/);
  if (!match?.[1] || !match[2]) return null;
  const date = match[1];
  const time = match[2];
  return new Date(`${date.slice(0, 4)}-${date.slice(4, 6)}-${date.slice(6, 8)}T${time.slice(0, 2)}:${time.slice(2, 4)}:${time.slice(4, 6)}Z`);
}

export function roundToMrmsMinute(date: Date) {
  const rounded = new Date(date);
  rounded.setUTCSeconds(0, 0);
  const minute = rounded.getUTCMinutes();
  const remainder = minute % 2;
  if (remainder) rounded.setUTCMinutes(minute + 1);
  return rounded;
}

function readGribSections(buffer: Buffer) {
  if (buffer.subarray(0, 4).toString() !== "GRIB") throw new Error("MRMS file is not a GRIB2 message.");
  const sections = new Map<number, number>();
  let offset = 16;
  while (offset < buffer.length - 4) {
    if (buffer.subarray(offset, offset + 4).toString() === "7777") break;
    const length = buffer.readUInt32BE(offset);
    const section = buffer.readUInt8(offset + 4);
    sections.set(section, offset);
    offset += length;
  }
  return sections;
}

function parseLatLonGrid(buffer: Buffer, section3: number) {
  const template = section3 + 14;
  const basicAngle = buffer.readUInt32BE(template + 24);
  const subdivisions = buffer.readUInt32BE(template + 28);
  const unit = basicAngle && subdivisions ? basicAngle / subdivisions : 1e-6;
  return {
    width: buffer.readUInt32BE(template + 16),
    height: buffer.readUInt32BE(template + 20),
    lat1: buffer.readInt32BE(template + 32) * unit,
    lon1: normalizeLon(buffer.readUInt32BE(template + 36) * unit),
    lat2: buffer.readInt32BE(template + 41) * unit,
    lon2: normalizeLon(buffer.readUInt32BE(template + 45) * unit),
    di: buffer.readUInt32BE(template + 49) * unit,
    dj: buffer.readUInt32BE(template + 53) * unit,
    scanMode: buffer.readUInt8(template + 57)
  };
}

function sampleMeshIn(grid: MrmsGrid, point: GeoPoint) {
  const cell = cellForPoint(grid, point);
  if (!cell) return null;
  return valueAtCellIn(grid, cell.x, cell.y);
}

function collectCellsWithinRadius(grid: MrmsGrid, point: GeoPoint, radiusMiles: number) {
  const center = cellForPoint(grid, point);
  if (!center) return [];
  const latPixels = Math.ceil((radiusMiles / 69) / Math.max(grid.dj, 0.000001)) + 1;
  const lonPixels = Math.ceil((radiusMiles / Math.max(1, 69 * Math.cos((point.lat * Math.PI) / 180))) / Math.max(grid.di, 0.000001)) + 1;
  const cells: GridCell[] = [];
  for (let y = Math.max(0, center.y - latPixels); y <= Math.min(grid.height - 1, center.y + latPixels); y += 1) {
    for (let x = Math.max(0, center.x - lonPixels); x <= Math.min(grid.width - 1, center.x + lonPixels); x += 1) {
      const cellPoint = pointForCell(grid, x, y);
      const distance = distanceMiles(point, cellPoint);
      if (distance > radiusMiles) continue;
      const meshIn = valueAtCellIn(grid, x, y);
      if (meshIn == null) continue;
      cells.push({ x, y, point: cellPoint, meshIn, distance });
    }
  }
  return cells;
}

function buildContourAreas(grid: MrmsGrid, property: GeoPoint, cells: GridCell[], maxMeshIn: number) {
  const thresholds = MESH_THRESHOLDS_IN.filter((threshold) => threshold <= maxMeshIn + 0.001).sort((a, b) => b - a).slice(0, 4);
  const areas: WeatherStormArea[] = [];
  for (const threshold of thresholds) {
    const components = connectedComponents(cells.filter((cell) => cell.meshIn >= threshold));
    for (const component of components.slice(0, 2)) {
      if (component.length < 2) continue;
      const polygon = hullFromCells(grid, component);
      if (polygon.length < 3) continue;
      const maxCell = [...component].sort((a, b) => b.meshIn - a.meshIn || a.distance - b.distance)[0];
      const nearest = Math.min(...component.map((cell) => cell.distance));
      const contains = pointInPolygon(property, polygon);
      areas.push({
        id: `mrms-${grid.product}-${grid.observed_at}-${threshold}`.replace(/[^a-zA-Z0-9_.-]/g, "-"),
        date: grid.observed_at.slice(0, 10),
        event_type: "hail",
        area_type: "mrms_mesh_contour",
        source: "NOAA MRMS",
        dataset: "mrms_mesh",
        magnitude: round(maxCell?.meshIn ?? threshold, 2),
        magnitude_unit: "in",
        record_count: component.length,
        contains_property: contains,
        nearest_distance_miles: round(nearest, 2),
        confidence: "high",
        basis: [
          `${grid.product} raster threshold >= ${threshold}"`,
          grid.key
        ],
        coordinates: polygon
      });
    }
  }
  return areas;
}

function connectedComponents(cells: GridCell[]) {
  const byKey = new Map(cells.map((cell) => [`${cell.x},${cell.y}`, cell]));
  const seen = new Set<string>();
  const components: GridCell[][] = [];
  for (const cell of cells) {
    const key = `${cell.x},${cell.y}`;
    if (seen.has(key)) continue;
    const queue = [cell];
    const component: GridCell[] = [];
    seen.add(key);
    while (queue.length) {
      const current = queue.shift();
      if (!current) continue;
      component.push(current);
      for (let dy = -1; dy <= 1; dy += 1) {
        for (let dx = -1; dx <= 1; dx += 1) {
          if (dx === 0 && dy === 0) continue;
          const neighborKey = `${current.x + dx},${current.y + dy}`;
          if (seen.has(neighborKey)) continue;
          const neighbor = byKey.get(neighborKey);
          if (!neighbor) continue;
          seen.add(neighborKey);
          queue.push(neighbor);
        }
      }
    }
    components.push(component);
  }
  return components.sort((a, b) => b.length - a.length);
}

function hullFromCells(grid: MrmsGrid, cells: GridCell[]) {
  const halfLon = grid.di / 2;
  const halfLat = grid.dj / 2;
  const corners = cells.flatMap((cell) => [
    { lat: cell.point.lat - halfLat, lon: cell.point.lon - halfLon },
    { lat: cell.point.lat - halfLat, lon: cell.point.lon + halfLon },
    { lat: cell.point.lat + halfLat, lon: cell.point.lon + halfLon },
    { lat: cell.point.lat + halfLat, lon: cell.point.lon - halfLon }
  ]);
  return convexHull(uniquePoints(corners));
}

function convexHull(points: GeoPoint[]) {
  const sorted = [...points].sort((a, b) => a.lon - b.lon || a.lat - b.lat);
  if (sorted.length <= 3) return sorted;
  const lower: GeoPoint[] = [];
  for (const point of sorted) {
    while (lower.length >= 2 && cross(lower[lower.length - 2] as GeoPoint, lower[lower.length - 1] as GeoPoint, point) <= 0) lower.pop();
    lower.push(point);
  }
  const upper: GeoPoint[] = [];
  for (let index = sorted.length - 1; index >= 0; index -= 1) {
    const point = sorted[index] as GeoPoint;
    while (upper.length >= 2 && cross(upper[upper.length - 2] as GeoPoint, upper[upper.length - 1] as GeoPoint, point) <= 0) upper.pop();
    upper.push(point);
  }
  upper.pop();
  lower.pop();
  return [...lower, ...upper];
}

function cross(origin: GeoPoint, a: GeoPoint, b: GeoPoint) {
  return (a.lon - origin.lon) * (b.lat - origin.lat) - (a.lat - origin.lat) * (b.lon - origin.lon);
}

function uniquePoints(points: GeoPoint[]) {
  const seen = new Set<string>();
  const unique: GeoPoint[] = [];
  for (const point of points) {
    const key = `${point.lat.toFixed(5)},${point.lon.toFixed(5)}`;
    if (seen.has(key)) continue;
    seen.add(key);
    unique.push(point);
  }
  return unique;
}

function cellForPoint(grid: MrmsGrid, point: GeoPoint) {
  const x = Math.round((point.lon - grid.lon1) / grid.di);
  const y = Math.round((grid.lat1 - point.lat) / grid.dj);
  if (x < 0 || x >= grid.width || y < 0 || y >= grid.height) return null;
  return { x, y };
}

function pointForCell(grid: MrmsGrid, x: number, y: number): GeoPoint {
  return {
    lat: grid.lat1 - y * grid.dj,
    lon: grid.lon1 + x * grid.di
  };
}

function valueAtCellIn(grid: MrmsGrid, x: number, y: number) {
  const offset = (y * grid.width + x) * 2;
  if (offset < 0 || offset + 2 > grid.data.length) return null;
  const packed = grid.data.readUInt16BE(offset);
  const meshMm = (grid.referenceValue + packed * 2 ** grid.binaryScale) / 10 ** grid.decimalScale;
  if (!Number.isFinite(meshMm) || meshMm < 0) return null;
  return meshMm / 25.4;
}

function isHailSeed(record: WeatherRecord) {
  const haystack = `${record.dataset} ${record.event_type ?? ""} ${JSON.stringify(record.raw)}`.toLowerCase();
  return haystack.includes("hail") || record.dataset === "nx3hail" || record.dataset === "mrms_mesh";
}

function uniqueDays(values: string[]) {
  return [...new Set(values.map((value) => value.slice(0, 10)).filter(Boolean))].sort();
}

function daysInRange(start: Date, end: Date) {
  const days: string[] = [];
  const cursor = new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth(), start.getUTCDate()));
  const last = new Date(Date.UTC(end.getUTCFullYear(), end.getUTCMonth(), end.getUTCDate()));
  while (cursor <= last && days.length < MAX_DAILY_FRAMES) {
    days.push(dayString(cursor));
    cursor.setUTCDate(cursor.getUTCDate() + 1);
  }
  return days;
}

function dayString(date: Date) {
  return date.toISOString().slice(0, 10);
}

function normalizeLon(value: number) {
  return value > 180 ? value - 360 : value;
}

async function fetchWithTimeout(url: string, timeoutMs: number) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

function decodeXml(value: string) {
  return value
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, "\"")
    .replace(/&#39;/g, "'");
}
