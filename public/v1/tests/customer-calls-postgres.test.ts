import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';

test('voice health works on PostgreSQL before usage exists and reports deduplicated costs', {skip:!process.env.TEST_POSTGRES_URL}, async t => {
  Object.assign(process.env,{NODE_ENV:'test',FIRSTMATE_ENV:'test',FIRSTMEASURE_DATA_ENVIRONMENT:'test',FIRSTMEASURE_DATABASE_MODE:'postgres',DATABASE_URL:process.env.TEST_POSTGRES_URL,POSTGRES_POOL_MAX:'1',POSTGRES_AUTO_MIGRATE:'false'});
  const storage=await import('../messaging/communications_storage.js');
  const {closePostgresPools}=await import('../src/database/postgres.js');
  const {voiceHealth,recordVoiceCost}=await import('../comms/calls/operations.js');
  t.after(async()=>{await storage.closeCommunicationsDatabase();await closePostgresPools();});
  assert.equal(storage.getCommunicationsDatabase().isPostgres,true);
  const org=`voice_pg_${randomUUID()}`;
  const empty=await voiceHealth(org);
  assert.equal(empty.healthy,true);
  assert.deepEqual(empty.usage_last_24_hours,[]);
  const payload={call_leg_id:'pg-leg',status:'success',total_cost:'0.0123',cost_parts:[{currency:'USD'}]};
  await recordVoiceCost(org,'pg-call','pg-event',payload);
  await recordVoiceCost(org,'pg-call','pg-event-retry',payload);
  const health=await voiceHealth(org);
  assert.equal(health.healthy,true);
  assert.equal(Number(health.usage_last_24_hours[0]?.legs),1);
  assert.ok(Math.abs(Number(health.usage_last_24_hours[0]?.reported_amount)-0.0123)<0.000001);
  assert.deepEqual((await voiceHealth('another-org')).usage_last_24_hours,[]);
});
