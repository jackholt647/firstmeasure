import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test, { after } from "node:test";
import { closePlatformFixtureStores, enableExpandedPlatformFixture } from "./helpers/platform-fixture.js";

// Stage-based default checklists (GP-1, workforce/checklist-defaults.ts): Checklist settings set, per pipeline, the
// stages each default checklist is added in; a pipeline nobody set up keeps adding every default when a scope starts.
const dir = await mkdtemp(path.join(os.tmpdir(), "checklist-defaults-"));
Object.assign(process.env, { NODE_ENV: "test", PLATFORM_STORAGE_ROOT: path.join(dir, "platform"), PRICEBOOK_STORAGE_ROOT: path.join(dir, "pricebook"), FIRSTMEASURE_STORAGE_ROOT: path.join(dir, "firstmeasure"), FIRSTMEASURE_INDEX_DB_PATH: path.join(dir, "index.sqlite"), PLATFORM_HEARTBEAT_DISABLED: "1", FIRSTMEASURE_JOB_WORKERS: "0" });
after(async () => {
  await closePlatformFixtureStores();
  const { closeWorkforceDatabase } = await import("../workforce/storage.js");
  await closeWorkforceDatabase();
  await rm(dir, { recursive: true, force: true }).catch(() => {});
});

const ORG = "org_checklist_defaults";
const flags = { "apps.checklists": true, "apps.crew": true };
const owner = { orgId: ORG, userId: "owner", role: "owner", permissions: { "*": true }, branchId: "default", organization: { data: {} }, capabilities: { effectiveByKey: flags } } as any;
const keys = (lists: Array<{ source_key: string }>) => lists.map((entry) => entry.source_key).sort();
const setupList = (use_case: string, title: string) => ({ use_case, title, description: "", audience: "crew", crew_editable: false, signature_required: false, customer: "none", items: [{ title: `${title} item`, item_type: "todo" }] }) as any;

test("default checklists are added by pipeline stage once a pipeline is set up", async () => {
  const storage = await import("../platform/storage.js");
  await storage.createOrganization({ id: ORG, name: "Checklist defaults" }).catch(() => {});
  await enableExpandedPlatformFixture(ORG, flags);
  const project = async (id: string) => { await storage.upsertDocument(ORG, "projects", { id, data: { branch_id: "default", title: id }, metadata: { kind: "platform_project", branch_id: "default" } }, { replace: true }); return id; };
  const { initializePublication } = await import("../platform/publication/bootstrap.js");
  initializePublication();
  const { invokeAction } = await import("../platform/publication/actions.js");
  const { readPublishedData: readData } = await import("../platform/publication/providers.js");
  const { userPublicationContext } = await import("../platform/publication/context.js");
  const { registerBuiltinWorkAutomations } = await import("../work/automations/builtins.js");
  registerBuiltinWorkAutomations();
  const { workAutomation } = await import("../work/registry.js");
  const crew = await import("../workforce/crew_storage.js");
  const defaults = await import("../workforce/checklist-defaults.js");
  const scopeStarts = workAutomation("checklists.initializeFromScope.v1")!;
  const stageReached = workAutomation("checklists.addStageDefaults.v1")!;
  const start = (projectId: string) => scopeStarts({ event: { organization_id: ORG }, project: { id: projectId }, plan: { template_id: "manual", branch_id: "default" } } as any, {}) as Promise<any>;
  const reach = (projectId: string, stage: string) => stageReached({ event: { organization_id: ORG, type: "work.node.started" }, project: { id: projectId }, plan: { template_id: "manual" }, node: { terminology_key: "work.stage", template_node_id: stage } } as any, {}) as Promise<any>;
  const target = (projectId: string) => ({ scope: "project" as const, organizationId: ORG, projectId });
  let calls = 0;
  const save = async (projectId: string, input: Record<string, unknown>) => {
    const result: any = await invokeAction(userPublicationContext(owner, { mode: "command" }), { action: "checklists.defaults.save", target: target(projectId) }, input, { idempotencyKey: `save-${++calls}` });
    assert.equal(result.receipt?.status, "succeeded", JSON.stringify(result));
    return result.value;
  };
  const read = async (projectId: string) => {
    const result: any = await readData(userPublicationContext(owner), { provider: "checklist-defaults", export: "settings", target: target(projectId) });
    assert.equal(result.status, "ready", JSON.stringify(result));
    return result.value;
  };

  // The setup picked two defaults. The Manual pipeline is not set up: every default, from the start, as before.
  await defaults.saveSetupDefaults(ORG, [setupList("crew_safety", "Safety"), setupList("work_completion", "Completion")], "owner");
  const first = await project("defaults_first");
  const before = await read(first);
  const manual = before.pipelines.find((pipeline: any) => pipeline.id === "manual");
  assert.ok(manual, "the Manual pipeline is listed");
  assert.equal(manual.configured, false);
  assert.deepEqual(manual.stages.map((stage: any) => stage.id), ["service_contract_stage", "service_scheduling_stage", "service_work_stage"]);
  assert.deepEqual(manual.checklists, { crew_safety: "all", work_completion: "all" });
  assert.deepEqual(before.checklists.map((entry: any) => entry.key), ["crew_safety", "work_completion"]);
  assert.equal((await start(first)).source, "organization_starting_checklists");
  assert.deepEqual(keys(await crew.listProjectChecklists(ORG, first)), ["setup:crew_safety", "setup:work_completion"]);
  assert.equal((await reach(first, "service_work_stage")).reason, "pipeline_not_configured", "an unconfigured pipeline adds nothing per stage");

  // Set up: safety in every stage, completion only in Service.
  const saved = await save(first, { expected_revision: before.revision, pipeline: { id: "manual", checklists: { crew_safety: "all", work_completion: ["service_work_stage"] } } });
  assert.equal(saved.pipelines.find((pipeline: any) => pipeline.id === "manual").configured, true);
  const second = await project("defaults_second");
  assert.equal((await start(second)).source, "pipeline_stage_defaults");
  assert.deepEqual(keys(await crew.listProjectChecklists(ORG, second)), ["setup:crew_safety"], "the scope starts in Contract: only the all-stages list");
  assert.equal((await reach(second, "service_scheduling_stage")).reason, "no_default_checklists_for_stage");
  assert.equal((await reach(second, "service_work_stage")).checklist_count, 1);
  assert.deepEqual(keys(await crew.listProjectChecklists(ORG, second)), ["setup:crew_safety", "setup:work_completion"]);
  assert.equal((await reach(second, "service_work_stage")).checklist_count, 0, "reaching it again adds nothing twice");
  // A manual board move counts as reaching the stage; a deleted default does not come back.
  const completion = (await crew.listProjectChecklists(ORG, second)).find((entry) => entry.source_key === "setup:work_completion")!;
  await crew.deleteProjectChecklist(ORG, second, completion.id, "owner");
  const moved = await stageReached({ event: { organization_id: ORG, type: "work.plan.stage_manually_set", payload: { to_stage_id: "service_work_stage" } }, project: { id: second }, plan: { template_id: "manual" }, node: {} } as any, {}) as any;
  assert.equal(moved.checklist_count, 0);
  assert.deepEqual(keys(await crew.listProjectChecklists(ORG, second)), ["setup:crew_safety"]);
  assert.equal((await stageReached({ event: { organization_id: ORG, type: "work.node.started" }, project: { id: second }, plan: { template_id: "manual" }, node: { terminology_key: "work.task", template_node_id: "service_work_stage" } } as any, {}) as any).reason, "not_a_stage");

  // One of this project's checklists becomes a default: it is that default here (no copy) and is off in Manual until
  // someone turns it on.
  const own = await crew.createProjectChecklist(ORG, second, { title: "Final walkthrough", items: [{ title: "Walk the site" }, { title: "Rate cleanup", item_type: "rating" }] }, "owner");
  const added = await save(second, { add_from_checklist_id: own.id });
  const key = added.added.key as string;
  assert.match(key, /^list_[0-9a-f]{10}$/);
  const made = added.checklists.find((entry: any) => entry.key === key);
  assert.equal(made.title, "Final walkthrough");
  assert.deepEqual(made.items.map((item: any) => item.item_type), ["todo", "rating"]);
  assert.equal((await crew.listProjectChecklists(ORG, second)).find((entry) => entry.id === own.id)!.source_key, `setup:${key}`);
  assert.equal(added.pipelines.find((pipeline: any) => pipeline.id === "manual").checklists[key], undefined);
  await assert.rejects(() => defaults.saveChecklistDefaults(ORG, second, { add_from_checklist_id: own.id }, "owner"), /already a default/);
  await save(second, { pipeline: { id: "manual", checklists: { crew_safety: "all", work_completion: ["service_work_stage"], [key]: ["service_scheduling_stage"] } } });
  const third = await project("defaults_third");
  await start(third);
  await reach(third, "service_scheduling_stage");
  assert.deepEqual((await crew.listProjectChecklists(ORG, third)).map((entry) => entry.title).sort(), ["Final walkthrough", "Safety"]);

  // Playing the setup again changes only its own picks: the pipeline settings and the project-made default stay, and
  // a newly picked list is on for all stages of a pipeline someone set up.
  await defaults.saveSetupDefaults(ORG, [setupList("crew_safety", "Safety"), setupList("punchlist", "Punch list")], "owner");
  const replayed = await read(third);
  assert.deepEqual(replayed.checklists.map((entry: any) => entry.key), ["crew_safety", "punchlist", key]);
  assert.deepEqual(replayed.pipelines.find((pipeline: any) => pipeline.id === "manual").checklists, { crew_safety: "all", [key]: ["service_scheduling_stage"], punchlist: "all" });

  // Stale saves are refused; removing a default takes it out of every pipeline; null puts a pipeline back.
  await assert.rejects(() => defaults.saveChecklistDefaults(ORG, third, { expected_revision: before.revision, remove: [key] }, "owner"), /changed the checklist settings/);
  const removed = await save(third, { expected_revision: replayed.revision, remove: [key] });
  assert.ok(!removed.checklists.some((entry: any) => entry.key === key));
  assert.deepEqual(removed.pipelines.find((pipeline: any) => pipeline.id === "manual").checklists, { crew_safety: "all", punchlist: "all" });
  assert.equal((await crew.listProjectChecklists(ORG, third)).length, 2, "projects keep the lists they have");
  await assert.rejects(() => defaults.saveChecklistDefaults(ORG, third, { pipeline: { id: "manual", checklists: { nope: "all" } } }, "owner"), /Not a default checklist/);
  const reset = await save(third, { pipeline: { id: "manual", checklists: null } });
  assert.equal(reset.pipelines.find((pipeline: any) => pipeline.id === "manual").configured, false);
});
