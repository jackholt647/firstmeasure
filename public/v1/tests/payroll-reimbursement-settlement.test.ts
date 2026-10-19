import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';

// A reimbursement approved to be paid with payroll has a ledger entry and a payable of its own, linked by the entry's
// metadata.payable_id (payments/reimbursements.ts makes both; this test makes the same two records). Paid directly in
// payables, it must never be paid again by a pay run (docs/architecture/pay-rules.md#reimbursements-paid-in-payables).
const day = (offset: number) => new Date(Date.now() + offset * 86400000).toISOString().slice(0, 10);

test('a reimbursement paid in payables is settled in payroll exactly once, whichever comes first', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'payroll-reimb-'));
  Object.assign(process.env, { NODE_ENV: 'test', FIRSTMATE_ENV: 'test', PLATFORM_STORAGE_ROOT: root, FIRSTMEASURE_DATABASE_MODE: 'local', FIRSTMEASURE_INDEX_DB_PATH: path.join(root, 'index.sqlite') });
  const core = await import('../platform/storage.js'), store = await import('../payroll/storage.js'), service = await import('../payroll/service.js');
  const payments = await import('../payments/storage.js'), payables = await import('../payroll/payables.js');
  const { saveCapabilityValues } = await import('../platform/capabilities.js'), { userPublicationContext } = await import('../platform/publication/context.js');
  const { readPublishedData } = await import('../platform/publication/providers.js');
  const { invokeAction } = await import('../platform/publication/actions.js');
  const org = 'org_reimb';
  try {
    await core.createOrganization({ id: org, name: 'Reimbursements' });
    await saveCapabilityValues(org, { 'platform.expanded_access': true, 'apps.payroll': true, 'payroll.pay_runs': true, 'platform.money': true });
    await core.upsertDocument(org, 'users', { id: 'alice', data: { name: 'Alice Archer', status: 'active', worker_classification: 'employee' } });
    const manager: any = { orgId: org, userId: 'owner', role: 'member', user: { id: 'owner', name: 'Owner' }, permissions: { manage_payroll: true, manage_company_settings: true, manage_projects: true }, applicationAccess: { management: { enabled: true, permissions: { '*': true } } }, capabilities: { effectiveByKey: { 'apps.payroll': true, 'payroll.pay_runs': true } } };
    const command = userPublicationContext(manager, { mode: 'command' }), target = { scope: 'organization' as const, organizationId: org };
    (await import('../platform/publication/bootstrap.js')).initializePublication();
    let key = 0;
    const run = async (action: string, input: any = {}, id?: string) => (await invokeAction(command, { action, target: { ...target, ...(id ? { id } : {}) } }, input, { idempotencyKey: `${action}:${++key}` })).value as any;
    const schedule = await run('payroll.schedule.create', { name: 'Weekly', recurrence: { frequency: 'weekly', weekday: new Date(`${day(3)}T12:00:00Z`).getUTCDay() } });
    await run('payroll.payDefault.save', { subject: { type: 'organization', id: org }, entries: [], schedules: [{ effective_from: '2026-01-01', schedule_id: schedule.id }] });
    await run('payroll.settings.save', { approval_required: false });
    const alice = { type: 'organization_user', id: 'alice', name: 'Alice Archer', worker_type: 'employee' };
    const worked = `${day(-2)}T15:00:00.000Z`;
    let n = 0;
    const hours = (cents: number) => service.recordPayrollLedgerEntries(org, [{ payee: alice, schedule_id: schedule.id, kind: 'hourly', state: 'accrued', amount_cents: cents, worked_at: worked, source_event_id: `hours-${++n}` } as any]);
    // What approving a reimbursement "with the next payroll" writes: a payable and a ledger entry naming it.
    const reimbursement = async (receipt: string, cents: number) => {
      const payable = await payments.createPayable(org, { id: `payment_payable_reimbursement_${receipt}`, kind: 'reimbursement', amount_cents: cents, payee_ref: { kind: 'organization_user', id: 'alice', name: 'Alice Archer' }, source: { type: 'receipt', id: receipt }, metadata: { receipt_id: receipt } }, manager);
      const [entry] = await service.recordPayrollLedgerEntries(org, [{ id: `pay_entry_reimbursement_${receipt}`, payee: alice, schedule_id: schedule.id, kind: 'reimbursement', subgroup: 'reimbursement', state: 'accrued', amount_cents: cents, completed_at: worked, eligible_at: worked, source_event_id: `reimbursement_request_${receipt}`, source_trigger_id: receipt, metadata: { receipt_id: receipt, payable_id: payable.id, payment_timing: 'next_payroll' } } as any]);
      return { payable, entry: entry as any };
    };
    const payInPayables = (payableId: string, cents: number) => payments.createDisbursement(org, { payable_ids: [payableId], amount_cents: cents, kind: 'reimbursement' }, manager);
    const nextOpen = async () => (await readPublishedData(userPublicationContext(manager), { provider: 'payroll', export: 'upcoming', target }) as any).value.upcoming.find((row: any) => !row.batch && row.employees.length);
    const reimbursementsIn = (batch: any) => batch.items.flatMap((item: any) => item.entries).filter((entry: any) => entry.kind === 'reimbursement').map((entry: any) => entry.id);

    await t.test('paid in payables first: the entry is settled once and no pay run includes it', async () => {
      await hours(50000);
      const first = await reimbursement('r1', 4200);
      await payInPayables(first.payable.id as string, 4200);
      const settled = await store.readPayrollLedgerEntry(org, first.entry.id);
      assert.equal(settled.state, 'void'); assert.equal((settled.metadata as any).settled_in_payables.payable_id, first.payable.id);
      const revision = settled.revision;
      // Reported again, or swept by reconcile, nothing changes.
      await payables.settlePaidPayrollBills(org, [first.payable.id as string], { id: 'again' }, manager);
      assert.deepEqual(await payables.settleReimbursementsPaidInPayables(org), { voided_count: 0, held_count: 0 });
      assert.equal((await store.readPayrollLedgerEntry(org, first.entry.id)).revision, revision);
      // A payment payables recorded without the hook (here written straight to the payable) is settled before a draft.
      const second = await reimbursement('r2', 1800);
      const doc = await core.readDocument(org, payments.PAYMENT_PAYABLE_COLLECTION, second.payable.id as string);
      await core.upsertDocument(org, payments.PAYMENT_PAYABLE_COLLECTION, { id: second.payable.id as string, data: { ...(doc.data as any), status: 'paid', paid_cents: 1800 } }, { replace: true });
      const occurrence = await nextOpen();
      const batch = (await run('payroll.batch.create', { schedule_id: schedule.id, pay_date: occurrence.pay_date })).batch;
      assert.deepEqual(reimbursementsIn(batch), [], 'neither reimbursement is in the pay run');
      assert.equal(batch.items[0].net_cents, 50000);
      assert.equal((await store.readPayrollLedgerEntry(org, second.entry.id)).state, 'void');
      await run('payroll.batch.action', { action: 'paid' }, batch.id);
    });

    await t.test('already in a pay run: the item is held until the run is reopened without it', async () => {
      await hours(30000);
      const third = await reimbursement('r3', 2500);
      const occurrence = await nextOpen();
      let batch = (await run('payroll.batch.create', { schedule_id: schedule.id, pay_date: occurrence.pay_date })).batch;
      assert.deepEqual(reimbursementsIn(batch), [third.entry.id]);
      await payInPayables(third.payable.id as string, 2500);
      const item = (await store.readPayrollBatch(org, batch.id)).items[0]!;
      assert.equal((item.metadata as any).reimbursement_paid_in_payables[0].ledger_entry_id, third.entry.id);
      // Paying the run now would pay the reimbursement twice: refused, for the run and for the person.
      await assert.rejects(run('payroll.batch.action', { action: 'paid' }, batch.id), /already paid in payables/);
      await assert.rejects(run('payroll.batch.action', { action: 'run' }, batch.id), /already paid in payables/);
      await assert.rejects(run('payroll.batch.item.update', { item_id: item.id, status: 'paid' }, batch.id), /already paid in payables/);
      assert.deepEqual(await payables.settleReimbursementsPaidInPayables(org), { voided_count: 0, held_count: 0 }, 'holding twice changes nothing');
      // Reopened, the run is worked out without it, and the entry is settled.
      batch = (await run('payroll.batch.action', { action: 'reopen', note: 'reimbursement paid in payables' }, batch.id)).batch;
      assert.deepEqual(reimbursementsIn(batch), []);
      assert.equal(batch.items[0].net_cents, 30000);
      assert.equal((await store.readPayrollLedgerEntry(org, third.entry.id)).state, 'void');
      assert.equal((await run('payroll.batch.action', { action: 'paid' }, batch.id)).batch.status, 'paid');
      assert.equal((await store.listPayrollLedgerEntries(org, { open_only: true, kind: 'reimbursement' })).length, 0, 'nothing is left for a later run');
    });

    await t.test('paid by payroll first: marking its payable paid afterwards changes nothing', async () => {
      await hours(10000);
      const fourth = await reimbursement('r4', 900);
      const occurrence = await nextOpen();
      const batch = (await run('payroll.batch.create', { schedule_id: schedule.id, pay_date: occurrence.pay_date })).batch;
      assert.equal((await run('payroll.batch.action', { action: 'paid' }, batch.id)).batch.status, 'paid');
      // What payroll's own reimbursement sync does once the item is paid.
      await payInPayables(fourth.payable.id as string, 900);
      const entry = await store.readPayrollLedgerEntry(org, fourth.entry.id);
      assert.equal(entry.state, 'accrued'); assert.equal(entry.remaining_cents, 0);
      assert.equal(((await store.readPayrollBatch(org, batch.id)).items[0]!.metadata as any).reimbursement_paid_in_payables, undefined);
    });
  } finally {
    await (await import('./helpers/platform-fixture.js')).closePlatformFixtureStores();
    await rm(root, { recursive: true, force: true }).catch(() => {});
  }
});
