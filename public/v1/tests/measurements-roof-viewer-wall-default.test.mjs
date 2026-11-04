// Picking the Walls default in Design changes every wall (FM-332). A wall given its own material earlier in the
// design (W16 set to Stucco, which with no color of its own drew in the navy wall color) kept it, so "all walls to
// Stone" left that wall looking unchanged. The newest choice wins: the default replaces each face's own material.
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import vm from 'node:vm';

const source = () => readFile(new URL('../../libraries/apps/measurements/roof-viewer.js', import.meta.url), 'utf8');
async function viewer() {
  const context = {window: {}, document: {currentScript: null}, location: {href: 'http://roof.test/'}, console};
  vm.createContext(context);
  vm.runInContext(await source(), context);
  return context.window.FirstMeasureRoofViewer;
}
const plain = value => JSON.parse(JSON.stringify(value));

test('the wall default replaces every face material choice and keeps face colors', async () => {
  const V = await viewer();
  const design = {version: 1, mode: 'projected', defaults: {trimColor: '#c18611', material: 'siding'}, openings: {o: {color: '#111111'}}, source: null,
    walls: {w16: {material: 'stucco'}, w4: {material: 'brick', color: '#222222'}, w7: {color: '#333333'}}};
  const next = plain(V.designWithWallDefault(design, 'stone'));
  assert.deepEqual(next.defaults, {trimColor: '#c18611', material: 'stone'});
  assert.deepEqual(next.walls, {w4: {color: '#222222'}, w7: {color: '#333333'}});
  assert.deepEqual(next.openings, design.openings);
  assert.equal(design.walls.w16.material, 'stucco', 'the design passed in is not changed');
});

test('a blank design gets the default and no walls', async () => {
  const V = await viewer();
  assert.deepEqual(plain(V.designWithWallDefault({defaults: {}, walls: {}}, 'brick')), {defaults: {material: 'brick'}, walls: {}});
});

test('the Walls default chips go through designWithWallDefault', async () => {
  const text = await source();
  assert.match(text, /id=>changeDesign\(x=>\{Object\.assign\(x,designWithWallDefault\(x,id\)\);\}\),'Wall material'/);
});
