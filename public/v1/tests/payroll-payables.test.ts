import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';

// Payees paid through payables (docs/architecture/pay-rules.md#paid-with-payroll-or-through-payables). Earnings stay in
// the payroll ledger; a pay run turns a payables payee's part into a bill when it is entered; paying the bill wherever
// payables are paid marks the pay run item paid exactly once; payroll payees are unaffected; branch scope holds.
const day = (offset: number) => new Date(Date.now() + offset * 86400000).toISOString().slice(0, 10);
const plus = (date: string, days: number) => { const value = new Date(`${date}T12:00:00.000Z`); value.setUTCDate(value.getUTCDate() + days); return value.toISOString().slice(0, 10); };

test('earnings become bills, a bill paid in payables is paid once in payroll, and payroll payees are unaffected', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'payroll-payables-'));
  Object.assign(process.env, { NODE_ENV: 'test', FIRSTMATE_ENV: 'test', PLATFORM_STORAGE_ROOT: root, FIRSTMEASURE_DATABASE_MODE: 'local', FIRSTMEASURE_INDEX_DB_PATH: path.join(root, 'index.sqlite') });
  const core = await import('../platform/storage.js'), store = await import('../payroll/storage.js'), service = await import('../payroll/service.js');
  const payments = await import('../payments/storage.js'), payables = await import('../payroll/payables.js');
  const { saveCapabilityValues } = await import('../platform/capabilities.js'), { userPublicationContext } = await import('../platform/publication/context.js');
  const { readPublishedData } = await import('../platform/publication/providers.js');
  const { invokeAction } = await import('../platform/publication/actions.js');
  const org = 'org_payables';
  try {
    await core.createOrganization({ id: org, name: 'Payables' });
    await saveCapabilityValues(org, { 'platform.expanded_access': true, 'apps.payroll': true, 'payroll.self_service_earnings': true, 'payroll.pay_runs': true, 'platform.money': true });
    await core.upsertDocument(org, 'users', { id: 'alice', data: { name: 'Alice Archer', email: 'alice@example.com', status: 'active', worker_classification: 'employee' } });
    await core.upsertDocument(org, 'users', { id: 'cora', data: { name: 'Cora Clark', email: 'cora@example.com', status: 'active', worker_classification: 'independent_contractor', payment_terms: { basis: 'payroll_schedule', net_days: 0 } } });
    await core.upsertDocument(org, 'users', { id: 'dev', data: { name: 'Dev Patel', email: 'dev@example.com', status: 'active', worker_classification: 'independent_contractor', payment_terms: { basis: 'net_days', net_days: 15 } } });
    const connections = await import('../connections/storage.js');
    await connections.createOrganizationConnection(org, { id: 'acme', name: 'Acme Roofing', payment_terms: { basis: 'net_days', net_days: 30 } });
    const caps = { effectiveByKey: { 'apps.payroll': true, 'payroll.self_service_earnings': true, 'payroll.pay_runs': true } };
    const auth = (userId: string, permissions: Record<string, boolean>, extra: Record<string, unknown> = {}): any => ({ orgId: org, userId, role: 'member', user: { id: userId, name: userId }, permissions, applicationAccess: { management: { enabled: true, permissions: { '*': true } } }, capabilities: caps, ...extra });
    const manager = auth('alice', { manage_payroll: true, manage_company_settings: true, manage_projects: true });
    const command = userPublicationContext(manager, { mode: 'command' }), target = { scope: 'organization' as const, organizationId: org };
    (await import('../platform/publication/bootstrap.js')).initializePublication();
    let key = 0;
    const run = async (ctx: any, action: string, input: any = {}, id?: string) => (await invokeAction(ctx, { action, target: { ...target, ...(id ? { id } : {}) } }, input, { idempotencyKey: `${action}:${++key}` })).value as any;
    const read = async (ctx: any, exportName: string, args?: any) => {
      const result: any = await readPublishedData(ctx, { provider: 'payroll', export: exportName, target, ...(args ? { args } : {}) });
      assert.equal(result.status, 'ready', JSON.stringify(result));
      return result.value;
    };
    const schedule = await run(command, 'payroll.schedule.create', { name: 'Weekly', recurrence: { frequency: 'weekly', weekday: new Date(`${day(3)}T12:00:00Z`).getUTCDay() } });
    await run(command, 'payroll.payDefault.save', { subject: { type: 'organization', id: org }, entries: [], schedules: [{ effective_from: '2026-01-01', schedule_id: schedule.id }] });
    const worked = `${day(-2)}T15:00:00.000Z`;
    let source = 0;
    const earn = (payee: any, kind: string, amount: number) => service.recordPayrollLedgerEntries(org, [{ payee, schedule_id: schedule.id, kind, state: 'accrued', amount_cents: amount, currency: 'USD', worked_at: worked, source_event_id: `earning-${++source}` } as any]);
    const alice = { type: 'organization_user', id: 'alice', name: 'Alice Archer' };
    const cora = { type: 'organization_user', id: 'cora', name: 'Cora Clark', worker_type: 'independent_contractor' };
    const dev = { type: 'organization_user', id: 'dev', name: 'Dev Patel', worker_type: 'independent_contractor' };
    const acme = { type: 'organization_connection', id: 'acme', name: 'Acme Roofing', worker_type: 'subcontractor' };
    await earn(alice, 'hourly', 100000); await earn(cora, 'piece_rate', 30000); await earn(dev, 'piece_rate', 50000); await earn(dev, 'clawback', -5000);
    await earn(acme, 'piece_rate', 80000); await earn(acme, 'reimbursement', 1500);
    // Acme was paid $100 outside a pay run: it comes off the bill exactly as it would come off a paycheck.
    await run(command, 'payroll.offCycle.record', { payee: { type: 'organization_connection', id: 'acme' }, kind: 'piece_rate', amount_cents: 10000, paid_on: day(-1) });

    let occurrence: any, batch: any;
    const item = (row: any, id: string) => row.items.find((entry: any) => entry.payee.id === id);
    const payrollBills = async (): Promise<any[]> => (await payments.listPayables(org, { include_void: true })).filter((row: any) => row.kind === 'contractor_payroll');
    const billDisbursements = async (): Promise<any[]> => (await core.listDocuments(org, payments.PAYMENT_DISBURSEMENT_COLLECTION)).filter((row: any) => (row.data as any).kind === 'contractor_payroll');

    await t.test('each payee is paid with payroll or through payables, from the settings People already has', async () => {
      const upcoming = await read(userPublicationContext(manager), 'upcoming');
      occurrence = upcoming.upcoming.find((row: any) => row.employees.some((entry: any) => entry.payee.id === 'alice'));
      const all = [...occurrence.employees, ...occurrence.subcontractors];
      const by = (id: string) => all.find((entry: any) => entry.payee.id === id);
      assert.equal(by('alice').paid_through, 'payroll');
      assert.equal(by('cora').paid_through, 'payroll', 'a contractor paid on the pay schedule is paid with payroll');
      assert.equal(by('dev').paid_through, 'payables'); assert.equal(by('dev').due_date, plus(occurrence.pay_date, 15));
      assert.equal(by('acme').paid_through, 'payables'); assert.equal(by('acme').due_date, plus(occurrence.pay_date, 30));
      // Same rules for deductions: the off-cycle payment comes off Acme's earnings, never its reimbursement.
      assert.equal(by('acme').accrued.net_cents, 80000 + 1500 - 10000);
      batch = (await run(command, 'payroll.batch.create', { schedule_id: schedule.id, pay_date: occurrence.pay_date })).batch;
      assert.equal(item(batch, 'dev').metadata.paid_through, 'payables'); assert.equal(item(batch, 'dev').metadata.due_date, plus(occurrence.pay_date, 15));
      assert.deepEqual(item(batch, 'dev').metadata.payment_terms, { basis: 'net_days', net_days: 15 });
      assert.equal(item(batch, 'alice').metadata.paid_through, 'payroll'); assert.equal(item(batch, 'cora').metadata.paid_through, 'payroll');
      assert.equal((await payrollBills()).length, 0, 'nothing is billed while the run is a draft');
    });

    await t.test('marking the run paid pays payroll payees and turns bills into payables linked to their ledger entries', async () => {
      for (const action of [{ action: 'submit_approval', approvers: [{ user_id: 'alice' }] }, { action: 'approve' }, { action: 'finalize' }]) await run(command, 'payroll.batch.action', action, batch.id);
      const result = await run(command, 'payroll.batch.action', { action: 'paid', payment_reference: 'GUSTO-1' }, batch.id);
      batch = result.batch;
      assert.equal(item(batch, 'alice').status, 'paid'); assert.equal(item(batch, 'cora').status, 'paid');
      assert.equal(item(batch, 'dev').status, 'run'); assert.equal(item(batch, 'acme').status, 'run');
      assert.equal(batch.status, 'run', 'the run is entered until its bills are paid');
      const bills = await payrollBills();
      assert.deepEqual(bills.map((row: any) => row.payee_ref.id).sort(), ['acme', 'dev'], 'payroll payees never become payables');
      const acmeBill = bills.find((row: any) => row.payee_ref.id === 'acme');
      assert.equal(acmeBill.amount_cents, item(batch, 'acme').net_cents); assert.equal(acmeBill.status, 'open');
      assert.equal(acmeBill.due_at.slice(0, 10), plus(occurrence.pay_date, 30));
      assert.equal(acmeBill.source.batch_id, batch.id); assert.equal(acmeBill.source.id, item(batch, 'acme').id);
      const linked = acmeBill.metadata.payroll_ledger_entries.map((row: any) => row.ledger_entry_id).sort();
      assert.deepEqual(linked, item(batch, 'acme').entries.map((entry: any) => entry.id).sort());
      assert.equal(acmeBill.metadata.payroll_ledger_entries.reduce((sum: number, row: any) => sum + row.applied_cents, 0), acmeBill.amount_cents);
      const listed = await read(userPublicationContext(manager), 'bills');
      assert.deepEqual(listed.map((row: any) => [row.payee.id, row.status, row.due_date]), [['dev', 'open', plus(occurrence.pay_date, 15)], ['acme', 'open', plus(occurrence.pay_date, 30)]]);
      // Owed, not paid: the earnings are in a pay run.
      const owed = (await read(userPublicationContext(manager), 'earnings', { payees: [{ type: 'organization_connection', id: 'acme' }] })).earnings[0];
      assert.equal(owed.totals.paid_cents, 10000, 'only the payment made outside a pay run'); assert.equal(owed.totals.in_payroll_cents, acmeBill.amount_cents);
      assert.equal(owed.payments[0].paid_through, 'payables'); assert.equal(owed.payments[0].due_date, plus(occurrence.pay_date, 30));
    });

    await t.test('paying a bill in payables marks the pay run item paid exactly once', async () => {
      const acmeBill = (await payrollBills()).find((row: any) => row.payee_ref.id === 'acme');
      await payments.createDisbursement(org, { payable_ids: [acmeBill.id], amount_cents: acmeBill.amount_cents, notes: 'ACH 7781' }, manager);
      let stored = await store.readPayrollBatch(org, batch.id);
      const paid = item(stored, 'acme');
      assert.equal(paid.status, 'paid'); assert.equal(paid.payment_reference, 'ACH 7781');
      assert.equal(paid.metadata.settlement.source, 'payables'); assert.equal(paid.metadata.settlement.payable_id, acmeBill.id);
      const earnings = (await read(userPublicationContext(manager), 'earnings', { payees: [{ type: 'organization_connection', id: 'acme' }] })).earnings[0];
      assert.equal(earnings.totals.paid_cents, 10000 + acmeBill.amount_cents); assert.equal(earnings.totals.owed_cents, 0);
      // A second payment report, and a re-run of the pay run's sync, change nothing.
      const revision = paid.revision, disbursements = (await billDisbursements()).length;
      await payables.settlePaidPayrollBills(org, [acmeBill.id], { id: 'again', notes: 'again' }, manager);
      await run(command, 'payroll.batch.action', { action: 'paid' }, batch.id);
      stored = await store.readPayrollBatch(org, batch.id);
      assert.equal(item(stored, 'acme').revision, revision); assert.equal(item(stored, 'acme').payment_reference, 'ACH 7781');
      assert.equal((await billDisbursements()).length, disbursements);
      assert.equal((await payrollBills()).length, 2, 'no bill is made twice');
      assert.equal(stored.status, 'run');
    });

    await t.test('marking a bill paid in Payroll records the payment against it once', async () => {
      const devItem = item(batch, 'dev');
      batch = (await run(command, 'payroll.batch.item.update', { item_id: devItem.id, status: 'paid', payment_reference: 'Check 220' }, batch.id)).batch;
      assert.equal(batch.status, 'paid');
      const devBill = (await payrollBills()).find((row: any) => row.payee_ref.id === 'dev');
      assert.equal(devBill.status, 'paid'); assert.equal(devBill.paid_cents, devBill.amount_cents);
      const recorded = await billDisbursements();
      assert.equal(recorded.filter((row: any) => (row.data as any).payable_ids.includes(devBill.id)).length, 1);
      await run(command, 'payroll.batch.action', { action: 'paid' }, batch.id).catch(() => null);
      assert.equal((await billDisbursements()).length, recorded.length);
      assert.equal(item(await store.readPayrollBatch(org, batch.id), 'dev').payment_reference, 'Check 220');
      assert.deepEqual(await read(userPublicationContext(manager), 'bills'), [], 'no open bills are left');
    });

    await t.test('the next pay run never includes billed earnings again', async () => {
      const upcoming = await read(userPublicationContext(manager), 'upcoming');
      const later = upcoming.upcoming.filter((row: any) => !row.batch);
      assert.ok(later.every((row: any) => [...row.employees, ...row.subcontractors].every((entry: any) => !['acme', 'dev'].includes(entry.payee.id))));
      const open = await store.listPayrollLedgerEntries(org, { open_only: true, limit: 5000 });
      assert.equal(open.filter((entry: any) => ['acme', 'dev'].includes(entry.payee.id)).length, 0);
    });

    let second: any;
    await t.test('a partly paid bill keeps the item open, and its run cannot be reopened', async () => {
      await earn(acme, 'piece_rate', 40000);
      const next = (await read(userPublicationContext(manager), 'upcoming')).upcoming.find((row: any) => !row.batch && row.subcontractors.some((entry: any) => entry.payee.id === 'acme'));
      second = (await run(command, 'payroll.batch.create', { schedule_id: schedule.id, pay_date: next.pay_date })).batch;
      for (const action of [{ action: 'submit_approval', approvers: [{ user_id: 'alice' }] }, { action: 'approve' }, { action: 'finalize' }, { action: 'run' }]) second = (await run(command, 'payroll.batch.action', action, second.id)).batch;
      const bill = (await payrollBills()).find((row: any) => row.source.batch_id === second.id);
      assert.equal(bill.amount_cents, 40000);
      await payments.createDisbursement(org, { payable_ids: [bill.id], amount_cents: 15000 }, manager);
      assert.equal(item(await store.readPayrollBatch(org, second.id), 'acme').status, 'run');
      const listed = (await read(userPublicationContext(manager), 'bills')).find((row: any) => row.id === bill.id);
      assert.equal(listed.status, 'partially_paid'); assert.equal(listed.paid_cents, 15000);
      await assert.rejects(run(command, 'payroll.batch.action', { action: 'reopen' }, second.id), /already has a payment in payables/);
      await payments.createDisbursement(org, { payable_ids: [bill.id], amount_cents: 25000 }, manager);
      assert.equal(item(await store.readPayrollBatch(org, second.id), 'acme').status, 'paid');
      assert.equal((await store.readPayrollBatch(org, second.id)).status, 'paid');
    });

    await t.test('a payment payables recorded without telling payroll is finished by reconcile', async () => {
      await earn(acme, 'piece_rate', 9000);
      const next = (await read(userPublicationContext(manager), 'upcoming')).upcoming.find((row: any) => !row.batch && row.subcontractors.some((entry: any) => entry.payee.id === 'acme'));
      let fourth = (await run(command, 'payroll.batch.create', { schedule_id: schedule.id, pay_date: next.pay_date })).batch;
      for (const action of [{ action: 'submit_approval', approvers: [{ user_id: 'alice' }] }, { action: 'approve' }, { action: 'finalize' }, { action: 'paid' }]) fourth = (await run(command, 'payroll.batch.action', action, fourth.id)).batch;
      const bill = (await payrollBills()).find((row: any) => row.source.batch_id === fourth.id && row.payee_ref.id === 'acme');
      const doc = await core.readDocument(org, payments.PAYMENT_PAYABLE_COLLECTION, bill.id);
      await core.upsertDocument(org, payments.PAYMENT_PAYABLE_COLLECTION, { id: bill.id, data: { ...(doc.data as any), status: 'paid', paid_cents: bill.amount_cents } }, { replace: true });
      const listed = (await read(userPublicationContext(manager), 'bills', { status: 'all' })).find((row: any) => row.id === bill.id);
      assert.equal(listed.needs_settlement, true);
      assert.deepEqual(await run(command, 'payroll.bills.reconcile', {}), { settled_count: 1, removed_count: 0 });
      assert.equal(item(await store.readPayrollBatch(org, fourth.id), 'acme').status, 'paid');
      assert.deepEqual(await run(command, 'payroll.bills.reconcile', {}), { settled_count: 0, removed_count: 0 }, 'a second reconcile changes nothing');
    });

    await t.test('bills follow branch scope', async () => {
      await earn(acme, 'piece_rate', 3000); await earn(dev, 'piece_rate', 2000);
      const next = (await read(userPublicationContext(manager), 'upcoming')).upcoming.find((row: any) => !row.batch && row.subcontractors.length);
      let fifth = (await run(command, 'payroll.batch.create', { schedule_id: schedule.id, pay_date: next.pay_date })).batch;
      for (const action of [{ action: 'submit_approval', approvers: [{ user_id: 'alice' }] }, { action: 'approve' }, { action: 'finalize' }, { action: 'run' }]) fifth = (await run(command, 'payroll.batch.action', action, fifth.id)).batch;
      const structure = { branches: [{ id: 'default', status: 'active' }, { id: 'north', status: 'active' }], catalog: { regions: [] },
        users: [{ id: 'alice', branch_ids: ['default'] }, { id: 'cora', branch_ids: ['default'] }, { id: 'dev', branch_ids: ['default'] }], groups: [], connections: [{ id: 'acme', branch_ids: ['north'] }] };
      const local = auth('alice', { manage_payroll: true }, { organizationStructure: structure, user: { id: 'alice', name: 'Alice', branch_id: 'default' }, capabilities: { effectiveByKey: { ...caps.effectiveByKey, 'platform.multiple_branches': true } } });
      const seen = await read(userPublicationContext(local), 'bills');
      assert.deepEqual(seen.map((row: any) => row.payee.id), ['dev'], 'a company of another branch is not shown');
      const everyone = await read(userPublicationContext(manager), 'bills');
      assert.deepEqual(everyone.map((row: any) => row.payee.id).sort(), ['acme', 'dev']);
    });

    await t.test('reopening or voiding a run removes its unpaid bills', async () => {
      await earn(dev, 'piece_rate', 7000);
      const next = (await read(userPublicationContext(manager), 'upcoming')).upcoming.find((row: any) => !row.batch && row.subcontractors.some((entry: any) => entry.payee.id === 'dev'));
      let third = (await run(command, 'payroll.batch.create', { schedule_id: schedule.id, pay_date: next.pay_date })).batch;
      for (const action of [{ action: 'submit_approval', approvers: [{ user_id: 'alice' }] }, { action: 'approve' }, { action: 'finalize' }, { action: 'run' }]) third = (await run(command, 'payroll.batch.action', action, third.id)).batch;
      const bill = (await payrollBills()).find((row: any) => row.source.batch_id === third.id);
      assert.equal(bill.status, 'open');
      third = (await run(command, 'payroll.batch.action', { action: 'reopen', note: 'fix' }, third.id)).batch;
      assert.equal((await payrollBills()).find((row: any) => row.id === bill.id).status, 'void');
      assert.equal(item(third, 'dev').metadata.paid_through, 'payables', 'reopening works out how each payee is paid again');
      third = (await run(command, 'payroll.batch.action', { action: 'void' }, third.id)).batch;
      assert.ok((await payrollBills()).filter((row: any) => row.source.batch_id === third.id).every((row: any) => row.status === 'void'));
      assert.equal((await store.listPayrollLedgerEntries(org, { open_only: true, payee_id: 'dev' })).length, 1, 'its earnings wait for the next run');
    });

    await t.test('with Money off nobody is paid through payables', async () => {
      await saveCapabilityValues(org, { 'platform.money': false });
      const routes = await payables.paymentRoutes(org, [acme, dev, alice]);
      assert.deepEqual([...routes.values()].map((route) => route.paid_through), ['payroll', 'payroll', 'payroll']);
      await saveCapabilityValues(org, { 'platform.money': true });
      assert.equal((await payables.paymentRoutes(org, [acme])).get('organization_connection:acme')!.paid_through, 'payables');
    });
  } finally {
    await (await import('./helpers/platform-fixture.js')).closePlatformFixtureStores();
    await rm(root, { recursive: true, force: true }).catch(() => {});
  }
});
