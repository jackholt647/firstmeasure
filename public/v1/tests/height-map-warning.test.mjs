import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';

const source = await readFile('../measure/internal/editor_scripts/main.js', 'utf8');
const start = source.indexOf('function firstMeasureParseSolarImageryDate(');
const end = source.indexOf('\nfunction firstMeasureShowOldHeightMapFootageModal(', start);
assert.ok(start >= 0 && end > start, 'height-map warning helpers are present');

const context = vm.createContext({ Date });
vm.runInContext(source.slice(start, end), context);
context.manifest = { height_map_quality: 'HIGH', solar_imagery_date: { year: 2026, month: 8, day: 1 } };
context.insights = {};
const highState = JSON.parse(vm.runInContext('JSON.stringify(firstMeasureHeightMapWarningState(manifest, insights))', context));
assert.equal(new Date(highState.imageryDate).getFullYear(), 2026);
assert.equal(highState.imageryQuality, 'HIGH');
assert.equal(highState.oldFootage, false);
assert.equal(highState.lowQuality, false);

for (const quality of ['MEDIUM', 'LOW', 'BASE']) {
  context.manifest = { height_map_quality: quality };
  const state = JSON.parse(vm.runInContext('JSON.stringify(firstMeasureHeightMapWarningState(manifest, insights))', context));
  assert.equal(state.lowQuality, true, `${quality} requires verification`);
}

context.manifest = { solar_imagery_quality: 'HIGH', solar_imagery_date: { year: 2020, month: 1, day: 1 } };
let state = JSON.parse(vm.runInContext('JSON.stringify(firstMeasureHeightMapWarningState(manifest, insights))', context));
assert.equal(state.oldFootage, true);
assert.equal(state.lowQuality, false);

context.manifest = { solar_imagery_date: { year: 2020, month: 1, day: 1 } };
context.insights = { imageryQuality: 'MEDIUM' };
state = JSON.parse(vm.runInContext('JSON.stringify(firstMeasureHeightMapWarningState(manifest, insights))', context));
assert.equal(state.oldFootage, true);
assert.equal(state.lowQuality, true);

assert.match(source, /Cross-reference the scale in Google Earth and the pitch in Street View/);
assert.match(source, /upload reference screenshots that confirm both/);

console.log('PASS: old-footage and low-quality height-map warnings are combined correctly.');
