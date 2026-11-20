import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

// The Automations Hub setup (GP-110, GP-119, docs/architecture/automations-hub.md): it asks how the company runs and
// builds the flow from the answers: the MVP platform's one pipeline, a first call and an appointment at its front, new
// leads waiting as new leads, or the sold job handed to the production board.
// Before anything is imported: the stores read where they live once.
const dir = await mkdtemp(path.join(os.tmpdir(), "automations-setup-"));
Object.assign(process.env, { NODE_ENV: "test", FIRSTMATE_ENV: "test", PLATFORM_STORAGE_ROOT: path.join(dir, "platform"), CRM_STORAGE_ROOT: path.join(dir, "crm"),
  PLATFORM_HEARTBEAT_DISABLED: "1", WORK_SCHEDULER_DISABLED: "1", FIRSTMEASURE_JOB_WORKERS: "0",
  FIRSTMEASURE_DATABASE_MODE: process.env.TEST_POSTGRES_URL ? "postgres" : "local", DATABASE_URL: process.env.TEST_POSTGRES_URL || "", POSTGRES_POOL_MAX: "4", POSTGRES_AUTO_MIGRATE: "false" });

const stage = (id: string, title: string, todos: string[], extra: Record<string, unknown> = {}) => ({ id, title, terminology_key: "work.stage", completion_mode: "all_children", ...extra,
  children: todos.map((todo) => ({ id: todo, title: todo, terminology_key: "work.task", actionable: true })) });
/** Shaped like the MVP platform's pipeline on dev (GP-119): new lead to complete, signing marks the sale won. */
const SOURCE = { id: "generic_roofing", name: "Roofing", category_ids: ["sales"], work_plan: { title: "Roofing", root_nodes: [{ id: "roofing_phase", title: "Roofing", terminology_key: "work.phase", completion_mode: "all_children", children: [
  stage("new_lead", "New lead", ["order_report"]),
  stage("measurements", "Measurements ordered", ["receive_report"], { depends_on: ["new_lead"] }),
  { ...stage("signing", "Signing", [], { depends_on: ["measurements"] }), children: [{ id: "get_signed", title: "Get signed", actionable: true, automation_bindings: { onCompleted: [{ id: "mark_sale_won", automation: "sales.markWon.v1" }] } }] },
  stage("production", "Production", ["install_roof"], { depends_on: ["signing"] }),
  stage("complete", "Complete", ["close_out"], { depends_on: ["production"] })
] }] } };
const stagesOf = (definition: any) => definition.work_plan.root_nodes[0].children.map((node: any) => node.title);
const todosOf = (definition: any, id: string) => definition.work_plan.root_nodes[0].children.find((node: any) => node.id === id).children.map((node: any) => node.id);

test("the answers become the flow: the one pipeline by default, a first call, an appointment, a handoff", async () => {
  const { pipelineDefinition, leadFlowOf, setupCategoryIds } = await import("../scopes/flow-setup.js");
  const flow = (answers: Record<string, string>) => leadFlowOf(answers);
  assert.deepEqual(leadFlowOf({}), { job_known: "yes", first_call: "no", visit: "no", handoff: "same" }, "unanswered is the MVP platform's way");
  assert.deepEqual(setupCategoryIds(["production", "storm"], ["sales", "production"]), ["sales", "production", "storm"], "other categories stay");

  const plain = pipelineDefinition(SOURCE, null, flow({}), null);
  assert.deepEqual(stagesOf(plain), ["New lead", "Measurements ordered", "Signing", "Production", "Complete"]);
  assert.deepEqual(plain.category_ids, ["sales", "production"], "the one pipeline spans Sales and Production");

  const call = pipelineDefinition(SOURCE, null, flow({ first_call: "yes", visit: "yes" }), null);
  assert.deepEqual(stagesOf(call), ["First call", "Appointment", "Measurements ordered", "Signing", "Production", "Complete"]);
  assert.deepEqual(todosOf(call, "new_lead"), ["setup_call"], "a new lead's first step is the call");
  assert.deepEqual(todosOf(call, "measurements"), ["order_report", "receive_report"], "measuring moves after it");
  assert.deepEqual((call as any).work_plan.root_nodes[0].children.find((node: any) => node.id === "measurements").depends_on, ["setup_appointment"]);
  const callTodo = (call as any).work_plan.root_nodes[0].children[0].children[0];
  assert.ok(callTodo.external_triggers.some((trigger: any) => trigger.event === "project.event_scheduled"), "booking the appointment ticks the call");
  assert.ok(callTodo.external_triggers.some((trigger: any) => trigger.event === "measurement.report.ordered"), "so does a later step");

  const visitOnly = pipelineDefinition(SOURCE, null, flow({ visit: "yes" }), null);
  assert.deepEqual(stagesOf(visitOnly), ["New lead", "Appointment", "Measurements ordered", "Signing", "Production", "Complete"]);
  assert.deepEqual(todosOf(visitOnly, "new_lead"), ["setup_book_appointment"]);
  assert.deepEqual(stagesOf(pipelineDefinition(SOURCE, null, flow({ job_known: "no", first_call: "yes" }), null)), stagesOf(plain), "found out on the phone: the call came before the board");

  const handed = pipelineDefinition(SOURCE, null, flow({ handoff: "separate" }), "roof_replacement");
  assert.deepEqual(stagesOf(handed), ["New lead", "Measurements ordered", "Signing"], "the pipeline ends at the signature");
  assert.deepEqual(handed.category_ids, ["sales"]);
  const signing = (handed as any).work_plan.root_nodes[0].children[2];
  assert.deepEqual(signing.automation_bindings.onCompleted.map((binding: any) => [binding.automation, binding.input.template_id]), [["scopes.activateTemplate.v1", "roof_replacement"]]);

  // A wire someone drew from a stage is kept; the setup's own are rebuilt, not repeated.
  const current = { name: "Our roofs", definition: JSON.parse(JSON.stringify(handed)) };
  current.definition.work_plan.root_nodes[0].children[0].automation_bindings = { onCompleted: [{ id: "start_gutters", automation: "scopes.activateTemplate.v1", input: { template_id: "gutters" } }] };
  const again = pipelineDefinition(SOURCE, current, flow({}), null);
  assert.equal(again.name, "Our roofs", "a renamed pipeline keeps its name");
  assert.deepEqual(stagesOf(again), stagesOf(plain), "back to one pipeline");
  assert.deepEqual((again as any).work_plan.root_nodes[0].children[0].automation_bindings.onCompleted.map((binding: any) => binding.id), ["start_gutters"]);
  assert.equal(JSON.stringify(again).includes("setup_start_production"), false);
});

test("the setup saves the answers and builds the flow in the organization", async (t) => {
  const storage = await import("../platform/storage.js");
  const { applyAutomationsSetup, planAutomationsSetup } = await import("../scopes/flow-setup.js");
  const { readIntakeRouting, saveIntakeRouting, resolveIntakeEntry } = await import("../scopes/router.js");
  const { readScopeTemplate, readScopeFlagState } = await import("../scopes/storage.js");
  const { readScopeCategories, saveScopeCategories, templateCategoryIds } = await import("../scopes/categories.js");
  const { readCompanyProfile } = await import("../company-profile/profile.js");
  const { receiveLead } = await import("../leads/receive.js");
  const { listPlanRecords } = await import("../work/storage.js");
  t.after(async () => { await (await import("../platform/sql_store.js")).closeSqlStoresForTests(); await (await import("../src/database/postgres.js")).closePostgresPools(); await rm(dir, { recursive: true, force: true }); });
  const ORG = "org_automations_setup";
  await storage.createOrganization({ id: ORG, name: "Automations setup" });
  await (await import("./helpers/platform-fixture.js")).enableExpandedPlatformFixture(ORG);

  // A rule the organization made is kept. An organization that turned Production off gets it back for the lane.
  const before = await readIntakeRouting(ORG, "default");
  await saveIntakeRouting(ORG, "default", { expected_revision: before.revision, data: { ...before, routing_mode: "formula", rules: [{ id: "chat", title: "Chats", entry: "unscoped", formula: { match: "all", conditions: [{ field: "lead_source.kind", operator: "in", value: "live_chat" }] } }] } });
  const catalog = await readScopeCategories(ORG);
  await saveScopeCategories(ORG, { categories: catalog.categories.map((category) => category.id === "production" ? { ...category, enabled: false } : category) });

  // Previewing writes nothing: the organization has no MVP pipeline yet.
  const plan = await planAutomationsSetup(ORG, {});
  assert.deepEqual([plan.pipeline_id, plan.templates[0]!.install, plan.routing], ["generic_roofing", true, { default_entry: "scope", default_template_id: "generic_roofing" }]);
  await assert.rejects(() => readScopeTemplate(ORG, "default", "generic_roofing"), /not found/);

  // Nothing answered: every organization starts on the one pipeline, in Sales and Production, leads straight onto it.
  const first = await applyAutomationsSetup(ORG, {}, "user_owner");
  assert.deepEqual([first.pipeline_id, first.category_ids, first.production_id], ["generic_roofing", ["sales", "production"], null]);
  assert.deepEqual(templateCategoryIds((await readScopeTemplate(ORG, "default", "generic_roofing")).definition), ["sales", "production"]);
  assert.equal((await readScopeTemplate(ORG, "default", "generic_roofing")).enabled, true);
  assert.equal((await readScopeCategories(ORG)).categories.find((category) => category.id === "production")?.enabled, true);
  const routing = await readIntakeRouting(ORG, "default");
  assert.deepEqual([routing.default_entry, routing.default_template_id, routing.rules.map((rule) => rule.id)], ["scope", "generic_roofing", ["chat"]]);
  assert.deepEqual(resolveIntakeEntry(routing, { lead_source: { kind: "web_form" } }), { entry: "scope", template_id: "generic_roofing" });
  assert.deepEqual(resolveIntakeEntry(routing, { lead_source: { kind: "live_chat" } }), { entry: "unscoped" });
  await receiveLead(ORG, { project_id: "lead_roof", source: { kind: "web_form" }, address: "4 Elm St", notification: false });
  assert.equal((await listPlanRecords(ORG, { project_id: "lead_roof", sales: true })).length, 1, "a new lead goes onto the pipeline and is an opportunity");
  assert.equal((await applyAutomationsSetup(ORG, {}, "user_owner")).templates_changed.length, 0, "the same answers again change nothing");

  // They call first and go out to see the job; someone else runs it once sold.
  const production = (await readScopeFlagState(ORG, "default")).flags.roof_replacement;
  const handed = await applyAutomationsSetup(ORG, { job_known: "mostly", first_call: "yes", visit: "yes", handoff: "separate" }, "user_owner");
  assert.deepEqual([handed.category_ids, handed.production_id], [["sales"], "roof_replacement"]);
  const pipeline = (await readScopeTemplate(ORG, "default", "generic_roofing")).definition as any;
  const stages = pipeline.work_plan.root_nodes[0].children;
  assert.deepEqual(stages.slice(0, 2).map((node: any) => node.title), ["First call", "Appointment"]);
  const last = stages[stages.length - 1];
  assert.deepEqual(last.automation_bindings.onCompleted.map((binding: any) => binding.input?.template_id).filter(Boolean), ["roof_replacement"], "its end starts the production board");
  assert.deepEqual(templateCategoryIds((await readScopeTemplate(ORG, "default", "roof_replacement")).definition), ["production"]);
  assert.equal((await readScopeTemplate(ORG, "default", "roof_replacement")).enabled, true);
  const profile = await readCompanyProfile(ORG);
  assert.deepEqual(profile.lead_flow, { job_known: "mostly", first_call: "yes", visit: "yes", handoff: "separate", answered: true }, "the answers are the company's");

  // They find out what the job is on the phone: new leads wait as new leads until the call.
  await applyAutomationsSetup(ORG, { job_known: "no", visit: "no", handoff: "same" }, "user_owner");
  assert.deepEqual(resolveIntakeEntry(await readIntakeRouting(ORG, "default"), { lead_source: { kind: "web_form" } }), { entry: "unscoped" });
  assert.equal((await readScopeTemplate(ORG, "default", "roof_replacement")).enabled, production, "a production board is left as it was found");
  assert.equal((await readCompanyProfile(ORG)).lead_flow.answered, true, "first_call is not asked of them");

  // GP-141: a production board the setup turned on stays on when it is the board of work the company does.
  const { patchScopeFlags } = await import("../scopes/storage.js");
  const { syncWorkBoards } = await import("../scopes/work-boards.js");
  await patchScopeFlags(ORG, { expected_revision: (await readScopeFlagState(ORG, "default")).revision, flags: { roof_replacement: false } }, "default");
  await applyAutomationsSetup(ORG, { handoff: "separate" }, "user_owner");
  await syncWorkBoards(ORG, "default", { services: [{ id: "roof_replacement", label: "Re-roofs", work_kind: "roofing" }], lead_flow: (await readCompanyProfile(ORG)).lead_flow }, "user_owner");
  await applyAutomationsSetup(ORG, { handoff: "same" }, "user_owner");
  assert.equal((await readScopeTemplate(ORG, "default", "roof_replacement")).enabled, true, "re-roofs are still its work");
});
