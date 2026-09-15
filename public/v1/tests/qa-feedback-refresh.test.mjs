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
  vm.runInContext(['mergeThreadDrafts','refreshForFolder','ensureFeedbackReady','persistThreadDrafts'].map(extract).join('\n'), context);
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
test('approval hydrates feedback before the first polling tick',async()=>{
  const c=fixture({manifest:{qa_threads:[{id:'saved',status:'fixed'}]}});
  c.lastFolderId=null;c.qaThreads=[];c.window.currentProjectId='project';
  c.window.firstMeasureFetchJson=async()=>({success:true});
  await vm.runInContext('ensureFeedbackReady().then(persistThreadDrafts)',c);
  assert.equal(c.lastFolderId,'project');assert.equal(c.qaThreads[0].id,'saved');
});
test('failed initial feedback load blocks approval without discarding notes',async()=>{
  const c=fixture(null);c.lastFolderId=null;c.window.currentProjectId='project';
  await assert.rejects(vm.runInContext('ensureFeedbackReady()',c),/Unable to load/);
  assert.equal(c.qaThreads[0].id,'unsaved');
});

test('production feedback uses the small authenticated PHP endpoint, not the PDF bundle',async()=>{
  const calls=[];
  const c=vm.createContext({URLSearchParams,console,getApiProjectPath:(id,suffix)=>`/projects/${id}${suffix}`,window:{
    location:{pathname:'/measure/internal/editor.php'},firstMeasureIsTutorialProjectId:()=>false,
    firstMeasureFetchLocalJson:async(url,options)=>{calls.push({url,options});return {manifest:{qa_threads:[{id:'saved'}]}};},
    firstMeasureFetchJson:()=>{throw new Error('Large bundle must not be requested');}
  }});
  vm.runInContext(extract('fetchManifest'),c);
  const result=await c.fetchManifest('project');
  assert.equal(result.manifest.qa_threads[0].id,'saved');
  assert.equal(calls[0].url,'/measure/internal/editor.php?action=project_feedback&folder=project');
  assert.equal(calls[0].options.credentials,'include');assert.equal(calls[0].options.cache,'no-store');
  c.window.firstMeasureIsTutorialProjectId=()=>true;
  c.window.firstMeasureFetchJson=async url=>({tutorialUrl:url});
  assert.equal((await c.fetchManifest('tutorial_abc')).tutorialUrl,'/projects/tutorial_abc/editor');
});
test('PDF preparation never submits before correction responses',async()=>{
  const report=await readFile(new URL('../../measure/internal/editor_scripts/report.js',import.meta.url),'utf8');
  const start=report.indexOf('function buildSubmissionPdfOutputs(');
  const end=report.indexOf('\nasync function ',start);
  const c=vm.createContext({window:{},firstReportLogoValue:()=>'',getProjectOrganizationBranding:()=>null});
  vm.runInContext(report.slice(start,end),c);
  const outputs=vm.runInContext('buildSubmissionPdfOutputs({})',c);
  assert.ok(outputs.every(o=>o.update_status===false));
  assert.doesNotMatch(report.slice(start,report.indexOf('async function',report.indexOf('async function runSharedLocalPdfGeneration')+20)),/updateStatus:\s*true/);
});
