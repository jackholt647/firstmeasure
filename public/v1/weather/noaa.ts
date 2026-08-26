import { createInterface } from "node:readline";
import { Readable } from "node:stream";

import { parseCsv } from "./csv.js";
import { fetchText } from "./http.js";
import { bboxAround, distanceMiles, round } from "./math.js";
import type { GeoPoint, WeatherRecord, WeatherSource } from "./types.js";

export type SwdiDataset = "nx3hail" | "plsr" | "warn" | "nx3structure" | "nx3meso" | "nx3tvs";

type FetchSwdiOptions = {
  point: GeoPoint;
  start: Date;
  end: Date;
  radiusMiles: number;
  dataset: SwdiDataset;
  timeoutMs: number;
};

export function formatSwdiDate(date: Date) {
  return date.toISOString().replace(/[-:T.Z]/g, "").slice(0, 12);
}

export function buildSwdiUrl(options: Omit<FetchSwdiOptions, "timeoutMs">) {
  const bbox = bboxAround(options.point, options.radiusMiles);
  const url = new URL(`https://www.ncei.noaa.gov/swdiws/csv/${options.dataset}/${formatSwdiDate(options.start)}:${formatSwdiDate(options.end)}`);
  url.searchParams.set("bbox", [bbox.minLon, bbox.minLat, bbox.maxLon, bbox.maxLat].map((value) => value.toFixed(4)).join(","));
  url.searchParams.set("limit", "100000");
  return url.toString();
}

export async function fetchSwdiDataset(options: FetchSwdiOptions): Promise<{ source: WeatherSource; records: WeatherRecord[] }> {
  const url = buildSwdiUrl(options);
  const accessedAt = new Date().toISOString();
  if (s3KeyPrefixForDataset(options.dataset) && monthKeys(options.start, options.end).length > 12) {
    const fallback = await fetchSwdiS3Monthly(options, new Error("Long history range uses monthly SWDI archive files"));
    if (fallback) return fallback;
  }
  try {
    const text = await fetchText(url, options.timeoutMs);
    const rows = parseCsv(text);
    const records = rows.map((row) => normalizeSwdiRecord(options.dataset, row, options.point))
      .filter((record) => record.distance_miles == null || record.distance_miles <= options.radiusMiles)
      .sort((a, b) => String(a.observed_at ?? "").localeCompare(String(b.observed_at ?? "")));
    return {
      source: {
        id: `noaa-swdi-${options.dataset}`,
        name: `NOAA SWDI ${options.dataset}`,
        url,
        accessed_at: accessedAt,
        status: "ok",
        record_count: records.length
      },
      records
    };
  } catch (error) {
    const fallback = await fetchSwdiS3Monthly(options, error);
    if (fallback) return fallback;
    return {
      source: {
        id: `noaa-swdi-${options.dataset}`,
        name: `NOAA SWDI ${options.dataset}`,
        url,
        accessed_at: accessedAt,
        status: "error",
        error: error instanceof Error ? error.message : String(error)
      },
      records: []
    };
  }
}

async function fetchSwdiS3Monthly(options: FetchSwdiOptions, primaryError: unknown): Promise<{ source: WeatherSource; records: WeatherRecord[] } | null> {
  const keyPrefix = s3KeyPrefixForDataset(options.dataset);
  if (!keyPrefix) return null;
  const months = monthKeys(options.start, options.end);
  const accessedAt = new Date().toISOString();
  const allRecords: WeatherRecord[] = [];
  const urls: string[] = [];
  const errors: string[] = [];

  const results = await mapWithConcurrency(months, 8, async (month) => {
    const url = `https://noaa-swdi-pds.s3.amazonaws.com/${keyPrefix}-${month}.csv`;
    try {
      const rows = await fetchAndFilterS3Csv(url, options);
      return { url, rows, error: null as string | null };
    } catch (error) {
      return { url, rows: [] as WeatherRecord[], error: `${url}: ${error instanceof Error ? error.message : String(error)}` };
    }
  });

  for (const result of results) {
    urls.push(result.url);
    allRecords.push(...result.rows);
    if (result.error) errors.push(result.error);
  }

  if (!allRecords.length && errors.length === urls.length) return null;
  return {
    source: {
      id: `noaa-swdi-s3-${options.dataset}`,
      name: `NOAA SWDI S3 ${options.dataset}`,
      url: `https://noaa-swdi-pds.s3.amazonaws.com/${keyPrefix}-YYYYMM.csv (${urls.length} monthly files scanned)`,
      accessed_at: accessedAt,
      status: errors.length ? "partial" : "ok",
      record_count: allRecords.length,
      error: errors.length ? `Monthly SWDI archive returned ${allRecords.length} record(s), but ${errors.length} monthly file(s) failed: ${errors.slice(0, 3).join("; ")}` : undefined
    },
    records: allRecords.sort((a, b) => String(a.observed_at ?? "").localeCompare(String(b.observed_at ?? "")))
  };
}

function s3KeyPrefixForDataset(dataset: SwdiDataset) {
  if (dataset === "nx3hail") return "hail";
  if (dataset === "plsr") return "plsr";
  if (dataset === "nx3structure") return "structure";
  if (dataset === "nx3meso") return "mda";
  return null;
}

function monthKeys(start: Date, end: Date) {
  const keys: string[] = [];
  const cursor = new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth(), 1));
  const stop = new Date(Date.UTC(end.getUTCFullYear(), end.getUTCMonth(), 1));
  while (cursor <= stop) {
    keys.push(`${cursor.getUTCFullYear()}${String(cursor.getUTCMonth() + 1).padStart(2, "0")}`);
    cursor.setUTCMonth(cursor.getUTCMonth() + 1);
  }
  return keys;
}

async function mapWithConcurrency<T, R>(items: T[], concurrency: number, worker: (item: T) => Promise<R>) {
  const results: R[] = new Array(items.length);
  let nextIndex = 0;
  const workerCount = Math.min(concurrency, items.length);
  await Promise.all(Array.from({ length: workerCount }, async () => {
    while (nextIndex < items.length) {
      const index = nextIndex;
      nextIndex += 1;
      results[index] = await worker(items[index] as T);
    }
  }));
  return results;
}

async function fetchAndFilterS3Csv(url: string, options: FetchSwdiOptions) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), options.timeoutMs);
  try {
    const response = await fetch(url, {
      signal: controller.signal,
      headers: {
        "User-Agent": "FirstMateWeather/1.0 (weather reports; contact support@1m8.ai)"
      }
    });
    if (response.status === 404) return [];
    if (!response.ok || !response.body) {
      throw new Error(`HTTP ${response.status}`);
    }
    const bbox = bboxAround(options.point, options.radiusMiles);
    const stream = Readable.fromWeb(response.body as unknown as import("node:stream/web").ReadableStream<Uint8Array>);
    const rl = createInterface({ input: stream, crlfDelay: Infinity });
    let header: string[] | null = null;
    const records: WeatherRecord[] = [];
    for await (const line of rl) {
      if (!line) continue;
      if (line.startsWith("#")) {
        if (!header && line.includes(",")) {
          header = line.slice(1).split(",").map((value) => value.trim());
        }
        continue;
      }
      if (!header) {
        header = line.split(",").map((value) => value.trim());
        continue;
      }
      const values = parseCsv(`${header.join(",")}\n${line}\n`)[0];
      if (!values) continue;
      const lat = Number(values.LAT ?? values.lat);
      const lon = Number(values.LON ?? values.lon);
      if (!Number.isFinite(lat) || !Number.isFinite(lon)) continue;
      if (lat < bbox.minLat || lat > bbox.maxLat || lon < bbox.minLon || lon > bbox.maxLon) continue;
      const observed = parseS3ObservedAt(values.ZTIME ?? values.ztime);
      if (observed && (observed < options.start || observed > options.end)) continue;
      const record = normalizeSwdiRecord(options.dataset, values, options.point);
      if (record.distance_miles == null || record.distance_miles <= options.radiusMiles) {
        records.push(record);
      }
    }
    return records;
  } finally {
    clearTimeout(timeout);
  }
}

function parseS3ObservedAt(value: string | undefined) {
  if (!value || !/^\d{14}$/.test(value)) return null;
  return new Date(`${value.slice(0, 4)}-${value.slice(4, 6)}-${value.slice(6, 8)}T${value.slice(8, 10)}:${value.slice(10, 12)}:${value.slice(12, 14)}Z`);
}

function normalizeSwdiRecord(dataset: SwdiDataset, row: Record<string, string>, point: GeoPoint): WeatherRecord {
  const lat = readNumber(row.lat ?? row.latitude ?? row.LAT ?? row.LATITUDE);
  const lon = readNumber(row.lon ?? row.longitude ?? row.LON ?? row.LONGITUDE);
  const observedAt = parseS3ObservedAt(row.ZTIME)?.toISOString() ?? row.ztime ?? row.utc_time ?? row.valid ?? row.issue ?? row.time ?? row.BEGIN_DATE_TIME ?? null;
  const magnitude = readMagnitude(dataset, row);
  const eventType = readEventType(dataset, row);
  return {
    source: "NOAA SWDI",
    dataset,
    observed_at: observedAt,
    event_type: eventType,
    magnitude,
    magnitude_unit: magnitude == null ? null : readMagnitudeUnit(dataset, row),
    lat,
    lon,
    distance_miles: lat != null && lon != null ? round(distanceMiles(point, { lat, lon }), 2) : null,
    raw: row
  };
}

function readNumber(value: unknown): number | null {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= -900) return null;
  return parsed;
}

function readMagnitude(dataset: SwdiDataset, row: Record<string, string>) {
  if (dataset === "nx3hail") return readNumber(row.maxsize ?? row.max_size ?? row.MAXSIZE);
  if (dataset === "plsr") return readNumber(row.magnitude ?? row.MAGNITUDE);
  if (dataset === "warn") return readNumber(row.issue_hailtag ?? row.hailtag ?? row.max_hail_size);
  if (dataset === "nx3structure") return readNumber(row.max_reflectivity ?? row.max_ref ?? row.mxref);
  return null;
}

function readMagnitudeUnit(dataset: SwdiDataset, row: Record<string, string>) {
  if (dataset === "nx3hail" || dataset === "warn") return "in";
  const type = String(row.typetext ?? row.type ?? row.event_type ?? "").toLowerCase();
  if (type.includes("wind")) return "mph";
  if (type.includes("hail")) return "in";
  if (dataset === "nx3structure") return "dBZ";
  return null;
}

function readEventType(dataset: SwdiDataset, row: Record<string, string>) {
  if (dataset === "nx3hail") return "hail_signature";
  if (dataset === "warn") return String(row.phenomena ?? row.event ?? "warning").toLowerCase();
  if (dataset === "nx3structure") return "storm_structure";
  if (dataset === "nx3meso") return "mesocyclone";
  if (dataset === "nx3tvs") return "tornado_vortex_signature";
  return String(row.typetext ?? row.type ?? row.event_type ?? "local_storm_report").toLowerCase();
}

export function nexradArchiveLinks(point: GeoPoint, radarSite: string | null, start: Date) {
  const year = start.getUTCFullYear();
  const month = String(start.getUTCMonth() + 1).padStart(2, "0");
  const day = String(start.getUTCDate()).padStart(2, "0");
  const site = radarSite ?? "nearest-site-required";
  return [
    {
      label: "NEXRAD Level-II AWS registry",
      url: "https://registry.opendata.aws/noaa-nexrad/"
    },
    {
      label: `NEXRAD Level-II archive prefix for ${site}`,
      url: `s3://unidata-nexrad-level2/${year}/${month}/${day}/${site}/`
    },
    {
      label: "NOAA radar station metadata",
      url: `https://api.weather.gov/radar/stations?stationType=WSR-88D&limit=500&lat=${point.lat}&lon=${point.lon}`
    }
  ];
}

export function mrmsArchiveLinks(start: Date) {
  const yyyy = start.getUTCFullYear();
  const mm = String(start.getUTCMonth() + 1).padStart(2, "0");
  const dd = String(start.getUTCDate()).padStart(2, "0");
  return [
    {
      label: "MRMS AWS registry",
      url: "https://registry.opendata.aws/noaa-mrms-pds/"
    },
    {
      label: "MRMS MESH public product family",
      url: "https://www.nssl.noaa.gov/projects/mrms/"
    },
    {
      label: "MRMS daily archive prefix",
      url: `s3://noaa-mrms-pds/CONUS/MESH/${yyyy}${mm}${dd}/`
    }
  ];
}
