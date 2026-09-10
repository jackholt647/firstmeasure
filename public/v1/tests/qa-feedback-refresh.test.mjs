import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import test from 'node:test';
import vm from 'node:vm';
const source = await readFile(new URL('../../measure/internal/editor_scripts/notes_overlay.js', import.meta.url), 'utf8');
function extract(name) {
  const start = source.search(new RegExp(`(?:async )?function ${name}\\(`));
  assert.ok(start >= 0);
  const tail = source.slice(start);
  const next = tail.slice(1).search(/\n  (?:async )?function /);
  return tail.slice(0, next < 0 ? undefined : next + 1);
}
function fixture(bundle) {
  const thread = {id:'unsaved',status:'open',history:[{ts:'2026-09-10T00:00:00Z',text:'Keep this note'}]};
  const context = vm.createContext({
    window:{}, qaThreads:[thread], displayThreads:[thread], lastFolderId:'project', activeThreadScope:'qa',
    lastNotesSig:'',manifestData:{id:'project'},currentBundleMeta:{},
    ensureUI:()=>true,fetchManifest:async()=>bundle,cloneJson:value=>structuredClone(value),
    getThreadScopeForManifest:()=> 'qa',getDraftThreadsFromMeta:()=>[],
    buildDisplayThreads:scopes=>scopes.qa,updateFab:()=>{},showModal:()=>{},renderThreads:()=>{},
    maybeShowResidentialGate:async()=>{},
    queueQaThreadDraftSave:fn=>fn(),getCurrentAppMetadata:()=>({}),getDraftMetaKey:()=> 'qa_thread_drafts'
  });
  vm.runInContext(extract('mergeThreadDrafts') + extract('refreshForFolder') + extract('persistThreadDrafts'), context);
  return context;
}
test('failed refresh preserves visible and editable feedback',async()=>{
  const c=fixture(null);await vm.runInContext("refreshForFolder('project')",c);
  assert.equal(c.qaThreads[0].id,'unsaved');assert.equal(c.displayThreads[0].id,'unsaved');
});
test('stale successful refresh preserves local feedback for the same project',async()=>{
  const c=fixture({manifest:{qa_threads:[]}});await vm.runInContext("refreshForFolder('project')",c);
  assert.equal(c.qaThreads[0].id,'unsaved');assert.equal(c.displayThreads[0].id,'unsaved');
});
test('feedback is not copied to a different project',async()=>{
  const c=fixture({manifest:{qa_threads:[]}});await vm.runInContext("refreshForFolder('different')",c);
  assert.equal(c.qaThreads.length,0);
});
test('unsuccessful save response rejects without confirming metadata',async()=>{
  const c=fixture(null);c.window.firstMeasureFetchJson=async()=>({success:false,message:'Unavailable'});
  await assert.rejects(vm.runInContext('persistThreadDrafts()',c),/Unavailable/);
  assert.equal(c.window.currentProjectLoadedAppMetadata,undefined);
  assert.equal(c.qaThreads[0].id,'unsaved');
});
