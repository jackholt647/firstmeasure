import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

// The Automations Hub setup (GP-110, docs/architecture/automations-hub.md): where new leads go and which lanes that
// board sits in, written to intake routing and the board's categories through `automations.setup.apply`.
test("the automations setup sends new leads to one board and places it in the lanes", async (t) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "automations-setup-"));
  Object.assign(process.env, { NODE_ENV: "test", FIRSTMATE_ENV: "test", PLATFORM_STORAGE_ROOT: path.join(dir, "platform"), CRM_STORAGE_ROOT: path.join(dir, "crm"),
    PLATFORM_HEARTBEAT_DISABLED: "1", WORK_SCHEDULER_DISABLED: "1", FIRSTMEASURE_JOB_WORKERS: "0",
    FIRSTMEASURE_DATABASE_MODE: process.env.TEST_POSTGRES_URL ? "postgres" : "local", DATABASE_URL: process.env.TEST_POSTGRES_URL || "", POSTGRES_POOL_MAX: "4", POSTGRES_AUTO_MIGRATE: "false" });
  const storage = await import("../platform/storage.js");
  const { applyAutomationsSetup, setupCategoryIds } = await import("../scopes/flow-setup.js");
  const { readIntakeRouting, saveIntakeRouting, resolveIntakeEntry } = await import("../scopes/router.js");
  const { readScopeTemplate } = await import("../scopes/storage.js");
  const { readScopeCategories, saveScopeCategories, templateCategoryIds } = await import("../scopes/categories.js");
  const { receiveLead } = await import("../leads/receive.js");
  const { listPlanRecords } = await import("../work/storage.js");
  t.after(async () => { await (await import("../platform/sql_store.js")).closeSqlStoresForTests(); await (await import("../src/database/postgres.js")).closePostgresPools(); await rm(dir, { recursive: true, force: true }); });
  const ORG = "org_automations_setup";
  await storage.createOrganization({ id: ORG, name: "Automations setup" });
  await (await import("./helpers/platform-fixture.js")).enableExpandedPlatformFixture(ORG);

  assert.deepEqual(setupCategoryIds(["production", "storm"], true), ["sales", "production", "storm"], "other categories stay");
  assert.deepEqual(setupCategoryIds(["sales", "production"], false), ["sales"]);

  // A rule the organization made is kept; the default (what no rule catches) becomes the board.
  const before = await readIntakeRouting(ORG, "default");
  await saveIntakeRouting(ORG, "default", { expected_revision: before.revision, data: { ...before, routing_mode: "formula", rules: [{ id: "chat", title: "Chats", entry: "unscoped", formula: { match: "all", conditions: [{ field: "lead_source.kind", operator: "in", value: "live_chat" }] } }] } });
  // An organization that turned Production off gets it back for the lane.
  const catalog = await readScopeCategories(ORG);
  await saveScopeCategories(ORG, { categories: catalog.categories.map((category) => category.id === "production" ? { ...category, enabled: false } : category) });

  const one = await applyAutomationsSetup(ORG, { entry_template_id: "roof_replacement", one_board: true }, "user_owner");
  assert.deepEqual([one.entry_template_id, one.category_ids, one.template_changed], ["roof_replacement", ["sales", "production"], true]);
  assert.deepEqual(templateCategoryIds((await readScopeTemplate(ORG, "default", "roof_replacement")).definition), ["sales", "production"], "the board spans both lanes");
  assert.equal((await readScopeCategories(ORG)).categories.find((category) => category.id === "production")?.enabled, true);
  const routing = await readIntakeRouting(ORG, "default");
  assert.deepEqual([routing.default_entry, routing.default_template_id, routing.rules.map((rule) => rule.id)], ["scope", "roof_replacement", ["chat"]]);
  assert.deepEqual(resolveIntakeEntry(routing, { lead_source: { kind: "web_form" } }), { entry: "scope", template_id: "roof_replacement" });
  assert.deepEqual(resolveIntakeEntry(routing, { lead_source: { kind: "live_chat" } }), { entry: "unscoped" });

  // A new lead goes straight onto that board, and it is an opportunity (a sales plan).
  await receiveLead(ORG, { project_id: "lead_roof", source: { kind: "web_form" }, address: "4 Elm St", notification: false });
  const plans = await listPlanRecords(ORG, { project_id: "lead_roof" });
  assert.equal(plans.length, 1);
  assert.equal((await listPlanRecords(ORG, { project_id: "lead_roof", sales: true })).length, 1, "a board in the Sales lane makes its projects opportunities");

  // Splitting it again: the board is the sales part only. Saving the same answer twice changes nothing.
  const two = await applyAutomationsSetup(ORG, { entry_template_id: "roof_replacement", one_board: false }, "user_owner");
  assert.deepEqual([two.category_ids, two.template_changed], [["sales"], true]);
  const again = await applyAutomationsSetup(ORG, { entry_template_id: "roof_replacement", one_board: false }, "user_owner");
  assert.equal(again.template_changed, false);

  await assert.rejects(() => applyAutomationsSetup(ORG, { entry_template_id: "no_such_board", one_board: true }, "user_owner"), /turned on/);
});
