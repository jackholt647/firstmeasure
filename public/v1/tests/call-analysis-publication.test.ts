import assert from 'node:assert/strict';
import test,{before,after} from 'node:test';
import {mkdtemp,rm} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type {PlatformAuthContext} from '../platform/auth.js';
import type {SourceRef,ActionRef} from '../platform/publication/contracts.js';
let root:string,auth:PlatformAuthContext;
let platform:typeof import('../platform/storage.js'),store:typeof import('../comms/calls/storage.js'),analysis:typeof import('../comms/calls/analysis.js'),actions:typeof import('../platform/publication/actions.js'),providers:typeof import('../platform/publication/providers.js'),context:typeof import('../platform/publication/context.js');
const org='analysis-publication-test';
const ctx=()=>context.userPublicationContext(auth,{executionKind:'agent',mode:'command'});
const source=(id:string):SourceRef=>({provider:'customer-call-analysis',export:'notes',target:{scope:'organization',organizationId:org,id}});
const action=(id:string,kind='generate'):ActionRef=>({action:`customer-calls.analysis.${kind}`,version:'1',target:{scope:'organization',organizationId:org,id}});
before(async()=>{
  root=await mkdtemp(path.join(os.tmpdir(),'call-analysis-publication-'));
  Object.assign(process.env,{NODE_ENV:'test',PLATFORM_STORAGE_ROOT:path.join(root,'platform'),MESSAGING_STORAGE_ROOT:path.join(root,'messaging'),WORKFORCE_STORAGE_ROOT:path.join(root,'workforce'),PLATFORM_HEARTBEAT_DISABLED:'1',WORK_SCHEDULER_DISABLED:'1'});
  platform=await import('../platform/storage.js');await import('../platform/capability_defs.js');await import('../chat/capabilities.js');await import('../comms/capabilities.js');
  await platform.createOrganization({id:org});const identity=await platform.createIdentity({email:'analysis-publication@test.invalid',name:'Manager'});
  await platform.addIdentityMembership(String(identity.id),org,'manager','owner');
  await platform.upsertDocument(org,'users',{id:'manager',data:{identity_id:identity.id,status:'active',org_permissions:{level:'owner',items:{}},scoped_access_assignments:[{scope:{kind:'department',id:'production'},permissions:{analyze_call_recordings:false}}]}});
  const {departmentCatalogSchema}=await import('../workforce/department-contracts.js');
  await platform.upsertDocument(org,'organization_departments',{id:'catalog',data:departmentCatalogSchema.parse({departments:[{id:'sales',label:'Sales'},{id:'production',label:'Production'}],groups:[]})});
  await (await import('./helpers/platform-fixture.js')).enableExpandedPlatformFixture(org);
  auth=await (await import('../platform/auth.js')).backgroundAuthContext(org,'manager');
  store=await import('../comms/calls/storage.js');analysis=await import('../comms/calls/analysis.js');actions=await import('../platform/publication/actions.js');providers=await import('../platform/publication/providers.js');context=await import('../platform/publication/context.js');
  (await import('../comms/calls/analysis-publication.js')).registerCallAnalysisPublication();
  for(const dept of ['sales','production']){
    await store.insertCall({id:dept,organization_id:org,branch_id:'default',owner_user_id:'manager',mode:'browser',direction:'outbound',state:'ended',metadata:{department_ids:[dept]}});
    await store.saveArtifact(org,dept,'transcript',dept,{text:`Confidential ${dept} transcript.`});
  }
});
after(async()=>{
  await actions.closeActionDatabase();await (await import('../agents/analysis-store.js')).closeAnalysisStore();await (await import('../platform/publication/bindings.js')).closeBindingStoreForTests();
  await (await import('../messaging/communications_storage.js')).closeCommunicationsDatabase();await (await import('../platform/sql_store.js')).closeSqlStores();await rm(root,{recursive:true,force:true});
});
test('analysis publications are bundled and actual department denial blocks action',async()=>{
  const bundles=await import('../platform/publication/permission-bundles.js');
  assert.equal(bundles.publishedActionPermission('customer-calls.analysis.generate'),'analyze_call_recordings');
  assert.equal(bundles.publishedActionPermission('customer-calls.analysis.ask'),'analyze_call_recordings');
  await assert.rejects(()=>actions.invokeAction(ctx(),action('production'),{}, {idempotencyKey:'denied-dept'}),/cannot create AI notes/);
  assert.equal((await providers.readPublishedData(ctx(),source('production'))).status,'ready');
});
test('action receipts hold only references and replay freshly checks permission',async()=>{
  const first=await actions.invokeAction(ctx(),action('sales','ask'),{question:'What happened?'},{idempotencyKey:'question'});
  assert.deepEqual(Object.keys(first.value as object),['analysis_id']);
  assert.doesNotMatch(JSON.stringify(first),/Confidential|transcript\.|What happened/);
  const again=await actions.invokeAction(ctx(),action('sales','ask'),{question:'What happened?'},{idempotencyKey:'question'});
  assert.equal(again.receipt.replayed,true);assert.deepEqual(again.value,first.value);
  const user=await platform.readDocument(org,'users','manager');
  await platform.upsertDocument(org,'users',{id:'manager',data:{...user.data,org_permissions:{level:'owner',items:{analyze_call_recordings:false}}}},{replace:true});
  try{await assert.rejects(()=>actions.invokeAction(ctx(),action('sales','ask'),{question:'What happened?'},{idempotencyKey:'question'}),/cannot create AI notes/);}
  finally{await platform.upsertDocument(org,'users',{id:'manager',data:user.data},{replace:true});}
});
test('frozen AI results are denied after source transcript deletion',async()=>{
  const generated=await actions.invokeAction(ctx(),action('sales'),{},{idempotencyKey:'frozen'});
  const id=(generated.value as {analysis_id:string}).analysis_id;
  await analysis.processCallAnalysisJob(await store.readCall(org,'sales'),{actor_user_id:'manager',analysis_id:id},{runner:async()=>({text:'Confidential generated notes.',model:'test'})});
  const agentRead=await providers.readPublishedData(ctx(),source('sales'));
  assert.equal(agentRead.status,'ready');assert.doesNotMatch(JSON.stringify(agentRead),/Confidential generated|What happened|Write concise factual/);
  if(agentRead.status==='ready'){const value=agentRead.value as any;assert.equal(value.call_id,'sales');assert.equal(value.notes.find((note:any)=>note.id===id).state,'ready');assert.equal(value.notes.find((note:any)=>note.id===id).text,'');}
  const apiContext=context.userPublicationContext(auth,{executionKind:'api'});
  const apiRead=await providers.readPublishedData(apiContext,source('sales'));assert.equal(apiRead.status,'ready');assert.match(JSON.stringify(apiRead),/Confidential generated notes/);
  const binding={kind:'data' as const,policy:'frozen' as const,source:source('sales')};
  const bindings=await import('../platform/publication/bindings.js');
  const captured=await bindings.resolveDataBinding(apiContext,'consumer','notes',binding);assert.equal(captured.status,'ready');
  await assert.rejects(()=>bindings.resolveDataBinding(ctx(),'consumer','notes',binding),/authorized call interface/);
  await store.database().prepare("UPDATE customer_call_artifacts SET state='deleted' WHERE organization_id=? AND call_id=?").run(org,'sales');
  await assert.rejects(()=>bindings.resolveDataBinding(apiContext,'consumer','notes',binding),/no longer available/);
  const current=await providers.readPublishedData(ctx(),source('sales'));assert.equal(current.status,'ready');if(current.status==='ready')assert.deepEqual((current.value as any).notes,[]);
});
