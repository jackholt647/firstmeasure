import assert from 'node:assert/strict';
import test,{before,after} from 'node:test';
import {mkdtemp,rm} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type {PlatformAuthContext} from '../platform/auth.js';
import type {SourceRef} from '../platform/publication/contracts.js';
let root:string,store:typeof import('../comms/calls/storage.js'),providers:typeof import('../platform/publication/providers.js'),context:typeof import('../platform/publication/context.js'),actions:typeof import('../platform/publication/actions.js');
const orgId='phone-publication-fixture',number='+12065550111';
function principal(permissions:Record<string,boolean>={'*':true},userId='manager'):PlatformAuthContext{return {orgId,userId,branchId:'default',role:'member',permissions,identity:{},organization:{},user:{},applicationAccess:{management:{enabled:true,permissions:{}}}} as unknown as PlatformAuthContext;}
const ctx=(auth=principal(),mode:'evaluate'|'command'='evaluate')=>context.userPublicationContext(auth,{executionKind:'agent',mode});
const target=(id?:string)=>({scope:'organization' as const,organizationId:orgId,...(id?{id}:{})});
const source=(kind:string,id?:string,args?:Record<string,unknown>):SourceRef=>({provider:'phone-settings',export:kind,target:target(id),...(args?{args}:{})});
const count=async(table:string)=>Number(store.object(await store.database().prepare(`SELECT count(*) AS n FROM ${table}`).get()).n);
before(async()=>{
 root=await mkdtemp(path.join(os.tmpdir(),'publication-phone-'));
 if(process.env.TEST_POSTGRES_URL)Object.assign(process.env,{FIRSTMATE_ENV:'test',FIRSTMEASURE_DATABASE_MODE:'postgres',DATABASE_URL:process.env.TEST_POSTGRES_URL,POSTGRES_POOL_MAX:'4',POSTGRES_AUTO_MIGRATE:'false'});
 Object.assign(process.env,{NODE_ENV:'test',PLATFORM_STORAGE_ROOT:path.join(root,'platform'),MESSAGING_STORAGE_ROOT:path.join(root,'messaging'),PLATFORM_HEARTBEAT_DISABLED:'1',WORK_SCHEDULER_DISABLED:'1',FIRSTMEASURE_JOB_WORKERS:'0',CUSTOMER_CALL_WORKER_DISABLED:'1'});
 const storage=await import('../platform/storage.js');await import('../platform/capability_defs.js');await import('../chat/capabilities.js');await import('../comms/capabilities.js');
 await storage.createOrganization({id:orgId});
 const identity=await storage.createIdentity({email:'phone-manager@publication.test',name:'Phone Manager'});await storage.addIdentityMembership(String(identity.id),orgId,'manager','owner');
 await storage.upsertDocument(orgId,'users',{id:'manager',data:{identity_id:identity.id,status:'active',branch_id:'default',org_permissions:{level:'owner',items:{}}}});
 await (await import('./helpers/platform-fixture.js')).enableExpandedPlatformFixture(orgId);
 await storage.upsertDocument(orgId,'projects',{id:'project-a',data:{name:'A',branch_id:'default'}});
 store=await import('../comms/calls/storage.js');providers=await import('../platform/publication/providers.js');context=await import('../platform/publication/context.js');actions=await import('../platform/publication/actions.js');
 (await import('../platform/publication/bootstrap.js')).initializePublication();
 await store.saveResource(orgId,'number',number,{phone_number:number,status:'active',branch_id:'default',accepted_cost:{monthly_cost:'1.00',upfront_cost:'1.00',currency:'USD',private_token:'SECRET'}},'SECRET-PROVIDER');
 await store.saveResource(orgId,'phone_line',number,{label:'Search ads',user_ids:['manager'],department_ids:['sales'],routing:null,messaging:null,tracking:{enabled:true,source:'Google',campaign:'Roofing'},group_id:''});
 await store.saveResource(orgId,'phone_sms',number,{assignment_status:'assigned',compliance_profile_id:'profile',campaign_id:'SECRET-CARRIER'});
 await store.saveResource(orgId,'phone_greeting','greeting',{owner_user_id:'manager',name:'Hello',content_type:'audio/wav',file:'SECRET-BYTES'});
 await store.saveResource(orgId,'phone_port','port',{phone_number:number,label:'Main',status:'draft',branch_id:'default',end_user:{pin_passcode:'SECRET'},documents:{loa:'SECRET'},customer_reference:'SECRET'},'SECRET');
 await store.saveResource(orgId,'phone_order','order',{phone_number:number,label:'Main',status:'pending',branch_id:'default',customer_reference:'SECRET'});
 await store.saveResource(orgId,'phone_reputation_account','default',{status:'pending',profile:{legal_name:'Business',fein:'SECRET',organization_contact:{email:'SECRET'}},signed_at:'',disabled_at:'',loa_document_id:'SECRET',signed_hash:'SECRET'});
 await store.saveResource(orgId,'phone_reputation_remediation','review',{status:'pending',numbers:[number],call_purpose:'Appointment follow-ups',created_at:'2026-10-12T00:00:00Z',results:null},'SECRET');
 await store.saveResource(orgId,'phone_reputation_number',number,{monitored:true,reputation_data:{spam_risk:'high',connection_score:null,private_token:'SECRET'},history:[]});
 await store.insertCall({id:'call',organization_id:orgId,branch_id:'default',project_id:'project-a',contact_id:'contact',owner_user_id:'manager',mode:'browser',direction:'inbound',state:'ended',customer_number:'+12065550222',business_number:number,created_at:'2026-10-01T12:00:00Z',metadata:{attribution:{enabled:true,number,label:'Search ads',source:'Google',medium:'cpc',campaign:'Roofing',ad_id:'ad'},voicemail:{started:true},voicemail_drop:{enabled:true,state:'completed',media_id:'SECRET'},power_dial:true}});
 await store.saveArtifact(orgId,'call','voicemail','audio',{file_path:'SECRET'});
 await (await import('../comms/phone/service.js')).recordAttribution(await store.readCall(orgId,'call'));
});
after(async()=>{
 await actions.closeActionDatabase();await (await import('../platform/publication/bindings.js')).closeBindingStoreForTests();await (await import('../work/storage.js')).closeWorkDatabase();await (await import('../messaging/communications_storage.js')).closeCommunicationsDatabase();await (await import('../platform/sql_store.js')).closeSqlStores();await (await import('../src/database/postgres.js')).closePostgresPools();
 if(path.dirname(path.resolve(root))===path.resolve(os.tmpdir())&&path.basename(root).startsWith('publication-phone-'))await rm(root,{recursive:true,force:true,maxRetries:5,retryDelay:100});
});
test('typed phone exports are pure and remove private carrier, audio and billing fields',async()=>{
 const before=[await count('customer_voice_resources'),await count('customer_call_jobs')];
 for(const [kind,id] of [['personal',undefined],['messaging',undefined],['line',number],['port','port'],['order','order'],['reputation',number],['reputation_settings',undefined],['reputation_onboarding',undefined],['reputation_remediation','review'],['greeting','greeting'],['billing',number],['voicemail','call']] as const){
  const result=await providers.readPublishedData(ctx(),source(kind,id));assert.equal(result.status,'ready',JSON.stringify(result));if(result.status==='ready')assert.doesNotMatch(JSON.stringify(result.value),/SECRET|provider_id|file_path|pin_passcode/);
 }
 assert.deepEqual([await count('customer_voice_resources'),await count('customer_call_jobs')],before);
 const line=await providers.readPublishedData(ctx(),source('line',number));if(line.status==='ready')assert.equal((line.value as any).sms_status,'assigned');
 const calls=await providers.readPublishedData(ctx(),{provider:'customer-calls',export:'record',target:target('call')});assert.equal(calls.status,'ready');if(calls.status==='ready'){assert.equal((calls.value as any).phone.attribution.source,'Google');assert.equal((calls.value as any).phone.voicemail_drop.state,'completed');assert.doesNotMatch(JSON.stringify(calls.value),/SECRET/);}
});
test('tenant, own-user, billing, department and recording permissions are enforced',async()=>{
 const viewer=principal({view_comms:true});
 assert.equal((await providers.readPublishedData(ctx(viewer),source('personal'))).status,'ready');
 for(const kind of ['line','billing','reputation'])assert.equal((await providers.readPublishedData(ctx(viewer),source(kind,number))).status,'denied');
 assert.equal((await providers.readPublishedData(ctx(viewer),source('voicemail','call'))).status,'denied');
 assert.equal((await providers.readPublishedData(ctx(),source('personal','other'))).status,'denied');
 assert.equal((await providers.readPublishedData(ctx(principal({'*':true},'other')),source('greeting','greeting'))).status,'denied');
 assert.equal((await providers.readPublishedData(ctx(),{...source('line',number),target:{...target(number),organizationId:'foreign'}})).status,'denied');
 const scoped=principal({view_comms:true});scoped.organizationStructure={catalog:{departments:[{id:'sales',label:'Sales'},{id:'other',label:'Other'}]},users:[]};scoped.scopedAccessGrants=[{scope:{kind:'department',id:'sales'},permissions:{manage_communications:true}}];
 assert.equal((await providers.readPublishedData(ctx(scoped),source('line',number))).status,'ready');
 scoped.scopedAccessGrants=[{scope:{kind:'department',id:'other'},permissions:{manage_communications:true}}];assert.equal((await providers.readPublishedData(ctx(scoped),source('line',number))).status,'denied');
});
test('publication actions use domain validation, revisions, evaluate guard and durable receipts',async()=>{
 const action={action:'phone-settings.personal.save',target:target()},input={revision:0,available:false};
 await assert.rejects(actions.invokeAction(ctx(),action,input,{idempotencyKey:'personal'}),{code:'action_effect_denied'});
 const first=await actions.invokeAction(ctx(principal(),'command'),action,input,{idempotencyKey:'personal'});
 const replay=await actions.invokeAction(ctx(principal(),'command'),action,input,{idempotencyKey:'personal'});assert.deepEqual(replay.value,first.value);assert.equal(replay.receipt.replayed,true);
 assert.equal((await store.resource(orgId,'phone_personal','manager'))?.revision,1);
 await assert.rejects(actions.invokeAction(ctx(principal(),'command'),action,{revision:0,available:true},{idempotencyKey:'stale'}),{code:'settings_revision_conflict'});
 await assert.rejects(actions.invokeAction(ctx(principal(),'command'),action,{revision:1,schedule:{timezone:'Invalid/Zone'}},{idempotencyKey:'invalid'}));
 await assert.rejects(actions.invokeAction(ctx(principal(),'command'),action,{revision:1,power_dial:{enabled:true,numbers:['+12065550999']}},{idempotencyKey:'foreign-pool'}),{code:'dial_pool_number_denied'});
 await assert.rejects(actions.invokeAction(ctx(principal(),'command'),action,{revision:1,voicemail_drop:{enabled:true,media_id:'missing'}},{idempotencyKey:'foreign-audio'}),{code:'drop_audio_denied'});
 await assert.rejects(actions.invokeAction(ctx(principal({}),'command'),action,input,{idempotencyKey:'personal'}),{code:'phone_settings_denied'});
});
test('port draft action is local and creates one draft on receipt replay',async()=>{
 const before=await count('customer_voice_resources'),ref={action:'phone-settings.port.draft',target:target()},input={phone_number:'+12065550333',label:'Port main'};
 const result=await actions.invokeAction(ctx(principal(),'command'),ref,input,{idempotencyKey:'port'});
 assert.deepEqual((await actions.invokeAction(ctx(principal(),'command'),ref,input,{idempotencyKey:'port'})).value,result.value);assert.equal(await count('customer_voice_resources'),before+1);
});
test('mailbox actions and frozen sources stop working when source retention expires',async()=>{
 const ref={action:'phone-settings.voicemail.handle',target:target('call')},input={revision:0,handled:true};
 await actions.invokeAction(ctx(principal(),'command'),ref,input,{idempotencyKey:'handled'});
 const captured=await providers.readPublishedData(ctx(),source('voicemail','call'));assert.equal(captured.status,'ready');
 const artifact=store.id('ca',`${orgId}:voicemail:audio`);await store.database().prepare("UPDATE customer_call_artifacts SET expires_at='2000-01-01' WHERE id=?").run(artifact);
 if(captured.status==='ready')await assert.rejects(providers.authorizeSourceSnapshot(ctx(),source('voicemail','call'),captured),{code:'voicemail_missing'});
 await assert.rejects(actions.invokeAction(ctx(principal(),'command'),ref,input,{idempotencyKey:'handled'}),{code:'voicemail_missing'});
});
test('tracking report publishes typed attribution and rechecks every captured source',async()=>{
 const ref=source('tracking_report',undefined,{from:'2026-10-01T00:00:00Z',to:'2026-10-03T00:00:00Z'}),result=await providers.readPublishedData(ctx(),ref);assert.equal(result.status,'ready',JSON.stringify(result));if(result.status!=='ready')return;
 assert.equal((result.value as any).calls.length,1);assert.equal((result.value as any).sources[0].new_leads,1);assert.doesNotMatch(JSON.stringify(result.value),/SECRET|provider_id/);
 await assert.rejects(providers.authorizeSourceSnapshot(ctx(principal({view_comms:true})),ref,result));
 assert.equal((await providers.readPublishedData(ctx(),source('tracking_report',undefined,{from:'bad',to:'bad'}))).status,'error');
});
test('phone outbox commits atomically, ignores timestamp-only polls and deduplicates webhook repeats',async()=>{
 const before=await count('customer_call_jobs');
 await assert.rejects(store.transaction(async()=>{await store.saveResource(orgId,'phone_port','rollback',{status:'draft'});throw Error('rollback');}));
 assert.equal(await store.resource(orgId,'phone_port','rollback'),null);assert.equal(await count('customer_call_jobs'),before);
 const old=(await store.resource(orgId,'phone_reputation_number',number))!;
 await store.saveResource(orgId,'phone_reputation_number',number,{...old,synced_at:new Date().toISOString()});assert.equal(await count('customer_call_jobs'),before);
 await store.appendEvent(orgId,'call','communication.call.connected',{},'connected-event');await store.appendEvent(orgId,'call','communication.call.connected',{},'connected-event');
 assert.equal(await count('customer_call_jobs'),before+1);
 const rows=await store.database().prepare("SELECT payload_json FROM customer_call_jobs WHERE organization_id=? AND kind='phone_event'").all(orgId);
 assert.doesNotMatch(JSON.stringify(rows),/SECRET|pin_passcode|file_path/);
 const events=await import('../work/events.js');for(const row of rows){const event=JSON.parse(String(store.object(row).payload_json));assert.ok(events.listWorkEventDefinitions().some(e=>e.name===event.type));}
});
test('worker publishes durable Work events and a repeated delivery has one event identity',async()=>{
 const row=store.object(await store.database().prepare("SELECT * FROM customer_call_jobs WHERE organization_id=? AND kind='phone_event' AND call_id='call' LIMIT 1").get(orgId));assert.ok(row.id);
 const {publishPhoneEvent}=await import('../comms/phone/events.js');const payload=JSON.parse(String(row.payload_json));
 const first=await publishPhoneEvent(orgId,String(row.id),payload),second=await publishPhoneEvent(orgId,String(row.id),payload);assert.ok(first);assert.ok(second);assert.equal(first.id,second.id);
 const worker=await import('../comms/calls/worker.js');assert.equal(await worker.processOneJob('phone-publication-test','events','call'),true);
 const work=await import('../work/storage.js');const saved=await work.readEventRecord(orgId,String(first.id));assert.ok(saved);assert.equal(saved.type,'phone.call.connected');assert.equal(saved.visibility,'system');
});
test('lists bind cursors to the query and frozen data rechecks captured records',async()=>{
 await store.saveResource(orgId,'number','+12065550444',{status:'active',branch_id:'default'});
 const page=await providers.listPublishedData(ctx(),source('line'),{limit:1});assert.equal(page.status,'ready');if(page.status!=='ready')return;assert.ok(page.nextCursor);
 assert.equal((await providers.listPublishedData(ctx(),source('order'),{limit:1,cursor:page.nextCursor})).status,'error');
 const frozen=await providers.readPublishedData(ctx(),source('line',number));assert.equal(frozen.status,'ready');if(frozen.status!=='ready')return;
 const restricted=principal({'*':true,manage_communications:false,manage_company_settings:false});await assert.rejects(providers.authorizeSourceSnapshot(ctx(restricted),source('line',number),frozen));
});

test('group, line, message-window and lead actions update real domain records',async()=>{
 const command=ctx(principal(),'command');
 const write=async(action:string,id:string|undefined,input:unknown,key:string)=>actions.invokeAction(command,{action:`phone-settings.${action}`,target:target(id)},input,{idempotencyKey:key});
 await write('group.save','ring-sales',{revision:0,label:'Sales',user_ids:['manager'],routing:{closed:{kind:'voicemail'}}},'group');
 const group=await providers.readPublishedData(ctx(),source('group','ring-sales'));assert.equal(group.status,'ready',JSON.stringify(group));
 const line=(await store.resource(orgId,'phone_line',number))!;
 await write('line.save',number,{revision:line.revision,label:'Search ads',group_id:'ring-sales',tracking:{enabled:true,source:'Google'}},'line');
 const route=await (await import('../comms/phone/service.js')).resolveRoute(orgId,number);assert.deepEqual(route?.members,['manager']);
 await write('messaging.save',undefined,{revision:0,policy:{enabled:true,timezone_mode:'contact',unknown_timezone:'hold'}},'messaging');
 assert.equal((await store.resource(orgId,'phone_messaging'))?.timezone_mode,'contact');
 const lead=(await store.resources(orgId,'phone_lead'))[0]!;
 await write('lead.save',lead.id,{revision:lead.revision,project_id:'project-a',status:'qualified'},'lead');assert.equal((await store.resource(orgId,'phone_lead',lead.id))?.status,'qualified');
 await assert.rejects(actions.invokeAction(ctx(principal({view_comms:true}),'command'),{action:'phone-settings.line.save',target:target(number)},{revision:line.revision,label:'Search ads',group_id:'ring-sales',tracking:{enabled:true,source:'Google'}},{idempotencyKey:'line'}));
});

test('publication jobs cannot block the voice lane and transient delivery failures retain the job',async()=>{
 const {callPhoneEvent}=await import('../comms/phone/event-contracts.js');const call=await store.readCall(orgId,'call');
 const event=callPhoneEvent('communication.call.ended',call,{})!;
 const jobId=await store.enqueue(orgId,call.id,'phone_event',event,'retry-event');
 const claimed=await store.claimJob('delivery-crash','events','call');assert.ok(claimed);
 // A call-control operation remains claimable while publication owns a lease.
 const providerId=await store.enqueue(orgId,call.id,'provider',{path:'hangup'},'lane-provider');
 const voice=await store.claimJob('voice-independent','voice','call');assert.equal(voice?.id,providerId);
 await store.finishJob(providerId,'voice-independent','completed');
 await store.finishJob(String(claimed.id),'delivery-crash','pending',{},'temporary delivery failure');
 const retried=await store.claimJob('delivery-retry','events','call');assert.equal(retried?.id,jobId);assert.equal(retried?.attempts,2);
 await store.finishJob(jobId,'delivery-retry','completed');
});

test('development phone event drain executes phone events and leaves unrelated automation backlogs alone',async()=>{
 const work=await import('../work/storage.js');
 const unrelated=await work.createEventRecord({organization_id:orgId,type:'project.created',idempotency_key:'unrelated-pending',payload:{}});
 const phone=await work.createEventRecord({organization_id:orgId,type:'phone.personal.updated',idempotency_key:'phone-pending',payload:{resource_id:'manager'}});
 const {drainPhoneEvents}=await import('../comms/phone/events.js');
 assert.ok(await drainPhoneEvents()>0);
 assert.equal((await work.readEventRecord(orgId,String(phone.event!.id)))?.status,'completed');
 assert.equal((await work.readEventRecord(orgId,String(unrelated.event!.id)))?.status,'pending');
});
