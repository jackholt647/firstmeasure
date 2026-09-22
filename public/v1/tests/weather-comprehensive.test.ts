import assert from "node:assert/strict";
import test from "node:test";

import { buildStormEventSummaries } from "../weather/events.js";
import { buildHailTraceStyleHistory } from "../weather/hailtrace_model.js";
import { analyzeMrmsGrid, roundToMrmsMinute } from "../weather/mrms.js";
import { weatherReportRequestSchema } from "../weather/schemas.js";
import { buildStormAreas } from "../weather/storm_areas.js";
import type { GeoPoint, WeatherRecord } from "../weather/types.js";

test("comprehensive weather requests support history-style date ranges", () => {
  const parsed = weatherReportRequestSchema.parse({
    tier: "comprehensive",
    property: { address: "80 E 5th St, Edmond, OK 73034" },
    start_date: "2024-09-24",
    end_date: "2024-09-25",
    peril: "all"
  });

  assert.equal(parsed.tier, "comprehensive");
  assert.equal(parsed.peril, "all");
});

test("storm areas include warning polygons and estimated swaths", () => {
  const property: GeoPoint = { lat: 35, lon: -97 };
  const records: WeatherRecord[] = [
    {
      source: "IEM",
      dataset: "iem_warning",
      observed_at: "2024-09-24T22:45:00Z",
      event_type: "severe_thunderstorm_warning",
      magnitude: 1.25,
      magnitude_unit: "in",
      raw: {
        polygon_json: JSON.stringify([
          { lat: 34.9, lon: -97.1 },
          { lat: 35.1, lon: -97.1 },
          { lat: 35.1, lon: -96.9 },
          { lat: 34.9, lon: -96.9 }
        ])
      }
    },
    weatherPoint("2024-09-24T22:40:00Z", 35.01, -97.01, 0.75),
    weatherPoint("2024-09-24T22:42:00Z", 35.02, -96.98, 1),
    weatherPoint("2024-09-24T22:44:00Z", 34.99, -96.99, 1.25)
  ];

  const areas = buildStormAreas(property, records);

  assert.ok(areas.some((area) => area.area_type === "warning_polygon" && area.contains_property === true));
  assert.ok(areas.some((area) => area.area_type === "estimated_swath" && area.event_type === "hail"));
});

test("MRMS raster analysis samples MESH values and builds contour areas", () => {
  const property: GeoPoint = { lat: 35.99, lon: -97.99 };
  const grid = testMrmsGrid([
    [0, 0, 0, 0],
    [0, 1.25, 1.5, 0],
    [0, 1, 2, 0],
    [0, 0, 0, 0]
  ]);

  const analyzed = analyzeMrmsGrid(grid, property, 120);

  assert.equal(analyzed.record?.dataset, "mrms_mesh");
  assert.equal(analyzed.record?.magnitude, 2);
  assert.ok(analyzed.areas.some((area) => area.area_type === "mrms_mesh_contour" && area.magnitude === 2));
});

test("MRMS frame selection rounds to the two-minute product cadence", () => {
  assert.equal(roundToMrmsMinute(new Date("2024-09-24T23:03:44Z")).toISOString(), "2024-09-24T23:04:00.000Z");
  assert.equal(roundToMrmsMinute(new Date("2024-09-24T23:04:44Z")).toISOString(), "2024-09-24T23:04:00.000Z");
});

test("storm event summaries de-dupe repeated same-storm hail rows", () => {
  const property: GeoPoint = { lat: 35.65, lon: -97.48 };
  const events = buildStormEventSummaries(property, [
    weatherPoint("2024-09-24T23:05:00Z", 35.64, -97.5, 1),
    weatherPoint("2024-09-24T23:10:00Z", 35.63, -97.49, 1.75),
    weatherPoint("2024-09-24T23:15:00Z", 35.62, -97.48, 2.5)
  ]);

  assert.equal(events.length, 1);
  assert.equal(events[0]?.event_type, "hail");
  assert.equal(events[0]?.max_magnitude, 2.5);
  assert.equal(events[0]?.record_count, 3);
});

test("storm event summaries include warning wind tags as wind events", () => {
  const property: GeoPoint = { lat: 35.65, lon: -97.48 };
  const events = buildStormEventSummaries(property, [{
    source: "IEM",
    dataset: "iem_warning",
    observed_at: "2023-06-16T02:20:00Z",
    event_type: "severe_thunderstorm_warning",
    magnitude: 1.75,
    magnitude_unit: "in",
    raw: {
      windtag: "70.0",
      hailtag: "1.75"
    }
  }]);

  assert.equal(events[0]?.event_type, "wind");
  assert.equal(events[0]?.max_magnitude, 70);
  assert.equal(events[0]?.magnitude_unit, "mph");
  assert.equal(events[0]?.date, "2023-06-15");
});

test("hailtrace-style history is generated algorithmically from source records", () => {
  const property: GeoPoint = { lat: 35.65, lon: -97.48 };
  const events = buildHailTraceStyleHistory(property, [
    weatherPoint("2023-07-14T02:42:00Z", 35.66, -97.49, 0.75),
    weatherPoint("2023-07-14T02:46:00Z", 35.67, -97.5, 1.25),
    {
      ...weatherPoint("2023-07-14T02:50:00Z", 35.9, -97.8, 2.5),
      distance_miles: 11
    },
    {
      source: "IEM",
      dataset: "iem_lsr",
      observed_at: "2023-07-11T07:10:00Z",
      event_type: "HAIL",
      magnitude: 1.25,
      magnitude_unit: "in",
      lat: 35.66,
      lon: -97.5,
      distance_miles: 3.89,
      raw: { TYPETEXT: "HAIL", MAG: "1.25" }
    },
    {
      source: "IEM",
      dataset: "iem_warning",
      observed_at: "2023-06-18T03:50:00Z",
      event_type: "severe_thunderstorm_warning",
      magnitude: 0.75,
      magnitude_unit: "in",
      raw: {
        windtag: "70",
        hailtag: "0.75",
        property_in_polygon: "true"
      }
    }
  ]);

  assert.deepEqual(events.map((event) => `${event.date} ${event.event_type}`), [
    "2023-07-13 Hail",
    "2023-07-10 Hail",
    "2023-06-17 Wind"
  ]);
  assert.equal(events[0]?.magnitude, 1.25);
  assert.equal(events[2]?.magnitude, 70);
});

test("hailtrace-style history ignores weak distant hail noise", () => {
  const property: GeoPoint = { lat: 35.65, lon: -97.48 };
  const events = buildHailTraceStyleHistory(property, [
    {
      ...weatherPoint("2023-05-01T02:00:00Z", 35.78, -97.65, 0.75),
      distance_miles: 12
    }
  ]);

  assert.equal(events.length, 0);
});

function weatherPoint(observed_at: string, lat: number, lon: number, magnitude: number): WeatherRecord {
  return {
    source: "NOAA SWDI",
    dataset: "nx3hail",
    observed_at,
    event_type: "hail_signature",
    magnitude,
    magnitude_unit: "in",
    lat,
    lon,
    distance_miles: 0.2,
    raw: {
      ZTIME: observed_at,
      MAXSIZE: String(magnitude)
    }
  };
}

function testMrmsGrid(valuesIn: number[][]) {
  const height = valuesIn.length;
  const width = valuesIn[0]?.length ?? 0;
  const data = Buffer.alloc(width * height * 2);
  for (let y = 0; y < height; y += 1) {
    const row = valuesIn[y] ?? [];
    for (let x = 0; x < width; x += 1) {
      const inches = row[x] ?? 0;
      const millimeters = inches * 25.4;
      const packed = inches > 0 ? Math.round(millimeters * 10 + 30) : 0;
      data.writeUInt16BE(packed, (y * width + x) * 2);
    }
  }
  return {
    product: "MESH_Max_60min_00.50",
    key: "CONUS/MESH_Max_60min_00.50/20240924/test.grib2.gz",
    observed_at: "2024-09-24T23:04:00.000Z",
    width,
    height,
    lat1: 36,
    lon1: -98,
    lat2: 35.97,
    lon2: -97.97,
    di: 0.01,
    dj: 0.01,
    scanMode: 0,
    referenceValue: -30,
    binaryScale: 0,
    decimalScale: 1,
    data
  } as Parameters<typeof analyzeMrmsGrid>[0];
}
