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

  // Split rules are their own kind of definition in the same table, with versions like a rule.
  const split = { inputs: {}, parameters: {}, code: "return {};" };
  await rules.savePaySplitRule(org, { id: "salary", name: "Whole team", effective_from: "2026-01-01", definition: split }, actor);
  const resplit = await rules.savePaySplitRule(org, { id: "salary", name: "Whole team", effective_from: "2026-06-01", definition: { ...split, code: "return null;" }, expected_revision: 1 }, actor);
  assert.deepEqual([resplit.revision, resplit.versions.length, (await rules.listPaySplitRules(org)).length, (await rules.listPayRules(org)).length, (await rules.listPaySplitRules(other)).length], [2, 2, 1, 1, 0], "a split rule and a pay rule may share an id");
  assert.equal((await rules.archivePaySplitRule(org, { id: "salary" })).status, "archived");
  const team = { type: "resource_group" as const, id: "team" };
  const shares = [{ id: "ana", weight: 3, reason: "Six hours" }, { id: "ben", weight: 1 }, { id: "cara", weight: 0, reason: "Off" }];
  await engine.saveUnit(org, team, "job", { key: "j1", digest: "d1", status: "ok", earned_at: "2026-04-30T12:00:00.000Z", version: "v1", error: "", evidence: [["jobs", "j1", "1"], ["split:shifts", "s1", "2"]],
    lines: [{ key: "main", amount_cents: 1001, description: "Job" }],
    allocation: { basis: "b1", method: "rule", members: shares.map((share) => ({ id: share.id, weight: 1 })), rule: { id: "salary", version: "v1", params: { minimum: 1 }, lines: { main: shares } } } });
  const explained = (await engine.listPayUnits(org, team))[0]!.split!;
  assert.deepEqual([explained.method, explained.split_rule_id, explained.params, explained.members], ["rule", "salary", { minimum: 1 }, ["ana", "ben", "cara"]]);
  assert.deepEqual(explained.lines.main, { amount_cents: 1001, total_weight: 4, shares: [{ ...shares[0], cents: 751 }, { ...shares[1], cents: 250 }, { ...shares[2], cents: 0 }] });
  assert.deepEqual((await engine.storedUnits(org, team))[0]!.allocation!.rule!.lines.main, shares);

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

  // Which defaults covered a payee, and from when to when, is kept by payroll: roles have no history of their own.
  const organization = { type: "organization" as const, id: org }, sales = { type: "role" as const, id: "sales" }, lead = { type: "role" as const, id: "lead" };
  const spans = async (current: { type: "organization" | "role"; id: string }[], day: string, record = true) => (await rules.notePayCoverage(org, payee, current, { day, record })).map((span) => [span.subject.id, span.from, span.through]);
  assert.deepEqual(await spans([organization, sales], "2026-06-10", false), [[org, "", ""], ["sales", "", ""]], "looking does not remember");
  assert.deepEqual(await spans([organization, sales, lead], "2026-06-10"), [[org, "", ""], ["lead", "", ""], ["sales", "", ""]], "the first time, everything is taken to have always covered them");
  assert.deepEqual(await spans([organization, sales], "2026-07-01", false), [[org, "", ""], ["lead", "", "2026-06-30"], ["sales", "", ""]], "a reader sees a role taken away end the day before, without writing");
  assert.deepEqual(await spans([organization, sales], "2026-07-01"), [[org, "", ""], ["lead", "", "2026-06-30"], ["sales", "", ""]]);
  assert.deepEqual(await spans([organization, sales, lead], "2026-09-01"), [[org, "", ""], ["lead", "", "2026-06-30"], ["lead", "2026-09-01", ""], ["sales", "", ""]], "given back, it covers them from the day it was noticed");
  assert.deepEqual(await spans([], "2026-10-01"), [[org, "", ""], ["lead", "", "2026-06-30"], ["lead", "2026-09-01", ""], ["sales", "", ""]], "a payee with no record ends nothing");
  assert.deepEqual(await rules.notePayCoverage(other, payee, [], { day: "2026-10-01", record: true }), []);

  // Schedule choices are stored on a default like its entries, and resolve for a payee nothing else is known about.
  const weekly = await store.createPayrollSchedule(org, { name: "Weekly", recurrence: { frequency: "weekly", weekday: 5 } });
  const monthly = await store.createPayrollSchedule(org, { name: "Monthly", recurrence: { frequency: "monthly", day: 1 }, clawback_cap_percent: 40 });
  const saved = await rules.savePayDefault(org, { subject: organization, entries: [], schedules: [
    { effective_from: "2026-01-01", schedule_id: weekly.id }, { effective_from: "2026-03-01", earning_kind: "commission", schedule_id: monthly.id, timing_basis: "completed", clawback_cap_percent: 10 }] }, actor);
  assert.deepEqual(saved.schedules!.map((choice) => [choice.earning_kind, choice.schedule_id, choice.entered_by]), [["*", weekly.id, "owner"], ["commission", monthly.id, "owner"]]);
  const stranger = { type: "organization_connection" as const, id: "someone_new" };
  const on = async (kind: string, date: string) => { const found = await rules.resolvePaySchedule(org, stranger, kind, date); return found && [found.schedule.name, found.earning_kind, found.timing_basis, found.clawback_cap_percent]; };
  assert.deepEqual(await on("commission", "2026-02-15"), ["Weekly", "*", "", null], "the commission choice had not started");
  assert.deepEqual(await on("commission", "2026-03-15"), ["Monthly", "commission", "completed", 10]);
  assert.deepEqual(await on("hourly", "2026-03-15"), ["Weekly", "*", "", null]);
  assert.deepEqual(await on("hourly", "2025-12-15"), ["Weekly", "*", "", null], "work from before any schedule was chosen is paid by today's choice");
  assert.equal(await rules.resolvePaySchedule(other, stranger, "hourly", "2026-03-15"), null);
  assert.equal((await rules.savePayDefault(org, { subject: organization, entries: [], expected_revision: saved.revision }, actor)).schedules!.length, 2, "left out, the choices are kept");

  // The retired policy table is dropped when the payroll schema is next initialized. On PostgreSQL that only happens when the store's schema version is raised.
  const db = store.getPayrollDatabase();
  await db.exec("CREATE TABLE payroll_policies (organization_id TEXT NOT NULL)");
  if (url) await db.prepare("UPDATE platform_sql_schemas SET schema_version=? WHERE store_id=?").run(3, "payroll");
  await store.closePayrollDatabase();
  assert.equal((await store.listPayrollSchedules(org)).length, 2, "everything else is still there after the schema is initialized again");
  await assert.rejects(async () => store.getPayrollDatabase().prepare("SELECT COUNT(*) AS n FROM payroll_policies").get(), "the policy table is gone");
});
