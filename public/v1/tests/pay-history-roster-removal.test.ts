import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test, { after } from "node:test";

/*
 * The pay-rules.md gaps closed together (docs/architecture/pay-rules.md): group membership has dates, so a split uses
 * who was a member on the day an earning was earned; split rules read the published schedule roster; rules that pay by
 * period are projected from scheduled shifts and by day; a removed payee is paid through their last day; previews say
 * which pay date each change lands on; and reports for dates are made from export templates.
 */
const ORG = "org_pay_gaps";
const AS_OF = "2026-06-30T12:00:00.000Z";
const root = await mkdtemp(path.join(os.tmpdir(), "pay-gaps-"));
Object.assign(process.env, {
  NODE_ENV: "test", FIRSTMATE_ENV: "test", PLATFORM_STORAGE_ROOT: root, FIRSTMEASURE_DATABASE_MODE: "local", FIRSTMEASURE_INDEX_DB_PATH: path.join(root, "index.sqlite"),
  PLATFORM_HEARTBEAT_DISABLED: "1", FIRSTMEASURE_JOB_WORKERS: "0", WORK_SCHEDULER_DISABLED: "1", APPOINTMENT_CONFIRMATIONS_DISABLED: "1", EMAIL_OUTBOUND_DISABLED: "1"
});
const core = await import("../platform/storage.js");
const store = await import("../payroll/storage.js");
const rules = await import("../payroll/pay-rules.js");
const engine = await import("../payroll/pay-refresh.js");
const workforce = await import("../workforce/storage.js");
const { SAMPLE_PAY_SPLIT_RULES, seedSamplePayRules } = await import("../payroll/sample-pay-rules.js");
const { registerDataProvider } = await import("../platform/publication/providers.js");
const { userPublicationContext } = await import("../platform/publication/context.js");
after(async () => { await store.closePayrollDatabase().catch(() => undefined); await rm(root, { recursive: true, force: true }).catch(() => undefined); });

const actor = { userId: "owner" };
const manager: any = { orgId: ORG, userId: "owner", role: "owner", permissions: { "*": true, manage_payroll: true }, branchId: "default", applicationAccess: { management: { enabled: true, permissions: { "*": true } } }, capabilities: { effectiveByKey: { "apps.payroll": true } }, accessProfile: { roles: [] } };
const context = userPublicationContext(manager);
// What a group is paid for, as a published collection a pay rule selects from.
const jobs: Record<string, any>[] = [];
let ready: Promise<{ schedule: string }> | null = null;
function setup() {
  return ready ||= (async () => {
    await core.createOrganization({ id: ORG, name: "Pay gaps" });
    await core.saveGlobal(ORG, { data: { timezone: "UTC" } }, { replace: false });
    const identity = await core.createIdentity({ email: "owner@gaps.test", name: "Owner", memberships: [{ organization_id: ORG, user_id: "owner", status: "active" }] });
    await core.upsertDocument(ORG, "users", { id: "owner", data: { name: "Owner", status: "active", role: "owner", identity_id: identity.id } });
    for (const id of ["ana", "ben", "cara", "dan", "eve"]) await core.upsertDocument(ORG, "users", { id, data: { name: id.charAt(0).toUpperCase() + id.slice(1), status: "active", worker_classification: "employee" } });
    const access = { scopes: ["organization"] as const, permissions: [] };
    registerDataProvider({ id: "pay-gaps-test", version: "1", apps: [], exports: { jobs: { schema: { type: "array", items: { type: "object", additionalProperties: true } }, schemaVersion: "1", description: "test", access, read: async () => ({ value: jobs }) } } });
    (await import("../platform/publication/bootstrap.js")).initializePublication();
    const schedule = await store.createPayrollSchedule(ORG, { name: "Weekly", recurrence: { frequency: "weekly", weekday: 5 }, timezone: "UTC" });
    await rules.savePayDefault(ORG, { subject: { type: "organization", id: ORG }, entries: [], schedules: [{ effective_from: "2026-01-01", schedule_id: schedule.id }] }, actor);
    await seedSamplePayRules(ORG, actor);
    await rules.savePayRule(ORG, { id: "job_pay", name: "Job pay", effective_from: "2026-01-01", definition: {
      grain: "record", kind: "piece_rate", earned_at: "done_at", project: "project_id", parameters: {},
      inputs: { jobs: { primary: true, source: { provider: "pay-gaps-test", export: "jobs" }, where: { rules: [{ field: "assignee_key", operator: "equals", value: "$payee.key" }] } } },
      code: "return unit.record.pay_cents;" } }, actor);
    return { schedule: schedule.id };
  })();
}
const job = (id: string, groupId: string, project: string, day: string, cents: number) => jobs.push({ id, revision: 1, assignee_key: `resource_group:${groupId}`, project_id: project, done_at: `2026-06-${day}T15:00:00.000Z`, pay_cents: cents });
const revision = async (groupId: string) => Number((await workforce.readResourceGroup(ORG, groupId)).revision);
const shares = (result: { posted: Record<string, any>[] }) => result.posted.map((entry) => [entry.payee.id, entry.metadata.pay_rule.unit, entry.amount_cents]).sort();
const entries = [{ kind: "add" as const, rule_id: "job_pay", effective_from: "2026-01-01" }];

test("a group's earning is shared by who was a member on the day it was earned, not by today's members", async () => {
  await setup();
  const crew = String((await workforce.createResourceGroup(ORG, { name: "Install team", kind_id: "crew" })).id);
  for (const user of ["ana", "cara"]) await workforce.putResourceGroupMember(ORG, crew, user, { role: "member", effective_from: "2026-01-01", expected_revision: await revision(crew) });
  // Ben joined on the 15th; Cara left on the 10th. Both are entered later, dated when they happened.
  await workforce.putResourceGroupMember(ORG, crew, "ben", { role: "member", effective_from: "2026-06-15", expected_revision: await revision(crew) });
  await workforce.removeResourceGroupMember(ORG, crew, "cara", await revision(crew), "2026-06-10");
  assert.deepEqual((await workforce.groupMembershipHistory(ORG, crew)).map((row: any) => [row.user_id, row.active_from, row.active_until]).sort(),
    [["ana", "2026-01-01", ""], ["ben", "2026-06-15", ""], ["cara", "2026-01-01", "2026-06-10"]]);
  assert.deepEqual((await workforce.membersOfGroupOn(ORG, crew, "2026-06-05")).sort(), ["ana", "cara"]);
  assert.deepEqual((await workforce.membersOfGroupOn(ORG, crew, "2026-06-10")).sort(), ["ana"], "a member who left on a day is not a member that day");
  assert.deepEqual((await workforce.membersOfGroupOn(ORG, crew, "2026-06-20")).sort(), ["ana", "ben"]);
  await assert.rejects(() => workforce.putResourceGroupMember(ORG, crew, "dan", { role: "member", effective_from: "2999-01-01", expected_revision: 0 }), /future|revision/);

  job("m1", crew, "p_m1", "05", 60_000);
  job("m2", crew, "p_m2", "20", 80_000);
  await rules.savePaySetup(ORG, { payee: { type: "resource_group", id: crew }, entries, distribution: [{ effective_from: "2026-01-01", mode: "split", method: "equal" }] }, actor);
  const result = await engine.refreshPayeeEarnings(ORG, { type: "resource_group", id: crew }, { context, asOf: AS_OF });
  assert.deepEqual(shares(result), [["ana", "m1", 30_000], ["ana", "m2", 40_000], ["ben", "m2", 40_000], ["cara", "m1", 30_000]],
    "Cara shares the job of the 5th and not the 20th; Ben the 20th and not the 5th");
});

test("split rules read who the schedule roster had on the job, and a preview says how it would divide and when it is paid", async () => {
  await setup();
  const roofers = String((await workforce.createResourceGroup(ORG, { name: "Roofers", kind_id: "crew" })).id);
  for (const user of ["dan", "eve"]) await workforce.putResourceGroupMember(ORG, roofers, user, { role: "member", effective_from: "2026-01-01", expected_revision: await revision(roofers) });
  // Only Dan is on the job's schedule that day; nobody clocked in on it.
  await core.upsertDocument(ORG, "projects", { id: "elm", data: { title: "9 Elm St", events: [
    { id: "elm_roof", title: "Roof", status: "scheduled", start_at: "2026-06-22T08:00:00.000Z", end_at: "2026-06-22T16:00:00.000Z", resource_refs: [{ kind: "organization_user", id: "dan", name: "Dan", role: "crew" }] }
  ] } });
  const { workRosterRows } = await import("../payroll/roster-sources.js");
  const roster = await workRosterRows(ORG, manager, { from: "2026-06-22T00:00:00.000Z", until: "2026-06-23T00:00:00.000Z" });
  assert.deepEqual(roster.map((row) => [row.assignee_key, row.project_id, row.event_id, row.from, row.until, row.seconds]), [["organization_user:dan", "elm", "elm_roof", "2026-06-22T08:00:00.000Z", "2026-06-22T16:00:00.000Z", 28_800]]);

  job("r1", roofers, "elm", "22", 50_000);
  const team = { type: "resource_group" as const, id: roofers };
  await rules.savePaySetup(ORG, { payee: team, entries, distribution: [{ effective_from: "2026-01-01", mode: "split", method: "rule", split_rule_id: "present_on_the_job" }] }, actor);
  const result = await engine.refreshPayeeEarnings(ORG, team, { context, asOf: AS_OF });
  assert.deepEqual(result.unresolved, []);
  assert.deepEqual(shares(result), [["dan", "r1", 50_000]], "Eve was not on this job that day");
  const unit = (await engine.listPayUnits(ORG, team)).find((entry) => entry.unit === "r1")!;
  assert.deepEqual(unit.split!.lines.main!.shares.map((share: any) => [share.id, share.weight, share.cents, share.reason]), [
    ["dan", 1, 50_000, "On the job's schedule for 8.00 hours that day"], ["eve", 0, 0, "Not on this job's schedule and no approved shift on it that day"]]);

  // Saving the whole-team way of dividing as a new version would move half to Eve, paid on the next Friday's run.
  const present = SAMPLE_PAY_SPLIT_RULES.find((rule) => rule.id === "present_on_the_job")!;
  const preview = await engine.previewPaySplitRuleSave(ORG, { id: "present_on_the_job", name: present.name, effective_from: "2026-01-01",
    definition: { inputs: {}, parameters: {}, code: "return Object.fromEntries(members.map((member) => [member.key, { weight: 1, reason: 'Everyone' }]));" } }, actor, { context, asOf: AS_OF });
  const group = preview.payees.find((entry: any) => entry.payee.id === roofers)!;
  assert.deepEqual(group.differences.map((difference: any) => [difference.payee, difference.change_cents, difference.pay_date, difference.schedule_name]).sort(), [
    ["organization_user:dan", -25_000, "2026-07-03", "Weekly"], ["organization_user:eve", 25_000, "2026-07-03", "Weekly"]]);
  assert.deepEqual((group as any).samples.map((sample: any) => [sample.unit, sample.lines.main.shares.map((share: any) => [share.id, share.cents, share.reason])]), [["r1", [["dan", 25_000, "Everyone"], ["eve", 25_000, "Everyone"]]]]);
  assert.equal(preview.changed_payee_count, 1);
  assert.deepEqual(shares(await engine.refreshPayeeEarnings(ORG, team, { context, asOf: AS_OF })), [], "a preview saves nothing");
});

test("rules that pay by period are projected: scheduled hours through the hourly rule and a salary by the day, never posted", async () => {
  await setup();
  // The time clock's projected reading is what is scheduled from now on, so this part runs on today's date.
  const now = new Date().toISOString(), today = now.slice(0, 10);
  const day = (offset: number) => new Date(Date.parse(`${today}T00:00:00.000Z`) + offset * 86_400_000).toISOString().slice(0, 10);
  const scheduled = day(2);
  const weekday = new Date(`${scheduled}T00:00:00.000Z`).getUTCDay();
  const weekEnds = day(2 + ((7 - weekday) % 7));
  const ana = { type: "organization_user" as const, id: "ana" };
  await rules.savePaySetup(ORG, { payee: ana, entries: [
    { kind: "add", rule_id: "hourly_time_clock", effective_from: "2026-01-01", params: { rate_cents: 3_000 } },
    { kind: "add", rule_id: "salary", effective_from: "2026-01-01", params: { annual_cents: 3_650_000 } }
  ] }, actor);
  await core.upsertDocument(ORG, "projects", { id: "oak", data: { title: "12 Oak St", events: [
    { id: "oak_roof", title: "Roof", status: "scheduled", start_at: `${scheduled}T08:00:00.000Z`, end_at: `${scheduled}T16:00:00.000Z`, resource_refs: [{ kind: "organization_user", id: "ana", name: "Ana", role: "crew" }] }
  ] } });
  const before = (await store.listPayrollLedgerEntries(ORG, { payee_id: "ana", limit: 1000 } as any)).length;
  const projection = await engine.projectPayeeEarnings(ORG, ana, { context, asOf: now });
  assert.deepEqual(projection.unresolved, []);
  const hourly = projection.earnings.filter((earning: any) => earning.rule_id === "hourly_time_clock");
  assert.deepEqual(hourly.map((earning: any) => [earning.expected_on, earning.amount_cents]), [[weekEnds, 24_000]], "the week with the scheduled day: eight hours at $30");
  const salary = projection.earnings.filter((earning: any) => earning.rule_id === "salary");
  assert.equal(salary[0]?.expected_on, today, "salary is projected from today");
  assert.ok(salary.every((earning: any) => earning.amount_cents === Math.round(3_650_000 / (Number(today.slice(0, 4)) % 4 === 0 ? 366 : 365))));
  assert.equal(salary.at(-1)!.expected_on, day(engine.PROJECTED_PERIOD_DAYS), `a day at a time to ${engine.PROJECTED_PERIOD_DAYS} days ahead`);
  assert.equal(salary.length, engine.PROJECTED_PERIOD_DAYS + 1);
  assert.equal((await store.listPayrollLedgerEntries(ORG, { payee_id: "ana", limit: 1000 } as any)).length, before, "a projection posts nothing");
});

test("a removed person is paid through their last day and nothing after, and the cleanup runs for users", async () => {
  await setup();
  const ben = { type: "organization_user" as const, id: "ben" };
  await rules.savePaySetup(ORG, { payee: ben, entries: [{ kind: "add", rule_id: "salary", effective_from: "2026-06-01", params: { annual_cents: 3_650_000 } }] }, actor);
  // Ben was archived on the 20th; the cleanup runs later. His salary stops on the 20th however late it runs.
  const { readDocument } = core;
  const data = (await readDocument(ORG, "users", "ben"))!.data as Record<string, unknown>;
  await core.upsertDocument(ORG, "users", { id: "ben", data: { ...data, deleted: true, deleted_at: "2026-06-20T15:00:00.000Z", status: "disabled", disabled: true } });
  const { cleanupAssignee } = await import("../assignees/base.js");
  await import("../payroll/assignee-cleanup.js").then((module) => module.registerPayrollAssigneeCleanup());
  const cleaned = await cleanupAssignee(ORG, ben, { orgId: ORG, userId: "owner", system: true } as any);
  const payroll = cleaned.steps.find((step: any) => step.name === "payroll-pay")!;
  assert.match(String((payroll as any).detail), /worked out through 2026-06-20, their last day \(20 new entries\)/);
  const salary = (await store.listPayrollLedgerEntries(ORG, { payee_id: "ben", limit: 1000 } as any)).filter((entry) => entry.kind === "salary");
  assert.equal(salary.length, 20);
  assert.equal(salary.reduce((sum, entry) => sum + entry.amount_cents, 0), 200_000, "June 1 through 20 at $100 a day");
  const later = await engine.refreshPayeeEarnings(ORG, ben, { context, asOf: "2026-07-31T12:00:00.000Z" });
  assert.deepEqual([later.posted.length, later.unresolved[0]?.reason], [0, "This payee is no longer available in the organization."]);
  assert.ok((await rules.readPaySetup(ORG, ben)).closed, "their pay setup is closed");
  const again = await cleanupAssignee(ORG, ben, { orgId: ORG, userId: "owner", system: true } as any);
  assert.ok(again.steps.length, "a second cleanup changes nothing and still reports");
  assert.equal((await store.listPayrollLedgerEntries(ORG, { payee_id: "ben", limit: 1000 } as any)).filter((entry) => entry.kind === "salary").length, 20);
});

test("reports for dates are made from templates, built-in or the company's own, as CSV and PDF", async () => {
  await setup();
  const exports = await import("../payroll/exports.js");
  const templates = await import("../payroll/export-templates.js");
  const csv = await exports.generatePayrollArtifact(ORG, { type: "earnings_ledger", format: "csv", from: "2026-06-01", through: "2026-06-30" }, "owner", undefined, manager);
  const artifact = (csv as any).artifact || csv;
  const metadata = (artifact as any).metadata;
  assert.deepEqual([metadata.scope_label, metadata.coverage_label, metadata.template.id], ["Date range", "Jun 1, 2026 through Jun 30, 2026", "earnings_ledger"]);
  assert.ok(Number(metadata.row_count) > 0, "June's earnings are in it");
  await assert.rejects(() => exports.generatePayrollArtifact(ORG, { type: "commissions", format: "csv" }, "owner", undefined, manager), /start date and end date/);
  const own = await templates.saveExportTemplate(ORG, { based_on: "earnings_ledger", definition: { name: "Salary by day", rows: "earning", kinds: ["salary"], people: ["employees"], sort: "none", group: "none", totals: "grand",
    columns: [{ header: "Who", source: "person.name" }, { header: "Day", source: "entry.earned_on" }, { header: "Amount", source: "entry.amount" }] } }, "owner");
  assert.equal(own.scope, "date_range");
  const pdf = await exports.generatePayrollArtifact(ORG, { template_id: own.id, format: "pdf", from: "2026-06-01", through: "2026-06-30" }, "owner", undefined, manager);
  const made = ((pdf as any).artifact || pdf) as any;
  assert.deepEqual([made.metadata.format, made.metadata.report_label, made.content_type || made.metadata.content_type], ["pdf", "Salary by day", "application/pdf"]);
  assert.ok(Number(made.metadata.row_count) >= 21, "Ben's twenty days and Ana's, and a total");
});
