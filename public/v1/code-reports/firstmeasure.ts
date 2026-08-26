import { readArtifact, readManifest } from "../firstmeasure/storage.js";
import type { CodeReportFirstMeasure } from "./types.js";

const SQM_TO_SQFT = 10.76391041671;

type InstantStructures = {
  structures?: Array<Record<string, unknown>>;
};

export async function loadFirstMeasureEnrichment(projectId: string | undefined) {
  if (!projectId) return null;
  const manifest = await readManifest(projectId);
  const structures = await readInstantStructures(projectId);
  const xml = await readModelXml(projectId);
  const roofFaces = [...xml.matchAll(/<POLYGON\b[^>]*\btype="ROOF"[^>]*>/gi)].length
    || [...xml.matchAll(/<FACE\b[^>]*\btype="ROOF"[^>]*>/gi)].length;
  const lineCount = [...xml.matchAll(/<LINE\b/gi)].length;
  const areas = structures.map((item) => numberAt(item, ["insights", "solarPotential", "wholeRoofStats", "areaMeters2"]));
  const totalRoofAreaSqft = sumNullable(areas.map((value) => value == null ? null : value * SQM_TO_SQFT));
  const segmentCounts = structures.map((item) => arrayAt(item, ["insights", "solarPotential", "roofSegmentStats"]).length);
  const pitches = structures.flatMap((item) => arrayAt(item, ["insights", "solarPotential", "roofSegmentStats"]).map((segment) => numberAt(segment, ["pitchDegrees"])).filter(isNumber));
  const imagery = structures.map((item) => itemAt(item, ["insights", "imageryDate"])).find(Boolean) as Record<string, unknown> | undefined;
  return {
    project_id: projectId,
    address: String(manifest.address ?? "") || null,
    status: String(manifest.status ?? "") || null,
    total_roof_area_sqft: round(totalRoofAreaSqft),
    roof_face_count: roofFaces || null,
    roof_segment_count: sumNullable(segmentCounts) ?? (lineCount || null),
    predominant_pitch: predominantPitch(pitches),
    max_pitch_degrees: round(pitches.length ? Math.max(...pitches) : null),
    imagery_date: imageryDate(imagery),
    structures: structures.map((item, index) => {
      const segments = arrayAt(item, ["insights", "solarPotential", "roofSegmentStats"]);
      const area = numberAt(item, ["insights", "solarPotential", "wholeRoofStats", "areaMeters2"]);
      const groundArea = numberAt(item, ["insights", "solarPotential", "wholeRoofStats", "groundAreaMeters2"]);
      const segmentPitch = segments.map((segment) => numberAt(segment, ["pitchDegrees"])).filter(isNumber);
      return {
        label: String(item.label ?? index + 1),
        roof_area_sqft: round(area == null ? null : area * SQM_TO_SQFT),
        ground_area_sqft: round(groundArea == null ? null : groundArea * SQM_TO_SQFT),
        pitch_degrees: round(segmentPitch.length ? average(segmentPitch) : null),
        segment_count: segments.length || null
      };
    })
  } satisfies CodeReportFirstMeasure;
}

async function readInstantStructures(projectId: string) {
  const artifact = await readArtifact(projectId, "instant-structures.json").catch(() => null);
  if (!artifact) return [];
  try {
    const parsed = JSON.parse(artifact.content.toString("utf8")) as InstantStructures;
    return Array.isArray(parsed.structures) ? parsed.structures : [];
  } catch {
    return [];
  }
}

async function readModelXml(projectId: string) {
  const artifact = await readArtifact(projectId, "model_data.xml").catch(() => null);
  return artifact?.content.toString("utf8") ?? "";
}

function itemAt(value: unknown, path: string[]): unknown {
  let current = value;
  for (const key of path) {
    if (!current || typeof current !== "object") return null;
    current = (current as Record<string, unknown>)[key];
  }
  return current;
}

function numberAt(value: unknown, path: string[]) {
  const parsed = Number(itemAt(value, path));
  return Number.isFinite(parsed) ? parsed : null;
}

function arrayAt(value: unknown, path: string[]) {
  const item = itemAt(value, path);
  return Array.isArray(item) ? item as Array<Record<string, unknown>> : [];
}

function sumNullable(values: Array<number | null>) {
  const valid = values.filter(isNumber);
  return valid.length ? valid.reduce((sum, value) => sum + value, 0) : null;
}

function isNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function average(values: number[]) {
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function predominantPitch(pitches: number[]) {
  if (!pitches.length) return null;
  const avg = average(pitches);
  return `${Math.round(avg)} deg / ${Math.round(Math.tan(avg * Math.PI / 180) * 12)}:12`;
}

function imageryDate(value: Record<string, unknown> | undefined) {
  if (!value) return null;
  const year = Number(value.year);
  const month = Number(value.month);
  const day = Number(value.day);
  if (!Number.isFinite(year) || !Number.isFinite(month) || !Number.isFinite(day)) return null;
  return `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

function round(value: number | null) {
  return value == null ? null : Math.round(value * 10) / 10;
}
