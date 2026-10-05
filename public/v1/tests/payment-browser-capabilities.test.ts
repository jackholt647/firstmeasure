import test from 'node:test';
import assert from 'node:assert/strict';

test('development FirstMeasure accounts keep assistant and Money disabled until expanded access and explicit opt-in',async()=>{
  process.env.FIRSTMEASURE_DATA_ENVIRONMENT='development';
  const {resolveCapabilities}=await import('../platform/capabilities.js');
  await import('../platform/capability_defs.js');
  await import('../assistant/capabilities.js');
  const {effectiveByKey}=resolveCapabilities({'platform.expanded_access':false});
  assert.equal(effectiveByKey['apps.assistant'],false);
  assert.equal(effectiveByKey['assistant.actions'],false);
  assert.equal(effectiveByKey['permission.use_assistant'],false);
  assert.equal(effectiveByKey['platform.money'],false);
  assert.equal(effectiveByKey['money.merchant_processing'],false);
  assert.equal(effectiveByKey['money.take_payment'],false);
  assert.equal(effectiveByKey['apps.crm'],false);
  assert.equal(effectiveByKey['apps.notifications'],false);
  assert.equal(effectiveByKey['platform.connections'],false);
  const enabled=resolveCapabilities({'platform.expanded_access':true,'apps.assistant':true,'platform.money':true,'money.merchant_processing':true}).effectiveByKey;
  assert.equal(enabled['apps.assistant'],true);assert.equal(enabled['platform.money'],true);assert.equal(enabled['money.merchant_processing'],true);
  const {routeNeedsExpandedPlatform}=await import('../platform/rollout_routes.js');
  assert.equal(routeNeedsExpandedPlatform('/v1/assistant/organizations/:orgId/context',{}),true);
  assert.equal(routeNeedsExpandedPlatform('/v1/documents/organizations/:orgId/documents',{}),true);
  process.env.FIRSTMEASURE_DATA_ENVIRONMENT='production';
  assert.equal(routeNeedsExpandedPlatform('/v1/assistant/organizations/:orgId/context',{}),true);
});
