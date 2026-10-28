import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test, { after } from "node:test";

// The measurement and work dictionaries and the price book defaults as config library entries
// (docs/architecture/config-library.md, measurement-schemas.md, requirements.md): what a save may change, and that
// a change to an entry reaches the code that reads it.
const dir = await mkdtemp(path.join(os.tmpdir(), "config-library-dictionaries-"));
Object.assign(process.env, { NODE_ENV: "test", PRICEBOOK_STORAGE_ROOT: path.join(dir, "pricebook"), PLATFORM_STORAGE_ROOT: path.join(dir, "platform"), PLATFORM_HEARTBEAT_DISABLED: "1" });
after(async () => { await rm(dir, { recursive: true, force: true }).catch(() => {}); });

const { registerAllLibraryKinds } = await import("../config-library/kinds/index.js");
const { checkEntry } = await import("../config-library/writes.js");
const library = await import("../config-library/library.js");
registerAllLibraryKinds();
const current = (kind: string, id: string) => structuredClone(library.libraryEntry(kind, id)!.data) as any;
const errors = (kind: string, id: string, data: unknown) => checkEntry(kind, id, data).errors;

test("every checked-in dictionary and price book entry passes its own kind's checks", () => {
  for (const kind of ["measurement_definition", "measurement_partition", "measurement_schema", "measurement_equivalence", "work_item", "work_schema", "pricebook_template", "material_library", "pricebook_setup"]) {
    const entries = library.libraryEntries(kind);
    assert.ok(entries.length, `${kind} has entries`);
    for (const entry of entries) assert.deepEqual(errors(kind, entry.id, entry.data), [], `${kind}/${entry.id}`);
  }
});

test("a measurement definition's key, unit and meaning never change; its wording may", () => {
  const area = current("measurement_definition", "roof.area");
  assert.deepEqual(errors("measurement_definition", "roof.area", { ...area, label: "Roof area (sloped)" }), []);
  assert.match(errors("measurement_definition", "roof.area", { ...area, unit: "roofing_square" }).join(" "), /unit never changes/);
  assert.match(errors("measurement_definition", "roof.area", { ...area, key: "roofAreaSqFt" }).join(" "), /key never changes/);
  assert.match(errors("measurement_definition", "roof.area", { ...area, levels: ["project"] }).join(" "), /structure level can never be removed/);
  assert.match(errors("measurement_definition", "roof.other_area", { ...area }).join(" "), /already belongs to roof.area/, "one key, one meaning");
  assert.match(errors("measurement_definition", "roof.squares_shaded", { key: "shadedSquares", label: "Shaded", unit: "ft", levels: ["project"], slice: { partition: "roof.pitch_bands" }, description: "" }).join(" "), /must be in its unit/);
  assert.match(errors("measurement_definition", "roof.pitchy", { keyPattern: "^pitch2to4Squares$", label: "x", unit: "roofing_square", levels: ["project"], description: "" }).join(" "), /would claim pitch2to4Squares/);
  assert.deepEqual(errors("measurement_definition", "roof.skylight_count", { key: "skylightsEa", label: "Skylights", unit: "ea", levels: ["project", "structure"], description: "Number of skylights." }), [], "a new definition is an addition");
  const partition = current("measurement_partition", "roof.pitch_bands");
  assert.match(errors("measurement_partition", "roof.pitch_bands", { ...partition, complete: false }).join(" "), /complete never changes/);
  assert.match(errors("measurement_partition", "roof.steep_by_side", { ...partition, of: "roof.squares_9_to_12" }).join(" "), /itself a part/);
  const equivalence = current("measurement_equivalence", "roof.squares");
  assert.match(errors("measurement_equivalence", "roof.squares", { ...equivalence, measurements: ["roof.area", "roof.squares"] }).join(" "), /measurements never changes/);
  assert.match(errors("measurement_equivalence", "roof.ventilation_squares", { measurements: ["roof.ventilation_squares", "roof.area"], description: "" }).join(" "), /already in an equivalence/);
});

test("a schema only grows, under a new version", () => {
  const gutters = current("measurement_schema", "gutters");
  const grown = { ...gutters, measurements: [...gutters.measurements, { definition: "roof.valley_length", required: false }] };
  assert.match(errors("measurement_schema", "gutters", grown).join(" "), /new version/);
  assert.deepEqual(errors("measurement_schema", "gutters", { ...grown, version: "2" }), []);
  assert.match(errors("measurement_schema", "gutters", { ...gutters, version: "2", measurements: gutters.measurements.slice(0, 1) }).join(" "), /never be dropped/);
  assert.match(errors("measurement_schema", "gutters", { ...gutters, version: "2", measurements: gutters.measurements.map((entry: any) => ({ ...entry, required: !entry.required })) }).join(" "), /required never changes/);
  assert.match(errors("measurement_schema", "gutters", { ...gutters, measurements: [...gutters.measurements, { definition: "brick.count", required: true }], version: "2" }).join(" "), /not in the dictionary/);

  const work = current("work_schema", "roofing");
  const cheaper = { ...work, items: work.items.map((entry: any) => (entry.item === "disposal.debris" ? { ...entry, quantity: { ...entry.quantity, factor: 0.35 } } : entry)) };
  assert.match(errors("work_schema", "roofing", cheaper).join(" "), /new version/, "a rule of thumb may change, as a new version");
  assert.deepEqual(errors("work_schema", "roofing", { ...cheaper, version: "2" }), []);
  assert.match(errors("work_schema", "roofing", { ...work, version: "2", items: work.items.slice(1) }).join(" "), /never be dropped/);
  assert.match(errors("work_schema", "gutters", { version: "1", items: [{ item: "roofing.install", quantity: { measurements: ["roof.squares"] } }] }).join(" "), /not part of the gutters measurement schema/);
  const item = current("work_item", "roofing.tear_off");
  assert.match(errors("work_item", "roofing.tear_off", { ...item, unit: "ft2" }).join(" "), /unit never changes/);
  assert.deepEqual(errors("work_item", "roofing.tear_off", { ...item, label: "Tear off the old roof" }), []);
});

test("a dictionary edit on the library is read at once by the code that uses it", async () => {
  const m = await import("../platform/publication/measurement-schemas.js");
  const w = await import("../platform/publication/work-items.js");
  assert.equal(m.definitionForKey("skylightCount"), null);
  const base = { revision: 1, sha256: "", updated_at: "", updated_by: "test" };
  library.applyLibraryChange({ ...base, kind: "measurement_definition", id: "roof.skylight_count", title: "Skylights", data: { key: "skylightCount", label: "Skylights", unit: "ea", levels: ["project"], description: "Number of skylights." } });
  assert.equal(m.definitionForKey("skylightCount")?.id, "roof.skylight_count");
  const gutters = current("measurement_schema", "gutters");
  library.applyLibraryChange({ ...base, revision: 2, kind: "measurement_schema", id: "gutters", title: "Gutters", data: { ...gutters, version: "2", measurements: [...gutters.measurements, { definition: "roof.valley_length", required: false }] } });
  assert.equal(m.measurementSchema("gutters").version, "2");
  assert.ok(m.assessMeasurements("gutters", {}).measurements.some((entry) => entry.definition === "roof.valley_length"));
  const item = current("work_item", "roofing.cleanup");
  library.applyLibraryChange({ ...base, revision: 2, kind: "work_item", id: "roofing.cleanup", title: "Clean up the site", data: { ...item, label: "Clean up the site" } });
  assert.equal(w.workItem("roofing.cleanup")?.label, "Clean up the site");
});

test("a newer price book template reaches market books and untouched organization links, additively", async () => {
  const storage = await import("../pricebook/storage.js");
  const { defaultPricebookTemplate } = await import("../pricebook/template.js");
  const orgId = "org_library_template";
  const before = await storage.getOrganizationPricebook(orgId);
  const template = current("pricebook_template", "default");
  assert.equal(before.overlay.metadata.template_version, template.version, "a new organization starts at the library's version");
  const added = { ...template.catalog.items.find((entry: any) => entry.id === "gutter_guard"), id: "gutter_guard_premium", name: "Premium gutter guards", unitPrice: 14 };
  const next = { ...template, catalog: { ...template.catalog, items: [...template.catalog.items, added] } };
  assert.match(errors("pricebook_template", "default", next).join(" "), /raise the version/, "a new item needs a new version that lists it");
  const versioned = { ...next, version: template.version + 1, added_item_ids: { ...template.added_item_ids, [template.version + 1]: ["gutter_guard_premium"] } };
  assert.deepEqual(errors("pricebook_template", "default", versioned), []);
  assert.match(errors("pricebook_template", "default", { ...versioned, version: template.version - 1 }).join(" "), /never goes back/);
  assert.match(errors("pricebook_template", "default", { ...versioned, added_item_ids: { ...versioned.added_item_ids, 2: ["gaf_ns"] } }).join(" "), /What version 2 added never changes/);

  library.applyLibraryChange({ kind: "pricebook_template", id: "default", revision: 2, sha256: "", title: template.name, data: versioned, updated_at: "", updated_by: "test" });
  assert.equal(defaultPricebookTemplate().version, template.version + 1);
  const market = await storage.getGlobalMarketPricebook();
  assert.ok(market.catalog.items.some((entry: any) => entry.id === "gutter_guard_premium"), "the market book gains the new item");
  assert.equal(market.manifest.template_ref.version, template.version + 1);
  const after = await storage.getOrganizationPricebook(orgId);
  assert.ok(after.catalog.items.some((entry: any) => entry.id === "gutter_guard_premium"), "the organization links it once");
  assert.equal(after.overlay.metadata.template_version, template.version + 1);
});

test("the roofing setup reads its tables and research from the library", async () => {
  const roofing = await import("../pricebook/setups/roofing.js");
  const settings = current("pricebook_setup", "roofing.settings");
  assert.deepEqual(errors("pricebook_setup", "roofing.settings", { ...settings, content: { ...settings.content, default_ice_coverage: "everywhere" } }), ["The default ice coverage everywhere is not one of the choices."]);
  assert.match(errors("pricebook_setup", "roofing.catalog", { trade: "roofing", part: "settings", content: settings.content }).join(" "), /must be roofing.settings/);
  const catalog = current("pricebook_setup", "roofing.catalog");
  catalog.content.estimating_rules[0].pricebook_formula = "roofSquares - shingleSquares";
  assert.match(errors("pricebook_setup", "roofing.catalog", catalog).join(" "), /reads shingleSquares, which is not a key/);
  assert.match(errors("pricebook_setup", "roofing.suppliers", (() => { const value = current("pricebook_setup", "roofing.suppliers"); value.content.suppliers[1].library_supplier = "Nobody"; return value; })()).join(" "), /not a supplier of material_library\/roofing/);

  assert.equal(roofing.roofingSetupOptions("TX").ice_coverage.default, "perimeter_18_valleys");
  const featured = ["certainteed", ...settings.content.featured_brands.filter((id: string) => id !== "certainteed")];
  library.applyLibraryChange({ kind: "pricebook_setup", id: "roofing.settings", revision: 2, sha256: "", title: "Roofing setup defaults", updated_at: "", updated_by: "test", data: { ...settings, content: { ...settings.content, featured_brands: featured, default_ice_coverage: "eaves_36_valleys" } } });
  const options = roofing.roofingSetupOptions("TX");
  assert.equal(options.brands[0]!.id, "certainteed", "the featured order is data");
  assert.equal(options.ice_coverage.default, "eaves_36_valleys");
  assert.throws(() => roofing.roofingSelectionsSchema.parse({ defaults: { ice_coverage: "everywhere" } }), /ice and water coverage choices/);
});
