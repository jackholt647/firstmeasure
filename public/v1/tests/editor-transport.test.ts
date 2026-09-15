import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { blindEditorQaIdentity } from '../firstmeasure/editor_transport.js';

test('streamed bundle blinding preserves feedback, geometry and images', () => {
  const value = { qa_reviewed_by: 'private', workflow: {qa_claim: {email:'private',name:'private',id:'private'}},
    qa_threads:[{id:'note',status:'open',history:[{role:'qa',by:'private',by_name:'private',text:'Fix edge',images:['image.png']}]}],
    geometry:{points:[{x:1,y:2}]}, image:'data:image/png;base64,abc' };
  blindEditorQaIdentity(value);
  assert.equal(value.qa_reviewed_by,null);
  assert.equal(value.workflow.qa_claim.email,null);
  assert.equal(value.qa_threads[0]!.history[0]!.by,null);
  assert.equal(value.qa_threads[0]!.history[0]!.by_name,'QA');
  assert.equal(value.qa_threads[0]!.history[0]!.text,'Fix edge');
  assert.deepEqual(value.geometry.points,[{x:1,y:2}]);
  assert.equal(value.image,'data:image/png;base64,abc');
});

test('feedback endpoint is independent of PDF state; streamed transport preserves the full bundle', async () => {
  const root=await mkdtemp(path.join(os.tmpdir(),'editor177-'));
  Object.assign(process.env,{FIRSTMATE_ENV:'test',FIRSTMEASURE_DATABASE_MODE:'sqlite',FIRSTMEASURE_STORAGE_ROOT:root,FIRSTMEASURE_INDEX_DB_PATH:path.join(root,'index.sqlite'),INTERNAL_STORAGE_ROOT:path.join(root,'internal'),PLATFORM_STORAGE_ROOT:path.join(root,'platform'),FIRSTMEASURE_JOB_WORKERS:'0',PLATFORM_HEARTBEAT_DISABLED:'1'});
  const storage=await import('../firstmeasure/storage.js');
  const {buildApp}=await import('../src/app.js');const app=await buildApp();await app.ready();
  const id='editor177';
  const thread={id:'note',status:'open',history:[{role:'qa',by:'private',by_name:'Private QA',text:'Fix edge',images:['image.png']}]};
  try {
    await storage.saveManifest(id,{id,schema_version:2,status:'correction_needed',address:'Synthetic feedback',qa_threads:[thread],qa_thread_drafts:{qa:{threads:[thread]}},timestamps:{created_at:new Date().toISOString()}} as any);
    await storage.saveAppMetadata(id,{qa_thread_drafts:{qa:{threads:[]}},geometry:{points:[]}});
    // If the feedback route accidentally starts reading PDF state again, this
    // invalid snapshot makes it fail instead of silently passing a tiny fixture.
    await storage.saveArtifact(id,'pdf_state.json','not JSON: feedback must never read this artifact');
    const feedback=await app.inject({url:`/v1/firstmeasure/projects/${id}/editor/feedback`});
    assert.equal(feedback.statusCode,200,feedback.body);
    assert.equal(feedback.json().manifest.qa_threads[0].id,'note');
    assert.equal(feedback.json().app_metadata.qa_thread_drafts.qa.threads[0].id,'note');
    assert.equal(feedback.json().pdf_state,undefined);
    const snapshot={geometry:{points:[{x:1,y:2}]},mainImage:'data:image/png;base64,abcdef',history:[{role:'qa',by:'private',by_name:'Private QA',text:'Keep annotation'}]};
    await storage.savePdfState(id,snapshot);
    const admin=await app.inject({url:`/v1/firstmeasure/projects/${id}/editor?transport=php&blind_qa=0`});
    assert.equal(admin.statusCode,200,admin.body);
    assert.deepEqual(admin.json().pdf_state,snapshot);
    const tech=await app.inject({url:`/v1/firstmeasure/projects/${id}/editor?transport=php&blind_qa=1`});
    assert.equal(tech.statusCode,200,tech.body);
    assert.equal(tech.json().manifest.qa_threads[0].history[0].by,null);
    assert.equal(tech.json().pdf_state.history[0].by,null);
    assert.equal(tech.json().pdf_state.mainImage,snapshot.mainImage);
    assert.deepEqual((await storage.readManifest(id)).qa_threads,[thread],'blinding must never persist');
    assert.deepEqual(await storage.readPdfState(id),snapshot);
    const php=await readFile(new URL('../../measure/internal/editor.php',import.meta.url),'utf8');
    assert.match(php,/\$canViewIdentity = fm_editor_can_view_qa_identity\(\)/);
    assert.match(php,/project_feedback.*strpos\(\$editorAction, 'tutorial_project_'/);
  } finally {await app.close();await(await import('../firstmeasure/project_index.js')).closeFirstMeasureProjectIndex();await rm(root,{recursive:true,force:true,maxRetries:3});}
});
