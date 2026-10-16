// Projected earnings: the payee's own pay rules over labor that is committed or assigned but not done yet. Never
// posted, never in a pay run, unresolved stays unresolved, and only the payee (with the permission) or a payroll
// manager may see them.
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const ORG = "org_pay_projections";

test("a committed labor list is projected through the payee's pay rule, dated by its schedule, and never posted", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "pay-projections-"));
  Object.assign(process.env, { NODE_ENV: "test", FIRSTMATE_ENV: "test", PLATFORM_STORAGE_ROOT: root, FIRSTMEASURE_DATABASE_MODE: "local", FIRSTMEASURE_INDEX_DB_PATH: path.join(root, "index.sqlite") });
  const core = await import("../platform/storage.js");
  const store = await import("../payroll/storage.js");
  const rules = await import("../payroll/pay-rules.js");
  const engine = await import("../payroll/pay-refresh.js");
  const { seedSamplePayRules } = await import("../payroll/sample-pay-rules.js");
  const { saveCapabilityValues } = await import("../platform/capabilities.js");
  const { userPublicationContext } = await import("../platform/publication/context.js");
  const { readPublishedData } = await import("../platform/publication/providers.js");
  const { invokeAction } = await import("../platform/publication/actions.js");
  const { selectPublishedData } = await import("../platform/publication/select.js");
  try {
    await core.createOrganization({ id: ORG, name: "Pay projections" });
    await saveCapabilityValues(ORG, { "platform.expanded_access": true, "apps.payroll": true, "payroll.self_service_earnings": true, "platform.materials": true, "platform.money": true });
    // The owner saves the rules; reads behind a projection run as them, as a refresh's do.
    const identity = await core.createIdentity({ email: "owner@projections.test", name: "Owner", memberships: [{ organization_id: ORG, user_id: "owner", status: "active" }] });
    await core.upsertDocument(ORG, "users", { id: "owner", data: { name: "Owner", status: "active", role: "owner", identity_id: identity.id } });
    for (const [id, name] of [["ana", "Ana"], ["ben", "Ben"]]) await core.upsertDocument(ORG, "users", { id, data: { name, status: "active", worker_classification: "employee" } });
    const workforce = await import("../workforce/storage.js");
    const team = (await workforce.createResourceGroup(ORG, { name: "Install team", kind_id: "crew" })).id as string;
    for (const member of ["ana", "ben"]) await workforce.putResourceGroupMember(ORG, team, member, { role: "member", expected_revision: Number((await workforce.readResourceGroup(ORG, team)).revision) });
    const schedule = await store.createPayrollSchedule(ORG, { name: "Weekly", recurrence: { frequency: "weekly", weekday: 5 }, timezone: "UTC" });
    await rules.savePayDefault(ORG, { subject: { type: "organization", id: ORG }, entries: [], schedules: [{ effective_from: "2026-01-01", schedule_id: schedule.id }] }, { userId: "owner" });
    (await import("../platform/publication/bootstrap.js")).initializePublication();
    const capabilities = { effectiveByKey: { "apps.payroll": true, "payroll.self_service_earnings": true } };
    const manager: any = { orgId: ORG, userId: "owner", role: "member", permissions: { manage_payroll: true }, applicationAccess: { management: { enabled: true, permissions: { "*": true } } }, capabilities };
    const context = userPublicationContext(manager), command = userPublicationContext(manager, { mode: "command" });
    const target = { scope: "organization" as const, organizationId: ORG };

    // ---- Labor: one finalized (earned), one taken back, one committed and scheduled, one with an unpriced line, one list never committed ----
    await core.upsertDocument(ORG, "projects", { id: "p1", data: { title: "Maple St", events: [{ id: "ev_roof", title: "Tear-off", status: "scheduled", start_at: "2026-07-14T14:00:00.000Z", end_at: "2026-07-15T22:00:00.000Z" }] } });
    await core.upsertDocument(ORG, "projects", { id: "p2", data: { title: "Oak Ave" } });
    const ana = { type: "organization_user" as const, id: "ana" }, group = { type: "resource_group" as const, id: team };
    const commitment = (id: string, assignee: { type: string; id: string }, status: string, total: number, extra: Record<string, unknown> = {}) => core.upsertDocument(ORG, "labor_commitments", { id, data: {
      list_id: `list_${id}`, project_id: "p1", project_title: "Maple St", title: `Labor ${id}`, revision: 1, status, unit: null, assignee: { ...assignee, name: assignee.id }, lines: [], total_cents: total, unpriced_lines: 0,
      pay_sheets: [], schedule: null, note: "", list_revision: 1, content_hash: id, idempotency_key: "", committed_by_user_id: "owner", committed_at: "2026-06-01T12:00:00.000Z",
      delivery: { method: "share", status: "delivered", detail: "", steps: [] }, ...(status === "released" ? { released_at: "2026-06-10T12:00:00.000Z", release_reason: "Finished" } : {}), ...extra
    } });
    await commitment("c_done", ana, "committed", 100_000);
    const finalize = (id: string, at: string) => core.upsertDocument(ORG, "labor_completions" as any, { id: `completion_${id}`, data: { commitment_id: id, list_id: `list_${id}`, project_id: "p1", state: "finalized", finalized_at: at, finalized_by_user_id: "owner", method: "approve", history: [] } });
    await finalize("c_done", "2026-06-10T12:00:00.000Z");
    await commitment("c_taken", ana, "released", 70_000);
    await commitment("c_open", ana, "committed", 90_000);
    await core.upsertDocument(ORG, "material_lists", { id: "list_c_open", data: { organization_id: ORG, project_id: "p1", resource_type: "labor", title: "Tear-off labor", status: "active", schedule: { event_id: "ev_roof" }, current_items: [{ id: "i1", name: "Tear-off", quantity: 30, projected_unit_price: 30 }] } });
    await commitment("c_unpriced", ana, "committed", 20_000, { unpriced_lines: 1, schedule: { start_at: "2026-08-03T14:00:00.000Z", end_at: "2026-08-03T22:00:00.000Z" } });
    await core.upsertDocument(ORG, "material_lists", { id: "list_new", data: { organization_id: ORG, project_id: "p2", resource_type: "labor", title: "Gutter labor", status: "active",
      assignment: { work_resource_ref: { kind: "organization_user", id: "ana", name: "Ana" } }, current_items: [{ id: "g1", name: "Gutters", quantity: 2, projected_unit_price: 250 }] } });
    await commitment("c_team", group, "committed", 60_000, { schedule: { end_at: "2026-07-20T22:00:00.000Z" } });

    // The published projected reading: work not done yet, each row as it is expected to look once done.
    const projectedRows = await selectPublishedData(context, { provider: "payroll", export: "labor_commitments", target, args: { projected: true } }, {});
    if (projectedRows.status !== "ready") throw Error(`expected rows: ${JSON.stringify(projectedRows)}`);
    const byId = new Map(projectedRows.rows.map((row) => [row.key, row.value as any]));
    assert.deepEqual([...byId.keys()].sort(), ["c_open", "c_team", "c_unpriced", "labor_list:list_new"], "finalized work is earned and work taken back is gone; neither is projected");
    // Each as finished work looks: still committed, finalized on the day its schedule ends.
    assert.deepEqual([byId.get("c_open").status, byId.get("c_open").finalized_at, byId.get("c_open").expected_from, byId.get("c_open").projected], ["committed", "2026-07-15T22:00:00.000Z", "schedule_event", true]);
    assert.deepEqual([byId.get("c_unpriced").finalized_at, byId.get("c_unpriced").expected_from], ["2026-08-03T22:00:00.000Z", "commitment"]);
    assert.deepEqual([byId.get("labor_list:list_new").total_cents, byId.get("labor_list:list_new").finalized_at, byId.get("labor_list:list_new").projected_from], [50_000, "", "labor_list"]);

    // ---- Pay: Ana and the team are paid by the sample committed-labor rule; the team splits equally ----
    await seedSamplePayRules(ORG, { userId: "owner" });
    const plan = [{ kind: "plan", plan_id: "labor_by_commitment", effective_from: "2026-01-01" }];
    await invokeAction(command, { action: "payroll.paySetup.save", target }, { payee: ana, entries: plan }, { idempotencyKey: "setup:ana" });
    await invokeAction(command, { action: "payroll.paySetup.save", target }, { payee: group, entries: plan, distribution: [{ effective_from: "2026-01-01", mode: "split", method: "equal" }] }, { idempotencyKey: "setup:team" });
    const asOf = "2026-06-30T12:00:00.000Z";
    await engine.refreshOrganizationEarnings(ORG, { context, asOf });
    const ledger = async () => (await store.listPayrollLedgerEntries(ORG, { limit: 500 })).map((entry) => [entry.payee.id, entry.amount_cents, entry.state]);
    const before = await ledger();
    assert.deepEqual(before, [["ana", 100_000, "accrued"]], "only the finalized commitment is earned");
    const units = async () => (await engine.listPayUnits(ORG, ana)).map((unit) => [unit.rule_id, unit.unit, unit.status]);
    const unitsBefore = await units();

    const projection = await engine.projectPayeeEarnings(ORG, ana, { context, asOf });
    assert.equal(projection.projected, true);
    assert.deepEqual(projection.earnings.map((earning) => [earning.unit, earning.amount_cents, earning.expected_on, earning.expected_from, earning.project_title, earning.projected, earning.rule_id]), [
      ["c_open", 90_000, "2026-07-15", "schedule_event", "Maple St", true, "committed_labor"],
      ["labor_list:list_new", 50_000, "", "", "Oak Ave", true, "committed_labor"]
    ], "the committed list on its event's last day, then the list nobody has committed yet");
    assert.equal(projection.total_cents, 140_000);
    // The same formula that refuses to pay an unpriced commitment refuses to project it: unresolved, never zero.
    assert.deepEqual(projection.unresolved.map((entry) => [entry.unit, entry.reason, entry.expected_on]), [["c_unpriced", "This commitment has 1 line(s) with no rate.", "2026-08-03"]]);
    assert.deepEqual(projection.projects.map((entry) => [entry.project_title, entry.total_cents, entry.unresolved_count, entry.next_expected_on]), [["Maple St", 90_000, 1, "2026-07-15"], ["Oak Ave", 50_000, 0, ""]]);

    // A member sees their share of a group that splits its pay; the group itself projects the whole line.
    const teamProjection = await engine.projectPayeeEarnings(ORG, group, { context, asOf });
    assert.deepEqual(teamProjection.earnings.map((earning) => [earning.unit, earning.amount_cents, earning.split]), [["c_team", 60_000, { method: "equal", members: [{ id: "ana", cents: 30_000 }, { id: "ben", cents: 30_000 }] }]]);
    const mine = await engine.projectUserEarnings(ORG, "ana", { context, asOf });
    assert.deepEqual(mine.earnings.map((earning) => [earning.unit, earning.amount_cents, earning.share_of?.payee || ""]), [["c_open", 90_000, ""], ["c_team", 30_000, `resource_group:${team}`], ["labor_list:list_new", 50_000, ""]]);
    assert.equal(mine.total_cents, 170_000);

    // Not posted: the ledger, the stored results and the next refresh are exactly as they were.
    assert.deepEqual(await ledger(), before);
    assert.deepEqual(await units(), unitsBefore);
    const dry = await engine.refreshPayeeEarnings(ORG, ana, { context, asOf, dryRun: true });
    assert.deepEqual(dry.differences, [], "a projection leaves nothing waiting for a refresh");
    const upcoming = (await store.listPayrollLedgerEntries(ORG, { limit: 500, state: "projected" })).length;
    assert.equal(upcoming, 0, "nothing projected is held in the ledger either");

    // Once the work is finalized it is earned, and no longer projected.
    await finalize("c_open", "2026-07-15T23:00:00.000Z");
    await engine.refreshOrganizationEarnings(ORG, { context, asOf: "2026-07-31T12:00:00.000Z" });
    const after = await engine.projectPayeeEarnings(ORG, ana, { context, asOf: "2026-07-31T12:00:00.000Z" });
    assert.deepEqual(after.earnings.map((earning) => earning.unit), ["labor_list:list_new"]);
    const settled = await ledger();
    assert.deepEqual(settled.map((row) => row[1]).sort(), [100_000, 90_000].sort(), "the finalized work was posted by the refresh, never by a projection");

    // ---- Who may see projections ----
    const payee = (permissions: Record<string, boolean>, userId = "ana"): any => userPublicationContext({ orgId: ORG, userId, role: "member", permissions, applicationAccess: { field: { enabled: true, permissions } }, capabilities } as any);
    const own = { provider: "payroll", export: "my_projected_earnings", target };
    const denied = await readPublishedData(payee({}), own);
    assert.equal(denied.status, "denied", "without the permission a payee sees no projections");
    await assert.rejects(() => invokeAction(payee({}), { action: "payroll.projectedEarnings.me", target }, {}), /not permitted|not shown/);
    const allowed = await readPublishedData(payee({ "payroll.view_own_projected_earnings": true }), own);
    if (allowed.status !== "ready") throw Error(`expected own projection: ${JSON.stringify(allowed)}`);
    const value = allowed.value as any;
    assert.equal(value.payee.id, "ana", "always the signed-in user's own");
    assert.deepEqual(value.unresolved.filter((entry: any) => !entry.unit), [], JSON.stringify(value.unresolved));
    assert.deepEqual(value.earnings.map((earning: any) => earning.unit).sort(), ["c_team", "labor_list:list_new"]);
    const benOwn = await readPublishedData(payee({ "payroll.view_own_projected_earnings": true }, "ben"), own);
    if (benOwn.status !== "ready") throw Error("expected Ben's own projection");
    assert.deepEqual((benOwn.value as any).earnings.map((earning: any) => [earning.unit, earning.amount_cents]), [["c_team", 30_000]], "Ben sees only his own share");
    // A payee cannot ask for someone else's: that is the manager read, which needs manage_payroll.
    const someone = await readPublishedData(payee({ "payroll.view_own_projected_earnings": true }), { provider: "payroll", export: "projected_earnings", target: { ...target, id: "organization_user:ben" } });
    assert.equal(someone.status, "denied");
    // A payroll manager sees anyone's, and everyone's totals, with no key of its own.
    const forAna = await readPublishedData(context, { provider: "payroll", export: "projected_earnings", target: { ...target, id: "organization_user:ana" } });
    if (forAna.status !== "ready") throw Error(`expected manager projection: ${JSON.stringify(forAna)}`);
    assert.equal((forAna.value as any).total_cents, 50_000);
    const everyone = await invokeAction(command, { action: "payroll.projectedEarnings.read", target }, {});
    assert.deepEqual(((everyone.value as any).payees as any[]).map((row) => [row.id, row.total_cents]).sort(), [[`resource_group:${team}`, 60_000], ["organization_user:ana", 50_000]].sort());
    assert.deepEqual(await ledger(), settled, "reading projections posts nothing");
  } finally {
    await store.closePayrollDatabase().catch(() => undefined);
    await rm(root, { recursive: true, force: true }).catch(() => undefined);
  }
});

test("every seeded role may see its own projected earnings, and the payouts apps follow the permission", async () => {
  await import("../platform/capability_defs.js");
  const { capabilityDefinition } = await import("../platform/capabilities.js");
  const { PAYROLL_PERMISSION_KEYS, factoryPersonaDefinitions } = await import("../workforce/access.js");
  const { appDefinition } = await import("../platform/app-experience/registry.js");
  const { publishedDataPermission, publishedActionPermission } = await import("../platform/publication/permission-bundles.js");
  const key = PAYROLL_PERMISSION_KEYS.view_own_projected_earnings;
  assert.equal(key, "payroll.view_own_projected_earnings");
  const node = capabilityDefinition("permission.payroll_view_own_projected_earnings")!;
  assert.deepEqual([node.kind, node.permission_key, node.permission_group, node.parent], ["permission", key, "payroll", "payroll.self_service_earnings"]);
  for (const persona of factoryPersonaDefinitions()) assert.equal(persona.permissions[key], true, `${persona.id} grants it by default`);
  for (const id of ["portal.crew_payouts", "project.crew_payouts"]) {
    const app = appDefinition(id)!;
    assert.equal(app.parameter_permissions.projected_enabled, key, id);
    assert.equal(app.default_params.projected_enabled, false, id);
  }
  assert.equal(publishedDataPermission("payroll.my_projected_earnings"), key);
  assert.equal(publishedActionPermission("payroll.projectedEarnings.me"), key);
  assert.equal(publishedDataPermission("payroll.projected_earnings"), "manage_payroll|manage_company_settings");
  assert.equal(publishedActionPermission("payroll.projectedEarnings.read"), "manage_payroll|manage_company_settings");
});
