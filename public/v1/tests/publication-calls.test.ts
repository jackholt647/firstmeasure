import assert from 'node:assert/strict';
import test,{before,after} from 'node:test';
import {mkdtemp,rm} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type {PlatformAuthContext} from '../platform/auth.js';
import type {SourceRef} from '../platform/publication/contracts.js';
let root:string,store:typeof import('../comms/calls/storage.js'),providers:typeof import('../platform/publication/providers.js'),context:typeof import('../platform/publication/context.js');
const orgId='call-publication-fixture';
function principal(permissions:Record<string,boolean>={'*':true}):PlatformAuthContext{return {orgId,userId:'manager',branchId:'default',role:'member',permissions,identity:{},organization:{},user:{},applicationAccess:{management:{enabled:true,permissions:{}}}} as unknown as PlatformAuthContext;}
const ctx=(auth=principal(),projectId?:string)=>context.userPublicationContext(auth,{executionKind:'agent',projectId});
const source=(kind='record',id?:string,projectId?:string,args?:Record<string,unknown>):SourceRef=>({provider:'customer-calls',export:kind,target:{scope:projectId?'project':'organization',organizationId:orgId,...(id?{id}:{}),...(projectId?{projectId}:{})},...(args?{args}:{})});
before(async()=>{
  root=await mkdtemp(path.join(os.tmpdir(),'publication-calls-'));
  Object.assign(process.env,{NODE_ENV:'test',PLATFORM_STORAGE_ROOT:path.join(root,'platform'),MESSAGING_STORAGE_ROOT:path.join(root,'messaging'),PLATFORM_HEARTBEAT_DISABLED:'1',WORK_SCHEDULER_DISABLED:'1'});
  const storage=await import('../platform/storage.js');await import('../platform/capability_defs.js');
  await import('../chat/capabilities.js');await import('../comms/capabilities.js');
  await storage.createOrganization({id:orgId});
  const identity=await storage.createIdentity({email:'call-manager@publication.test',name:'Call Manager'});
  await storage.addIdentityMembership(String(identity.id),orgId,'manager','owner');
  await storage.upsertDocument(orgId,'users',{id:'manager',data:{identity_id:identity.id,status:'active',org_permissions:{level:'owner',items:{}}}});
  await (await import('./helpers/platform-fixture.js')).enableExpandedPlatformFixture(orgId);
  await storage.upsertDocument(orgId,'projects',{id:'project-a',data:{name:'A',branch_id:'default'}});
  await storage.upsertDocument(orgId,'projects',{id:'project-b',data:{name:'B',branch_id:'east'}});
  store=await import('../comms/calls/storage.js');providers=await import('../platform/publication/providers.js');context=await import('../platform/publication/context.js');
  (await import('../comms/calls/publication.js')).registerCallPublication();
  for(const [id,project,owner,contact,branch] of [['call-a','project-a','manager','contact-a','default'],['call-b','project-a','other','contact-b','default'],['call-c','project-b','other','contact-a','east'],['diagnostic','','manager','','default']] as const){
    await store.insertCall({id,organization_id:orgId,branch_id:branch,project_id:project,contact_id:contact,owner_user_id:owner,mode:id==='diagnostic'?'diagnostic':'browser',direction:'outbound',state:'ended',notes:`Notes ${id}`,connected_at:'2026-10-01T12:00:00.000Z',ended_at:'2026-10-01T12:01:00.000Z',
      result:{disposition:'answered',next_action:'none',private_provider_token:'secret'},metadata:{purpose:'Follow up',device_id:'private-device',conference_id:'private-conference',policy:{recording_enabled:true,transcription_enabled:true},script_answers:{0:'Yes'},capture:{state:'stopped'}}});
    await store.patchCall(orgId,id,{notes:`Notes ${id}`,connected_at:'2026-10-01T12:00:00.000Z',ended_at:'2026-10-01T12:01:00.000Z',result:{disposition:'answered',next_action:'none',private_provider_token:'secret'}});
  }
  await store.saveArtifact(orgId,'call-a','transcript','transcript-a',{text:'Customer wants an estimate.',recording_id:'private-provider',download_url:'secret-url'});
  await store.saveArtifact(orgId,'call-a','recording','recording-a',{file_path:'private-path',provider_urls:['secret-url']});
  await store.saveArtifact(orgId,'call-a','transcript','expired',{text:'Expired private content'},'ready',-1);
});
after(async()=>{
  await (await import('../platform/publication/actions.js')).closeActionDatabase();
  await (await import('../platform/publication/bindings.js')).closeBindingStoreForTests();
  await (await import('../messaging/communications_storage.js')).closeCommunicationsDatabase();
  await (await import('../platform/sql_store.js')).closeSqlStores();
  await rm(root,{recursive:true,force:true});
});
test('calls publish typed details and safe retained transcripts without mutating domain records',async()=>{
  const before=await store.readCall(orgId,'call-a');
  const read=await providers.readPublishedData(ctx(),source('record','call-a'));
  assert.equal(read.status,'ready',JSON.stringify(read));if(read.status!=='ready')return;
  assert.equal((read.value as any).notes,'Notes call-a');assert.equal((read.value as any).duration_seconds,60);
  assert.equal((read.value as any).result.disposition,'answered');assert.deepEqual((read.value as any).script.answers,{0:'Yes'});
  assert.doesNotMatch(JSON.stringify(read.value),/private|secret|conference_id|device_id/);
  const transcript=await providers.readPublishedData(ctx(),source('transcripts','call-a'));
  assert.equal(transcript.status,'ready',JSON.stringify(transcript));if(transcript.status==='ready'){
    assert.equal((transcript.value as any).artifacts.length,1);assert.equal((transcript.value as any).artifacts[0].text,'Customer wants an estimate.');
    assert.doesNotMatch(JSON.stringify(transcript.value),/private|secret|Expired/);
  }
  const recording=await providers.readPublishedData(ctx(),source('recordings','call-a'));
  assert.equal(recording.status,'ready');if(recording.status==='ready')assert.match((recording.value as any).artifacts[0].media_url,/\/v1\/comms\/organizations\/call-publication-fixture\/calls\/call-a\/artifacts\/.+\/media$/);
  assert.deepEqual(await store.readCall(orgId,'call-a'),before);
  assert.equal((await providers.readPublishedData(ctx(),source('record','missing'))).status,'missing');
});
test('call lists filter recent history by user, contact, project and date with bound keyset cursors',async()=>{
  const first=await providers.listPublishedData(ctx(),source(),{limit:1});assert.equal(first.status,'ready');if(first.status!=='ready')return;
  assert.ok(first.nextCursor);
  const second=await providers.listPublishedData(ctx(),source(),{limit:1,cursor:first.nextCursor});assert.equal(second.status,'ready');if(second.status==='ready')assert.notEqual((second.items[0] as any).id,(first.items[0] as any).id);
  assert.equal((await providers.listPublishedData(ctx(),source('record',undefined,undefined,{contact_id:'contact-a'}),{cursor:first.nextCursor})).status,'error');
  for(const [args,expected] of [[{owner_user_id:'manager'},['call-a']],[{contact_id:'contact-b'},['call-b']],[{project_id:'project-b'},['call-c']],[{created_before:'2000-01-01T00:00:00Z'},[]]] as const){
    const result=await providers.listPublishedData(ctx(),source('record',undefined,undefined,args));assert.equal(result.status,'ready',JSON.stringify(result));if(result.status==='ready')assert.deepEqual(result.items.map((i:any)=>i.id),expected);
  }
  const transcripts=await providers.listPublishedData(ctx(),source('transcripts',undefined,undefined,{contact_id:'contact-a'}));assert.equal(transcripts.status,'ready');if(transcripts.status==='ready')assert.equal(transcripts.items.length,2);
  assert.equal((await providers.listPublishedData(ctx(),source('record',undefined,undefined,{created_after:'yesterday'}))).status,'error');
});
test('tenant, branch, project and recording permissions apply to publication and frozen replay',async()=>{
  const viewer=principal({view_comms:true});
  assert.equal((await providers.readPublishedData(ctx(viewer),source('record','call-a'))).status,'ready');
  assert.equal((await providers.readPublishedData(ctx(viewer),source('record','call-c'))).status,'denied');
  assert.equal((await providers.readPublishedData(ctx(viewer),source('transcripts','call-a'))).status,'denied');
  const listed=await providers.listPublishedData(ctx(viewer),source());assert.equal(listed.status,'ready');if(listed.status==='ready')assert.equal(listed.items.length,2);
  assert.equal((await providers.readPublishedData(ctx(principal(),'project-a'),source('record','call-c'))).status,'denied');
  assert.equal((await providers.listPublishedData(ctx(principal(),'project-a'),source('record',undefined,undefined,{project_id:'project-b'}))).status,'denied');
  assert.equal((await providers.readPublishedData(ctx(),{...source('record','call-a'),target:{scope:'organization',organizationId:'other',id:'call-a'}})).status,'denied');
  const denied=principal({'*':true,view_call_recordings:false});assert.equal((await providers.readPublishedData(ctx(denied),source('transcripts','call-a'))).status,'denied');
  const bindings=await import('../platform/publication/bindings.js');
  const binding={kind:'data' as const,policy:'frozen' as const,source:{...source('transcripts','call-a'),path:'/artifacts/0/text'}};
  const captured=await bindings.resolveDataBinding(ctx(),'call-consumer','transcript',binding);assert.equal(captured.status,'ready',JSON.stringify(captured));
  const id=store.id('ca',`${orgId}:transcript:transcript-a`);await store.database().prepare("UPDATE customer_call_artifacts SET state='deleted' WHERE organization_id=? AND id=?").run(orgId,id);
  await assert.rejects(bindings.resolveDataBinding(ctx(),'call-consumer','transcript',binding),/removed or expired/);
});
test('the shared assistant discovers call exports and reads filtered transcripts through the platform tools',async()=>{
  await store.saveArtifact(orgId,'call-b','transcript','agent-transcript',{text:'Follow up next Tuesday.'});
  const {platformAgentTools}=await import('../agents/platform_tools.js');
  const auth=await (await import('../platform/auth.js')).backgroundAuthContext(orgId,'manager');
  const run={agentId:'assistant',orgId,branchId:'default',userId:'manager',ctx:auth,settings:{},scratch:{}} as any;
  const tool=(name:string)=>platformAgentTools.find(item=>item.name===name)!;
  const found=await tool('platform_search').execute(run,{query:'customer-calls',kind:'data'});
  assert.deepEqual((found.matches as any[]).map(item=>item.id).sort(),['customer-calls.record','customer-calls.recordings','customer-calls.transcripts']);
  const described=await tool('platform_describe').execute(run,{id:'customer-calls.transcripts'});assert.equal(described.available,true);
  const history=await tool('platform_list').execute(run,{source:source('transcripts',undefined,undefined,{owner_user_id:'other',contact_id:'contact-b'}),limit:3});
  assert.equal(history.status,'ready',JSON.stringify(history));assert.equal((history.items as any[]).length,1);
  assert.equal((history.items as any[])[0].artifacts[0].text,'Follow up next Tuesday.');
  run.settings.data_scope={projects:false};
  await assert.rejects(async()=>tool('platform_read').execute(run,{source:source('record','call-b')}),{code:'agent_data_denied'});
  const storage=await import('../platform/storage.js');const user=await storage.readDocument(orgId,'users','manager');
  await storage.upsertDocument(orgId,'users',{id:'manager',data:{...user.data,org_permissions:{level:'owner',items:{view_call_recordings:false}}}},{replace:true});
  run.settings.data_scope={};
  const revoked=await tool('platform_read').execute(run,{source:source('transcripts','call-b')});assert.equal(revoked.status,'denied');
});

test('frozen transcripts recheck recording permission on their captured department',async()=>{
  const auth=principal({view_comms:true});
  auth.organizationStructure={catalog:{departments:[{id:'sales',label:'Sales'},{id:'production',label:'Production'}],divisions:[]},users:[]};
  auth.scopedAccessGrants=[{scope:{kind:'department',id:'sales'},permissions:{view_call_recordings:true}}];
  const call=await store.readCall(orgId,'call-b');await store.patchCall(orgId,call.id,{metadata:{...call.metadata,department_ids:['sales']}});
  const bindings=await import('../platform/publication/bindings.js');
  const binding={kind:'data' as const,policy:'frozen' as const,source:source('transcripts','call-b')};
  const captured=await bindings.resolveDataBinding(ctx(auth),'department-consumer','media',binding);assert.equal(captured.status,'ready');
  auth.scopedAccessGrants=[{scope:{kind:'department',id:'production'},permissions:{view_call_recordings:true}}];
  await assert.rejects(bindings.resolveDataBinding(ctx(auth),'department-consumer','media',binding),/no longer have access/);
});
