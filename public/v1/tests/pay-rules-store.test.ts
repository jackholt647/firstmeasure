import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

// Runs on SQLite by default and on PostgreSQL through tests/run-embedded-postgres.mjs, which sets TEST_POSTGRES_URL.
test("pay rule definitions, results and evidence are stored the same on both database backends", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "pay-rules-store-"));
  const url = process.env.TEST_POSTGRES_URL;
  Object.assign(process.env, { FIRSTMATE_ENV: "test", PLATFORM_STORAGE_ROOT: root,
    FIRSTMEASURE_DATABASE_MODE: url ? "postgres" : "local", DATABASE_URL: url || "", POSTGRES_POOL_MAX: "1", POSTGRES_AUTO_MIGRATE: "false" });
  const store = await import("../payroll/storage.js");
  const rules = await import("../payroll/pay-rules.js");
  const engine = await import("../payroll/pay-refresh.js");
  const database = await import("../src/database/postgres.js");
  t.after(async () => { await (await import("../platform/sql_store.js")).closeSqlStoresForTests(); await database.closePostgresPools(); await rm(root, { recursive: true, force: true }); });
  const org = `pay_rules_${randomUUID()}`, other = `pay_rules_${randomUUID()}`;
  const actor = { userId: "owner" };
  const definition = { grain: "period" as const, period: "month" as const, always: true, kind: "salary" as const, inputs: {}, parameters: { monthly_cents: {} }, code: "return params.monthly_cents;" };

  const first = await rules.savePayRule(org, { id: "salary", name: "Salary", effective_from: "2026-01-01", definition }, actor);
  assert.equal(first.revision, 1);
  const second = await rules.savePayRule(org, { id: "salary", name: "Salary", effective_from: "2026-06-01", definition: { ...definition, code: "return params.monthly_cents + 1;" }, expected_revision: 1 }, actor);
  assert.deepEqual([second.revision, second.versions.map((version) => version.effective_from)], [2, ["2026-01-01", "2026-06-01"]]);
  await assert.rejects(() => rules.savePayRule(org, { id: "salary", name: "Salary", definition, expected_revision: 1 }, actor), /changed elsewhere/);
  // Saving the same effective date again replaces that version and keeps the rest.
  const replaced = await rules.savePayRule(org, { id: "salary", name: "Salary pay", effective_from: "2026-06-01", definition }, actor);
  assert.deepEqual([replaced.name, replaced.versions.length, replaced.versions[1]!.definition.code], ["Salary pay", 2, "return params.monthly_cents;"]);
  const plan = await rules.savePayPlan(org, { id: "office", name: "Office", effective_from: "2026-01-01", rules: [{ rule_id: "salary", params: { monthly_cents: 400_000 } }] }, actor);
  assert.equal(plan.versions[0]!.rules[0]!.params!.monthly_cents, 400_000);
  await assert.rejects(() => rules.savePayPlan(org, { name: "Broken", rules: [{ rule_id: "missing" }] }, actor), /does not exist/);
  assert.deepEqual((await rules.listPayRules(org)).map((rule) => rule.id), ["salary"]);
  assert.deepEqual(await rules.listPayRules(other), [], "definitions belong to their organization");
  assert.equal((await rules.archivePayRule(org, { id: "salary" })).status, "archived");
  await assert.rejects(() => rules.readPayRule(other, "salary"), /does not exist/);

  const payee = { type: "organization_user" as const, id: "ana" };
  const unit = { key: "2026-04-01", digest: "d1", status: "ok", earned_at: "2026-04-30T12:00:00.000Z", version: "v1", error: "",
    lines: [{ key: "main", amount_cents: 400_000, description: "Salary" }], evidence: [["shifts", "s1", "3"], ["shifts", "s1", "3"], ["shifts", "s2", "1"]] as [string, string, string][] };
  await engine.saveUnit(org, payee, "salary", unit);
  await engine.saveUnit(org, payee, "salary", { ...unit, digest: "d2", lines: [{ key: "main", amount_cents: 410_000, description: "Salary" }], evidence: [["shifts", "s2", "2"]] });
  await engine.saveUnit(org, payee, "salary", { ...unit, key: "2026-05-01", earned_at: "2026-05-31T12:00:00.000Z", status: "error", error: "No rate", lines: [] });
  assert.deepEqual((await engine.storedUnits(org, payee)).map((entry) => [entry.unit_key, entry.digest, entry.status, entry.lines[0]?.amount_cents]).sort(), [["2026-04-01", "d2", "ok", 410_000], ["2026-05-01", "d1", "error", undefined]]);
  assert.deepEqual((await engine.listPayUnits(org, payee)).map((entry) => [entry.unit, entry.status, entry.error]), [["2026-05-01", "error", "No rate"], ["2026-04-01", "ok", ""]], "newest earned first");
  assert.deepEqual(await engine.storedUnits(org, { type: "organization_user", id: "ben" }), []);
  const evidence = await store.getPayrollDatabase().prepare("SELECT source, row_key, row_revision FROM pay_rule_evidence WHERE organization_id=? AND unit_key=? ORDER BY row_key").all(org, "2026-04-01");
  assert.deepEqual(evidence.map((row) => [row.source, row.row_key, row.row_revision]), [["shifts", "s2", "2"]], "a unit's evidence is replaced with what it last read");
});
