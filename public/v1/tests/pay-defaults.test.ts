import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const ORG = "org_pay_defaults";
const AS_OF = "2026-06-30T12:00:00.000Z";

test("defaults give each kind of payee a starting pay and a schedule, roles and group types are layers, and a group is paid as one or split among its members", async () => {
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
    await (await import("../payroll/pay-rules.js")).savePayDefault(ORG, { subject: { type: "organization", id: ORG }, entries: [], schedules: [{ effective_from: "2026-01-01", schedule_id: schedule.id }] }, { userId: "owner" });

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
      [`organization:${ORG}`, "assignee_kind:organization_user", "worker_classification:independent_contractor", "own"], "the organization default carries the schedule everyone is paid on");
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
    await rules.savePayDefault(ORG, { subject: { type: "group_type", id: "crew" }, entries: [{ kind: "add", rule_id: "job_pay", effective_from: "2026-01-01" }], distribution: [{ effective_from: "2026-01-01", mode: "split", method: "equal" }] }, actor);
    const second = (await workforce.createResourceGroup(ORG, { name: "Second team", kind_id: "crew" })).id as string;
    jobs.push({ id: "j5", revision: 1, assignee_key: `resource_group:${second}`, done_at: "2026-06-20T15:00:00.000Z", pay_cents: 20_000 });
    const empty = await engine.refreshPayeeEarnings(ORG, { type: "resource_group", id: second }, { context, asOf: AS_OF });
    assert.deepEqual([empty.posted.length, empty.unresolved.map((entry) => entry.reason)], [0, ["This group has no active members to split its pay among."]], "nobody to pay is reported, not paid to nobody");
    await addMember(second, "dan");
    const filled = await engine.refreshPayeeEarnings(ORG, { type: "resource_group", id: second }, { context, asOf: AS_OF });
    assert.deepEqual(filled.posted.map((entry) => [(entry.payee as any).id, entry.amount_cents]), [["dan", 20_000]]);

    // ---- A user's roles are their types: every role's default applies, and a role taken away stops only what is earned afterwards ----
    await assert.rejects(() => rules.savePayDefault(ORG, { subject: { type: "role", id: "no_such_role" }, entries: [] }, actor), /role does not exist/);
    await assert.rejects(() => rules.savePayDefault(ORG, { subject: { type: "group_type", id: "no_such_kind" }, entries: [] }, actor), /type of group does not exist/);
    await assert.rejects(() => rules.savePayDefault(ORG, { subject: { type: "company_type", id: "no_such_type" }, entries: [] }, actor), /type of outside company does not exist/);
    await assert.rejects(() => rules.savePayDefault(ORG, { subject: { type: "role", id: "salesperson" }, entries: [], distribution: [{ effective_from: "2026-01-01", mode: "split", method: "equal" }] }, actor), /Only a group/);
    await assert.rejects(() => rules.savePayDefault(ORG, { subject: { type: "assignee_type", id: "crew" }, entries: [] }, actor), "the single assignee type is gone: roles, group types and company types took its place");
    // A parameter may say what it holds; a default that does not fit is refused.
    await assert.rejects(() => rules.savePayRule(ORG, { id: "bad_param", name: "Bad", effective_from: "2026-01-01", definition: { grain: "period", period: "month", always: true, inputs: {}, parameters: { cents: { type: "cents", default: 10.5 } }, code: "return 1;" } }, actor), /whole number of cents/);
    for (const [id, cents] of [["sales_bonus", 7_000], ["lead_bonus", 3_000]] as [string, number][]) await rules.savePayRule(ORG, { id, name: id, effective_from: "2026-01-01", definition: {
      grain: "period", period: "month", always: true, kind: "salary", inputs: {}, parameters: { cents: { label: "Monthly amount", type: "cents", default: cents } }, code: "return params.cents;" } }, actor);
    assert.equal((await rules.readPayRule(ORG, "sales_bonus")).versions[0]!.definition.parameters.cents!.type, "cents");
    const salesBonus = [{ kind: "add" as const, rule_id: "sales_bonus", effective_from: "2026-05-01" }];
    await rules.savePayDefault(ORG, { subject: { type: "role", id: "salesperson" }, entries: salesBonus }, actor);
    await rules.savePayDefault(ORG, { subject: { type: "role", id: "supervisor" }, entries: [{ kind: "add", rule_id: "lead_bonus", effective_from: "2026-05-01" }] }, actor);
    const eveWith = (roles: string[]) => core.upsertDocument(ORG, "users", { id: "eve", data: { name: "Eve", status: "active", worker_classification: "employee", access_role_ids: roles } });
    await eveWith(["supervisor", "salesperson"]);
    const eve = user("eve");
    assert.deepEqual((await rules.payDefaultSubjectsFor(ORG, eve)).map((subject) => `${subject.type}:${subject.id}`),
      [`organization:${ORG}`, "assignee_kind:organization_user", "worker_classification:employee", "role:salesperson", "role:supervisor"], "several roles apply together, in order of id");
    const byRule = (result: { posted: Record<string, any>[] }) => result.posted.map((entry) => [entry.metadata.pay_rule.rule_id, entry.metadata.pay_rule.unit, entry.amount_cents]).sort();
    assert.deepEqual(byRule(await engine.refreshPayeeEarnings(ORG, eve, { context, asOf: AS_OF })), [["lead_bonus", "2026-05-01", 3_000], ["sales_bonus", "2026-05-01", 7_000], ["stipend", "2026-05-01", 10_000]],
      "both roles' defaults pay her, on top of what every user gets");

    // Someone with no roles saved still resolves to one, and is paid by that role's default: the layers ask the assignee base, not the record.
    await core.upsertDocument(ORG, "users", { id: "fay", data: { name: "Fay", status: "active", worker_classification: "employee" } });
    const inferred = await (await import("../assignees/base.js")).assigneeTypeIds(ORG, user("fay"));
    assert.equal(inferred.length, 1, "a user with no saved roles resolves to one inferred role");
    assert.equal((await rules.payDefaultSubjectsFor(ORG, user("fay"))).at(-1)!.id, inferred[0]);
    await rules.savePayRule(ORG, { id: "inferred_bonus", name: "Inferred role bonus", effective_from: "2026-01-01", definition: { grain: "period", period: "month", always: true, kind: "salary", inputs: {}, parameters: {}, code: "return 1234;" } }, actor);
    await rules.savePayDefault(ORG, { subject: { type: "role", id: inferred[0]! }, entries: [{ kind: "add", rule_id: "inferred_bonus", effective_from: "2026-06-01" }] }, actor);
    assert.ok(byRule(await engine.refreshPayeeEarnings(ORG, user("fay"), { context, asOf: "2026-07-01T12:00:00.000Z" })).some(([rule, unit, cents]) => rule === "inferred_bonus" && unit === "2026-06-01" && cents === 1234));

    // The supervisor role is taken away. A role has no history, so payroll notices at the next refresh, on July 1: she is
    // covered through June 30. May and June were earned while she held the role and stay hers; July is not paid by it.
    await eveWith(["salesperson"]);
    assert.deepEqual(byRule(await engine.refreshPayeeEarnings(ORG, eve, { context, asOf: "2026-07-01T12:00:00.000Z" })), [["lead_bonus", "2026-06-01", 3_000], ["sales_bonus", "2026-06-01", 7_000], ["stipend", "2026-06-01", 10_000]]);
    assert.deepEqual(byRule(await engine.refreshPayeeEarnings(ORG, eve, { context, asOf: "2026-08-01T12:00:00.000Z" })), [["sales_bonus", "2026-07-01", 7_000], ["stipend", "2026-07-01", 10_000]],
      "only new earnings from the role she lost stop; the role she kept still pays");
    const leadBonus = (await ledger("eve")).filter((entry) => (entry.metadata as any).pay_rule.rule_id === "lead_bonus");
    assert.deepEqual(leadBonus.map((entry) => [entry.state, entry.amount_cents]), [["accrued", 3_000], ["accrued", 3_000]], "nothing posted under the lost role is edited or taken back");
    assert.deepEqual((await rules.payLayersFor(ORG, eve)).filter((layer) => layer.source?.type === "role").map((layer) => [layer.source!.id, layer.covered_from || "", layer.covered_through || ""]),
      [["salesperson", "", ""], ["supervisor", "", "2026-06-30"]]);

    // ---- A preview says what a change would do to everyone it reaches, and changes nothing ----
    const posted = async () => (await store.listPayrollLedgerEntries(ORG, { limit: 5000 })).length;
    const entriesBefore = await posted();
    const august = { context, asOf: "2026-08-01T12:00:00.000Z" };
    const raise = await engine.previewPayDefaultSave(ORG, { subject: { type: "role", id: "salesperson" }, entries: [{ kind: "add", rule_id: "sales_bonus", params: { cents: 9_000 }, effective_from: "2026-05-01" }] }, actor, august);
    assert.deepEqual([raise.payee_count, raise.changed_payee_count, raise.change_cents, raise.difference_count], [1, 1, 6_000, 3], "three months at 2,000 more, for the one person with the role");
    assert.equal(raise.payees[0]!.payee_name, "Eve");
    // A new version of a rule from July: everyone the rule pays, except Cara, whose own setup fixes her amount, and Ben, who has it removed.
    const version = await engine.previewPayRuleSave(ORG, { id: "stipend", name: "Monthly stipend", effective_from: "2026-07-01", definition: {
      grain: "period", period: "month", always: true, kind: "salary", inputs: {}, parameters: { cents: { default: 12_000 } }, code: "return params.cents;" } }, actor, august);
    assert.deepEqual(version.payees.map((entry) => [entry.payee.id, entry.change_cents]).sort(), [["ana", 2_000], ["dan", 2_000], ["eve", 2_000], ["fay", 2_000], ["owner", 2_000]]);
    assert.equal(version.change_cents, 10_000);
    assert.ok(version.payees.every((entry) => entry.differences.every((difference) => difference.unit === "2026-07-01")), "only July is touched: what is waiting to be posted for other reasons is not blamed on the change");
    assert.equal(await posted(), entriesBefore, "a preview posts nothing");
    assert.equal((await rules.readPayRule(ORG, "stipend")).versions.length, 1, "and saves nothing");
    assert.deepEqual((await rules.readPayDefault(ORG, { type: "role", id: "salesperson" })).entries.map((entry) => (entry as any).params), [undefined]);

    // Given back later, the role pays from the day payroll noticed, not for the months she did not have it.
    await eveWith(["supervisor", "salesperson"]);
    assert.deepEqual(byRule(await engine.refreshPayeeEarnings(ORG, eve, { context, asOf: "2026-09-01T12:00:00.000Z" })), [["sales_bonus", "2026-08-01", 7_000], ["stipend", "2026-08-01", 10_000]]);
    assert.deepEqual(byRule(await engine.refreshPayeeEarnings(ORG, eve, { context, asOf: "2026-10-01T12:00:00.000Z" })), [["lead_bonus", "2026-09-01", 3_000], ["sales_bonus", "2026-09-01", 7_000], ["stipend", "2026-09-01", 10_000]]);

    // ---- When someone is paid comes through the same layers as what they are paid ----
    const monthly = await store.createPayrollSchedule(ORG, { name: "Monthly", recurrence: { frequency: "monthly", day: 1 }, timezone: "UTC", clawback_cap_percent: 80 });
    await rules.savePayDefault(ORG, { subject: { type: "role", id: "salesperson" }, entries: salesBonus, schedules: [{ effective_from: "2026-01-01", earning_kind: "commission", schedule_id: monthly.id, timing_basis: "completed" }] }, actor);
    const paidOn = async (kind: string, date: string) => { const found = await rules.resolvePaySchedule(ORG, eve, kind, date); return found && [found.schedule.name, found.source ? `${found.source.type}:${found.source.id}` : "own", found.timing_basis, found.clawback_cap_percent]; };
    assert.deepEqual(await paidOn("commission", "2026-06-15"), ["Monthly", "role:salesperson", "completed", null], "her role pays commissions monthly");
    assert.deepEqual(await paidOn("hourly", "2026-06-15"), ["Weekly", `organization:${ORG}`, "", null], "the role says nothing about hours, so the organization's default answers");
    // Her own choice from July is a catch-all: it is the highest layer that says, so it wins over the role's choice for commissions too.
    await rules.savePaySetup(ORG, { payee: eve, entries: [], schedules: [{ effective_from: "2026-07-01", schedule_id: monthly.id, clawback_cap_percent: 25 }] }, actor);
    assert.deepEqual(await paidOn("commission", "2026-06-15"), ["Monthly", "role:salesperson", "completed", null], "a dated choice does not reach back before it starts");
    assert.deepEqual(await paidOn("commission", "2026-07-15"), ["Monthly", "own", "", 25]);
    assert.deepEqual(await paidOn("hourly", "2026-07-15"), ["Monthly", "own", "", 25]);
    await assert.rejects(() => rules.savePaySetup(ORG, { payee: eve, entries: [], schedules: [{ effective_from: "2026-07-01", schedule_id: monthly.id }, { effective_from: "2026-07-01", schedule_id: schedule.id }] }, actor), /start on the same day/);
    // Saving rules without mentioning schedules keeps them; an empty list goes back to what the defaults say.
    await rules.savePaySetup(ORG, { payee: eve, entries: [] }, actor);
    assert.equal((await rules.readPaySetup(ORG, eve)).schedules!.length, 1);
    await rules.savePaySetup(ORG, { payee: eve, entries: [], schedules: [] }, actor);
    assert.equal((await rules.readPaySetup(ORG, eve)).schedules, undefined);
    assert.deepEqual(await paidOn("hourly", "2026-07-15"), ["Weekly", `organization:${ORG}`, "", null]);

    // ---- Removing someone keeps everything they were paid and are owed, and stops working out anything new ----
    const { cleanupAssignee } = await import("../assignees/base.js");
    await import("../payroll/assignee-cleanup.js");
    const benBefore = { entries: (await ledger("ben")).length, total: await total("ben"), setup: (await rules.readPaySetup(ORG, user("ben"))).entries.length, units: (await engine.listPayUnits(ORG, user("ben"))).length };
    await assert.rejects(() => cleanupAssignee(ORG, user("ben"), { orgId: ORG, userId: "owner", system: true }), /has not been removed/);
    await core.upsertDocument(ORG, "users", { id: "ben", data: { name: "Ben", status: "archived", worker_classification: "employee" } });
    const cleaned = (await cleanupAssignee(ORG, user("ben"), { orgId: ORG, userId: "owner", system: true })).steps.find((step) => step.name === "payroll-pay")!;
    assert.deepEqual([cleaned.removed, cleaned.kept, cleaned.error], [0, benBefore.entries + benBefore.units + 1, ""]);
    assert.match(cleaned.detail, /Kept \d+ ledger entr(y|ies), \d+ worked-out results?, their pay setup, now closed\..*No new earnings are worked out for them\./);
    const benSetup = await rules.readPaySetup(ORG, user("ben"));
    assert.deepEqual([benSetup.entries.length, !!benSetup.closed, (await ledger("ben")).length, await total("ben"), (await engine.listPayUnits(ORG, user("ben"))).length], [benBefore.setup, true, benBefore.entries, benBefore.total, benBefore.units]);
    assert.equal((await engine.payeesWithPay(ORG)).some((payee) => payee.id === "ben"), false);
    const gone = await engine.refreshPayeeEarnings(ORG, user("ben"), { context, asOf: "2026-10-01T12:00:00.000Z" });
    assert.deepEqual([gone.posted.length, gone.differences.length], [0, 0], "nothing is taken back either");
  } finally {
    await store.closePayrollDatabase().catch(() => undefined);
    await rm(root, { recursive: true, force: true }).catch(() => undefined);
  }
});
