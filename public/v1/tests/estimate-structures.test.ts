import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import vm from "node:vm";

import { measurementPayloadFromRoofplan } from "../platform/publication/firstmeasure-datasets.js";
import { listMeasurementDefinitions, listMeasurementPartitions, listMeasurementSchemas } from "../platform/publication/measurement-schemas.js";
import { generatePieceScope } from "../pricebook/scope-generation.js";
import { scopeItemPriceResult } from "../proposals/scope.js";

// The estimate workflow runtime is a browser file; its structure helpers are pure and run here as they do there.
vm.runInThisContext(readFileSync(new URL("../../libraries/doc-workflow/firstmate-doc-workflow.js", import.meta.url), "utf8"));
const S = (globalThis as any).FMDocWorkflow.structures;
const catalog = JSON.parse(readFileSync(new URL("../../libraries/pricebook/default-pricebook.json", import.meta.url), "utf8"));
const vocabulary = { dictionary: listMeasurementDefinitions(), catalog: listMeasurementSchemas(), partitions: listMeasurementPartitions() };

// The roof step's own fields (signup-sandbox ROOF_MEASUREMENT_FIELDS): what the estimate reads.
const ROOF_FIELD_KEYS = ["roofSquares", "wastePercent", "eavesLf", "rakesLf", "ridgesLf", "hipsLf", "valleyLf", "sideWallLf", "headWallLf", "pipeBootsEa", "skylightsEa", "chimneysEa", "gutterLf", "downspoutLf"];

/** A house and a detached garage, as FirstMeasure's model file writes them (one ROOF per structure). */
function twoStructureReport() {
  const points = `<POINTS><POINT data="0,0,10" id="C1"/><POINT data="40,0,10" id="C2"/><POINT data="0,0,20" id="C3"/><POINT data="12,0,20" id="C4"/><POINT data="0,30,10" id="C5"/><POINT data="50,30,10" id="C6"/></POINTS>`;
  const roof = (id: string, area: number, pitch: number, lines: string) => `<ROOF id="${id}"><FACES><FACE id="F${id}" type="ROOF"><POLYGON id="P${id}" path="L1" pitch="${pitch}" size="${area}"/></FACE></FACES><LINES>${lines}</LINES></ROOF>`;
  const xml = `<STRUCTURES>${roof("ROOF1", 2600, 6, `<LINE id="L1" path="C1,C2" type="RIDGE"/><LINE id="L3" path="C5,C6" type="EAVE"/>`)}${roof("ROOF2", 600, 4, `<LINE id="L2" path="C3,C4" type="RIDGE"/>`)}${points}</STRUCTURES>`;
  const payload = measurementPayloadFromRoofplan(xml, "report") as any;
  // What the documents host hands the measurements step: totals as numbers (the shared loader's units), and the
  // dataset's structures through the runtime's own mapping.
  const values: Record<string, number> = {};
  for (const [key, entry] of Object.entries(payload.measurements as Record<string, { value: number; unit: string }>)) {
    const expected = /Squares$/.test(key) ? "roofing_square" : /Lf$/.test(key) ? "ft" : /Ea$/.test(key) ? "count" : "";
    if (expected && entry.unit === expected) values[key] = entry.value;
  }
  return { values, source: "the measurement report on this project", ...S.fromDataset({ datasetId: "dataset_1", revision: 3, value: payload }) };
}
const total = (measurements: Record<string, number>) => scopeItemPriceResult(generatePieceScope(catalog, "roof_replacement", { wastePercent: 10, ...measurements })).amount_cents;
const shingles = (measurements: Record<string, number>) => {
  const root = generatePieceScope(catalog, "roof_replacement", { wastePercent: 10, ...measurements }) as any;
  const lines: any[] = [];
  const walk = (list: any[]) => list.forEach((item) => { lines.push(item); walk(item.children || []); });
  walk([root]);
  // The default shingle (GAF HDZ, priced per square with waste).
  return Number(lines.find((line) => line.name === "GAF HDZ")?.quantity || 0);
};

test("a report's structures come through with their own measurements, and together they are the report", () => {
  const report = twoStructureReport();
  assert.deepEqual(report.structures.map((s: any) => [s.id, s.name, s.values.roofSquares, s.values.ridgesLf]), [["ROOF1", "Structure 1", 26, 40], ["ROOF2", "Structure 2", 6, 12]]);
  assert.equal(report.structures[0].units.roofSquares, "roofing_square");
  assert.equal(report.dataset_id, "dataset_1");
  const state = S.mergeReport(null, report, { pricing: "combined", sharedKeys: ["wastePercent"] });
  assert.equal(state.version, 1);
  assert.deepEqual(state.structures.map((s: any) => [s.id, s.origin, s.included]), [["ROOF1", "report", true], ["ROOF2", "report", true]]);
  assert.deepEqual(state.source, { label: "the measurement report on this project", dataset_id: "dataset_1", revision: 3 });
  // Everything on, nothing added: exactly the report's totals.
  assert.deepEqual(S.combine(state).values, Object.fromEntries(Object.entries(report.values).map(([key, value]) => [key, Math.round(Number(value) * 100) / 100])));
  assert.deepEqual(S.combine(state).manualKeys, []);
});

test("turning a structure off drops its measurements and the lines they drive, and turning it on restores them", () => {
  const state = S.mergeReport(null, twoStructureReport());
  const all = S.combine(state).values;
  const off = { ...state, structures: state.structures.map((s: any) => (s.id === "ROOF2" ? { ...s, included: false } : s)) };
  const withoutGarage = S.combine(off).values;
  assert.equal(withoutGarage.roofSquares, 26);
  assert.equal(withoutGarage.ridgesLf, 40);
  assert.equal(withoutGarage.pitch2to4Squares, 0, "the garage's pitch band drops out");
  assert.equal(withoutGarage.pitch4to6Squares, 26);
  assert.ok(total(withoutGarage) < total(all), "the estimate total falls with the garage off");
  assert.ok(shingles(withoutGarage) < shingles(all), "fewer shingles");
  const backOn = { ...off, structures: off.structures.map((s: any) => ({ ...s, included: true })) };
  assert.deepEqual(S.combine(backOn).values, all);
  assert.equal(total(S.combine(backOn).values), total(all));
  // The choice is the document's: a refreshed report keeps it, and keeps a structure's new name.
  const renamed = { ...off, structures: off.structures.map((s: any) => (s.id === "ROOF1" ? { ...s, name: "House" } : s)) };
  const refreshed = S.mergeReport(renamed, twoStructureReport());
  assert.deepEqual(refreshed.structures.map((s: any) => [s.name, s.included]), [["House", true], ["Structure 2", false]]);
  assert.deepEqual(S.combine(refreshed).values, withoutGarage);
});

test("a structure entered by hand asks for its kind of work's measurements, with units, and adds its lines", () => {
  const state = S.mergeReport(null, twoStructureReport());
  const combined = S.combine(state).values;
  const fields = S.fieldsFromSchemas(vocabulary, ["roofing"], ROOF_FIELD_KEYS, combined);
  const byKey = Object.fromEntries(fields.map((field: any) => [field.key, field]));
  // The roofing schema's measurements this estimate reads, per structure.
  for (const key of ["roofSquares", "eavesLf", "rakesLf", "ridgesLf", "hipsLf", "valleyLf", "sideWallLf", "headWallLf"]) assert.ok(byKey[key], `asks for ${key}`);
  // The report splits squares by pitch band, so a structure entered by hand does too; its roof squares add up from them.
  for (const key of ["flatRoofSquares", "pitch2to4Squares", "pitch4to6Squares", "pitch6to8Squares", "pitch9to12Squares", "pitch13PlusSquares"]) assert.ok(byKey[key], `asks for ${key}`);
  assert.deepEqual(byKey.roofSquares.derive_from, ["flatRoofSquares", "pitch2to4Squares", "pitch4to6Squares", "pitch6to8Squares", "pitch9to12Squares", "pitch13PlusSquares"]);
  assert.equal(byKey.roofSquares.required, true, "the schema requires roof squares");
  assert.equal(byKey.roofSquares.unit, "roofing_square");
  assert.equal(byKey.roofSquares.unit_label, "sq");
  assert.equal(byKey.eavesLf.unit, "ft");
  assert.equal(byKey.eavesLf.definition, "roof.eave_length");
  // Nothing outside the dictionary, nothing the estimate does not read, nothing shared like waste.
  assert.equal(byKey.roofArea, undefined, "roof area in square feet is not read by this estimate");
  assert.equal(byKey.wastePercent, undefined);
  assert.equal(byKey.pipeBootsEa, undefined, "pipe boots are not a dictionary measurement");
  assert.equal(fields.some((field: any) => field.key.includes("pitch") && /^pitch\d+Squares$/.test(field.key)), false, "a family of exact pitches is not asked one by one");
  // Nothing in use: the schema's required measurements.
  assert.deepEqual(S.fieldsFromSchemas(vocabulary, ["gutters"], [], {}).map((field: any) => field.key), ["eavesLf"]);

  const empty = S.manualStructure({ name: "Shed", values: {} }, fields, { id: "u1", name: "Jack" });
  assert.match(S.manualStructureError(empty, fields), /Roof squares/);
  const shed = S.manualStructure({ name: "Shed", values: { pitch4to6Squares: "4", eavesLf: 40, ridgesLf: "" } }, fields, { id: "u1", name: "Jack" });
  assert.equal(S.manualStructureError(shed, fields), null);
  assert.equal(shed.origin, "manual");
  assert.deepEqual(shed.values, { pitch4to6Squares: 4, eavesLf: 40, roofSquares: 4 });
  assert.deepEqual(shed.units, { pitch4to6Squares: "roofing_square", eavesLf: "ft", roofSquares: "roofing_square" });
  assert.deepEqual(shed.entered_by, { id: "u1", name: "Jack" });
  assert.match(shed.entered_at, /^\d{4}-\d{2}-\d{2}T/);

  const withShed = { ...state, structures: [...state.structures, shed] };
  const result = S.combine(withShed);
  assert.equal(result.values.roofSquares, combined.roofSquares + 4);
  assert.equal(result.values.pitch4to6Squares, combined.pitch4to6Squares + 4);
  assert.equal(result.values.eavesLf, combined.eavesLf + 40);
  assert.deepEqual([...result.manualKeys].sort(), ["eavesLf", "pitch4to6Squares", "roofSquares"], "values entered by hand are marked as such");
  assert.ok(total(result.values) > total(combined), "the shed's lines add to the total");
  assert.ok(shingles(result.values) > shingles(combined), "the shed's squares get shingles");
  // Report data stays report data.
  assert.deepEqual(withShed.structures.filter((s: any) => s.origin === "report").map((s: any) => s.values), state.structures.map((s: any) => s.values));
  // Off again: exactly the report.
  const shedOff = { ...withShed, structures: withShed.structures.map((s: any) => (s.origin === "manual" ? { ...s, included: false } : s)) };
  assert.deepEqual(S.combine(shedOff).values, { ...combined });
  // A report that measured one structure is one structure, and a hand-entered one adds to it.
  const single = S.mergeReport(null, { values: { roofSquares: 20, eavesLf: 100 }, structures: [] });
  assert.deepEqual(single.structures.map((s: any) => [s.id, s.origin, s.values.roofSquares]), [["report", "report", 20]]);
  assert.equal(S.combine({ ...single, structures: [...single.structures, shed] }).values.roofSquares, 24);
  // With no report at all, the structures entered by hand are the measurements.
  assert.deepEqual(S.combine({ structures: [shed] }).values, { pitch4to6Squares: 4, eavesLf: 40, roofSquares: 4 });
});

test("values someone changed by hand survive a change of structures", () => {
  const before = { roofSquares: 32, eavesLf: 50, ridgesLf: 52 };
  const after = { roofSquares: 26, eavesLf: 50, ridgesLf: 40 };
  const current = { roofSquares: 32, eavesLf: 50, ridgesLf: 60, wastePercent: 12 };
  assert.deepEqual(S.rebase(current, before, after), { roofSquares: 26, eavesLf: 50, ridgesLf: 60, wastePercent: 12 });
  assert.deepEqual(S.rebase({}, {}, after), after, "empty values fill in");
});

test("priced one section per structure, each structure prices from its own measurements and nothing is counted twice", () => {
  const state = { ...S.mergeReport(null, twoStructureReport(), { sharedKeys: ["wastePercent"] }), pricing: "per_structure" };
  assert.equal(S.pricesPerStructure(state), true);
  assert.equal(S.pricesPerStructure({ ...state, structures: state.structures.slice(0, 1) }), false, "one structure is one section");
  assert.equal(S.pricesPerStructure({ ...state, pricing: "combined" }), false);
  const current = { ...S.combine(state).values, wastePercent: 12, pipeBootsEa: 3, ridgesLf: S.combine(state).values.ridgesLf + 5 };
  const sections = S.pricingMeasurements(state, current);
  assert.deepEqual(sections.map((s: any) => s.structure.id), ["ROOF1", "ROOF2"]);
  const [house, garage] = sections.map((s: any) => s.values);
  assert.equal(house.roofSquares, 26);
  assert.equal(garage.roofSquares, 6);
  assert.equal(house.wastePercent, 12, "waste applies to every structure");
  assert.equal(garage.wastePercent, 12);
  assert.equal(house.pipeBootsEa, 3, "a count the report did not split goes to the first structure");
  assert.equal(garage.pipeBootsEa, 0);
  assert.equal(house.ridgesLf, 45, "a combined value changed by hand moves the first structure");
  assert.equal(garage.ridgesLf, 12);
  assert.ok(total(house) > total(garage) && total(garage) > 0, "each structure has its own total");

  // Each structure's lines carry its name, a reference back and their own choices.
  const tagged = [house, garage].map((values, index) => S.tagScope(generatePieceScope(catalog, "roof_replacement", values), state.structures[index]));
  assert.match(String(tagged[1].display_name), /— Structure 2$/);
  assert.deepEqual(tagged[1].structure_ref, { id: "ROOF2", name: "Structure 2", origin: "report" });
  const groupTitles = (item: any): string[] => [item.selection?.group_title, ...(item.children || []).flatMap(groupTitles)].filter(Boolean);
  assert.ok(groupTitles(tagged[1]).length > 0 && groupTitles(tagged[1]).every((title) => title.endsWith("— Structure 2")));
  const sum = tagged.reduce((acc, root) => acc + scopeItemPriceResult(root).amount_cents, 0);
  assert.equal(sum, total(house) + total(garage), "the document total is the structures' totals");
});

test("after signing, materials follow the document's structures and work is sized from its measurements", async () => {
  const { roofingCalculus } = await import("../signup-sandbox/roofing-documents.js");
  const { runModuleCode } = await import("../documents/modules/runtime.js");
  const { requiredWork } = await import("../labor/scope-artifacts.js");
  const products = ["gaf_hd", "underlayment", "starter", "ridge_cap", "drip_edge"].map((id) => ({ id, name: id, unit: ["gaf_hd", "underlayment"].includes(id) ? "sq" : "lf" }));
  const report = twoStructureReport();
  const dataset = { measurements: Object.fromEntries(Object.entries(report.values).map(([key, value]) => [key, { value, unit: /Squares$/.test(key) ? "roofing_square" : "ft" }])) };
  const calculate = async (params: Record<string, unknown>) => (await runModuleCode({ source: roofingCalculus("detailed").source, inputs: { document: { params }, values: {} }, state: {}, mode: "evaluate", now: "2026-10-22" },
    { read: async (name: string) => (name === "products" ? products : dataset), invoke: async () => { throw new Error("No effects"); } })).outputs as any;
  const state = S.mergeReport(null, report);
  state.structures[0].name = "House"; state.structures[1].name = "Garage";
  const shed = S.manualStructure({ name: "Shed", values: { pitch4to6Squares: 4, eavesLf: 40 } }, S.fieldsFromSchemas(vocabulary, ["roofing"], ROOF_FIELD_KEYS, S.combine(state).values), { name: "Jack" });
  const off = { ...state, structures: [{ ...state.structures[0] }, { ...state.structures[1], included: false }, shed] };
  const measurements = S.combine(off).values;

  // Priced together: every line is for the structures the estimate includes.
  const together = await calculate({ measurement_structures: off, measurements, scope_items: [{ id: "gaf_hd", quantity: 33 }, { id: "starter", quantity: 100 }] });
  assert.deepEqual([...new Set(together.lines.map((line: any) => line.structure))], ["House + Shed"]);
  // Work is sized from the document's measurements, with explicit units, not the project's report.
  assert.deepEqual(together.measurements.roofSquares, { value: 30, unit: "roofing_square" });
  assert.equal(together.measurements.wastePercent, undefined, "only dictionary-shaped keys are stated");
  // One section per structure: each line is for its own section's structure.
  const sections = [S.tagScope({ id: "r1", name: "Roof", children: [{ id: "gaf_hd", quantity: 29 }] }, off.structures[0]), S.tagScope({ id: "r2", name: "Roof", children: [{ id: "gaf_hd", quantity: 5 }] }, shed)];
  const each = await calculate({ measurement_structures: { ...off, pricing: "per_structure" }, measurements, scope_items: sections });
  assert.deepEqual(each.lines.map((line: any) => [line.structure, line.quantity]), [["House", 29], ["Shed", 5]]);
  // What the document calls them follows the same rule, and one structure keeps what the document calls it.
  assert.equal(S.label(off), "House + Shed");
  const single = S.mergeReport(null, { values: { roofSquares: 20 } }, { singleName: "Main house" });
  assert.equal(single.structures[0].name, "Main house");
  assert.equal((await calculate({ measurement_structures: { ...single, structures: [{ ...single.structures[0], name: "Report roof" }] }, measurements: { roofSquares: 20 }, structure: "Main house and porch", scope_items: [{ id: "gaf_hd", quantity: 20 }] })).lines[0].structure, "Main house and porch");
  // A document with no structures keeps today's behaviour: the project's measurements and its single structure.
  const plain = await calculate({ structure: "Main house", scope_items: [{ id: "gaf_hd", quantity: 20 }] });
  assert.equal(plain.lines[0].structure, "Main house");
  assert.equal(plain.measurements, undefined);

  // Requirements: tear-off is the 30 squares the estimate covers, not the report's 32.
  const set = (measurementsBasis?: Record<string, { value: number; unit: string }>) => ({ id: "set_1", title: "Roof replacement", key: "roofing_detailed", origin: "document", document_id: "doc_1", work: [{ item: "roofing.tear_off" }, { item: "roofing.edge_metal" }], lines: [], pending: false, ...(measurementsBasis ? { measurements: measurementsBasis } : {}) });
  const project = { measurements: dataset };
  const tearOff = (sets: any[]) => requiredWork(sets, project).find((row) => row.item === "roofing.tear_off")!.quantity;
  assert.equal(tearOff([set()]), 32, "without a basis, the project's measurements");
  assert.equal(tearOff([set(together.measurements)]), 30);
  assert.equal(requiredWork([set(together.measurements)], project).find((row) => row.item === "roofing.edge_metal")!.quantity, measurements.eavesLf);
});
