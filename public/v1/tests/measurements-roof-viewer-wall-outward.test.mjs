// Openings stand 3 cm off their wall on its outside (FM-331). A report without a base saves each wall's normal as
// the face's winding, which can point into the house: the door then sat behind the siding and showed or vanished
// with the canvas size and zoom. The viewer orients walls itself.
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
const rect = (a, b, z0 = 0, z1 = 3) => [[...a, z0], [...b, z0], [...b, z1], [...a, z1]];
const door = (a, b) => ({type: 'door', points: rect(a, b, 0, 2.1)});
// An L-shaped plan in metres: a 10 x 8 main body and a 4 x 4 wing on its west side. The wing's south wall faces into
// the inside corner, as the reported door's wall did.
function lPlan(saved) {
  return [
    {id: 'north', points: rect([10, 0], [-4, 0]), normal: saved.north, openings: []},
    {id: 'east', points: rect([10, 8], [10, 0]), normal: saved.east, openings: [door([10, 3], [10, 4])]},
    {id: 'south', points: rect([0, 8], [10, 8]), normal: saved.south, openings: []},
    {id: 'mainWest', points: rect([0, 4], [0, 8]), normal: saved.mainWest, openings: []},
    {id: 'wingSouth', points: rect([-4, 4], [0, 4]), normal: saved.wingSouth, openings: [door([-2.5, 4], [-1.5, 4])]},
    {id: 'wingWest', points: rect([-4, 0], [-4, 4]), normal: saved.wingWest, openings: []}
  ];
}
const outside = {north: [0, -1, 0], east: [1, 0, 0], south: [0, 1, 0], mainWest: [-1, 0, 0], wingSouth: [0, 1, 0], wingWest: [-1, 0, 0]};
const inside = Object.fromEntries(Object.entries(outside).map(([k, n]) => [k, n.map(v => -v)]));
function assertOutward(walls, result, expected = outside) {
  walls.forEach((wall, i) => {
    const n = result[i], e = expected[wall.id];
    assert.ok(n[0] * e[0] + n[1] * e[1] + n[2] * e[2] > .99, `${wall.id} faces ${JSON.stringify(e)}, got ${JSON.stringify(n)}`);
  });
}

test('without a base, walls whose saved normal points inside are turned outward', async () => {
  const V = await viewer();
  const walls = lPlan({...outside, east: inside.east, wingSouth: inside.wingSouth});
  assertOutward(walls, V.exteriorOutwards(walls, []));
});

test('without a base or saved normals, the inside-corner wall still faces out of the corner', async () => {
  const V = await viewer();
  const walls = lPlan({});
  assertOutward(walls, V.exteriorOutwards(walls, []));
});

test('the base footprint orients walls first, as the report does', async () => {
  const V = await viewer();
  const walls = lPlan(inside), base = [{points: [[-4, 0, 0], [10, 0, 0], [10, 8, 0], [0, 8, 0], [0, 4, 0], [-4, 4, 0]], holes: []}];
  assertOutward(walls, V.exteriorOutwards(walls, base));
});

test('a wall the other walls cannot orient keeps its saved normal', async () => {
  const V = await viewer();
  const walls = [{id: 'alone', points: rect([0, 0], [5, 0]), normal: [0, 1, 0], openings: []}];
  assertOutward(walls, V.exteriorOutwards(walls, []), {alone: [0, 1, 0]});
});

test('openings and their trim stand off the wall along exteriorOutwards, not the saved normal', async () => {
  const text = await source();
  assert.match(text, /outwards=new Map\(exteriorOutwards\(exterior\.walls,exterior\.base\|\|\[\]\)/);
  assert.match(text, /const wallNormal=outwards\.get\(wall\);/);
  assert.doesNotMatch(text, /outward=savedNormal\?1/);
});
