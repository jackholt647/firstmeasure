import test,{before,after} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
let root:string,p:typeof import('../comms/phone/reputation-product.js'),s:typeof import('../comms/calls/storage.js'),env:any,TelnyxError:any;
let status:any=null,requests:any[]=[],registered:any={},counter=0;
const auth=(org='rep-org',permissions:any={'*':true})=>({orgId:org,userId:'owner',branchId:'default',role:'member',permissions,identity:{},organization:{},user:{},applicationAccess:{management:{enabled:true,permissions:{}}}} as any);
const contact={first_name:'Jane',last_name:'Example',email:'jane@example.test',phone_number:'+12025550100'};
const address={street_address:'100 Test St',city:'Seattle',administrative_area:'WA',postal_code:'98101',country:'US'};
const profile={legal_name:'Example Business LLC',doing_business_as:'Example Business',organization_type:'commercial',organization_legal_type:'llc',country_code:'US',jurisdiction_of_incorporation:'Washington',website:'https://example.test',industry:'business',number_of_employees:'1-10',organization_contact:{...contact,job_title:'Owner'},billing_contact:contact,organization_physical_address:address,billing_address:address};
before(async()=>{
 root=await mkdtemp(path.join(os.tmpdir(),'reputation-onboarding-'));
 Object.assign(process.env,{NODE_ENV:'test',FIRSTMATE_ENV:'test',PLATFORM_STORAGE_ROOT:path.join(root,'platform'),MESSAGING_STORAGE_ROOT:path.join(root,'messaging'),TELNYX_API_KEY:'test-no-network',CUSTOMER_CALL_WORKER_DISABLED:'1',PLATFORM_HEARTBEAT_DISABLED:'1',WORK_SCHEDULER_DISABLED:'1',FIRSTMEASURE_JOB_WORKERS:'0'});
 if(process.env.TEST_POSTGRES_URL)Object.assign(process.env,{FIRSTMEASURE_DATABASE_MODE:'postgres',DATABASE_URL:process.env.TEST_POSTGRES_URL,POSTGRES_AUTO_MIGRATE:'false'});
 ({env}=await import('../src/config/env.js'));({TelnyxError}=await import('../messaging/telnyx.js'));env.dataEnvironment='production';
 const adapter=await import('../telephony/telnyx.js');
 class Carrier extends adapter.TelnyxVoiceClient{
 override async request(url:string,method='GET',body:any={}){requests.push({url,method,body});
 if(url==='/enterprises'&&method==='POST'){const id='enterprise-'+(++counter);registered[id]={...body,id};return {data:registered[id]};}
 if(url==='/documents')return {data:{id:'document-1'}};
 if(url.endsWith('/reputation')&&method==='DELETE'){status=null;return {data:{}};}
 if(url.endsWith('/reputation')&&method==='POST'){status={status:'pending',loa_status:'pending',...body};return {data:status};}
 if(url.endsWith('/loa')&&method==='PATCH'){status={...status,loa_status:'pending',...body};return {data:status};}
 if(url.endsWith('/reputation')&&method==='GET'){if(!status)throw new TelnyxError('Not found',404);return {data:status};}
 if(url.includes('/remediation/'))return {data:{id:'review-1',status:'completed',results:{remediated:['+12025550100'],requires_review:[]}}};
 if(url.endsWith('/remediation'))return {data:{id:'review-1',status:'pending',created_at:new Date().toISOString()}};
 if(url.startsWith('/enterprises/')&&method==='PUT')return {data:body};
 throw Error('Unexpected carrier request '+url);
 }
 override async pdf(url:string,body:any={}){requests.push({url,method:'PDF',body});return Buffer.from('%PDF-1.7\nfixture '+JSON.stringify(body));}
 }
 adapter.setVoiceClientFactoryForTests(()=>new Carrier());
 p=await import('../comms/phone/reputation-product.js');s=await import('../comms/calls/storage.js');
});
after(async()=>{(await import('../telephony/telnyx.js')).setVoiceClientFactoryForTests(null);await(await import('../messaging/communications_storage.js')).closeCommunicationsDatabase();await(await import('../platform/sql_store.js')).closeSqlStoresForTests();await(await import('../src/database/postgres.js')).closePostgresPools();if(path.dirname(root)===os.tmpdir())await rm(root,{recursive:true,force:true,maxRetries:5,retryDelay:100});});
test('draft validates business information, permissions and optimistic revisions without carrier calls',async()=>{
 await assert.rejects(p.saveBusiness(auth('denied',{}),{revision:0,profile}),{code:'phone_settings_denied'});
 await assert.rejects(p.saveBusiness(auth(),{revision:0,profile:{...profile,website:'javascript:alert(1)'}}));
 const draft=await p.saveBusiness(auth(),{revision:0,profile});assert.equal(draft.revision,1);assert.equal(requests.length,0);
 await assert.rejects(p.saveBusiness(auth(),{revision:0,profile}),{code:'settings_revision_conflict'});
});
test('registration creates a tenant-bound enterprise without persisting the EIN',async()=>{
 await p.registerBusiness(auth(),{operation_id:'register-request-1',revision:1,fein:'12-3456789'});
 assert.equal(await p.enterpriseId('rep-org'),'enterprise-1');assert.equal(await p.enterpriseId('other-org'),'');
 const persisted=await s.database().prepare('SELECT data_json FROM customer_voice_resources WHERE organization_id=?').all('rep-org');assert.doesNotMatch(JSON.stringify(persisted),/12-3456789/);
 await assert.rejects(p.registerBusiness(auth(),{operation_id:'register-request-1',revision:1,fein:'12-3456789'}),{code:'reputation_already_registered'});
 assert.equal(requests.filter(r=>r.url==='/enterprises').length,1);
});
test('authorization requires current document review and explicit consent; signing uses the Telnyx template',async()=>{
 const pdf=await p.renderAuthorization(auth());assert.match(pdf.file.toString(),/^%PDF/);
 await assert.rejects(p.renderAuthorization(auth(),{loa_version:'old',signer_name:'Jane',signature:'test'}),{code:'reputation_loa_stale'});
 const signed=await p.renderAuthorization(auth(),{loa_version:pdf.version,signer_name:'Jane',signature:Buffer.from([137,80,78,71,13,10,26,10]).toString('base64')});assert.equal(signed.version,pdf.version);
 const input={operation_id:'authorization-1',loa_version:pdf.version,signer_name:'Jane',authorized:true,terms_accepted:true,file:signed.file.toString('base64')};
 await assert.rejects(p.submitAuthorization(auth(),{...input,authorized:false}));
 await p.submitAuthorization(auth(),input);assert.equal(status.check_frequency,'never');assert.equal((await p.account('rep-org'))?.status,'pending');
 const serialized=JSON.stringify(await s.resources('rep-org','phone_reputation_account'));assert.doesNotMatch(serialized,/%PDF|JVBER/);
 status={...status,status:'approved',loa_status:'approved'};
 await assert.rejects(p.submitAuthorization(auth(),input),{code:'reputation_loa_locked'});
});
test('remediation checks ownership and approval, persists results, and refreshes asynchronously',async()=>{
 await assert.rejects(p.remediation(auth(),{operation_id:'review-denied-1',phone_numbers:['+12025550199'],call_purpose:'Requested appointment follow-ups',confirmed:true}),{code:'reputation_number_missing'});
 await s.saveResource('rep-org','number','+12025550100',{status:'active'});await s.saveResource('rep-org','phone_reputation_number','+12025550100',{monitored:true});
 await p.remediation(auth(),{operation_id:'review-request-1',phone_numbers:['+12025550100'],call_purpose:'Requested appointment follow-ups',confirmed:true});
 await p.refreshProduct('rep-org');assert.equal((await s.resource('rep-org','phone_reputation_remediation','review-1'))?.status,'completed');
});
test('durable attempts deduplicate completed work and block automatic retry after unknown outcomes',async()=>{
 let calls=0;const run=async()=>{calls++;return {saved:true};};await p.operation('ops','request-0001','check',{},'owner',run);await p.operation('ops','request-0001','check',{},'owner',run);assert.equal(calls,1);
 await assert.rejects(p.operation('ops','request-0001','check',{different:true},'owner',run),{code:'reputation_operation_conflict'});
 await assert.rejects(p.operation('ops','request-0002','check',{},'owner',async()=>{throw new TelnyxError('Timeout',502,{submission_unknown:true});}));
 await assert.rejects(p.operation('ops','request-0003','check',{},'owner',run),{code:'reputation_operation_pending'});assert.equal(calls,1);
});
test('rejected business corrections reset authorization without enabling carrier services',async()=>{
 status={...status,status:'rejected',loa_status:'approved'};
 const before=requests.filter(r=>r.url.endsWith('/reputation')&&r.method==='POST').length;
 await p.correctBusiness(auth(),{operation_id:'correct-business-1',profile:{...profile,legal_name:'Corrected Example LLC'},fein:'12-3456789',confirmed:true});
 assert.equal((await p.account('rep-org'))?.loa_version,'');assert.equal((await p.account('rep-org'))?.signed_at,'');assert.equal(status,null);
 assert.equal(requests.filter(r=>r.url.endsWith('/reputation')&&r.method==='POST').length,before);
});
test('partial carrier changes remain locked even when the next step is rejected',async()=>{
 await assert.rejects(p.operation('partial','partial-request-1','correct',{},'owner',async()=>{const op=await s.resource('partial','phone_reputation_operation','partial-request-1');await s.saveResource('partial','phone_reputation_operation','partial-request-1',{...op,provider_effect:true});throw new TelnyxError('Rejected after reset',422);}));
 assert.equal((await s.resource('partial','phone_reputation_operation','partial-request-1'))?.state,'uncertain');assert.equal((await p.account('partial'))?.busy,'partial-request-1');
});
test('development prohibits carrier onboarding and no subscription or billing record is created',async()=>{
 const count=requests.length;env.dataEnvironment='development';
 await p.saveBusiness(auth('dev-draft'),{revision:0,profile});
 await assert.rejects(p.registerBusiness(auth('dev-draft'),{operation_id:'dev-registration',revision:1,fein:'12-3456789'}),{code:'reputation_development_read_only'});
 await assert.rejects(p.renderAuthorization(auth()),{code:'reputation_development_read_only'});assert.equal(requests.length,count);
 env.dataEnvironment='production';const billing=await import('../platform-billing/storage.js');assert.deepEqual(await billing.records('rep-org','subscription'),[]);await billing.closeBillingStore();
});
test('disabling monitoring retains telephone service and requires a new authorization',async()=>{
 await p.disableReputation(auth(),'disable-request-1');assert.ok((await p.account('rep-org'))?.disabled_at);assert.equal((await p.account('rep-org'))?.loa_version,'');assert.equal((await s.resource('rep-org','number','+12025550100'))?.status,'active');
});
