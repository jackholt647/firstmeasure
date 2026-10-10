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
  root=await mkdtemp(path.join(os.tmpdir(),"firstmate-phone-settings-"));
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
  if(path.dirname(path.resolve(root))===path.resolve(os.tmpdir())&&path.basename(root).startsWith("firstmate-phone-settings-"))await rm(root,{recursive:true,force:true,maxRetries:5,retryDelay:100}).catch(()=>{});
},{timeout:15000});

test('phone workspace is authenticated, tenant scoped, and revisions protect personal settings',async()=>{
 const {c,orgId}=await owner(),url=`/v1/comms/organizations/${orgId}/phone`;
 assert.equal((await client().raw('GET',url)).status,401);
 const other=await owner();assert.equal((await other.c.raw('GET',url)).status,403);
 const state=await c.request('GET',url);assert.equal(state.can_manage,true);
 await c.request('PUT',url+'/personal',{revision:0,available:false,notifications:{texts:false}});
 assert.equal((await c.raw('PUT',url+'/personal',{revision:0,available:true})).status,409);
 const {userAvailable}=await import('../comms/phone/service.js');assert.equal(await userAvailable(orgId,state.user_id),false);
});
test('line and group configuration validates members, departments, and route loops',async()=>{
 const {c,orgId}=await owner(),url=`/v1/comms/organizations/${orgId}/phone`,state=await c.request('GET',url);
 await store.saveResource(orgId,'number','+12065551001',{phone_number:'+12065551001',status:'active',branch_id:'default'});
 assert.equal((await c.raw('PUT',url+'/lines/%2B12065551001',{label:'Ads',revision:0,user_ids:['unknown']})).status,400);
 const group={label:'Sales',user_ids:[state.user_id],routing:{},revision:0};
 const g=await c.request('PUT',url+'/groups/sales',group);
 assert.equal((await c.raw('PUT',url+'/groups/sales',{...group,revision:g.group.revision,routing:{open:{kind:'group',id:'sales'}}})).status,400);
 await c.request('PUT',url+'/lines/%2B12065551001',{label:'Ads',revision:0,group_id:'sales',tracking:{enabled:true,source:'Google',campaign:'Roofing'}});
 const {resolveRoute}=await import('../comms/phone/service.js');assert.deepEqual((await resolveRoute(orgId,'+12065551001'))?.members,[state.user_id]);
});
test('sending windows respect weekends, holidays, missing zones, expiry and DST',async()=>{
 const {scheduleSchema}=await import('../comms/phone/contracts.js');const {nextWindow,deliveryEligibility}=await import('../comms/phone/messaging.js');
 const schedule=scheduleSchema.parse({timezone:'America/Los_Angeles',business_hours:[{day:1,open:'08:00',close:'17:00'}],holidays:['2026-03-09']});
 assert.equal(nextWindow(schedule,new Date('2026-03-06T20:00:00Z')),'2026-03-16T15:00:00.000Z');
 const repeated=scheduleSchema.parse({timezone:'America/Los_Angeles',business_hours:[{day:0,open:'01:00',close:'02:00'}]});
 assert.equal(nextWindow(repeated,new Date('2026-11-01T09:30:00Z')),'2026-11-01T09:30:00.000Z');
 const {orgId}=await owner();await store.saveResource(orgId,'phone_messaging','default',{enabled:true,timezone_mode:'contact',unknown_timezone:'hold',expiry_hours:1});
 assert.equal((await deliveryEligibility(orgId,{sender:{address:'+12065551002'},created_at:'2026-10-10T10:00:00Z'}, {},new Date('2026-10-10T10:30:00Z'))).action,'wait');
 assert.equal((await deliveryEligibility(orgId,{sender:{address:'+12065551002'},created_at:'2026-10-10T10:00:00Z'}, {},new Date('2026-10-10T12:00:00Z'))).action,'cancel');
});
test('attribution preserves history when configurations change and jobs arrive out of order',async()=>{
 const {c,orgId}=await owner(),number='+12065551003',url=`/v1/comms/organizations/${orgId}/phone`;
 await store.saveResource(orgId,'phone_line',number,{label:'Ad',tracking:{enabled:true,source:'Google',campaign:'Original'}});
 const {trackingSnapshot,recordAttribution}=await import('../comms/phone/service.js');const snapshot=await trackingSnapshot(orgId,number);
 await store.saveResource(orgId,'phone_line',number,{tracking:{enabled:true,source:'Mail'}});
 const earlier=await store.insertCall({id:store.id('call','earlier'+orgId),organization_id:orgId,branch_id:'default',mode:'browser',direction:'inbound',state:'no_answer',customer_number:'+12065551234',business_number:number,created_at:'2026-10-01T12:00:00.000Z',metadata:{attribution:snapshot}});
 const later=await store.insertCall({id:store.id('call','later'+orgId),organization_id:orgId,branch_id:'default',mode:'browser',direction:'inbound',state:'no_answer',customer_number:'+12065551234',business_number:number,created_at:'2026-10-02T12:00:00.000Z',metadata:{attribution:await trackingSnapshot(orgId,number)}});
 await recordAttribution(later);await recordAttribution(earlier);await recordAttribution(earlier);
 const leads=await store.resources(orgId,'phone_lead');assert.equal(leads.length,1);assert.equal(store.object(leads[0]?.first_touch).source,'Google');assert.equal(store.object(leads[0]?.last_touch).source,'Mail');
 const report=await c.request('GET',url+'/tracking?from=2026-10-01T00:00:00Z&to=2026-10-04T00:00:00Z');assert.equal(report.calls.length,2);assert.equal(report.sources.length,2);
});
test('simultaneous answers choose one owner and hang up the losing leg',async()=>{
 const {orgId}=await owner(),{ringEvent}=await import('../comms/phone/routing.js');
 const call=await store.insertCall({id:store.id('call','race'+orgId),organization_id:orgId,branch_id:'default',mode:'browser',direction:'inbound',state:'agent_connecting',metadata:{phone_routing:true,offered_user_ids:['alice','bob']}});
 await store.saveLeg(orgId,call.id,'agent',{call_control_id:'phone-race-a',state:'answered',ring_user_id:'alice'},store.now());await store.saveLeg(orgId,call.id,'agent',{call_control_id:'phone-race-b',state:'answered',ring_user_id:'bob'},store.now());
 assert.equal(await ringEvent(call,'call.answered','phone-race-a','alice'),false);assert.equal(await ringEvent(call,'call.answered','phone-race-b','bob'),true);
 const updated=await store.readCall(orgId,call.id);assert.equal(updated.owner_user_id,'alice');assert.equal(updated.metadata.winning_control_id,'phone-race-a');
 assert.ok(await store.database().prepare("SELECT id FROM customer_call_jobs WHERE organization_id=? AND call_id=? AND payload_json LIKE ?").get(orgId,call.id,'%phone-race-b%'));
});
test('uploaded voicemail greetings validate audio and signed URLs expire',async()=>{
 const {c,orgId}=await owner(),url=`/v1/comms/organizations/${orgId}/phone`;
 assert.equal((await c.raw('POST',url+'/greetings',{name:'fake.mp3',file:Buffer.from('not audio').toString('base64')})).status,400);
 const bytes=Buffer.alloc(48);bytes.write('RIFF');bytes.write('WAVE',8);
 const result=await c.request('POST',url+'/greetings',{name:'greeting.wav',file:bytes.toString('base64')});
 const {greetingUrl}=await import('../comms/phone/greetings.js');const link=new URL(greetingUrl(orgId,result.greeting.id),'https://example.test');
 assert.equal((await client().raw('GET',link.pathname+link.search)).status,200);
 link.searchParams.set('expires','1');assert.equal((await client().raw('GET',link.pathname+link.search)).status,403);
});
test('development port drafts are idempotent and paid carrier actions are blocked',async()=>{
 const {env}=await import('../src/config/env.js');const original=env.dataEnvironment;(env as any).dataEnvironment='development';
 try{const {c,orgId}=await owner(),url=`/v1/comms/organizations/${orgId}/phone`,body={phone_number:'+12065551004',label:'Existing line',operation_id:'port-draft-test'};
 const a=await c.request('POST',url+'/ports',body),b=await c.request('POST',url+'/ports',body);assert.equal(a.port.id,b.port.id);
 assert.equal((await c.raw('POST',url+'/ports/'+a.port.id+'/start',{})).status,409);
 assert.equal((await c.raw('POST',url+'/ports',{...body,phone_number:'+12065551005'})).status,409);
 }finally{(env as any).dataEnvironment=original;}
});

test('carrier port lifecycle attaches documents and reconciles an uncertain create without duplication',async()=>{
 const {TelnyxClient}=await import('../messaging/telnyx.js'),{env}=await import('../src/config/env.js');const original=TelnyxClient.prototype.request,oldEnv=env.dataEnvironment;(env as any).dataEnvironment='production';
 const requests:Array<{path:string,method:string,body:any}>=[];let reference='',status='draft',creates=0;
 TelnyxClient.prototype.request=async function(path:string,options:any={}){const body=options.body?JSON.parse(options.body):{};requests.push({path,method:options.method||'GET',body});
 if(path==='/porting_orders'&&options.method==='POST'){creates++;reference=body.customer_reference;throw new Error('Simulated lost response after carrier acceptance');}
 if(path.startsWith('/porting_orders?'))return {data:[{id:'port-provider-test',customer_reference:reference,status:{value:status}}]};
 if(path.includes('/requirements'))return {data:[{field:'documents.loa',requirement_type:'document'}]};
 if(path==='/documents')return {data:{id:'document-test'}};
 if(path.endsWith('/actions/confirm')){status='submitted';return {data:{}};}
 if(path.startsWith('/porting_orders/'))return {data:{id:'port-provider-test',customer_reference:reference,status:{value:status}}};
 throw Error('Unexpected carrier request: '+path);
 } as any;
 try{const {c,orgId}=await owner(),base=`/v1/comms/organizations/${orgId}/phone`;const {port}=await c.request('POST',base+'/ports',{phone_number:'+12065551008',label:'Port test',operation_id:'carrier-port-test'});
 assert.equal((await c.raw('POST',base+'/ports/'+port.id+'/start',{})).status,500);
 const recovered=await c.request('POST',base+'/ports/'+port.id+'/start',{});assert.equal(recovered.port.provider_id,'port-provider-test');assert.equal(creates,1);
 await c.request('PUT',base+'/ports/'+port.id+'/details',{end_user:{admin:{entity_name:'Test Co',auth_person_name:'Test User',billing_phone_number:'+12065551008',account_number:'private-account',pin_passcode:'private-pin'},location:{street_address:'1 Test Street',locality:'Seattle',administrative_area:'WA',postal_code:'98101',country_code:'US'}}});
 const saved=JSON.stringify(await store.resource(orgId,'phone_port',port.id));assert.equal(saved.includes('private-account'),false);assert.equal(saved.includes('private-pin'),false);
 await c.request('POST',base+'/ports/'+port.id+'/documents',{kind:'loa',filename:'signed-loa.pdf',file:Buffer.from('%PDF-1.4 test').toString('base64')});assert.ok(requests.some(r=>r.method==='PATCH'&&r.body.documents?.loa==='document-test'));
 const submitted=await c.request('POST',base+'/ports/'+port.id+'/confirm',{confirmed:true});assert.equal(submitted.port.status,'submitted');
 }finally{TelnyxClient.prototype.request=original;(env as any).dataEnvironment=oldEnv;}
});
test('assigned lines route to their member and closed schedules immediately use voicemail',async()=>{
 const {c,orgId}=await owner(),state=await c.request('GET',`/v1/comms/organizations/${orgId}/phone`),number='+12065551009';
 await store.saveResource(orgId,'settings','default',{enabled:true,business_hours:[]});await store.saveResource(orgId,'application','default',{},'route-app-test');
 await store.saveResource(orgId,'number',number,{status:'active',phone_number:number,branch_id:'default'});await store.saveResource(orgId,'phone_line',number,{user_ids:[state.user_id]});
 const {resolveRoute}=await import('../comms/phone/service.js');assert.deepEqual((await resolveRoute(orgId,number))?.members,[state.user_id]);
 const call=await store.insertCall({id:store.id('call','closed'+orgId),organization_id:orgId,branch_id:'default',mode:'browser',direction:'inbound',state:'queued',business_number:number});
 await store.saveLeg(orgId,call.id,'customer',{call_control_id:'closed-control-test',state:'answered'},store.now());
 const {routeConfiguredCall}=await import('../comms/phone/routing.js');assert.equal(await routeConfiguredCall(call),true);assert.equal((await store.readCall(orgId,call.id)).state,'voicemail');
});

test('phone notification opt-outs prevent occurrence creation and shared lines respect membership',async()=>{
 const {c,orgId}=await owner(),state=await c.request('GET',`/v1/comms/organizations/${orgId}/phone`),number='+12065551010';
 const {notifyText}=await import('../comms/phone/notifications.js'),{canUseLine}=await import('../comms/phone/service.js'),{backgroundAuthContext}=await import('../platform/auth.js');
 await store.saveResource(orgId,'number',number,{status:'active',phone_number:number,branch_id:'default'});await store.saveResource(orgId,'phone_line',number,{user_ids:[state.user_id]});await store.saveResource(orgId,'phone_personal',state.user_id,{notifications:{texts:false,push:false}});
 assert.equal(await canUseLine(await backgroundAuthContext(orgId,state.user_id),number),true);
 const message={id:'preference-test',branch_id:'default',channel:'sms',sender:{address:'+12065551111'},recipients:[{address:number}],text_body:'Test'};
 assert.equal(await notifyText(orgId,message,{enabled:true}),true);
 const {listDocuments}=await import('../platform/storage.js');assert.equal((await listDocuments(orgId,'notifications')).length,0);
 await store.saveResource(orgId,'phone_line',number,{user_ids:['another-user']});assert.equal(await canUseLine(await backgroundAuthContext(orgId,state.user_id),number),false);
});
