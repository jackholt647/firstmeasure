import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';

// Off-cycle payments are taken off the next pay run, pay run files separate employees and contractors in the
// Gusto and QuickBooks shapes, and the self-service, approver and branch-scoped reads give each person their part.
const day = (offset: number) => new Date(Date.now() + offset * 86400000).toISOString().slice(0, 10);
const csvRows = (text: string) => text.replace(/^﻿/, '').trim().split('\r\n').map((line) => {
  const cells: string[] = []; let cell = '', quoted = false;
  for (let i = 0; i < line.length; i++) {
    const char = line[i]!;
    if (quoted) { if (char === '"' && line[i + 1] === '"') { cell += '"'; i++; } else if (char === '"') quoted = false; else cell += char; }
    else if (char === '"') quoted = true; else if (char === ',') { cells.push(cell); cell = ''; } else cell += char;
  }
  cells.push(cell); return cells;
});

test('off-cycle payments subtract from the next pay run, exports follow Gusto and QuickBooks, and each person sees their part', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'payroll-offcycle-'));
  Object.assign(process.env, { NODE_ENV: 'test', FIRSTMATE_ENV: 'test', PLATFORM_STORAGE_ROOT: root, FIRSTMEASURE_DATABASE_MODE: 'local', FIRSTMEASURE_INDEX_DB_PATH: path.join(root, 'index.sqlite') });
  const core = await import('../platform/storage.js'), store = await import('../payroll/storage.js'), service = await import('../payroll/service.js');
  const { saveCapabilityValues } = await import('../platform/capabilities.js'), { userPublicationContext } = await import('../platform/publication/context.js');
  const { readPublishedData } = await import('../platform/publication/providers.js');
  const { invokeAction } = await import('../platform/publication/actions.js');
  const org = 'org_offcycle';
  try {
    await core.createOrganization({ id: org, name: 'Off-cycle' });
    await saveCapabilityValues(org, { 'platform.expanded_access': true, 'apps.payroll': true, 'payroll.self_service_earnings': true, 'payroll.pay_runs': true, 'apps.crew': true, 'crew.time_clock': true, 'platform.money': true });
    await core.upsertDocument(org, 'users', { id: 'alice', data: { name: 'Alice Archer', email: 'alice@example.com', status: 'active', worker_classification: 'employee' } });
    await core.upsertDocument(org, 'users', { id: 'bob', data: { name: 'Bob Builder', email: 'bob@example.com', status: 'active', worker_classification: 'employee', branch_id: 'north' } });
    await core.upsertDocument(org, 'users', { id: 'cora', data: { name: 'Cora Contractor', email: 'cora@example.com', status: 'active', worker_classification: 'independent_contractor' } });
    const caps = { effectiveByKey: { 'apps.payroll': true, 'payroll.self_service_earnings': true, 'payroll.pay_runs': true, 'apps.crew': true, 'crew.time_clock': true } };
    const auth = (userId: string, permissions: Record<string, boolean>, extra: Record<string, unknown> = {}): any => ({ orgId: org, userId, role: 'member', user: { id: userId, name: userId }, permissions, applicationAccess: { management: { enabled: true, permissions: { '*': true } } }, capabilities: caps, ...extra });
    const manager = auth('alice', { manage_payroll: true, manage_company_settings: true });
    const command = userPublicationContext(manager, { mode: 'command' }), target = { scope: 'organization' as const, organizationId: org };
    (await import('../platform/publication/bootstrap.js')).initializePublication();
    let key = 0;
    const run = async (ctx: any, action: string, input: any = {}, id?: string) => (await invokeAction(ctx, { action, target: { ...target, ...(id ? { id } : {}) } }, input, { idempotencyKey: `${action}:${++key}` })).value as any;
    const read = async (ctx: any, exportName: string, extra: any = {}) => readPublishedData(ctx, { provider: 'payroll', export: exportName, target: { ...target, ...(extra.id ? { id: extra.id } : {}) }, ...(extra.args ? { args: extra.args } : {}) }) as any;
    const schedule = await run(command, 'payroll.schedule.create', { name: 'Weekly', recurrence: { frequency: 'weekly', weekday: new Date(`${day(3)}T12:00:00Z`).getUTCDay() }, clawback_cap_percent: 10 });
    await run(command, 'payroll.payDefault.save', { subject: { type: 'organization', id: org }, entries: [], schedules: [{ effective_from: '2026-01-01', schedule_id: schedule.id }] });
    const worked = `${day(-2)}T15:00:00.000Z`;
    const earning = (payee: any, kind: string, amount: number, source: string) => ({ payee, schedule_id: schedule.id, kind, state: 'accrued', amount_cents: amount, currency: 'USD', worked_at: worked, source_event_id: source });
    const alice = { type: 'organization_user', id: 'alice', name: 'Alice Archer' };
    const bob = { type: 'organization_user', id: 'bob', name: 'Bob Builder' };
    const acme = { type: 'organization_connection', id: 'acme_roofing', name: 'Acme Roofing', worker_type: 'subcontractor' };
    await service.recordPayrollLedgerEntries(org, [
      earning(alice, 'hourly', 100000, 'hours-alice'), earning(alice, 'commission', 25000, 'commission-alice'), earning(alice, 'reimbursement', 4200, 'receipt-alice'),
      earning(bob, 'hourly', 20000, 'hours-bob'), earning(acme, 'piece_rate', 80000, 'labor-acme'), earning(acme, 'reimbursement', 1500, 'receipt-acme'),
      { ...earning(bob, 'clawback', -50000, 'clawback-bob') }
    ] as any);

    await t.test('a recorded payment is one negative entry of its kind, refused in the future', async () => {
      const paid = await run(command, 'payroll.offCycle.record', { payee: { type: 'organization_user', id: 'alice' }, kind: 'hourly', amount_cents: 30000, paid_on: day(-1), reference: 'Check 1042' });
      assert.equal(paid.status, 'waiting'); assert.equal(paid.amount_cents, 30000); assert.equal(paid.waiting_cents, 30000); assert.equal(paid.schedule_id, schedule.id);
      const entry = await store.readPayrollLedgerEntry(org, paid.id);
      assert.equal(entry.amount_cents, -30000); assert.equal(entry.kind, 'hourly'); assert.equal(entry.subgroup, 'off_cycle'); assert.equal(entry.state, 'accrued');
      await assert.rejects(run(command, 'payroll.offCycle.record', { payee: { type: 'organization_user', id: 'alice' }, kind: 'hourly', amount_cents: 100, paid_on: day(5) }), /cannot be in the future/);
      // Bob was paid more outside a run than this run pays him: the rest waits for the next run.
      await run(command, 'payroll.offCycle.record', { payee: { type: 'organization_user', id: 'bob' }, kind: 'hourly', amount_cents: 50000, paid_on: day(-1) });
      // A mistake can be removed while no pay run has taken it off.
      const mistake = await run(command, 'payroll.offCycle.record', { payee: { type: 'organization_user', id: 'cora' }, kind: 'commission', amount_cents: 999, paid_on: day(-1) });
      assert.equal((await run(command, 'payroll.offCycle.remove', {}, mistake.id)).status, 'removed');
    });

    let batch: any;
    await t.test('the upcoming run and the drafted run take it off in full, before clawbacks and outside the clawback cap', async () => {
      const upcoming = (await read(userPublicationContext(manager), 'upcoming')).value;
      const occurrence = upcoming.upcoming.find((row: any) => row.employees.some((item: any) => item.payee.id === 'alice'));
      assert.ok(occurrence, JSON.stringify(upcoming.upcoming.map((row: any) => row.pay_date)));
      const aliceItem = occurrence.employees.find((item: any) => item.payee.id === 'alice');
      assert.equal(aliceItem.accrued.gross_cents, 129200); assert.equal(aliceItem.accrued.off_cycle_cents, 30000); assert.equal(aliceItem.accrued.net_cents, 99200);
      assert.equal(aliceItem.accrued.subgroup_totals.off_cycle, -30000);
      const bobItem = occurrence.employees.find((item: any) => item.payee.id === 'bob');
      // 20,000 gross: the off-cycle payment takes all of it; the clawback has nothing left within its cap.
      assert.equal(bobItem.accrued.off_cycle_cents, 20000); assert.equal(bobItem.accrued.clawback_cents, 0); assert.equal(bobItem.accrued.net_cents, 0);
      assert.equal(occurrence.subcontractors[0].payee.id, 'acme_roofing');
      batch = (await run(command, 'payroll.batch.create', { schedule_id: schedule.id, pay_date: occurrence.pay_date })).batch;
      const stored = batch.items.find((item: any) => item.payee.id === 'alice');
      assert.equal(stored.net_cents, 99200); assert.equal(stored.subgroup_totals.off_cycle, -30000); assert.equal(stored.deduction_cents, 30000);
      const payments = (await read(userPublicationContext(manager), 'off_cycle_payments')).value;
      const alicePaid = payments.find((row: any) => row.payee.id === 'alice'), bobPaid = payments.find((row: any) => row.payee.id === 'bob');
      assert.equal(alicePaid.status, 'subtracted'); assert.equal(alicePaid.runs[0].batch_id, batch.id);
      assert.equal(bobPaid.status, 'partly_subtracted'); assert.equal(bobPaid.subtracted_cents, 20000); assert.equal(bobPaid.waiting_cents, 30000);
      assert.equal(payments.some((row: any) => row.payee.id === 'cora'), false, 'a removed payment is not listed');
      await assert.rejects(run(command, 'payroll.offCycle.remove', {}, alicePaid.id), /already taken this payment off/);
    });

    await t.test('earnings count the off-cycle payment as paid, so nothing is earned twice', async () => {
      for (const action of [{ action: 'submit_approval', approvers: [{ user_id: 'alice' }] }, { action: 'approve' }, { action: 'finalize' }, { action: 'paid' }]) await run(command, 'payroll.batch.action', action, batch.id);
      const report = (await read(userPublicationContext(manager), 'my_earnings')).value.earnings[0];
      assert.equal(report.totals.paid_cents, 129200, JSON.stringify(report.totals));
      assert.equal(report.totals.owed_cents, 0); assert.equal(report.totals.earned_cents, 129200);
      assert.equal(report.off_cycle_payments[0].amount_cents, 30000); assert.equal(report.off_cycle_payments[0].reference, 'Check 1042');
    });

    await t.test('pay run files: Gusto and QuickBooks shapes, employees apart from contractors, reimbursements on their own line', async () => {
      const file = async (type: string) => {
        const artifact = await run(command, 'payroll.artifact.generate', { type, format: 'csv', batch_id: batch.id });
        return csvRows((await store.readPayrollArtifact(org, artifact.id, true) as any).content.toString('utf8'));
      };
      const gusto = await file('gusto_employees');
      assert.deepEqual(gusto[0]!.slice(0, 11), ['Last Name', 'First Name', 'Email', 'Hourly pay', 'Salary', 'Piece rate', 'Commission', 'Bonus or adjustment', 'Reimbursement', 'Already paid outside a pay run', 'Clawback or correction']);
      const aliceRow = gusto.find((row) => row[0] === 'Archer')!;
      assert.deepEqual(aliceRow.slice(0, 12), ['Archer', 'Alice', 'alice@example.com', '1000.00', '0.00', '0.00', '250.00', '0.00', '42.00', '-300.00', '0.00', '992.00']);
      assert.equal(gusto.some((row) => row.includes('Acme Roofing')), false, 'contractors are not in the employee file');
      const contractors = await file('gusto_contractors');
      assert.deepEqual(contractors[0]!.slice(0, 6), ['Contractor', 'Email', 'Contractor Type', 'Wage', 'Reimbursement', 'Total']);
      assert.deepEqual(contractors[1]!.slice(0, 6), ['Acme Roofing', '', 'Business', '800.00', '15.00', '815.00']);
      assert.equal(contractors.length, 2);
      const quickbooks = await file('quickbooks_payroll');
      assert.deepEqual(quickbooks[0], ['Employee', 'Email', 'Pay Item', 'Amount', 'Pay date', 'Period start', 'Period end', 'Memo']);
      assert.deepEqual(quickbooks.filter((row) => row[0] === 'Alice Archer').map((row) => [row[2], row[3]]),
        [['Hourly pay', '1000.00'], ['Commission', '250.00'], ['Reimbursement', '42.00'], ['Already paid outside a pay run', '-300.00']]);
      const bills = await file('quickbooks_bills');
      assert.deepEqual(bills.slice(1).map((row) => [row[0], row[4], row[6]]), [['Acme Roofing', 'Subcontractor payments', '800.00'], ['Acme Roofing', 'Reimbursements', '15.00']]);
      const summary = await file('pay_run_summary');
      assert.deepEqual(summary.map((row) => [row[0], row[1], row[10]]).slice(1),
        [['Employees', 'Alice Archer', '992.00'], ['Employees', 'Bob Builder', '0.00'], ['Employees', 'Employees total', '992.00'], ['Contractors', 'Acme Roofing', '815.00'], ['Contractors', 'Contractors total', '815.00'], ['Total', 'Pay run total', '1807.00']]);
      const pdf = await run(command, 'payroll.artifact.generate', { type: 'gusto_employees', format: 'pdf', batch_id: batch.id });
      assert.equal(pdf.metadata.format, 'csv', 'provider files are CSV only');
    });

    await t.test('worker classification may be changed by payroll managers as well as user managers', async () => {
      const classify = (permissions: Record<string, boolean>) => run(userPublicationContext(auth('alice', permissions), { mode: 'command' }), 'payroll.contractor.worker.update', { worker_classification: 'independent_contractor', payment_terms: { basis: 'net_days', net_days: 15 } }, 'cora');
      assert.equal((await classify({ manage_payroll: true })).worker_classification, 'independent_contractor');
      assert.equal((await classify({ manage_company_users: true })).payment_terms.net_days, 15);
      await assert.rejects(classify({ manage_projects: true }));
    });

    await t.test('own timesheets need only the time clock permission; approvals need only being named', async () => {
      const crew = auth('bob', { 'crew.time_clock.use': true });
      assert.equal((await read(userPublicationContext(crew), 'my_timesheets')).status, 'ready');
      assert.equal((await read(userPublicationContext(auth('bob', {})), 'my_timesheets')).status, 'denied');
      assert.equal((await read(userPublicationContext(crew), 'timesheets')).status, 'denied');
      const occurrence = (await read(userPublicationContext(manager), 'upcoming')).value.upcoming.find((row: any) => !row.batch && row.pay_date > batch.pay_date);
      await service.recordPayrollLedgerEntries(org, [earning(alice, 'salary', 5000, 'salary-next')] as any);
      const next = (await run(command, 'payroll.batch.create', { schedule_id: schedule.id, pay_date: occurrence.pay_date, run_type: 'off_cycle', period_start: day(-7), period_end: day(0) })).batch;
      await run(command, 'payroll.batch.action', { action: 'submit_approval', approvers: [{ user_id: 'bob' }] }, next.id);
      const mine = (await read(userPublicationContext(crew), 'my_approvals')).value;
      assert.equal(mine.count, 1); assert.equal(mine.approvals[0].id, next.id); assert.equal(mine.approvals[0].items[0].payee.name, 'Alice Archer');
      assert.equal(JSON.stringify(mine).includes('source_event_id'), false, 'the approver sees amounts, not ledger detail');
      assert.equal((await read(userPublicationContext(auth('cora', {})), 'my_approvals')).value.count, 0);
      await assert.rejects(run(userPublicationContext(auth('cora', {}), { mode: 'command' }), 'payroll.batch.decide', { decision: 'approve' }, next.id), /named approver/);
      const decided = await run(userPublicationContext(crew, { mode: 'command' }), 'payroll.batch.decide', { decision: 'approve' }, next.id);
      assert.equal(decided.approval.status, 'approved'); assert.equal(decided.my_decision, 'approved');
    });

    await t.test('reimbursements are paid in full, and with approval turned off a pay run goes draft, run, paid', async () => {
      await core.upsertDocument(org, 'users', { id: 'dana', data: { name: 'Dana Driver', email: 'dana@example.com', status: 'active' } });
      const dana = { type: 'organization_user', id: 'dana', name: 'Dana Driver' };
      await service.recordPayrollLedgerEntries(org, [earning(dana, 'reimbursement', 5000, 'receipt-dana'), earning(dana, 'hourly', 2000, 'hours-dana')] as any);
      await run(command, 'payroll.offCycle.record', { payee: { type: 'organization_user', id: 'dana' }, kind: 'hourly', amount_cents: 6000, paid_on: day(-1) });
      const occurrence = (await read(userPublicationContext(manager), 'upcoming')).value.upcoming.find((row: any) => !row.batch && row.employees.some((item: any) => item.payee.id === 'dana'));
      const preview = occurrence.employees.find((item: any) => item.payee.id === 'dana').accrued;
      // The outside payment comes off the $20 earned, never the $50 reimbursement; the other $40 waits.
      assert.equal(preview.off_cycle_cents, 2000); assert.equal(preview.net_cents, 5000); assert.equal(preview.subgroup_totals.reimbursement, 5000);
      assert.equal((await read(userPublicationContext(manager), 'configuration')).value.settings.approval_required, true, 'approval is on unless turned off');
      const saved = await run(command, 'payroll.settings.save', { approval_required: false, expected_revision: 0 });
      assert.equal(saved.approval_required, false);
      await assert.rejects(run(userPublicationContext(auth('bob', { 'crew.time_clock.use': true }), { mode: 'command' }), 'payroll.settings.save', { approval_required: true }));
      const drafted = (await run(command, 'payroll.batch.create', { schedule_id: schedule.id, pay_date: occurrence.pay_date })).batch;
      assert.equal(drafted.approval.status, 'not_required');
      const item = drafted.items.find((row: any) => row.payee.id === 'dana');
      assert.equal(item.net_cents, 5000); assert.equal(item.subgroup_totals.off_cycle, -2000);
      const file = await run(command, 'payroll.artifact.generate', { type: 'quickbooks_payroll', format: 'csv', batch_id: drafted.id });
      const lines = csvRows((await store.readPayrollArtifact(org, file.id, true) as any).content.toString('utf8')).filter((row) => row[0] === 'Dana Driver').map((row) => [row[2], row[3]]);
      assert.deepEqual(lines, [['Hourly pay', '20.00'], ['Reimbursement', '50.00'], ['Already paid outside a pay run', '-20.00']]);
      await run(command, 'payroll.batch.action', { action: 'run' }, drafted.id);
      const paid = (await run(command, 'payroll.batch.action', { action: 'paid' }, drafted.id)).batch;
      assert.equal(paid.status, 'paid');
      const waiting = (await read(userPublicationContext(manager), 'off_cycle_payments')).value.find((row: any) => row.payee.id === 'dana');
      assert.equal(waiting.subtracted_cents, 2000); assert.equal(waiting.waiting_cents, 4000);
      // Turned back on, a pay run needs its approval again before it is marked paid.
      await run(command, 'payroll.settings.save', { approval_required: true });
      await service.recordPayrollLedgerEntries(org, [earning(dana, 'hourly', 9000, 'hours-dana-2')] as any);
      const next = (await read(userPublicationContext(manager), 'upcoming')).value.upcoming.find((row: any) => !row.batch && row.employees.some((entry: any) => entry.payee.id === 'dana'));
      const gated = (await run(command, 'payroll.batch.create', { schedule_id: schedule.id, pay_date: next.pay_date })).batch;
      await assert.rejects(run(command, 'payroll.batch.action', { action: 'paid' }, gated.id), /need approval/);
      // With approval off, a run someone was asked to approve waits for them.
      await run(command, 'payroll.settings.save', { approval_required: false });
      await run(command, 'payroll.batch.action', { action: 'submit_approval', approvers: [{ user_id: 'alice' }] }, gated.id);
      await assert.rejects(run(command, 'payroll.batch.action', { action: 'run' }, gated.id), /Someone was asked to approve/);
      await run(command, 'payroll.batch.action', { action: 'void' }, gated.id);
      await run(command, 'payroll.settings.save', { approval_required: true });
      // The payee's own view says when they are next paid.
      const mine = (await read(userPublicationContext(auth('dana', {})), 'my_earnings')).value;
      assert.match(mine.next_payment.pay_date, /^\d{4}-\d{2}-\d{2}$/); assert.equal(mine.next_payment.schedule_name, 'Weekly'); assert.deepEqual(mine.unresolved, []);
    });

    await t.test('someone who sees only their own branch sees only its payees', async () => {
      const structure = { branches: [{ id: 'default', status: 'active' }, { id: 'north', status: 'active' }], catalog: { regions: [] },
        users: [{ id: 'alice', branch_ids: ['default'] }, { id: 'bob', branch_ids: ['north'] }, { id: 'cora', branch_ids: ['default'] }], groups: [], connections: [{ id: 'acme_roofing', branch_ids: [] }] };
      const local = auth('alice', { manage_payroll: true }, { organizationStructure: structure, user: { id: 'alice', name: 'Alice', branch_id: 'default' }, capabilities: { effectiveByKey: { ...caps.effectiveByKey, 'platform.multiple_branches': true } } });
      const runs = (await read(userPublicationContext(local), 'batches')).value;
      const scoped = runs.find((row: any) => row.id === batch.id);
      assert.deepEqual(scoped.items.map((item: any) => item.payee.id).sort(), ['acme_roofing', 'alice']);
      assert.equal(scoped.branch_view.hidden_payee_count, 1); assert.equal(scoped.total_cents, 99200 + 81500);
      assert.equal((await read(userPublicationContext(local), 'off_cycle_payments')).value.some((row: any) => row.payee.id === 'bob'), false);
      await assert.rejects(run(userPublicationContext(local, { mode: 'command' }), 'payroll.offCycle.record', { payee: { type: 'organization_user', id: 'bob' }, kind: 'hourly', amount_cents: 100, paid_on: day(-1) }), /cannot manage/);
      await assert.rejects(run(userPublicationContext(local, { mode: 'command' }), 'payroll.batch.action', { action: 'void' }, batch.id), /branches you do not manage/);
      const everyone = auth('alice', { manage_payroll: true, view_all_branches: true, manage_all_branches: true }, { organizationStructure: structure, user: { id: 'alice', name: 'Alice', branch_id: 'default' }, capabilities: { effectiveByKey: { ...caps.effectiveByKey, 'platform.multiple_branches': true } } });
      assert.equal((await read(userPublicationContext(everyone), 'batches')).value.find((row: any) => row.id === batch.id).items.length, 3);
      assert.equal((await read(userPublicationContext(everyone), 'batches', { args: { branch_ids: 'north' } })).value.find((row: any) => row.id === batch.id).items.map((item: any) => item.payee.id).sort().join(), 'acme_roofing,bob');
    });
  } finally {
    await (await import('./helpers/platform-fixture.js')).closePlatformFixtureStores();
    await rm(root, { recursive: true, force: true }).catch(() => {});
  }
});
