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
  const { readPublishedData, listPublishedData } = await import("../platform/publication/providers.js");
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

    const { listCrewTimeShiftPage } = await import("../workforce/crew_storage.js");
    await listCrewTimeShiftPage(ORG, { limit: 1 });
    const db = workforce.getWorkforceDatabase();
    const shift = (id: string, userId: string, out: string, hours: number, status: string, state = "closed", extra: Record<string, unknown> = {}) => db.prepare(`INSERT INTO crew_time_shifts
      (id, organization_id, user_id, status, clocked_in_at, clocked_out_at, break_seconds, metadata_json, revision, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, 0, ?, 1, ?, ?)`)
      .run(id, ORG, userId, state, new Date(Date.parse(out) - hours * 3_600_000).toISOString(), state === "closed" ? out : null, JSON.stringify({ project_id: "p1", timezone: "America/Denver", source: "crew_app", timesheet: { status }, ...extra }), now, now);
    const event = (id: string, shiftId: string, userId: string, action: string, at: string, data: Record<string, unknown> = {}) => db.prepare(`INSERT INTO crew_time_events
      (id, organization_id, user_id, shift_id, action, occurred_at, data_json, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`).run(id, ORG, userId, shiftId, action, at, JSON.stringify(data), at);
    const at = (latitude: number, longitude: number) => ({ location: { status: "captured", latitude, longitude, accuracy_meters: 9, captured_at: "2026-06-02T14:00:01.000Z", reason: "" }, request: { ip: "203.0.113.7", user_agent: "FirstMate/1" }, timezone: "America/Denver", source: "crew_app", client_path: "/crew" });
    await shift("shift_1", "ben", "2026-06-02T22:00:00.000Z", 8, "approved");
    await shift("shift_2", "ben", "2026-06-03T22:00:00.000Z", 8, "approved");
    await shift("shift_3", "ben", "2026-06-04T22:00:00.000Z", 8, "pending");
    await shift("shift_4", "ana", "2026-06-04T22:00:00.000Z", 8, "approved");
    await shift("shift_5", "ben", "2026-06-05T22:00:00.000Z", 3, "pending", "active");
    // Maple St is at 40, -105. Ben clocked in there for shift 1 and about 11 km away for shift 2; shift 3 has no place at all.
    await core.upsertDocument(ORG, "projects", { id: "p1", data: { latitude: 40, longitude: -105 } }, { replace: false });
    await event("ev_1_in", "shift_1", "ben", "clock_in", "2026-06-02T14:00:00.000Z", at(40.0003, -105));
    await event("ev_1_break", "shift_1", "ben", "break_start", "2026-06-02T18:00:00.000Z", at(40.0003, -105));
    await event("ev_1_back", "shift_1", "ben", "break_end", "2026-06-02T18:30:00.000Z", { ...at(40.0003, -105), break_seconds: 1800 });
    await event("ev_1_out", "shift_1", "ben", "clock_out", "2026-06-02T22:00:00.000Z", at(40.0004, -105));
    await event("ev_2_in", "shift_2", "ben", "clock_in", "2026-06-03T14:00:00.000Z", at(40.1, -105));
    await event("ev_2_out", "shift_2", "ben", "clock_out", "2026-06-03T22:00:00.000Z", { location: { status: "denied", reason: "permission_denied" } });
    await event("ev_5_in", "shift_5", "ben", "clock_in", "2026-06-05T19:00:00.000Z", at(40.0003, -105));
    const mineOnly = { field: "assignee_key", operator: "equals", value: "organization_user:ben" };
    const rowsOf = async (name: string, selection: Record<string, unknown>) => {
      const result = await selectPublishedData(context, source(name), selection);
      if (result.status !== "ready") throw Error(`expected rows from ${name}: ${JSON.stringify(result)}`);
      return result.rows;
    };
    const shifts = await rowsOf("time_shifts", { where: { rules: [mineOnly, { field: "status", operator: "equals", value: "closed" }] }, orderBy: { field: "clocked_out_at" } });
    assert.deepEqual(shifts.map((row) => [row.key, row.value.worked_seconds, row.value.approval_status, row.value.project_id]),
      [["shift_1", 28_800, "approved", "p1"], ["shift_2", 28_800, "approved", "p1"], ["shift_3", 28_800, "pending", "p1"]]);
    const firstShift = shifts[0]!.value as any;
    assert.deepEqual([firstShift.clock_in.event_id, firstShift.clock_in.location_status, firstShift.clock_in.latitude, firstShift.clock_in.accuracy_meters, firstShift.clock_in.distance_to_project_meters, firstShift.clock_out.distance_to_project_meters, firstShift.break_count, firstShift.timezone],
      ["ev_1_in", "captured", 40.0003, 9, 33, 44, 1, "America/Denver"]);
    assert.deepEqual([(shifts[1]!.value as any).clock_out.location_status, (shifts[1]!.value as any).clock_out.location_reason, Object.hasOwn((shifts[1]!.value as any).clock_out, "distance_to_project_meters")], ["denied", "permission_denied", false]);
    assert.deepEqual([(shifts[2]!.value as any).clock_in.location_status, (shifts[2]!.value as any).clock_in.location_reason], ["unavailable", "not_recorded"], "a shift with no recorded place says so");
    // Selecting on where someone was needs no field made for the purpose.
    assert.deepEqual((await rowsOf("time_shifts", { where: { rules: [mineOnly, { field: "clock_in.distance_to_project_meters", operator: "less_or_equal", value: 150 }, { field: "status", operator: "equals", value: "closed" }] } })).map((row) => row.key), ["shift_1"]);

    // A shift still on the clock is published, without a duration that would move with nothing recording it.
    const open = await rowsOf("time_shifts", { where: { rules: [{ field: "status", operator: "equals", value: "active" }] } });
    assert.deepEqual(open.map((row) => [row.key, row.value.approval_status, row.value.clocked_out_at, Object.hasOwn(row.value, "worked_seconds"), Object.hasOwn(row.value, "clock_out"), (row.value as any).clock_in.distance_to_project_meters]),
      [["shift_5", "active", "", false, false, 33]]);
    assert.equal((await rowsOf("time_shifts", { where: { rules: [{ field: "status", operator: "equals", value: "active" }] } }))[0]!.revision, open[0]!.revision, "reading it again a moment later is the same row");
    db.prepare("UPDATE crew_time_shifts SET active_break_started_at=?, revision=revision+1 WHERE id='shift_5'").run("2026-06-05T20:00:00.000Z");
    const onBreak = (await rowsOf("time_shifts", { where: { rules: [{ field: "on_break", operator: "equals", value: true }] } }))[0]!;
    assert.deepEqual([onBreak.key, onBreak.value.break_seconds, onBreak.revision !== open[0]!.revision], ["shift_5", 0, true], "a break in progress changes the row but is not counted until it ends");

    // Every event, with where it happened.
    const events = await rowsOf("time_clock_events", { where: { rules: [mineOnly] }, period: { field: "occurred_at", from: "2026-06-02", through: "2026-06-02" }, orderBy: { field: "occurred_at" } });
    assert.deepEqual(events.map((row) => [row.key, row.value.action, row.value.shift_id, row.value.distance_to_project_meters]),
      [["ev_1_in", "clock_in", "shift_1", 33], ["ev_1_break", "break_start", "shift_1", 33], ["ev_1_back", "break_end", "shift_1", 33], ["ev_1_out", "clock_out", "shift_1", 44]]);
    const punch = events[0]!.value;
    assert.deepEqual([punch.assignee_key, punch.project_id, punch.location_status, punch.longitude, punch.ip_address, punch.user_agent, punch.client_path, punch.shift_status, punch.shift_approval_status, punch.automatic],
      ["organization_user:ben", "p1", "captured", -105, "203.0.113.7", "FirstMate/1", "/crew", "closed", "approved", false]);
    assert.equal(events[2]!.value.break_seconds, 1800);
    assert.deepEqual((await rowsOf("time_clock_events", { where: { rules: [{ field: "location_status", operator: "equals", value: "denied" }] } })).map((row) => row.key), ["ev_2_out"]);

    // Review and correction are part of the published clock: who, when, and what changed.
    const { correctPayrollTimesheet, approvePayrollTimesheet } = await import("../payroll/timesheets.js");
    const before = (await rowsOf("time_shifts", { where: { rules: [{ field: "id", operator: "equals", value: "shift_3" }] } }))[0]!;
    await correctPayrollTimesheet(ORG, "shift_3", { clocked_out_at: "2026-06-04T21:00:00.000Z", break_seconds: 1800, manager_note: "Left early" }, "owner");
    await approvePayrollTimesheet(ORG, "shift_3", { manager_note: "Checked with the foreman" }, "owner");
    const after = (await rowsOf("time_shifts", { where: { rules: [{ field: "approved_by_user_id", operator: "equals", value: "owner" }] } }))[0]!;
    assert.deepEqual([after.key, after.value.worked_seconds, after.value.break_seconds, after.value.corrected, after.value.correction_count, after.value.last_corrected_by_user_id, after.value.manager_note, after.value.approval_status, after.revision !== before.revision],
      ["shift_3", 7 * 3600 - 1800, 1800, true, 1, "owner", "Checked with the foreman", "approved", true]);
    const changes = await rowsOf("time_shift_changes", { where: { rules: [mineOnly] }, orderBy: { field: "sequence" } });
    assert.deepEqual(changes.map((row) => [row.key, row.value.action, row.value.actor_user_id, row.value.note]), [["shift_3:1", "corrected", "owner", "Left early"], ["shift_3:2", "approved", "owner", "Checked with the foreman"]]);
    assert.deepEqual([(changes[0]!.value as any).before.clocked_out_at, (changes[0]!.value as any).after.clocked_out_at, (changes[0]!.value as any).after.break_seconds], ["2026-06-04T22:00:00.000Z", "2026-06-04T21:00:00.000Z", 1800]);
    // Read a page at a time, however small the page, every change still arrives exactly once.
    const paged: string[] = [];
    let cursor: string | undefined, pages = 0;
    do {
      const page = await listPublishedData(context, source("time_shift_changes"), { limit: 1, cursor });
      if (page.status !== "ready") throw Error(`expected a page: ${JSON.stringify(page)}`);
      assert.ok(page.items.length <= 1);
      paged.push(...page.items.map((item) => String((item as any).id)));
      cursor = page.nextCursor;
    } while (cursor && ++pages < 50);
    assert.deepEqual(paged, ["shift_3:1", "shift_3:2"]);
    // Moving the project moves the distance, and the rows say so.
    await core.upsertDocument(ORG, "projects", { id: "p1", data: { latitude: 40.0003, longitude: -105 } }, { replace: false });
    const moved = (await rowsOf("time_shifts", { where: { rules: [{ field: "id", operator: "equals", value: "shift_1" }] } }))[0]!;
    assert.deepEqual([(moved.value as any).clock_in.distance_to_project_meters, moved.value.shift_revision, moved.revision !== shifts[0]!.revision], [0, 1, true]);
    await core.upsertDocument(ORG, "projects", { id: "p1", data: { latitude: 40, longitude: -105 } }, { replace: false });
    // Put shift 3 back as the rest of this test expects it: eight pending hours.
    db.prepare("UPDATE crew_time_shifts SET clocked_out_at=?, break_seconds=0, metadata_json=? WHERE id='shift_3'").run("2026-06-04T22:00:00.000Z", JSON.stringify({ project_id: "p1", timesheet: { status: "pending" } }));

    const commitment = (id: string, status: string, total: number, unpriced = 0) => core.upsertDocument(ORG, "labor_commitments", { id, data: {
      list_id: `list_${id}`, project_id: "p1", revision: 1, status, unit: null, assignee: { type: "resource_group", id: crew, name: "Install team" }, lines: [], total_cents: total, unpriced_lines: unpriced,
      pay_sheets: [], schedule: null, note: "", list_revision: 1, content_hash: id, idempotency_key: "", committed_by_user_id: "owner", committed_at: "2026-06-01T12:00:00.000Z",
      delivery: { method: "share", status: "delivered", detail: "", steps: [] }, ...(status === "released" ? { released_at: "2026-06-10T12:00:00.000Z", release_reason: "Finished" } : {})
    } });
    await commitment("c1", "released", 250_000);
    await commitment("c2", "committed", 90_000);
    await commitment("c3", "released", 40_000, 2);
    const provider = describeDataProvider("payroll")!;
    for (const name of ["time_shifts", "time_clock_events", "time_shift_changes", "project_records", "labor_commitments"]) assert.equal(selectionSupport({ provider: "payroll", export: name }).selectable, true, name);
    assert.deepEqual(provider.exports.time_shifts!.access.permissions, ["manage_payroll|manage_company_settings"]);
    const denied = userPublicationContext({ ...auth, permissions: {} });
    for (const name of ["labor_commitments", "time_shifts", "time_clock_events", "time_shift_changes"]) assert.equal((await selectPublishedData(denied, source(name), {})).status, "denied", name);

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

    // ---- Pay that depends on where someone was, written as ordinary rules over the published clock ----
    // Nothing about the clock is special to pay: a premium for hours clocked in on site reads the shift's
    // distance, and a stipend per arrival reads the events. Neither needed a field made for it.
    const saveRule = (rule: Record<string, unknown>) => invokeAction(command, { action: "payroll.payRule.save", target }, { ...rule, effective_from: "2026-01-01" }, { idempotencyKey: `rule:${rule.id}` });
    await saveRule({ id: "on_site_premium", name: "On-site premium", definition: {
      grain: "period", period: "week", kind: "adjustment",
      inputs: { shifts: { source: { provider: "payroll", export: "time_shifts" }, date: "clocked_out_at", where: { rules: [
        { field: "assignee_key", operator: "equals", value: "$payee.key" }, { field: "approval_status", operator: "equals", value: "approved" },
        { field: "clock_in.distance_to_project_meters", operator: "less_or_equal", value: 150 }] } } },
      parameters: { premium_cents: { label: "Extra per on-site hour (cents)", default: 200 } },
      code: `const hours = unit.rows.shifts.reduce((sum, shift) => sum + shift.worked_seconds, 0) / 3600;
return hours > 0 ? { amount_cents: Math.round(hours * params.premium_cents), description: hours.toFixed(2) + " on-site hours" } : null;`
    } });
    await saveRule({ id: "arrival_stipend", name: "Arrival stipend", definition: {
      grain: "record", kind: "reimbursement", earned_at: "occurred_at", project: "project_id",
      inputs: { arrivals: { primary: true, source: { provider: "payroll", export: "time_clock_events" }, where: { rules: [
        { field: "assignee_key", operator: "equals", value: "$payee.key" }, { field: "action", operator: "equals", value: "clock_in" },
        { field: "shift_approval_status", operator: "equals", value: "approved" }, { field: "distance_to_project_meters", operator: "less_or_equal", value: 150 }] } } },
      parameters: { amount_cents: { label: "Per arrival (cents)", default: 1500 } },
      code: `return { amount_cents: Math.round(params.amount_cents), description: "Arrived on site" };`
    } });
    const benEntries = [{ kind: "plan", plan_id: "hourly_staff", effective_from: "2026-01-01" }, { kind: "plan", plan_id: "inside_sales", effective_from: "2026-01-01" }, { kind: "override", rule_id: "hourly_time_clock", params: { rate_cents: 2500 }, effective_from: "2026-01-01" },
      { kind: "add", rule_id: "on_site_premium", effective_from: "2026-01-01" }, { kind: "add", rule_id: "arrival_stipend", effective_from: "2026-01-01" }];
    await save(ben, benEntries);
    const earned = async (ruleId: string) => (await store.listPayrollLedgerEntries(ORG, { limit: 500 })).filter((entry) => entry.payee.id === "ben" && entry.state === "accrued" && (entry.metadata as any)?.pay_rule?.rule_id === ruleId).reduce((sum, entry) => sum + entry.amount_cents, 0);
    await engine.refreshOrganizationEarnings(ORG, { context, asOf });
    assert.equal(await earned("on_site_premium"), 8 * 200, "only the shift clocked in at the project earns the premium; the one clocked in 11 km away does not");
    assert.equal(await earned("arrival_stipend"), 1500, "one approved arrival on site");
    assert.equal(await earned("hourly_time_clock"), 40_000, "and the hours themselves are still paid by the hourly rule alone");
    // The project turns out to be where the second shift was clocked in. The rows change, so the next refresh pays the difference.
    await core.upsertDocument(ORG, "projects", { id: "p1", data: { latitude: 40.1, longitude: -105 } }, { replace: false });
    const movedRefresh = await engine.refreshOrganizationEarnings(ORG, { context, asOf });
    assert.equal(await earned("on_site_premium"), 8 * 200, "the same hours, now from the other shift");
    assert.equal(await earned("arrival_stipend"), 1500, "one arrival taken back and the other earned");
    assert.deepEqual(movedRefresh.payees.flatMap((entry) => entry.differences.map((difference) => [difference.rule_id, difference.unit, difference.delta_cents])).sort(), [["arrival_stipend", "ev_1_in", -1500], ["arrival_stipend", "ev_2_in", 1500]]);
    assert.equal(await earned("hourly_time_clock"), 40_000);
  } finally {
    await store.closePayrollDatabase().catch(() => undefined);
    await rm(root, { recursive: true, force: true }).catch(() => undefined);
  }
});
