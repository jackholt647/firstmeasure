import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const ORG = "org_pay_sources";

test("the sample pay rules price the real time clock, projects and labor commitments through published selections", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "pay-sources-"));
  Object.assign(process.env, { NODE_ENV: "test", FIRSTMATE_ENV: "test", PLATFORM_STORAGE_ROOT: root, FIRSTMEASURE_DATABASE_MODE: "local", FIRSTMEASURE_INDEX_DB_PATH: path.join(root, "index.sqlite") });
  const core = await import("../platform/storage.js");
  const store = await import("../payroll/storage.js");
  const rules = await import("../payroll/pay-rules.js");
  const engine = await import("../payroll/pay-refresh.js");
  const { seedSamplePayRules, SAMPLE_PAY_RULES } = await import("../payroll/sample-pay-rules.js");
  const { assigneeKeysOf } = await import("../payroll/pay-sources.js");
  const { saveCapabilityValues } = await import("../platform/capabilities.js");
  const { userPublicationContext } = await import("../platform/publication/context.js");
  const { describeDataProvider } = await import("../platform/publication/providers.js");
  const { selectPublishedData, selectionSupport } = await import("../platform/publication/select.js");
  const { invokeAction } = await import("../platform/publication/actions.js");
  const { readPublishedData } = await import("../platform/publication/providers.js");
  try {
    await core.createOrganization({ id: ORG, name: "Pay sources" });
    await saveCapabilityValues(ORG, { "platform.expanded_access": true, "apps.payroll": true });
    for (const [id, name] of [["ana", "Ana"], ["ben", "Ben"], ["owner", "Owner"]]) await core.upsertDocument(ORG, "users", { id, data: { name, status: "active", worker_classification: "employee" } });
    const workforce = await import("../workforce/storage.js");
    const crew = (await workforce.createResourceGroup(ORG, { name: "Install team", kind_id: "crew" })).id as string;
    const schedule = await store.createPayrollSchedule(ORG, { name: "Weekly", recurrence: { frequency: "weekly", weekday: 5 }, timezone: "UTC" });
    await store.savePayrollPolicy(ORG, "organization", ORG, { schedule_id: schedule.id });
    (await import("../platform/publication/bootstrap.js")).initializePublication();
    const auth: any = { orgId: ORG, userId: "owner", role: "member", permissions: { manage_payroll: true }, applicationAccess: { management: { enabled: true, permissions: { "*": true } } }, capabilities: { effectiveByKey: { "apps.payroll": true } } };
    const context = userPublicationContext(auth), command = userPublicationContext(auth, { mode: "command" });
    const target = { scope: "organization" as const, organizationId: ORG };
    const source = (name: string, args?: Record<string, unknown>) => ({ provider: "payroll", export: name, target, ...(args ? { args } : {}) });

    // ---- The published sources ----
    const user = (id: string) => ({ subject_type: "organization_user", subject_id: id });
    assert.deepEqual(assigneeKeysOf({ assignments: { estimator: user("ana"), team: [user("ben"), { subject_type: "resource_group", subject_id: "g1" }] }, notes: "x", size: { squares: 30 } }),
      { assignments: { estimator: ["organization_user:ana"], team: ["organization_user:ben", "resource_group:g1"] } });
    await core.upsertDocument(ORG, "projects", { id: "p1", data: { title: "Maple St", custom_field_values: { assignments: { estimator: user("ana"), inside_salesperson: user("ben") } } } });
    await core.upsertDocument(ORG, "projects", { id: "p2", data: { title: "Oak Ave", custom_field_values: { assignments: { estimator: user("ana") } } } });
    const mine = await selectPublishedData(context, source("project_records"), { where: { rules: [{ field: "assignee_keys.assignments.inside_salesperson", operator: "contains", value: "organization_user:ben" }] } });
    assert.equal(mine.status, "ready");
    if (mine.status !== "ready") throw Error("expected rows");
    assert.deepEqual(mine.rows.map((row) => [row.key, row.value.title]), [["p1", "Maple St"]]);
    // Sold dates and money come from the project index. Until it has been built that reading is pending, never empty.
    const pending = await selectPublishedData(context, source("project_records", { facts: true }), {});
    assert.deepEqual([pending.status, (pending as any).code], ["pending", "project_facts_pending"]);

    const stats = (await import("../stats/storage.js")).getStatsDatabase();
    const now = new Date().toISOString();
    await stats.prepare("INSERT INTO stats_sync_state (organization_id, backfill_done, created_at, updated_at) VALUES (?, 1, ?, ?)").run(ORG, now, now);
    const fact = (id: string, sold: string | null, completed: string | null, contract: number) => stats.prepare(`INSERT INTO stats_projects
      (organization_id, project_id, title, sold_at, completed_at, contract_cents, computed_at) VALUES (?, ?, ?, ?, ?, ?, ?)`).run(ORG, id, id, sold, completed, contract, now);
    await fact("p1", "2026-06-02T15:00:00.000Z", null, 2_000_000);
    await fact("p2", "2026-06-03T15:00:00.000Z", "2026-06-20T15:00:00.000Z", 1_000_000);
    const withFacts = await selectPublishedData(context, source("project_records", { facts: true }), { period: { field: "completed_at", from: "2026-06-01" } });
    if (withFacts.status !== "ready") throw Error(`expected rows: ${JSON.stringify(withFacts)}`);
    assert.deepEqual(withFacts.rows.map((row) => [row.key, row.value.contract_cents, row.value.sold_at]), [["p2", 1_000_000, "2026-06-03T15:00:00.000Z"]]);

    const { listClosedCrewTimeShifts } = await import("../workforce/crew_storage.js");
    await listClosedCrewTimeShifts(ORG, { limit: 1 });
    const shift = (id: string, userId: string, out: string, hours: number, status: string, state = "closed") => workforce.getWorkforceDatabase().prepare(`INSERT INTO crew_time_shifts
      (id, organization_id, user_id, status, clocked_in_at, clocked_out_at, break_seconds, metadata_json, revision, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, 0, ?, 1, ?, ?)`)
      .run(id, ORG, userId, state, new Date(Date.parse(out) - hours * 3_600_000).toISOString(), state === "closed" ? out : null, JSON.stringify({ project_id: "p1", timesheet: { status } }), now, now);
    await shift("shift_1", "ben", "2026-06-02T22:00:00.000Z", 8, "approved");
    await shift("shift_2", "ben", "2026-06-03T22:00:00.000Z", 8, "approved");
    await shift("shift_3", "ben", "2026-06-04T22:00:00.000Z", 8, "pending");
    await shift("shift_4", "ana", "2026-06-04T22:00:00.000Z", 8, "approved");
    await shift("shift_5", "ben", "2026-06-05T22:00:00.000Z", 3, "pending", "active");
    const shifts = await selectPublishedData(context, source("time_shifts"), { where: { rules: [{ field: "assignee_key", operator: "equals", value: "organization_user:ben" }] }, orderBy: { field: "clocked_out_at" } });
    if (shifts.status !== "ready") throw Error(`expected rows: ${JSON.stringify(shifts)}`);
    assert.deepEqual(shifts.rows.map((row) => [row.key, row.value.worked_seconds, row.value.approval_status, row.value.project_id]),
      [["shift_1", 28_800, "approved", "p1"], ["shift_2", 28_800, "approved", "p1"], ["shift_3", 28_800, "pending", "p1"]], "a shift still on the clock is not published");

    const commitment = (id: string, status: string, total: number, unpriced = 0) => core.upsertDocument(ORG, "labor_commitments", { id, data: {
      list_id: `list_${id}`, project_id: "p1", revision: 1, status, unit: null, assignee: { type: "resource_group", id: crew, name: "Install team" }, lines: [], total_cents: total, unpriced_lines: unpriced,
      pay_sheets: [], schedule: null, note: "", list_revision: 1, content_hash: id, idempotency_key: "", committed_by_user_id: "owner", committed_at: "2026-06-01T12:00:00.000Z",
      delivery: { method: "share", status: "delivered", detail: "", steps: [] }, ...(status === "released" ? { released_at: "2026-06-10T12:00:00.000Z", release_reason: "Finished" } : {})
    } });
    await commitment("c1", "released", 250_000);
    await commitment("c2", "committed", 90_000);
    await commitment("c3", "released", 40_000, 2);
    const provider = describeDataProvider("payroll")!;
    for (const name of ["time_shifts", "project_records", "labor_commitments"]) assert.equal(selectionSupport({ provider: "payroll", export: name }).selectable, true, name);
    assert.deepEqual(provider.exports.time_shifts!.access.permissions, ["manage_payroll|manage_company_settings"]);
    const denied = userPublicationContext({ ...auth, permissions: {} });
    assert.equal((await selectPublishedData(denied, source("labor_commitments"), {})).status, "denied");

    // ---- The starting library, assigned through plans and one personal override ----
    await seedSamplePayRules(ORG, { userId: "owner" });
    await seedSamplePayRules(ORG, { userId: "owner" });
    assert.equal((await rules.listPayRules(ORG)).length, SAMPLE_PAY_RULES.length, "seeding again adds nothing");
    const save = (payee: { type: string; id: string }, entries: unknown[]) => invokeAction(command, { action: "payroll.paySetup.save", target }, { payee, entries }, { idempotencyKey: `setup:${payee.id}:${entries.length}` });
    const ben = { type: "organization_user" as const, id: "ben" }, ana = { type: "organization_user" as const, id: "ana" }, team = { type: "resource_group" as const, id: crew };
    await save(ben, [{ kind: "plan", plan_id: "hourly_staff", effective_from: "2026-01-01" }, { kind: "plan", plan_id: "inside_sales", effective_from: "2026-01-01" }]);
    await save(ana, [{ kind: "plan", plan_id: "estimator", effective_from: "2026-01-01" }]);
    await save(team, [{ kind: "plan", plan_id: "labor_by_commitment", effective_from: "2026-01-01" }]);
    const asOf = "2026-06-30T12:00:00.000Z";
    const first = await engine.refreshOrganizationEarnings(ORG, { context, asOf });
    const total = async (id: string, kind: string) => (await store.listPayrollLedgerEntries(ORG, { limit: 500 })).filter((entry) => entry.payee.id === id && entry.kind === kind && entry.state === "accrued").reduce((sum, entry) => sum + entry.amount_cents, 0);
    assert.equal(await total("ben", "commission"), 10_000, "the booking fee for the project Ben is named on");
    assert.equal(await total("ana", "commission"), 100_000 + 50_000 + 50_000, "5% of each contract when sold, and 5% more of the one that was completed");
    assert.equal(await total(crew, "piece_rate"), 250_000, "only the released commitment is earned");
    // No hourly rate has been set for Ben, and one commitment has unpriced lines: both are reported, neither is paid as zero.
    assert.equal(await total("ben", "hourly"), 0);
    const reasons = first.payees.flatMap((entry) => entry.unresolved.map((item) => item.reason)).sort();
    assert.deepEqual(reasons, ["Set this payee's hourly rate.", "This commitment has 2 line(s) with no rate."]);

    await save(ben, [{ kind: "plan", plan_id: "hourly_staff", effective_from: "2026-01-01" }, { kind: "plan", plan_id: "inside_sales", effective_from: "2026-01-01" }, { kind: "override", rule_id: "hourly_time_clock", params: { rate_cents: 2500 }, effective_from: "2026-01-01" }]);
    const second = await engine.refreshOrganizationEarnings(ORG, { context, asOf });
    assert.equal(await total("ben", "hourly"), 40_000, "sixteen approved hours in the week at $25");
    assert.equal(second.posted_count, 1);
    const units = await readPublishedData(context, { provider: "payroll", export: "pay_units", target: { ...target, id: "organization_user:ben" } });
    if (units.status !== "ready") throw Error(`expected units: ${JSON.stringify(units)}`);
    assert.deepEqual((units.value as any[]).map((unit) => [unit.rule_id, unit.unit, unit.status]).sort(), [["hourly_time_clock", "2026-06-01", "ok"], ["inside_sales_booking", "p1", "ok"]]);
    const preview = await invokeAction(command, { action: "payroll.paySetup.preview", target }, { payee: ben, entries: [{ kind: "plan", plan_id: "inside_sales", effective_from: "2026-01-01" }] });
    assert.equal((preview.value as any).total_delta_cents, -40_000, "taking Ben off the hourly plan would take the week back; previewing does not");
    assert.equal(await total("ben", "hourly"), 40_000);
  } finally {
    await store.closePayrollDatabase().catch(() => undefined);
    await rm(root, { recursive: true, force: true }).catch(() => undefined);
  }
});
