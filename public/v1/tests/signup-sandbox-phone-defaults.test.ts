import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

test('instant development organizations onboard phones automatically only with verified transport', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'fm-sandbox-phones-'));
  process.chdir(root);
  Object.assign(process.env, {
    FIRSTMATE_ENV: 'development', FIRSTMEASURE_DATA_ENVIRONMENT: 'development',
    FIRSTMEASURE_DATABASE_MODE: 'sqlite', PLATFORM_STORAGE_ROOT: path.join(root, 'platform'),
    SIGNUP_SANDBOX_STORAGE_ROOT: path.join(root, 'sandbox'),
    MESSAGING_STORAGE_ROOT: path.join(root, 'messaging'),
    PLATFORM_SESSION_SECRET: 'isolated-sandbox-phone-defaults-test-secret'
  });
  await import('../platform/capability_defs.js');
  const service = await import('../signup-sandbox/service.js');
  const store = await import('../comms/calls/storage.js');
  const { voiceSettings } = await import('../comms/calls/settings.js');
  const { developmentCallStatus } = await import('../comms/calls/development.js');
  const { env } = await import('../src/config/env.js');
  await service.ensureSeedData();
  const pending = await service.createTestInstance('swf_instant_full_org');
  const transportOrg = String(pending.testOrg.org_id);
  assert.equal((await voiceSettings(transportOrg)).enabled, false);
  assert.equal((await developmentCallStatus(transportOrg))?.onboarded, false);
  for (const kind of ['application', 'connection', 'outbound_profile']) {
    await store.saveResource(transportOrg, kind, 'default', { status: 'ready' }, `fixture-${kind}`);
  }
  await store.saveResource(transportOrg, 'number', '+12065550199', {
    status: 'active', phone_number: '+12065550199', branch_id: 'default'
  }, 'fixture-number');
  const ready = await service.createTestInstance('swf_instant_full_org');
  const orgId = String(ready.testOrg.org_id);
  assert.equal((await voiceSettings(orgId)).enabled, true);
  const status = await developmentCallStatus(orgId);
  assert.equal(status?.onboarded, true);
  assert.equal(store.object(status?.registrations).campaign_10dlc, 'mock_approved');
  assert.equal(status?.destination, '+12069415049');
  assert.equal((await store.resourceByProvider('application', 'fixture-application'))?.organization_id, transportOrg);
  Object.assign(env, { dataEnvironment: 'production' });
  const production = await service.createTestInstance('swf_instant_full_org');
  assert.equal((await voiceSettings(String(production.testOrg.org_id))).enabled, false);
  assert.equal(await store.resource(String(production.testOrg.org_id), 'development_onboarding'), null);
});
