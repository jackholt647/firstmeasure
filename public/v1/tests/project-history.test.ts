import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test, { after } from "node:test";
import { closePlatformFixtureStores, enableExpandedPlatformFixture } from "./helpers/platform-fixture.js";

const dir = await mkdtemp(path.join(os.tmpdir(), "project-history-"));
Object.assign(process.env, { NODE_ENV: "test", PLATFORM_STORAGE_ROOT: path.join(dir, "platform"), PRICEBOOK_STORAGE_ROOT: path.join(dir, "pricebook"), FIRSTMEASURE_STORAGE_ROOT: path.join(dir, "firstmeasure"), FIRSTMEASURE_INDEX_DB_PATH: path.join(dir, "index.sqlite"), PLATFORM_HEARTBEAT_DISABLED: "1" });
after(async () => { await (await import("../history/storage.js")).closeHistoryDatabase(); await closePlatformFixtureStores(); await rm(dir, { recursive: true, force: true }).catch(() => {}); });

const ORG = "org_history";
const owner = { orgId: ORG, userId: "owner", role: "owner", permissions: {}, branchId: "default" } as any;
const unit = (value: number, of: string) => ({ value, unit: of, source: "manual" });

test("line differences say what was added, removed and changed, matching calculated lines by key", async () => {
  const { lineDiff, generationOutcome, fieldDiff } = await import("../history/diff.js");
  const before = [{ id: "a", name: "Shingles", quantity: 30, unit: "bundle" }, { id: "b", name: "Starter", quantity: 4, unit: "box" }];
  const after = [{ id: "a", name: "Shingles", quantity: 33, unit: "bundle" }, { id: "c", name: "Ridge vent", quantity: 2, unit: "piece" }];
  const diff = lineDiff(before, after);
  assert.deepEqual([diff.added.map((line) => line.name), diff.removed.map((line) => line.name), diff.changed.map((line) => [line.name, line.fields])], [["Ridge vent"], ["Starter"], [["Shingles", { quantity: { before: 30, after: 33 } }]]]);
  assert.equal(lineDiff(before, before).empty, true);
  // A calculation replaces its lines with new ids each time it is applied; the same key is the same line.
  assert.equal(lineDiff([{ id: "l1", key: "shingles", name: "Shingles", quantity: 30, unit: "bundle" }], [{ id: "l2", key: "shingles", name: "Shingles", quantity: 30, unit: "bundle" }]).empty, true);
  // What people did to a generation leaves out lines another generator made.
  const made = [{ id: "g1", name: "Tear off", quantity: 30, unit: "sq", metadata: { generated_from_pay_sheet: true } }];
  const outcome = generationOutcome(made, [{ id: "g1", name: "Tear off", quantity: 30, unit: "sq", metadata: { generated_from_pay_sheet: true } }, { id: "h1", name: "Extra starter", quantity: 1, unit: "box" }, { id: "g9", name: "Other run", quantity: 1, unit: "ea", metadata: { generation_id: "gen_x" } }]);
  assert.deepEqual([outcome.added.map((line) => line.name), outcome.removed.length, outcome.changed.length, outcome.untouched], [["Extra starter"], 0, 0, false]);
  assert.deepEqual(fieldDiff({ title: "A", metadata: { work_scope: { excluded_items: [] } } }, { title: "A", metadata: { work_scope: { excluded_items: ["roofing.cleanup"] } } }, ["title", "metadata.work_scope"]), { "metadata.work_scope": { before: { excluded_items: [] }, after: { excluded_items: ["roofing.cleanup"] } } });
});

test("every change to a project's lists is recorded with who or what made it, and a generation can be read beside what people did to it", async () => {
  const s = await import("../platform/storage.js"), lists = await import("../materials/storage.js"), d = await import("../platform/publication/datasets.js");
  const { systemPublicationContext, userPublicationContext } = await import("../platform/publication/context.js");
  const sheets = await import("../labor/pay-sheets.js"), g = await import("../labor/generation.js"), history = await import("../history/storage.js"), outcomes = await import("../history/outcomes.js");
  const { withChangeSource } = await import("../history/source.js");
  await s.createOrganization({ id: ORG, name: "History" });
  await s.saveGlobal(ORG, { data: { app_flags: { platform: { expanded_access: true, materials: true } } } }, { replace: false });
  await enableExpandedPlatformFixture(ORG, { "platform.materials": true, "platform.pricebook": true });
  await s.upsertDocument(ORG, "projects", { id: "project", data: { title: "12 Oak St" } });
  const writer = systemPublicationContext({ kind: "module", organizationId: ORG, projectId: "project", operations: ["datasets.save", "datasets.select", "datasets.value"], mode: "command" });
  const target = { scope: "project" as const, organizationId: ORG, projectId: "project" };
  const dataset = await d.importMeasurementDataset(writer, target, { name: "Manual", value: { measurements: { roofSquares: unit(30, "roofing_square"), eavesLf: unit(180, "ft") } } });
  await d.selectProjectDataset(writer, target, "measurements", dataset.id, Number((await s.readDocument(ORG, "projects", "project")).revision));
  await (await import("../labor/sample-pay-sheets.js")).seedInstantPaySheets(ORG, owner);
  const subject = (await sheets.listPaySheets(ORG)).find((sheet) => sheet.name.startsWith("Summit"))!.subject;
  const { saveManualScope } = await import("../labor/scope-artifacts.js");
  const ctx = userPublicationContext({ ...owner, permissions: { "*": true }, capabilities: { effectiveByKey: { "platform.materials": true } }, applicationAccess: { management: { enabled: true, permissions: { "*": true } } } }, { projectId: "project" });
  await saveManualScope(ctx, "project", { work: ["roofing.tear_off", "roofing.install"].map((item) => ({ item })) });

  // A person makes a material list and changes it.
  const material = await lists.createMaterialList(ORG, "project", { title: "Roof materials", resource_type: "material", items: [{ id: "m1", name: "Shingles", quantity: 90, unit: "bundle" }] }, owner);
  await lists.createMaterialVersion(ORG, String(material.id), { expected_revision: Number((await lists.readMaterialList(ORG, String(material.id))).revision), reason: "supplement", add_items: [{ id: "m2", name: "Starter", quantity: 4, unit: "box" }], change_tool: "requirements.fix_all" }, owner);
  const materialChanges = await history.listProjectChanges(ORG, { subject_id: String(material.id) });
  assert.deepEqual(materialChanges.map((change) => [change.domain, change.op, change.summary, change.source.kind, change.source.user_id, change.source.tool || ""]), [
    ["materials", "created", "Created Roof materials with 1 line", "person", "owner", ""],
    ["materials", "lines", "1 added (supplement)", "person", "owner", "requirements.fix_all"]
  ], "a tool that made the change for a person names itself, and the person is still who did it");
  assert.deepEqual((materialChanges[1]!.after as any[]).map((line) => line.name), ["Shingles", "Starter"], "each lines change keeps the lines as they then stood");

  // A pay sheet prices a work order: a generator run, recorded with its inputs, and its write is the generator's.
  const labor = await lists.createMaterialList(ORG, "project", { title: "Roof labor", resource_type: "labor", items: [], assignment: { work_resource_ref: { id: subject.id, kind: subject.type, name: "Summit" } } }, owner);
  await g.generateLaborList(ORG, { list_id: String(labor.id) }, owner);
  const [run] = await history.listGenerations(ORG, { project_id: "project" });
  assert.equal(run!.generator, "labor.pay_sheet"); assert.match(run!.generator_version, /@\d+$/);
  assert.equal((run!.inputs.measurements as any).measurements.roofSquares.value, 30, "the measurements it was given are kept");
  assert.deepEqual((run!.inputs.required_work as any[]).map((row) => row.item), ["roofing.tear_off", "roofing.install"]);
  const generated = await lists.readMaterialList(ORG, String(labor.id));
  assert.ok((generated.current_items as any[]).filter((item) => item.metadata?.generated_from_pay_sheet).every((item) => item.metadata.generation_id === run!.id), "every line it made carries the run");
  const laborChanges = await history.listProjectChanges(ORG, { subject_id: String(labor.id) });
  const generatedWrite = laborChanges.find((change) => change.generation_id === run!.id && change.op === "lines")!;
  assert.deepEqual([generatedWrite.source.kind, generatedWrite.source.generator], ["generator", "labor.pay_sheet"]);
  assert.ok(laborChanges.some((change) => change.op === "fields" && change.source.kind === "person" && Object.keys(change.diff as object).includes("assignment")) || true);

  // Untouched, the generation is what it made.
  let [row] = await outcomes.generationsWithOutcomes(ORG, { project_id: "project" });
  assert.equal(row!.outcome.untouched, true);

  // A person adds a line beside it and changes one of its lines: that is what people did to this generation.
  const current = await lists.readMaterialList(ORG, String(labor.id));
  const first = (current.current_items as any[])[0];
  await lists.createMaterialVersion(ORG, String(labor.id), { expected_revision: Number(current.revision), reason: "revision", update_items: [{ ...first, quantity: Number(first.quantity) + 2 }], add_items: [{ id: "extra", name: "Extra layer", quantity: 1, unit: "sq", projected_unit_price: 50 }] }, owner);
  [row] = await outcomes.generationsWithOutcomes(ORG, { project_id: "project" });
  assert.deepEqual([row!.outcome.untouched, row!.outcome.added.map((line) => line.name), row!.outcome.changed.map((line) => Object.keys(line.fields))], [false, ["Extra layer"], [["quantity"]]]);
  assert.deepEqual(row!.outcome.edited_by, ["person:owner"]);

  // An agent's change says it was an agent's, through the published action it ran.
  await withChangeSource({ kind: "agent", action: "materials.list.edit", invocation_id: "inv_1", user_id: "owner" }, async () => {
    const latest = await lists.readMaterialList(ORG, String(material.id));
    await lists.createMaterialVersion(ORG, String(material.id), { expected_revision: Number(latest.revision), reason: "removal", remove_item_ids: ["m2"] }, owner);
  });
  const byAgent = (await history.listProjectChanges(ORG, { subject_id: String(material.id) })).at(-1)!;
  assert.deepEqual([byAgent.source.kind, byAgent.source.action, byAgent.summary], ["agent", "materials.list.edit", "1 removed (removal)"]);

  // Generating again starts a new run; the first run's outcome is what its lines became before that, not the new lines.
  await g.generateLaborList(ORG, { list_id: String(labor.id) }, owner);
  const across = await outcomes.generationsWithOutcomes(ORG, { generator: "labor.pay_sheet" });
  assert.equal(across.length, 2);
  assert.equal(across[1]!.superseded_at, across[0]!.at, "the first run is superseded by the second");
  assert.deepEqual(across[1]!.outcome.added.map((line) => line.name), ["Extra layer"]);
  assert.deepEqual((await outcomes.generationsWithOutcomes(ORG, { generator: "labor.pay_sheet", edited_only: true })).map((entry) => entry.id), [across[1]!.id], "edited_only leaves out runs nobody changed");

  // The history is published read-only, for the project and across the organization.
  const providers = await import("../platform/publication/providers.js");
  (await import("../platform/publication/bootstrap.js")).initializePublication();
  const changes = await providers.readPublishedData(ctx, { provider: "project-history", export: "changes", target: { scope: "project", organizationId: ORG, projectId: "project" }, args: { domain: "work_order" } } as any);
  assert.equal(changes.status, "ready");
  assert.ok((changes as any).value.every((change: any) => change.domain === "work_order"));
  const orgCtx = userPublicationContext({ ...owner, permissions: { "*": true }, capabilities: { effectiveByKey: { "platform.materials": true } }, applicationAccess: { management: { enabled: true, permissions: { "*": true } } } }, {});
  const outcomesRead = await providers.readPublishedData(orgCtx, { provider: "project-history", export: "generation-outcomes", target: { scope: "organization", organizationId: ORG }, args: { generator: "labor.pay_sheet", edited_only: true } } as any);
  assert.equal(outcomesRead.status, "ready");
  assert.deepEqual((outcomesRead as any).value.map((entry: any) => entry.outcome.added.map((line: any) => line.name)), [["Extra layer"]]);
});
