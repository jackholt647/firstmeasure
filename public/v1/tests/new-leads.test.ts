import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

// New leads, intake scopes and the lead.received rules (docs/architecture/opportunities.md).
test("a lead routing leaves unscoped is a new lead until a scope, a loss or a merge", async (t) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "new-leads-"));
  Object.assign(process.env, { NODE_ENV: "test", FIRSTMATE_ENV: "test", PLATFORM_STORAGE_ROOT: path.join(dir, "platform"), CRM_STORAGE_ROOT: path.join(dir, "crm"),
    PLATFORM_HEARTBEAT_DISABLED: "1", WORK_SCHEDULER_DISABLED: "1", FIRSTMEASURE_JOB_WORKERS: "0",
    // Runs on SQLite by default and on PostgreSQL through tests/run-embedded-postgres.mjs, which sets TEST_POSTGRES_URL.
    FIRSTMEASURE_DATABASE_MODE: process.env.TEST_POSTGRES_URL ? "postgres" : "local", DATABASE_URL: process.env.TEST_POSTGRES_URL || "", POSTGRES_POOL_MAX: "4", POSTGRES_AUTO_MIGRATE: "false" });
  const storage = await import("../platform/storage.js");
  const { receiveLead } = await import("../leads/receive.js");
  const { leadFromMissedCall } = await import("../leads/calls.js");
  const { readIntakeRouting, saveIntakeRouting } = await import("../scopes/router.js");
  const { readScopeTemplate, saveScopeTemplate } = await import("../scopes/storage.js");
  const { instantiateScopeTemplateWorkPlan } = await import("../scopes/service.js");
  const { setOpportunityOutcome } = await import("../work/opportunities.js");
  const { listPlanRecords } = await import("../work/storage.js");
  const { listWorkBoards, NEW_LEADS_COLUMN_ID } = await import("../work/service.js");
  const { drainWorkEvents } = await import("../work/engine.js");
  const { createProject } = await import("../projects/create.js");
  t.after(async () => { await (await import("../platform/sql_store.js")).closeSqlStoresForTests(); await (await import("../src/database/postgres.js")).closePostgresPools(); await rm(dir, { recursive: true, force: true }); });
  const ORG = "org_new_leads";
  await storage.createOrganization({ id: ORG, name: "New leads" });
  await (await import("./helpers/platform-fixture.js")).enableExpandedPlatformFixture(ORG);
  const lifecycle = async (id: string) => (await storage.readDocument(ORG, "projects", id)).data.lifecycle as Record<string, any>;
  const notifications = async () => (await storage.listDocuments(ORG, "notifications")).map(doc => doc.data as Record<string, any>);

  // Until routing is saved, a missed call starts with no scope; other leads get the default entry scope.
  const missed = await leadFromMissedCall(ORG, { id: "call_1", branch_id: "default", customer_number: "+15550401000", project_id: "", metadata: {} });
  assert.ok(missed.project_id && missed.contact_id, "a number no contact has becomes a contact and a new lead");
  assert.deepEqual(await listPlanRecords(ORG, { project_id: missed.project_id }), []);
  assert.deepEqual([(await lifecycle(missed.project_id)).new_lead, (await lifecycle(missed.project_id)).status, (await lifecycle(missed.project_id)).opportunities.open], [true, "open", 1]);
  assert.deepEqual(await leadFromMissedCall(ORG, { id: "call_2", branch_id: "default", customer_number: "(555) 040-1000", project_id: "" }), { project_id: "", contact_id: "" }, "a known contact's missed call is only logged by default");
  const web = await receiveLead(ORG, { project_id: "lead_web", source: { kind: "web_form" }, address: "2 Oak St", contacts: [{ name: "Ada", phone: "555-040-2000" }], notification: { target_role_ids: ["estimators"], title: "New form lead: Roof" } });
  assert.equal((await listPlanRecords(ORG, { project_id: "lead_web", sales: true })).length, 1);
  assert.equal(web.project.data.lifecycle && (web.project.data.lifecycle as Record<string, unknown>).new_lead, false);

  // The organization's rules on lead.received notify (who the source named, else the sales roles) and queue the call.
  await drainWorkEvents();
  const sent = await notifications();
  const missedNote = sent.find(n => n.context?.project_id === missed.project_id)!, webNote = sent.find(n => n.context?.project_id === "lead_web")!;
  assert.deepEqual([missedNote.title, missedNote.target_role_ids, missedNote.frontend_action], ["Missed call from a new number", ["inside_sales", "sales_appointments"], { kind: "open_project", project_id: missed.project_id, project_tab: "overview" }]);
  assert.deepEqual([webNote.title, webNote.target_role_ids], ["New form lead: Roof", ["estimators"]]);
  await receiveLead(ORG, { project_id: "lead_quiet", source: { kind: "manual_lead" }, address: "3 Fir St", notification: false });
  await drainWorkEvents();
  assert.equal((await notifications()).filter(n => n.context?.project_id === "lead_quiet").length, 0, "a source may ask for no notification");

  // A sales board can show new leads as its first column.
  const pipeline = await readScopeTemplate(ORG, "default", "sales_pipeline");
  const definition = pipeline.definition as Record<string, any>;
  await saveScopeTemplate(ORG, "default", { ...definition, work_plan: { ...definition.work_plan, metadata: { ...definition.work_plan.metadata, new_leads_column: true } }, expected_version: pipeline.version });
  const board = (await listWorkBoards(ORG, {})).find(b => b.id === "sales_pipeline")!;
  const column = (board.columns as Array<Record<string, any>>)[0]!;
  assert.deepEqual([column.id, column.kind, column.cards.map((c: Record<string, unknown>) => c.project_id).sort()], [NEW_LEADS_COLUMN_ID, "new_leads", [missed.project_id]]);

  // An intake scope runs before a scope: off the boards, not an opportunity, the project still a new lead.
  const intake = await saveScopeTemplate(ORG, "default", {
    schema_version: 1, id: "call_then_route", name: "Call, then route", category_ids: ["intake"], status: "active",
    work_plan: { title: "Call, then route", root_nodes: [{ id: "intake_phase", title: "Intake", terminology_key: "work.phase", children: [
      { id: "call_stage", title: "Call", terminology_key: "work.stage", children: [{ id: "first_call", title: "Call the lead", terminology_key: "work.task", actionable: true }] }
    ] }] }
  });
  await assert.rejects(() => saveScopeTemplate(ORG, "default", { ...(intake.definition as Record<string, unknown>), category_ids: ["intake", "sales"], expected_version: intake.version }), /cannot also be a sales scope/);
  await saveIntakeRouting(ORG, "default", { ...(await readIntakeRouting(ORG, "default")), default_entry: "scope", default_template_id: "call_then_route" });
  const routed = await receiveLead(ORG, { project_id: "lead_intake", source: { kind: "web_form" }, address: "4 Elm St", contacts: [{ name: "Bo", phone: "555-040-3000" }] });
  const [intakePlan] = await listPlanRecords(ORG, { project_id: "lead_intake" });
  assert.deepEqual([intakePlan?.sales, (intakePlan?.metadata as Record<string, unknown>).hide_from_boards, (routed.project.data.lifecycle as Record<string, unknown>).new_lead], [false, true, true]);
  assert.ok(!(await listWorkBoards(ORG, {})).some(b => b.id === "call_then_route"), "an intake scope is never a board");

  // Starting a sales scope routes it: the intake plan completes and the opportunity is the sales plan.
  await instantiateScopeTemplateWorkPlan(ORG, { project_id: "lead_intake", template: await readScopeTemplate(ORG, "default", "roofing_sales_appointment") });
  const plans = await listPlanRecords(ORG, { project_id: "lead_intake" });
  const closed = plans.find(p => p.id === intakePlan!.id)!;
  assert.deepEqual([closed.status, (closed.metadata as Record<string, unknown>).completed_reason], ["completed", "routed"]);
  assert.deepEqual([(await lifecycle("lead_intake")).new_lead, (await lifecycle("lead_intake")).opportunities.open], [false, 1]);

  // A wrong number is lost with a reason, and can be reopened.
  await setOpportunityOutcome(ORG, { project_id: missed.project_id, outcome: "lost", reason: "not_a_lead" });
  assert.deepEqual([(await lifecycle(missed.project_id)).new_lead, (await lifecycle(missed.project_id)).status], [false, "lost"]);
  await setOpportunityOutcome(ORG, { project_id: missed.project_id, outcome: "open", reason: "called back" });
  assert.equal((await lifecycle(missed.project_id)).new_lead, true);

  // A project made by hand always starts a scope: the one it names, or the branch's manual default.
  const byHand = await createProject(ORG, { id: "hand_made", data: { title: "Fence", address: "5 Ash St" } });
  assert.deepEqual([(await listPlanRecords(ORG, { project_id: "hand_made" })).map(p => p.template_id), (byHand.data.lifecycle as Record<string, unknown>).new_lead], [["manual"], false]);
  await createProject(ORG, { id: "hand_roof", scope_template_id: "roof_replacement", data: { title: "Roof" } });
  assert.deepEqual((await listPlanRecords(ORG, { project_id: "hand_roof" })).map(p => p.template_id), ["roof_replacement"]);
  await assert.rejects(() => createProject(ORG, { id: "hand_none", scope_template_id: "no_such_scope", data: { title: "?" } }), /Choose an available scope/);
  await assert.rejects(() => storage.readDocument(ORG, "projects", "hand_none"), /not found|missing/i, "a refused project is not written");
});
