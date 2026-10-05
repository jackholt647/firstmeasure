import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import vm from 'node:vm';
const scopeSource = await readFile(new URL('../../libraries/platform-widgets/scope-data.js',import.meta.url),'utf8');
const source = await readFile(new URL('../../libraries/apps/materials/project.js', import.meta.url), 'utf8');
function fn(name) {
  const start = source.search(new RegExp(`  (?:async )?function ${name}\\(`));
  assert.ok(start >= 0, name);
  const end = source.indexOf('\n  }', start) + 4;
  return source.slice(start, end);
}
function scope(project, report = {}) {
  const ctx = { window:{}, state: { project, lists: [] }, reportMeasurements: () => report,
    measurementsHaveValues: values => Object.values(values).some(v => Number(v) > 0) };
  vm.createContext(ctx);
  vm.runInContext(scopeSource,ctx);
  vm.runInContext(fn('scopeForMaterials') + fn('scopeMeasurements'), ctx);
  return ctx;
}
test('linked report values appear and feed scope generation without a saved measurement copy', () => {
  const ctx = scope({ scope: { pieces: [{ id: 'roof', template_id: 'roof' }] } }, { roofSquares: 25.5, eavesLf: 122 });
  assert.equal(ctx.scopeMeasurements().roofSquares, 25.5);
  assert.equal(ctx.scopeForMaterials().pieces[0].measurements.eavesLf, 122);
});
test('scope definitions win over measurement-only project metadata and saved values stay authoritative', () => {
  const ctx = scope({ scope: { measurements: { roofSquares: 1 } }, project_scope: {
    pieces: [{ id: 'roof', measurements: { roofSquares: 12 } }], measurements: { roofSquares: 20 }
  } }, { roofSquares: 30 });
  assert.equal(ctx.scopeForMaterials().pieces[0].id, 'roof');
  assert.equal(ctx.scopeMeasurements().roofSquares, 20);
  assert.equal(ctx.scopeForMaterials().pieces[0].measurements.roofSquares, 12);
});
test('proposal definitions are recovered when project scope contains only metadata', () => {
  const ctx = scope({ scope: { status: 'defined' }, proposals: [{ content: { scope: {
    pieces: [{ id: 'proposal-roof', template_id: 'roof' }], measurements: { roofSquares: 18 }
  } } }] });
  assert.equal(ctx.scopeForMaterials().pieces[0].id, 'proposal-roof');
  assert.equal(ctx.scopeMeasurements().roofSquares, 18);
});
test('existing lists render before slow catalog calls and refresh does not generate', async () => {
  let finish;
  const slow = new Promise(resolve => { finish = resolve; });
  const events = [];
  const state = { mounted: true, lists: [], activeListId: '' };
  const ctx = { state, performance, timingMark() {}, beginLoadContext: () => ({ orgId: 'org', projectId: 'project' }),
    loadContextIsCurrent: () => true, apiReady: () => true,
    loadPricebookItems: () => slow, loadWorkResources: () => slow, requestMeasurementHydration: () => slow,
    window: { MaterialsAPI: { projects: { list: async () => ({ material_lists: [{ id: 'existing' }] }) } } },
    applyMaterialLists: lists => { state.lists = lists; }, render: () => events.push(state.lists.length), renderLeft() {},
    initializeMaterialListsFromScope: () => { throw Error('must not regenerate existing lists'); },
    loadActiveListDetails: async () => {}, loadExpenseProjection: async () => {}, listItems: () => [] };
  ctx.materialsAPI = ctx.window.MaterialsAPI;
  vm.createContext(ctx); vm.runInContext(fn('loadData'), ctx);
  const loading = ctx.loadData();
  await new Promise(resolve => setImmediate(resolve));
  assert.ok(events.includes(1), 'lists render while ancillary requests remain pending');
  assert.equal(state.loading, false);
  finish(); await loading;
  assert.equal(state.lastError, '');
});
test('explicit regeneration surfaces permission errors instead of treating them as success', async () => {
  const ctx = { state: { lists: [] }, loadContextIsCurrent: () => true, apiReady: () => true,
    orgId: () => 'org', projectId: () => 'project', branchId: () => 'branch', scopeForMaterials: () => ({}),
    window: { MaterialsAPI: { projects: { initializeFromScope: async () => { throw Object.assign(Error('denied'), { status: 403 }); } } } } };
  ctx.materialsAPI = ctx.window.MaterialsAPI;
  vm.createContext(ctx); vm.runInContext(fn('initializeMaterialListsFromScope'), ctx);
  assert.equal(await ctx.initializeMaterialListsFromScope(), null);
  await assert.rejects(ctx.initializeMaterialListsFromScope({ force: true }), /denied/);
});
test('scope sidebar omits duplicate project notes and render does not fetch notes', () => {
  assert.doesNotMatch(fn('leftHtml'), /Project Notes|scopeNotesHtml|data-mt-note/);
  assert.doesNotMatch(fn('renderLeft'), /projectNotesApi/);
});

test('empty scope defaults do not mask a completed report', () => {
  const ctx = scope({ scope: { measurements: { roofSquares: 0, eavesLf: 0, wastePercent: 10 }, pieces: [
    { id: 'roof', measurements: { roofSquares: 0, wastePercent: 10 } }
  ] } }, { roofSquares: 25, eavesLf: 120 });
  assert.equal(ctx.scopeMeasurements().roofSquares, 25);
  assert.equal(ctx.scopeForMaterials().pieces[0].measurements.roofSquares, 25);
});
