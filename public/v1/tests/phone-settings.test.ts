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


test('outgoing preferences validate audio ownership and number access',async()=>{
 const {c,orgId}=await owner(),base=`/v1/comms/organizations/${orgId}/phone`,w=await c.request('GET',base);
 assert.equal((await c.raw('PUT',base+'/personal',{revision:0,voicemail_drop:{enabled:true}})).status,400);
 await store.saveResource(orgId,'number','+12065551101',{phone_number:'+12065551101',status:'active',assigned_user_id:'another-user'});
 assert.equal((await c.raw('PUT',base+'/personal',{revision:0,power_dial:{enabled:true,numbers:['+12065551101']}})).status,403);
 await store.saveResource(orgId,'phone_greeting','outgoing',{owner_user_id:w.user_id,file:Buffer.from('RIFF0000WAVEtest').toString('base64'),content_type:'audio/wav'});
 await c.request('PUT',base+'/personal',{revision:0,voicemail_drop:{enabled:true,media_id:'outgoing'}});
 const {outgoingDrop}=await import('../comms/phone/outbound.js');assert.deepEqual(await outgoingDrop(orgId,w.user_id,false),{});assert.equal((await outgoingDrop(orgId,w.user_id,true)).media_id,'outgoing');
});

test('power dialing balances owned numbers, counts manual usage, and pauses at limits or high risk',async()=>{
 const {orgId,c}=await owner(),w=await c.request('GET',`/v1/comms/organizations/${orgId}/phone`),ctx=await (await import('../platform/auth.js')).backgroundAuthContext(orgId,w.user_id),numbers=['+12065551102','+12065551103'];
 const {selectPowerDialLine}=await import('../comms/phone/outbound.js');
 for(const number of numbers)await store.saveResource(orgId,'number',number,{phone_number:number,status:'active',branch_id:'default'});
 await store.saveResource(orgId,'phone_personal',w.user_id,{power_dial:{enabled:true,numbers,daily_limit:1,cooldown_seconds:0}});
 assert.equal((await store.transaction(()=>selectPowerDialLine(ctx,'default')))?.id,numbers[0]);
 await store.insertCall({id:store.id('call'),organization_id:orgId,branch_id:'default',mode:'browser',direction:'outbound',state:'ended',business_number:numbers[0]});
 assert.equal((await store.transaction(()=>selectPowerDialLine(ctx,'default')))?.id,numbers[1]);
 await store.saveResource(orgId,'phone_reputation_number',numbers[1]!,{reputation_data:{spam_risk:'high'}});
 await assert.rejects(()=>store.transaction(()=>selectPowerDialLine(ctx,'default')),/paused/);
 await store.saveResource(orgId,'phone_reputation_number',numbers[1]!,{reputation_data:{spam_risk:'low'}});
 await store.saveResource(orgId,'phone_line',numbers[1]!,{user_ids:['other-user']});
 await assert.rejects(()=>store.transaction(()=>selectPowerDialLine(ctx,'default')),/paused/);
});

test('voicemail drop waits for a beep and matching completed playback, with duplicate protection',async()=>{
 const {orgId}=await owner(),callId=store.id('call'),control=store.id('control');
 await store.insertCall({id:callId,organization_id:orgId,branch_id:'default',mode:'browser',direction:'outbound',state:'dialing',metadata:{voicemail_drop:{enabled:true,media_id:'audio',state:'pending'}}});
 await store.saveLeg(orgId,callId,'agent',{call_control_id:store.id('agent'),state:'answered'},store.now());
 await store.saveLeg(orgId,callId,'customer',{call_control_id:control,state:'initiated'},store.now());
 const event=async(type:string,extra:any={})=>worker.processVoiceEvent({data:{id:store.id('event'),event_type:type,occurred_at:store.now(),payload:{call_control_id:control,...extra}}});
 const jobs=async()=> (await store.database().prepare('SELECT payload_json FROM customer_call_jobs WHERE organization_id=? AND call_id=?').all(orgId,callId)).map((r:any)=>JSON.parse(r.payload_json));
 await event('call.answered');assert.equal((await jobs()).some(j=>j.path==='conference_create'),false);
 await event('call.machine.premium.detection.ended',{result:'machine'});assert.equal((await jobs()).some(j=>j.path==='playback_start'),false);
 await event('call.machine.premium.greeting.ended',{result:'beep_detected'});await event('call.machine.premium.greeting.ended',{result:'beep_detected'});
 const drops=(await jobs()).filter(j=>j.path==='playback_start');assert.equal(drops.length,1);assert.match(drops[0].payload.audio_url,/phone-greetings/);
 await event('call.playback.ended',{status:'completed'});assert.equal(store.object((await store.readCall(orgId,callId)).metadata.voicemail_drop).state,'playing');
 await event('call.playback.ended',{status:'completed',client_state:drops[0].payload.client_state});assert.equal(store.object((await store.readCall(orgId,callId)).metadata.voicemail_drop).state,'completed');assert.ok((await jobs()).some(j=>j.path==='hangup'));await event('call.hangup',{hangup_cause:'NORMAL_CLEARING'});assert.equal((await store.readCall(orgId,callId)).state,'ended');
});

test('human, uncertain, timeout, inbound and canceled calls cannot receive a voicemail drop',async()=>{
 const {orgId}=await owner(),{voicemailDropEvent,expireVoicemailDetection}=await import('../comms/phone/outbound.js');
 for(const result of ['human_residence','human_business','not_sure','silence']){
  const call=await store.insertCall({id:store.id('call'),organization_id:orgId,branch_id:'default',mode:'browser',direction:'outbound',state:'dialing',metadata:{voicemail_drop:{enabled:true,media_id:'audio',state:'pending'}}});
  await voicemailDropEvent(call,'call.machine.premium.detection.ended',{result,call_control_id:'control'},{},'customer');
  assert.equal(store.object((await store.readCall(orgId,call.id)).metadata.voicemail_drop).state,'skipped');
  assert.equal(await voicemailDropEvent(await store.readCall(orgId,call.id),'call.machine.premium.greeting.ended',{result:'beep_detected'},{},'customer'),false);
 }
 const timed=await store.insertCall({id:store.id('call'),organization_id:orgId,branch_id:'default',mode:'browser',direction:'outbound',state:'dialing',metadata:{voicemail_drop:{enabled:true,state:'machine'}}});await expireVoicemailDetection(timed);assert.equal(store.object((await store.readCall(orgId,timed.id)).metadata.voicemail_drop).state,'skipped');
 for(const patch of [{direction:'inbound'}, {state:'ended'},{metadata:{voicemail_drop:{enabled:true,state:'pending'},canceled_at:store.now()}}])assert.equal(await voicemailDropEvent({...timed,...patch} as any,'call.machine.premium.greeting.ended',{result:'beep_detected'},{},'customer'),false);
});

test('reputation is tenant-bound, uses cached polling, and requires confirmed carrier changes',async()=>{
 const {c,orgId}=await owner(),base=`/v1/comms/organizations/${orgId}/phone/reputation`,number='+12065551104';
 const {TelnyxClient}=await import('../messaging/telnyx.js'),{env}=await import('../src/config/env.js'),original=TelnyxClient.prototype.request,oldEnv=env.dataEnvironment,oldMap=process.env.TELNYX_REPUTATION_ENTERPRISES;
 const requests:any[]=[];let monitored=false,frequency='weekly';
 await store.saveResource(orgId,'number',number,{phone_number:number,status:'active'});
 process.env.TELNYX_REPUTATION_ENTERPRISES=JSON.stringify({[orgId]:'owned-enterprise'});(env as any).dataEnvironment='production';
 TelnyxClient.prototype.request=async function(path:string,init:any={}){const body=init.body?JSON.parse(init.body):{};requests.push({path,method:init.method||'GET',body});assert.ok(path.startsWith('/enterprises/owned-enterprise/reputation'));
 if(path.includes('/numbers?page'))return {data:monitored?[{phone_number:number,reputation_data:{spam_risk:'high',last_refreshed_at:'2026-10-11T12:00:00Z',connection_score:null}},{phone_number:'+12065559999',reputation_data:{spam_risk:'low'}}]:[]};
 if(path.endsWith('/numbers')&&init.method==='POST'){monitored=true;return {data:{}};}
 if(path.endsWith('/frequency')){frequency=body.check_frequency;return {data:{}};}
 if(path.endsWith('/refresh'))return {data:{total_successful:1,total_failed:0}};
 if(path.endsWith('/reputation'))return {data:{status:'approved',loa_status:'approved',check_frequency:frequency}};
 throw Error('Unexpected reputation request '+path);
 } as any;
 try{
 assert.equal((await c.raw('POST',base,{action:'monitor',phone_number:number})).status,409);
 const result=await c.request('POST',base,{operation_id:'monitor-test-001',action:'monitor',phone_number:number,confirmed:true});assert.equal(result.numbers.length,1);assert.equal(result.numbers[0].reputation_data.spam_risk,'high');
 await c.request('POST',base,{operation_id:'monitor-test-001',action:'monitor',phone_number:number,confirmed:true});assert.equal(requests.filter(r=>r.path.endsWith('/numbers')&&r.method==='POST').length,1);
 await c.request('POST',base,{operation_id:'frequency-test-001',action:'frequency',frequency:'daily',confirmed:true});assert.equal((await store.resource(orgId,'phone_reputation'))?.check_frequency,'daily');
 await c.request('POST',base,{operation_id:'refresh-test-001',action:'refresh',phone_number:number,confirmed:true});assert.ok(requests.some(r=>r.path.endsWith('/refresh')&&r.method==='POST'));assert.equal(requests.some(r=>r.method==='GET'&&r.path.includes('/numbers/')),false);
 (env as any).dataEnvironment='development';assert.equal((await c.raw('POST',base,{operation_id:'refresh-test-001',action:'refresh',phone_number:number,confirmed:true})).status,403);
 process.env.TELNYX_REPUTATION_ENTERPRISES=JSON.stringify({[orgId]:'owned-enterprise',another:'owned-enterprise'});assert.equal((await c.raw('POST',base,{action:'sync'})).status,409);
 }finally{TelnyxClient.prototype.request=original;(env as any).dataEnvironment=oldEnv;if(oldMap===undefined)delete process.env.TELNYX_REPUTATION_ENTERPRISES;else process.env.TELNYX_REPUTATION_ENTERPRISES=oldMap;}
});


test('power-dial API snapshots the selected line and sends AMD only on the customer carrier leg',async()=>{
 const {TelnyxVoiceClient,setVoiceClientFactoryForTests}=await import('../telephony/telnyx.js'),requests:any[]=[];let sequence=0;
 class Provider extends TelnyxVoiceClient {override async request(path:string,method='GET',body:any={}){requests.push({path,method,body});if(path==='/calls')return {data:{call_control_id:`outbound-extension-${++sequence}`,call_leg_id:`extension-leg-${sequence}`}};if(path==='/telephony_credentials')return {data:{id:'extension-credential',sip_username:'extension-endpoint',expires_at:new Date(Date.now()+86400000).toISOString()}};if(path.endsWith('/token'))return `test.${Buffer.from(JSON.stringify({exp:Math.floor(Date.now()/1000)+86400})).toString('base64url')}.sig`;return {data:{result:'ok'}};}}
 setVoiceClientFactoryForTests(()=>new Provider());process.env.TELNYX_VOICE_MODE='live';
 try{
 const {c,orgId}=await owner(),base=`/v1/comms/organizations/${orgId}`,w=await c.request('GET',base+'/phone'),number='+12065551105';
 await store.saveResource(orgId,'application','default',{},'extension-app');await store.saveResource(orgId,'connection','default',{},'extension-connection');
 await store.saveResource(orgId,'number',number,{phone_number:number,status:'active',branch_id:'default'});await store.saveResource(orgId,'settings','default',{enabled:true,emergency_policy_confirmed:true,service_location:'Test office'});
 await store.saveResource(orgId,'phone_greeting','extension-audio',{owner_user_id:w.user_id});
 await c.request('PUT',base+'/phone/personal',{revision:0,power_dial:{enabled:true,numbers:[number],cooldown_seconds:0},voicemail_drop:{enabled:true,media_id:'extension-audio'}});
 await c.request('POST',base+'/voice/endpoint/token',{device_id:'extension-device'});await c.request('POST',base+'/voice/endpoint/presence',{device_id:'extension-device',registered:true,availability:'available'});await c.request('POST',base+'/voice/diagnostics',{device_id:'extension-device',microphone:'ready',connectivity:'ready',provider_verdict:'ready',metrics:{rtt_ms:60,jitter_ms:3,packet_loss_percent:0}});
 const body={operation_id:'extension-dial-operation',mode:'browser',power_dial:true,device_id:'extension-device',customer_number:'+12065551106'},result=await c.request('POST',base+'/calls',body);
 assert.equal(result.call.business_number,number);assert.equal(result.call.metadata.voicemail_drop.state,'pending');assert.equal((await c.request('POST',base+'/calls',body)).call.id,result.call.id);
 await worker.processOneJob('extension','voice',result.call.id);assert.equal(requests.find(r=>r.path==='/calls').body.answering_machine_detection,undefined);
 await worker.processVoiceEvent({data:{id:'extension-answer',event_type:'call.answered',occurred_at:store.now(),payload:{call_control_id:'outbound-extension-1'}}});await worker.processOneJob('extension','voice',result.call.id);
 const customer=requests.filter(r=>r.path==='/calls')[1];assert.equal(customer.body.answering_machine_detection,'premium');assert.equal(customer.body.from,number);assert.equal(customer.body.to,'+12065551106');
 }finally{process.env.TELNYX_VOICE_MODE='disabled';setVoiceClientFactoryForTests(null);}
});
