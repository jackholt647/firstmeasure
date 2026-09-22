import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import vm from 'node:vm';
const request = await readFile(new URL('../../libraries/apps/project-request/app.js', import.meta.url), 'utf8');
const map = await readFile(new URL('../../libraries/apps/project-map/app.js', import.meta.url), 'utf8');
function fn(source, name) {
  const start = source.indexOf(`  function ${name}(`);
  return source.slice(start, source.indexOf('\n  }', start) + 4);
}
test('FirstMeasure notes autosave outside the form without duplicating form autosave or saving platform composers', () => {
  let handler, saves = 0;
  const start = request.indexOf("    $('#rProjectNotes')?.addEventListener('input', (event) => {");
  const end = request.indexOf('}, { signal: projectFormListeners.signal });', start);
  const context = {
    $: () => ({ addEventListener: (_type, callback) => { handler = callback; } }),
    autoSizeProjectNoteInput() {}, renderProjectNoteComposerMentions() {},
    expandedPlatformEnabled: () => false, queueAutosaveNotice: () => saves++,
    projectFormListeners: { signal: undefined }
  };
  vm.createContext(context);
  vm.runInContext(request.slice(start, end + '}, { signal: projectFormListeners.signal });'.length), context);
  handler({ target: { closest: () => null } }); assert.equal(saves, 1);
  handler({ target: { closest: () => ({}) } }); assert.equal(saves, 1);
  context.expandedPlatformEnabled = () => true;
  handler({ target: { closest: () => null } }); assert.equal(saves, 1);
});
test('FirstMeasure drafts save with proposals disabled even when their script is loaded', () => {
  let saves = 0, proposalCalls = 0;
  const context = { proposalsEnabled: () => false, proposalTabModule: () => ({}), persistActiveBaseProject: () => saves++, proposalInvoke: () => proposalCalls++ };
  vm.createContext(context); vm.runInContext(fn(request, 'queueAutosaveNotice'), context);
  context.queueAutosaveNotice();
  assert.equal(saves, 1); assert.equal(proposalCalls, 0);
  context.proposalsEnabled = () => true;
  context.queueAutosaveNotice();
  assert.equal(proposalCalls, 1);
});
test('map reactivation does not overwrite a newly added or removed pin with the same saved snapshot', () => {
  let syncs = 0;
  const saved = { id: 'draft', address: 'Fictional location', pins: [{ lat: 1, lng: 2 }] };
  const state = { map: {}, markerSignature: '', hydratedPinsKey: '', focusedPinSignature: '' };
  const context = { state, project: () => saved, normalizeProjectPins: p => p.pins,
    pinsSignature: p => JSON.stringify(p), projectId: p => p.id,
    syncProjectPins: p => { syncs++; state.markerSignature = JSON.stringify(p); return true; },
    setCoords() {}, fitMapToPins() {}, setAddressSelected() {}, callHost() {} };
  vm.createContext(context); vm.runInContext(fn(map, 'focusMapOnProject'), context);
  context.focusMapOnProject(saved); assert.equal(syncs, 1);
  state.markerSignature = JSON.stringify([...saved.pins, {lat:3,lng:4}]);
  context.focusMapOnProject(saved); assert.equal(syncs, 1);
  state.markerSignature = '[]';
  context.focusMapOnProject(saved); assert.equal(syncs, 1);
  context.focusMapOnProject({...saved, id:'another-draft'}); assert.equal(syncs, 2);
});

test('URL-opened report drafts recover their ordering workflow before controls are created', () => {
  const stop = new Error('stop at control creation');
  const context = {
    projectOpenGeneration: 2, projectShellLoading: true, activePreviewTab: 'map', requestedWorkflow: 'project',
    $: () => ({classList:{contains:()=>true}}), activeModalMatchesProject:()=>true,
    projectHasReportOrder: p => p.ordered === true,
    firstMeasureReportOrdersEnabled:()=>true, proposalsEnabled:()=>false, schedulingEnabled:()=>false,
    ensureProjectModalLeftRegion:()=>{throw stop;}
  };
  vm.createContext(context);
  vm.runInContext(fn(request,'normalizeWorkflow')+'\n'+fn(request,'isUnfinishedReportDraft')+'\n'+fn(request,'hydrateOpenProjectContent'), context);
  assert.throws(()=>context.hydrateOpenProjectContent({id:'draft',address:'Test address',workflow_state:'draft'}),e=>e===stop);
  assert.equal(context.requestedWorkflow,'report');
  context.requestedWorkflow='project';
  assert.throws(()=>context.hydrateOpenProjectContent({id:'complete',address:'Test address',workflow_state:'measurement_ordered',ordered:true}),e=>e===stop);
  assert.equal(context.requestedWorkflow,'project');
  assert.equal(context.hydrateOpenProjectContent({workflow_intent:'report'},{},1),false,'stale hydration is ignored');
});

test('roof and Full House share the same closed-hours notice', () => {
  const notice={classList:{toggle:(name,value)=>{notice.visible=value;}}};const message={textContent:''};
  class EveningDate extends Date{constructor(value){super(value??'2026-09-20T04:00:00Z');}}
  let exterior=false,roof=true;
  const context={Date:EveningDate,hasSelectedAddons:()=>roof,window:{Portal:{ExteriorOrder:{active:()=>exterior}}},$:id=>id==='#rAfterHours'?notice:message};
  vm.createContext(context);vm.runInContext(fn(request,'getAfterHoursMessage')+'\n'+fn(request,'renderAfterHoursNotice'),context);
  context.renderAfterHoursNotice();const roofNotice=message.textContent;assert.equal(notice.visible,true);
  roof=false;exterior=true;context.renderAfterHoursNotice();assert.equal(message.textContent,roofNotice);assert.match(message.textContent,/Reports placed now/);assert.equal(notice.visible,true);
});
