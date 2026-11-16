import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { closePlatformFixtureStores, enableExpandedPlatformFixture } from './helpers/platform-fixture.js';
const dir = await mkdtemp(path.join(os.tmpdir(), 'comms-setup-'));
Object.assign(process.env, { NODE_ENV: 'test', PLATFORM_STORAGE_ROOT: path.join(dir, 'platform'), PRICEBOOK_STORAGE_ROOT: path.join(dir, 'pricebook'), FIRSTMEASURE_STORAGE_ROOT: path.join(dir, 'firstmeasure'), FIRSTMEASURE_INDEX_DB_PATH: path.join(dir, 'index.sqlite'), PLATFORM_HEARTBEAT_DISABLED: '1', FIRSTMEASURE_JOB_WORKERS: '0' });
after(async () => { await closePlatformFixtureStores(); await rm(dir, { recursive: true, force: true }); });

// FM-491: the Communications setup turns texts (and SMS settings) or the email inbox on through published actions,
// only for someone who manages company settings.
test('Communications setup turns on texts or email as the person, and reports what is set up', async () => {
  await import('../chat/capabilities.js'); await import('../comms/capabilities.js');
  const storage = await import('../platform/storage.js');
  const orgId = 'org_comms_setup';
  await storage.createOrganization({ id: orgId, name: 'Comms setup test' });
  await enableExpandedPlatformFixture(orgId, { 'apps.comms': true, 'comms.sms': false, 'comms.email': false });
  const capabilities = await import('../platform/capabilities.js');
  await capabilities.saveCapabilityValues(orgId, { 'apps.comms': true, 'comms.sms': false, 'comms.email': false });
  const { initializePublication } = await import('../platform/publication/bootstrap.js'); initializePublication();
  const { invokeAction } = await import('../platform/publication/actions.js');
  const { userPublicationContext } = await import('../platform/publication/context.js');
  const auth = (permissions: Record<string, boolean>, role = 'owner') => ({ orgId, userId: role, role, permissions, branchId: 'default', capabilities: { effectiveByKey: { 'apps.comms': true } } }) as any;
  const owner = userPublicationContext(auth({ '*': true }), { mode: 'command' });
  const target = { scope: 'organization' as const, organizationId: orgId };

  const before = await invokeAction({ ...owner, mode: 'evaluate' }, { action: 'comms.setup.status', target }, {}) as any;
  assert.deepEqual(before.value.done, { phone: false, email: false });

  const phone = await invokeAction(owner, { action: 'comms.setup.start', target }, { channel: 'phone' }, { idempotencyKey: 'comms-setup-phone' }) as any;
  assert.equal(phone.value.phone.texts, true);
  for (const key of ['comms.sms', 'apps.messaging', 'platform.sms_settings']) assert.equal(await capabilities.isCapabilityEnabled(orgId, key), true, key);
  assert.equal(await capabilities.isCapabilityEnabled(orgId, 'comms.email'), false, 'texts and calls leave email alone');

  const email = await invokeAction(owner, { action: 'comms.setup.start', target }, { channel: 'email' }, { idempotencyKey: 'comms-setup-email' }) as any;
  assert.equal(email.value.email.on, true);
  assert.match(email.value.email.address, /@/, 'the company inbox address is created');
  assert.deepEqual(email.value.done, { phone: true, email: true });

  await assert.rejects(() => invokeAction(owner, { action: 'comms.setup.start', target }, { channel: 'fax' }, { idempotencyKey: 'comms-setup-fax' }));
  const viewer = userPublicationContext(auth({ view_comms: true }, 'member'), { mode: 'command' });
  await assert.rejects(() => invokeAction(viewer, { action: 'comms.setup.start', target }, { channel: 'email' }, { idempotencyKey: 'comms-setup-viewer' }));
});
