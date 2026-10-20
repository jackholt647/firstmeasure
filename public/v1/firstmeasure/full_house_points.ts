// Production points for a customer full-house (exteriors_) report.
//
// A full house is drafted as a roof and its walls. At the drafter's submission
// both are scored from the completed model (the snapshot pinned to the reviewed
// PDF) and combined into one point value:
//
//   total points = roof points + wall_multiplier x wall points
//
// Every production consumer (the editor's post-submit summary, earnings,
// payroll, queue bands, QA ranking and QA shift points) reads the manifest's
// point_value, so the drafter and QA see one complexity, one allotted time and
// one pay tier derived from the total. Roof jobs never pass through here.
import {
  FIRSTMEASURE_COMPLEXITY_POINT_VALUES,
  firstMeasureComplexityForRoofSegments
} from "./constants.js";

type RecordValue = Record<string, unknown>;
const record = (value: unknown): RecordValue => value && typeof value === "object" && !Array.isArray(value) ? value as RecordValue : {};
const list = (value: unknown): unknown[] => Array.isArray(value) ? value : [];

export type FullHousePointsParams = {
  // How much a point of wall complexity weighs against a point of roof.
  wall_multiplier: number;
  wall_proxy: WallComplexityProxyParams;
};

export type WallComplexityProxyParams = {
  window_weight: number;
  door_weight: number;
  wall_plane_weight: number;
  // Upper score bound of complexity 1, 2, 3 and 4; anything above is 5.
  score_bands: [number, number, number, number];
};

// Defaults chosen so the average house's walls score about the same complexity
// as its roof, which makes a full house about 3x the same property's roof.
export const FULL_HOUSE_POINTS_DEFAULTS: FullHousePointsParams = {
  wall_multiplier: 2,
  wall_proxy: {
    window_weight: 0.5,
    door_weight: 0.5,
    wall_plane_weight: 1,
    score_bands: [8, 16, 30, 50]
  }
};

export type WallComplexityInput = { windows: number; doors: number; wall_planes: number };

// Wall complexity proxy (version 1): a weighted count of what a drafter places
// on the walls, banded into complexity 1-5 like the roof's facet count. It is a
// stand-in until a better measure exists; replace this function (and bump
// WALL_COMPLEXITY_PROXY_VERSION) without touching the points math around it.
export const WALL_COMPLEXITY_PROXY_VERSION = 1;
export function wallComplexityProxy(input: WallComplexityInput, params: WallComplexityProxyParams = FULL_HOUSE_POINTS_DEFAULTS.wall_proxy) {
  const count = (value: number) => Number.isFinite(value) && value > 0 ? Math.floor(value) : 0;
  const score = count(input.windows) * params.window_weight
    + count(input.doors) * params.door_weight
    + count(input.wall_planes) * params.wall_plane_weight;
  const band = params.score_bands.findIndex(bound => score <= bound);
  return { score, complexity: band < 0 ? 5 : band + 1 };
}

const pointsForComplexity = (complexity: number) => FIRSTMEASURE_COMPLEXITY_POINT_VALUES[String(complexity)] ?? 0;

const MIN_WALL_PLANE_SQFT = 1;
const DOOR_TYPES = new Set(["door", "garage", "garagedoor", "garage-door"]);

// Port of the editor's isObstacleFace (pdf.js): a face whose every corner is on
// a skylight or chimney line is an obstacle, not a roof facet.
function obstaclePointKeys(report: RecordValue) {
  const key = (p: RecordValue) => `${Number(p.x).toFixed(4)},${Number(p.y).toFixed(4)}`;
  const keys = new Set<string>();
  for (const line of list(report.lines).map(record)) {
    const type = String(line.type ?? "").toLowerCase();
    if (!["skylight", "chimney_edge", "chimney_back", "chimney_front"].includes(type)) continue;
    for (const point of list(line.points).slice(0, 2)) keys.add(key(record(point)));
  }
  return { keys, key };
}

// What the completed model contains, read from the reviewed PDF snapshot.
export function countFullHouseModel(snapshotValue: unknown) {
  const snapshot = record(snapshotValue);
  const exterior = record(snapshot.exteriorReport);
  const { keys, key } = obstaclePointKeys(record(snapshot.report));
  const facets = list(snapshot.facesData).map(record).filter(face => {
    const points = list(face.points).map(record);
    return points.length >= 3 && !(keys.size && points.every(p => keys.has(key(p))));
  });
  const roofFacets = facets.length || list(exterior.roof).filter(face => list(record(face).points).length >= 3).length;
  let windows = 0, doors = 0;
  for (const opening of list(exterior.openings).map(record)) {
    const type = String(opening.type ?? "").trim().toLowerCase();
    if (type === "window") windows += 1;
    else if (DOOR_TYPES.has(type)) doors += 1;
  }
  // Zero-area slivers the wall schedule can contain are not planes anyone drew.
  const wallPlanes = list(exterior.walls).filter(wall => Number(record(wall).gross) >= MIN_WALL_PLANE_SQFT).length;
  return { roof_facets: roofFacets, windows, doors, wall_planes: wallPlanes };
}

// The roof complexity whose full-house total is nearest the computed total, so
// a project shows one complexity on the familiar 1-5 scale.
export function fullHouseProjectComplexity(totalPoints: number, wallMultiplier: number) {
  let best = 1, bestGap = Infinity;
  for (let level = 1; level <= 5; level++) {
    const gap = Math.abs((1 + wallMultiplier) * pointsForComplexity(level) - totalPoints);
    if (gap <= bestGap) { best = level; bestGap = gap; }
  }
  return best;
}

export function computeFullHousePoints(counts: ReturnType<typeof countFullHouseModel>, params: FullHousePointsParams = FULL_HOUSE_POINTS_DEFAULTS) {
  const roofComplexity = firstMeasureComplexityForRoofSegments(counts.roof_facets);
  const roofPoints = pointsForComplexity(roofComplexity);
  const wall = wallComplexityProxy(counts, params.wall_proxy);
  const wallPoints = pointsForComplexity(wall.complexity);
  const total = roofPoints + params.wall_multiplier * wallPoints;
  const complexity = fullHouseProjectComplexity(total, params.wall_multiplier);
  return {
    complexity,
    point_value: total,
    point_calculation: {
      mode: "full_house",
      version: 1,
      wall_proxy_version: WALL_COMPLEXITY_PROXY_VERSION,
      roof: { facets: counts.roof_facets, complexity: roofComplexity, points: roofPoints },
      walls: { windows: counts.windows, doors: counts.doors, wall_planes: counts.wall_planes, score: wall.score, complexity: wall.complexity, points: wallPoints },
      wall_multiplier: params.wall_multiplier,
      total_points: total,
      project_complexity: complexity
    }
  };
}
