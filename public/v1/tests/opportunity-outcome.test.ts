import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

// docs/architecture/opportunities.md: an opportunity is a sales work plan; its outcome is set only by actions.
test("opportunities are sales plans whose outcome the scope decides", async (t) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "opportunity-outcome-"));
  Object.assign(process.env, { NODE_ENV: "test", FIRSTMATE_ENV: "test", PLATFORM_STORAGE_ROOT: path.join(dir, "platform"), CRM_STORAGE_ROOT: path.join(dir, "crm"),
    PLATFORM_HEARTBEAT_DISABLED: "1", WORK_SCHEDULER_DISABLED: "1", FIRSTMEASURE_JOB_WORKERS: "0",
    // Runs on SQLite by default and on PostgreSQL through tests/run-embedded-postgres.mjs, which sets TEST_POSTGRES_URL.
    FIRSTMEASURE_DATABASE_MODE: process.env.TEST_POSTGRES_URL ? "postgres" : "local", DATABASE_URL: process.env.TEST_POSTGRES_URL || "", POSTGRES_POOL_MAX: "4", POSTGRES_AUTO_MIGRATE: "false" });
  const storage = await import("../platform/storage.js");
  const categories = await import("../scopes/categories.js");
  const { ensurePipelinePlanForProject, saveIntakeRouting, readIntakeRouting } = await import("../scopes/router.js");
  const { instantiateScopeTemplateWorkPlan } = await import("../scopes/service.js");
  const { readScopeTemplate, saveScopeTemplate } = await import("../scopes/storage.js");
  const { setOpportunityOutcome } = await import("../work/opportunities.js");
  const { listPlanRecords } = await import("../work/storage.js");
  t.after(async () => { await (await import("../platform/sql_store.js")).closeSqlStoresForTests(); await (await import("../src/database/postgres.js")).closePostgresPools(); await rm(dir, { recursive: true, force: true }); });
  const ORG = "org_opportunities";
  await storage.createOrganization({ id: ORG, name: "Opportunities" });
  await (await import("./helpers/platform-fixture.js")).enableExpandedPlatformFixture(ORG);

  // The catalog: sales is built in and cannot be removed or disabled; the rest is the organization's.
  assert.deepEqual((await categories.readScopeCategories(ORG)).categories.map(c => [c.id, c.builtin]), [["sales", true], ["production", false]]);
  const saved = await categories.saveScopeCategories(ORG, { categories: [{ id: "sales", label: "Selling", enabled: false }, { id: "service", label: "Service" }] });
  assert.deepEqual(saved.categories.map(c => [c.id, c.label, c.enabled]), [["sales", "Selling", true], ["service", "Service", true]]);
  assert.deepEqual((await categories.saveScopeCategories(ORG, { categories: [{ id: "service", label: "Service" }] })).categories.map(c => c.id), ["sales", "service"]);
  assert.deepEqual(categories.templateCategoryIds({ kind: "pipeline" }), ["sales"], "an older definition's kind is read as a category");

  // Presets carry categories, and saving a template only accepts catalog categories.
  const pipeline = await readScopeTemplate(ORG, "default", "sales_pipeline");
  assert.deepEqual([(pipeline.definition as Record<string, unknown>).category_ids, "kind" in (pipeline.definition as object)], [["sales"], false]);
  const roofing = await readScopeTemplate(ORG, "default", "roof_replacement");
  await assert.rejects(() => saveScopeTemplate(ORG, "default", { ...(roofing.definition as Record<string, unknown>), category_ids: ["made_up"], expected_version: roofing.version }), /scope categories from the catalog/);

  // A project's entry sales scope is an opportunity, open until an action says otherwise.
  await storage.upsertDocument(ORG, "projects", { id: "p1", data: { title: "Roof", contacts: [{ name: "Ivy", phone: "555-030-1000" }] } });
  await ensurePipelinePlanForProject(ORG, { id: "p1", ...(await storage.readDocument(ORG, "projects", "p1")).data });
  const [plan] = await listPlanRecords(ORG, { project_id: "p1", sales: true });
  assert.deepEqual([plan?.sales, plan?.outcome], [true, "open"]);
  assert.deepEqual(((await storage.readDocument(ORG, "projects", "p1")).data.lifecycle as Record<string, unknown>).opportunities, { open: 1, won: 0, lost: 0, unresolved: 0, won_at: "", lost_at: "" });

  // The organization may limit open opportunities per project; by default there is no limit.
  const second = await readScopeTemplate(ORG, "default", "roofing_sales_appointment");
  assert.equal((await readIntakeRouting(ORG, "default")).max_open_opportunities, 0);
  await saveIntakeRouting(ORG, "default", { ...(await readIntakeRouting(ORG, "default")), max_open_opportunities: 1 });
  await assert.rejects(() => instantiateScopeTemplateWorkPlan(ORG, { project_id: "p1", template: second }), /already has 1 open opportunity/);
  await saveIntakeRouting(ORG, "default", { ...(await readIntakeRouting(ORG, "default")), max_open_opportunities: 0 });
  await instantiateScopeTemplateWorkPlan(ORG, { project_id: "p1", template: second });
  assert.equal((await listPlanRecords(ORG, { project_id: "p1", sales: true })).filter(p => p.outcome === "open").length, 2);

  // Won: the sold date is the first win; the plan keeps running to its own end.
  await setOpportunityOutcome(ORG, { plan_id: String(plan!.id), outcome: "won", reason: "Signed" });
  const won = (await storage.readDocument(ORG, "projects", "p1")).data.lifecycle as Record<string, unknown>;
  assert.ok(String(won.sold_at));
  assert.deepEqual([(won.opportunities as Record<string, number>).won, (won.opportunities as Record<string, number>).open, won.status], [1, 1, "open"]);
  assert.equal((await listPlanRecords(ORG, { project_id: "p1" })).find(p => p.id === plan!.id)?.status, "active");

  // Lost without a plan id stops every open opportunity; the won one is untouched.
  const lost = await setOpportunityOutcome(ORG, { project_id: "p1", outcome: "lost", reason: "Went with a competitor" });
  assert.equal(lost.plans.length, 1);
  const plans = await listPlanRecords(ORG, { project_id: "p1", sales: true });
  assert.deepEqual(plans.map(p => [p.outcome, p.status]).sort(), [["lost", "canceled"], ["won", "active"]]);
  await assert.rejects(() => setOpportunityOutcome(ORG, { plan_id: String(plans.find(p => p.outcome === "lost")!.id), outcome: "open" }), /start the sales scope again/);

  // Reopen takes back a win; a project whose only opportunity is lost is lost.
  await setOpportunityOutcome(ORG, { project_id: "p1", outcome: "open", reason: "Customer cancelled" });
  await setOpportunityOutcome(ORG, { project_id: "p1", outcome: "lost" });
  const after = (await storage.readDocument(ORG, "projects", "p1")).data.lifecycle as Record<string, unknown>;
  assert.deepEqual([after.status, after.sold_at], ["lost", ""]);

  // A project with no sales scope can still be marked sold (a production-only flow).
  await storage.upsertDocument(ORG, "projects", { id: "p2", data: { title: "Repair" } });
  await setOpportunityOutcome(ORG, { project_id: "p2", outcome: "won" });
  assert.ok(String(((await storage.readDocument(ORG, "projects", "p2")).data.lifecycle as Record<string, unknown>).sold_at));
});
