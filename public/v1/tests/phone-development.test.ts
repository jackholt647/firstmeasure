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

test('development onboarding is tenant-scoped, keeps one provider owner, and cannot run in production',async()=>{
  const {env}=await import('../src/config/env.js');const saved=env.dataEnvironment;
  const a=await owner(),b=await owner();
  const route=(orgId:string)=>`/v1/comms/organizations/${orgId}/voice/development/onboard`;
  try{
    Object.assign(env,{dataEnvironment:'development'});
    for(const kind of ['application','connection','outbound_profile'])await store.saveResource(a.orgId,kind,'default',{status:'ready'},`test-${kind}`);
    await store.saveResource(a.orgId,'number','+12065550199',{status:'active',phone_number:'+12065550199',branch_id:'default'},'test-number');
    assert.equal((await client().raw('POST',route(b.orgId),{})).status,401);
    assert.equal((await a.c.raw('POST',route(b.orgId),{})).status,403);
    const result=await b.c.request('POST',route(b.orgId),{});
    assert.equal(result.development.onboarded,true);assert.equal(result.development.destination,'+14259700671');
    assert.equal((await store.resource(b.orgId,'application'))?.provider_id,'test-application');
    assert.equal((await store.resourceByProvider('application','test-application'))?.organization_id,a.orgId);
    assert.equal((await store.resource(a.orgId,'settings')),null);
    await b.c.request('POST',route(b.orgId),{});
    const {readGlobal}=await import('../platform/storage.js');
    const global=await readGlobal(b.orgId);assert.equal((global.data as any).app_groups.communications.members.center,'standalone');
    await store.insertCall({id:'shared-transport-call',organization_id:b.orgId,branch_id:'default',owner_user_id:'test',mode:'browser',direction:'outbound',state:'agent_connecting',metadata:{}});
    await worker.processVoiceEvent({data:{event_type:'call.initiated',occurred_at:store.now(),payload:{connection_id:'test-application',call_control_id:'shared-control',client_state:Buffer.from(JSON.stringify({call_id:'shared-transport-call',role:'agent'})).toString('base64')}}});
    assert.equal((await store.legByControl('shared-control'))?.organization_id,b.orgId);
    Object.assign(env,{dataEnvironment:'production'});
    assert.equal((await b.c.raw('POST',route(b.orgId),{})).status,404);
    assert.equal((await store.resource(b.orgId,'application'))?.provider_id,'');
  }finally{Object.assign(env,{dataEnvironment:saved});}
});
test('mandatory dispositions block a new call while optional outcomes remain skippable',async()=>{
  const {c,orgId}=await owner(),base=`/v1/comms/organizations/${orgId}`;
  await store.saveResource(orgId,'settings','default',{require_disposition:true});
  const first=await c.request('POST',`${base}/calls`,{operation_id:'disposition-first',customer_number:'+12065550100'});
  const blocked=await c.raw('POST',`${base}/calls`,{operation_id:'disposition-second',customer_number:'+12065550101'});
  assert.equal(blocked.status,409);assert.equal(blocked.data.error,'call_disposition_required');
  await store.saveResource(orgId,'settings','default',{require_disposition:false});
  assert.equal((await c.raw('POST',`${base}/calls`,{operation_id:'disposition-second',customer_number:'+12065550101'})).status,201);
  assert.equal((await store.readCall(orgId,first.call.id)).wrap_up_state,'draft');
});
test('phone search finds saved Contacts records and preserves their project link',async()=>{
  const {c,orgId}=await owner();
  const projectId='phone_contact_project',contactId='phone_contact_person';
  await c.request('POST',`/v1/platform/organizations/${orgId}/projects`,{id:projectId,data:{
    title:'Taylor Reed',workflow_state:'contact_only',contacts:[{id:contactId,name:'Taylor Reed',phone:'+12025550131',primary:true}]
  }});
  const result=await c.request('GET',`/v1/comms/organizations/${orgId}/voice/contacts?query=Taylor`);
  assert.deepEqual(result.contacts,[{id:contactId,project_id:projectId,name:'Taylor Reed',phone:'+12025550131'}]);
  assert.deepEqual((await c.request('GET',`/v1/comms/organizations/${orgId}/voice/contacts`)).contacts,result.contacts);
  assert.deepEqual((await c.request('GET',`/v1/comms/organizations/${orgId}/voice/contacts?query=a`)).contacts,result.contacts);
  const call=await c.request('POST',`/v1/comms/organizations/${orgId}/calls`,{
    operation_id:'contact-search-call',project_id:projectId,contact_id:contactId,customer_number:'+12025550131'
  });
  assert.equal(call.call.contact_id,contactId);
  assert.equal(call.call.project_id,projectId);
});
test('phone defaults are saved per user and assigned lines remain restricted',async()=>{
  const {c,orgId}=await owner(),base=`/v1/comms/organizations/${orgId}`;
  const users=(await c.request('GET',`${base}/voice/people`)).people;
  const userId=users.find((person:any)=>person.name==='Call Owner')?.id;
  assert.ok(userId);
  await store.saveResource(orgId,'number','+12065550191',{status:'active',phone_number:'+12065550191',branch_id:'default',label:'Main'},'');
  await store.saveResource(orgId,'number','+12065550192',{status:'active',phone_number:'+12065550192',branch_id:'default',label:'Personal'},'');
  await c.request('PUT',`${base}/voice/numbers/${encodeURIComponent('+12065550192')}/assignment`,{assigned_user_id:userId});
  await c.request('PUT',`${base}/voice/default-number`,{phone_number:'+12065550192'});
  const status=await c.request('GET',`${base}/voice/status`);
  assert.equal(status.default_number,'+12065550192');
  assert.equal(status.numbers.find((line:any)=>line.phone_number==='+12065550192').assigned_user_id,userId);
  const rejected=await c.raw('PUT',`${base}/voice/default-number`,{phone_number:'+12065550999'});
  assert.equal(rejected.status,403);
});
test('carrier boundary reroutes development PSTN calls and transfers; production is unchanged',async()=>{
  const {env}=await import('../src/config/env.js');const {TelnyxVoiceClient}=await import('../telephony/telnyx.js');
  const previous=env.dataEnvironment,allowed=process.env.TELNYX_VOICE_DEVELOPMENT_ALLOWED_NUMBERS;
  const payloads:any[]=[];
  const adapter=new TelnyxVoiceClient({request:async(_path:string,options:any)=>{payloads.push(JSON.parse(options.body));return {data:{id:'test'}};}} as any);
  try{
    Object.assign(env,{dataEnvironment:'development'});process.env.TELNYX_VOICE_DEVELOPMENT_ALLOWED_NUMBERS='+14259700671';
    await adapter.dial({to:'+442012345678'});await adapter.command('test','transfer',{to:'+12065550122'});
    assert.deepEqual(payloads.map(p=>p.to),['+14259700671','+14259700671']);
    await adapter.dial({to:'sip:test@sip.telnyx.com'});assert.equal(payloads[2].to,'sip:test@sip.telnyx.com');
    process.env.TELNYX_VOICE_DEVELOPMENT_ALLOWED_NUMBERS='';await assert.rejects(adapter.dial({to:'+12065550111'}));
    Object.assign(env,{dataEnvironment:'production'});await adapter.dial({to:'+12065550111'});assert.equal(payloads.at(-1).to,'+12065550111');
  }finally{Object.assign(env,{dataEnvironment:previous});if(allowed===undefined)delete process.env.TELNYX_VOICE_DEVELOPMENT_ALLOWED_NUMBERS;else process.env.TELNYX_VOICE_DEVELOPMENT_ALLOWED_NUMBERS=allowed;}
});
