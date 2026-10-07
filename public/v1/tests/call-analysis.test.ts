import assert from 'node:assert/strict';
import test,{before,after} from 'node:test';
import {mkdtemp,rm} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type {PlatformAuthContext} from '../platform/auth.js';
let root:string,store:typeof import('../comms/calls/storage.js'),analysis:typeof import('../comms/calls/analysis.js'),core:typeof import('../agents/analysis.js'),results:typeof import('../agents/analysis-store.js');
const org='analysis-tests';let ctx:PlatformAuthContext;
before(async()=>{
  root=await mkdtemp(path.join(os.tmpdir(),'call-analysis-'));
  Object.assign(process.env,{NODE_ENV:'test',OPENAI_API_KEY:'test-key-not-a-real-credential',PLATFORM_STORAGE_ROOT:path.join(root,'platform'),MESSAGING_STORAGE_ROOT:path.join(root,'messaging'),PLATFORM_HEARTBEAT_DISABLED:'1',WORK_SCHEDULER_DISABLED:'1'});
  const platform=await import('../platform/storage.js');await import('../platform/capability_defs.js');await import('../chat/capabilities.js');await import('../comms/capabilities.js');
  await platform.createOrganization({id:org});
  const identity=await platform.createIdentity({email:'analysis-owner@test.invalid',name:'Owner'});
  await platform.addIdentityMembership(String(identity.id),org,'owner','owner');
  await platform.upsertDocument(org,'users',{id:'owner',data:{identity_id:identity.id,status:'active',org_permissions:{level:'owner',items:{}}}});
  await (await import('./helpers/platform-fixture.js')).enableExpandedPlatformFixture(org);
  ctx=await (await import('../platform/auth.js')).backgroundAuthContext(org,'owner');
  store=await import('../comms/calls/storage.js');analysis=await import('../comms/calls/analysis.js');core=await import('../agents/analysis.js');results=await import('../agents/analysis-store.js');
});
after(async()=>{
  await results.closeAnalysisStore();await (await import('../agents/storage.js')).closeAgentsDatabase();
  await (await import('../messaging/communications_storage.js')).closeCommunicationsDatabase();await (await import('../platform/sql_store.js')).closeSqlStores();await rm(root,{recursive:true,force:true});
});
async function fixture(id:string){
  await store.insertCall({id,organization_id:org,branch_id:'default',project_id:'',owner_user_id:'owner',mode:'browser',direction:'outbound',state:'ended',metadata:{}});
  await store.patchCall(org,id,{notes:'Human notes must remain unchanged.'});
  const transcript=await store.saveArtifact(org,id,'transcript',id,{text:'Customer requested a Tuesday visit. Agent will call to confirm.'});
  return {call:await store.readCall(org,id),transcript};
}
test('queued analysis is idempotent, uses retained transcript, and preserves human notes',async()=>{
  const {call,transcript}=await fixture('call-notes');let runs=0;
  const first=await analysis.generateCallAnalysis(ctx,call.id,{operation_id:'summary-1',system_prompt:'Summarize action items.'});
  assert.equal(first.note.state,'pending');
  assert.equal((await analysis.generateCallAnalysis(ctx,call.id,{operation_id:'summary-1',system_prompt:'Summarize action items.'})).note.id,first.note.id);
  await assert.rejects(()=>analysis.generateCallAnalysis(ctx,call.id,{operation_id:'summary-1',question:'Different input'}),/different analysis/);
  const runner:import('../agents/analysis.js').AnalysisRunner=async input=>{runs++;assert.match(input.content,/Tuesday/);assert.equal(input.prompt,'Summarize action items.');return {text:`Confirm the Tuesday visit [${transcript}].`,model:'test-model'};};
  const payload={actor_user_id:'owner',analysis_id:first.note.id};
  await Promise.all([analysis.processCallAnalysisJob(call,payload,{runner}),analysis.processCallAnalysisJob(call,payload,{runner})]);
  assert.equal(runs,1);
  const read=await analysis.readCallAnalysis(ctx,call.id);assert.equal(read.notes[0]?.state,'ready');assert.equal(read.notes[0]?.model,'test-model');
  assert.deepEqual(read.notes[0]?.citations.map(c=>c.id),[transcript]);assert.equal((await store.readCall(org,call.id)).notes,'Human notes must remain unchanged.');
  const messages=await (await import('../agents/storage.js')).getAgentsDatabase().prepare('SELECT count(*) AS count FROM agent_messages').get();assert.equal(Number(messages?.count),0);
});
test('questions use source grounding and source deletion revokes all stored answers',async()=>{
  const {call,transcript}=await fixture('call-question');
  const pending=await analysis.generateCallAnalysis(ctx,call.id,{operation_id:'ask-1',question:'When is the visit?'});
  await analysis.processCallAnalysisJob(call,{actor_user_id:'owner',analysis_id:pending.note.id},{runner:async input=>{assert.match(input.content,/When is the visit/);return {text:'Tuesday.',model:'test'};}});
  assert.equal((await analysis.readCallAnalysis(ctx,call.id)).notes[0]?.kind,'answer');
  await store.database().prepare("UPDATE customer_call_artifacts SET state='deleted' WHERE id=?").run(transcript);
  assert.deepEqual(await analysis.readCallAnalysis(ctx,call.id),{notes:[],available:false});
  await analysis.revokeCallAnalyses(org,call.id);assert.equal(await results.readAnalysis(org,pending.note.id),null);
});
test('source access is rechecked after generation and unavailable text is never committed',async()=>{
  const {call,transcript}=await fixture('call-revoked');
  const pending=await analysis.generateCallAnalysis(ctx,call.id,{operation_id:'revoke-1'});
  const outcome=await analysis.processCallAnalysisJob(call,{actor_user_id:'owner',analysis_id:pending.note.id},{runner:async()=>{
    await store.database().prepare("UPDATE customer_call_artifacts SET expires_at=? WHERE id=?").run('2000-01-01T00:00:00.000Z',transcript);
    return {text:'Sensitive generated content',model:'test'};
  }});
  assert.equal(outcome.state,'failed');assert.equal((await results.readAnalysis(org,pending.note.id))?.text,'');
});
test('worker failure is terminal for the request and never automatically repeats model cost',async()=>{
  const {call}=await fixture('call-failed');let runs=0;
  const pending=await analysis.generateCallAnalysis(ctx,call.id,{operation_id:'failed-1'});
  const options={runner:async()=>{runs++;throw Error('provider secret detail');}};
  const payload={actor_user_id:'owner',analysis_id:pending.note.id};
  await analysis.processCallAnalysisJob(call,payload,options);await analysis.processCallAnalysisJob(call,payload,options);
  assert.equal(runs,1);const note=(await analysis.readCallAnalysis(ctx,call.id)).notes[0];assert.equal(note?.state,'failed');assert.doesNotMatch(note?.error||'',/secret/);
});
test('long documents chunk and reduce using bounded source adapters with provenance',async()=>{
  const source={provider:'test-documents',id:'doc',revision:'v1',expiresAt:'2999-01-01T00:00:00.000Z',parts:[{id:'part-1',label:'Document',text:'a'.repeat(24001)}]};
  let loads=0,runs=0;const prompts:string[]=[];
  const output=await core.analyzeSource(ctx,{load:async()=>{loads++;return source;}},'doc',{question:'What happened?',runner:async input=>{runs++;prompts.push(input.content);return {text:'Grounded answer [part-1]',model:'test'};}});
  assert.equal(runs,3);assert.ok(loads>=5);assert.match(prompts[2]!,/Combine these partial extracts/);assert.deepEqual(output.citations,[{id:'part-1',label:'Document'}]);
  assert.throws(()=>core.analysisChunks({...source,parts:[{...source.parts[0]!,text:'x'.repeat(240001)}]}),/240,000/);
  const streaming=core.analysisChunks({...source,parts:Array.from({length:300},(_,i)=>({id:`utterance-${i}`,label:'Transcript',text:'Customer asks a short question.'}))});
  assert.ok(streaming.length<3);assert.match(streaming.join(''),/utterance-299/);assert.ok(streaming.every(chunk=>chunk.length<=24000));
});
test('partial transcription events are excluded and source updates invalidate prior notes',async()=>{
  const {call}=await fixture('call-partial');
  await store.saveArtifact(org,call.id,'transcript','partial',{text:'Do not analyze incomplete words',final:false});
  const source=await analysis.callTranscriptAdapter.load(ctx,call.id);assert.equal(source.parts.length,1);
  const pending=await analysis.generateCallAnalysis(ctx,call.id,{operation_id:'source-update'});
  await analysis.processCallAnalysisJob(call,{actor_user_id:'owner',analysis_id:pending.note.id},{runner:async()=>({text:'Ready notes',model:'test'})});
  await store.saveArtifact(org,call.id,'transcript','new-final',{text:'Additional final evidence.',final:true});
  assert.deepEqual((await analysis.readCallAnalysis(ctx,call.id)).notes,[]);
});
test('untrusted generic agent requests cannot bypass an authorized source adapter',async()=>{
  const def=(await import('../agents/registry.js')).requireAgentDefinition('source_analysis');
  assert.throws(()=>def.prepare!({input:{authorization:'source-analysis'}} as any),/authorized source analysis/);
});
test('shared runtime honors current agent settings and records usage without storing source history',async()=>{
  const settings=await import('../agents/settings.js'),original=globalThis.fetch;let requests=0;
  globalThis.fetch=(async(_url,init)=>{requests++;const body=JSON.parse(String(init?.body));
    assert.deepEqual(body.tools,[]);assert.match(body.input[0].content,/Prefer bullet notes/);assert.match(body.input[1].content,/Tuesday/);
    return new Response(JSON.stringify({output:[{type:'message',content:[{type:'output_text',text:'Grounded shared-runtime notes.'}]}],usage:{input_tokens:50,output_tokens:10}}),{status:200});
  }) as typeof fetch;
  try{
    const {call}=await fixture('call-shared-runtime');
    await settings.saveAgentSettings('source_analysis',org,'default',{enabled:false});
    const disabled=await analysis.generateCallAnalysis(ctx,call.id,{operation_id:'disabled-agent'});
    assert.equal((await analysis.processCallAnalysisJob(call,{actor_user_id:'owner',analysis_id:disabled.note.id})).state,'failed');assert.equal(requests,0);
    await settings.saveAgentSettings('source_analysis',org,'default',{enabled:true,custom_instructions:'Prefer bullet notes'});
    const enabled=await analysis.generateCallAnalysis(ctx,call.id,{operation_id:'enabled-agent'});
    assert.equal((await analysis.processCallAnalysisJob(call,{actor_user_id:'owner',analysis_id:enabled.note.id})).state,'ready');assert.equal(requests,1);
    const db=(await import('../agents/storage.js')).getAgentsDatabase();
    assert.equal(Number((await db.prepare("SELECT count(*) AS count FROM agent_runs WHERE agent_id='source_analysis'").get())?.count),1);
    assert.equal(Number((await db.prepare('SELECT count(*) AS count FROM agent_messages').get())?.count),0);
  }finally{globalThis.fetch=original;}
});
