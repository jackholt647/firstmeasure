import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { closePlatformFixtureStores, enableExpandedPlatformFixture } from './helpers/platform-fixture.js';
const dir = await mkdtemp(path.join(os.tmpdir(), 'payments-setup-'));
Object.assign(process.env, { NODE_ENV: 'test', PLATFORM_STORAGE_ROOT: path.join(dir, 'platform'), PRICEBOOK_STORAGE_ROOT: path.join(dir, 'pricebook'), MESSAGING_STORAGE_ROOT: path.join(dir, 'messaging'), FIRSTMEASURE_STORAGE_ROOT: path.join(dir, 'firstmeasure'), FIRSTMEASURE_INDEX_DB_PATH: path.join(dir, 'index.sqlite'), PLATFORM_HEARTBEAT_DISABLED: '1', FIRSTMEASURE_JOB_WORKERS: '0' });
after(async () => { await closePlatformFixtureStores(); await rm(dir, { recursive: true, force: true }); });

// GP-128: in a new organization Money's setup could not turn online processing on (the capabilities route is operator
// only), so Forward's application opened on "Merchant boarding is not available". Starting the setup is a published
// action run as the person: it turns processing on for someone who manages company settings, and for nobody else.
test('starting payment setup turns on online processing as the person', async () => {
  const storage = await import('../platform/storage.js');
  const orgId = 'org_payments_setup';
  await storage.createOrganization({ id: orgId, name: 'Payments setup test' });
  await enableExpandedPlatformFixture(orgId, { 'platform.money': true, 'money.take_payment': true, 'money.merchant_processing': false });
  const capabilities = await import('../platform/capabilities.js');
  await capabilities.saveCapabilityValues(orgId, { 'platform.money': true, 'money.take_payment': true, 'money.merchant_processing': false });
  const { paymentsReadiness } = await import('../payments/readiness.js');
  assert.equal((await paymentsReadiness(orgId)).reason, 'online_processing_off');

  const { initializePublication } = await import('../platform/publication/bootstrap.js'); initializePublication();
  const { invokeAction } = await import('../platform/publication/actions.js');
  const { userPublicationContext } = await import('../platform/publication/context.js');
  const auth = (permissions: Record<string, boolean>, role = 'owner') => ({ orgId, userId: role, role, permissions, branchId: 'default', capabilities: { effectiveByKey: { 'platform.money': true } } }) as any;
  const target = { scope: 'organization' as const, organizationId: orgId };

  const member = userPublicationContext(auth({ manage_projects: true }, 'member'), { mode: 'command' });
  await assert.rejects(() => invokeAction(member, { action: 'payments.setup.start', target }, {}, { idempotencyKey: 'payments-setup-member' }));
  assert.equal(await capabilities.isCapabilityEnabled(orgId, 'money.merchant_processing'), false, 'only company settings access starts it');

  const owner = userPublicationContext(auth({ '*': true }), { mode: 'command' });
  const started = await invokeAction(owner, { action: 'payments.setup.start', target }, {}, { idempotencyKey: 'payments-setup-owner' }) as any;
  assert.equal(started.value.started, true);
  assert.equal(await capabilities.isCapabilityEnabled(orgId, 'money.merchant_processing'), true);
  assert.notEqual(started.value.readiness.reason, 'online_processing_off', 'the answer is where payments stand now');
  // Turning processing on is not being able to take payments: that still needs Forward's approved account.
  assert.equal(started.value.readiness.ready, false);
  // Starting again (another click on Setup) is harmless.
  await invokeAction(owner, { action: 'payments.setup.start', target }, {}, { idempotencyKey: 'payments-setup-owner-again' });
  assert.equal(await capabilities.isCapabilityEnabled(orgId, 'money.merchant_processing'), true);
});
