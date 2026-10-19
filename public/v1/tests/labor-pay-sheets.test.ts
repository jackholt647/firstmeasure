import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { closePlatformFixtureStores, enableExpandedPlatformFixture } from "./helpers/platform-fixture.js";

const dir = await mkdtemp(path.join(os.tmpdir(), "labor-pay-sheets-"));
Object.assign(process.env, { NODE_ENV: "test", PLATFORM_STORAGE_ROOT: path.join(dir, "platform"), PRICEBOOK_STORAGE_ROOT: path.join(dir, "pricebook"), FIRSTMEASURE_STORAGE_ROOT: path.join(dir, "firstmeasure"), FIRSTMEASURE_INDEX_DB_PATH: path.join(dir, "index.sqlite"), PLATFORM_HEARTBEAT_DISABLED: "1" });

const subject = { type: "organization_connection" as const, id: "conn_summit" };
const pieceRate = {
  subject, name: "Summit Roofing piece rates", schema_ids: ["roofing"],
  inputs: [
    { name: "squares", label: "Roof squares", source: { kind: "measurement", definition: "roof.squares", per_structure: true }, required: true },
    { name: "steep", source: { kind: "measurement", definition: "roof.squares_9_to_12" }, required: false },
    { name: "ridge_bundles", source: { kind: "material", item_type: "Hip & Ridge" }, required: false },
    { name: "pack_out_feet", source: { kind: "field", key: "pack_out_feet" }, required: false, default: 0 },
    { name: "layers", source: { kind: "manual" }, required: true }
  ],
  entries: [
    { label: "Tear off", kind: "piece_rate", unit: "sq", rate_cents: 4000, input: "squares" },
    { label: "Steep charge", kind: "piece_rate", unit: "sq", rate_cents: 1500, input: "steep" },
    { label: "Ridge cap", kind: "piece_rate", unit: "bundle", rate_cents: 800, input: "ridge_bundles" },
    { label: "Pack out", kind: "piece_rate", unit: "ft", rate_cents: 100, input: "pack_out_feet", minimum_cents: 5000, when: "pack_out_feet" },
    { label: "Extra layers", kind: "piece_rate", unit: "layer", rate_cents: 20000, input: "layers" },
    { label: "Dump fee", kind: "flat", rate_cents: 35000 }
  ],
  equipment: [{ name: "Dump trailer", included: true }, { name: "Shingle lift", included: false, rate_cents: 12000 }],
  duration: { input: "squares", units_per_day: 25 }
};

test("a pay sheet declares what it reads and refuses a measurement outside its kind of work", async () => {
  const { paySheetInputSchema, paySheetRequirements } = await import("../labor/pay-sheets.js");
  const sheet = paySheetInputSchema.parse(pieceRate);
  const requirements = paySheetRequirements({ ...sheet, id: "ps_1" });
  assert.deepEqual(requirements.schema_ids, ["roofing"]);
  assert.deepEqual(requirements.inputs.map((input) => [input.name, input.source.kind, input.required]), [["squares", "measurement", true], ["steep", "measurement", false], ["ridge_bundles", "material", false], ["pack_out_feet", "field", false], ["layers", "manual", true]]);
  const fails = (patch: object, pattern: RegExp) => { const result = paySheetInputSchema.safeParse({ ...pieceRate, ...patch }); assert.equal(result.success, false); assert.match(JSON.stringify((result as any).error.issues), pattern); };
  fails({ schema_ids: [] }, /must name the kind of work/);
  fails({ schema_ids: ["siding"] }, /roof\.squares is not part of siding/);
  fails({ schema_ids: ["windows"] }, /no measurement schema called windows/);
  fails({ inputs: [{ name: "area", source: { kind: "measurement", definition: "roof.made_up" } }], entries: [] }, /not in the measurement dictionary/);
  fails({ entries: [{ label: "Mystery", kind: "piece_rate", rate_cents: 100, input: "nothing" }] }, /not a declared input/);
  fails({ inputs: [{ name: "stuff", source: { kind: "material" } }], entries: [] }, /one price book item or one item type/);
  // Hourly and salaried pay reads no measurement, so it names no kind of work.
  assert.equal(paySheetInputSchema.safeParse({ subject: { type: "resource_group", id: "crew_a" }, name: "Crew A hourly", inputs: [{ name: "hours", source: { kind: "manual" } }], entries: [{ label: "Hourly", kind: "hourly", rate_cents: 3200, input: "hours" }, { label: "Foreman salary", kind: "salary", rate_cents: 150000 }] }).success, true);
});

test("the same job prices differently per sheet, leaves missing inputs unresolved and estimates days", async () => {
  const { paySheetInputSchema, evaluatePaySheet } = await import("../labor/pay-sheets.js");
  const sheet = { ...paySheetInputSchema.parse(pieceRate), id: "ps_1", revision: 1 };
  const measurements = { measurements: { roofSquares: { value: 32, unit: "roofing_square" }, pitch9to12Squares: { value: 6, unit: "roofing_square" } }, structures: [{ id: "house", name: "House", measurements: { roofSquares: { value: 26, unit: "roofing_square" } } }, { id: "garage", name: "Garage", measurements: { roofSquares: { value: 6, unit: "roofing_square" } } }] };
  const materials = [{ item_id: "lib-ridge-gaf-seal-a-ridge", item_type: "Hip & Ridge", quantity: 5, unit: "bundle" }, { item_id: "lib-shingle-gaf-hdz", item_type: "Shingles", quantity: 96, unit: "bundle" }];
  const priced = evaluatePaySheet(sheet, { measurements, materials, fields: { pack_out_feet: 30 }, manual: { layers: 1 } });
  const line = (label: string) => priced.lines.filter((row) => row.label === label);
  assert.deepEqual(line("Tear off").map((row) => [row.structure_name, row.quantity, row.total_cents]), [["House", 26, 104000], ["Garage", 6, 24000]], "a per-structure input prices each structure");
  assert.equal(line("Steep charge")[0]!.total_cents, 9000); assert.equal(line("Ridge cap")[0]!.total_cents, 4000, "material quantities come from the lists by item type");
  assert.deepEqual(priced.lines.filter((row) => row.label.startsWith("Pack out")).map((row) => [row.label, row.total_cents]), [["Pack out", 3000], ["Pack out (minimum)", 2000]], "30 ft at $1 is below the $50 minimum, and the difference is its own line"); assert.equal(line("Extra layers")[0]!.total_cents, 20000); assert.equal(line("Dump fee")[0]!.total_cents, 35000);
  assert.deepEqual(priced.equipment.map((row) => [row.name, row.included, row.total_cents]), [["Dump trailer", true, 0], ["Shingle lift", false, 12000]]);
  assert.equal(priced.total_cents, 104000 + 24000 + 9000 + 4000 + 5000 + 20000 + 35000 + 12000); assert.equal(priced.duration_days, 1.5, "32 squares at 25 a day rounds up to the next half day"); assert.equal(priced.complete, true);

  const bare = evaluatePaySheet(sheet, { measurements: {}, materials: [] });
  assert.deepEqual(bare.unresolved.map((row) => row.label), ["Tear off", "Extra layers"], "required inputs that are missing leave their lines unresolved, not zero");
  assert.deepEqual(bare.lines.map((row) => row.label), ["Dump fee"], "optional inputs with nothing recorded simply do not apply");
  assert.deepEqual(bare.missing_inputs.filter((row) => row.required).map((row) => row.name), ["squares", "layers"]); assert.equal(bare.duration_days, null); assert.equal(bare.complete, false);
  assert.equal(evaluatePaySheet(sheet, { measurements: { measurements: { roofSquares: { value: 3200, unit: "ft2" } } }, manual: { layers: 0 } }).unresolved[0]!.label, "Tear off", "a value in another unit is not the measurement");

  // A corrected total is what gets paid. Structures that do not add up to it, or that are not all measured, are not used.
  const corrected = evaluatePaySheet(sheet, { measurements: { measurements: { roofSquares: { value: 40, unit: "roofing_square" } }, structures: [{ id: "house", name: "House", measurements: { roofSquares: { value: 26, unit: "roofing_square" } } }, { id: "garage", name: "Garage", measurements: { roofSquares: { value: 3, unit: "roofing_square" } } }, { id: "shed", name: "Shed", measurements: { roofSquares: { value: 400, unit: "ft2" } } }] }, manual: { layers: 0 } });
  assert.deepEqual(corrected.lines.filter((row) => row.label === "Tear off").map((row) => [row.structure_name, row.quantity, row.total_cents]), [[undefined, 40, 160000]], "pay follows the total the estimate was built on"); assert.equal(corrected.duration_days, 2);
  // With no total recorded, structures that are all measured stand in for it.
  const structuresOnly = evaluatePaySheet(sheet, { measurements: { measurements: {}, structures: [{ id: "house", name: "House", measurements: { roofSquares: { value: 26, unit: "roofing_square" } } }, { id: "garage", name: "Garage", measurements: { roofSquares: { value: 6, unit: "roofing_square" } } }] }, manual: { layers: 0 } });
  assert.deepEqual(structuresOnly.lines.filter((row) => row.label === "Tear off").map((row) => row.quantity), [26, 6]); assert.equal(structuresOnly.duration_days, 1.5);
  // A minimum belongs to the entry, not to each structure it was priced across.
  const minimum = { ...paySheetInputSchema.parse({ ...pieceRate, entries: [{ label: "Tear off", kind: "piece_rate", unit: "sq", rate_cents: 10000, input: "squares", minimum_cents: 50000 }] }), id: "ps_min", revision: 1 };
  const small = evaluatePaySheet(minimum, { measurements: { measurements: {}, structures: [{ id: "house", name: "House", measurements: { roofSquares: { value: 30, unit: "roofing_square" } } }, { id: "garage", name: "Garage", measurements: { roofSquares: { value: 3, unit: "roofing_square" } } }] }, manual: { layers: 0 } });
  assert.deepEqual(small.lines.map((row) => [row.label, row.total_cents]), [["Tear off", 300000], ["Tear off", 30000]], "the garage is $300, not raised to the $500 minimum");
  const tiny = evaluatePaySheet(minimum, { measurements: { measurements: { roofSquares: { value: 3, unit: "roofing_square" } } }, manual: { layers: 0 } });
  assert.deepEqual(tiny.lines.map((row) => [row.label, row.total_cents]), [["Tear off", 30000], ["Tear off (minimum)", 20000]]); assert.equal(tiny.total_cents, 50000 + 12000);
  // A gate whose required input was never entered cannot be decided, so its entry is unresolved rather than dropped.
  const gated = { ...paySheetInputSchema.parse({ ...pieceRate, entries: [{ label: "Extra layers", kind: "piece_rate", rate_cents: 20000, input: "layers", when: "layers" }] }), id: "ps_gate", revision: 1 };
  const undecided = evaluatePaySheet(gated, { measurements });
  assert.deepEqual(undecided.unresolved.map((row) => [row.label, row.input]), [["Extra layers", "layers"]]); assert.equal(undecided.complete, false);
  assert.deepEqual(evaluatePaySheet(gated, { measurements, manual: { layers: 0 } }).lines, [], "entered as zero, the gate is decided and the entry does not apply");
  // Steep charges are found whether the producer wrote the band or the exact pitches.
  const exact = evaluatePaySheet(sheet, { measurements: { measurements: { roofSquares: { value: 32, unit: "roofing_square" }, pitch10Squares: { value: 7, unit: "roofing_square" }, pitch12Squares: { value: 5, unit: "roofing_square" }, pitch6Squares: { value: 20, unit: "roofing_square" } } }, manual: { layers: 0 } });
  assert.equal(exact.lines.find((row) => row.label === "Steep charge")!.quantity, 12, "10/12 and 12/12 fall in the band over 8/12 up to 12/12; 6/12 does not");
  // Quantities in different units are not added together.
  const mixed = evaluatePaySheet(sheet, { measurements, manual: { layers: 0 }, materials: [{ item_id: "a", item_type: "Hip & Ridge", quantity: 5, unit: "bundle" }, { item_id: "b", item_type: "Hip & Ridge", quantity: 40, unit: "ft" }] });
  assert.match(mixed.missing_inputs.find((row) => row.name === "ridge_bundles")!.reason, /different units \(bundle, ft\)/); assert.equal(mixed.lines.some((row) => row.label === "Ridge cap"), false);
  // When a source could not be read at all, nothing that depends on it is priced, even an optional input with a default.
  const unread = evaluatePaySheet(sheet, { measurements, manual: { layers: 0 }, unavailable: { field: "Project fields could not be read." } });
  assert.deepEqual(unread.unresolved.map((row) => [row.label, row.reason]), [["Pack out", "Project fields could not be read."]]); assert.equal(unread.complete, false);

  const hourly = { ...paySheetInputSchema.parse({ subject: { type: "resource_group", id: "crew_a" }, name: "Crew A hourly", inputs: [{ name: "hours", source: { kind: "manual" } }], entries: [{ label: "Hourly", kind: "hourly", rate_cents: 3200, input: "hours" }, { label: "Foreman salary", kind: "salary", rate_cents: 150000 }] }), id: "ps_2", revision: 1 };
  const unknown = evaluatePaySheet(hourly, { measurements, materials });
  assert.deepEqual(unknown.unresolved.map((row) => row.label), ["Hourly"], "an hourly crew is unknown until hours are entered"); assert.equal(unknown.total_cents, 0);
  const entered = evaluatePaySheet(hourly, { manual: { hours: 40 } });
  assert.equal(entered.lines.find((row) => row.kind === "hourly")!.total_cents, 128000); assert.equal(entered.lines.find((row) => row.kind === "salary")!.total_cents, null, "salary is recorded but not charged to the job"); assert.equal(entered.total_cents, 128000);
});

test("every problem names the field it is about, so the editor can show it there", async () => {
  const { paySheetInputSchema } = await import("../labor/pay-sheets.js");
  const paths = (patch: object) => { const result = paySheetInputSchema.safeParse({ ...pieceRate, ...patch }); assert.equal(result.success, false); return (result as any).error.issues.map((issue: any) => [issue.path.join("."), issue.message]); };
  assert.deepEqual(paths({ entries: [...pieceRate.entries, { label: "Mystery", kind: "piece_rate", rate_cents: 100, input: "nothing" }] }), [["entries.6.input", "Entry Mystery reads nothing, which is not a declared input."]]);
  assert.deepEqual(paths({ schema_ids: ["siding"] }).map(([path]: string[]) => path), ["inputs.0.source.definition", "inputs.1.source.definition"]);
  assert.deepEqual(paths({ entries: [{ label: "Tear off", kind: "piece_rate", rate_cents: 100, input: "squares", covers: ["roofing.plumbing"] }] }), [["entries.0.covers.0", "roofing.plumbing is not in the work item dictionary."]]);
  assert.deepEqual(paths({ equipment: [{ name: "Truck", provides: [{ item: "roofing.install" }] }] }), [["equipment.0.provides.0.item", "Truck can only provide a function, and roofing.install is work."]]);
  assert.deepEqual(paths({ duration: { input: "area", units_per_day: 10 } }), [["duration.input", "Duration reads area, which is not a declared input."]]);
  assert.deepEqual(paths({ inputs: [...pieceRate.inputs, pieceRate.inputs[0]] }).map(([path]: string[]) => path), ["inputs.5.name"]);
});

test("the editor's reads: the words of each kind of work, who lacks a sheet, and an unsaved sheet tried on a project", async () => {
  const s = await import("../platform/storage.js");
  const sheets = await import("../labor/pay-sheets.js");
  const editor = await import("../labor/pay-sheet-editor.js");
  const d = await import("../platform/publication/datasets.js");
  const { systemPublicationContext, userPublicationContext } = await import("../platform/publication/context.js");
  const ORG = "org_pay_editor";
  await s.createOrganization({ id: ORG, name: "Editor" }); await s.saveGlobal(ORG, { data: { app_flags: { platform: { expanded_access: true, materials: true } } } }, { replace: false }); await enableExpandedPlatformFixture(ORG, { "platform.materials": true, "platform.pricebook": true });
  const owner = { orgId: ORG, userId: "owner", role: "owner", permissions: {} } as any;

  // Each kind of work, with which measurements are a part of which whole and what each work item is sized by.
  const { kinds, partitions } = editor.paySheetKindsOfWork();
  const roofing = kinds.find((kind) => kind.id === "roofing")!;
  const steep = roofing.measurements.find((entry) => entry.definition === "roof.squares_9_to_12")!;
  assert.deepEqual([steep.label, steep.key, steep.part_of?.base, steep.part_of?.complete], ["Squares over 8/12 up to 12/12", "pitch9to12Squares", "roof.squares", true]);
  assert.equal(roofing.measurements.find((entry) => entry.definition === "roof.squares")!.part_of, undefined, "a whole measurement is not a part of anything");
  assert.equal(roofing.measurements.find((entry) => entry.definition === "roof.squares_at_pitch")!.key, "", "a family of keys cannot be typed as one number");
  const tearOff = roofing.work.find((entry) => entry.item === "roofing.tear_off")!;
  assert.deepEqual([tearOff.measure, tearOff.kind, tearOff.sized_by.map((entry) => entry.label)], ["roof.squares", "work", ["Roof squares"]]);
  assert.deepEqual([roofing.work.find((entry) => entry.item === "disposal.debris")!.under, roofing.work.find((entry) => entry.item === "disposal.debris")!.per_load_default], ["roofing.tear_off", true]);
  assert.ok(partitions.find((entry) => entry.id === "roof.pitch_bands")!.parts.includes("roof.squares_9_to_12"));
  assert.deepEqual(kinds.find((kind) => kind.id === "gutters")!.work, [], "a kind of work with no work schema names no work");

  // Who lacks a sheet: an assignee marked as able to do roofing with no roofing sheet, and one with nothing said about it.
  const connections = await import("../connections/storage.js"), workforce = await import("../workforce/storage.js"), caps = await import("../labor/capabilities.js");
  const summit = await connections.createOrganizationConnection(ORG, { name: "Summit", relationship_type_ids: ["work_provider"] });
  const crew = await workforce.createResourceGroup(ORG, { name: "Crew D", kind_id: "crew" });
  const quiet = await workforce.createResourceGroup(ORG, { name: "Crew E", kind_id: "crew" });
  const subject = { type: "organization_connection" as const, id: String(summit.id) };
  const saved = await sheets.savePaySheet(ORG, { ...pieceRate, subject }, owner);
  await caps.saveCapabilities(ORG, { assignee: { type: "resource_group", id: String(crew.id) }, schema_ids: ["roofing"] }, owner);
  const overview = await editor.paySheetOverview(ORG);
  const row = (id: string) => overview.assignees.find((entry) => entry.assignee.id === id)!;
  assert.deepEqual(overview.sheets.map((sheet) => sheet.id), [saved.id]);
  assert.deepEqual([row(String(crew.id)).capable_schema_ids, row(String(crew.id)).sheet_ids, row(String(crew.id)).known], [["roofing"], [], true]);
  assert.deepEqual([row(String(quiet.id)).known, row(String(quiet.id)).capable_schema_ids], [false, []], "nothing said is not the same as unable, and is never reported as missing");
  assert.deepEqual(row(String(summit.id)).sheet_ids, [saved.id]);

  // An unsaved sheet tried on a project: priced as a saved one would be, with what each input read and the project's work.
  await s.upsertDocument(ORG, "projects", { id: "oak", data: { title: "12 Oak St" } });
  await assert.rejects(() => editor.tryPaySheet(ORG, "nowhere", { sheet: { ...pieceRate, subject } }), /project is unavailable/);
  await assert.rejects(() => editor.tryPaySheet(ORG, "oak", { sheet: { ...pieceRate, subject, schema_ids: ["siding"] } }), (error: any) => error.issues?.[0]?.path?.join(".") === "inputs.0.source.definition", "a sheet that would not save is refused with the field named");
  const draft = { ...pieceRate, subject, entries: [...pieceRate.entries.slice(0, 2)], equipment: [{ name: "Dump trailer", included: true, provides: [{ item: "disposal.debris", capacity: 14, per_load: true }] }] };
  const bare = await editor.tryPaySheet(ORG, "oak", { sheet: draft });
  assert.equal(bare.measurement_source, "none"); assert.equal(bare.evaluation.complete, false);
  assert.deepEqual(bare.evaluation.unresolved.map((entry) => entry.label), ["Tear off"], "nothing measured leaves the line unresolved");
  assert.equal(bare.evaluation.lines.some((line) => line.label === "Tear off"), false, "and never priced at zero");
  assert.deepEqual(bare.inputs.find((input) => input.name === "squares")!.from, "missing");
  assert.deepEqual(bare.required_work, [], "a project whose scope names no work requires none");
  // Numbers typed for the trial: a measurement by its dataset key, a number for the job by its input.
  const typed = await editor.tryPaySheet(ORG, "oak", { sheet: draft, manual: { layers: 1 }, legacy_measurements: { roofSquares: { value: 30, unit: "roofing_square" }, pitch9to12Squares: { value: 4, unit: "roofing_square" } } });
  assert.equal(typed.measurement_source, "project");
  assert.deepEqual(typed.evaluation.lines.map((line) => [line.label, line.total_cents]), [["Tear off", 120000], ["Steep charge", 6000]]);
  assert.deepEqual(typed.inputs.filter((input) => ["squares", "layers", "pack_out_feet"].includes(input.name)).map((input) => [input.name, input.value, input.from]), [["squares", 30, "job"], ["pack_out_feet", 0, "default"], ["layers", 1, "typed"]]);
  // With work in the project's scope, each requirement says how this sheet stands to it.
  const { saveManualScope } = await import("../labor/scope-artifacts.js");
  const ctx = userPublicationContext({ ...owner, permissions: { "*": true }, capabilities: { effectiveByKey: { "platform.materials": true } }, applicationAccess: { management: { enabled: true, permissions: { "*": true } } } }, { projectId: "oak" });
  await saveManualScope(ctx, "oak", { work: ["roofing.tear_off", "disposal.debris", "roofing.install", "roofing.cleanup"].map((item) => ({ item })) });
  const writer = systemPublicationContext({ kind: "module", organizationId: ORG, projectId: "oak", operations: ["datasets.save", "datasets.select", "datasets.value"], mode: "command" });
  const target = { scope: "project" as const, organizationId: ORG, projectId: "oak" };
  const dataset = await d.importMeasurementDataset(writer, target, { name: "Manual", value: { measurements: { roofSquares: { value: 20, unit: "roofing_square", source: "manual" } } } });
  await d.selectProjectDataset(writer, target, "measurements", dataset.id, Number((await s.readDocument(ORG, "projects", "oak")).revision));
  const covered = await editor.tryPaySheet(ORG, "oak", { sheet: { ...draft, entries: [{ label: "Tear off", kind: "piece_rate", unit: "sq", rate_cents: 4000, input: "squares", covers: ["roofing.tear_off"] }, { label: "Steep charge", kind: "piece_rate", unit: "sq", rate_cents: 1500, input: "steep", covers: ["roofing.tear_off"] }], work: [{ item: "roofing.cleanup", included: true }] }, legacy_measurements: { roofSquares: { value: 99, unit: "roofing_square" } } });
  assert.equal(covered.measurement_source, "dataset", "a selected dataset wins over numbers typed for the trial");
  assert.deepEqual(Object.fromEntries(covered.required_work.map((entry) => [entry.item, entry.state])), { "roofing.tear_off": "paid", "disposal.debris": "provided", "roofing.install": "open", "roofing.cleanup": "included" });
  assert.equal(covered.required_work.find((entry) => entry.item === "disposal.debris")!.quantity, 8, "20 squares of one layer is 8 cubic yards of debris");
  assert.equal(covered.evaluation.lines.find((line) => line.label === "Tear off")!.total_cents, 80000);
  assert.deepEqual(covered.evaluation.lines.find((line) => line.label === "Tear off")!.covers, ["roofing.tear_off"]);
  // Trying never saves.
  assert.deepEqual((await sheets.listPaySheets(ORG)).map((sheet) => [sheet.id, sheet.revision]), [[saved.id, saved.revision]]);
});

test("pay sheets are stored per organization, published with their requirements and priced against a project", async () => {
  const s = await import("../platform/storage.js");
  const sheets = await import("../labor/pay-sheets.js");
  const { evaluateProjectPaySheets } = await import("../labor/pay-sheet-publication.js");
  const { systemPublicationContext } = await import("../platform/publication/context.js");
  const d = await import("../platform/publication/datasets.js");
  try {
    await s.createOrganization({ id: "org_pay", name: "Pay" }); await s.saveGlobal("org_pay", { data: { app_flags: { platform: { expanded_access: true, materials: true } } } }, { replace: false }); await enableExpandedPlatformFixture("org_pay", { "platform.materials": true, "platform.pricebook": true });
    await s.upsertDocument("org_pay", "projects", { id: "project_pay", data: { title: "Oak St" } });
    const owner = { orgId: "org_pay", userId: "owner", role: "owner", permissions: {} } as any;
    await assert.rejects(() => sheets.savePaySheet("org_pay", pieceRate, owner), /not available in this organization/, "a pay sheet needs a real assignee");
    const summit = await (await import("../connections/storage.js")).createOrganizationConnection("org_pay", { name: "Summit Roofing", relationship_type_ids: ["work_provider"] });
    const real = { ...pieceRate, subject: { type: "organization_connection" as const, id: String(summit.id) } };
    await assert.rejects(() => sheets.savePaySheet("org_pay", real, { orgId: "org_pay", userId: "crew", role: "member", permissions: {}, accessProfile: { roles: [] } } as any), /company settings access/);
    const saved = await sheets.savePaySheet("org_pay", real, owner);
    // One sheet per kind of work for an assignee, and at most one that names none.
    await assert.rejects(() => sheets.savePaySheet("org_pay", { ...real, name: "Second roofing sheet" }, owner), /already covers that kind of work/);
    const hourlyOnly = { subject: real.subject, name: "Summit hourly", inputs: [{ name: "hours", source: { kind: "manual" as const } }], entries: [{ label: "Hourly", kind: "hourly" as const, rate_cents: 5000, input: "hours" }] };
    const unscoped = await sheets.savePaySheet("org_pay", hourlyOnly, owner);
    await assert.rejects(() => sheets.savePaySheet("org_pay", { ...hourlyOnly, name: "Another hourly" }, owner), /already covers work that names no kind/);
    await sheets.archivePaySheet("org_pay", { id: unscoped.id }, owner);
    assert.equal(saved.entries[0]!.id, "entry_1"); assert.equal(saved.revision >= 1, true);
    const renamed = await sheets.savePaySheet("org_pay", { ...real, id: saved.id, name: "Summit 2026 rates", expected_revision: saved.revision }, owner);
    assert.equal(renamed.name, "Summit 2026 rates"); await assert.rejects(() => sheets.savePaySheet("org_pay", { ...real, id: saved.id, expected_revision: saved.revision }, owner), /revision/i, "a stale revision is refused");
    assert.deepEqual((await sheets.listPaySheets("org_pay")).map((row) => row.id), [saved.id]);

    const writer = systemPublicationContext({ kind: "module", organizationId: "org_pay", projectId: "project_pay", operations: ["datasets.save", "datasets.select", "datasets.value"], mode: "command" });
    const target = { scope: "project" as const, organizationId: "org_pay", projectId: "project_pay" };
    const before = await evaluateProjectPaySheets("org_pay", "project_pay", { manual: { layers: 0 } });
    assert.deepEqual(before[0]!.unresolved.map((row) => row.label), ["Tear off"], "a project with no measurements leaves the measured lines unresolved");
    const dataset = await d.importMeasurementDataset(writer, target, { name: "Manual", value: { measurements: { roofSquares: { value: 20, unit: "roofing_square", source: "manual" } } } });
    await d.selectProjectDataset(writer, target, "measurements", dataset.id, Number((await s.readDocument("org_pay", "projects", "project_pay")).revision));
    const after = await evaluateProjectPaySheets("org_pay", "project_pay", { sheet_id: saved.id, manual: { layers: 0 }, fields: { pack_out_feet: 0 } });
    assert.equal(after.length, 1); assert.equal(after[0]!.lines.find((row) => row.label === "Tear off")!.total_cents, 80000); assert.equal(after[0]!.duration_days, 1); assert.equal(after[0]!.complete, true);
    assert.equal(after[0]!.lines.some((row) => row.label === "Pack out"), false, "a gated entry is left out when its input is zero");

    // Project fields are read on the server: a pay sheet that prices pack-out finds the project's own value.
    const { projectFieldNumbers } = await import("../labor/pay-sheet-publication.js");
    await s.saveBranchModule("org_pay", "default", "custom_fields", { data: { fields: [{ key: "pack_out_feet", path: "pack_out_feet", label: "Pack-out distance", type: "number", entity: "project" }, { key: "steep_access", path: "access.steep", label: "Steep access", type: "boolean", entity: "project" }, { key: "notes", path: "notes", label: "Notes", type: "text", entity: "project" }] } });
    const current = await s.readDocument("org_pay", "projects", "project_pay");
    await s.upsertDocument("org_pay", "projects", { id: "project_pay", expected_revision: Number(current.revision), data: { ...current.data, custom_field_values: { pack_out_feet: 80, access: { steep: true }, notes: "Gate code 4411" } } });
    await s.upsertDocument("org_pay", "projects", { id: "project_pay", expected_revision: Number((await s.readDocument("org_pay", "projects", "project_pay")).revision), data: { ...(await s.readDocument("org_pay", "projects", "project_pay")).data, custom_field_values: { pack_out_feet: 80, access: { steep: true }, notes: "4411" } } });
    const { numbers: fields, error } = await projectFieldNumbers("org_pay", "project_pay");
    assert.equal(error, ""); assert.equal(fields.pack_out_feet, 80); assert.equal(fields["access.steep"], 1, "a yes/no field counts as 1"); assert.equal(fields.custom_access_steep, 1, "also under the name the Project tab's formulas use"); assert.equal("notes" in fields, false, "text that looks like a number is still text");
    const packed = await evaluateProjectPaySheets("org_pay", "project_pay", { sheet_id: saved.id, manual: { layers: 0 } });
    assert.equal(packed[0]!.lines.find((row) => row.label === "Pack out")!.total_cents, 8000, "80 ft at $1 a foot, read from the project");
    assert.equal((await evaluateProjectPaySheets("org_pay", "project_pay", { sheet_id: saved.id, manual: { layers: 0 }, fields: { pack_out_feet: 0 } }))[0]!.lines.some((row) => row.label === "Pack out"), false, "a value passed by the caller still wins");

    // Material comes from the project's live lists only: an archived list beside its replacement is not paid twice.
    const lists = await import("../materials/storage.js");
    const ridge = (quantity: number) => lists.createMaterialList("org_pay", "project_pay", { title: "Ridge", resource_type: "material", items: [{ id: "r1", name: "Ridge cap", quantity, unit: "bundle", pricebook_ref: { item_id: "ridge_item" } }] }, owner);
    const pricebook = await import("../pricebook/storage.js");
    const book = await pricebook.getOrganizationPricebook("org_pay");
    await pricebook.saveOrganizationCatalog("org_pay", { ...book.catalog, items: [...book.catalog.items, { id: "ridge_item", kind: "atomic", name: "Ridge cap", type: "Hip & Ridge", category: "shingle_roofs", unit: "bundle", unit_price: 60 }] }, Number(book.manifest.revision));
    const oldList = await ridge(5); await ridge(6);
    const ridgeTotal = async () => (await evaluateProjectPaySheets("org_pay", "project_pay", { sheet_id: saved.id, manual: { layers: 0 } }))[0]!.lines.find((row) => row.label === "Ridge cap")!.quantity;
    assert.equal(await ridgeTotal(), 11); await lists.archiveMaterialList("org_pay", String(oldList.id), { reason: "Replaced" }, owner); assert.equal(await ridgeTotal(), 6, "the archived list no longer counts");

    // Documents, scope code and the assistant read the same published views a person does.
    (await import("../platform/publication/bootstrap.js")).initializePublication();
    const { readPublishedData } = await import("../platform/publication/providers.js");
    const reader = systemPublicationContext({ kind: "agent", organizationId: "org_pay", projectId: "project_pay", operations: ["pay-sheets.requirements", "pay-sheets.evaluation", "pay-sheets.catalog"] });
    const published = await readPublishedData(reader, { provider: "pay-sheets", export: "requirements", target: { scope: "organization", organizationId: "org_pay" } }) as any;
    assert.equal(published.status, "ready"); assert.deepEqual(published.value.map((row: any) => [row.consumer.id, row.schema_ids]), [[saved.id, ["roofing"]]]);
    const evaluated = await readPublishedData(reader, { provider: "pay-sheets", export: "evaluation", target: { scope: "project", organizationId: "org_pay", projectId: "project_pay" }, args: { manual: { layers: 0 } } }) as any;
    assert.equal(evaluated.status, "ready"); assert.equal(evaluated.value[0].complete, true);
    // An agent checks a sheet it proposes before anyone saves it: priced on the project, refused with paths when it would not save, never stored.
    const { publishedDataPermission } = await import("../platform/publication/permission-bundles.js");
    assert.equal(publishedDataPermission("pay-sheets.try"), "manage_projects");
    const trier = systemPublicationContext({ kind: "agent", organizationId: "org_pay", projectId: "project_pay", operations: ["pay-sheets.try"] });
    const proposal = { ...real, name: "Summit proposal", entries: [{ label: "Tear off", kind: "piece_rate", unit: "sq", rate_cents: 5000, input: "squares", covers: ["roofing.tear_off"] }] };
    const tried = await readPublishedData(trier, { provider: "pay-sheets", export: "try", target: { scope: "project", organizationId: "org_pay", projectId: "project_pay" }, args: { sheet: proposal } }) as any;
    assert.equal(tried.status, "ready"); assert.equal(tried.value.measurement_source, "dataset");
    assert.deepEqual(tried.value.evaluation.lines.map((line: any) => [line.label, line.total_cents]), [["Tear off", 100000]], "20 squares at $50");
    assert.deepEqual(tried.value.inputs.find((input: any) => input.name === "squares").from, "job");
    const refused = await readPublishedData(trier, { provider: "pay-sheets", export: "try", target: { scope: "project", organizationId: "org_pay", projectId: "project_pay" }, args: { sheet: { ...proposal, schema_ids: ["siding"] } } }) as any;
    assert.deepEqual([refused.status, refused.code], ["error", "pay_sheet_invalid"]);
    assert.match(refused.message, /^This sheet would not save: inputs\.0\.source\.definition: roof\.squares is not part of siding\./, "a sheet that would not save is refused, naming the field");
    assert.deepEqual((await sheets.listPaySheets("org_pay")).map((sheet) => sheet.name), ["Summit 2026 rates"], "trying never saves");
    // The item type a material input matches on is published with the organization's products, for choosing one.
    const products = await readPublishedData((await import("../platform/publication/context.js")).userPublicationContext({ ...owner, permissions: { "*": true }, capabilities: { effectiveByKey: { "platform.pricebook": true, "platform.materials": true } }, applicationAccess: { management: { enabled: true, permissions: { "*": true } } } } as any), { provider: "materials-inputs", export: "products", target: { scope: "organization", organizationId: "org_pay" } }) as any;
    assert.equal(products.status, "ready", JSON.stringify(products));
    assert.equal(products.value.find((item: any) => item.id === "ridge_item").type, "Hip & Ridge");

    await sheets.archivePaySheet("org_pay", { id: saved.id }, owner);
    assert.deepEqual(await sheets.listPaySheets("org_pay"), []);
  } finally { await closePlatformFixtureStores(); await rm(dir, { recursive: true, force: true }).catch(() => {}); }
});
