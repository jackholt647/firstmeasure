import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const ORG = "org_pay_rules";
const AS_OF = "2026-06-30T12:00:00.000Z";

test("pay rules derive earnings from declared data, post only differences, and respect effective dates", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "pay-rules-"));
  Object.assign(process.env, { NODE_ENV: "test", FIRSTMATE_ENV: "test", PLATFORM_STORAGE_ROOT: root, FIRSTMEASURE_DATABASE_MODE: "local", FIRSTMEASURE_INDEX_DB_PATH: path.join(root, "index.sqlite") });
  const core = await import("../platform/storage.js");
  const store = await import("../payroll/storage.js");
  const service = await import("../payroll/service.js");
  const rules = await import("../payroll/pay-rules.js");
  const engine = await import("../payroll/pay-refresh.js");
  const { registerDataProvider } = await import("../platform/publication/providers.js");
  const { userPublicationContext } = await import("../platform/publication/context.js");
  try {
    await core.createOrganization({ id: ORG, name: "Pay rules" });
    for (const [id, name] of [["ana", "Ana"], ["ben", "Ben"], ["cara", "Cara"], ["owner", "Owner"]]) await core.upsertDocument(ORG, "users", { id, data: { name, status: "active", worker_classification: "employee" } });
    const crew = (await (await import("../workforce/storage.js")).createResourceGroup(ORG, { name: "Install team", kind_id: "crew" })).id as string;
    const schedule = await store.createPayrollSchedule(ORG, { name: "Weekly", recurrence: { frequency: "weekly", weekday: 5 }, timezone: "UTC" });
    await store.savePayrollPolicy(ORG, "organization", ORG, { schedule_id: schedule.id });

    // The data rules read is a published collection, selected by declared conditions. Nothing else is visible to a rule.
    const person = (id: string) => [`organization_user:${id}`];
    const projects: Record<string, any>[] = [
      { id: "p1", revision: 1, assignee_keys: { booked_by: person("ana") }, sold_at: "2026-06-01T15:00:00.000Z", upsell: true, contract_cents: 1_000_000 },
      { id: "p2", revision: 1, assignee_keys: { booked_by: person("ana") }, sold_at: "", upsell: false, contract_cents: 500_000 },
      { id: "p3", revision: 1, assignee_keys: { booked_by: [`resource_group:${crew}`] }, sold_at: "2026-06-02T15:00:00.000Z", upsell: false, contract_cents: 800_000 }
    ];
    const hours = (count: number) => count * 3600;
    const shifts: Record<string, any>[] = [
      { id: "s1", revision: 1, assignee_key: "organization_user:ben", clocked_out_at: "2026-06-02T22:00:00.000Z", worked_seconds: hours(25), approval_status: "approved" },
      { id: "s2", revision: 1, assignee_key: "organization_user:ben", clocked_out_at: "2026-06-05T22:00:00.000Z", worked_seconds: hours(20), approval_status: "approved" },
      { id: "s3", revision: 1, assignee_key: "organization_user:ben", clocked_out_at: "2026-06-06T22:00:00.000Z", worked_seconds: hours(9), approval_status: "pending" },
      { id: "s4", revision: 1, assignee_key: "organization_user:ben", clocked_out_at: "2026-06-30T08:00:00.000Z", worked_seconds: hours(8), approval_status: "approved" }
    ];
    const access = { scopes: ["organization"] as const, permissions: [] };
    const collection = { type: "array", items: { type: "object", additionalProperties: true } };
    let unavailable = false;
    registerDataProvider({ id: "pay-test", version: "1", apps: [], exports: {
      projects: { schema: collection, schemaVersion: "1", description: "test", access, read: async () => unavailable ? { status: "pending", code: "indexing", message: "Projects are still indexing." } : { value: projects } },
      shifts: { schema: collection, schemaVersion: "1", description: "test", access, read: async () => ({ value: shifts }) }
    } });
    const auth: any = { orgId: ORG, userId: "owner", role: "member", permissions: { manage_payroll: true }, applicationAccess: { management: { enabled: true, permissions: { "*": true } } } };
    const context = userPublicationContext(auth);
    const actor = { userId: "owner" };
    const ana = { type: "organization_user" as const, id: "ana" }, ben = { type: "organization_user" as const, id: "ben" }, cara = { type: "organization_user" as const, id: "cara" };
    const refresh = (payee: { type: any; id: string }, asOf = AS_OF) => engine.refreshPayeeEarnings(ORG, payee, { context, asOf });
    const ledger = async (payee: { id: string }) => (await store.listPayrollLedgerEntries(ORG, { limit: 500 })).filter((entry) => entry.payee.id === payee.id);
    const owed = async (payee: { id: string }, state = "accrued") => (await ledger(payee)).filter((entry) => entry.state === state).reduce((sum, entry) => sum + entry.amount_cents, 0);

    // ---- A rule that pays per record: a booking fee, plus a bonus when the upsell field is set ----
    await rules.savePayRule(ORG, { id: "booking", name: "Booking commission", effective_from: "2026-01-01", definition: {
      grain: "record", kind: "commission", earned_at: "sold_at", project: "id",
      inputs: { projects: { primary: true, source: { provider: "pay-test", export: "projects" }, where: { rules: [{ field: "assignee_keys.booked_by", operator: "contains", value: "$payee.key" }] } } },
      parameters: { flat_cents: { default: 10_000 }, upsell_bps: { default: 200 } },
      code: `const lines = [{ key: "booking", amount_cents: params.flat_cents, description: "Booking" }];
        if (unit.record.upsell) lines.push({ key: "upsell", amount_cents: Math.round(unit.record.contract_cents * params.upsell_bps / 10000), description: "Upsell bonus", details: { contract_cents: unit.record.contract_cents } });
        return lines;`
    } }, actor);
    await assert.rejects(() => rules.savePaySetup(ORG, { payee: ana, entries: [{ kind: "add", rule_id: "missing", effective_from: "2026-01-01" }] }, actor), /does not exist/);
    await assert.rejects(() => rules.savePaySetup(ORG, { payee: { type: "organization_user", id: "nobody" }, entries: [] }, actor), /not available/);
    await rules.savePaySetup(ORG, { payee: ana, entries: [{ kind: "add", rule_id: "booking", effective_from: "2026-01-01" }] }, actor);

    const first = await refresh(ana);
    assert.equal(first.evaluated, 1, "the project with no sold date has not been earned and is not run");
    assert.deepEqual(first.posted.map((entry) => [entry.kind, entry.amount_cents, entry.project_id, entry.worked_at, entry.state]), [
      ["commission", 10_000, "p1", "2026-06-01T15:00:00.000Z", "accrued"], ["commission", 20_000, "p1", "2026-06-01T15:00:00.000Z", "accrued"]]);
    assert.deepEqual((first.posted[1]!.metadata as any).details, { contract_cents: 1_000_000 });
    assert.equal((first.posted[1]!.metadata as any).pay_rule.earned_on, "2026-06-01");

    // Nothing it read has changed, so nothing is run and nothing is posted.
    const again = await refresh(ana);
    assert.deepEqual([again.evaluated, again.unchanged, again.posted.length], [0, 1, 0]);

    // A changed record is run again and only the difference is posted; the earlier entry is untouched.
    Object.assign(projects[0]!, { revision: 2, contract_cents: 2_000_000 });
    const raised = await refresh(ana);
    assert.deepEqual(raised.posted.map((entry) => [entry.amount_cents, entry.description]), [[20_000, "Correction: Upsell bonus"]]);
    assert.equal(raised.differences[0]!.handling, "normal", "nothing has been paid yet, so it simply joins the same pay run");
    assert.equal(await owed(ana), 50_000);

    // A source that cannot be read is not the same as nothing earned: nothing is taken back.
    unavailable = true;
    const blocked = await refresh(ana);
    assert.equal(blocked.posted.length, 0);
    assert.match(blocked.unresolved[0]!.reason, /still indexing/);
    unavailable = false;

    // Once the earning is in a pay run, later changes follow the schedule's correction policy and the run is never edited.
    const batch = await service.createPayrollBatch(ORG, { schedule_id: schedule.id, pay_date: "2026-06-05" }, "owner");
    assert.equal(batch.total_cents, 50_000);
    Object.assign(projects[0]!, { revision: 3, upsell: false });
    const lowered = await refresh(ana);
    assert.deepEqual(lowered.posted.map((entry) => [entry.kind, entry.state, entry.amount_cents, (entry.metadata as any).review_required]), [["clawback", "projected", -40_000, true]]);
    assert.equal((await refresh(ana)).posted.length, 0, "a held correction is not raised twice");
    assert.equal((await store.readPayrollBatch(ORG, batch.id)).total_cents, 50_000);
    await assert.rejects(() => engine.declinePayCorrection(ORG, String(first.posted[0]!.id), actor), /held for review/);
    const declined = await engine.declinePayCorrection(ORG, String(lowered.posted[0]!.id), actor, "Agreed to let it stand");
    assert.equal(declined.state, "void");
    assert.equal((await refresh(ana)).posted.length, 0, "a declined correction stays settled");

    // Backdating: preview what an override from an earlier date would change, then save it.
    const backdated = [{ kind: "add" as const, rule_id: "booking", effective_from: "2026-01-01" }, { kind: "override" as const, rule_id: "booking", params: { flat_cents: 15_000 }, effective_from: "2026-05-01", note: "Promised in May" }];
    const preview = await engine.previewPaySetup(ORG, ana, await rules.normalizePaySetup(ORG, { payee: ana, entries: backdated }, actor, await rules.readPaySetup(ORG, ana)), { context, asOf: AS_OF });
    assert.deepEqual(preview.differences.map((difference) => [difference.line, difference.posted_cents, difference.target_cents, difference.delta_cents, difference.handling]), [["booking", 10_000, 15_000, 5_000, "next_run"]]);
    assert.equal(preview.total_delta_cents, 5_000);
    assert.equal((await refresh(ana)).posted.length, 0, "a preview changes nothing");
    const saved = await rules.savePaySetup(ORG, { payee: ana, entries: backdated }, actor);
    assert.ok(saved.entries.every((entry) => entry.entered_by === "owner" && entry.entered_at), "each entry records who entered it and when");
    const backPay = await refresh(ana);
    assert.deepEqual(backPay.posted.map((entry) => [entry.amount_cents, entry.state, entry.worked_at, (entry.metadata as any).back_pay]), [[5_000, "accrued", AS_OF, true]]);
    assert.equal((backPay.posted[0]!.metadata as any).pay_rule.earned_on, "2026-06-01", "the correction is paid now but remembers the day it was earned");

    // A record that no longer names the payee is taken back, again as a new entry.
    projects[0]!.assignee_keys = { booked_by: person("ben") }; projects[0]!.revision = 4;
    const withdrawn = await refresh(ana);
    assert.deepEqual(withdrawn.posted.map((entry) => [entry.amount_cents, entry.state]), [[-15_000, "projected"]]);
    assert.ok((await engine.listPayUnits(ORG, ana)).some((unit) => unit.unit === "p1" && unit.status === "withdrawn"));

    // ---- A rule that pays by period, assigned through a plan: hours with overtime over the week ----
    await rules.savePayRule(ORG, { id: "hourly", name: "Hourly", effective_from: "2026-01-01", definition: {
      grain: "period", period: "week", kind: "hourly",
      inputs: { shifts: { source: { provider: "pay-test", export: "shifts" }, date: "clocked_out_at", where: { rules: [{ field: "assignee_key", operator: "equals", value: "$payee.key" }, { field: "approval_status", operator: "equals", value: "approved" }] } } },
      parameters: { rate_cents: { default: 2500 }, overtime_after: { default: 40 }, multiplier: { default: 1.5 } },
      code: `const hours = unit.rows.shifts.reduce((sum, shift) => sum + shift.worked_seconds, 0) / 3600;
        const regular = Math.min(hours, params.overtime_after), over = hours - regular;
        const lines = [{ key: "regular", amount_cents: Math.round(regular * params.rate_cents), description: regular.toFixed(2) + " hours" }];
        if (over > 0) lines.push({ key: "overtime", amount_cents: Math.round(over * params.rate_cents * params.multiplier), description: over.toFixed(2) + " overtime hours" });
        return lines;`
    } }, actor);
    await assert.rejects(() => rules.savePayPlan(ORG, { id: "field", name: "Field", rules: [{ rule_id: "hourly" }, { rule_id: "hourly" }] }, actor), /each rule once/);
    await rules.savePayPlan(ORG, { id: "field", name: "Field", effective_from: "2026-01-01", rules: [{ rule_id: "hourly", params: { rate_cents: 3000 } }] }, actor);
    await rules.savePaySetup(ORG, { payee: ben, entries: [{ kind: "plan", plan_id: "field", effective_from: "2026-01-01" }] }, actor);
    const week = await refresh(ben);
    assert.deepEqual(week.posted.map((entry) => [entry.kind, entry.amount_cents, entry.description, entry.worked_at]), [
      ["hourly", 120_000, "40.00 hours", "2026-06-07T12:00:00.000Z"], ["hourly", 22_500, "5.00 overtime hours", "2026-06-07T12:00:00.000Z"]],
      "the unapproved shift is not selected, and the week still in progress has not been earned");

    // A promotion is a new version from a date. Weeks earned before it keep the old rate without being touched.
    await rules.savePayPlan(ORG, { id: "field", name: "Field", effective_from: "2026-06-08", rules: [{ rule_id: "hourly", params: { rate_cents: 3500 } }] }, actor);
    shifts.push({ id: "s5", revision: 1, assignee_key: "organization_user:ben", clocked_out_at: "2026-06-10T22:00:00.000Z", worked_seconds: hours(10), approval_status: "approved" });
    const promoted = await refresh(ben);
    assert.deepEqual(promoted.posted.map((entry) => entry.amount_cents), [35_000]);
    assert.equal(promoted.unchanged, 1);
    // A corrected shift changes only its own week.
    Object.assign(shifts[1]!, { revision: 2, worked_seconds: hours(15) });
    assert.deepEqual((await refresh(ben)).posted.map((entry) => [entry.amount_cents, (entry.metadata as any).pay_rule.line]).sort(), [[-22_500, "overtime"]]);
    // Taking one rule out for one person leaves the plan in place and stops only later earnings.
    await rules.savePaySetup(ORG, { payee: ben, entries: [{ kind: "plan", plan_id: "field", effective_from: "2026-01-01" }, { kind: "remove", rule_id: "hourly", effective_from: "2026-06-15" }] }, actor);
    shifts.push({ id: "s6", revision: 1, assignee_key: "organization_user:ben", clocked_out_at: "2026-06-17T22:00:00.000Z", worked_seconds: hours(6), approval_status: "approved" });
    assert.equal((await refresh(ben)).posted.length, 0);

    // ---- A salary pays every period whether or not anything happened in it ----
    await rules.savePayRule(ORG, { id: "salary", name: "Salary", effective_from: "2026-01-01", definition: {
      grain: "period", period: "month", always: true, kind: "salary", inputs: {}, parameters: { monthly_cents: {} }, code: "return params.monthly_cents;" } }, actor);
    await rules.savePaySetup(ORG, { payee: cara, entries: [{ kind: "add", rule_id: "salary", params: { monthly_cents: 500_000 }, effective_from: "2026-04-01" }] }, actor);
    assert.deepEqual((await refresh(cara)).posted.map((entry) => [entry.amount_cents, String(entry.worked_at).slice(0, 10)]), [[500_000, "2026-04-30"], [500_000, "2026-05-31"]]);
    // A formula that fails leaves the period unresolved. It is not paid as zero and nothing already posted moves.
    await rules.savePayRule(ORG, { id: "salary", name: "Salary", effective_from: "2026-01-01", definition: {
      grain: "period", period: "month", always: true, kind: "salary", inputs: {}, parameters: { monthly_cents: {} }, code: "return params.monthly_cents / 3;" } }, actor);
    const broken = await refresh(cara);
    assert.equal(broken.posted.length, 0);
    assert.equal(broken.unresolved.length, 2);
    assert.match(broken.unresolved[0]!.reason, /whole number of cents/);
    assert.equal(await owed(cara), 1_000_000);

    // ---- A group of users is paid as one payee ----
    const team = { type: "resource_group" as const, id: crew };
    await rules.savePaySetup(ORG, { payee: team, entries: [{ kind: "add", rule_id: "booking", effective_from: "2026-01-01" }] }, actor);
    const grouped = await refresh(team);
    assert.deepEqual(grouped.posted.map((entry) => [(entry.payee as any).type, (entry.payee as any).name, entry.amount_cents]), [["resource_group", "Install team", 10_000]]);
    const run = await service.createPayrollBatch(ORG, { schedule_id: schedule.id, pay_date: "2026-06-12" }, "owner");
    assert.ok(run.items.some((item: any) => item.payee.type === "resource_group" && item.net_cents === 10_000), "the group has its own line on the pay run");

    // Refreshing the organization covers every payee with a setup and reports what could not be worked out.
    const everyone = await engine.refreshOrganizationEarnings(ORG, { context, asOf: AS_OF });
    assert.equal(everyone.payees.length, 4);
    assert.equal(everyone.posted_count, 0);
    assert.equal(everyone.unresolved_count, 2);
    // What needs a person's attention can be read at any time, without refreshing again.
    const unresolved = await engine.listUnresolvedPay(ORG);
    assert.deepEqual(unresolved.map((item) => [item.payee_name, item.rule_id, item.unit, item.whole_rule]).sort(), [["Cara", "salary", "2026-04-01", false], ["Cara", "salary", "2026-05-01", false]]);
    assert.match(unresolved[0]!.reason, /whole number of cents/);
    const review = await engine.listPayReview(ORG);
    assert.deepEqual(review.held.map((entry) => [entry.payee.id, entry.amount_cents]), [["ana", -15_000]], "the declined correction is settled; the withdrawn booking still waits");
    assert.deepEqual(review.off_cycle, []);
    // A rule whose inputs cannot be read at all is remembered too, and forgotten once it reads again.
    unavailable = true;
    await refresh(team);
    assert.deepEqual((await engine.listUnresolvedPay(ORG)).filter((item) => item.whole_rule).map((item) => [item.payee_name, item.rule_id]), [["Install team", "booking"]]);
    unavailable = false;
    await refresh(team);
    assert.equal((await engine.listUnresolvedPay(ORG)).filter((item) => item.whole_rule).length, 0);
  } finally {
    await store.closePayrollDatabase().catch(() => undefined);
    await rm(root, { recursive: true, force: true }).catch(() => undefined);
  }
});

test("pay rule definitions refuse shapes the engine could not evaluate", async () => {
  const { payRuleDefinitionSchema, effectiveRuleSlots, versionOn } = await import("../payroll/pay-rules.js");
  const { payPeriodOf } = await import("../payroll/pay-refresh.js");
  const input = { source: { provider: "payroll", export: "time_shifts" } };
  const bad = (definition: unknown) => assert.equal(payRuleDefinitionSchema.safeParse(definition).success, false);
  bad({ grain: "record", inputs: { rows: { ...input, primary: true } }, code: "return 1;" });
  bad({ grain: "record", earned_at: "at", inputs: { rows: input }, code: "return 1;" });
  bad({ grain: "period", inputs: { rows: { ...input, date: "at" } }, code: "return 1;" });
  bad({ grain: "period", period: "week", inputs: { rows: input }, code: "return 1;" });
  bad({ grain: "period", period: "week", always: true, inputs: { rows: { ...input, where: { assignee_key: "x" } } }, code: "return 1;" });
  bad({ grain: "period", period: "week", always: true, timezone: "Mars/Olympus", inputs: {}, code: "return 1;" });
  assert.equal(payRuleDefinitionSchema.safeParse({ grain: "period", period: "week", always: true, inputs: {}, code: "return 1;" }).success, true);

  assert.deepEqual(payPeriodOf("2026-06-03", "week", 1), { key: "2026-06-01", from: "2026-06-01", through: "2026-06-07" });
  assert.deepEqual(payPeriodOf("2026-06-07", "week", 0), { key: "2026-06-07", from: "2026-06-07", through: "2026-06-13" });
  assert.deepEqual(payPeriodOf("2026-02-10", "month"), { key: "2026-02-01", from: "2026-02-01", through: "2026-02-28" });
  assert.deepEqual(payPeriodOf("2026-05-20", "quarter"), { key: "2026-04-01", from: "2026-04-01", through: "2026-06-30" });
  assert.equal(versionOn([{ effective_from: "2026-01-01" }, { effective_from: "2026-06-01" }], "2026-05-31")!.effective_from, "2026-01-01");
  assert.equal(versionOn([{ effective_from: "2026-06-01" }], "2026-05-31"), null);

  // Plans bring rules in, a person can add one, change one, swap one's formula, or take one out, each from its own date.
  const stamp = { entered_at: "2026-01-01T00:00:00.000Z", entered_by: "owner" };
  const plans = new Map([["sales", { id: "sales", name: "Sales", description: "", status: "active" as const, revision: 1, versions: [
    { ...stamp, effective_from: "2026-01-01", rules: [{ rule_id: "base", params: { rate: 1 } }, { rule_id: "bonus" }] }] }]]);
  const entries: any[] = [
    { ...stamp, id: "a", kind: "plan", plan_id: "sales", effective_from: "2026-01-01" },
    { ...stamp, id: "b", kind: "add", rule_id: "spiff", effective_from: "2026-03-01", effective_through: "2026-03-31" },
    { ...stamp, id: "c", kind: "override", rule_id: "base", params: { rate: 2 }, replacement_rule_id: "base_custom", effective_from: "2026-04-01" },
    { ...stamp, id: "d", kind: "remove", rule_id: "bonus", effective_from: "2026-05-01" }
  ];
  const on = (date: string) => Object.fromEntries([...effectiveRuleSlots({ entries }, plans, date)].map(([id, slot]) => [id, `${slot.definition_rule_id}:${slot.params.rate ?? ""}`]));
  assert.deepEqual(on("2026-02-01"), { base: "base:1", bonus: "bonus:" });
  assert.deepEqual(on("2026-03-15"), { base: "base:1", bonus: "bonus:", spiff: "spiff:" });
  assert.deepEqual(on("2026-04-15"), { base: "base_custom:2", bonus: "bonus:" });
  assert.deepEqual(on("2026-05-15"), { base: "base_custom:2" });
});
