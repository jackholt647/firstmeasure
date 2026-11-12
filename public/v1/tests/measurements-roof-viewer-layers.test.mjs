// FM-405: where a lower roof meets an upper one in plan, the two layers keep their own points and every roof face is drawn
// as the plane it is. model_data.xml written before the fix shares those points (the lower face rises into a wall-high
// sliver); the viewer puts such a corner back on its face's plane. The editor no longer writes it
// (dev/xml-generator-layers.test.cjs).
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import vm from 'node:vm';
import {chromium} from 'playwright-core';

const source = path => readFile(new URL('../../' + path, import.meta.url), 'utf8');
async function viewer() {
  const context = {window: {}, document: {currentScript: null}, location: {href: 'http://roof.test/'}, console};
  vm.createContext(context);
  vm.runInContext(await source('libraries/apps/measurements/roof-viewer.js'), context);
  return context.window.FirstMeasureRoofViewer;
}
// A delivered two-story report's roof (FM-405), as stored: F5 and F6 are the lower roof, and C15 and C16 are upper-roof
// corners they were given by mistake (C15 12.7 ft and C16 13.7 ft up, on the upper face F3).
const twoLayerRoof = '<DATA_EXPORT><STRUCTURES><ROOF id="ROOF1"><FACES><FACE id="F1" type="ROOF"><POLYGON id="P1" path="L2,L3,L4,L1" pitch="4" pitch_degrees="18.4" size="618"/></FACE><FACE id="F2" type="ROOF"><POLYGON id="P2" path="L7,L9,L8,L5" pitch="3" pitch_degrees="14.0" size="462"/></FACE><FACE id="F3" type="ROOF"><POLYGON id="P3" path="L6,L1,L17,L19,L18,L21,L16,L9" pitch="4" pitch_degrees="18.4" size="369"/></FACE><FACE id="F4" type="ROOF"><POLYGON id="P4" path="L12,L11,L14,L15" pitch="5" pitch_degrees="22.6" size="337"/></FACE><FACE id="F5" type="ROOF"><POLYGON id="P5" path="L10,L23,L22,L20,L26,L15,L13" pitch="5" pitch_degrees="22.6" size="326"/></FACE><FACE id="F6" type="ROOF"><POLYGON id="P6" path="L24,L25,L26" pitch="4" pitch_degrees="18.4" size="3"/></FACE></FACES><LINES><LINE height="12" id="L1" path="C1,C2" type="RIDGE" width="6"/><LINE height="12" id="L2" path="C1,C3" type="RAKE" width="6"/><LINE height="12" id="L3" path="C3,C4" type="EAVE" width="6"/><LINE height="12" id="L4" path="C4,C2" type="RAKE" width="6"/><LINE height="12" id="L5" path="C5,C6" type="EAVE" width="6"/><LINE height="12" id="L6" path="C1,C7" type="RAKE" width="6"/><LINE height="12" id="L7" path="C7,C5" type="RAKE" width="6"/><LINE height="12" id="L8" path="C6,C8" type="RAKE" width="6"/><LINE height="12" id="L9" path="C7,C8" type="FLASHING" width="6"/><LINE height="12" id="L10" path="C9,C10" type="EAVE" width="6"/><LINE height="12" id="L11" path="C11,C12" type="EAVE" width="6"/><LINE height="12" id="L12" path="C12,C13" type="SIDE_WALL" width="6"/><LINE height="12" id="L13" path="C9,C14" type="RAKE" width="6"/><LINE height="12" id="L14" path="C14,C11" type="RAKE" width="6"/><LINE height="12" id="L15" path="C13,C14" type="RIDGE" width="6"/><LINE height="12" id="L16" path="C8,C20" type="RAKE" width="6"/><LINE height="12" id="L17" path="C17,C2" type="RAKE" width="6"/><LINE height="12" id="L18" path="C15,C16" type="STEPFLASH" width="6"/><LINE height="12" id="L19" path="C16,C17" type="FLASHING" width="6"/><LINE height="12" id="L20" path="C18,C19" type="STEPFLASH" width="6"/><LINE height="12" id="L21" path="C20,C15" type="FLASHING" width="6"/><LINE height="12" id="L22" path="C19,C15" type="FLASHING" width="6"/><LINE height="12" id="L23" path="C15,C10" type="SIDE_WALL" width="6"/><LINE height="12" id="L24" path="C18,C16" type="STEPFLASH" width="6"/><LINE height="12" id="L25" path="C16,C13" type="HEAD_WALL" width="6"/><LINE height="12" id="L26" path="C18,C13" type="VALLEY" width="6"/></LINES><POINTS><POINT data="12.488898,26.193204,2014.978126" id="C1"/><POINT data="-3.220003,-9.503348,2014.978126" id="C2"/><POINT data="26.241374,20.141183,2009.938757" id="C3"/><POINT data="10.532473,-15.555369,2009.938757" id="C4"/><POINT data="-6.293487,34.458726,2009.098864" id="C5"/><POINT data="-22.002388,-1.237826,2009.098864" id="C6"/><POINT data="4.228686,29.828257,2011.968504" id="C7"/><POINT data="-11.480215,-5.868295,2011.968504" id="C8"/><POINT data="-26.241374,-23.365720,2000.000000" id="C9"/><POINT data="-17.146239,-2.698140,2000.000000" id="C10"/><POINT data="-1.033879,-34.458726,2000.000000" id="C11"/><POINT data="8.061257,-13.791145,2000.000000" id="C12"/><POINT data="-4.542491,-8.244643,2005.739281" id="C13"/><POINT data="-13.637626,-28.912223,2005.739281" id="C14"/><POINT data="-9.103016,-6.243504,2012.744518" id="C15"/><POINT data="-6.357139,-7.451876,2013.744983" id="C16"/><POINT data="-6.604488,-8.013945,2013.744983" id="C17"/><POINT data="-7.337382,-9.679358,2004.913931" id="C18"/><POINT data="-10.083259,-8.470986,2003.663561" id="C19"/><POINT data="-9.350365,-6.805574,2012.744518" id="C20"/></POINTS></ROOF></STRUCTURES></DATA_EXPORT>';
const rise = ring => { const n = [0, 0, 0]; ring.forEach((p, i) => { const q = ring[(i + 1) % ring.length]; n[0] += (p[1] - q[1]) * (p[2] + q[2]); n[1] += (p[2] - q[2]) * (p[0] + q[0]); n[2] += (p[0] - q[0]) * (p[1] + q[1]); }); return Math.hypot(n[0], n[1]) / Math.abs(n[2]) * 12; };
// Farthest any corner is from the plane through the face's first three corners that are not in a line.
function offPlane(ring) {
  for (let k = 2; k < ring.length; k++) {
    const [a, b, c] = [ring[0], ring[1], ring[k]], d = (b[0] - a[0]) * (c[1] - a[1]) - (c[0] - a[0]) * (b[1] - a[1]);
    if (Math.abs(d) < 1e-6) continue;
    const A = ((b[2] - a[2]) * (c[1] - a[1]) - (c[2] - a[2]) * (b[1] - a[1])) / d, B = ((b[0] - a[0]) * (c[2] - a[2]) - (c[0] - a[0]) * (b[2] - a[2])) / d;
    return Math.max(...ring.map(p => Math.abs(A * (p[0] - a[0]) + B * (p[1] - a[1]) + a[2] - p[2])));
  }
  return 0;
}

test('a roof face that is already a plane is drawn exactly as saved', async () => {
  const {facePlaneHeights} = await viewer();
  const quad = [[0, 0, 0], [30, 0, 0], [30, 15, 7.5], [0, 15, 7.5]];
  assert.equal(facePlaneHeights(quad, 6), null);
  // A saved pitch that disagrees with the drawn slope (a typed label, or a model with no heights) changes nothing.
  assert.equal(facePlaneHeights(quad, 10), null);
  assert.equal(facePlaneHeights(quad.map(([x, y]) => [x, y, 0]), 6), null);
  assert.equal(facePlaneHeights([[0, 0, 0], [12, 0, 0], [6, 9, 4.5]], 6), null);
  // Steep roofs (a mansard) are roofs too.
  assert.equal(facePlaneHeights([[0, 0, 0], [20, 0, 0], [20, 4, 8], [0, 4, 8]], 24), null);
});

test('a corner far off its face\'s plane is put back on it', async () => {
  const {facePlaneHeights} = await viewer();
  // A lower face with one corner lifted 9 ft to the upper roof.
  const lower = [[0, 0, 0], [20, 0, 0], [20, 12, 5], [10, 12, 14], [0, 12, 5]];
  const heights = facePlaneHeights(lower, 5);
  assert.deepEqual(heights.map(z => Math.round(z * 100) / 100), [0, 0, 5, 5, 5]);
  // A small triangle standing upright because one corner is the upper roof's: back to its saved 4/12.
  const sliver = [[-7.337382, -9.679358, 2004.913931], [-6.357139, -7.451876, 2013.744983], [-4.542491, -8.244643, 2005.739281]];
  const fixed = facePlaneHeights(sliver, 4).map((z, i) => [...sliver[i].slice(0, 2), z]);
  assert.ok(Math.abs(rise(fixed) - 4) < .01, `sliver pitch ${rise(fixed)}`);
  assert.equal(fixed[0][2], sliver[0][2]);
  assert.equal(fixed[2][2], sliver[2][2]);
});

test('the stored two-story roof parses into planes, with the upper roof and its lines untouched', async () => {
  const browser = await chromium.launch({executablePath: process.env.CHROME_PATH || 'C:/Program Files/Google/Chrome/Application/chrome.exe', headless: true});
  try {
    const page = await browser.newPage();
    await page.setContent('<html></html>');
    await page.addScriptTag({content: await source('libraries/apps/measurements/roof-viewer.js')});
    const [roof] = await page.evaluate(xml => window.FirstMeasureRoofViewer.parseModel(xml).map(roof => ({
      faces: roof.faces.map(face => ({ids: face.ids, points: face.points, pitch: face.pitch})),
      lines: Object.fromEntries([...roof.lines].map(([id, line]) => [id, line.ids.map(end => roof.points.get(end))])),
      points: Object.fromEntries(roof.points)
    })), twoLayerRoof);
    for (const face of roof.faces) {
      assert.ok(offPlane(face.points) < .5, `${face.ids} is ${offPlane(face.points)} ft off its plane`);
      assert.ok(Math.abs(rise(face.points) - face.pitch) < 1, `${face.ids} is drawn at ${rise(face.points)}/12, saved ${face.pitch}/12`);
    }
    // The upper roof keeps its own corners; the lower roof's corner and its side wall stay at the lower roof.
    assert.deepEqual(roof.faces[2].points, ['C1', 'C7', 'C8', 'C20', 'C15', 'C16', 'C17', 'C2'].map(id => roof.points[id]));
    assert.deepEqual(roof.lines.L18, [roof.points.C15, roof.points.C16]);
    assert.ok(Math.max(...roof.lines.L23.map(p => p[2])) < 2005, 'the lower side wall stays below the upper roof');
    assert.ok(Math.max(...roof.lines.L25.map(p => p[2])) < 2006, 'the lower head wall stays below the upper roof');
  } finally { await browser.close(); }
});

