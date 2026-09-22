import { nextTestPhone, enableExpandedPlatformFixture } from "./helpers/platform-fixture.js";
import assert from "node:assert/strict";
import test,{before,after} from "node:test";
import {mkdtemp,rm,mkdir,writeFile} from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import {generateKeyPairSync,sign} from "node:crypto";

let app:any,root="",store:typeof import("../comms/calls/storage.js"),worker:typeof import("../comms/calls/worker.js");
const keys=generateKeyPairSync("ed25519");
function client(){
  let cookie="",csrf="";
  const raw=async(method:string,url:string,payload?:unknown,headers:Record<string,string>={})=>{
    const response=await app.inject({method,url,payload,headers:{...(cookie?{cookie}:{}),...(csrf&&method!=="GET"?{"x-platform-csrf":csrf}:{}),...headers}});
    const cookies=response.headers["set-cookie"]||[];
    for(const value of Array.isArray(cookies)?cookies:[cookies]){const pair=String(value).split(";")[0]||"";const name=pair.split("=")[0];cookie=[...cookie.split("; ").filter(p=>p&&!p.startsWith(`${name}=`)),pair].join("; ");if(name==="fm_platform_session_csrf")csrf=decodeURIComponent(pair.slice(pair.indexOf("=")+1));}
    let data:any;try{data=response.json();}catch{data=null;}return {status:response.statusCode,data,body:response.body};
  };
  const request=async(method:string,url:string,payload?:unknown)=>{const result=await raw(method,url,payload);assert.ok(result.status<400,`${method} ${url}: ${result.status} ${result.body}`);return result.data;};
  return {raw,request};
}
async function owner(){const c=client();const suffix=Math.random().toString(36).slice(2);const data=await c.request("POST","/v1/platform/auth/register",{phone: nextTestPhone(), email:`calls-${suffix}@example.test`,password:"correct horse battery staple",name:"Call Owner",company:"Calls Test",organization_id:`calls_${suffix}`});
  await enableExpandedPlatformFixture(String(data.organization.id));return {c,orgId:String(data.organization.id)};}
before(async()=>{
  root=await mkdtemp(path.join(os.tmpdir(),"firstmate-customer-calls-"));
  Object.assign(process.env,{NODE_ENV:"test",PLATFORM_HEARTBEAT_DISABLED:"1",WORK_SCHEDULER_DISABLED:"1",CUSTOMER_CALL_WORKER_DISABLED:"1",EMAIL_OUTBOUND_DISABLED:"1",OPENAI_API_KEY:"",COMMUNICATIONS_DELIVERY_MODE:"capture",EMAIL_DELIVERY_MODE:"capture",TELNYX_VOICE_MODE:"disabled",V1_LOG_LEVEL:"error",
    PLATFORM_STORAGE_ROOT:path.join(root,"platform"),CRM_STORAGE_ROOT:path.join(root,"crm"),MESSAGING_STORAGE_ROOT:path.join(root,"messaging"),FIRSTMEASURE_STORAGE_ROOT:path.join(root,"firstmeasure"),FIRSTMEASURE_INDEX_DB_PATH:path.join(root,"firstmeasure","index.sqlite"),PRICEBOOK_STORAGE_ROOT:path.join(root,"pricebook"),
    CHANNELS_STORAGE_ROOT:path.join(root,'channels'),EMAIL_INBOUND_WEBHOOK_TOKEN:'',FIRSTMEASURE_JOB_WORKERS:'0',
    TELNYX_API_KEY:"test-key-never-sent",TELNYX_VOICE_WEBHOOK_URL:"https://voice.example.test/v1/comms/voice/webhooks/telnyx",
    TELNYX_WEBHOOK_PUBLIC_KEY:keys.publicKey.export({type:"spki",format:"pem"}).toString()});
  const {buildApp}=await import("../src/app.js");store=await import("../comms/calls/storage.js");worker=await import("../comms/calls/worker.js");app=await buildApp();await app.ready();
});
after(async()=>{
  const { closeSqlStoresForTests } = await import("../platform/sql_store.js");
  await app?.close();(await (await import("../work/storage.js")).closeWorkDatabase());(await (await import("../messaging/communications_storage.js")).closeCommunicationsDatabase());(await (await import('../channels/storage.js')).closeChannelsDatabase());
  (await (await import('../agents/storage.js')).closeAgentsDatabase());(await (await import('../workforce/storage.js')).closeWorkforceDatabase());
  (await import('../firstmeasure/project_index.js')).getFirstMeasureProjectIndexDb().close();
  await closeSqlStoresForTests();
  if(path.dirname(path.resolve(root))===path.resolve(os.tmpdir())&&path.basename(root).startsWith("firstmate-customer-calls-"))await rm(root,{recursive:true,force:true,maxRetries:5,retryDelay:100}).catch(()=>{});
},{timeout:15000});
test("call API authenticates, enforces tenant boundaries, and logs external calls with no invented media",async()=>{
  const {c,orgId}=await owner();const base=`/v1/comms/organizations/${orgId}`;
  assert.equal((await client().raw("GET",`${base}/calls`)).status,401);
  const created=await c.request("POST",`${base}/calls`,{operation_id:"external-attempt-1",customer_name:"Avery",customer_number:"2065550100"});
  assert.equal(created.call.mode,"external");assert.equal(created.call.customer_number,"+12065550100");assert.equal(created.call.connected_at,"");
  const other=await owner();assert.equal((await other.c.raw("GET",`${base}/calls/${created.call.id}`)).status,403);
  const calls=await c.request("GET",`${base}/calls`);assert.equal(calls.total,1);
  const control=await c.raw("POST",`${base}/calls/${created.call.id}/actions`,{operation_id:"manual-control-1",action:"hold"});assert.equal(control.status,409);
});
test("call creation and wrap-up retries keep one attempt and one follow-up",async()=>{
  const {c,orgId}=await owner();const base=`/v1/comms/organizations/${orgId}`;
  const input={operation_id:"idempotent-create",customer_name:"Avery",customer_number:"+12065550101"};
  const first=await c.request("POST",`${base}/calls`,input);const retry=await c.request("POST",`${base}/calls`,input);assert.equal(first.call.id,retry.call.id);
  assert.equal((await c.raw("POST",`${base}/calls`,{...input,customer_number:"+12065550102"})).status,409);
  const wrap={operation_id:"idempotent-wrap-up",revision:first.call.revision,disposition:"answered",notes:"",next_action:"follow_up",due_at:"2026-10-05",timezone:"America/Los_Angeles"};
  await c.request("POST",`${base}/calls/${first.call.id}/wrap-up`,wrap);await c.request("POST",`${base}/calls/${first.call.id}/wrap-up`,wrap);
  await worker.processOneJob("test-worker");
  const detail=await c.request("GET",`${base}/calls/${first.call.id}`);assert.equal(detail.call.wrap_up_state,"saved");assert.equal(detail.call.notes,"");assert.equal(detail.call.connected_at,"");
  const tasks=await c.request("GET",`${base}/follow-ups`);assert.equal(tasks.tasks.length,1);assert.equal(tasks.tasks[0].metadata.follow_up.call_id,first.call.id);
  assert.deepEqual(tasks.tasks[0].external_triggers,[]);
  assert.equal((await c.request("GET",`${base}/calls`)).total,1);
});
test("draft revisions protect notes and a saved wrap-up cannot create another outcome",async()=>{
  const {c,orgId}=await owner();const base=`/v1/comms/organizations/${orgId}`;
  const {call}=await c.request("POST",`${base}/calls`,{operation_id:"draft-test-call",customer_number:"+12065550103"});
  const draft=await c.request("PATCH",`${base}/calls/${call.id}/draft`,{revision:call.revision,notes:"Keep these notes."});
  assert.equal((await c.raw("PATCH",`${base}/calls/${call.id}/draft`,{revision:call.revision,notes:"Stale overwrite"})).status,409);
  await c.request("POST",`${base}/calls/${call.id}/wrap-up`,{operation_id:"first-outcome",revision:draft.call.revision,disposition:"answered",notes:"Keep these notes."});
  await worker.processOneJob("test-worker");
  const current=(await store.readCall(orgId,call.id));
  assert.equal((await c.raw("POST",`${base}/calls/${call.id}/wrap-up`,{operation_id:"second-outcome",revision:current.revision,disposition:"answered"})).status,409);
  assert.equal((await store.readCall(orgId,call.id)).notes,"Keep these notes.");
});
test("Skip retains list entry and never creates an attempt",async()=>{
  const {c,orgId}=await owner();const base=`/v1/comms/organizations/${orgId}`;
  await c.request("POST",`${base}/call-lists`,{key:"callbacks",title:"Callbacks"});
  const {entry}=await c.request("POST",`${base}/call-lists/callbacks/entries`,{operation_id:"entry-create-1",name:"Contact without a project",phone:"+12065550104",title:"Requested callback"});
  const queue=await c.request("GET",`${base}/call-lists/queue`);assert.equal(queue.columns[0].tasks[0].id,entry.id);
  await c.request("POST",`${base}/call-list-entries/${entry.id}/claim`,{});
  const skipped=await c.request("POST",`${base}/call-list-entries/${entry.id}/skip`,{session_id:"list-session-1"});assert.deepEqual(skipped.skipped,[entry.id]);
  assert.equal((await c.request("GET",`${base}/calls`)).total,0);
  assert.equal((await c.request("GET",`${base}/call-lists/queue`)).columns[0].tasks[0].status,"pending");
});
test("claims arbitrate simultaneous callers and cannot be stolen before expiry",async ()=>{
  (await store.transaction(async ()=>(await store.claimResource("claim-org","phone:+12065550105","alice"))));
  await assert.rejects(async ()=>(await store.transaction(async ()=>(await store.claimResource("claim-org","phone:+12065550105","bob")))),/already working/);
  (await store.transaction(async ()=>(await store.claimResource("claim-org","phone:+12065550105","alice"))));
});
test("voice webhook validates exact signed bytes, rejects tampering, and deduplicates events",async()=>{
  const timestamp=String(Math.floor(Date.now()/1000));const payload=JSON.stringify({data:{id:"evt_test_1",event_type:"call.initiated",payload:{call_control_id:"unknown",connection_id:"unowned"}}});
  const signature=sign(null,Buffer.from(`${timestamp}|${payload}`),keys.privateKey).toString("base64");
  const headers={"content-type":"application/json","telnyx-timestamp":timestamp,"telnyx-signature-ed25519":signature};
  assert.equal((await client().raw("POST","/v1/comms/voice/webhooks/telnyx",`${payload} `,headers)).status,401);
  assert.equal((await client().raw("POST","/v1/comms/voice/webhooks/telnyx",payload,headers)).status,202);
  assert.equal((await client().raw("POST","/v1/comms/voice/webhooks/telnyx",payload,headers)).status,202);
  assert.equal(Number(store.object((await store.database().prepare("SELECT count(*) AS count FROM customer_voice_webhooks WHERE event_id='evt_test_1'").get())).count),1);
  await worker.processOneWebhook("test-webhook-worker");
});
test("terminal call events do not resurrect a call and late legs are cleaned up",async()=>{
  const orgId="provider-race-org";(await store.saveResource(orgId,"application","default",{},"app-race"));
  const call=(await store.insertCall({id:"call_race",organization_id:orgId,branch_id:"default",mode:"browser",direction:"outbound",state:"connected"}));
  (await store.saveLeg(orgId,call.id,"customer",{call_control_id:"control-race",state:"answered"},"2026-01-01T00:00:00Z"));
  await worker.processVoiceEvent({data:{id:"end-race",event_type:"call.hangup",occurred_at:"2026-01-01T00:00:10Z",payload:{call_control_id:"control-race",hangup_cause:"NORMAL_CLEARING"}}});
  await worker.processVoiceEvent({data:{id:"answer-race",event_type:"call.answered",occurred_at:"2026-01-01T00:00:05Z",payload:{call_control_id:"control-race"}}});
  assert.ok(store.terminal.has((await store.readCall(orgId,call.id)).state));assert.equal((await store.legByControl("control-race"))?.state,"ended");
  assert.ok((await store.jobs(orgId,call.id)).length>0);
});
test("stale provider commands become uncertain instead of being redialed",async ()=>{
  (await store.enqueue("job-org","call-job","provider",{path:"dial"},"charged-dial"));
  const job=(await store.claimJob("dead-worker"));assert.ok(job);
  (await store.database().prepare("UPDATE customer_call_jobs SET lease_until='2000-01-01' WHERE id=?").run(store.text(job.id)));
  (await store.claimJob("new-worker"));
  const state=store.object((await store.database().prepare("SELECT state FROM customer_call_jobs WHERE id=?").get(store.text(job.id)))).state;assert.equal(state,"uncertain");
});
test("readiness distinguishes missing media from a fast connection",async()=>{
  const {diagnosticVerdict}=await import("../comms/calls/settings.js");
  assert.equal(diagnosticVerdict({microphone:"denied",connectivity:"ready",metrics:{rtt_ms:10,jitter_ms:1,packet_loss_percent:0}}).verdict,"blocked");
  assert.equal(diagnosticVerdict({microphone:"ready",connectivity:"ready",metrics:{rtt_ms:100,jitter_ms:8,packet_loss_percent:0.2}}).verdict,"ready");
  assert.equal(diagnosticVerdict({microphone:"ready",connectivity:"ready",metrics:{rtt_ms:900,jitter_ms:80,packet_loss_percent:8}}).verdict,"blocked");
});

test("full outbound voice flow dials staff first, joins the customer, holds, records, and ends both legs",async()=>{
  const {TelnyxVoiceClient,setVoiceClientFactoryForTests}=await import("../telephony/telnyx.js");
  const submissions:Array<{path:string;method:string;body:Record<string,unknown>}> = [];
  let sequence=0;
  class Provider extends TelnyxVoiceClient {
    override async request(path:string,method="GET",body:Record<string,unknown>={}){
      submissions.push({path,method,body});
      if(path==='/calls')return {data:{call_control_id:`simulated-${++sequence}`,call_leg_id:`leg-${sequence}`}};
      if(path==='/conferences')return {data:{id:'simulated-conference'}};
      if(path==='/telephony_credentials')return {data:{id:'staff-credential',sip_username:'staff-endpoint',expires_at:new Date(Date.now()+86400000).toISOString()}};
      if(path.endsWith('/token'))return `test.${Buffer.from(JSON.stringify({exp:Math.floor(Date.now()/1000)+3600})).toString('base64url')}.signature`;
      return {data:{result:'ok'}};
    }
  }
  setVoiceClientFactoryForTests(()=>new Provider());process.env.TELNYX_VOICE_MODE='live';
  try{
    // Clear the deliberately stalled jobs left by earlier recovery tests.
    (await store.database().prepare("UPDATE customer_call_jobs SET state='completed',lease_until='' WHERE state IN ('pending','running')").run());
    const {c,orgId}=await owner(),base=`/v1/comms/organizations/${orgId}`;
    (await store.saveResource(orgId,'application','default',{},'simulated-app'));(await store.saveResource(orgId,'connection','default',{},'simulated-connection'));
    (await store.saveResource(orgId,'number','+12065550110',{phone_number:'+12065550110',status:'active',branch_id:'default'},'number-id'));
    (await store.saveResource(orgId,'settings','default',{enabled:true,recording_enabled:true,recording_policy_confirmed:true,emergency_policy_confirmed:true,service_location:'Test office'}));
    await c.request('POST',`${base}/voice/endpoint/token`,{device_id:'simulated-device'});
    await c.request('POST',`${base}/voice/endpoint/presence`,{device_id:'simulated-device',registered:true,availability:'available'});
    await c.request('POST',`${base}/voice/diagnostics`,{device_id:'simulated-device',microphone:'ready',connectivity:'ready',provider_verdict:'ready',metrics:{rtt_ms:60,jitter_ms:3,packet_loss_percent:0}});
    const {call}=await c.request('POST',`${base}/calls`,{operation_id:'simulated-outbound-call',mode:'browser',device_id:'simulated-device',customer_number:'+12065550111',customer_name:'Simulated customer'});
    await worker.processOneJob('simulation');assert.equal(submissions.filter(s=>s.path==='/calls').length,1);assert.equal(submissions.find(s=>s.path==='/calls')?.body.to,'sip:staff-endpoint@sip.telnyx.com');
    const event=async(type:string,control:string,extra:Record<string,unknown>={})=>worker.processVoiceEvent({data:{id:`evt-${Math.random()}`,event_type:type,occurred_at:new Date().toISOString(),payload:{call_control_id:control,...extra}}});
    await event('call.answered','simulated-1');await worker.processOneJob('simulation');
    assert.equal(submissions.filter(s=>s.path==='/calls').length,2);assert.equal(submissions.filter(s=>s.path==='/calls')[1]?.body.to,'+12065550111');
    await event('call.answered','simulated-2');await worker.processOneJob('simulation');await worker.processOneJob('simulation');
    assert.equal((await store.readCall(orgId,call.id)).state,'connected');
    assert.equal(submissions.filter(s=>s.path==='/conferences').length,1);assert.ok(submissions.some(s=>s.path==='/conferences/simulated-conference/actions/join'));
    await c.request('POST',`${base}/calls/${call.id}/actions`,{operation_id:'simulation-hold',action:'hold'});await worker.processOneJob('simulation');
    assert.equal((await store.readCall(orgId,call.id)).state,'held');assert.ok(submissions.some(s=>s.path.endsWith('/actions/hold')&&Array.isArray(s.body.call_control_ids)));
    assert.equal((await c.raw('POST',`${base}/calls/${call.id}/actions`,{operation_id:'record-without-consent',action:'record_start'})).status,409);
    await c.request('POST',`${base}/calls/${call.id}/actions`,{operation_id:'simulation-consent',action:'consent',consent:'granted'});
    await c.request('POST',`${base}/calls/${call.id}/actions`,{operation_id:'simulation-record',action:'record_start'});await worker.processOneJob('simulation');
    assert.equal(store.object((await store.readCall(orgId,call.id)).metadata.capture).state,'recording');
    await event('call.hangup','simulated-2',{hangup_cause:'NORMAL_CLEARING'});await worker.processOneJob('simulation');
    assert.equal((await store.readCall(orgId,call.id)).state,'ended');assert.ok(submissions.some(s=>s.path==='/calls/simulated-1/actions/hangup'));
    assert.equal(submissions.filter(s=>s.path==='/calls').length,2);
  }finally{process.env.TELNYX_VOICE_MODE='disabled';setVoiceClientFactoryForTests(null);}
});

test("recordings and transcripts have different IDs and deletion cannot be resurrected by redelivery",async ()=>{
  (await store.insertCall({id:'call-artifact',organization_id:'artifact-org',branch_id:'default',mode:'browser',direction:'outbound'}));
  const recording=(await store.saveArtifact('artifact-org','call-artifact','recording','provider-recording',{provider_recording_id:'provider-recording'}));
  const transcript=(await store.saveArtifact('artifact-org','call-artifact','transcript','provider-recording',{text:'Caller agreed to a callback.'}));
  assert.notEqual(recording,transcript);assert.equal((await store.artifacts('artifact-org','call-artifact')).length,2);
  (await store.database().prepare("UPDATE customer_call_artifacts SET state='deleted',data_json='{}' WHERE id=?").run(recording));
  (await store.saveArtifact('artifact-org','call-artifact','recording','provider-recording',{provider_recording_id:'provider-recording'}));
  assert.equal((await store.artifacts('artifact-org','call-artifact')).length,1);
});

test("call history cursor pages do not repeat rows and wrap-up filters are applied",async()=>{
  const {c,orgId}=await owner(),base=`/v1/comms/organizations/${orgId}`;
  for(let n=0;n<3;n++)await c.request('POST',`${base}/calls`,{operation_id:`pagination-call-${n}`,customer_number:`+1206555012${n}`});
  const first=await c.request('GET',`${base}/calls?limit=2`);assert.equal(first.calls.length,2);assert.ok(first.next_cursor);
  const next=await c.request('GET',`${base}/calls?limit=2&cursor=${encodeURIComponent(first.next_cursor)}`);assert.equal(next.calls.length,1);assert.ok(!first.calls.some((call:any)=>call.id===next.calls[0].id));
  assert.equal((await c.request('GET',`${base}/calls?wrap_up_state=needs_wrap_up`)).calls.length,0);
});

test('delayed answered events preserve a connected or held call',async()=>{
  const org='delayed-org',call=(await store.insertCall({id:'delayed-call',organization_id:org,branch_id:'default',mode:'browser',direction:'outbound',state:'held'}));
  (await store.patchCall(org,call.id,{connected_at:store.now()}));
  (await store.saveLeg(org,call.id,'agent',{call_control_id:'delayed-agent',state:'answered'},store.now()));
  await worker.processVoiceEvent({data:{id:'late-answer',event_type:'call.answered',payload:{call_control_id:'delayed-agent'}}});
  assert.equal((await store.readCall(org,call.id)).state,'held');assert.equal((await store.jobs(org,call.id)).length,0);
});

test('incoming queue selects a branch teammate and a declined leg never disconnects the caller',async()=>{
  const {orgId:org}=await owner();(await store.saveResource(org,'application','default',{},'incoming-app'));
  (await store.saveResource(org,'number','+12065550140',{phone_number:'+12065550140',branch_id:'default',status:'active'},'incoming-number'));
  (await store.saveResource(org,'settings','default',{enabled:true,business_hours:Array.from({length:7},(_,day)=>({day,open:'00:00',close:'23:59'}))}));
  (await store.saveResource(org,'endpoint','alice',{user_id:'alice',branch_id:'default',registered:true,availability:'available',heartbeat_at:store.now(),sip_username:'alice'}));
  (await store.saveResource(org,'endpoint','other-branch',{user_id:'other-branch',branch_id:'restricted',registered:true,availability:'available',heartbeat_at:store.now(),sip_username:'other'}));
  const event=(type:string,control:string,extra:Record<string,unknown>={})=>worker.processVoiceEvent({data:{id:`in-${Math.random()}`,event_type:type,payload:{call_control_id:control,...extra}}});
  await event('call.initiated','inbound-customer',{connection_id:'incoming-app',direction:'incoming',from:'+12065550141',to:'+12065550140'});
  await event('call.answered','inbound-customer');(await worker.routeWaitingCalls());
  const call=(await store.listCalls(org)).calls[0]!;assert.equal((await store.readCall(org,call.id)).owner_user_id,'alice');
  (await store.saveLeg(org,call.id,'agent',{call_control_id:'inbound-agent',state:'initiated'},store.now()));
  await event('call.hangup','inbound-agent',{hangup_cause:'CALL_REJECTED'});
  assert.equal((await store.readCall(org,call.id)).state,'queued');assert.equal((await store.legByControl('inbound-customer'))?.state,'answered');
  await event('call.hangup','inbound-agent',{hangup_cause:'CALL_REJECTED'});assert.equal((await store.readCall(org,call.id)).state,'queued');
  (await worker.routeWaitingCalls());assert.equal((await store.readCall(org,call.id)).owner_user_id,'');
});

test('voicemail recording starts only after its own greeting, and transcription uses the provider field',async()=>{
  const org='voicemail-org',call=(await store.insertCall({id:'voicemail-call',organization_id:org,branch_id:'default',mode:'browser',direction:'inbound',state:'queued'}));
  (await store.saveResource(org,'settings','default',{enabled:false}));(await store.saveLeg(org,call.id,'customer',{call_control_id:'voicemail-control',state:'answered'},store.now()));
  (await worker.routeWaitingCalls());assert.equal((await store.readCall(org,call.id)).state,'voicemail');
  const event=async(type:string,payload:Record<string,unknown>)=>worker.processVoiceEvent({data:{id:`vm-${Math.random()}`,event_type:type,payload:{call_control_id:'voicemail-control',...payload}}});
  await event('call.speak.ended',{});assert.equal(store.object((await store.readCall(org,call.id)).metadata.voicemail).started,undefined);
  await event('call.speak.ended',{client_state:Buffer.from(JSON.stringify({phase:'voicemail_greeting'})).toString('base64')});
  assert.equal(store.object((await store.readCall(org,call.id)).metadata.voicemail).started,true);
  await event('call.recording.transcription.saved',{recording_id:'vm-recording',transcription_text:'Please return my call.',status:'completed'});
  assert.equal(store.object((await store.artifacts(org,call.id))[0]?.data).text,'Please return my call.');
});

test('recording range playback, expiry, and deletion are enforced by the authenticated API',async()=>{
  const {c,orgId}=await owner(),base=`/v1/comms/organizations/${orgId}`;
  const {call}=await c.request('POST',`${base}/calls`,{operation_id:'recording-media-fixture',customer_number:'+12065550144'});
  const folder=path.join(root,'messaging','call-recordings',store.id('org',orgId));await mkdir(folder,{recursive:true});const file=path.join(folder,'recording.mp3');await writeFile(file,'0123456789');
  const artifact=(await store.saveArtifact(orgId,call.id,'recording','range-fixture',{file_path:file,content_type:'audio/mpeg'}));
  const url=`${base}/calls/${call.id}/artifacts/${artifact}/media`;
  const partial=await c.raw('GET',url,undefined,{range:'bytes=2-5'});assert.equal(partial.status,206);assert.equal(partial.body,'2345');
  assert.equal((await c.raw('GET',url,undefined,{range:'bytes=20-30'})).status,416);
  assert.equal((await client().raw('GET',url)).status,401);
  (await store.database().prepare("UPDATE customer_call_artifacts SET expires_at='2000-01-01' WHERE id=?").run(artifact));
  assert.equal((await c.raw('GET',url)).status,404);
  await (await import('../comms/calls/media.js')).expireArtifacts();assert.equal((await store.artifacts(orgId,call.id)).length,0);
});

test('new inbound activity reopens a resolved conversation and read markers remain per user',async()=>{
  const {incomingWorkflow}=await import('../comms/calls/activity.js'),org='workflow-org';
  (await store.database().prepare("INSERT INTO customer_communication_workflow VALUES(?,?,?,?,?,?,?,?)").run(org,'conversation','thread','alice','closed','2099-01-01',3,'2026-01-01'));
  let flow=(await incomingWorkflow(org,'conversation','thread','2026-01-02','alice'));assert.equal(flow.status,'open');assert.equal(flow.snoozed_until,'');assert.equal(flow.revision,4);assert.equal(flow.unread_count,1);
  (await store.database().prepare("INSERT INTO customer_communication_read_markers VALUES(?,?,?,?,?)").run(org,'alice','conversation','thread','2026-01-03'));
  assert.equal((await incomingWorkflow(org,'conversation','thread','2026-01-02','alice')).unread_count,0);
  assert.equal((await incomingWorkflow(org,'conversation','thread','2026-01-02','bob')).unread_count,1);
});

test('voice cost ledger deduplicates provider legs and never reports unknown costs as zero',async()=>{
  const {recordVoiceCost,voiceHealth}=await import('../comms/calls/operations.js');
  const payload={call_leg_id:'cost-leg',status:'success',total_cost:'0.12345',cost_parts:[{currency:'USD',cost:'0.12345',call_part:'call-control',billed_duration_secs:60}]};
  (await recordVoiceCost('cost-org','cost-call','cost-event',payload));(await recordVoiceCost('cost-org','cost-call','retry-event',payload));
  assert.equal((await voiceHealth('cost-org')).usage_last_24_hours[0]?.legs,1);assert.equal((await voiceHealth('cost-org')).usage_last_24_hours[0]?.reported_amount,0.12345);
  (await recordVoiceCost('cost-org','cost-call','missing-cost',{call_leg_id:'unknown-leg',status:'error'}));
  assert.equal((await voiceHealth('cost-org')).usage_last_24_hours[0]?.legs,1);
});

test('legacy migration is a dry run by default and imports an outcome once without new work',async()=>{
  const {c,orgId}=await owner(),base=`/v1/comms/organizations/${orgId}`;
  await c.request('POST',`${base}/call-lists`,{key:'legacy-list',title:'Legacy calls'});
  const {entry}=await c.request('POST',`${base}/call-lists/legacy-list/entries`,{operation_id:'legacy-entry-test',name:'Historical contact',phone:'+12065550145',title:'Old call'});
  await (await import('../internal/crm/call_lists.js')).getCallListDatabase().prepare("UPDATE crm_call_list_entries SET status='completed',completed_at=?,result_json=? WHERE id=?").run('2025-07-01T10:00:00Z',JSON.stringify({id:'legacy-outcome',disposition:'answered',created_at:'2025-07-01T10:00:00Z'}),entry.id);
  const {migrateLegacyCalls}=await import('../comms/calls/migration.js');
  assert.equal((await migrateLegacyCalls(orgId)).eligible,1);assert.equal((await store.listCalls(orgId)).total,0);
  assert.equal((await migrateLegacyCalls(orgId,true)).imported,1);assert.equal((await migrateLegacyCalls(orgId,true)).existing,1);
  assert.equal((await store.listCalls(orgId)).calls[0]?.connected_at,'');assert.equal((await c.request('GET',`${base}/follow-ups`)).tasks.length,0);
});

test('warm transfer offers the teammate, reserves availability, and keeps the customer connected after handoff',async()=>{
  const {TelnyxVoiceClient,setVoiceClientFactoryForTests}=await import('../telephony/telnyx.js');
  const submissions:Array<{path:string;body:any}>=[];
  class Provider extends TelnyxVoiceClient{override async request(path:string,_method='GET',body:any={}){submissions.push({path,body});return {data:path==='/calls'?{call_control_id:'transfer-consult'}:{result:'ok'}};}}
  setVoiceClientFactoryForTests(()=>new Provider());process.env.TELNYX_VOICE_MODE='live';
  try{
    (await store.database().prepare("UPDATE customer_call_jobs SET state='completed' WHERE state IN ('pending','running')").run());
    const {c,orgId}=await owner(),base=`/v1/comms/organizations/${orgId}`;
    const userCall=await c.request('POST',`${base}/calls`,{operation_id:'transfer-owner-fixture',customer_number:'+12065550146'});
    const call=(await store.insertCall({id:'transfer-call',organization_id:orgId,branch_id:'default',mode:'browser',direction:'outbound',state:'connected',owner_user_id:userCall.call.owner_user_id,business_number:'+12065550147',metadata:{conference_id:'transfer-conference'}}));
    (await store.patchCall(orgId,call.id,{connected_at:store.now()}));
    (await store.saveLeg(orgId,call.id,'agent',{call_control_id:'transfer-original',state:'answered'},store.now()));(await store.saveLeg(orgId,call.id,'customer',{call_control_id:'transfer-customer',state:'answered'},store.now()));
    (await store.saveResource(orgId,'settings','default',{enabled:true}));(await store.saveResource(orgId,'application','default',{},'transfer-app'));
    (await store.saveResource(orgId,'endpoint','teammate',{user_id:'teammate',name:'Teammate',branch_id:'default',registered:true,availability:'available',heartbeat_at:store.now(),sip_username:'teammate',session_id:'teammate-session',device_id:'teammate-device'}));
    await c.request('POST',`${base}/calls/${call.id}/actions`,{operation_id:'warm-transfer-test',action:'transfer',target_user_id:'teammate'});
    const {presence}=await import('../comms/calls/voice.js');
    const teammate={orgId,userId:'teammate',branchId:'default',sessionId:'teammate-session',role:'staff',permissions:{make_calls:true}} as any;
    assert.equal((await presence(teammate,{device_id:'teammate-device',registered:true,availability:'available'})).availability,'busy');
    assert.equal((await store.resource(orgId,'endpoint','teammate'))?.offered_call_id,call.id);
    await worker.processOneJob('transfer-worker');await worker.processOneJob('transfer-worker');
    await worker.processVoiceEvent({data:{id:'consult-answer',event_type:'call.answered',payload:{call_control_id:'transfer-consult'}}});await worker.processOneJob('transfer-worker');
    await c.request('POST',`${base}/calls/${call.id}/actions`,{operation_id:'warm-transfer-complete',action:'transfer_complete'});
    await worker.processOneJob('transfer-worker');await worker.processOneJob('transfer-worker');
    await worker.processVoiceEvent({data:{id:'old-staff-ended',event_type:'call.hangup',payload:{call_control_id:'transfer-original'}}});
    const transferred=(await store.readCall(orgId,call.id));assert.equal(transferred.owner_user_id,'teammate');assert.equal(transferred.state,'connected');
    assert.ok(!submissions.some(s=>s.path==='/calls/transfer-customer/actions/hangup'));
    assert.equal(store.object(transferred.metadata.transfer).state,'completed');
  }finally{process.env.TELNYX_VOICE_MODE='disabled';setVoiceClientFactoryForTests(null);}
});

test('calendar follow-up dates honor the organization timezone and daylight saving changes',async()=>{
  const {policyDueAt}=await import('../comms/calls/follow-up-policy.js');
  assert.equal(policyDueAt('America/Los_Angeles',1,'days','',new Date('2026-09-05T01:00:00Z')),'2026-09-05');
  assert.equal(policyDueAt('America/Los_Angeles',1,'days','09:00',new Date('2026-03-07T18:00:00Z')),'2026-03-08T16:00:00.000Z');
  assert.equal(policyDueAt('America/Los_Angeles',1,'days','02:30',new Date('2026-03-07T18:00:00Z')),'2026-03-08T10:30:00.000Z');
  assert.equal(policyDueAt('America/Los_Angeles',1,'months','',new Date('2026-01-31T18:00:00Z')),'2026-02-28');
});

test('published scripts remain usable while a later draft is being edited, and archive stops new use',async()=>{
  const {c,orgId}=await owner(),base=`/v1/comms/organizations/${orgId}`;
  const body={title:'Opening',status:'published',sections:[{title:'Hello',body:'Original opening'}],questions:['Next step?']};
  const {script}=await c.request('POST',`${base}/call-scripts`,body);
  await c.request('POST',`${base}/call-scripts`,{...body,id:script.id,status:'draft',sections:[{title:'Hello',body:'Unpublished change'}]});
  const published=await c.request('GET',`${base}/call-scripts?published=true`);assert.equal(published.scripts[0].version,1);
  const {call}=await c.request('POST',`${base}/calls`,{operation_id:'script-version-call',script_id:script.id,customer_number:'+12065550160'});
  assert.equal(call.metadata.script.data.sections[0].body,'Original opening');
  await c.request('POST',`${base}/call-scripts`,{...body,id:script.id,status:'archived'});
  assert.equal((await c.raw('POST',`${base}/calls`,{operation_id:'archived-script-call',script_id:script.id,customer_number:'+12065550161'})).status,404);
  assert.equal((await store.readCall(orgId,call.id)).metadata.script&&((await store.readCall(orgId,call.id)).metadata.script as any).version,1);
});

test('keeping work open leaves a manual entry queued and a retry with a newer revision cannot duplicate a follow-up',async()=>{
  const {c,orgId}=await owner(),base=`/v1/comms/organizations/${orgId}`;
  await c.request('POST',`${base}/call-lists`,{key:'open-work',title:'Open work'});
  const {entry}=await c.request('POST',`${base}/call-lists/open-work/entries`,{operation_id:'keep-open-entry',name:'Avery',phone:'+12065550162',title:'Check in'});
  const {call}=await c.request('POST',`${base}/calls`,{operation_id:'keep-open-attempt',entry_id:entry.id});
  await c.request('POST',`${base}/calls/${call.id}/wrap-up`,{operation_id:'keep-open-outcome',revision:call.revision,disposition:'answered',next_action:'none'});
  await worker.processOneJob('keep-open-worker','background',call.id);
  assert.equal((await c.request('GET',`${base}/call-lists/queue`)).columns[0].tasks[0].id,entry.id);
  const second=(await c.request('POST',`${base}/calls`,{operation_id:'second-open-attempt',entry_id:entry.id})).call;
  const wrap={operation_id:'retry-new-revision',revision:second.revision,disposition:'no_answer',next_action:'follow_up',due_at:'2026-10-01'};
  await c.request('POST',`${base}/calls/${second.id}/wrap-up`,wrap);await worker.processOneJob('keep-open-worker','background',second.id);
  await c.request('POST',`${base}/calls/${second.id}/wrap-up`,{...wrap,revision:(await store.readCall(orgId,second.id)).revision});
  assert.equal((await c.request('GET',`${base}/follow-ups`)).tasks.length,1);
});

test('a number binding retry preserves its original route and refuses to overwrite an external reroute',async()=>{
  const {TelnyxVoiceClient,setVoiceClientFactoryForTests}=await import('../telephony/telnyx.js');let connection='old-route',writes=0;
  class Provider extends TelnyxVoiceClient{override async request(_path:string,method='GET',body:any={}){if(method==='PATCH'){connection=body.connection_id;writes++;}return {data:{phone_number:'+12065550163',connection_id:connection}};}}
  setVoiceClientFactoryForTests(()=>new Provider());process.env.TELNYX_VOICE_MODE='live';
  try{
    const {c,orgId}=await owner(),base=`/v1/comms/organizations/${orgId}`;
    (await (await import('../messaging/communications_storage.js')).claimPhoneNumberOwnership({organization_id:orgId,phone_number:'+12065550163',provider_phone_number_id:'owned-number'}));
    (await store.saveResource(orgId,'application','default',{},'our-route'));
    assert.equal((await c.raw('POST',`${base}/voice/numbers`,{phone_number:'+12065550163'})).status,409);assert.equal(writes,0);
    await c.request('POST',`${base}/voice/numbers`,{phone_number:'+12065550163',confirm_routing_change:true});
    await c.request('POST',`${base}/voice/numbers`,{phone_number:'+12065550163',label:'Main line'});assert.equal(writes,1);
    assert.equal((await store.resource(orgId,'number','+12065550163'))?.previous_connection_id,'old-route');
    connection='outside-change';assert.equal((await c.raw('DELETE',`${base}/voice/numbers/${encodeURIComponent('+12065550163')}`)).status,409);assert.equal(connection,'outside-change');
    connection='our-route';await c.request('DELETE',`${base}/voice/numbers/${encodeURIComponent('+12065550163')}`);assert.equal(connection,'old-route');
  }finally{process.env.TELNYX_VOICE_MODE='disabled';setVoiceClientFactoryForTests(null);}
});

test('device diagnostics use only the staff SIP leg and never dial or record a customer',async()=>{
  const {startDiagnostic}=await import('../comms/calls/voice.js');const orgId='diagnostic-only-org',ctx={orgId,userId:'staff',sessionId:'session',branchId:'default'} as any;
  (await store.saveResource(orgId,'application','default',{},'diagnostic-app'));(await store.saveResource(orgId,'settings','default',{enabled:true}));(await store.saveResource(orgId,'number','+12065550164',{phone_number:'+12065550164',status:'active'}));
  (await store.saveResource(orgId,'endpoint','staff',{session_id:'session',device_id:'diagnostic-device',registered:true,heartbeat_at:store.now(),sip_username:'staff-sip'},'credential'));
  process.env.TELNYX_VOICE_MODE='live';
  try{
    const {call_id}=(await startDiagnostic(ctx,'diagnostic-device'));await assert.rejects(async ()=>(await startDiagnostic(ctx,'diagnostic-device')),/between calls/);
    const payload=JSON.parse(((await store.database().prepare('SELECT payload_json FROM customer_call_jobs WHERE call_id=?').get(call_id)) as any).payload_json);
    assert.equal(payload.payload.to,'sip:staff-sip@sip.telnyx.com');assert.equal(payload.payload.time_limit_secs,25);
    (await store.saveLeg(orgId,call_id,'agent',{call_control_id:'diagnostic-leg',state:'initiated'}));
    await worker.processVoiceEvent({data:{id:'diagnostic-answer',event_type:'call.answered',payload:{call_control_id:'diagnostic-leg'}}});
    const jobs=(await store.database().prepare('SELECT payload_json FROM customer_call_jobs WHERE call_id=?').all(call_id)).map((r:any)=>JSON.parse(r.payload_json));
    assert.ok(jobs.every(j=>j.path!=='record_start'&&j.role!=='customer'));assert.equal((await store.listCalls(orgId)).total,0);
  }finally{process.env.TELNYX_VOICE_MODE='disabled';}
});

test('provider resource reconciliation searches later inventory pages',async()=>{
  const {TelnyxVoiceClient}=await import('../telephony/telnyx.js');const paths:string[]=[];
  class Provider extends TelnyxVoiceClient{override async request(path:string){paths.push(path);return {data:path.endsWith('=1')?Array.from({length:100},(_,i)=>({name:`Other ${i}`})):[{id:'found',name:'Ours'}],meta:{total_pages:2}};}}
  assert.deepEqual(await new Provider().findNamed('/telephony_credentials','name','Ours'),[{id:'found',name:'Ours'}]);assert.equal(paths.length,2);
});

test('canceling a transfer before provider submission cannot ring the teammate or rejoin a late leg',async()=>{
  const {TelnyxVoiceClient,setVoiceClientFactoryForTests}=await import('../telephony/telnyx.js');const submissions:string[]=[];
  class Provider extends TelnyxVoiceClient{override async request(path:string){submissions.push(path);return {data:{result:'ok'}};}}
  const {callAction}=await import('../comms/calls/voice.js');const orgId='cancel-consult-org',ctx={orgId,userId:'owner',branchId:'default',permissions:{make_calls:true}} as any;
  const call=(await store.insertCall({id:'cancel-consult-call',organization_id:orgId,branch_id:'default',owner_user_id:'owner',mode:'browser',direction:'outbound',state:'connected',connected_at:store.now(),metadata:{conference_id:'cancel-conference'}}));
  (await store.saveResource(orgId,'settings','default',{enabled:true}));(await store.saveResource(orgId,'application','default',{},'cancel-app'));
  (await store.saveResource(orgId,'endpoint','consultant',{user_id:'consultant',registered:true,availability:'available',branch_id:'default',heartbeat_at:store.now(),sip_username:'consultant'}));
  (await store.saveLeg(orgId,call.id,'agent',{call_control_id:'cancel-agent',state:'answered'}));(await store.saveLeg(orgId,call.id,'customer',{call_control_id:'cancel-customer',state:'answered'}));
  setVoiceClientFactoryForTests(()=>new Provider());process.env.TELNYX_VOICE_MODE='live';
  try{
    (await callAction(ctx,call.id,{operation_id:'begin-cancel-transfer',action:'transfer',target_user_id:'consultant'}));
    (await callAction(ctx,call.id,{operation_id:'cancel-transfer-now',action:'transfer_cancel'}));
    for(let n=0;n<4;n++)await worker.processOneJob('cancel-consult-worker','voice',call.id);
    assert.ok(!submissions.includes('/calls'));assert.equal((await store.readCall(orgId,call.id)).state,'connected');
    (await store.saveLeg(orgId,call.id,'consult',{call_control_id:'late-consult',state:'initiated'}));
    await worker.processVoiceEvent({data:{id:'late-cancel-answer',event_type:'call.answered',payload:{call_control_id:'late-consult'}}});
    await worker.processOneJob('cancel-consult-worker','voice',call.id);
    assert.ok(submissions.includes('/calls/late-consult/actions/hangup'));assert.ok(!submissions.some(p=>p.endsWith('/actions/join')));
    assert.equal(store.object((await store.readCall(orgId,call.id)).metadata.transfer).state,'canceled');
  }finally{process.env.TELNYX_VOICE_MODE='disabled';setVoiceClientFactoryForTests(null);}
});

test('withdrawing consent before a queued start prevents the provider recording request',async()=>{
  const {TelnyxVoiceClient,setVoiceClientFactoryForTests}=await import('../telephony/telnyx.js');const submissions:string[]=[];
  class Provider extends TelnyxVoiceClient{override async request(path:string){submissions.push(path);return {data:{result:'ok'}};}}
  const {callAction}=await import('../comms/calls/voice.js'),orgId='withdraw-recording-org',ctx={orgId,userId:'owner',branchId:'default'} as any;
  const call=(await store.insertCall({id:'withdraw-recording-call',organization_id:orgId,branch_id:'default',owner_user_id:'owner',mode:'browser',direction:'outbound',state:'connected',metadata:{consent:{state:'granted'}}}));
  (await store.saveLeg(orgId,call.id,'customer',{call_control_id:'withdraw-customer',state:'answered'}));
  (await store.saveResource(orgId,'settings','default',{recording_enabled:true,recording_policy_confirmed:true}));
  (await callAction(ctx,call.id,{operation_id:'record-before-withdraw',action:'record_start'}));(await callAction(ctx,call.id,{operation_id:'withdraw-permission',action:'consent',consent:'withdrawn'}));
  process.env.TELNYX_VOICE_MODE='live';setVoiceClientFactoryForTests(()=>new Provider());
  try{await worker.processOneJob('withdraw-worker','voice',call.id);await worker.processOneJob('withdraw-worker','voice',call.id);assert.ok(!submissions.some(p=>p.endsWith('/record_start')));assert.ok(submissions.some(p=>p.endsWith('/record_stop')));}
  finally{process.env.TELNYX_VOICE_MODE='disabled';setVoiceClientFactoryForTests(null);}
});

test('provider reconciliation cannot mistake a previous consultation for an uncertain new dial',async()=>{
  const {TelnyxVoiceClient,setVoiceClientFactoryForTests}=await import('../telephony/telnyx.js');
  class Provider extends TelnyxVoiceClient{override async readCall(){return {is_alive:true};}}
  const orgId='exact-operation-org',call=(await store.insertCall({id:'exact-operation-call',organization_id:orgId,branch_id:'default',mode:'browser',direction:'outbound',state:'held'}));
  (await store.saveLeg(orgId,call.id,'consult',{call_control_id:'prior-consult',state:'ended',operation_id:'old-operation'}));
  const id=(await store.enqueue(orgId,call.id,'provider',{path:'dial',role:'consult',payload:{}},'uncertain-consult'));(await store.database().prepare("UPDATE customer_call_jobs SET state='uncertain' WHERE id=?").run(id));
  process.env.TELNYX_VOICE_MODE='live';setVoiceClientFactoryForTests(()=>new Provider());
  try{await (await import('../comms/calls/recovery.js')).reconcileCall(orgId,call.id);assert.equal((await store.jobs(orgId,call.id))[0]?.state,'uncertain');}
  finally{process.env.TELNYX_VOICE_MODE='disabled';setVoiceClientFactoryForTests(null);}
});

test('the shared feed and search apply branch restrictions to messages and calls together',async()=>{
  const {createMessageRecord}=await import('../messaging/communications_storage.js');
  const {orgCommsFeed,searchComms}=await import('../comms/service.js');const orgId='branch-communications-org';
  for(const branch of ['east','west']){
    (await createMessageRecord({id:`branch-message-${branch}`,organization_id:orgId,branch_id:branch,channel:'email',direction:'inbound',status:'received',text_body:`Branchneedle ${branch}`}));
    (await store.insertCall({id:`branch-call-${branch}`,organization_id:orgId,branch_id:branch,mode:'external',direction:'outbound',state:'ended',customer_name:`Branchneedle ${branch}`}));
  }
  const feed=(await orgCommsFeed(orgId,{branch_id:'east'}));assert.equal(feed.length,2);assert.ok(feed.every(row=>!JSON.stringify(row).includes('west')));
  const search=(await searchComms(orgId,'Branchneedle',{branch_id:'east'}));assert.equal(search.length,2);assert.ok(search.every(row=>!JSON.stringify(row).includes('west')));
  const {requireCallAccess}=await import('../comms/calls/service.js');await assert.rejects(async ()=>requireCallAccess({orgId,userId:'east-user',branchId:'east',role:'staff',permissions:{view_comms:true}} as any,(await store.readCall(orgId,'branch-call-west'))),/another branch/);
});

test('accepted list-specific lost outcomes survive later configuration changes and reject cross-call retries',async()=>{
  const {c,orgId}=await owner(),base=`/v1/comms/organizations/${orgId}`;
  const {upsertDocument,readDocument}=await import('../platform/storage.js');
  await upsertDocument(orgId,'projects',{id:'outcome-project',data:{title:'Outcome project',branch_id:'default',contacts:[]}});
  const followup=await (await import('../work/followups.js')).createFollowUpTodo(orgId,{project_id:'outcome-project',title:'Review decision',metadata:{follow_up:{completion_policy:'explicit'}}});
  let call=(await c.request('POST',`${base}/calls`,{operation_id:'configured-outcome-call',customer_number:'+12065550170',project_id:'outcome-project',source_node_ids:[followup.node.id]})).call;
  call=(await store.patchCall(orgId,call.id,{metadata:{...call.metadata,list_settings:{follow_ups:{outcomes:[{id:'customer-declined',label:'Customer declined',action:'lost'}]}}}}));
  const payload={operation_id:'configured-lost-wrap',revision:call.revision,disposition:'answered',next_action:'complete',source_node_ids:[followup.node.id],outcome_id:'customer-declined'};
  await c.request('POST',`${base}/calls/${call.id}/wrap-up`,payload);
  (await store.patchCall(orgId,call.id,{metadata:{...(await store.readCall(orgId,call.id)).metadata,list_settings:{follow_ups:{outcomes:[]}}}}));
  await c.request('POST',`${base}/calls/${call.id}/wrap-up`,payload);
  await worker.processOneJob('configured-outcome-worker','background',call.id);
  assert.equal((await readDocument(orgId,'projects','outcome-project')).data.lead_status,'lost');
  assert.equal((await (await import('../work/storage.js')).readNodeRecord(orgId,String(followup.node.id)))?.status,'completed');
  const other=(await c.request('POST',`${base}/calls`,{operation_id:'other-outcome-call',customer_number:'+12065550171'})).call;
  assert.equal((await c.raw('POST',`${base}/calls/${other.id}/wrap-up`,payload)).status,409);
});

test('definitive setup rejection can retry but an unknown provider submission cannot create duplicates',async()=>{
  const {TelnyxVoiceClient,setVoiceClientFactoryForTests}=await import('../telephony/telnyx.js');const {TelnyxError}=await import('../messaging/telnyx.js');
  const {provisionVoice}=await import('../comms/calls/voice.js');let rejected=true,unknown=false,posts=0;
  class Provider extends TelnyxVoiceClient {override async request(path:string,method='GET'){
    if(method==='GET')return {data:[],meta:{total_pages:1}};
    posts++;if(rejected)throw new TelnyxError('Rejected',401);if(unknown)throw new TelnyxError('Timeout',502,{submission_unknown:true});return {data:{id:`provider-${path}`}};
  }}
  const {c,orgId}=await owner(),ctx={orgId,userId:'owner',permissions:{manage_communications:true}} as any;
  setVoiceClientFactoryForTests(()=>new Provider());process.env.TELNYX_VOICE_MODE='live';
  try{
    await assert.rejects(provisionVoice(ctx),/Rejected/);assert.equal((await store.resource(orgId,'outbound_profile'))?.status,'failed');
    rejected=false;await provisionVoice(ctx);assert.equal(posts,4);assert.equal((await store.resource(orgId,'connection'))?.status,'ready');
    const other=await owner();unknown=true;await assert.rejects(provisionVoice({...ctx,orgId:other.orgId}),/Timeout/);
    const before=posts;await assert.rejects(provisionVoice({...ctx,orgId:other.orgId}),/uncertain result/);assert.equal(posts,before);
    assert.equal((await store.resource(other.orgId,'outbound_profile'))?.status,'uncertain');
  }finally{process.env.TELNYX_VOICE_MODE='disabled';setVoiceClientFactoryForTests(null);}
});

test('outbound-policy update failure retains local limits and a successful retry repairs provider health',async()=>{
  const {TelnyxVoiceClient,setVoiceClientFactoryForTests}=await import('../telephony/telnyx.js');const {TelnyxError}=await import('../messaging/telnyx.js');
  const {configureVoice}=await import('../comms/calls/voice.js'),{voiceSettings}=await import('../comms/calls/settings.js');let rejected=true;const patches:any[]=[];
  class Provider extends TelnyxVoiceClient {override async request(_path:string,method='GET',body:any){if(method==='PATCH'){patches.push(body);if(rejected)throw new TelnyxError('Policy rejected',422);}return {data:{}};}}
  const {orgId}=await owner(),ctx={orgId,userId:'owner'} as any;(await store.saveResource(orgId,'outbound_profile','default',{status:'ready'},'profile'));
  const settings={...(await voiceSettings(orgId)),max_concurrent_calls:5,daily_spend_limit:'12.00'};
  setVoiceClientFactoryForTests(()=>new Provider());process.env.TELNYX_VOICE_MODE='live';
  try{
    await assert.rejects(configureVoice(ctx,settings),/Policy rejected/);assert.equal((await voiceSettings(orgId)).max_concurrent_calls,3);assert.equal((await store.resource(orgId,'outbound_profile'))?.status,'sync_uncertain');
    rejected=false;await configureVoice(ctx,settings);assert.equal((await voiceSettings(orgId)).max_concurrent_calls,5);assert.equal((await store.resource(orgId,'outbound_profile'))?.status,'ready');
    assert.equal(patches[1].concurrent_call_limit,15);assert.equal(patches[1].daily_spend_limit,'12.00');
  }finally{process.env.TELNYX_VOICE_MODE='disabled';setVoiceClientFactoryForTests(null);}
});

test('background recovery resumes the existing job but never retries a paid provider command',async()=>{
  const {c,orgId}=await owner(),base=`/v1/comms/organizations/${orgId}`;
  const {call}=await c.request('POST',`${base}/calls`,{operation_id:'background-recovery-call',customer_number:'+12065550172'});
  await c.request('POST',`${base}/calls/${call.id}/wrap-up`,{operation_id:'background-recovery-wrap',revision:call.revision,disposition:'answered'});
  const job=(await store.jobs(orgId,call.id)).find(j=>j.kind==='wrap_up')!;
  (await store.database().prepare("UPDATE customer_call_jobs SET state='failed' WHERE id=?").run(String(job.id)));
  assert.equal((await c.request('POST',`${base}/calls/${call.id}/retry-work`,{job_id:job.id})).queued,true);
  assert.equal((await c.request('POST',`${base}/calls/${call.id}/retry-work`,{job_id:job.id})).queued,false);
  await worker.processOneJob('background-recovery-worker','background',call.id);assert.equal((await store.readCall(orgId,call.id)).wrap_up_state,'saved');
  const provider=(await store.enqueue(orgId,call.id,'provider',{path:'dial'},'never-retry-paid-call'));
  (await store.database().prepare("UPDATE customer_call_jobs SET state='uncertain' WHERE id=?").run(provider));
  assert.equal((await c.raw('POST',`${base}/calls/${call.id}/retry-work`,{job_id:provider})).status,400);
  assert.equal((await store.jobs(orgId,call.id)).find(j=>j.id===provider)?.state,'uncertain');
});

test('snoozed conversations remain discoverable and assignment does not cancel snoozing',async()=>{
  const {c,orgId}=await owner(),base=`/v1/comms/organizations/${orgId}`;
  const {createConversationRecord,createMessageRecord}=await import('../messaging/communications_storage.js');
  const conversation=(await createConversationRecord({organization_id:orgId,channel_strategy:'email',participants:[{address:'review@example.test'}]}));
  (await createMessageRecord({organization_id:orgId,conversation_id:conversation.id,channel:'email',direction:'inbound',status:'received',text_body:'A future reminder'}));
  const source_id=String(conversation.id),until=new Date(Date.now()+86400000).toISOString();
  await c.request('POST',`${base}/conversation-workflow`,{kind:'conversation',source_id,revision:0,action:'snooze',snoozed_until:until});
  const empty=await c.request('GET',`${base}/inbox`);assert.equal(empty.conversations.length,0);
  const snoozed=await c.request('GET',`${base}/inbox?snoozed=true`);assert.equal(snoozed.conversations[0].id,source_id);
  await c.request('POST',`${base}/conversation-workflow`,{kind:'conversation',source_id,revision:1,action:'assign',owner_user_id:''});
  assert.equal((await c.request('GET',`${base}/inbox?snoozed=true`)).conversations.length,1);
  await c.request('POST',`${base}/conversation-workflow`,{kind:'conversation',source_id,revision:2,action:'unsnooze'});
  assert.equal((await c.request('GET',`${base}/inbox`)).conversations[0].id,source_id);
});

test('disconnect holds the endpoint lease and heartbeats cannot make a revoking phone available',async()=>{
  const {TelnyxVoiceClient,setVoiceClientFactoryForTests}=await import('../telephony/telnyx.js');
  const {disconnectEndpoint,endpointToken,presence}=await import('../comms/calls/voice.js');
  const orgId='endpoint-disconnect-org',ctx={orgId,userId:'endpoint-owner',sessionId:'session'} as any;
  let finish!:()=>void;const barrier=new Promise<void>(resolve=>{finish=resolve;});
  class Provider extends TelnyxVoiceClient{override async revokeCredential(){await barrier;}}
  (await store.saveResource(orgId,'endpoint',ctx.userId,{user_id:ctx.userId,device_id:'disconnect-device',session_id:'session',registered:true,availability:'available',heartbeat_at:store.now()},'revoking-credential'));
  setVoiceClientFactoryForTests(()=>new Provider());
  try{
    const closing=disconnectEndpoint(ctx,'disconnect-device');
    assert.equal((await presence(ctx,{device_id:'disconnect-device',registered:true,availability:'available'})).availability,'unavailable');
    await assert.rejects(endpointToken(ctx,'disconnect-device'),/already connecting/);
    finish();await closing;assert.equal((await store.resource(orgId,'endpoint',ctx.userId)),null);
  }finally{finish();setVoiceClientFactoryForTests(null);}
});
