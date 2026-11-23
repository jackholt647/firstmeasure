import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import type { PlatformAuthContext } from "../platform/auth.js";

// The leads setup (docs/architecture/flows.md, "The leads setup"): how the company handles a new lead, made real.
test("the leads setup makes new leads arrive as new leads, saves the new-lead flow and the New menu", async (t) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "lead-setup-"));
  Object.assign(process.env, { NODE_ENV: "test", FIRSTMATE_ENV: "test", PLATFORM_STORAGE_ROOT: path.join(dir, "platform"), CRM_STORAGE_ROOT: path.join(dir, "crm"),
    PLATFORM_HEARTBEAT_DISABLED: "1", WORK_SCHEDULER_DISABLED: "1", FIRSTMEASURE_JOB_WORKERS: "0",
    FIRSTMEASURE_DATABASE_MODE: process.env.TEST_POSTGRES_URL ? "postgres" : "local", DATABASE_URL: process.env.TEST_POSTGRES_URL || "", POSTGRES_POOL_MAX: "4", POSTGRES_AUTO_MIGRATE: "false" });
  const storage = await import("../platform/storage.js");
  const setup = await import("../leads/setup.js");
  const { readIntakeRouting } = await import("../scopes/router.js");
  const { readAutomationRules } = await import("../work/rules.js");
  const { rawCapabilityValues } = await import("../platform/capabilities.js");
  const flows = await import("../flows/service.js");
  const { receiveLead } = await import("../leads/receive.js");
  const { listPlanRecords } = await import("../work/storage.js");
  t.after(async () => { await (await import("../platform/sql_store.js")).closeSqlStoresForTests(); await (await import("../src/database/postgres.js")).closePostgresPools(); await rm(dir, { recursive: true, force: true }); });
  const ORG = "org_lead_setup";
  await storage.createOrganization({ id: ORG, name: "Setup Roofing" });
  await (await import("./helpers/platform-fixture.js")).enableExpandedPlatformFixture(ORG);
  const auth = { orgId: ORG, userId: "u_owner", role: "member", branchId: "default", permissions: { manage_company_settings: true, manage_projects: true, view_projects: true },
    user: { first_name: "Jo" }, organization: { name: "Setup Roofing" }, appEntitlements: [] } as unknown as PlatformAuthContext;
  const ctx = { organizationId: ORG, auth, branchId: "default" } as never;
  const rep = { ...auth, userId: "u_rep", permissions: { manage_projects: true, view_projects: true } } as unknown as PlatformAuthContext;

  let status = await setup.leadSetupStatus(ctx);
  assert.deepEqual(status.answered, { sources: false, contact: false, no_answer: false, questions: false, script: false, new_menu: false });
  assert.equal(status.flow?.kind, "call", "unanswered, the flow is the call script");
  await assert.rejects(() => setup.saveLeadSetup({ ...ctx, auth: rep } as never, { part: "contact", method: "call" }), /Company settings/);

  status = await setup.saveLeadSetup(ctx, { part: "sources", sources: ["email", "website"] });
  assert.ok(status.sources.lead_inbox.on && status.sources.lead_inbox.address.includes("@"), "the lead inbox is on with its address");

  status = await setup.saveLeadSetup(ctx, { part: "contact", method: "call" });
  assert.equal((await readIntakeRouting(ORG, "default")).default_entry, "unscoped", "new leads arrive as new leads");
  status = await setup.saveLeadSetup(ctx, { part: "no_answer", actions: ["text", "email"] });
  status = await setup.saveLeadSetup(ctx, { part: "questions", questions: [{ key: "need", label: "What do you need?", input: "text" }] });
  const blocks = status.flow!.steps.flatMap((step) => step.blocks.map((block) => block.id));
  assert.ok(blocks.includes("no_answer_text") && blocks.includes("no_answer_email") && !blocks.includes("no_answer_retry"), "the no-answer step has what they chose");
  assert.equal(status.answered.script, false);

  status = await setup.saveLeadSetup(ctx, { part: "script" });
  assert.equal((await flows.readFlow(ORG, setup.NEW_LEAD_FLOW_ID)).kind, "call");
  const queue = (await readAutomationRules(ORG, "default")).rules.find((rule) => rule.id === "platform_queue_new_lead_calls")!;
  assert.equal(((queue.input as Record<string, any>).list.metadata).flow_id, setup.NEW_LEAD_FLOW_ID, "the New Leads call list plays the new-lead flow");

  // A lead from outside now waits as a new lead: no scope starts.
  const lead = await receiveLead(ORG, { source: { kind: "web_form" }, address: "2 Bay Rd", contacts: [{ name: "Bo", phone: "555-030-1000" }] });
  assert.equal((await listPlanRecords(ORG, { project_id: lead.project.id })).length, 0);

  status = await setup.saveLeadSetup(ctx, { part: "new_menu", items: ["lead", "project", "contact", "report"] });
  const values = await rawCapabilityValues(ORG);
  assert.deepEqual([values["platform.new_button_mode"], values["platform.new_button_items"]], ["selector", `flow:${setup.MANUAL_LEAD_FLOW_ID},project,contact,report`]);
  assert.deepEqual((await flows.newMenuFlows(rep)).map((flow) => flow.id), [setup.MANUAL_LEAD_FLOW_ID]);
  assert.ok(Object.values(status.answered).every(Boolean), "every part is answered");

  // Turning New › Lead off keeps the flow but takes it out of the menu; treating leads like projects puts them on the board.
  await setup.saveLeadSetup(ctx, { part: "new_menu", items: ["project", "contact"] });
  assert.deepEqual(await flows.newMenuFlows(rep), []);
  await setup.saveLeadSetup(ctx, { part: "contact", method: "none" });
  assert.equal((await readIntakeRouting(ORG, "default")).default_entry, "scope");
});
