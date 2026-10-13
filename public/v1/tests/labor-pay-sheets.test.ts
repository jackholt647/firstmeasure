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
  const materials = [{ item_id: "lib-ridge-gaf-seal-a-ridge", item_type: "Hip & Ridge", quantity: 5 }, { item_id: "lib-shingle-gaf-hdz", item_type: "Shingles", quantity: 96 }];
  const priced = evaluatePaySheet(sheet, { measurements, materials, fields: { pack_out_feet: 30 }, manual: { layers: 1 } });
  const line = (label: string) => priced.lines.filter((row) => row.label === label);
  assert.deepEqual(line("Tear off").map((row) => [row.structure_name, row.quantity, row.total_cents]), [["House", 26, 104000], ["Garage", 6, 24000]], "a per-structure input prices each structure");
  assert.equal(line("Steep charge")[0]!.total_cents, 9000); assert.equal(line("Ridge cap")[0]!.total_cents, 4000, "material quantities come from the lists by item type");
  assert.equal(line("Pack out")[0]!.total_cents, 5000, "30 ft at $1 is below the $50 minimum"); assert.equal(line("Extra layers")[0]!.total_cents, 20000); assert.equal(line("Dump fee")[0]!.total_cents, 35000);
  assert.deepEqual(priced.equipment.map((row) => [row.name, row.included, row.total_cents]), [["Dump trailer", true, 0], ["Shingle lift", false, 12000]]);
  assert.equal(priced.total_cents, 104000 + 24000 + 9000 + 4000 + 5000 + 20000 + 35000 + 12000); assert.equal(priced.duration_days, 1.5, "32 squares at 25 a day rounds up to the next half day"); assert.equal(priced.complete, true);

  const bare = evaluatePaySheet(sheet, { measurements: {}, materials: [] });
  assert.deepEqual(bare.unresolved.map((row) => row.label), ["Tear off", "Extra layers"], "required inputs that are missing leave their lines unresolved, not zero");
  assert.deepEqual(bare.lines.map((row) => row.label), ["Dump fee"], "optional inputs with nothing recorded simply do not apply");
  assert.deepEqual(bare.missing_inputs.filter((row) => row.required).map((row) => row.name), ["squares", "layers"]); assert.equal(bare.duration_days, null); assert.equal(bare.complete, false);
  assert.equal(evaluatePaySheet(sheet, { measurements: { measurements: { roofSquares: { value: 3200, unit: "ft2" } } }, manual: { layers: 0 } }).unresolved[0]!.label, "Tear off", "a value in another unit is not the measurement");

  const hourly = { ...paySheetInputSchema.parse({ subject: { type: "resource_group", id: "crew_a" }, name: "Crew A hourly", inputs: [{ name: "hours", source: { kind: "manual" } }], entries: [{ label: "Hourly", kind: "hourly", rate_cents: 3200, input: "hours" }, { label: "Foreman salary", kind: "salary", rate_cents: 150000 }] }), id: "ps_2", revision: 1 };
  const unknown = evaluatePaySheet(hourly, { measurements, materials });
  assert.deepEqual(unknown.unresolved.map((row) => row.label), ["Hourly"], "an hourly crew is unknown until hours are entered"); assert.equal(unknown.total_cents, 0);
  const entered = evaluatePaySheet(hourly, { manual: { hours: 40 } });
  assert.equal(entered.lines.find((row) => row.kind === "hourly")!.total_cents, 128000); assert.equal(entered.lines.find((row) => row.kind === "salary")!.total_cents, null, "salary is recorded but not charged to the job"); assert.equal(entered.total_cents, 128000);
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
    await assert.rejects(() => sheets.savePaySheet("org_pay", pieceRate, { orgId: "org_pay", userId: "crew", role: "member", permissions: {}, accessProfile: { roles: [] } } as any), /company settings access/);
    const saved = await sheets.savePaySheet("org_pay", pieceRate, owner);
    assert.equal(saved.entries[0]!.id, "entry_1"); assert.equal(saved.revision >= 1, true);
    const renamed = await sheets.savePaySheet("org_pay", { ...pieceRate, id: saved.id, name: "Summit 2026 rates", expected_revision: saved.revision }, owner);
    assert.equal(renamed.name, "Summit 2026 rates"); await assert.rejects(() => sheets.savePaySheet("org_pay", { ...pieceRate, id: saved.id, expected_revision: saved.revision }, owner), "a stale revision is refused");
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

    await sheets.archivePaySheet("org_pay", { id: saved.id }, owner);
    assert.deepEqual(await sheets.listPaySheets("org_pay"), []);
  } finally { await closePlatformFixtureStores(); await rm(dir, { recursive: true, force: true }).catch(() => {}); }
});
