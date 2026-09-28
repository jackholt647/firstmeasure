import test from 'node:test';
import assert from 'node:assert/strict';

test('development onboarding exposes the global assistant without expanding other apps',async()=>{
  process.env.FIRSTMEASURE_DATA_ENVIRONMENT='development';
  const {resolveCapabilities}=await import('../platform/capabilities.js');
  await import('../platform/capability_defs.js');
  await import('../assistant/capabilities.js');
  const {effectiveByKey}=resolveCapabilities({'platform.expanded_access':false});
  assert.equal(effectiveByKey['apps.assistant'],true);
  assert.equal(effectiveByKey['assistant.actions'],true);
  assert.equal(effectiveByKey['permission.use_assistant'],true);
  assert.equal(effectiveByKey['platform.money'],true);
  assert.equal(effectiveByKey['money.merchant_processing'],true);
  assert.equal(effectiveByKey['money.take_payment'],false);
  assert.equal(effectiveByKey['apps.crm'],false);
  const {routeNeedsExpandedPlatform}=await import('../platform/rollout_routes.js');
  assert.equal(routeNeedsExpandedPlatform('/v1/assistant/organizations/:orgId/context',{}),false);
  assert.equal(routeNeedsExpandedPlatform('/v1/documents/organizations/:orgId/documents',{}),true);
  process.env.FIRSTMEASURE_DATA_ENVIRONMENT='production';
  assert.equal(routeNeedsExpandedPlatform('/v1/assistant/organizations/:orgId/context',{}),true);
});
