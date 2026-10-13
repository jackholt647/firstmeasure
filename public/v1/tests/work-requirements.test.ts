import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test, { after } from "node:test";
import { closePlatformFixtureStores, enableExpandedPlatformFixture } from "./helpers/platform-fixture.js";

const dir = await mkdtemp(path.join(os.tmpdir(), "work-requirements-"));
Object.assign(process.env, { NODE_ENV: "test", PLATFORM_STORAGE_ROOT: path.join(dir, "platform"), PRICEBOOK_STORAGE_ROOT: path.join(dir, "pricebook"), FIRSTMEASURE_STORAGE_ROOT: path.join(dir, "firstmeasure"), FIRSTMEASURE_INDEX_DB_PATH: path.join(dir, "index.sqlite"), PLATFORM_HEARTBEAT_DISABLED: "1" });
after(async () => { await closePlatformFixtureStores(); await rm(dir, { recursive: true, force: true }).catch(() => {}); });

const ORG = "org_requirements";
const owner = { orgId: ORG, userId: "owner", role: "owner", permissions: {}, branchId: "default" } as any;
const unit = (value: number, of: string) => ({ value, unit: of, source: "manual" });

test("measurements say what they are a part of, so overlap is known and parts are never added up by mistake", async () => {
  const m = await import("../platform/publication/measurement-schemas.js");
  assert.equal(m.measurementBase("roof.squares_9_to_12"), "roof.squares"); assert.equal(m.measurementBase("roof.squares"), "roof.squares"); assert.equal(m.measurementBase("roof.eave_length"), "roof.eave_length");
  assert.equal(m.measurementRelation("roof.squares_9_to_12", "roof.squares"), "part"); assert.equal(m.measurementRelation("roof.squares", "roof.squares_9_to_12"), "whole");
  assert.equal(m.measurementRelation("roof.squares_9_to_12", "roof.squares_13_plus"), "disjoint", "two bands of one partition never share a square");
  assert.equal(m.measurementRelation("roof.squares_9_to_12", "roof.squares_hand_carried"), "overlap", "hand-carried squares are some of the same squares the pitch bands count");
  assert.equal(m.measurementRelation("roof.squares_9_to_12", "roof.squares_at_pitch"), "overlap", "bands and exact pitches are two cuts of the same squares");
  assert.equal(m.measurementRelation("roof.squares", "roof.eave_length"), "unrelated");
  const bands = m.listMeasurementDefinitions().filter((definition) => definition.slice?.partition === "roof.pitch_bands").map((definition) => definition.id);
  assert.equal(bands.length, 6);
  assert.equal(m.measurementCover("roof.squares", bands), "whole", "every band of a complete partition is the whole roof");
  assert.equal(m.measurementCover("roof.squares", bands.slice(1)), "part"); assert.equal(m.measurementCover("roof.squares", ["roof.squares_hand_carried"]), "part", "an incomplete partition never adds up to the whole");
  assert.equal(m.measurementCover("roof.squares", ["roof.squares_at_pitch"]), "whole"); assert.equal(m.measurementCover("roof.squares", ["roof.eave_length"]), "none");
  assert.deepEqual(m.measurementWhole("roof.squares", [...bands, "roof.squares_hand_carried"]).sort(), [...bands].sort(), "what is left over counts some of the same squares again");
  // The dictionary still only grows: a part must name a known partition in its base's unit, and a part cannot be cut again.
  assert.throws(() => m.registerMeasurementDefinition({ id: "roof.squares_shaded", key: "shadedSquares", label: "Shaded", unit: "roofing_square", levels: ["project"], slice: { partition: "roof.nope" }, description: "" }), /not defined/);
  assert.throws(() => m.registerMeasurementDefinition({ id: "roof.feet_steep", key: "steepFeet", label: "Steep feet", unit: "ft", levels: ["project"], slice: { partition: "roof.pitch_bands" }, description: "" }), /must be in its unit/);
  assert.throws(() => m.registerMeasurementPartition({ id: "roof.steep_by_side", of: "roof.squares_9_to_12", dimension: "roof.side", label: "By side", complete: true, description: "" }), /itself a part/);
});

test("a kind of work lists what its jobs require, sized from measurements and never priced", async () => {
  const w = await import("../platform/publication/work-items.js");
  assert.deepEqual(w.listWorkSchemas().map((schema) => schema.id), ["roofing"]);
  assert.equal(w.listWorkItems().find((item) => item.id === "disposal.debris")!.kind, "function");
  const measurements = { measurements: { roofSquares: unit(30, "roofing_square"), eavesLf: unit(120, "ft"), rakesLf: unit(80, "ft"), ridgesLf: unit(40, "ft") } };
  const rows = w.workRequirements(["roofing"], { measurements });
  assert.deepEqual(rows.map((row) => [row.item, row.quantity, row.unit, row.under]), [
    ["roofing.tear_off", 30, "roofing_square", ""], ["disposal.debris", 12, "yd3", "roofing.tear_off"], ["roofing.dry_in", 30, "roofing_square", ""], ["roofing.install", 30, "roofing_square", ""],
    ["roofing.edge_metal", 200, "ft", ""], ["roofing.ridge_cap", 40, "ft", ""], ["roofing.cleanup", 1, "job", ""]
  ], "valleys and wall flashing are not required of a roof that has none");
  assert.equal(rows[0]!.measure, "roof.squares", "tear-off is sized by all the squares, whatever pitch they are at"); assert.equal(rows[1]!.measure, "", "disposal is worked out from squares, not measured in them");
  assert.equal(w.workRequirements(["roofing"], { measurements, fields: { existing_layers: 2 } }).find((row) => row.item === "disposal.debris")!.quantity, 24, "two layers is twice the debris");
  // Nothing measured: the work is still required, its size is unknown, and unknown is not zero.
  const blank = w.workRequirements(["roofing"], {});
  assert.deepEqual(blank.map((row) => [row.item, row.quantity]), [["roofing.tear_off", null], ["disposal.debris", null], ["roofing.dry_in", null], ["roofing.install", null], ["roofing.cleanup", 1]]);
  assert.match(blank[0]!.reason, /cannot be sized/);
  assert.throws(() => w.registerWorkItem({ id: "roofing.tear_off", label: "Again", kind: "work", unit: "sq", description: "" }), /already defined/);
  assert.throws(() => w.registerWorkSchema({ id: "gutters", version: "1", items: [{ item: "roofing.install", quantity: { measurements: ["roof.squares"] } }] }), /not part of the gutters measurement schema/);
  assert.throws(() => w.registerWorkSchema({ id: "gutters", version: "1", items: [{ item: "roofing.nope", quantity: { fixed: 1 } }] }), /not in the dictionary/);
});

test("a pay sheet maps how it is paid onto the work, and a line that reads part of the work adjusts rather than counts", async () => {
  const sheets = await import("../labor/pay-sheets.js");
  const subject = { type: "resource_group" as const, id: "g" }, measure = (definition: string) => ({ kind: "measurement" as const, definition });
  const parse = (sheet: object) => sheets.paySheetInputSchema.parse({ subject, name: "Sheet", schema_ids: ["roofing"], ...sheet });
  const stored = (sheet: object) => { const parsed = parse(sheet); return { ...parsed, id: "s", revision: 1, entries: parsed.entries.map((entry, index) => ({ ...entry, id: `e${index + 1}` })) } as any; };
  const roof = ["roofing.tear_off", "roofing.install"];
  // The base price counts; the steep and hand-carried lines read parts of the same squares, so they adjust.
  const combined = stored({ inputs: [{ name: "sq", source: measure("roof.squares") }, { name: "steep", source: measure("roof.squares_9_to_12"), required: false }, { name: "carried", source: measure("roof.squares_hand_carried"), required: false }, { name: "feet", source: { kind: "field", key: "pack_out_feet" }, required: false, default: 0 }],
    entries: [{ label: "Roof", kind: "piece_rate", rate_cents: 9000, input: "sq", covers: roof }, { label: "Steep", kind: "piece_rate", rate_cents: 1500, input: "steep", covers: roof }, { label: "Carried", kind: "piece_rate", rate_cents: 500, input: "carried", covers: roof }, { label: "Pack out", kind: "piece_rate", rate_cents: 100, input: "feet" }],
    work: [{ item: "roofing.cleanup", included: true }], equipment: [{ name: "Trailer", provides: [{ item: "disposal.debris", capacity: 10, per_load: true }] }] });
  const context = { measurements: { measurements: { roofSquares: unit(30, "roofing_square"), pitch9to12Squares: unit(12, "roofing_square"), handCarriedSquares: unit(10, "roofing_square") } }, fields: {}, manual: {} };
  const priced = sheets.evaluatePaySheet(combined, context);
  assert.deepEqual(priced.lines.map((line) => [line.label, line.quantity, line.covers || null, line.adjusts || null]), [["Roof", 30, roof, null], ["Steep", 12, null, roof], ["Carried", 10, null, roof]], "thirty squares of work is paid for once, not fifty-two");
  assert.deepEqual(priced.work.items, [{ item: "roofing.tear_off", state: "paid" }, { item: "roofing.install", state: "paid" }, { item: "roofing.cleanup", state: "included" }, { item: "disposal.debris", state: "provided" }]);
  // A sheet priced by pitch band and nothing else: the bands together are the whole roof, so they are the pay.
  const bands = ["roof.flat_squares", "roof.squares_2_to_4", "roof.squares_4_to_6", "roof.squares_6_to_8", "roof.squares_9_to_12", "roof.squares_13_plus"];
  const banded = stored({ inputs: [...bands.map((definition, index) => ({ name: `b${index}`, source: measure(definition), required: false })), { name: "carried", source: measure("roof.squares_hand_carried"), required: false }],
    entries: [...bands.map((_, index) => ({ label: `Band ${index}`, kind: "piece_rate", rate_cents: 8000 + index * 500, input: `b${index}`, covers: ["roofing.install"] })), { label: "Carried", kind: "piece_rate", rate_cents: 500, input: "carried", covers: ["roofing.install"] }] });
  const roles = sheets.paySheetCoverRoles(banded);
  assert.deepEqual(banded.entries.map((entry: any) => roles.get(entry)!.get("roofing.install")), ["counts", "counts", "counts", "counts", "counts", "counts", "adjusts"]);
  // Only some bands: nothing adds up to the roof, so the work is adjusted and never paid for. A stated role is taken at its word.
  const partial = stored({ inputs: [{ name: "steep", source: measure("roof.squares_9_to_12"), required: false }], entries: [{ label: "Steep", kind: "piece_rate", rate_cents: 1500, input: "steep", covers: ["roofing.install"] }] });
  assert.deepEqual([...sheets.paySheetWork(partial)], [["roofing.install", "adjusted"]]);
  assert.deepEqual([...sheets.paySheetWork(stored({ inputs: [{ name: "steep", source: measure("roof.squares_9_to_12"), required: false }], entries: [{ label: "Steep", kind: "piece_rate", rate_cents: 1500, input: "steep", covers: ["roofing.install"], role: "counts" }] }))], [["roofing.install", "paid"]]);

  // Evaluating for only part of the work: a line for work left to someone else is not charged; one that pays for both is charged in full and says so.
  const split = stored({ inputs: [{ name: "sq", source: measure("roof.squares") }], entries: [{ label: "Tear off", kind: "piece_rate", rate_cents: 2500, input: "sq", covers: ["roofing.tear_off"] }, { label: "Install", kind: "piece_rate", rate_cents: 6500, input: "sq", covers: ["roofing.install"] }] });
  assert.deepEqual(sheets.evaluatePaySheet(split, { ...context, scope: ["roofing.install"] }).lines.map((line) => line.label), ["Install"]);
  const whole = sheets.evaluatePaySheet(combined, { ...context, scope: ["roofing.install", "roofing.cleanup"] });
  assert.deepEqual([whole.lines[0]!.covers, whole.lines[0]!.covers_outside, whole.lines[0]!.total_cents], [["roofing.install"], ["roofing.tear_off"], 30 * 9000]);
  assert.deepEqual(whole.equipment[0]!.provides, [], "the trailer is not this evaluation's to provide");

  // Hours estimated from the work, shaped like the work: more squares, more hours; work left to someone else, fewer.
  const hourly = stored({ inputs: [{ name: "hours", source: { kind: "work_hours" } }], entries: [{ label: "Hourly", kind: "hourly", rate_cents: 10000, input: "hours", covers: roof }], work: [{ item: "roofing.tear_off", hours_per_unit: 0.2 }, { item: "roofing.install", hours_per_unit: 0.3 }], duration: { hours_per_day: 8 } });
  const work = [{ item: "roofing.tear_off", quantity: 30 }, { item: "roofing.install", quantity: 30 }];
  const estimated = sheets.evaluatePaySheet(hourly, { ...context, work });
  assert.deepEqual([estimated.lines[0]!.quantity, estimated.lines[0]!.estimated, estimated.total_cents, estimated.duration_days, estimated.work.hours], [15, true, 150000, 2, 15]);
  assert.equal(sheets.evaluatePaySheet(hourly, { ...context, work: work.map((row) => ({ ...row, quantity: 40 })) }).lines[0]!.quantity, 20);
  assert.equal(sheets.evaluatePaySheet(hourly, { ...context, work, scope: ["roofing.install"] }).lines[0]!.quantity, 9);
  const typed = sheets.evaluatePaySheet(hourly, { ...context, work, manual: { hours: 22 } });
  assert.deepEqual([typed.lines[0]!.quantity, typed.lines[0]!.estimated], [22, undefined], "a number someone typed replaces the estimate");
  const unsized = sheets.evaluatePaySheet(hourly, { ...context, work: [{ item: "roofing.tear_off", quantity: null }, { item: "roofing.install", quantity: 30 }] });
  assert.deepEqual([unsized.complete, unsized.lines.length, unsized.unresolved[0]!.covers], [false, 0, roof], "work that cannot be sized is not estimated at part of its hours");

  // The mapping is checked: work is named through a kind of work, equipment provides functions only, estimates need hours.
  const issues = (sheet: object) => { const result = sheets.paySheetInputSchema.safeParse({ subject, name: "Sheet", ...sheet }); return result.success ? [] : result.error.issues.map((issue) => issue.message); };
  assert.match(issues({ entries: [{ label: "Roof", kind: "flat", rate_cents: 100, covers: ["roofing.install"] }] }).join(" "), /must name the kind of work/);
  assert.match(issues({ schema_ids: ["roofing"], entries: [{ label: "Roof", kind: "flat", rate_cents: 100, covers: ["roofing.plumbing"] }] }).join(" "), /not in the work item dictionary/);
  assert.match(issues({ schema_ids: ["roofing"], equipment: [{ name: "Truck", provides: [{ item: "roofing.install" }] }] }).join(" "), /can only provide a function/);
  assert.match(issues({ schema_ids: ["roofing"], inputs: [{ name: "hours", source: { kind: "work_hours" } }], entries: [{ label: "Hourly", kind: "hourly", rate_cents: 100, input: "hours" }] }).join(" "), /needs hours for at least one work item/);
});

test("a project's requirements say what is open, what accounts for each thing, and what looks wrong without blocking it", async () => {
  const s = await import("../platform/storage.js"), lists = await import("../materials/storage.js"), d = await import("../platform/publication/datasets.js");
  const { systemPublicationContext } = await import("../platform/publication/context.js");
  const sheets = await import("../labor/pay-sheets.js"), g = await import("../labor/generation.js"), r = await import("../labor/requirements.js"), caps = await import("../labor/capabilities.js");
  await s.createOrganization({ id: ORG, name: "Requirements" });
  await s.saveGlobal(ORG, { data: { app_flags: { platform: { expanded_access: true, materials: true } } } }, { replace: false });
  await enableExpandedPlatformFixture(ORG, { "platform.materials": true, "platform.pricebook": true });
  await s.upsertDocument(ORG, "projects", { id: "project", data: { title: "12 Oak St" } });
  const writer = systemPublicationContext({ kind: "module", organizationId: ORG, projectId: "project", operations: ["datasets.save", "datasets.select", "datasets.value"], mode: "command" });
  const target = { scope: "project" as const, organizationId: ORG, projectId: "project" };
  const dataset = await d.importMeasurementDataset(writer, target, { name: "Manual", value: { measurements: { roofSquares: unit(30, "roofing_square"), pitch10Squares: unit(6, "roofing_square"), eavesLf: unit(180, "ft") } } });
  await d.selectProjectDataset(writer, target, "measurements", dataset.id, Number((await s.readDocument(ORG, "projects", "project")).revision));
  const pricebook = await import("../pricebook/storage.js");
  const book = await pricebook.getOrganizationPricebook(ORG);
  await pricebook.saveOrganizationCatalog(ORG, { ...book.catalog, items: [...book.catalog.items, { id: "shingle", kind: "atomic", name: "Shingles", type: "Shingles", category: "shingle_roofs", unit: "bundle", unit_price: 40 }] }, Number(book.manifest.revision));
  await (await import("../labor/sample-pay-sheets.js")).seedInstantPaySheets(ORG, owner);
  const all = await sheets.listPaySheets(ORG);
  const reference = (name: string) => { const subject = all.find((sheet) => sheet.name.startsWith(name))!.subject; return { id: subject.id, kind: subject.type, name }; };
  const read = async (hint = ["roof_replacement"]) => r.projectRequirements(ORG, "project", { scope_template_ids: hint });
  const status = (set: Awaited<ReturnType<typeof read>>) => Object.fromEntries(set.requirements.map((row) => [row.id, row.status]));
  const row = (set: Awaited<ReturnType<typeof read>>, id: string) => set.requirements.find((entry) => entry.id === id)!;

  // Nothing on the project names a kind of work yet.
  assert.deepEqual([(await read([])).status, (await read([])).requirements.length], ["empty", 0]);
  // The scope says it is roofing: everything is required and nothing accounts for any of it.
  const open = await read();
  assert.deepEqual(open.schema_ids, ["roofing"]); assert.equal(open.status, "open");
  assert.deepEqual(status(open), { material: "open", "roofing.tear_off": "open", "disposal.debris": "open", "roofing.dry_in": "open", "roofing.install": "open", "roofing.edge_metal": "open", "roofing.cleanup": "open" });
  assert.deepEqual([row(open, "disposal.debris").quantity, row(open, "disposal.debris").under, row(open, "disposal.debris").kind], [12, "roofing.tear_off", "function"]);

  // Material on a list is a requirement that is already met by its own lines.
  const materialList = await lists.createMaterialList(ORG, "project", { title: "Roof materials", resource_type: "material", items: [{ id: "m1", name: "Shingles", quantity: 90, unit: "bundle", pricebook_ref: { item_id: "shingle" } }, { id: "m2", name: "Starter", quantity: 4, unit: "box" }] }, owner);
  const withMaterial = await read();
  assert.deepEqual(withMaterial.requirements.filter((entry) => entry.kind === "material").map((entry) => [entry.label, entry.quantity, entry.unit, entry.status, entry.covered_by[0]!.list_id === String(materialList.id)]), [["Shingles", 90, "bundle", "covered", true], ["Starter", 4, "box", "covered", true]]);

  // Summit does the roof for one price, brings its truck and does the trim at no charge: everything is accounted for.
  const summit = await lists.createMaterialList(ORG, "project", { title: "Roof labor", resource_type: "labor", items: [], assignment: { work_resource_ref: reference("Summit") } }, owner);
  assert.equal(row(await read([]), "roofing.install").status, "open", "assigned but not generated: a pay sheet that would cover it is not a line that does");
  await g.generateLaborList(ORG, { list_id: String(summit.id) }, owner);
  const covered = await read([]);
  assert.equal(covered.status, "covered"); assert.deepEqual(covered.counts, { open: 0, warning: 0, covered: 8 });
  assert.deepEqual(row(covered, "roofing.tear_off").covered_by.map((entry) => [entry.assignee_name, entry.mode, entry.lines.map((line) => line.name)]), [["Summit", "paid", ["Tear off and install"]]], "the steep charge adjusts the price and is not a second cover");
  assert.deepEqual([row(covered, "disposal.debris").covered_by[0]!.mode, row(covered, "disposal.debris").covered_by[0]!.lines[0]!.name], ["provided", "Dump truck"]);
  assert.deepEqual([row(covered, "roofing.cleanup").covered_by[0]!.mode, row(covered, "roofing.cleanup").covered_by[0]!.lines.length], ["included", 0]);

  // A second work order for the same roof: everything both of them do is accounted for twice. A warning, not a block.
  const ridgeline = await lists.createMaterialList(ORG, "project", { title: "Second crew", resource_type: "labor", items: [], assignment: { work_resource_ref: reference("Ridgeline") } }, owner);
  await g.generateLaborList(ORG, { list_id: String(ridgeline.id) }, owner);
  const doubled = await read([]);
  assert.equal(doubled.status, "warning");
  assert.deepEqual(row(doubled, "roofing.tear_off").warnings.map((warning) => [warning.code, warning.message]), [["duplicate", "Accounted for twice: Ridgeline and Summit."]]);
  assert.equal(row(doubled, "disposal.debris").status, "covered", "Ridgeline does not take debris away, so only the truck accounts for it");
  assert.ok(doubled.line_warnings.some((warning) => warning.list_id === String(ridgeline.id) && warning.code === "duplicate" && /also accounted for by Summit/.test(warning.message)));

  // Split the roof: Ridgeline tears off, Summit does the rest. Summit's price is one line for both, so it still pays
  // for the tear-off it is no longer doing, and that is said rather than silently charged.
  const exclude = async (listId: unknown, items: string[]) => { const current = await lists.readMaterialList(ORG, String(listId)); await lists.patchMaterialList(ORG, String(listId), { expected_revision: Number(current.revision), metadata: { ...(current.metadata as object), work_scope: { excluded_items: items } } }, owner); await g.generateLaborList(ORG, { list_id: String(listId) }, owner); };
  await exclude(summit.id, ["roofing.tear_off"]);
  await exclude(ridgeline.id, ["roofing.dry_in", "roofing.install", "roofing.edge_metal", "roofing.ridge_cap", "roofing.valleys", "roofing.wall_flashing", "roofing.cleanup"]);
  assert.deepEqual(((await lists.readMaterialList(ORG, String(ridgeline.id))).current_items as any[]).map((item) => item.name), ["Tear off"], "the tear-off line is all that is left of Ridgeline's sheet");
  const split = await read([]);
  assert.deepEqual(row(split, "roofing.tear_off").covered_by.map((entry) => entry.assignee_name), ["Ridgeline"]);
  assert.deepEqual(row(split, "roofing.tear_off").warnings.map((warning) => warning.code), ["paid_outside"]);
  assert.match(row(split, "roofing.tear_off").warnings[0]!.message, /Summit's line "Tear off and install" also pays for this/);
  assert.deepEqual(row(split, "roofing.install").covered_by.map((entry) => entry.assignee_name), ["Summit"]); assert.equal(row(split, "roofing.install").status, "covered");
  assert.deepEqual(row(split, "roofing.install").can_cover.map((entry) => entry.assignee_name), ["Ridgeline"], "work left to someone else can be given back");
  assert.ok(split.line_warnings.some((warning) => warning.list_id === String(summit.id) && warning.code === "paid_outside"));

  // An hourly group with no truck: the work is theirs and the debris is nobody's until something is marked as taking it.
  await s.upsertDocument(ORG, "projects", { id: "second", data: { title: "4 Pine St" } });
  const held = { roofSquares: { value: 20, unit: "roofing_square" } };
  const crew = await lists.createMaterialList(ORG, "second", { title: "Labor", resource_type: "labor", items: [], assignment: { work_resource_ref: reference("Crew A") } }, owner);
  await g.generateLaborList(ORG, { list_id: String(crew.id), legacy_measurements: held }, owner);
  const second = async () => r.projectRequirements(ORG, "second", { legacy_measurements: held });
  const before = await second();
  assert.deepEqual(before.schema_ids, ["roofing"], "the sheet the work order is priced on says what kind of work it is");
  assert.deepEqual([before.status, row(before, "disposal.debris").status, row(before, "roofing.install").status, row(before, "disposal.debris").quantity], ["open", "open", "covered", 8]);
  const equipment = await lists.createMaterialList(ORG, "second", { title: "Equipment", resource_type: "equipment", items: [{ id: "dumpster", name: "10 yard dumpster", quantity: 1, unit: "ea", projected_unit_price: 450, metadata: { covers: ["disposal.debris"] } }] }, owner);
  const after = await second();
  assert.deepEqual(row(after, "disposal.debris").covered_by.map((entry) => [entry.list_id === String(equipment.id), entry.mode, entry.lines[0]!.name, entry.lines[0]!.generated]), [[true, "paid", "10 yard dumpster", false]]);
  assert.equal(row(after, "disposal.debris").status, "covered");
  // Equipment that states a capacity too small for the job is said to be short.
  const current = await lists.readMaterialList(ORG, String(equipment.id));
  await lists.createMaterialVersion(ORG, String(equipment.id), { expected_revision: Number(current.revision), reason: "revision", items: [{ id: "dumpster", name: "6 yard dumpster", quantity: 1, unit: "ea", projected_unit_price: 300, metadata: { provides: [{ item: "disposal.debris", capacity: 6 }] } }] }, owner);
  assert.deepEqual(row(await second(), "disposal.debris").warnings.map((warning) => warning.message), ["What is on the work order holds 6 cubic yards of the 8 needed."]);

  // Capabilities are apart from pay. The sample group is marked as doing roofing scopes or not at all; once someone
  // says it does not install, the work order that has it installing carries a warning.
  const crewA = all.find((sheet) => sheet.name.startsWith("Crew A"))!.subject;
  const unknown = await caps.assigneeCapabilities(ORG, crewA);
  assert.equal(unknown.known, unknown.scope_schema_ids.length > 0);
  const declared = await caps.saveCapabilities(ORG, { assignee: crewA, schema_ids: ["roofing"], excluded_item_ids: ["roofing.install"] }, owner);
  assert.deepEqual([declared.known, declared.items.includes("roofing.install"), declared.items.includes("roofing.tear_off"), declared.items.includes("disposal.debris")], [true, false, true, true]);
  assert.deepEqual(row(await second(), "roofing.install").warnings.map((warning) => warning.message), ["Crew A is not marked as able to do this."]);
  assert.deepEqual((await g.compareAssigneesForList(ORG, { list_id: String(crew.id), legacy_measurements: held })).find((entry) => entry.sheet?.name.startsWith("Crew A"))!.not_capable.map((entry) => entry.label), ["Install roofing"]);
  await assert.rejects(() => caps.saveCapabilities(ORG, { assignee: crewA, item_ids: ["roofing.plumbing"] }, owner), /not in the work item dictionary/);
  await assert.rejects(() => caps.saveCapabilities(ORG, { assignee: crewA, schema_ids: ["roofing"] }, { ...owner, role: "member", permissions: {}, accessProfile: { roles: [] } }), /company settings access/);
});
