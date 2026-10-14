import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

test("a pay schedule's pay days are data: weekdays, month days, positions, intervals and weekend moves", async () => {
  const { payrollPayDates, payrollOccurrence } = await import("../payroll/schedule.js");
  const { payrollRecurrenceSchema } = await import("../payroll/schemas.js");
  const dates = (recurrence: Record<string, unknown>, from: string, through: string) => {
    assert.equal(payrollRecurrenceSchema.safeParse(recurrence).success, true, JSON.stringify(recurrence));
    return payrollPayDates({ recurrence }, from, through);
  };
  // The 3rd Thursday of every month, and the last Friday.
  assert.deepEqual(dates({ frequency: "monthly", nth_weekdays: [{ nth: 3, weekday: 4 }] }, "2026-06-01", "2026-08-31"), ["2026-06-18", "2026-07-16", "2026-08-20"]);
  assert.deepEqual(dates({ frequency: "monthly", nth_weekdays: [{ nth: -1, weekday: 5 }] }, "2026-06-01", "2026-07-31"), ["2026-06-26", "2026-07-31"]);
  // The 1st and 15th; the last day of the month; a day a short month does not have pays on its last day.
  assert.deepEqual(dates({ frequency: "semi_monthly", days: [1, 15] }, "2026-06-01", "2026-07-15"), ["2026-06-01", "2026-06-15", "2026-07-01", "2026-07-15"]);
  assert.deepEqual(dates({ frequency: "monthly", days: [-1] }, "2026-02-01", "2026-04-30"), ["2026-02-28", "2026-03-31", "2026-04-30"]);
  assert.deepEqual(dates({ frequency: "monthly", day: 31 }, "2026-02-01", "2026-03-31"), ["2026-02-28", "2026-03-31"]);
  // Every other Friday counted from an anchor, exactly as before; and twice a week.
  assert.deepEqual(dates({ frequency: "biweekly", weekday: 5, anchor_date: "2026-06-05" }, "2026-06-01", "2026-07-05"), ["2026-06-05", "2026-06-19", "2026-07-03"]);
  assert.deepEqual(dates({ frequency: "weekly", interval: 2, weekday: 5, anchor_date: "2026-06-05" }, "2026-06-01", "2026-07-05"), ["2026-06-05", "2026-06-19", "2026-07-03"]);
  assert.deepEqual(dates({ frequency: "weekly", weekdays: [2, 5] }, "2026-06-01", "2026-06-12"), ["2026-06-02", "2026-06-05", "2026-06-09", "2026-06-12"]);
  // Quarterly and yearly, limited to named months, and every third day from an anchor.
  assert.deepEqual(dates({ frequency: "quarterly", day: 10, anchor_date: "2026-01-01" }, "2026-01-01", "2026-12-31"), ["2026-01-10", "2026-04-10", "2026-07-10", "2026-10-10"]);
  assert.deepEqual(dates({ frequency: "yearly", months: [12], nth_weekdays: [{ nth: 2, weekday: 1 }] }, "2026-01-01", "2027-12-31"), ["2026-12-14", "2027-12-13"]);
  assert.deepEqual(dates({ frequency: "daily", interval: 3, anchor_date: "2026-06-01" }, "2026-06-01", "2026-06-10"), ["2026-06-01", "2026-06-04", "2026-06-07", "2026-06-10"]);
  // A pay day on a weekend can move to the weekday before or after. 2026-08-01 is a Saturday and 2026-08-15 a Saturday.
  assert.deepEqual(dates({ frequency: "semi_monthly", days: [1, 15], adjust: "previous_weekday" }, "2026-07-20", "2026-08-31"), ["2026-07-31", "2026-08-14"]);
  assert.deepEqual(dates({ frequency: "semi_monthly", days: [1, 15], adjust: "next_weekday" }, "2026-07-20", "2026-08-31"), ["2026-08-03", "2026-08-17"]);
  // An occurrence still gets its period from the pay day before it.
  const occurrence = payrollOccurrence({ id: "s", name: "Third Thursday", recurrence: { frequency: "monthly", nth_weekdays: [{ nth: 3, weekday: 4 }] }, timezone: "UTC" }, "2026-07-16")!;
  assert.deepEqual([occurrence.period_start.slice(0, 10), occurrence.period_end.slice(0, 10)], ["2026-06-19", "2026-07-16"]);

  const bad = (recurrence: unknown) => assert.equal(payrollRecurrenceSchema.safeParse(recurrence).success, false, JSON.stringify(recurrence));
  bad({ frequency: "monthly" });
  bad({ frequency: "weekly" });
  bad({ frequency: "weekly", weekday: 5, interval: 2 });
  bad({ frequency: "weekly", weekday: 5, nth_weekdays: [{ nth: 1, weekday: 5 }] });
  bad({ frequency: "monthly", days: [0] });
  bad({ frequency: "monthly", nth_weekdays: [{ nth: 0, weekday: 4 }] });
});

test("a salary is earned by the day through the same rules and paid on whatever cadence its schedule says", async () => {
  const ORG = "org_pay_cadence";
  const root = await mkdtemp(path.join(os.tmpdir(), "pay-cadence-"));
  Object.assign(process.env, { NODE_ENV: "test", FIRSTMATE_ENV: "test", PLATFORM_STORAGE_ROOT: root, FIRSTMEASURE_DATABASE_MODE: "local", FIRSTMEASURE_INDEX_DB_PATH: path.join(root, "index.sqlite") });
  const core = await import("../platform/storage.js");
  const store = await import("../payroll/storage.js");
  const service = await import("../payroll/service.js");
  const rules = await import("../payroll/pay-rules.js");
  const engine = await import("../payroll/pay-refresh.js");
  const { userPublicationContext } = await import("../platform/publication/context.js");
  try {
    await core.createOrganization({ id: ORG, name: "Pay cadence" });
    await core.upsertDocument(ORG, "users", { id: "cara", data: { name: "Cara", status: "active", worker_classification: "employee" } });
    // Everything pays weekly on Friday, except salary, which this company pays on the 3rd Thursday of the month.
    const weekly = await store.createPayrollSchedule(ORG, { name: "Weekly", recurrence: { frequency: "weekly", weekday: 5 }, timezone: "UTC" });
    const thirdThursday = await store.createPayrollSchedule(ORG, { name: "Third Thursday", recurrence: { frequency: "monthly", nth_weekdays: [{ nth: 3, weekday: 4 }] }, timezone: "UTC" });
    await rules.savePayDefault(ORG, { subject: { type: "organization", id: ORG }, entries: [], schedules: [
      { effective_from: "2026-01-01", schedule_id: weekly.id }, { effective_from: "2026-01-01", earning_kind: "salary", schedule_id: thirdThursday.id }] }, { userId: "owner" });

    const actor = { userId: "owner" };
    const context = userPublicationContext({ orgId: ORG, userId: "owner", role: "member", permissions: { manage_payroll: true }, applicationAccess: { management: { enabled: true, permissions: { "*": true } } } } as any);
    // No inputs: a salary reads no data. It is an amount on a cadence, earned each day, weekends included here.
    await rules.savePayRule(ORG, { id: "salary", name: "Salary", effective_from: "2026-01-01", definition: {
      grain: "period", period: "day", always: true, kind: "salary", inputs: {}, parameters: { annual_cents: {} },
      code: `return { amount_cents: Math.round(params.annual_cents / unit.period.days_in_year), description: "Salary for " + unit.period.from };`
    } }, actor);
    const cara = { type: "organization_user" as const, id: "cara" };
    // Cara starts on the 10th, so June pays her from the 10th: nothing needs prorating by hand.
    await rules.savePaySetup(ORG, { payee: cara, entries: [{ kind: "add", rule_id: "salary", params: { annual_cents: 3_650_000 }, effective_from: "2026-06-10" }] }, actor);
    const first = await engine.refreshPayeeEarnings(ORG, cara, { context, asOf: "2026-06-20T12:00:00.000Z" });
    assert.equal(first.unresolved.length, 0, JSON.stringify(first.unresolved));
    assert.deepEqual(first.posted.map((entry) => String(entry.worked_at).slice(0, 10)), ["2026-06-10", "2026-06-11", "2026-06-12", "2026-06-13", "2026-06-14", "2026-06-15", "2026-06-16", "2026-06-17", "2026-06-18", "2026-06-19"], "today is not earned until it is over");
    assert.ok(first.posted.every((entry) => entry.amount_cents === 10_000 && entry.kind === "salary" && entry.schedule_id === thirdThursday.id));

    await assert.rejects(() => service.createPayrollBatch(ORG, { schedule_id: thirdThursday.id, pay_date: "2026-06-17" }, "owner"), /not part of this schedule/);
    const run = await service.createPayrollBatch(ORG, { schedule_id: thirdThursday.id, pay_date: "2026-06-18" }, "owner");
    assert.equal(run.total_cents, 90_000, "the nine days earned through the pay day; the 19th waits for July's");
    // The next day is earned and nothing already worked out is run again.
    const next = await engine.refreshPayeeEarnings(ORG, cara, { context, asOf: "2026-06-21T12:00:00.000Z" });
    assert.deepEqual([next.evaluated, next.unchanged, next.posted.length], [1, 10, 1]);
    // A raise from the 20th changes only the days from the 20th.
    await rules.savePaySetup(ORG, { payee: cara, entries: [
      { kind: "add", rule_id: "salary", params: { annual_cents: 3_650_000 }, effective_from: "2026-06-10" },
      { kind: "override", rule_id: "salary", params: { annual_cents: 7_300_000 }, effective_from: "2026-06-20" }
    ] }, actor);
    const raised = await engine.refreshPayeeEarnings(ORG, cara, { context, asOf: "2026-06-21T12:00:00.000Z" });
    assert.deepEqual(raised.posted.map((entry) => [(entry.metadata as any).pay_rule.earned_on, entry.amount_cents]), [["2026-06-20", 10_000]]);
  } finally {
    await store.closePayrollDatabase().catch(() => undefined);
    await rm(root, { recursive: true, force: true }).catch(() => undefined);
  }
});
