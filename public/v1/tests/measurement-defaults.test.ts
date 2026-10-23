import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test, { after } from "node:test";
import { closePlatformFixtureStores, enableExpandedPlatformFixture } from "./helpers/platform-fixture.js";

const dir = await mkdtemp(path.join(os.tmpdir(), "measurement-defaults-"));
Object.assign(process.env, { NODE_ENV: "test", PLATFORM_STORAGE_ROOT: path.join(dir, "platform"), PRICEBOOK_STORAGE_ROOT: path.join(dir, "pricebook"), FIRSTMEASURE_STORAGE_ROOT: path.join(dir, "firstmeasure"), FIRSTMEASURE_INDEX_DB_PATH: path.join(dir, "index.sqlite"), PLATFORM_HEARTBEAT_DISABLED: "1" });
after(async () => { await closePlatformFixtureStores(); await rm(dir, { recursive: true, force: true }).catch(() => {}); });

const ORG = "org_measurement_defaults";
const owner = { orgId: ORG, userId: "owner", role: "owner", permissions: { "*": true }, branchId: "default", capabilities: { effectiveByKey: { "platform.materials": true } }, applicationAccess: { management: { enabled: true, permissions: { "*": true } } } } as any;
const unit = (value: number, of: string) => ({ value, unit: of, source: "manual" });
// A 30 square hip roof with valleys, two flat squares over the porch and six steep squares.
const ROOF = { roofSquares: unit(30, "roofing_square"), flatRoofSquares: unit(2, "roofing_square"), pitch9to12Squares: unit(6, "roofing_square"), hipsLf: unit(60, "ft"), valleyLf: unit(20, "ft"), ridgesLf: unit(40, "ft"), eavesLf: unit(150, "ft"), rakesLf: unit(60, "ft"), sideWallLf: unit(23, "ft") };

test("the industry defaults are valid, and a rule cannot add feet to squares or read what roofing does not measure", async () => {
  const d = await import("../materials/measurement-defaults.js");
  const industry = d.industryMeasurementDefaults();
  assert.deepEqual(d.parseMeasurementDefaults(industry), industry);
  assert.equal(industry.materials.enabled && industry.labor.enabled, true, "an organization that never saved its own starts with both on");
  assert.deepEqual(industry.labor.items.map((entry) => entry.item), ["roofing.tear_off", "disposal.debris", "roofing.dry_in", "roofing.install", "roofing.edge_metal", "roofing.ridge_cap", "roofing.valleys", "roofing.wall_flashing", "roofing.cleanup"]);
  const mixed = structuredClone(industry); mixed.materials.rules[0]!.terms.push({ measurement: "roof.eave_length", factor: 1 });
  assert.throws(() => d.parseMeasurementDefaults(mixed), /different units/);
  const wall = structuredClone(industry); wall.materials.rules[0]!.terms = [{ measurement: "exterior_wall.net_area", factor: 1 }];
  assert.throws(() => d.parseMeasurementDefaults(wall), /not a roofing measurement/);
  const twice = structuredClone(industry); twice.labor.items.push({ item: "roofing.install", enabled: true });
  assert.throws(() => d.parseMeasurementDefaults(twice), /listed twice/);
  assert.throws(() => d.parseMeasurementDefaults({ ...industry, labor: { enabled: true, items: [{ item: "siding.install", enabled: true }] } }), /not roofing work/);
});

test("with no document, a project with just a roof report generates its materials and work from the organization's defaults", async () => {
  const s = await import("../platform/storage.js"), ds = await import("../platform/publication/datasets.js"), { systemPublicationContext, userPublicationContext } = await import("../platform/publication/context.js");
  const d = await import("../materials/measurement-defaults.js"), calculus = await import("../materials/calculus.js"), { projectScope, requiredWork } = await import("../labor/scope-artifacts.js");
  const history = await import("../history/storage.js");
  await s.createOrganization({ id: ORG, name: "Defaults" });
  await s.saveGlobal(ORG, { data: { app_flags: { platform: { expanded_access: true, materials: true } } } }, { replace: false });
  await enableExpandedPlatformFixture(ORG, { "platform.materials": true, "platform.pricebook": true });
  const pricebook = await import("../pricebook/storage.js"), book = await pricebook.getOrganizationPricebook(ORG);
  await pricebook.saveOrganizationCatalog(ORG, { ...book.catalog, items: [...book.catalog.items, { id: "our-shingle", kind: "atomic", name: "Our shingle", type: "Shingles", category: "shingle_roofs", unit: "bundle", unit_price: 55, internal_cost: 41 }] }, Number(book.manifest.revision));
  const project = async (id: string, measurements?: object) => {
    await s.upsertDocument(ORG, "projects", { id, data: { title: id } });
    if (!measurements) return;
    const writer = systemPublicationContext({ kind: "module", organizationId: ORG, projectId: id, operations: ["datasets.save", "datasets.select", "datasets.value"], mode: "command" }), target = { scope: "project" as const, organizationId: ORG, projectId: id };
    const dataset = await ds.importMeasurementDataset(writer, target, { name: "FirstMeasure report", value: { measurements } });
    await ds.selectProjectDataset(writer, target, "measurements", dataset.id, Number((await s.readDocument(ORG, "projects", id)).revision));
  };
  const ctx = (projectId: string) => userPublicationContext(owner, { projectId });
  // The shingles rule finds the organization's own shingle by type: the library product it names is not in this price book.
  const settings = d.industryMeasurementDefaults();
  settings.materials.rules[0]!.product_id = "";
  assert.equal((await d.saveMeasurementDefaults(ORG, { settings, expected_revision: 0 })).stored, true);
  await assert.rejects(() => d.saveMeasurementDefaults(ORG, { settings, expected_revision: 0 }), /changed these defaults/);

  await project("report_only", ROOF);
  const generated = await d.generateFromMeasurementDefaults(ctx("report_only"), "report_only");
  assert.equal(generated.status, "generated");
  const ledger = await calculus.readMaterialsLedger(ctx("report_only"), "report_only");
  const set = (ledger.sets as any[]).find((entry) => entry.id === (generated as any).set_id);
  assert.equal(set.origin.type, "defaults");
  const line = (key: string) => set.lines.find((entry: any) => entry.key === key);
  // Waste: 10% + 0.8% for each of the 2.67 ft of hip and valley per square + 3% of the 20% that is steep = 12.73%, to the half percent.
  assert.deepEqual([line("shingles").quantity, line("shingles").unit, line("shingles").order_quantity, line("shingles").order_unit], [31.5, "sq", 95, "bundle"], "28 shingled squares (flat ones excluded) plus 12.5% roof waste");
  assert.deepEqual([line("shingles").product_id, line("shingles").name, line("shingles").unit_cost], ["our-shingle", "Our shingle", 123], "a $41 bundle covers a third of a square");
  assert.match(line("shingles").explanation, /Roof squares 30 - Flat roof squares 2 sq \+ 12\.5% waste/);
  assert.deepEqual([line("starter").quantity, line("starter").order_quantity], [220.5, 2], "eaves and rakes plus 5%, in 120 ft bundles");
  assert.deepEqual([line("hip_ridge").quantity, line("hip_ridge").order_quantity], [105, 5]);
  assert.deepEqual([line("ice_water").quantity, line("ice_water").order_quantity], [187, 3], "one course along the eaves and one down each valley, plus 10% laps");
  assert.deepEqual([line("underlayment").quantity, line("underlayment").order_quantity], [30.8, 4]);
  assert.deepEqual([line("step_flashing").quantity, line("low_slope_cap").quantity], [25.3, 2.2]);
  assert.equal(line("headwall_flashing"), undefined, "a roof with no head walls needs no headwall flashing");
  assert.equal(line("drip_edge").product_id, "default:drip_edge", "a product the price book lacks keeps the default's own name");
  assert.ok(set.evaluations.at(-1).warnings.some((warning: string) => /penetrations/.test(warning)));
  // The work the job includes, sized by the scope set from the same measurements. No wall-flashing-free surprises: this roof has side walls.
  const work = requiredWork((await projectScope(ORG, "report_only")).sets, { measurements: { measurements: ROOF } });
  assert.deepEqual(work.map((row) => [row.item, row.quantity]), [["roofing.tear_off", 30], ["disposal.debris", 12], ["roofing.dry_in", 30], ["roofing.install", 30], ["roofing.edge_metal", 210], ["roofing.ridge_cap", 100], ["roofing.valleys", 20], ["roofing.wall_flashing", 23], ["roofing.cleanup", 1]]);
  assert.deepEqual(work[0]!.sources.map((source) => source.origin), ["defaults"]);
  const runs = await history.listGenerations(ORG, { project_id: "report_only" });
  assert.deepEqual(runs.map((run: any) => run.generator), ["materials.calculus"], "generating is recorded as the generator's run, so later edits can be told apart from it");

  // Generating again with changed defaults re-applies to the defaults as they now stand; the set is the same one.
  const changed = structuredClone(settings); changed.materials.waste.base_percent = 15;
  await d.saveMeasurementDefaults(ORG, { settings: changed });
  const again = await d.generateFromMeasurementDefaults(ctx("report_only"), "report_only");
  assert.equal((again as any).set_id, (generated as any).set_id);
  const after = ((await calculus.readMaterialsLedger(ctx("report_only"), "report_only")).sets as any[]).filter((entry) => entry.origin.type === "defaults");
  assert.equal(after.length, 1); assert.equal(after[0].lines.find((entry: any) => entry.key === "shingles").quantity, 32.9, "28 squares plus 17.5% waste");

  // A project the Project tab measured, with no dataset selected: its measurements come from the caller, as for pay sheets.
  await project("legacy");
  await assert.rejects(() => d.generateFromMeasurementDefaults(ctx("legacy"), "legacy"), /no roof measurements yet/);
  const legacy = await d.generateFromMeasurementDefaults(ctx("legacy"), "legacy", { legacy_measurements: { roofSquares: { value: 20, unit: "roofing_square" }, eavesLf: { value: 100, unit: "ft" }, bogus: { value: 9, unit: "ft" } } });
  assert.deepEqual([legacy.status, (legacy as any).measurement_source], ["generated", "project"]);
});

test("labor switched off publishes no work, and both switched off publish nothing", async () => {
  const d = await import("../materials/measurement-defaults.js"), { userPublicationContext } = await import("../platform/publication/context.js"), { projectScope, requiredWork } = await import("../labor/scope-artifacts.js");
  const s = await import("../platform/storage.js"), ds = await import("../platform/publication/datasets.js"), { systemPublicationContext } = await import("../platform/publication/context.js");
  for (const id of ["no_labor", "nothing"]) {
    await s.upsertDocument(ORG, "projects", { id, data: { title: id } });
    const writer = systemPublicationContext({ kind: "module", organizationId: ORG, projectId: id, operations: ["datasets.save", "datasets.select", "datasets.value"], mode: "command" }), target = { scope: "project" as const, organizationId: ORG, projectId: id };
    const dataset = await ds.importMeasurementDataset(writer, target, { name: "Report", value: { measurements: ROOF } });
    await ds.selectProjectDataset(writer, target, "measurements", dataset.id, Number((await s.readDocument(ORG, "projects", id)).revision));
  }
  const settings = d.industryMeasurementDefaults(); settings.labor.enabled = false;
  await d.saveMeasurementDefaults(ORG, { settings });
  const result = await d.generateFromMeasurementDefaults(userPublicationContext(owner, { projectId: "no_labor" }), "no_labor");
  assert.deepEqual([result.status, (result as any).work, (result as any).lines > 10], ["generated", 0, true]);
  assert.deepEqual(requiredWork((await projectScope(ORG, "no_labor")).sets, { measurements: { measurements: ROOF } }), [], "no labor requirements, so the work order column has nothing to show");
  settings.materials.enabled = false;
  await d.saveMeasurementDefaults(ORG, { settings });
  assert.equal((await d.generateFromMeasurementDefaults(userPublicationContext(owner, { projectId: "nothing" }), "nothing")).status, "off");
  assert.deepEqual((await projectScope(ORG, "nothing")).sets, []);
  // Labor alone is a set with work and no material lines.
  settings.labor.enabled = true;
  await d.saveMeasurementDefaults(ORG, { settings });
  const labor = await d.generateFromMeasurementDefaults(userPublicationContext(owner, { projectId: "nothing" }), "nothing");
  assert.deepEqual([labor.status, (labor as any).lines, (labor as any).work], ["generated", 0, 9]);
});

test("a document that has published a scope overrides the defaults completely", async () => {
  const d = await import("../materials/measurement-defaults.js"), calculus = await import("../materials/calculus.js"), { userPublicationContext } = await import("../platform/publication/context.js");
  const { projectScope } = await import("../labor/scope-artifacts.js"), s = await import("../platform/storage.js"), { contentHash } = await import("../platform/publication/validation.js");
  await d.saveMeasurementDefaults(ORG, { settings: d.industryMeasurementDefaults() });
  const ctx = userPublicationContext(owner, { projectId: "report_only" });
  assert.deepEqual((await projectScope(ORG, "report_only")).sets.map((set) => set.origin), ["defaults"]);
  // A document is accepted after the defaults were generated: its set joins the ledger beside them.
  const id = `materials_${contentHash("report_only").slice(0, 32)}`, row = await s.readDocument(ORG, calculus.CALCULUS_LEDGER, id);
  const ledger = row.data as any;
  ledger.sets.push({ id: "set_document", title: "Signed proposal", definition: { type: "materials_calculus", key: "signed", title: "Signed proposal", source: "return {outputs:{lines:[],warnings:[],work:[]}};", bindings: {}, inputSchema: { type: "object" }, defaults: {} }, document: {}, origin: { type: "document", title: "Signed proposal" }, revision: 1, lines: [], work: [{ item: "roofing.install" }], evaluations: [], history: [] });
  await s.upsertDocument(ORG, calculus.CALCULUS_LEDGER, { id, data: ledger, expected_revision: row.revision }, { replace: true });
  assert.deepEqual((await projectScope(ORG, "report_only")).sets.map((set) => [set.origin, set.work.map((entry) => entry.item)]), [["document", ["roofing.install"]]], "the document's scope is the whole scope: the defaults no longer count");
  assert.equal((await d.generateFromMeasurementDefaults(ctx, "report_only")).status, "document", "and they are not generated again");
});
