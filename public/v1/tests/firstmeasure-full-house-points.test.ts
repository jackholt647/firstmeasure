import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  FIRSTMEASURE_COMPLEXITY_POINT_VALUES,
  firstMeasureComplexityForRoofSegments,
  firstMeasurePointValueForComplexity
} from "../firstmeasure/constants.js";
import {
  FULL_HOUSE_POINTS_DEFAULTS,
  computeFullHousePoints,
  countFullHouseModel,
  fullHouseProjectComplexity,
  wallComplexityProxy
} from "../firstmeasure/full_house_points.js";

const square = (x: number, y: number) => ({ points: [{ x, y }, { x: x + 1, y }, { x: x + 1, y: y + 1 }, { x, y: y + 1 }] });

test("wall complexity proxy weighs windows, doors and wall planes into bands 1-5", () => {
  assert.deepEqual(wallComplexityProxy({ windows: 0, doors: 0, wall_planes: 0 }), { score: 0, complexity: 1 });
  assert.deepEqual(wallComplexityProxy({ windows: 4, doors: 2, wall_planes: 5 }), { score: 8, complexity: 1 });
  assert.deepEqual(wallComplexityProxy({ windows: 4, doors: 2, wall_planes: 6 }), { score: 9, complexity: 2 });
  // A typical two-storey house: 16 wall planes, 15 windows, 3 doors.
  assert.deepEqual(wallComplexityProxy({ windows: 15, doors: 3, wall_planes: 16 }), { score: 25, complexity: 3 });
  assert.equal(wallComplexityProxy({ windows: 30, doors: 4, wall_planes: 30 }).complexity, 4);
  assert.equal(wallComplexityProxy({ windows: 60, doors: 6, wall_planes: 40 }).complexity, 5);
  assert.equal(wallComplexityProxy({ windows: -3, doors: Number.NaN, wall_planes: 2.9 }).score, 2, "bad counts never add work");
  assert.equal(wallComplexityProxy({ windows: 0, doors: 0, wall_planes: 10 }, { ...FULL_HOUSE_POINTS_DEFAULTS.wall_proxy, score_bands: [1, 2, 3, 4] }).complexity, 5, "bands are replaceable");
});

test("the completed model is counted from the reviewed snapshot", () => {
  const skylight = { type: "skylight", points: [{ x: 10, y: 10 }, { x: 11, y: 10 }] };
  const skylightBack = { type: "skylight", points: [{ x: 11, y: 11 }, { x: 10, y: 11 }] };
  const snapshot = {
    report: { lines: [skylight, skylightBack, { type: "ridge", points: [{ x: 0, y: 0 }, { x: 1, y: 0 }] }] },
    facesData: [square(0, 0), square(2, 0), square(4, 0), square(10, 10), { points: [{ x: 0, y: 0 }, { x: 1, y: 1 }] }],
    exteriorReport: {
      walls: [{ id: "W01" }, { id: "W02" }, { id: "W03" }],
      roof: [square(0, 0)],
      openings: [{ type: "window" }, { type: "window" }, { type: "door" }, { type: "garageDoor" }, { type: "garage-door" }, { type: "vent" }, { type: "gable-vent" }]
    }
  };
  assert.deepEqual(countFullHouseModel(snapshot), { roof_facets: 3, windows: 2, doors: 3, wall_planes: 3 },
    "obstacle (skylight) faces and degenerate faces are not facets; vents are neither windows nor doors");
  assert.equal(countFullHouseModel({ exteriorReport: { roof: [square(0, 0), square(1, 0)] } }).roof_facets, 2, "falls back to the wall-mode roof faces");
  assert.deepEqual(countFullHouseModel(null), { roof_facets: 0, windows: 0, doors: 0, wall_planes: 0 });
});

test("total points are roof points plus twice the wall points, mapped to one project complexity", () => {
  // Roof complexity 2 (3 pts), walls complexity 3 (4 pts): 3 + 2 x 4 = 11.
  const result = computeFullHousePoints({ roof_facets: 8, windows: 15, doors: 3, wall_planes: 16 });
  assert.equal(result.point_value, 11);
  assert.equal(result.complexity, 3, "11 is nearest the full-house total of complexity 3 (12)");
  assert.deepEqual(result.point_calculation.roof, { facets: 8, complexity: 2, points: 3 });
  assert.deepEqual(result.point_calculation.walls, { windows: 15, doors: 3, wall_planes: 16, score: 25, complexity: 3, points: 4 });
  assert.equal(result.point_calculation.mode, "full_house");
  assert.equal(result.point_calculation.total_points, 11);

  // When the walls score the same complexity as the roof, a full house is
  // exactly 3x the same roof and keeps the roof's complexity.
  for (const [facets, walls] of [[4, { windows: 2, doors: 1, wall_planes: 4 }], [8, { windows: 6, doors: 2, wall_planes: 8 }], [15, { windows: 15, doors: 3, wall_planes: 16 }], [30, { windows: 30, doors: 4, wall_planes: 30 }], [40, { windows: 60, doors: 6, wall_planes: 40 }]] as const) {
    const roofComplexity = firstMeasureComplexityForRoofSegments(facets);
    const full = computeFullHousePoints({ roof_facets: facets, ...walls });
    assert.equal(full.point_value, 3 * firstMeasurePointValueForComplexity(roofComplexity)!);
    assert.equal(full.complexity, roofComplexity);
  }

  // The dev pilot: roof complexity 2 was 3 points, 54 minutes and P30-57.
  // With a complexity-2 wall proxy it is 9 points: 162 minutes and P90-171.
  const pilot = computeFullHousePoints({ roof_facets: 8, windows: 10, doors: 2, wall_planes: 10 });
  assert.equal(pilot.point_value, 9);
  assert.equal(18 * pilot.point_value, 162);
  assert.deepEqual([10, 19].map(rate => rate * pilot.point_value), [90, 171]);

  assert.equal(computeFullHousePoints({ roof_facets: 8, windows: 10, doors: 2, wall_planes: 10 }, { ...FULL_HOUSE_POINTS_DEFAULTS, wall_multiplier: 1 }).point_value, 6, "the wall weight is a parameter");
});

test("project complexity picks the nearest full-house level and breaks ties upward", () => {
  assert.deepEqual([6, 7, 8, 9, 10, 11, 12, 15, 18, 24, 30, 45].map(total => fullHouseProjectComplexity(total, 2)), [1, 1, 2, 2, 2, 3, 3, 4, 4, 5, 5, 5]);
  assert.equal(fullHouseProjectComplexity(7.5, 2), 2);
});

test("roof regression: the roof calculation and point table are unchanged", () => {
  const original = (count: number) => count <= 0 ? 3 : count <= 5 ? 1 : count <= 10 ? 2 : count <= 20 ? 3 : count <= 35 ? 4 : 5;
  for (let count = -1; count <= 60; count++) assert.equal(firstMeasureComplexityForRoofSegments(count), original(count), `segments ${count}`);
  assert.deepEqual([1, 2, 3, 4, 5].map(level => FIRSTMEASURE_COMPLEXITY_POINT_VALUES[String(level)]), [2, 3, 4, 6, 10]);
});

test("roof regression: the editor keeps its timer for roof jobs and hides it for customer full house only", async () => {
  const editor = await readFile(new URL("../../measure/internal/editor.php", import.meta.url), "utf8");
  const source = editor.match(/window\.firstMeasureHidesPayWhileDrafting = (function\(manifest\) \{[\s\S]*?\n\s{8}\});/)?.[1];
  assert.ok(source, "editor defines firstMeasureHidesPayWhileDrafting");
  const hides = new Function(`return (${source});`)() as (manifest: unknown) => boolean;
  const hex = "0123456789abcdef0123456789abcdef";
  assert.equal(hides({ id: `exteriors_${hex}`, measurement_scope: "full_house" }), true);
  assert.equal(hides({ id: hex }), false, "roof job");
  assert.equal(hides({ id: hex, complexity: 2, point_value: 3 }), false, "roof job with points");
  assert.equal(hides({ id: `fullhouse_${hex}`, measurement_scope: "full_house", internal_only: true }), false, "internal draft workspace");
  assert.equal(hides(null), false);
  assert.match(editor, /const points = payHidden \? null : window\.firstMeasureResolveProjectPoints\(manifest\);/);
  const report = await readFile(new URL("../../measure/internal/editor_scripts/report.js", import.meta.url), "utf8");
  assert.match(report, /!window\.firstMeasureHidesPayWhileDrafting\(window\.currentProjectManifest\)\) return summary;/, "roof submissions keep the pre-submit summary");
});

test("stored point values: roof jobs follow complexity; a scored full house keeps its total", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "fm-full-house-points-"));
  Object.assign(process.env, { FIRSTMATE_ENV: "development", FIRSTMEASURE_DATA_ENVIRONMENT: "development", FIRSTMEASURE_DATABASE_MODE: "sqlite", FIRSTMEASURE_STORAGE_ROOT: path.join(root, "reports"), FIRSTMEASURE_INDEX_DB_PATH: path.join(root, "index.sqlite"), PLATFORM_STORAGE_ROOT: path.join(root, "platform") });
  const storage = await import("../firstmeasure/storage.js");
  const roofId = "a".repeat(32);
  await storage.createProject({ id: roofId, address: "1 Roof St", complexity: 2 });
  assert.equal((await storage.readManifest(roofId)).point_value, 3);
  await storage.patchManifest(roofId, { complexity: 4 });
  assert.equal((await storage.readManifest(roofId)).point_value, 6, "roof points still follow complexity");
  await storage.patchManifest(roofId, { point_value: 99 } as never);
  assert.equal((await storage.readManifest(roofId)).point_value, 6, "a roof job cannot carry a point value its complexity does not give");

  const fullId = `exteriors_${"b".repeat(32)}`;
  await storage.createProject({ id: fullId, address: "2 House St", complexity: 2, measurement_scope: "full_house" }, { customerExteriors: true });
  assert.equal((await storage.readManifest(fullId)).point_value, 3, "unscored until submission");
  const scored = computeFullHousePoints({ roof_facets: 8, windows: 15, doors: 3, wall_planes: 16 });
  await storage.patchManifest(fullId, scored as never);
  assert.equal((await storage.readManifest(fullId)).point_value, 11);
  assert.equal((await storage.readManifest(fullId)).complexity, 3);
  await storage.patchManifest(fullId, { status: "awaiting_review" });
  assert.equal((await storage.readManifest(fullId)).point_value, 11, "later writes keep the full-house total");
});
