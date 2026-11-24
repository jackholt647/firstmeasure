import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import type { PlatformAuthContext } from "../platform/auth.js";

// Flows (docs/architecture/flows.md): one definition for call scripts and workflows, played on the server.
test("a flow plays step by step: branches, records, saved answers, actions and outcomes", async (t) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "flows-"));
  Object.assign(process.env, { NODE_ENV: "test", FIRSTMATE_ENV: "test", PLATFORM_STORAGE_ROOT: path.join(dir, "platform"), CRM_STORAGE_ROOT: path.join(dir, "crm"),
    PLATFORM_HEARTBEAT_DISABLED: "1", WORK_SCHEDULER_DISABLED: "1", FIRSTMEASURE_JOB_WORKERS: "0",
    FIRSTMEASURE_DATABASE_MODE: process.env.TEST_POSTGRES_URL ? "postgres" : "local", DATABASE_URL: process.env.TEST_POSTGRES_URL || "", POSTGRES_POOL_MAX: "4", POSTGRES_AUTO_MIGRATE: "false" });
  const storage = await import("../platform/storage.js");
  const flows = await import("../flows/service.js");
  const { newLeadFlow, manualLeadFlow, SUGGESTED_QUESTIONS } = await import("../flows/new-lead.js");
  const { listEventRecords, listNodeRecords } = await import("../work/storage.js");
  const { drainWorkEvents } = await import("../work/engine.js");
  const contacts = await import("../contacts/records.js");
  t.after(async () => { await (await import("../platform/sql_store.js")).closeSqlStoresForTests(); await (await import("../src/database/postgres.js")).closePostgresPools(); await rm(dir, { recursive: true, force: true }); });
  const ORG = "org_flows";
  await storage.createOrganization({ id: ORG, name: "Flow Roofing" });
  await (await import("./helpers/platform-fixture.js")).enableExpandedPlatformFixture(ORG);
  const person = (id: string, permissions: Record<string, boolean>) => ({ orgId: ORG, userId: id, role: "member", branchId: "default", permissions, user: { first_name: "Sam", name: "Sam Lee" },
    organization: { name: "Flow Roofing" }, appEntitlements: [] } as unknown as PlatformAuthContext);
  const owner = person("u_owner", { manage_company_settings: true, manage_projects: true, view_projects: true });
  const rep = person("u_rep", { manage_projects: true, view_projects: true });
  const viewer = person("u_viewer", { view_projects: true });

  // The contract refuses a flow that goes nowhere.
  assert.throws(() => flows.parseFlow({ name: "Broken", start: "a", steps: [{ id: "a", next: "missing" }] }), /not a step/);
  assert.throws(() => flows.parseFlow({ name: "Twice", start: "a", steps: [{ id: "a", blocks: [{ id: "x", kind: "ask", key: "k" }, { id: "y", kind: "ask", key: "k" }] }] }), /asked twice/);
  await assert.rejects(() => flows.saveFlow(rep, { definition: manualLeadFlow(SUGGESTED_QUESTIONS) }), /company settings or communications/, "only editors save flows");
  // Every issue names where it is, so the editor draws it next to the step, block or option it is about.
  const issuesOf = (definition: unknown) => { try { flows.parseFlow(definition); return []; } catch (error) { return ((error as { details?: { issues?: Array<{ path: string; message: string }> } }).details?.issues || []).map((issue) => [issue.path, issue.message]); } };
  assert.deepEqual(issuesOf({ name: "Paths", start: "nowhere", outcomes: [{ id: "o" }, { id: "o" }], steps: [
    { id: "a", next: "gone", blocks: [{ id: "c", kind: "choice", key: "k", options: [{ id: "x", to: "lost" }, { id: "y", outcome: "missing" }] }] },
    { id: "b", blocks: [{ id: "q", kind: "ask", key: "k" }, { id: "q", kind: "outcome", outcome: "nope" }] }] }), [
    ["outcomes.1.id", 'Outcome "o" is used twice.'],
    ["start", 'The flow starts at "nowhere", which is not a step.'],
    ["steps.0.next", 'Step "a" goes to "gone", which is not a step.'],
    ["steps.0.blocks.0.options.0.to", '"k" goes to "lost", which is not a step.'],
    ["steps.0.blocks.0.options.1.outcome", '"k" ends with "missing", which is not an outcome.'],
    ["steps.1.blocks.0.key", 'The answer "k" is asked twice.'],
    ["steps.1.blocks.1.id", 'Step "b" uses block id "q" twice.'],
    ["steps.1.blocks.1.outcome", 'Step "b" ends with "nope", which is not an outcome.']
  ]);
  // The editor's action picker: the catalog's actions with their input schemas, without internal machinery.
  const actions = flows.flowActions();
  const sms = actions.find((action) => action.id === "communications.sendSms.v1");
  assert.ok(sms?.title && (sms.input_schema as { properties?: Record<string, unknown> }).properties?.text, "texts are offered with their fields");
  assert.ok(actions.some((action) => action.id === "work.createTodo.v1") && actions.length > 5);

  // New › Lead: find or create the contact, make the lead through intake, ask, then open it.
  const manual = await flows.saveFlow(owner, { id: "new_lead", definition: manualLeadFlow(SUGGESTED_QUESTIONS) });
  assert.deepEqual((await flows.newMenuFlows(rep)).map((entry) => [entry.id, entry.label]), [["new_lead", "Lead"]], "a flow with entry.new_menu is a New menu item");
  let view = await flows.startRun(rep, { flow_id: "new_lead", source: { kind: "new_menu" } });
  assert.equal(view.step.id, "who");
  await assert.rejects(() => flows.advanceRun(rep, view.run.id, { step_id: "who", answers: {} }), /Name needs an answer/);
  await assert.rejects(() => flows.advanceRun(rep, view.run.id, { step_id: "who", answers: { name: "Ada", email: "nope" } }), /email address/);
  view = await flows.advanceRun(rep, view.run.id, { step_id: "who", answers: { name: "Ada Stone", phone: "555-010-2000", email: "ada@example.com", address: "4 Oak Ln" } });
  assert.ok(view.contact?.id && view.project?.id, "the contact and the lead were made");
  const lead = await storage.readDocument(ORG, "projects", String(view.project!.id));
  assert.deepEqual([(lead.data.lead_source as Record<string, unknown>).kind, (lead.data.lead_source as Record<string, unknown>).entered_by_user_id, lead.data.address], ["manual_lead", "u_rep", "4 Oak Ln"]);
  assert.equal((await listEventRecords(ORG, { project_id: lead.id, type: "lead.received" })).length, 1, "intake ran");
  await assert.rejects(() => flows.advanceRun(viewer, view.run.id, { step_id: "ask_need", answers: {} }), /belongs to someone else/, "a run is its player's");
  // One question per step.
  view = await flows.advanceRun(rep, view.run.id, { step_id: "ask_need", answers: { need: "repair" } });
  assert.equal(view.step.id, "ask_timeline");
  view = await flows.backRun(rep, view.run.id);
  assert.deepEqual([view.step.id, view.run.answers.need], ["ask_need", "repair"], "back keeps the answers");
  view = await flows.advanceRun(rep, view.run.id, { step_id: "ask_need", answers: { need: "repair" } });
  while (view.step.id !== "done") view = await flows.advanceRun(rep, view.run.id, { step_id: view.step.id, answers: {} });
  assert.equal((view.step.blocks as Array<{ kind: string; text?: string }>).find((block) => block.kind === "note")?.text, "Ada Stone is in your new leads.", "notes are filled from the run");
  view = await flows.advanceRun(rep, view.run.id, { step_id: "done", answers: {} });
  assert.equal(view.run.status, "done");

  // A second lead from the same phone attaches to the same contact.
  const again = await flows.startRun(rep, { flow_id: "new_lead" });
  const second = await flows.advanceRun(rep, again.run.id, { step_id: "who", answers: { name: "A. Stone", phone: "(555) 010-2000" } });
  assert.equal(second.contact?.id, view.contact?.id);
  assert.equal((await contacts.readContact(ORG, String(view.contact!.id))).name, "Ada Stone", "finding a contact never rewrites it");

  // The new-lead call: no answer sends the text it shows and ends as no answer; answered routes by the choice.
  const call = await flows.saveFlow(owner, { id: "new_lead_call", definition: newLeadFlow({ contact: "call", no_answer: ["text", "retry"], questions: SUGGESTED_QUESTIONS.filter((question) => ["need", "address"].includes(question.key)), board_id: "" }) });
  assert.equal(call.kind, "call");
  let run = await flows.startRun(rep, { flow_id: "new_lead_call", source: { kind: "crm", project_id: lead.id, contact_id: view.contact!.id } });
  assert.match(String((run.step.blocks[0] as { text?: string }).text), /Call Ada Stone at/);
  run = await flows.advanceRun(rep, run.run.id, { step_id: "dial", answers: { answered: "no" } });
  assert.equal(run.step.id, "no_answer");
  const text = run.step.blocks.find((block: { id: string }) => block.id === "no_answer_text") as { preview: string };
  assert.match(text.preview, /^Hi .*this is Sam with Flow Roofing/, "the person sees the text's words before it is sent");
  run = await flows.advanceRun(rep, run.run.id, { step_id: "no_answer", answers: { voicemail: "yes" } });
  assert.deepEqual([run.run.status, run.outcome?.id], ["done", "no_answer"]);
  await drainWorkEvents();
  assert.ok((await listEventRecords(ORG, { project_id: lead.id, type: "flow.step.completed" })).length === 1, "the step's actions went to the work engine");
  const todos = (await listNodeRecords(ORG, { project_id: lead.id, actionable: true } as never)).filter((node) => String(node.title) === "Try the lead again");
  assert.equal(todos.length, 1, "the call-back to-do was made by the engine");

  // Answered → questions saved to the project → not interested marks the lead lost.
  run = await flows.startRun(rep, { flow_id: "new_lead_call", source: { project_id: lead.id, contact_id: view.contact!.id } });
  run = await flows.advanceRun(rep, run.run.id, { step_id: "dial", answers: { answered: "yes" } });
  run = await flows.advanceRun(rep, run.run.id, { step_id: "greet", answers: {} });
  run = await flows.advanceRun(rep, run.run.id, { step_id: "ask_need", answers: { need: "replacement" } });
  run = await flows.advanceRun(rep, run.run.id, { step_id: "ask_address", answers: { address: "4 Oak Lane" } });
  assert.equal((await storage.readDocument(ORG, "projects", lead.id)).data.address, "4 Oak Lane", "saves_to wrote the project field");
  run = await flows.advanceRun(rep, run.run.id, { step_id: "next", answers: { result: "not_interested" } });
  assert.equal(run.outcome?.id, "not_interested");
  await drainWorkEvents();
  const { listPlanRecords } = await import("../work/storage.js");
  const sales = await listPlanRecords(ORG, { project_id: lead.id, sales: true });
  assert.ok((await storage.readDocument(ORG, "projects", lead.id)).data.lost_at || (sales.length && sales.every((plan) => plan.outcome === "lost")), "the outcome's effect marked the lead lost");

  // A preview plays a definition with nothing saved.
  const preview = flows.previewStep(newLeadFlow({ contact: "text", no_answer: [], questions: [] }), { step_id: "replied", answers: { replied: "not_yet" } });
  assert.deepEqual(preview.next, { to: "call_back", outcome: null });
});
