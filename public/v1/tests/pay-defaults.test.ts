import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const ORG = "org_pay_defaults";
const AS_OF = "2026-06-30T12:00:00.000Z";

test("defaults give each kind of payee a starting pay, and a group is paid as one or split among its members", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "pay-defaults-"));
  Object.assign(process.env, { NODE_ENV: "test", FIRSTMATE_ENV: "test", PLATFORM_STORAGE_ROOT: root, FIRSTMEASURE_DATABASE_MODE: "local", FIRSTMEASURE_INDEX_DB_PATH: path.join(root, "index.sqlite") });
  const core = await import("../platform/storage.js");
  const store = await import("../payroll/storage.js");
  const rules = await import("../payroll/pay-rules.js");
  const engine = await import("../payroll/pay-refresh.js");
  const workforce = await import("../workforce/storage.js");
  const { registerDataProvider } = await import("../platform/publication/providers.js");
  const { userPublicationContext } = await import("../platform/publication/context.js");
  try {
    await core.createOrganization({ id: ORG, name: "Pay defaults" });
    for (const [id, classification] of [["ana", "employee"], ["ben", "employee"], ["cara", "employee"], ["dan", "independent_contractor"], ["owner", "employee"]] as [string, string][]) {
      await core.upsertDocument(ORG, "users", { id, data: { name: id.charAt(0).toUpperCase() + id.slice(1), status: "active", worker_classification: classification } });
    }
    const crew = (await workforce.createResourceGroup(ORG, { name: "Install team", kind_id: "crew" })).id as string;
    const addMember = async (groupId: string, userId: string) => workforce.putResourceGroupMember(ORG, groupId, userId, { role: "member", expected_revision: Number((await workforce.readResourceGroup(ORG, groupId)).revision) });
    for (const id of ["ana", "ben"]) await addMember(crew, id);
    const schedule = await store.createPayrollSchedule(ORG, { name: "Weekly", recurrence: { frequency: "weekly", weekday: 5 }, timezone: "UTC" });
    await store.savePayrollPolicy(ORG, "organization", ORG, { schedule_id: schedule.id });

    const jobs: Record<string, any>[] = [
      { id: "j1", revision: 1, assignee_key: `resource_group:${crew}`, done_at: "2026-06-03T15:00:00.000Z", pay_cents: 100_001 },
      { id: "j2", revision: 1, assignee_key: `resource_group:${crew}`, done_at: "2026-06-17T15:00:00.000Z", pay_cents: 90_000 }
    ];
    const access = { scopes: ["organization"] as const, permissions: [] };
    registerDataProvider({ id: "pay-defaults-test", version: "1", apps: [], exports: {
      jobs: { schema: { type: "array", items: { type: "object", additionalProperties: true } }, schemaVersion: "1", description: "test", access, read: async () => ({ value: jobs }) }
    } });
    const context = userPublicationContext({ orgId: ORG, userId: "owner", role: "member", permissions: { manage_payroll: true }, applicationAccess: { management: { enabled: true, permissions: { "*": true } } } } as any);
    const actor = { userId: "owner" };
    const user = (id: string) => ({ type: "organization_user" as const, id }), team = { type: "resource_group" as const, id: crew };
    const ledger = async (id: string) => (await store.listPayrollLedgerEntries(ORG, { limit: 1000 })).filter((entry) => entry.payee.id === id);
    const total = async (id: string, state = "accrued") => (await ledger(id)).filter((entry) => entry.state === state).reduce((sum, entry) => sum + entry.amount_cents, 0);

    await rules.savePayRule(ORG, { id: "stipend", name: "Monthly stipend", effective_from: "2026-01-01", definition: {
      grain: "period", period: "month", always: true, kind: "salary", inputs: {}, parameters: { cents: { default: 10_000 } }, code: "return params.cents;" } }, actor);
    await rules.savePayRule(ORG, { id: "retainer", name: "Contractor retainer", effective_from: "2026-01-01", definition: {
      grain: "period", period: "month", always: true, kind: "piece_rate", inputs: {}, parameters: { cents: { default: 50_000 } }, code: "return params.cents;" } }, actor);
    await rules.savePayRule(ORG, { id: "job_pay", name: "Job pay", effective_from: "2026-01-01", definition: {
      grain: "record", kind: "piece_rate", earned_at: "done_at", parameters: {},
      inputs: { jobs: { primary: true, source: { provider: "pay-defaults-test", export: "jobs" }, where: { rules: [{ field: "assignee_key", operator: "equals", value: "$payee.key" }] } } },
      code: "return unit.record.pay_cents;" } }, actor);

    // ---- Defaults ----
    await assert.rejects(() => rules.savePayDefault(ORG, { subject: { type: "organization", id: "someone_else" }, entries: [] }, actor), /this organization/);
    await assert.rejects(() => rules.savePayDefault(ORG, { subject: { type: "assignee_kind", id: "robots" }, entries: [] }, actor), /users, groups/);
    await assert.rejects(() => rules.savePayDefault(ORG, { subject: { type: "worker_classification", id: "employee" }, entries: [], distribution: [{ effective_from: "2026-01-01", mode: "split", method: "equal" }] }, actor), /Only a group/);
    // Every user gets the stipend from May; contractors get a retainer as well; nobody has a setup of their own yet.
    await rules.savePayDefault(ORG, { subject: { type: "assignee_kind", id: "organization_user" }, entries: [{ kind: "add", rule_id: "stipend", effective_from: "2026-05-01" }] }, actor);
    await rules.savePayDefault(ORG, { subject: { type: "worker_classification", id: "independent_contractor" }, entries: [{ kind: "add", rule_id: "retainer", effective_from: "2026-05-01" }] }, actor);
    // Cara's own setup raises her stipend; Ben's takes it away from June. Both sit on top of the default instead of replacing it.
    await rules.savePaySetup(ORG, { payee: user("cara"), entries: [{ kind: "override", rule_id: "stipend", params: { cents: 25_000 }, effective_from: "2026-05-01" }] }, actor);
    await rules.savePaySetup(ORG, { payee: user("ben"), entries: [{ kind: "remove", rule_id: "stipend", effective_from: "2026-06-01" }] }, actor);
    assert.deepEqual((await rules.payLayersFor(ORG, user("dan"))).map((layer) => layer.source ? `${layer.source.type}:${layer.source.id}` : "own"),
      ["assignee_kind:organization_user", "worker_classification:independent_contractor", "own"]);
    assert.deepEqual((await engine.payeesWithPay(ORG)).map((payee) => payee.id).sort(), ["ana", "ben", "cara", "dan", "owner"], "a default covers people who have no setup of their own; the group and nobody else has no pay yet");

    const everyone = await engine.refreshOrganizationEarnings(ORG, { context, asOf: AS_OF });
    assert.equal(everyone.unresolved_count, 0, JSON.stringify(everyone.payees.flatMap((entry) => entry.unresolved)));
    assert.equal(await total("ana"), 10_000, "May; June is not over");
    assert.equal(await total("cara"), 25_000);
    assert.equal(await total("ben"), 10_000, "May only: his own setup removes the rule from June, which matters next month");
    assert.equal(await total("dan"), 60_000, "the stipend every user gets and the contractor retainer add up");
    const nextMonth = await engine.refreshOrganizationEarnings(ORG, { context, asOf: "2026-07-01T12:00:00.000Z" });
    assert.deepEqual(nextMonth.payees.filter((entry) => entry.posted.length).map((entry) => entry.payee.id).sort(), ["ana", "cara", "dan", "owner"]);
    assert.equal(await total("ben"), 10_000);

    // ---- A group paid as one, then split ----
    await assert.rejects(() => rules.savePaySetup(ORG, { payee: user("ana"), entries: [], distribution: [{ effective_from: "2026-01-01", mode: "split", method: "equal" }] }, actor), /Only a group/);
    await rules.savePaySetup(ORG, { payee: team, entries: [{ kind: "add", rule_id: "job_pay", effective_from: "2026-01-01" }] }, actor);
    const asOne = await engine.refreshPayeeEarnings(ORG, team, { context, asOf: AS_OF });
    assert.deepEqual(asOne.posted.map((entry) => [(entry.payee as any).type, entry.amount_cents]), [["resource_group", 100_001], ["resource_group", 90_000]]);

    // From the 10th the team's pay is split equally among its members. The job before that date stays paid to the team.
    const before = { ana: await total("ana"), ben: await total("ben"), cara: await total("cara") };
    await rules.savePaySetup(ORG, { payee: team, entries: [{ kind: "add", rule_id: "job_pay", effective_from: "2026-01-01" }], distribution: [{ effective_from: "2026-06-10", mode: "split", method: "equal" }] }, actor);
    const split = await engine.refreshPayeeEarnings(ORG, team, { context, asOf: AS_OF });
    assert.deepEqual(split.posted.map((entry) => [(entry.payee as any).id, entry.amount_cents]).sort(), [["ana", 45_000], ["ben", 45_000], [crew, -90_000]].sort(),
      "the later job moves from the team to its two members; nothing about the earlier job changes");
    assert.equal(await total(crew), 100_001);
    assert.deepEqual((split.posted.find((entry) => (entry.payee as any).id === "ana")!.metadata as any).split, { of: `resource_group:${crew}`, line_cents: 90_000, members: 2 });
    assert.ok((await engine.listPayUnits(ORG, team)).find((unit) => unit.unit === "j2")!.split_among!.length === 2);

    // Someone joining later shares new work only: who shared an earning was fixed when it was worked out.
    await addMember(crew, "cara");
    jobs.push({ id: "j3", revision: 1, assignee_key: `resource_group:${crew}`, done_at: "2026-06-24T15:00:00.000Z", pay_cents: 100_000 });
    jobs[1]!.revision = 2; jobs[1]!.pay_cents = 90_010;
    const joined = await engine.refreshPayeeEarnings(ORG, team, { context, asOf: AS_OF });
    assert.deepEqual(joined.posted.map((entry) => [(entry.payee as any).id, (entry.metadata as any).pay_rule.unit, entry.amount_cents]).sort(),
      [["ana", "j2", 5], ["ben", "j2", 5], ["ana", "j3", 33_334], ["ben", "j3", 33_333], ["cara", "j3", 33_333]].sort(), "odd cents go to someone, and the parts always add up");
    assert.equal(await total("ana") - before.ana + await total("ben") - before.ben + await total("cara") - before.cara, 90_010 + 100_000);

    // Fixed shares from a later date, and a job that stops being the team's is taken back from whoever was paid for it.
    await rules.savePaySetup(ORG, { payee: team, entries: [{ kind: "add", rule_id: "job_pay", effective_from: "2026-01-01" }], distribution: [
      { effective_from: "2026-06-10", mode: "split", method: "equal" }, { effective_from: "2026-06-26", mode: "split", method: "shares", shares: { ana: 3, ben: 1 } }] }, actor);
    jobs.push({ id: "j4", revision: 1, assignee_key: `resource_group:${crew}`, done_at: "2026-06-27T15:00:00.000Z", pay_cents: 40_000 });
    jobs[2]!.assignee_key = "resource_group:someone_else"; jobs[2]!.revision = 2;
    const shares = await engine.refreshPayeeEarnings(ORG, team, { context, asOf: AS_OF });
    assert.deepEqual(shares.posted.map((entry) => [(entry.payee as any).id, (entry.metadata as any).pay_rule.unit, entry.amount_cents]).sort(),
      [["ana", "j4", 30_000], ["ben", "j4", 10_000], ["ana", "j3", -33_334], ["ben", "j3", -33_333], ["cara", "j3", -33_333]].sort());
    assert.equal((await engine.refreshPayeeEarnings(ORG, team, { context, asOf: AS_OF })).posted.length, 0);
    assert.deepEqual([...engine.splitCentsByWeight(-100, [{ id: "a", weight: 1 }, { id: "b", weight: 1 }, { id: "c", weight: 1 }])].sort(), [["a", -34], ["b", -33], ["c", -33]]);

    // A kind of group can default to being split, so each new group of that kind does not have to be set up.
    await rules.savePayDefault(ORG, { subject: { type: "group_kind", id: "crew" }, entries: [{ kind: "add", rule_id: "job_pay", effective_from: "2026-01-01" }], distribution: [{ effective_from: "2026-01-01", mode: "split", method: "equal" }] }, actor);
    const second = (await workforce.createResourceGroup(ORG, { name: "Second team", kind_id: "crew" })).id as string;
    jobs.push({ id: "j5", revision: 1, assignee_key: `resource_group:${second}`, done_at: "2026-06-20T15:00:00.000Z", pay_cents: 20_000 });
    const empty = await engine.refreshPayeeEarnings(ORG, { type: "resource_group", id: second }, { context, asOf: AS_OF });
    assert.deepEqual([empty.posted.length, empty.unresolved.map((entry) => entry.reason)], [0, ["This group has no active members to split its pay among."]], "nobody to pay is reported, not paid to nobody");
    await addMember(second, "dan");
    const filled = await engine.refreshPayeeEarnings(ORG, { type: "resource_group", id: second }, { context, asOf: AS_OF });
    assert.deepEqual(filled.posted.map((entry) => [(entry.payee as any).id, entry.amount_cents]), [["dan", 20_000]]);
  } finally {
    await store.closePayrollDatabase().catch(() => undefined);
    await rm(root, { recursive: true, force: true }).catch(() => undefined);
  }
});
