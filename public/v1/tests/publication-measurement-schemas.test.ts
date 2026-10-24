import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const dir = await mkdtemp(path.join(os.tmpdir(), "publication-measurement-schemas-"));
process.env.NODE_ENV = "test"; process.env.PLATFORM_STORAGE_ROOT = path.join(dir, "platform"); process.env.FIRSTMEASURE_STORAGE_ROOT = path.join(dir, "firstmeasure"); process.env.FIRSTMEASURE_INDEX_DB_PATH = path.join(dir, "index.sqlite");

test("the measurement dictionary gives each key one meaning and schemas select from it", async () => {
  const m = await import("../platform/publication/measurement-schemas.js");
  const definitions = m.listMeasurementDefinitions(), schemas = m.listMeasurementSchemas();
  assert.equal(new Set(definitions.map((row) => row.id)).size, definitions.length);
  assert.equal(m.definitionForKey("roofArea")?.id, "roof.area");
  assert.equal(m.definitionForKey("pitch6Squares")?.id, "roof.squares_at_pitch", "one definition covers the family of exact-pitch keys");
  assert.equal(m.definitionForKey("pitch2to4Squares")?.id, "roof.squares_2_to_4", "a banded key is not swallowed by the exact-pitch family");
  assert.equal(m.definitionForKey("packOutFeet"), null);
  assert.deepEqual(schemas.map((row) => row.id).sort(), ["gutters", "roofing", "siding"]);
  // Overlap between kinds of work is the same definition, not two that have to be paired later.
  const uses = (id: string) => schemas.filter((row) => row.measurements.some((entry) => entry.definition === id)).map((row) => row.id).sort();
  assert.deepEqual(uses("roof.eave_length"), ["gutters", "roofing"]);
  assert.equal(schemas.find((row) => row.id === "gutters")!.measurements.find((entry) => entry.definition === "roof.eave_length")!.required, true);
  assert.equal(schemas.find((row) => row.id === "roofing")!.measurements.find((entry) => entry.definition === "roof.eave_length")!.required, false);
  // The dictionary only grows: a key cannot be claimed twice and a schema cannot name something undefined.
  assert.throws(() => m.registerMeasurementDefinition({ id: "roof.other_area", key: "roofArea", label: "Other", unit: "ft2", levels: ["project"], description: "" }), /already belongs to roof.area/);
  assert.throws(() => m.registerMeasurementDefinition({ id: "roof.area", key: "roofAreaTwo", label: "Again", unit: "ft2", levels: ["project"], description: "" }), /already defined/);
  assert.throws(() => m.registerMeasurementSchema({ id: "masonry", version: "1", title: "Masonry", description: "", measurements: [{ definition: "brick.count", required: true }] }), /not in the dictionary/);
  assert.deepEqual(m.measurementSchemaIdsForScope({ measurement_schema_ids: ["roofing", "unknown", "roofing"] }), ["roofing"]);
  assert.deepEqual(m.measurementSchemaIdsForScope({}), [], "a scope with no schema is unscoped, as hourly or salaried work is");
  const presets = (await import("../scopes/presets/index.js")).DEFAULT_SCOPE_TEMPLATES;
  const preset = (id: string) => { const row = presets.find((entry) => entry.id === id); assert.ok(row, id); return row; };
  assert.deepEqual(m.measurementSchemaIdsForScope(preset("roof_replacement")), ["roofing"]);
  assert.deepEqual(m.measurementSchemaIdsForScope(preset("repairs")), ["roofing"]);
  assert.deepEqual(m.measurementSchemaIdsForScope(preset("gutters")), ["gutters"]);
  assert.deepEqual(m.measurementSchemaIdsForScope(preset("siding_replacement")), ["siding"]);
  assert.deepEqual(m.measurementSchemaIdsForScope(preset("manual")), []);
});

test("an assessment reports what a schema still needs, per structure and without inventing zeros", async () => {
  const m = await import("../platform/publication/measurement-schemas.js");
  const value = { value: 0, unit: "ft", source: "manual" };
  const dataset = {
    measurements: { roofArea: { value: 3200, unit: "ft2", source: "firstmeasure" }, roofSquares: { value: 32, unit: "squares", source: "manual" }, eavesLf: { value: null, unit: "ft", status: "missing" }, pitch6Squares: { value: 20, unit: "roofing_square" }, pitch8Squares: { value: 12, unit: "roofing_square" }, packOutFeet: { ...value, value: 80 } },
    structures: [{ id: "house", name: "House", measurements: { roofArea: { value: 2600, unit: "ft2" }, ridgesLf: { value: 48, unit: "ft" } } }, { id: "garage", name: "Garage", measurements: { roofArea: { value: 600, unit: "ft2" } } }]
  };
  const roofing = m.assessMeasurements("roofing", dataset);
  const entry = (id: string) => roofing.measurements.find((row) => row.definition === id)!;
  assert.equal(entry("roof.area").status, "ready");
  assert.deepEqual(entry("roof.area").structures.map((row) => [row.id, row.values.roofArea?.value]), [["house", 2600], ["garage", 600]]);
  assert.equal(entry("roof.squares").status, "unit_mismatch", "a value in another unit is reported, never converted by guesswork");
  assert.equal(entry("roof.eave_length").status, "missing");
  assert.equal(entry("roof.ridge_length").status, "ready", "a value recorded only on a structure still counts");
  assert.deepEqual(Object.keys(entry("roof.squares_at_pitch").values).sort(), ["pitch6Squares", "pitch8Squares"]);
  assert.deepEqual(roofing.missing_required, ["roof.squares"]);
  assert.deepEqual(roofing.unrecognized, ["packOutFeet"], "a key no definition claims is surfaced rather than ignored");
  assert.deepEqual(m.assessMeasurements("gutters", dataset).missing_required, ["roof.eave_length"]);
  assert.deepEqual(m.assessMeasurements("siding", {}).missing_required, ["exterior_wall.net_area"]);
  assert.throws(() => m.assessMeasurements("windows", dataset), /no measurement schema/);
});

test("measurement schemas are published, and every FirstMeasure key has a definition", async () => {
  const s = await import("../platform/storage.js");
  const { systemPublicationContext } = await import("../platform/publication/context.js");
  const d = await import("../platform/publication/datasets.js");
  const { readPublishedData, describeDataProvider } = await import("../platform/publication/providers.js");
  const fm = await import("../platform/publication/firstmeasure-datasets.js");
  const m = await import("../platform/publication/measurement-schemas.js");
  try {
    d.registerDatasetProvider();
    assert.deepEqual(Object.keys(describeDataProvider("measurement-schemas")!.exports).sort(), ["assessment", "catalog", "dictionary", "manual", "partitions"]);
    await s.createOrganization({ id: "org_schemas", name: "Schemas" });
    await s.upsertDocument("org_schemas", "projects", { id: "project_schemas", data: { title: "Oak St" } });
    const writer = systemPublicationContext({ kind: "module", organizationId: "org_schemas", projectId: "project_schemas", operations: ["datasets.save", "datasets.select", "datasets.value"], mode: "command" });
    const reader = systemPublicationContext({ kind: "module", organizationId: "org_schemas", projectId: "project_schemas", operations: ["datasets.value", "measurement-schemas.assessment", "measurement-schemas.catalog", "measurement-schemas.dictionary"] });
    const target = { scope: "project" as const, organizationId: "org_schemas", projectId: "project_schemas" };
    const ref = (exported: string, args?: Record<string, unknown>) => ({ provider: "measurement-schemas", export: exported, target, ...(args ? { args } : {}) });
    const before = await readPublishedData(reader, ref("assessment", { schema: "roofing" }));
    assert.equal(before.status, "ready"); assert.equal((before as any).value.status, "unselected"); assert.deepEqual((before as any).value.missing_required, ["roof.area", "roof.squares"]);
    const saved = await d.importMeasurementDataset(writer, target, { name: "Manual", value: { measurements: { roofArea: { value: 3200, unit: "ft2", source: "manual" }, roofSquares: { value: 32, unit: "roofing_square", source: "manual" } }, structures: [{ id: "garage", name: "Garage", measurements: { roofArea: { value: 600, unit: "ft2", source: "manual" } } }] } });
    await d.selectProjectDataset(writer, target, "measurements", saved.id, Number((await s.readDocument("org_schemas", "projects", "project_schemas")).revision));
    const after = (await readPublishedData(reader, ref("assessment", { schema: "roofing" })) as any).value;
    assert.equal(after.status, "ready"); assert.equal(after.dataset_id, saved.id); assert.deepEqual(after.missing_required, []);
    assert.deepEqual(after.measurements.find((row: any) => row.definition === "roof.area").structures.map((row: any) => row.id), ["garage"]);
    assert.equal(((await readPublishedData(reader, ref("catalog")) as any).value as any[]).length, m.listMeasurementSchemas().length);
    assert.ok(((await readPublishedData(reader, ref("dictionary")) as any).value as any[]).some((row) => row.id === "exterior_wall.net_area" && row.key === "wallNetArea"));
    await assert.rejects(() => d.importMeasurementDataset(writer, target, { name: "Bad", value: { measurements: {}, structures: [{ name: "No id", measurements: {} }] } }), "a structure needs an identity");

    // FirstMeasure is one producer filling the dictionary's keys; it may not introduce a name of its own.
    const linear = ["ridge", "hip", "valley", "rake", "eave", "head_wall", "side_wall", "stepflash", "trans", "parapet", "protrusion", "chimney_back", "chimney_edge", "chimney_front", "skylight", "unknown"];
    const report = fm.measurementPayloadFromSavedReport({ report: { materials: { linear: Object.fromEntries(linear.map((type) => [type, 10])), squares: { "4/12": 10, "7.5/12": 5 }, totalSquares: 15, ventilationSquares: 15 } } });
    const exterior = fm.measurementPayloadFromExterior({ version: 1, units: "ft", totals: Object.fromEntries(["gross", "net", "openingArea", "openingPerimeter", "top", "bottom", "transitions", "terminations", "inside", "outside", "returns"].map((field) => [field, 5])) }, "report").measurements;
    const xml = fm.measurementPayloadFromRoofplan([1, 3, 5, 7, 10, 14].map((pitch, index) => `<FACE id="f${index}"><POLYGON size="100" pitch="${pitch}"/></FACE>`).join(""), "report").measurements;
    for (const [producer, measurements] of Object.entries({ report, exterior, xml })) {
      assert.ok(Object.keys(measurements).length > 3, producer);
      for (const [key, value] of Object.entries(measurements)) { const definition = m.definitionForKey(key); assert.ok(definition, `${producer} writes ${key}, which has no definition`); assert.equal(value.unit, definition!.unit, `${key} unit`); }
    }
  } finally { await (await import("../firstmeasure/project_index.js")).closeFirstMeasureProjectIndex(); await rm(dir, { recursive: true, force: true }); }
});

test("a report with several structures publishes each structure's measurements as well as the total", async () => {
  const fm = await import("../platform/publication/firstmeasure-datasets.js");
  const m = await import("../platform/publication/measurement-schemas.js");
  const points = `<POINTS><POINT data="0,0,10" id="C1"/><POINT data="30,0,10" id="C2"/><POINT data="0,0,20" id="C3"/><POINT data="12,0,20" id="C4"/></POINTS>`;
  const roof = (id: string, area: number, pitch: number, line: string) => `<ROOF id="${id}"><FACES><FACE id="F1" type="ROOF"><POLYGON id="P1" path="L1" pitch="${pitch}" size="${area}"/></FACE></FACES><LINES>${line}</LINES></ROOF>`;
  const xml = `<STRUCTURES>${roof("ROOF1", 2600, 6, `<LINE id="L1" path="C1,C2" type="RIDGE"/>`)}${roof("ROOF2", 600, 4, `<LINE id="L2" path="C3,C4" type="RIDGE"/>`)}${points}</STRUCTURES>`;
  const payload = fm.measurementPayloadFromRoofplan(xml, "report") as any;
  assert.equal(payload.measurements.roofArea.value, 3200); assert.equal(payload.measurements.ridgesLf.value, 42);
  assert.deepEqual(payload.structures.map((row: any) => [row.id, row.name, row.measurements.roofArea.value, row.measurements.ridgesLf.value]), [["ROOF1", "Structure 1", 2600, 30], ["ROOF2", "Structure 2", 600, 12]]);
  assert.equal(payload.structures[1].measurements.pitch2to4Squares.value, 6);
  const area = m.assessMeasurements("roofing", payload).measurements.find((row) => row.definition === "roof.area")!;
  assert.deepEqual(area.structures.map((row) => row.id), ["ROOF1", "ROOF2"]);
  assert.equal((fm.measurementPayloadFromRoofplan(`<STRUCTURES>${roof("ROOF1", 2600, 6, "")}${points}</STRUCTURES>`, "report") as any).structures, undefined, "one structure is just the total");
});
