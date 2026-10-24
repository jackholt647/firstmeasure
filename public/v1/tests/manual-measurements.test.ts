import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test, { after } from "node:test";
import { closePlatformFixtureStores, enableExpandedPlatformFixture } from "./helpers/platform-fixture.js";

const dir = await mkdtemp(path.join(os.tmpdir(), "manual-measurements-"));
Object.assign(process.env, { NODE_ENV: "test", PLATFORM_STORAGE_ROOT: path.join(dir, "platform"), PRICEBOOK_STORAGE_ROOT: path.join(dir, "pricebook"), FIRSTMEASURE_STORAGE_ROOT: path.join(dir, "firstmeasure"), FIRSTMEASURE_INDEX_DB_PATH: path.join(dir, "index.sqlite"), PLATFORM_HEARTBEAT_DISABLED: "1" });
after(async () => { await closePlatformFixtureStores(); await rm(dir, { recursive: true, force: true }).catch(() => {}); });

const ORG = "org_manual_measurements";
const owner = { orgId: ORG, userId: "owner", role: "owner", permissions: {}, branchId: "default" } as any;
const operations = ["measurements.manual.save", "measurement-schemas.manual", "datasets.save", "datasets.select", "datasets.value"];

test("the editor offers the dictionary measurements the project's scope schemas name, and nothing else", async () => {
  const m = await import("../platform/publication/manual-measurements.js");
  const roofing = m.manualMeasurementFields(["roofing"]);
  const keys = roofing.map((field) => field.key);
  assert.ok(keys.includes("roofSquares") && keys.includes("roofArea") && keys.includes("eavesLf") && keys.includes("pitch9to12Squares"));
  assert.ok(!keys.some((key) => /^pitch\d+(?:\.\d+)?Squares$/.test(key)), "a family of exact-pitch keys has no single key to type into");
  assert.equal(new Set(keys).size, keys.length);
  const squares = roofing.find((field) => field.key === "roofSquares")!;
  assert.deepEqual([squares.unit, squares.required, squares.group], ["roofing_square", true, "area"]);
  assert.equal(roofing.find((field) => field.key === "pitch9to12Squares")!.group, "part:roof.pitch_bands");
  assert.equal(roofing.find((field) => field.key === "eavesLf")!.group, "length");
  // Two schemas share a measurement by naming the same definition: it is listed once, required if either requires it.
  const both = m.manualMeasurementFields(["roofing", "gutters"]);
  const eaves = both.filter((field) => field.key === "eavesLf");
  assert.equal(eaves.length, 1); assert.equal(eaves[0]!.required, true); assert.deepEqual(eaves[0]!.schemas, ["roofing", "gutters"]);
  assert.deepEqual(m.manualMeasurementFields([]), []);
});

test("entries made by hand are the project's measurements until a completed report replaces them, and stay listed until cleared", async () => {
  const s = await import("../platform/storage.js"), fm = await import("../firstmeasure/storage.js"), lists = await import("../materials/storage.js");
  const { systemPublicationContext } = await import("../platform/publication/context.js");
  const { ensureDefaultScopeTemplates } = await import("../scopes/storage.js");
  const m = await import("../platform/publication/manual-measurements.js");
  const { effectiveProjectMeasurements } = await import("../platform/publication/firstmeasure-datasets.js");
  const { measurementAmounts, assessMeasurements } = await import("../platform/publication/measurement-schemas.js");
  const { listProjectChanges } = await import("../history/storage.js");
  await s.createOrganization({ id: ORG, name: "Manual measurements" });
  await s.saveGlobal(ORG, { data: { app_flags: { platform: { expanded_access: true, materials: true } } } }, { replace: false });
  await enableExpandedPlatformFixture(ORG, { "platform.materials": true, "platform.pricebook": true });
  await ensureDefaultScopeTemplates(ORG);
  await s.upsertDocument(ORG, "projects", { id: "roof", data: { title: "12 Oak St", measurement_project: { id: "report_manual" } } });
  await s.upsertDocument(ORG, "projects", { id: "hourly", data: { title: "Hourly job" } });
  await lists.createMaterialList(ORG, "roof", { title: "Roof materials", resource_type: "material", scope_template_id: "roof_replacement", items: [] }, owner);
  const ctx = (projectId: string) => systemPublicationContext({ kind: "module", organizationId: ORG, projectId, operations, mode: "command" });

  // A project whose scopes name no schema keeps today's empty state: nothing to enter, and the writer refuses.
  const hourly = await m.readManualMeasurements(ctx("hourly"), "hourly");
  assert.equal(hourly.available, false); assert.deepEqual(hourly.fields, []); assert.equal(hourly.in_use.source, "none");
  await assert.rejects(m.saveManualMeasurements(ctx("hourly"), "hourly", { values: { roofSquares: 20 } }), /no measurement schema/);

  const empty = await m.readManualMeasurements(ctx("roof"), "roof");
  assert.equal(empty.available, true); assert.deepEqual(empty.schemas.map((schema) => schema.id), ["roofing"]);
  assert.equal(empty.manual, null); assert.equal(empty.in_use.source, "none"); assert.equal(empty.report_linked, true);
  assert.equal((await effectiveProjectMeasurements(ctx("roof"), "roof")).status, "missing");

  // Only dictionary keys the schemas ask for, in their unit, zero or more.
  await assert.rejects(m.saveManualMeasurements(ctx("roof"), "roof", { values: { wallNetArea: 400 } }), /not a measurement this project's scopes ask for/);
  await assert.rejects(m.saveManualMeasurements(ctx("roof"), "roof", { values: { pitch7Squares: 4 } }), /not a measurement/);
  await assert.rejects(m.saveManualMeasurements(ctx("roof"), "roof", { values: { roofSquares: -1 } }), /zero or more/);

  const first = await m.saveManualMeasurements(ctx("roof"), "roof", { values: { roofSquares: 32, eavesLf: 180, ridgesLf: 40 } });
  assert.equal(first.inUse, "manual"); assert.deepEqual(first.changed, ["eavesLf", "ridgesLf", "roofSquares"]);
  // Everything downstream reads the selected dataset; with no report it is these entries, in dictionary keys and units.
  const effective = await effectiveProjectMeasurements(ctx("roof"), "roof");
  assert.equal(effective.status, "ready"); assert.equal(effective.datasetId, m.manualMeasurementDatasetId(ORG, "roof"));
  assert.deepEqual((effective.value as any).measurements.roofSquares, { value: 32, unit: "roofing_square", source: "manual" });
  assert.equal(measurementAmounts(effective.value, "roof.squares").total, 32);
  assert.ok(!assessMeasurements("roofing", effective.value).missing_required.includes("roof.squares"));
  assert.equal((effective.provenance as any).producer, "manual");

  // An edit by someone who read an older revision is refused instead of overwriting theirs.
  const stale = (await m.readManualMeasurements(ctx("roof"), "roof")).manual!.store_revision;
  await m.saveManualMeasurements(ctx("roof"), "roof", { values: { ridgesLf: 41 } });
  await assert.rejects(m.saveManualMeasurements(ctx("roof"), "roof", { values: { eavesLf: 175 }, expectedRevision: stale }), /changed by someone else/);
  const read = await m.readManualMeasurements(ctx("roof"), "roof");
  const second = await m.saveManualMeasurements(ctx("roof"), "roof", { values: { eavesLf: 175, ridgesLf: null }, expectedRevision: read.manual!.store_revision });
  assert.deepEqual(second.values, { eavesLf: 175, roofSquares: 32 }); assert.deepEqual(second.changed, ["eavesLf", "ridgesLf"]);

  // The writer records the change in project history; an unchanged save records nothing.
  await m.saveManualMeasurements(ctx("roof"), "roof", { values: { eavesLf: 175 } });
  const history = await listProjectChanges(ORG, { project_id: "roof", domain: "measurements" });
  assert.equal(history.length, 3);
  assert.deepEqual((history[2]!.before as any).values, { eavesLf: 180, ridgesLf: 41, roofSquares: 32 });
  assert.deepEqual((history[2]!.after as any).values, { eavesLf: 175, roofSquares: 32 });

  // The report arrives: its numbers are used, never mixed with the entries made by hand.
  await fm.createProject({ id: "report_manual", address: "12 Oak St", organization_ref: { id: ORG } });
  await fm.saveStoredXml("report_manual", `<FACE id="roof"><POLYGON size="2400" pitch="6"/></FACE>`);
  await fm.updateStatus("report_manual", "completed");
  const reported = await effectiveProjectMeasurements(ctx("roof"), "roof");
  assert.notEqual(reported.datasetId, m.manualMeasurementDatasetId(ORG, "roof"));
  assert.equal((reported.value as any).measurements.roofSquares.value, 24);
  assert.equal((reported.value as any).measurements.eavesLf, undefined, "a value only entered by hand is not carried into the report's numbers");
  const replaced = (await listProjectChanges(ORG, { project_id: "roof", domain: "measurements" })).at(-1)!;
  assert.equal(replaced.op, "selected"); assert.equal((replaced.after as any).dataset_id, reported.datasetId);

  // The entries are kept and shown beside the report's numbers until cleared.
  const compare = await m.readManualMeasurements(ctx("roof"), "roof");
  assert.equal(compare.in_use.source, "report"); assert.equal(compare.in_use.values.roofSquares, 24);
  assert.deepEqual(compare.manual!.values, { eavesLf: 175, roofSquares: 32 });

  // Editing or clearing them never takes the report's place.
  const edited = await m.saveManualMeasurements(ctx("roof"), "roof", { values: { roofSquares: 30 } });
  assert.equal(edited.inUse, "other"); assert.equal((await effectiveProjectMeasurements(ctx("roof"), "roof")).datasetId, reported.datasetId);
  const cleared = await m.saveManualMeasurements(ctx("roof"), "roof", { values: { roofSquares: null, eavesLf: null } });
  assert.deepEqual(cleared.values, {}); assert.equal((await effectiveProjectMeasurements(ctx("roof"), "roof")).datasetId, reported.datasetId);
  assert.equal((await m.readManualMeasurements(ctx("roof"), "roof")).in_use.source, "report");
});

test("clearing every entry before a report unselects them, so the project reads no measurements rather than empty ones", async () => {
  const s = await import("../platform/storage.js"), lists = await import("../materials/storage.js");
  const { systemPublicationContext } = await import("../platform/publication/context.js");
  const m = await import("../platform/publication/manual-measurements.js");
  const { effectiveProjectMeasurements } = await import("../platform/publication/firstmeasure-datasets.js");
  await s.upsertDocument(ORG, "projects", { id: "gutters", data: { title: "Gutters only" } });
  await lists.createMaterialList(ORG, "gutters", { title: "Gutters", resource_type: "material", scope_template_id: "gutters", items: [] }, owner);
  const ctx = systemPublicationContext({ kind: "module", organizationId: ORG, projectId: "gutters", operations, mode: "command" });
  const form = await m.readManualMeasurements(ctx, "gutters");
  assert.deepEqual(form.fields.map((field) => field.key), ["eavesLf", "rakesLf"]);
  await m.saveManualMeasurements(ctx, "gutters", { values: { eavesLf: 120 } });
  assert.equal((await effectiveProjectMeasurements(ctx, "gutters")).status, "ready");
  const cleared = await m.saveManualMeasurements(ctx, "gutters", { values: { eavesLf: null } });
  assert.equal(cleared.inUse, "none");
  assert.equal((await effectiveProjectMeasurements(ctx, "gutters")).status, "missing");
  // Another dataset someone selected is never displaced by entries made by hand.
  const d = await import("../platform/publication/datasets.js");
  const target = { scope: "project" as const, organizationId: ORG, projectId: "gutters" };
  const other = await d.importMeasurementDataset(ctx, target, { name: "Survey", value: { measurements: { eavesLf: { value: 130, unit: "ft", source: "survey" } } } });
  await d.selectProjectDataset(ctx, target, "measurements", other.id, Number((await s.readDocument(ORG, "projects", "gutters")).revision));
  assert.equal((await m.saveManualMeasurements(ctx, "gutters", { values: { eavesLf: 125 } })).inUse, "other");
  assert.equal((await effectiveProjectMeasurements(ctx, "gutters")).datasetId, other.id);
  assert.equal((await m.readManualMeasurements(ctx, "gutters")).in_use.source, "other");
});

test("the manual entry read and writer are published with the project data permissions", async () => {
  const { registerDatasetActions } = await import("../platform/publication/dataset-actions.js");
  const { registerDatasetProvider } = await import("../platform/publication/datasets.js");
  const { listActions } = await import("../platform/publication/actions.js");
  const { listDataProviders } = await import("../platform/publication/providers.js");
  registerDatasetActions(); registerDatasetProvider();
  const action = listActions().find((entry: any) => entry.id === "measurements.manual.save") as any;
  assert.ok(action); assert.deepEqual(action.policy?.permissions || action.access?.permissions, ["manage_project_data"]);
  const provider = listDataProviders().find((entry: any) => entry.id === "measurement-schemas") as any;
  assert.ok(provider?.exports?.manual || provider?.exports?.find?.((entry: any) => entry.id === "manual"));
});
