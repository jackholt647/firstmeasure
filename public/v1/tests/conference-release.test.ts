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

async function conferenceFixture(){
  const {c,orgId}=await owner(),base=`/v1/comms/organizations/${orgId}`;
  const seed=await c.request('POST',`${base}/calls`,{operation_id:'conference-owner-fixture',customer_number:'+12065550101'});
  const call=await store.insertCall({id:store.id('conference'),organization_id:orgId,branch_id:'default',mode:'browser',direction:'outbound',state:'connected',owner_user_id:seed.call.owner_user_id,customer_number:'+12065550101',business_number:'+12065550100',metadata:{conference_id:'room'}});
  await store.patchCall(orgId,call.id,{connected_at:store.now()});
  await store.saveResource(orgId,'settings','default',{enabled:true});await store.saveResource(orgId,'application','default',{},store.id('app'));
  await store.saveLeg(orgId,call.id,'agent',{call_control_id:`${call.id}-host`,state:'answered'});
  await store.saveLeg(orgId,call.id,'customer',{call_control_id:`${call.id}-customer`,state:'answered'});
  const submissions:Array<{path:string;body:any}>=[];
  const {TelnyxVoiceClient,setVoiceClientFactoryForTests}=await import('../telephony/telnyx.js');
  let rejectDial=false,uncertainDial=false;
  class Provider extends TelnyxVoiceClient{override async request(path:string,_method='GET',body:any={}){
    submissions.push({path,body});
    if(path==='/calls'&&(rejectDial||uncertainDial)){const {TelnyxError}=await import('../messaging/telnyx.js');throw new TelnyxError('Test rejection',422,{submission_unknown:uncertainDial});}
    return {data:path==='/calls'?{call_control_id:`${call.id}-guest-${submissions.length}`}:{result:'ok'}};
  }}
  setVoiceClientFactoryForTests(()=>new Provider());process.env.TELNYX_VOICE_MODE='live';
  const action=async(action:string,extra:any={},operation_id=store.id('op'))=>c.request('POST',`${base}/calls/${call.id}/actions`,{action,operation_id,...extra});
  const pump=async()=>{for(let n=0;n<15;n++)if(!await worker.processOneJob('conference-tests','voice',call.id))break;};
  const detail=async()=>c.request('GET',`${base}/calls/${call.id}`);
  const event=async(type:string,control:string)=>worker.processVoiceEvent({data:{id:store.id('event'),event_type:type,occurred_at:store.now(),payload:{call_control_id:control,hangup_cause:'NORMAL_CLEARING'}}});
  return {c,orgId,base,call,submissions,action,pump,detail,event,fail:(uncertain=false)=>{rejectDial=true;uncertainDial=uncertain;},close:()=>{setVoiceClientFactoryForTests(null);process.env.TELNYX_VOICE_MODE='disabled';}};
}
test('conference invitations are idempotent, join the existing bridge, and a guest leaving preserves the call',async()=>{
  const f=await conferenceFixture();try{
    const input={target_phone:'+12065550102',target_name:'External guest'};
    await f.action('add_participant',input,'conference-invite-one');await f.action('add_participant',input,'conference-invite-one');
    assert.equal((await f.detail()).participants.length,1);
    await assert.rejects(()=>f.action('add_participant',input),/already on the call/);
    await f.pump();const control=`${f.call.id}-guest-1`;
    assert.equal(f.submissions[0]!.body.to,input.target_phone);
    assert.equal(f.submissions.filter(s=>s.path==='/calls').length,1);
    await f.event('call.answered',control);await f.pump();
    assert.equal((await f.detail()).participants[0].state,'connected');
    assert.ok(f.submissions.some(s=>s.path==='/conferences/room/actions/join'&&s.body.call_control_id===control&&s.body.end_conference_on_exit===false));
    await f.action('hold');await f.pump();assert.equal((await f.detail()).call.state,'held');
    assert.ok(f.submissions.some(s=>s.path.endsWith('/actions/hold')&&s.body.call_control_ids.includes(control)));
    await f.action('resume');await f.pump();
    await f.event('call.hangup',control);await f.pump();
    assert.equal((await f.detail()).participants[0].state,'left');assert.equal((await f.detail()).call.state,'connected');
    assert.ok(!f.submissions.some(s=>s.path.includes(`${f.call.id}-host/actions/hangup`)||s.path.includes(`${f.call.id}-customer/actions/hangup`)));
  }finally{f.close();}
});
test('teammate invitations reserve availability and allow only their own guest controls',async()=>{
  const f=await conferenceFixture();try{
    const user='guest-user',ctx={orgId:f.orgId,userId:user,branchId:'default',sessionId:'guest-session',permissions:{make_calls:true,view_comms:true}} as any;
    await store.saveResource(f.orgId,'endpoint',user,{user_id:user,name:'Jordan',branch_id:'default',registered:true,availability:'available',heartbeat_at:store.now(),sip_username:'guest',session_id:'guest-session',device_id:'guest-device'});
    await f.action('add_participant',{target_user_id:user});
    const {presence,callAction,disconnectEndpoint}=await import('../comms/calls/voice.js');
    assert.equal((await presence(ctx,{device_id:'guest-device',registered:true,availability:'available'})).availability,'busy');
    await assert.rejects(()=>disconnectEndpoint(ctx,'guest-device'),/active call/);
    await assert.rejects(()=>callAction(ctx,f.call.id,{operation_id:'guest-cannot-add',action:'add_participant',target_phone:'+12065550103'}),/Only the call owner/);
    await f.pump();assert.equal(f.submissions[0]!.body.to,'sip:guest@sip.telnyx.com');
    await f.event('call.answered',`${f.call.id}-guest-1`);await f.pump();
    await callAction(ctx,f.call.id,{operation_id:'guest-leaves-only-self',action:'hangup'});await f.pump();
    assert.equal((await f.detail()).call.state,'connected');assert.equal((await f.detail()).participants[0].state,'left');
    assert.equal((await store.resource(f.orgId,'endpoint',user))?.offered_call_id,'');
    assert.ok(!f.submissions.some(s=>s.path.includes(`${f.call.id}-host/actions/hangup`)));
  }finally{f.close();}
});
test('canceled conference invitations never dial and late answers cannot rejoin',async()=>{
  const f=await conferenceFixture();try{
    await f.action('add_participant',{target_phone:'+12065550104'});const p=(await f.detail()).participants[0];
    const resource=await store.resource(f.orgId,'conference_participant',p.id);
    await f.action('remove_participant',{participant_id:p.id});await f.pump();assert.equal(f.submissions.length,0);
    await store.saveLeg(f.orgId,f.call.id,'participant',{call_control_id:'late-conference-leg',participant_id:p.id,operation_id:resource!.job_id,state:'initiated'});
    await f.event('call.answered','late-conference-leg');await f.pump();
    assert.ok(f.submissions.some(s=>s.path==='/calls/late-conference-leg/actions/hangup'));
    assert.ok(!f.submissions.some(s=>s.path.endsWith('/actions/join')));assert.equal((await f.detail()).call.state,'connected');
    assert.equal((await f.detail()).participants[0].state,'removed');
  }finally{f.close();}
});
test('conference limits and destination policy include pending invites; failures never end the original call',async()=>{
  const f=await conferenceFixture();try{
    await store.saveResource(f.orgId,'suppression','+12065550109',{});
    await assert.rejects(()=>f.action('add_participant',{target_phone:'+12065550109'}),/requested no phone calls/);
    await assert.rejects(()=>f.action('add_participant',{target_phone:'+442079460123'}),/enabled calling regions/);
    await assert.rejects(()=>f.action('add_participant',{target_phone:f.call.customer_number}),/different number/);
    for(let i=2;i<6;i++)await f.action('add_participant',{target_phone:`+1206555010${i}`});
    await assert.rejects(()=>f.action('add_participant',{target_phone:'+12065550106'}),/supports 6 people/);
    f.fail();await f.pump();const detail=await f.detail();
    assert.ok(detail.participants.every((p:any)=>p.state==='failed'));assert.equal(detail.call.state,'connected');
    assert.ok(!detail.call.metadata.provider_error);assert.ok(!f.submissions.some(s=>s.path.endsWith('/hangup')));
    await f.action('add_participant',{target_phone:'+12065550106'});f.fail(true);await f.pump();
    assert.equal((await f.detail()).participants.find((p:any)=>p.phone==='+12065550106').state,'uncertain');
    await assert.rejects(()=>f.action('add_participant',{target_phone:'+12065550106'}),/already on the call/);
    assert.equal((await f.detail()).call.state,'connected');
  }finally{f.close();}
});
test('conference capacity reserves pending supervisors and correlated events clear uncertainty',async()=>{
  const f=await conferenceFixture();try{
    await store.saveResource(f.orgId,'supervision','waiting-supervisor',{call_id:f.call.id,state:'dialing'});
    for(let i=2;i<5;i++)await f.action('add_participant',{target_phone:`+1206555010${i}`});
    await assert.rejects(()=>f.action('add_participant',{target_phone:'+12065550105'}),/supports 6 people/);
    f.fail(true);await f.pump();
    const p=(await f.detail()).participants.find((v:any)=>v.state==='uncertain'),resource=await store.resource(f.orgId,'conference_participant',p.id);
    for(const other of (await f.detail()).participants.filter((v:any)=>v.id!==p.id))await f.action('remove_participant',{participant_id:other.id});
    await store.saveLeg(f.orgId,f.call.id,'participant',{call_control_id:'uncertain-confirmed',participant_id:p.id,operation_id:resource!.job_id,state:'initiated'});
    await f.event('call.answered','uncertain-confirmed');await f.pump();
    assert.equal((await f.detail()).participants.find((v:any)=>v.id===p.id).state,'connected');
    assert.equal((await store.jobs(f.orgId,f.call.id)).find(j=>j.id===resource!.job_id)?.state,'completed');
    assert.equal((await f.detail()).call.state,'connected');
  }finally{f.close();}
});
