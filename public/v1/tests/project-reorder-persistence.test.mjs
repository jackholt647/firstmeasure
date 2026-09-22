import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import vm from 'node:vm';
const viewer = await readFile(new URL('../../portal/scripts/project_viewer.js', import.meta.url),'utf8');
const request = await readFile(new URL('../../libraries/apps/project-request/app.js', import.meta.url),'utf8');
test('reordering replaces all current report aliases and records the prior report as history', () => {
  const local = new Map();
  const context = { window:{Portal:{},__APP:{userOrgId:'org-local',userId:'owner'}}, localStorage:{getItem:key=>local.get(key)||null,setItem:(key,value)=>local.set(key,value)}, console };
  vm.createContext(context); vm.runInContext(viewer,context);
  const store=context.window.Portal.ProjectStore;
  store.cache({id:'project_local',platform_project_id:'project_local',project_id:'old-report',folder:'old-report', status:'cancelled',project_notes:'Existing note',measurement:{id:'old-report'},refund_amount:7});
  const ordered=store.fromQueue({platform_project_id:'project_local',address:'123 Preview Lane',project_notes:'Existing note'}, {folder:'new-report'}, {persist:false});
  assert.equal(ordered.project_id,'new-report'); assert.equal(ordered.folder,'new-report');
  assert.equal(ordered.measurement_project_id,'new-report'); assert.equal(ordered.status,'queued');
  assert.equal(ordered.refund_amount,0); assert.equal(ordered.project_notes,'Existing note');
  assert.equal(ordered.previous_measurement_ids.includes('old-report'),true);
  assert.equal(store.findByMeasurement({id:'old-report'}),null);
  assert.equal(store.findByMeasurement({id:'new-report'}).id,ordered.id);
});
test('incomplete routed shells and hydration cannot save over the full project record', () => {
  const start=request.indexOf('  function persistActiveBaseProject('), end=request.indexOf('\n  function ',start+1);
  const context={projectShellLoading:true,projectFormHydrating:0};
  vm.createContext(context);vm.runInContext(request.slice(start,end),context);
  // Any attempt to read/save form fields here would throw: these shells have none.
  assert.doesNotThrow(()=>context.persistActiveBaseProject());
  context.projectShellLoading=false;context.projectFormHydrating=1;
  assert.doesNotThrow(()=>context.persistActiveBaseProject());
});

test('building contact fields for hydration does not persist an empty form', () => {
  const start=request.indexOf('  function addContactCard('),end=request.indexOf('\n  function ',start+1);
  let writes=0,queued=0;
  const context={ $:()=>({querySelectorAll:()=>[],appendChild(){}}),createContactCard:()=>({}),refreshContactCards(){},updateModalTitle(){},queueAutosaveNotice:()=>queued++,persistActiveBaseProject:()=>writes++ };
  vm.createContext(context);vm.runInContext(request.slice(start,end),context);
  context.addContactCard({}, {hydrate:true});
  assert.equal(writes,0);assert.equal(queued,0);
  context.addContactCard({name:'Local Contact'});
  assert.equal(writes,1);assert.equal(queued,1);
});
