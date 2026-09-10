import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
test('stale draft and decision payloads cannot erase saved feedback during rework',async()=>{
 const root=await mkdtemp(path.join(os.tmpdir(),'qa177-'));
 Object.assign(process.env,{FIRSTMATE_ENV:'test',FIRSTMEASURE_DATABASE_MODE:'sqlite',FIRSTMEASURE_STORAGE_ROOT:root,FIRSTMEASURE_INDEX_DB_PATH:path.join(root,'index.sqlite'),INTERNAL_STORAGE_ROOT:path.join(root,'internal'),PLATFORM_STORAGE_ROOT:path.join(root,'platform'),FIRSTMEASURE_JOB_WORKERS:'0',PLATFORM_HEARTBEAT_DISABLED:'1'});
 const storage=await import('../firstmeasure/storage.js');const {buildApp}=await import('../src/app.js');const app=await buildApp();await app.ready();
 const qa={email:'qa@example.test',name:'QA'};const thread={id:'saved-feedback',status:'open',history:[{ts:'2026-09-10T01:00:00Z',text:'Fix roof alignment',images:['fixture.jpg']}]};
 const post=(suffix:string,payload:Record<string,unknown>)=>app.inject({method:'POST',url:'/v1/firstmeasure/projects/qa177/'+suffix,payload});
 try{
  await storage.saveManifest('qa177',{id:'qa177',schema_version:2,status:'awaiting_review',address:'Synthetic QA feedback',assigned_to_email:'tech@example.test',qa_claimed_by_email:qa.email,workflow:{assigned_to:{email:'tech@example.test',name:'Tech'},qa_claim:{...qa,claimed_at:new Date().toISOString()},history:[]},timestamps:{created_at:new Date().toISOString()}} as any);
  assert.equal((await post('editor/qa-thread-drafts',{scope:'qa',threads:[thread]})).statusCode,200);
  assert.equal((await post('editor/qa-thread-drafts',{scope:'qa',threads:[]})).statusCode,200);
  assert.equal((await storage.readManifest('qa177')).qa_thread_drafts && ((await storage.readManifest('qa177')).qa_thread_drafts as any).qa.threads.length,1,'stale empty draft must retain saved feedback');
  const rejected=await post('qa/decision',{actor:qa,status:'rejected',threads:[]});
  assert.equal(rejected.statusCode,200,rejected.body);assert.equal(rejected.json().success,true,rejected.body);
  const manifest=await storage.readManifest('qa177');assert.equal((manifest.qa_threads as any[]).length,1,'rework handoff must promote saved draft even when parent view is stale');
  assert.equal((manifest.qa_threads as any[])[0].history[0].images[0],'fixture.jpg');
  assert.equal((manifest.qa_thread_drafts as any).qa,null,'promotion consumes draft atomically');
  const editor=await app.inject({method:'GET',url:'/v1/firstmeasure/projects/qa177/editor'});assert.equal(editor.statusCode,200,editor.body);assert.equal(editor.json().manifest.qa_threads[0].id,thread.id);
  const fixed={...thread,status:'fixed',history:[...thread.history,{ts:'2026-09-10T02:00:00Z',text:'Fixed alignment'}]};
  await post('editor/qa-thread-drafts',{scope:'qa',threads:[fixed]});
  const clear=await post('editor/qa-thread-drafts',{scope:'qa',clear:true});assert.equal(clear.statusCode,409,'late clear from old QA tab must not delete tech response');
  await post('editor/qa-thread-drafts',{scope:'qa',threads:[thread]});
  assert.equal(((await storage.readManifest('qa177')).qa_thread_drafts as any).qa.threads[0].status,'fixed');
  const concurrent=await Promise.all(['parallel-a','parallel-b'].map(id=>post('editor/qa-thread-drafts',{scope:'manager',threads:[{...thread,id}]})));
  assert.ok(concurrent.every(result=>result.statusCode===200));
  assert.equal(((await storage.readManifest('qa177')).qa_thread_drafts as any).manager.threads.length,2,'concurrent independent feedback additions must both survive');
 }finally{await app.close();await(await import('../firstmeasure/project_index.js')).closeFirstMeasureProjectIndex();await rm(root,{recursive:true,force:true,maxRetries:3});}
});
