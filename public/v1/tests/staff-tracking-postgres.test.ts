import test from 'node:test';
import assert from 'node:assert/strict';
import { reference, signalsFor, type TrackingEvent } from '../staff_tracking/core.js';

test('shared PostgreSQL event deduplication, lookups and retention', {skip:!process.env.TEST_POSTGRES_URL}, async () => {
  Object.assign(process.env,{FIRSTMATE_ENV:'test',FIRSTMEASURE_DATABASE_MODE:'postgres',DATABASE_URL:process.env.TEST_POSTGRES_URL,POSTGRES_AUTO_MIGRATE:'false'});
  const s=await import('../staff_tracking/store.js');
  const db=await import('../src/database/postgres.js');
  try {
    await s.initializeTrackingSchema();
    const now=Date.now();
    const e:TrackingEvent={id:reference('exam'),email:'trainee@example.test',name:'Trainee',at:new Date(now).toISOString(),ip:'8.8.8.8',kind:'exam_submit',session_ref:reference('session'),browser:'Chrome / Windows',established:false,impersonated:false,course:'one',attempt:'one',project:'one'};
    await Promise.all(Array.from({length:16},()=>s.insertEvent(e)));
    assert.equal((await s.trackingQuery('SELECT id FROM staff_tracking_events WHERE id=$1',[e.id])).length,1);
    for(let batch=0;batch<20;batch++)await Promise.all(Array.from({length:25},(_,i)=>s.insertEvent({...e,id:reference(`staff${batch}-${i}`),email:`staff-${batch}-${i}@example.test`,at:new Date(now-1000-batch*25-i).toISOString(),established:true,kind:'activity'})));
    const prior=await s.priorEvents(e);assert.equal(prior.length,500);assert.equal(signalsFor(e,prior)[0]?.matches.length,500);
    await db.queryPostgres(`INSERT INTO staff_tracking_events(id,email,at,ip,kind,attempt,course,data)
      SELECT repeat(md5('dense-'||g),2),$2,$3,$4,'activity','','',
      ($1::jsonb||jsonb_build_object('id',repeat(md5('dense-'||g),2),'email',$2::text,'at',$3::text,'kind','activity','attempt','','course',''))::text
      FROM generate_series(1,10002) g`,[JSON.stringify(e),'dense@example.test',new Date(now-100).toISOString(),e.ip]);
    assert.equal((await s.priorEvents(e)).limited,true,'large shared-network history reports bounded evidence instead of silently claiming completeness');
    await s.insertEvent({...e,id:reference('old'),at:new Date(now-91*86400000).toISOString()});await s.expireTracking();
    assert.equal((await s.trackingQuery('SELECT id FROM staff_tracking_events WHERE id=$1',[reference('old')])).length,0);
  } finally {await db.closePostgresPools();}
});
