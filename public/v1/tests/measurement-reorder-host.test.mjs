import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import vm from 'node:vm';
const source = await readFile(new URL('../../libraries/apps/measurements/project.js', import.meta.url), 'utf8');
function functionSource(name) {
  const start = source.search(new RegExp(`  (?:async )?function ${name}\\(`));
  assert.ok(start >= 0);
  return source.slice(start, source.indexOf('\n  }', start) + 4);
}
test('reordering a saved report transfers confirmation and mobile form state through the host', () => {
  const host = {}, custom = {};
  const context = {
    callHost(name, ...args) { host[name] = args; if (name === 'mobileOrderUsesFinalPage') return true; },
    normalizeOrderProjectType: value => value,
    reorderSourceProjectId: value => value.reorder_source_project_id,
    isRejectedStatus: (...values) => values.includes('rejected'),
    shouldAutoOpenInstantFromMode: () => false,
    normalizeProjectPins: value => value.pins,
    $: () => custom,
    setProjectionMode: value => { host.projection = value; },
    setActivePreviewTab: value => { host.tab = value; },
    selectedReportExpedite: null,
  };
  vm.createContext(context);
  vm.runInContext(functionSource('applyReorderPrefillState'), context);
  context.applyReorderPrefillState({ reorder_source_project_id: 'report-1', status: 'rejected',
    project_type: 'residential', correct_project_type: 'commercial', address: '123 Preview Lane',
    pins: [{ lat: 47, lng: -122 }], measurement: { include_gutters: true } });
  assert.equal(context.selectedType, 'commercial');
  assert.equal(context.reorderSourceCanReopenInPlace, true);
  assert.equal(context.includeGutterMeasurements, false);
  assert.deepEqual(host.setLocationConfirmed, [true]);
  assert.deepEqual(host.setAddressSelected, [true]);
  assert.deepEqual(host.setCoords, [47, -122, true]);
  assert.deepEqual(host.setTypePickerExpanded, [false]);
  assert.deepEqual(host.setMobileOrderPage, ['final']);
  assert.equal(host.tab, 'map');
  assert.equal(custom.value, '1');
});
test('measurement purchases await a denied asynchronous credit check', async () => {
  const start = source.indexOf('  async function ensureCreditsForPurchase(');
  const line = source.slice(start, source.indexOf('\n', start));
  const context = { callHost: async () => false };
  vm.createContext(context); vm.runInContext(line, context);
  assert.equal(await context.ensureCreditsForPurchase(7), false);
  context.callHost = async () => true;
  assert.equal(await context.ensureCreditsForPurchase(7), true);
});
