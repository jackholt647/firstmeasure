// The roof viewer shows the delivered report's own numbers, rounded as the report rounds them, and never more precise.
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
const plan = ring => Math.abs(ring.reduce((sum, p, i) => { const q = ring[(i + 1) % ring.length]; return sum + p[0] * q[1] - q[0] * p[1]; }, 0)) / 2;
const slope = rise => Math.sqrt(1 + (rise / 12) ** 2);
// A face as model_data.xml carries it: feet, pitch = Math.round(rise), size = Math.round(outline less holes, sloped).
function xmlFace(outline, holes, rise) {
  const z = ([x, y]) => [x, y, y * rise / 12];
  return {points: outline.map(z), holes: holes.map(h => h.map(z)), pitch: Math.round(rise), area: Math.round((plan(outline) - holes.reduce((s, h) => s + plan(h), 0)) * slope(rise))};
}
// The report's Area Diagram label for that face: Math.round of the sloped outline, holes not taken off.
const reportLabel = (outline, rise) => Math.round(plan(outline) * slope(rise));

test('the report rounding the viewer copies is still the report generator\'s rounding', async () => {
  const pdf = await source('measure/internal/editor_scripts/pdf.js');
  const xml = await source('measure/internal/editor_scripts/xml_generator.js');
  const exterior = await source('measure/internal/editor_scripts/exterior_pdf.js');
  // Face area: whole square feet of the outline (no hole subtraction) at the face's pitch.
  assert.match(pdf, /const areaPx = Math\.abs\(getSignedArea\(face\.points\)\);[\s\S]{0,1600}lbl\.areaText = `\$\{Math\.round\(areaSqFt\)\}`;/);
  assert.match(xml, /size="\$\{Math\.round\(areaSqFt\)\}"/);
  assert.match(xml, /const pitch = Math\.max\(0, Math\.round\(Math\.abs\(pitchRise12\)\)\);/);
  // Roof lines: whole feet. Wall edges and openings: one decimal.
  assert.match(pdf, /text: pdfMeasure\(line\.length, "ft", Math\.round\(line\.length\)\.toString\(\)\)/);
  assert.match(exterior, /const number=v=>v>0&&v<\.05\?'<0\.1':Number\(v\|\|0\)\.toLocaleString\([\s\S]{0,80}?\{minimumFractionDigits:1,maximumFractionDigits:1\}\)/);
  // Flat roofing is 2/12 and under on the whole-number pitch.
  assert.match(pdf, /function splitSquaresByPitch\(squaresData, threshold\) \{\s*if \(threshold === undefined\) threshold = 2;[\s\S]{0,400}if \(rise <= threshold\)/);
});

test('a face shows the report\'s square feet as whole squares rounded up', async () => {
  const V = await viewer();
  // No holes: size= is the report label exactly.
  const plain = xmlFace([[0, 0], [30, 0], [30, 15], [0, 15]], [], 7);
  assert.equal(V.reportFaceSqFt(plain), reportLabel([[0, 0], [30, 0], [30, 15], [0, 15]], 7));
  assert.equal(V.reportSquares(V.reportFaceSqFt(plain)), Math.ceil(plain.area / 100));
  // A chimney hole: the XML's size is net, the report's label is the whole outline. Here they straddle 400 sq ft:
  // net rounds up to 4 squares, the report's 410 sq ft to 5, and the viewer must say 5.
  const outline = [[0, 0], [24.5, 0], [24.5, 15], [0, 15]], chimney = [[10, 5], [13.5, 5], [13.5, 8.5], [10, 8.5]];
  const holed = xmlFace(outline, [chimney], 6);
  assert.ok(holed.area <= 400 && reportLabel(outline, 6) > 400, `${holed.area} / ${reportLabel(outline, 6)}`);
  assert.equal(V.reportFaceSqFt(holed), reportLabel(outline, 6));
  assert.equal(V.reportSquares(V.reportFaceSqFt(holed)), 5);
  // A hand-set fractional pitch (6.5/12) the XML writes as 7: the slope is recovered from size= and the label still matches.
  const odd = xmlFace(outline, [chimney], 6.5);
  assert.equal(odd.pitch, 7);
  assert.equal(V.reportFaceSqFt(odd), reportLabel(outline, 6.5));
  // Whole squares, always up; 400 is exactly 4.
  assert.deepEqual([1, 99, 100, 101, 400, 401, 1299].map(V.reportSquares), [1, 1, 1, 2, 4, 5, 13]);
  assert.equal(V.reportSquares(null), null);
});

test('line lengths carry the report\'s precision and no more', async () => {
  const V = await viewer();
  assert.deepEqual([12.49, 12.5, 0.4, 166.48].map(V.reportRoofFeet), [12, 13, 0, 166]);
  assert.deepEqual([12.34, 3, 0.04, 0].map(V.reportWallFeet), ['12.3', '3.0', '<0.1', '0.0']);
  assert.deepEqual([0, 1, 2, 2.4, 2.5, 3, 7].map(V.isLowSlope), [true, true, true, true, false, false, false]);
});

test('the selected face card shows only whole squares, at the lower right clear of the tools', async () => {
  const xml = '<ROOT><ROOF><POINT id="a" data="0,0,0"/><POINT id="b" data="30,0,0"/><POINT id="c" data="30,15,9"/><POINT id="d" data="0,15,9"/><LINE id="ab" path="b,a" type="EAVE"/><LINE id="bc" path="b,c" type="RAKE"/><LINE id="cd" path="d,c" type="RIDGE"/><LINE id="da" path="d,a" type="RAKE"/><FACE><POLYGON path="ab,bc,cd,da" pitch="7" size="521"/></FACE></ROOF></ROOT>';
  const browser = await chromium.launch({executablePath: process.env.CHROME_PATH || 'C:/Program Files/Google/Chrome/Application/chrome.exe', headless: true, args: ['--enable-webgl', '--use-angle=swiftshader']});
  try {
    const page = await browser.newPage({viewport: {width: 380, height: 560}}), errors = [];
    page.on('pageerror', e => errors.push(e.message));
    await page.route(url => url.host === 'roof.test', route => route.fulfill(route.request().url().includes('/measure/internal/') ? {status: 404, body: ''} : route.request().url().endsWith('.xml') ? {contentType: 'application/xml', body: xml} : {contentType: 'text/html', body: '<style>body{margin:0;font-family:Arial}#viewer{width:360px;height:500px}</style><div id="viewer"></div>'}));
    await page.goto('http://roof.test/');
    await page.addScriptTag({content: await source('libraries/apps/measurements/roof-viewer.js')});
    await page.addScriptTag({url: 'https://cdnjs.cloudflare.com/ajax/libs/three.js/r128/three.min.js'});
    await page.evaluate(() => { const Renderer = THREE.WebGLRenderer; THREE.WebGLRenderer = function (options) { const renderer = new Renderer(options), render = renderer.render; renderer.render = function (scene, camera) { window.drawnScene = scene; window.drawnCamera = camera; return render.call(renderer, scene, camera); }; return renderer; }; });
    await page.evaluate(() => { window.viewer = FirstMeasureRoofViewer.mount(document.querySelector('#viewer'), {xmlUrl: '/model.xml', standalone: true, initialState: {area: true}}); });
    await page.waitForFunction(() => document.querySelector('.fm-roof-canvas canvas') && document.querySelector('.fm-roof-message').hidden, {}, {timeout: 45000});
    const box = await page.locator('.fm-roof-canvas canvas').boundingBox();
    await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
    await page.waitForSelector('[data-card]:not([hidden])');
    const card = await page.locator('[data-card] dl').innerText();
    assert.match(card, /Area\s+6 sq/, card);
    assert.doesNotMatch(card, /sq ft|\./, 'no square feet and no decimals');
    const [cardBox, toolsBox, help] = await Promise.all(['[data-card]', '.fm-roof-tools', '.fm-roof-help-button'].map(s => page.locator(s).boundingBox()));
    assert.ok(cardBox.y > toolsBox.y + toolsBox.height, 'the card is below the tools');
    assert.ok(cardBox.x + cardBox.width > box.x + box.width - 16 && cardBox.y + cardBox.height > box.y + box.height - 16, 'the card is in the lower right of the model');
    assert.ok(cardBox.width <= 220, `the card is narrow (${cardBox.width})`);
    assert.ok(help.x < box.x + 20 && help.y + help.height > box.y + box.height - 20, 'the info button is in the lower left');
    // Labels keep one on-screen size at any zoom: the same pixel height before and after zooming in and out.
    const labelPx = () => page.evaluate(() => { const height = document.querySelector('.fm-roof-canvas').clientHeight, sizes = new Set(); drawnScene.traverse(o => { if (o.isSprite && o.visible) { sizes.add(Math.round(o.scale.y * height / (2 * Math.tan(drawnCamera.fov * Math.PI / 360)) * 10) / 10); if (o.material.sizeAttenuation !== false) sizes.add('attenuated'); } }); return [...sizes]; });
    const before = await labelPx();
    assert.deepEqual(before, [18]);
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    for (let i = 0; i < 6; i++) await page.mouse.wheel(0, -240);
    await page.waitForTimeout(200);
    assert.deepEqual(await labelPx(), before, 'zoomed in');
    for (let i = 0; i < 12; i++) await page.mouse.wheel(0, 240);
    await page.waitForTimeout(200);
    assert.deepEqual(await labelPx(), before, 'zoomed out');
    assert.deepEqual(errors, []);
    await page.evaluate(() => window.viewer.destroy());
  } finally { await browser.close(); }
});
