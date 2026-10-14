import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const ORG = "org_pay_splits";
const AS_OF = "2026-06-30T12:00:00.000Z";

test("a split rule divides a group's earning by data, follows that data as corrections, and keeps who shared it", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "pay-splits-"));
  Object.assign(process.env, { NODE_ENV: "test", FIRSTMATE_ENV: "test", PLATFORM_STORAGE_ROOT: root, FIRSTMEASURE_DATABASE_MODE: "local", FIRSTMEASURE_INDEX_DB_PATH: path.join(root, "index.sqlite") });
  const core = await import("../platform/storage.js");
  const store = await import("../payroll/storage.js");
  const service = await import("../payroll/service.js");
  const rules = await import("../payroll/pay-rules.js");
  const engine = await import("../payroll/pay-refresh.js");
  const workforce = await import("../workforce/storage.js");
  const { SAMPLE_PAY_SPLIT_RULES } = await import("../payroll/sample-pay-rules.js");
  const { registerDataProvider } = await import("../platform/publication/providers.js");
  const { userPublicationContext } = await import("../platform/publication/context.js");
  try {
    await core.createOrganization({ id: ORG, name: "Pay splits" });
    for (const id of ["ana", "ben", "cara", "dan", "owner"]) await core.upsertDocument(ORG, "users", { id, data: { name: id.charAt(0).toUpperCase() + id.slice(1), status: "active", worker_classification: "employee" } });
    const addMember = async (groupId: string, userId: string) => workforce.putResourceGroupMember(ORG, groupId, userId, { role: "member", expected_revision: Number((await workforce.readResourceGroup(ORG, groupId)).revision) });
    const group = async (name: string, kind: string, members: string[]) => {
      const id = (await workforce.createResourceGroup(ORG, { name, kind_id: kind })).id as string;
      for (const member of members) await addMember(id, member);
      return id;
    };
    const crew = await group("Install team", "crew", ["ana", "ben", "cara"]);
    const schedule = await store.createPayrollSchedule(ORG, { name: "Weekly", recurrence: { frequency: "weekly", weekday: 5 }, timezone: "UTC" });
    await (await import("../payroll/pay-rules.js")).savePayDefault(ORG, { subject: { type: "organization", id: ORG }, entries: [], schedules: [{ effective_from: "2026-01-01", schedule_id: schedule.id }] }, { userId: "owner" });

    // Jobs are what the group is paid for; shifts are the time clock. Both are published collections a rule selects from.
    const jobs: Record<string, any>[] = [];
    const shifts: Record<string, any>[] = [];
    const job = (id: string, groupId: string, project: string, day: string, cents: number) => jobs.push({ id, revision: 1, assignee_key: `resource_group:${groupId}`, project_id: project, done_at: `2026-06-${day}T15:00:00.000Z`, pay_cents: cents });
    const shift = (id: string, user: string, project: string, day: string, from: string, to: string, status = "approved", worked?: number) => {
      const clocked_in_at = `2026-06-${day}T${from}:00.000Z`, clocked_out_at = `2026-06-${day}T${to}:00.000Z`;
      shifts.push({ id, revision: 1, assignee_key: `organization_user:${user}`, project_id: project, clocked_in_at, clocked_out_at, approval_status: status,
        worked_seconds: worked ?? (Date.parse(clocked_out_at) - Date.parse(clocked_in_at)) / 1000 });
    };
    const change = (id: string, values: Record<string, unknown>) => { const row = shifts.find((entry) => entry.id === id)!; Object.assign(row, values, { revision: row.revision + 1 }); };
    let selections = 0;
    const access = { scopes: ["organization"] as const, permissions: [] };
    const collection = { type: "array", items: { type: "object", additionalProperties: true } };
    registerDataProvider({ id: "pay-splits-test", version: "1", apps: [], exports: {
      jobs: { schema: collection, schemaVersion: "1", description: "test", access, read: async () => ({ value: jobs }) },
      shifts: { schema: collection, schemaVersion: "1", description: "test", access, read: async () => { selections += 1; return { value: shifts }; } }
    } });
    const context = userPublicationContext({ orgId: ORG, userId: "owner", role: "member", permissions: { manage_payroll: true }, applicationAccess: { management: { enabled: true, permissions: { "*": true } } } } as any);
    const actor = { userId: "owner" };
    const team = { type: "resource_group" as const, id: crew };
    const refresh = (payee: { type: "resource_group"; id: string }) => engine.refreshPayeeEarnings(ORG, payee, { context, asOf: AS_OF });
    const ledger = async () => (await store.listPayrollLedgerEntries(ORG, { limit: 1000, include_projected: true } as any)).map((entry) => [entry.id, entry.payee.id, entry.state, entry.amount_cents]).sort();
    const posted = (result: { posted: Record<string, any>[] }) => result.posted.map((entry) => [entry.payee.id, entry.metadata.pay_rule.unit, entry.amount_cents]).sort();
    const quiet = async (payee: { type: "resource_group"; id: string }, units: number) => {
      const again = await refresh(payee);
      assert.deepEqual([again.evaluated, again.unchanged, again.posted.length, again.unresolved.length], [0, units, 0, 0], "nothing it read has changed, so neither the pay rule nor the split rule is run");
    };

    await rules.savePayRule(ORG, { id: "job_pay", name: "Job pay", effective_from: "2026-01-01", definition: {
      grain: "record", kind: "piece_rate", earned_at: "done_at", project: "project_id", parameters: {},
      inputs: { jobs: { primary: true, source: { provider: "pay-splits-test", export: "jobs" }, where: { rules: [{ field: "assignee_key", operator: "equals", value: "$payee.key" }] } } },
      code: "return unit.record.pay_cents;" } }, actor);
    // The sample split rules, reading this test's shifts in place of the real time clock.
    const sample = (id: string) => {
      const found = SAMPLE_PAY_SPLIT_RULES.find((rule) => rule.id === id)!;
      const inputs = Object.fromEntries(Object.entries(found.definition.inputs).map(([name, input]) => [name, { ...(input as object), source: { provider: "pay-splits-test", export: "shifts" } }]));
      return { id, name: found.name, effective_from: "2026-01-01", definition: { ...found.definition, inputs } };
    };
    for (const id of ["present_on_the_job", "by_hours_on_the_job", "whole_team"]) await rules.savePaySplitRule(ORG, sample(id), actor);
    assert.deepEqual((await rules.listPaySplitRules(ORG)).map((rule) => [rule.id, rule.versions.length]), [["by_hours_on_the_job", 1], ["present_on_the_job", 1], ["whole_team", 1]]);
    assert.deepEqual(await rules.listPayRules(ORG).then((list) => list.map((rule) => rule.id)), ["job_pay"], "split rules are kept beside pay rules, not among them");

    // ---- What can be saved ----
    const entries = [{ kind: "add" as const, rule_id: "job_pay", effective_from: "2026-01-01" }];
    const byRule = (from: string, id: string, params?: Record<string, number>) => ({ effective_from: from, mode: "split" as const, method: "rule" as const, split_rule_id: id, ...(params ? { params } : {}) });
    await assert.rejects(() => rules.savePaySetup(ORG, { payee: team, entries, distribution: [{ effective_from: "2026-01-01", mode: "split", method: "rule" }] }, actor), /Name the split rule/);
    await assert.rejects(() => rules.savePaySetup(ORG, { payee: team, entries, distribution: [{ effective_from: "2026-01-01", mode: "split", method: "equal", split_rule_id: "whole_team" }] }, actor), /Only a split by rule/);
    await assert.rejects(() => rules.savePaySetup(ORG, { payee: team, entries, distribution: [byRule("2026-01-01", "missing")] }, actor), /does not exist/);
    await assert.rejects(() => rules.savePaySplitRule(ORG, { name: "Bad", definition: { inputs: { rows: { source: { provider: "payroll", export: "time_shifts" }, match: { project_id: "$payee.key" } } }, code: "return {};" } }, actor));
    await assert.rejects(() => rules.savePaySplitRule(ORG, { name: "Bad", definition: { inputs: { rows: { source: { provider: "payroll", export: "time_shifts" }, where: { assignee_key: "x" } } }, code: "return {};" } }, actor));
    assert.equal(engine.zonedDayStart("2026-06-03", "America/Denver"), Date.parse("2026-06-03T06:00:00.000Z"), "windows are cut at the exact instant a day starts where the earning was earned");

    // ---- A group split equally, then by who was on the job, from a date ----
    job("j0", crew, "p0", "01", 30_000);
    job("j1", crew, "p1", "03", 90_000);
    shift("s1", "ana", "p1", "03", "08:00", "16:00");
    shift("s2", "ben", "p1", "03", "08:00", "12:00");
    shift("s3", "cara", "p1", "03", "09:00", "13:00", "pending");
    shift("s4", "cara", "p1", "02", "08:00", "16:00");
    shift("s5", "cara", "p2", "03", "14:00", "16:00");
    await rules.savePaySetup(ORG, { payee: team, entries, distribution: [{ effective_from: "2026-01-01", mode: "split", method: "equal" }] }, actor);
    assert.deepEqual(posted(await refresh(team)), [["ana", "j0", 10_000], ["ana", "j1", 30_000], ["ben", "j0", 10_000], ["ben", "j1", 30_000], ["cara", "j0", 10_000], ["cara", "j1", 30_000]]);

    await rules.savePaySetup(ORG, { payee: team, entries, distribution: [{ effective_from: "2026-01-01", mode: "split", method: "equal" }, byRule("2026-06-02", "present_on_the_job")] }, actor);
    selections = 0;
    const present = await refresh(team);
    assert.deepEqual(posted(present), [["ana", "j1", 15_000], ["ben", "j1", 15_000], ["cara", "j1", -30_000]],
      "from the 2nd, Cara, who had no approved shift on that job that day, gets nothing for it; the job earned before the switch stays split equally");
    assert.deepEqual([present.evaluated, present.unchanged, selections], [1, 1, 1], "the shifts are selected once for the group, not once per earning");
    const anaEntry = present.posted.find((entry) => (entry.payee as any).id === "ana")!.metadata as any;
    assert.deepEqual({ ...anaEntry.split, reason: undefined, params: undefined, split_rule_version: undefined }, {
      of: `resource_group:${crew}`, line_cents: 90_000, members: 3, method: "rule", split_rule_id: "present_on_the_job", weight: 1, total_weight: 2, share_cents: 45_000,
      details: { seconds_on_the_job: 28_800 }, reason: undefined, params: undefined, split_rule_version: undefined });
    assert.equal(anaEntry.split.reason, "On the job for 8.00 hours that day");
    assert.deepEqual(anaEntry.split.params, { minimum_minutes: 1 });
    const caraEntry = present.posted.find((entry) => (entry.payee as any).id === "cara")!.metadata as any;
    assert.deepEqual([caraEntry.split.weight, caraEntry.split.share_cents, caraEntry.split.reason], [0, 0, "No approved shift on this job that day"], "the entry that takes a share back says why");
    const unit = async (payee: { type: "resource_group"; id: string }, key: string) => (await engine.listPayUnits(ORG, payee)).find((entry) => entry.unit === key)!;
    const explained = (await unit(team, "j1")).split!;
    assert.deepEqual([explained.method, explained.split_rule_id, explained.members], ["rule", "present_on_the_job", ["ana", "ben", "cara"]]);
    assert.deepEqual(explained.lines.main!.shares.map((share) => [share.id, share.weight, share.cents]), [["ana", 1, 45_000], ["ben", 1, 45_000], ["cara", 0, 0]]);
    assert.equal((await unit(team, "j0")).split!.method, "equal");
    const evidence = await store.getPayrollDatabase().prepare("SELECT source, row_key, row_revision FROM pay_rule_evidence WHERE organization_id=? AND unit_key=? ORDER BY source, row_key").all(ORG, "j1");
    assert.deepEqual(evidence.map((row) => [row.source, row.row_key, row.row_revision]), [["jobs", "j1", "1"], ["split:shifts", "s1", "1"], ["split:shifts", "s2", "1"]],
      "what the split read is evidence too: not the pending shift, the day before, or the other project");
    await quiet(team, 2);

    // A parameter of the split rule is set where the group's distribution names it. A preview shows what it would move without moving it.
    const stricter = await rules.normalizePaySetup(ORG, { payee: team, entries, distribution: [{ effective_from: "2026-01-01", mode: "split", method: "equal" }, byRule("2026-06-02", "present_on_the_job", { minimum_minutes: 300 })] }, actor, await rules.readPaySetup(ORG, team));
    const preview = await engine.previewPaySetup(ORG, team, stricter, { context, asOf: AS_OF });
    assert.deepEqual(preview.differences.map((difference) => [difference.payee, difference.unit, difference.delta_cents]).sort(), [["organization_user:ana", "j1", 45_000], ["organization_user:ben", "j1", -45_000]], "four hours is not five");
    await quiet(team, 2);

    // ---- The weights follow the data: a shift approved late moves shares as corrections ----
    change("s3", { approval_status: "approved" });
    const late = await refresh(team);
    assert.deepEqual(posted(late), [["ana", "j1", -15_000], ["ben", "j1", -15_000], ["cara", "j1", 30_000]]);
    assert.deepEqual(late.differences.map((difference) => difference.handling), ["normal", "normal", "normal"], "nothing has been in a pay run yet, so the differences simply join it");
    await quiet(team, 2);

    // Once the earning has been in a pay run, the same kind of change follows each member's correction policy and the run is not edited.
    const run = await service.createPayrollBatch(ORG, { schedule_id: schedule.id, pay_date: "2026-06-05" }, "owner");
    assert.equal(run.total_cents, 120_000);
    change("s2", { approval_status: "rejected" });
    const afterRun = await refresh(team);
    assert.deepEqual(afterRun.posted.map((entry) => [(entry.payee as any).id, entry.amount_cents, entry.state, (entry.metadata as any).back_pay === true, (entry.metadata as any).review_required === true]).sort(), [
      ["ana", 15_000, "accrued", true, false], ["ben", -30_000, "projected", false, true], ["cara", 15_000, "accrued", true, false]],
      "the increases are back pay on the next run; the decrease is held for review");
    assert.equal((afterRun.posted.find((entry) => (entry.payee as any).id === "ben")!.metadata as any).split.reason, "No approved shift on this job that day");
    assert.equal((await store.readPayrollBatch(ORG, run.id)).total_cents, 120_000);
    await quiet(team, 2);

    // ---- Who shares an earning is fixed when it is first worked out ----
    await addMember(crew, "dan");
    shift("s6", "dan", "p1", "03", "08:00", "16:00");
    await quiet(team, 2);
    job("j2", crew, "p2", "10", 60_000);
    shift("s7", "ana", "p2", "10", "08:00", "16:00");
    shift("s8", "dan", "p2", "10", "08:00", "16:00");
    assert.deepEqual(posted(await refresh(team)), [["ana", "j2", 30_000], ["dan", "j2", 30_000]], "Dan shares work earned after he joined, and his shift on the old job changes nothing about it");
    assert.deepEqual([(await unit(team, "j1")).split!.members, (await unit(team, "j2")).split!.members], [["ana", "ben", "cara"], ["ana", "ben", "cara", "dan"]]);

    // ---- Nobody with a weight: unresolved, not paid to nobody and not shared equally ----
    job("j3", crew, "p9", "15", 40_000);
    const nobody = await refresh(team);
    assert.equal(nobody.posted.length, 0);
    assert.deepEqual(nobody.unresolved.map((entry) => [entry.rule_id, entry.unit]), [["job_pay", "j3"]]);
    assert.match(nobody.unresolved[0]!.reason, /Present on the job: .*weight of 0.*paid to nobody/);
    assert.deepEqual((await engine.listUnresolvedPay(ORG)).map((item) => [item.payee_name, item.unit]), [["Install team", "j3"]]);
    shift("s9", "ben", "p9", "15", "08:00", "16:00");
    assert.deepEqual(posted(await refresh(team)), [["ben", "j3", 40_000]]);
    assert.deepEqual(await engine.listUnresolvedPay(ORG), []);
    await quiet(team, 4);

    // ---- A split formula that fails leaves the earning unresolved and everything posted where it was ----
    const before = await ledger();
    await rules.savePaySplitRule(ORG, { ...sample("present_on_the_job"), definition: { ...sample("present_on_the_job").definition, code: "throw new Error('No roster yet');" } }, actor);
    const broken = await refresh(team);
    assert.equal(broken.posted.length, 0);
    assert.deepEqual(broken.unresolved.map((entry) => entry.unit).sort(), ["j1", "j2", "j3"]);
    assert.match(broken.unresolved[0]!.reason, /Present on the job: No roster yet/);
    assert.deepEqual(await ledger(), before);
    assert.deepEqual([(await unit(team, "j1")).status, (await unit(team, "j1")).lines[0]!.amount_cents, (await unit(team, "j1")).split!.members], ["error", 90_000, ["ana", "ben", "cara"]], "what it last worked out, and who shared it, is kept");
    await rules.savePaySplitRule(ORG, { ...sample("present_on_the_job"), definition: { ...sample("present_on_the_job").definition, code: "return { 'organization_user:zed': 1 };" } }, actor);
    assert.match((await refresh(team)).unresolved[0]!.reason, /organization_user:zed is not one of the members/);
    await rules.savePaySplitRule(ORG, sample("present_on_the_job"), actor);
    const mended = await refresh(team);
    assert.deepEqual([mended.evaluated, mended.posted.length, mended.unresolved.length], [3, 0, 0], "worked out again among the same members, it agrees with what was posted");
    assert.deepEqual(await ledger(), before);
    await quiet(team, 4);

    // ---- In proportion to approved hours on the job ----
    const roofers = { type: "resource_group" as const, id: await group("Roof team", "crew", ["ana", "ben"]) };
    await rules.savePaySetup(ORG, { payee: roofers, entries, distribution: [byRule("2026-01-01", "by_hours_on_the_job")] }, actor);
    job("h1", roofers.id, "p5", "12", 100_000);
    shift("h_a1", "ana", "p5", "11", "08:00", "14:00");
    shift("h_a2", "ana", "p5", "12", "08:00", "10:00");
    shift("h_b1", "ben", "p5", "12", "08:00", "10:30", "approved", 7200);
    shift("h_a3", "ana", "p5", "13", "08:00", "16:00");
    const hours = await refresh(roofers);
    assert.deepEqual(posted(hours), [["ana", "h1", 80_000], ["ben", "h1", 20_000]], "eight hours to two, over every day of the job up to the day it was earned, net of breaks; the shift the day after is not counted");
    assert.equal((hours.posted.find((entry) => (entry.payee as any).id === "ana")!.metadata as any).split.reason, "8.00 approved hours on this job");
    // A corrected shift moves the proportion; the parts still add up to the line.
    change("h_b1", { worked_seconds: 9000 });
    assert.deepEqual(posted(await refresh(roofers)), [["ana", "h1", -3_810], ["ben", "h1", 3_810]]);
    await quiet(roofers, 1);

    // ---- The whole team regardless, set once as a default; groups with a distribution of their own keep it ----
    await rules.savePayDefault(ORG, { subject: { type: "group_type", id: "crew" }, entries, distribution: [byRule("2026-01-01", "whole_team")] }, actor);
    const sales = { type: "resource_group" as const, id: await group("Sales team", "crew", ["ana", "cara"]) };
    job("c1", sales.id, "", "20", 50_001);
    const commission = await refresh(sales);
    assert.deepEqual(posted(commission), [["ana", "c1", 25_001], ["cara", "c1", 25_000]], "nobody clocked anything and both share; the odd cent goes to someone");
    assert.equal((commission.posted[0]!.metadata as any).split.reason, "Member of the team");
    await quiet(sales, 1);
    await quiet(team, 4);
  } finally {
    await store.closePayrollDatabase().catch(() => undefined);
    await rm(root, { recursive: true, force: true }).catch(() => undefined);
  }
});
