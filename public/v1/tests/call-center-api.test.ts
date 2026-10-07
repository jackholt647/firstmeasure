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
test('call-center routes enforce authentication, CSRF, exact analysis permission and tenant boundaries',async()=>{
  const {c,orgId}=await owner(),base=`/v1/comms/organizations/${orgId}`;
  const {call}=await c.request('POST',`${base}/calls`,{operation_id:'analysis-api-call',customer_number:'+12025550199'});
  const detail=await c.request('GET',`${base}/calls/${call.id}`);
  assert.equal(detail.permissions.analyze,true);assert.equal(detail.supervision.permissions.monitor,true);
  for(const suffix of ['analysis','supervision']){
    assert.equal((await client().raw('GET',`${base}/calls/${call.id}/${suffix}`)).status,401);
    const denied=await c.raw('POST',`${base}/calls/${call.id}/${suffix}`,{operation_id:'missing-csrf-token',mode:'monitor'},{'x-platform-csrf':''});
    assert.equal(denied.status,403);
    const other=await owner();assert.equal((await other.c.raw('GET',`${base}/calls/${call.id}/${suffix}`)).status,403);
  }
  assert.equal((await c.request('GET',`${base}/calls/${call.id}/analysis`)).available,false);
  await store.saveArtifact(orgId,call.id,'transcript','api-transcript',{text:'The customer requested a written estimate by Friday.',final:true},'ready',30);
  const input={operation_id:'api-analysis-request',system_prompt:'Extract the decisions and deadlines.'};
  const first=await c.raw('POST',`${base}/calls/${call.id}/analysis`,input);assert.equal(first.status,202);assert.equal(first.data.note.state,'pending');
  const retry=await c.request('POST',`${base}/calls/${call.id}/analysis`,input);assert.equal(retry.note.id,first.data.note.id);
  assert.equal((await store.jobs(orgId,call.id)).filter(j=>j.kind==='analysis').length,1);
  const storage=await import('../platform/storage.js'),user=await storage.readDocument(orgId,'users',call.owner_user_id);
  await storage.upsertDocument(orgId,'users',{id:user.id,data:{...user.data,org_permissions:{...(user.data as any).org_permissions,items:{...(user.data as any).org_permissions?.items,analyze_call_recordings:false,listen_calls:false}}}});
  const refreshed=await c.request('GET',`${base}/calls/${call.id}`);assert.equal(refreshed.permissions.analyze,false);assert.equal(refreshed.supervision.permissions.monitor,false);
  assert.equal((await c.raw('POST',`${base}/calls/${call.id}/analysis`,{...input,operation_id:'denied-analysis-request'})).status,403);
  assert.equal((await c.raw('POST',`${base}/calls/${call.id}/supervision`,{operation_id:'denied-supervisor-request',mode:'monitor'})).status,403);
});
