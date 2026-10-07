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
  root=await mkdtemp(path.join(os.tmpdir(),"firstmate-supervision-"));
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
  if(path.dirname(path.resolve(root))===path.resolve(os.tmpdir())&&path.basename(root).startsWith("firstmate-supervision-"))await rm(root,{recursive:true,force:true,maxRetries:5,retryDelay:100}).catch(()=>{});
},{timeout:15000});
let sequence=0;
async function fixture(){
  const {orgId}=await owner();
  const docs=await import('../platform/storage.js'),auth=await import('../platform/auth.js');
  const users=await docs.listDocuments(orgId,'users');const userId=users[0]!.id;
  const ctx=await auth.backgroundAuthContext(orgId,userId);
  const id=`supervision-call-${++sequence}`;
  await store.saveResource(orgId,'settings','default',{enabled:true});
  await store.saveResource(orgId,'application','default',{},`app-${id}`);
  await store.saveResource(orgId,'endpoint',userId,{user_id:userId,registered:true,device_id:'test-device',sip_username:'supervisor',heartbeat_at:store.now(),availability:'available'});
  await store.insertCall({id,organization_id:orgId,owner_user_id:'original-agent',branch_id:'default',mode:'browser',direction:'outbound',state:'connected',business_number:'+12065550111',metadata:{conference_id:`conference-${id}`}});
  const call=await store.patchCall(orgId,id,{connected_at:store.now()});
  await store.saveLeg(orgId,id,'agent',{call_control_id:`agent-${id}`,state:'answered'});
  await store.saveLeg(orgId,id,'customer',{call_control_id:`customer-${id}`,state:'answered'});
  const sent:Array<{action:string,payload:any}>=[];
  const telnyx=await import('../telephony/telnyx.js');
  telnyx.setVoiceClientFactoryForTests(()=>({
    dial:async(payload:any)=>{sent.push({action:'dial',payload});return {call_control_id:`supervisor-${id}`};},
    conference:async(_id:string,action:string,payload:any)=>{sent.push({action,payload});return {result:'ok'};},
    command:async(control:string,action:string,payload:any)=>{sent.push({action,payload:{...payload,control}});return {result:'ok'};}
  } as any));process.env.TELNYX_VOICE_MODE='live';
  const service=await import('../comms/calls/supervision.js');
  const event=(type:string,control=`supervisor-${id}`)=>worker.processVoiceEvent({data:{id:`evt-${Math.random()}`,event_type:type,occurred_at:store.now(),payload:{call_control_id:control}}});
  const job=()=>worker.processOneJob('supervision-test','voice',id);
  return {orgId,userId,ctx,call,id,sent,service,event,job};
}
test('listen joins muted, whisper targets only the agent, and repeat intent cannot dial twice',async()=>{
  const f=await fixture();
  const intent={operation_id:'monitor-intent-001',mode:'monitor'};
  await f.service.superviseCall(f.ctx,f.id,intent);await f.service.superviseCall(f.ctx,f.id,intent);
  await f.job();assert.equal(f.sent.filter(v=>v.action==='dial').length,1);
  await f.event('call.answered');await f.job();
  const join=f.sent.find(v=>v.action==='join')!;assert.equal(join.payload.supervisor_role,'monitor');assert.equal(join.payload.end_conference_on_exit,false);
  await f.event('conference.participant.joined');
  await f.service.superviseCall(f.ctx,f.id,{operation_id:'whisper-intent-001',mode:'whisper'});await f.job();
  const update=f.sent.find(v=>v.action==='update')!;assert.equal(update.payload.supervisor_role,'whisper');assert.deepEqual(update.payload.whisper_call_control_ids,[`agent-${f.id}`]);assert.ok(update.payload.command_id);
  await f.event('call.hangup');assert.equal((await store.readCall(f.orgId,f.id)).state,'connected');assert.equal((await f.service.supervisionView(f.ctx,f.call)).session?.state,'ended');
});
test('takeover waits for conference join, then changes owner before releasing the original leg',async()=>{
  const f=await fixture();await f.service.superviseCall(f.ctx,f.id,{operation_id:'takeover-intent-001',mode:'takeover'});await f.job();await f.event('call.answered');await f.job();
  assert.equal((await store.readCall(f.orgId,f.id)).owner_user_id,'original-agent');assert.equal(f.sent.find(v=>v.action==='join')?.payload.supervisor_role,'barge');
  await f.event('conference.participant.joined');await f.job();
  assert.equal((await store.readCall(f.orgId,f.id)).owner_user_id,f.userId);assert.equal((await store.legByControl(`agent-${f.id}`))?.role,'transferred_agent');assert.equal((await store.legByControl(`supervisor-${f.id}`))?.role,'agent');
  await f.job();assert.equal(f.sent.filter(v=>v.action==='hangup').length,1);assert.equal(f.sent.find(v=>v.action==='hangup')?.payload.control,`agent-${f.id}`);
  await f.event('call.hangup',`agent-${f.id}`);assert.equal((await store.readCall(f.orgId,f.id)).state,'connected');
});
test('leaving supervision only hangs up the supervisor and cannot release the customer',async()=>{
  const f=await fixture();await f.service.superviseCall(f.ctx,f.id,{operation_id:'barge-intent-001',mode:'barge'});await f.job();await f.event('call.answered');await f.job();await f.event('conference.participant.joined');
  const voice=await import('../comms/calls/voice.js');await voice.callAction(f.ctx,f.id,{operation_id:'leave-intent-001',action:'hangup'});await f.job();
  assert.deepEqual(f.sent.filter(v=>v.action==='hangup').map(v=>v.payload.control),[`supervisor-${f.id}`]);await f.event('call.hangup');assert.equal((await store.readCall(f.orgId,f.id)).state,'connected');
});
test('failed supervisor dialing leaves the conversation intact and provider uncertainty cannot redial',async()=>{
  const f=await fixture(),telnyx=await import('../telephony/telnyx.js');let attempts=0;
  telnyx.setVoiceClientFactoryForTests(()=>({dial:async()=>{attempts++;throw new Error('lost response');}} as any));
  await f.service.superviseCall(f.ctx,f.id,{operation_id:'uncertain-intent-001',mode:'monitor'});await f.job();
  assert.equal((await f.service.supervisionView(f.ctx,f.call)).session?.state,'uncertain');assert.equal((await store.readCall(f.orgId,f.id)).state,'connected');
  await f.job();assert.equal(attempts,1);await assert.rejects(()=>f.service.superviseCall(f.ctx,f.id,{operation_id:'retry-uncertain-001',mode:'monitor'}),/Wait for the current/);
});
test('department grants and explicit denials gate each supervisor mode against the loaded call',async()=>{
  const f=await fixture();const call={...f.call,metadata:{...f.call.metadata,department_ids:['sales']}};
  const ctx={...f.ctx,role:'member',permissions:{view_comms:true},organizationStructure:{catalog:{departments:[{id:'sales',label:'Sales'},{id:'production',label:'Production'}]},users:[]},scopedAccessGrants:[{scope:{kind:'department',id:'sales'},permissions:{listen_calls:true}}]} as any;
  assert.equal((await f.service.supervisionView(ctx,call)).permissions.monitor,true);assert.equal((await f.service.supervisionView(ctx,call)).permissions.barge,false);
  assert.equal((await f.service.supervisionView(ctx,{...call,metadata:{department_ids:['production']}})).permissions.monitor,false);
  ctx.permissions.listen_calls=false;assert.equal((await f.service.supervisionView(ctx,call)).permissions.monitor,false);
  await assert.rejects(()=>f.service.supervisionView(ctx,{...call,organization_id:'another-org'}),/unavailable/);
});
test('revoked supervisor authority is rechecked before the queued carrier action',async()=>{
  const f=await fixture();await f.service.superviseCall(f.ctx,f.id,{operation_id:'revocation-intent-001',mode:'monitor'});
  const docs=await import('../platform/storage.js'),user=await docs.readDocument(f.orgId,'users',f.userId);
  await docs.upsertDocument(f.orgId,'users',{id:f.userId,data:{...user.data,org_permissions:{items:{listen_calls:false}}},expected_revision:user.revision},{replace:true});
  await f.job();assert.equal(f.sent.length,0);assert.equal((await store.readCall(f.orgId,f.id)).state,'connected');assert.equal((await f.service.supervisionView(f.ctx,f.call)).session?.state,'failed');
});
test('a duplicate joined webhook cannot take over before the barge update succeeds',async()=>{
  const f=await fixture();await f.service.superviseCall(f.ctx,f.id,{operation_id:'monitor-then-takeover-001',mode:'monitor'});await f.job();await f.event('call.answered');await f.job();await f.event('conference.participant.joined');
  await f.service.superviseCall(f.ctx,f.id,{operation_id:'monitor-then-takeover-002',mode:'takeover'});
  await f.event('conference.participant.joined');assert.equal((await store.readCall(f.orgId,f.id)).owner_user_id,'original-agent');assert.equal((await f.service.supervisionView(f.ctx,f.call)).session?.state,'updating');
  await f.job();assert.equal(f.sent.find(v=>v.action==='update')?.payload.supervisor_role,'barge');assert.equal((await store.readCall(f.orgId,f.id)).owner_user_id,f.userId);
});
test('active supervision revocation ends only that supervisor during maintenance',async()=>{
  const f=await fixture();await f.service.superviseCall(f.ctx,f.id,{operation_id:'active-revocation-001',mode:'monitor'});await f.job();await f.event('call.answered');await f.job();await f.event('conference.participant.joined');
  const docs=await import('../platform/storage.js'),user=await docs.readDocument(f.orgId,'users',f.userId);
  await docs.upsertDocument(f.orgId,'users',{id:f.userId,data:{...user.data,org_permissions:{items:{listen_calls:false}}},expected_revision:user.revision},{replace:true});
  await f.service.maintainSupervisionSessions();await f.job();assert.equal((await f.service.supervisionView(f.ctx,f.call)).session?.state,'ended');
  assert.deepEqual(f.sent.filter(v=>v.action==='hangup').map(v=>v.payload.control),[`supervisor-${f.id}`]);assert.equal((await store.readCall(f.orgId,f.id)).state,'connected');
});
test('joining from another browser login and takeover without calling permission are rejected',async()=>{
  const f=await fixture();
  await assert.rejects(()=>f.service.superviseCall({...f.ctx,sessionId:'another-login'},f.id,{operation_id:'wrong-login-intent',mode:'monitor'}),/Connect your browser/);
  const ctx={...f.ctx,permissions:{...f.ctx.permissions,make_calls:false}};
  assert.equal((await f.service.supervisionView(ctx,f.call)).permissions.takeover,false);
  await assert.rejects(()=>f.service.superviseCall(ctx,f.id,{operation_id:'no-calling-intent',mode:'takeover'}),/also requires permission/);
});
test('a correlated late dial webhook resolves uncertainty without submitting another dial',async()=>{
  const f=await fixture(),telnyx=await import('../telephony/telnyx.js');let request:any,attempts=0;
  telnyx.setVoiceClientFactoryForTests(()=>({dial:async(payload:any)=>{request=payload;attempts++;throw new Error('lost response');},conference:async()=>({result:'ok'})} as any));
  await f.service.superviseCall(f.ctx,f.id,{operation_id:'late-dial-evidence-001',mode:'monitor'});await f.job();
  assert.equal((await store.jobs(f.orgId,f.id))[0]?.state,'uncertain');
  await worker.processVoiceEvent({data:{id:'late-supervisor-proof',event_type:'call.answered',occurred_at:store.now(),payload:{call_control_id:`supervisor-${f.id}`,connection_id:`app-${f.id}`,client_state:request.client_state}}});
  assert.equal((await store.jobs(f.orgId,f.id))[0]?.state,'completed');await f.job();assert.equal(attempts,1);assert.equal((await f.service.supervisionView(f.ctx,f.call)).session?.state,'joining');
});
test('an uncertain quieter mode update disconnects only the supervisor rather than retaining a live barge',async()=>{
  const f=await fixture();await f.service.superviseCall(f.ctx,f.id,{operation_id:'uncertain-barge-001',mode:'barge'});await f.job();await f.event('call.answered');await f.job();await f.event('conference.participant.joined');
  const telnyx=await import('../telephony/telnyx.js');telnyx.setVoiceClientFactoryForTests(()=>({conference:async()=>{throw new Error('lost update response');},command:async(control:string,action:string)=>{f.sent.push({action,payload:{control}});return {};}} as any));
  await f.service.superviseCall(f.ctx,f.id,{operation_id:'uncertain-monitor-002',mode:'monitor'});await f.job();await f.job();
  assert.deepEqual(f.sent.filter(v=>v.action==='hangup').map(v=>v.payload.control),[`supervisor-${f.id}`]);assert.equal((await store.readCall(f.orgId,f.id)).owner_user_id,'original-agent');assert.equal((await store.readCall(f.orgId,f.id)).state,'connected');
  await f.event('call.hangup');assert.ok(!(await store.jobs(f.orgId,f.id)).some(v=>v.state==='uncertain'));
  telnyx.setVoiceClientFactoryForTests(()=>({conference:async()=>({result:'ok'})} as any));
  await (await import('../comms/calls/voice.js')).providerCommand(f.call,`customer-${f.id}`,'conference_hold',{},'customer-after-supervisor-left');
  await f.job();assert.equal((await store.readCall(f.orgId,f.id)).state,'held');
});
test('a stale takeover completion cannot promote a session that has concurrently left',async()=>{
  const f=await fixture();await f.service.superviseCall(f.ctx,f.id,{operation_id:'stale-takeover-001',mode:'takeover'});await f.job();await f.event('call.answered');await f.job();await f.event('conference.participant.joined');
  const view=await f.service.supervisionView(f.ctx,f.call),stale=(await store.resource(f.orgId,'supervision',String(view.session!.id)))!;
  await f.service.superviseCall(f.ctx,f.id,{operation_id:'stale-takeover-leave',mode:'leave'});
  await f.service.completeSupervisionTakeover(stale,f.call);
  assert.equal((await store.readCall(f.orgId,f.id)).owner_user_id,'original-agent');assert.equal((await store.legByControl(`agent-${f.id}`))?.role,'agent');
});
