// FM-574: a company measuring in metric saw feet, square feet and squares in the portal's 3D model viewer. The viewer
// keeps everything in feet as the report stores and edits it, and a metric report shows (and takes) m and m², as its
// PDF converts them (report-units.js: 1 ft = 0.3048 m, up to two decimals). Imperial output is unchanged.
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

test('metric units convert the report\'s feet the way report-units.js does; imperial is the report\'s own text', async () => {
  const V = await viewer();
  const imperial = V.viewerUnits('imperial'), metric = V.viewerUnits('metric');
  assert.equal(V.viewerUnits(undefined).metric, false, 'no measurement system is imperial');
  // Imperial: exactly what the viewer printed before.
  assert.equal(imperial.lineLabel(12.5), '13′');
  assert.equal(imperial.lineLabel(12.34, true), '12.3′');
  assert.equal(imperial.roofLength(12.5), '13 ft');
  assert.equal(imperial.area(1234.4, 0), '1,234 sq ft');
  assert.equal(imperial.faceArea(521), '6 sq');
  assert.equal(imperial.legendLength(34.99, false, false), '35');
  assert.equal(imperial.pitchSquares(5.2097), '5.21');
  assert.equal(imperial.totalSquares(17.333), '17.33');
  assert.equal(imperial.openingSize(3, 4.25), '3.0 × 4.3 ft');
  assert.equal(imperial.obstacleSize([4, 4.7]), '4 × 5 ft');
  assert.equal(imperial.fromLength(10), 10);
  // Metric: the same quantities in metres, two decimals at most, never "ft", "sq ft" or "sq".
  const units = await source('libraries/report-units.js');
  const context = {module: {exports: {}}, globalThis: {}};
  vm.createContext(context); vm.runInContext(units, context);
  const R = context.module.exports.create({measurement_system: 'metric'});
  assert.equal(metric.roofLength(34.99), R.quantity(34.99, 'ft'), 'a length reads as the PDF prints it');
  assert.equal(metric.area(1234.4), R.quantity(1234.4, 'sf'));
  assert.equal(metric.totalSquares(17.333), R.quantity(17.333, 'sq'));
  assert.equal(metric.lineLabel(30), '9.14 m');
  assert.equal(metric.faceArea(521), '48.4 m²');
  assert.equal(metric.faceArea(null), null);
  assert.equal(metric.legendLength(4000, false, false), '1219.2', 'an input value has no grouping');
  assert.equal(metric.pitchSquares(5.2097), '48.4');
  assert.equal(metric.openingSize(3, 4.25), '0.91 × 1.3 m');
  assert.equal(metric.obstacleSize([4, 4.7]), '1.22 × 1.52 m');
  assert.ok(Math.abs(metric.fromLength(10) - 10 / 0.3048) < 1e-12);
  assert.ok(Math.abs(metric.fromSquares(48.4) - 48.4 / 9.290304) < 1e-12);
});

test('a metric report\'s viewer shows m and m² in the key, Pitches, Summary and the face card, and stores edits in feet', async () => {
  const xml = '<ROOT><ROOF><POINT id="a" data="0,0,0"/><POINT id="b" data="30,0,0"/><POINT id="c" data="30,15,9"/><POINT id="d" data="0,15,9"/><LINE id="ab" path="b,a" type="EAVE"/><LINE id="bc" path="b,c" type="RAKE"/><LINE id="cd" path="d,c" type="RIDGE"/><LINE id="da" path="d,a" type="RAKE"/><FACE><POLYGON path="ab,bc,cd,da" pitch="7" size="521"/></FACE></ROOF></ROOT>';
  const browser = await chromium.launch({executablePath: process.env.CHROME_PATH || 'C:/Program Files/Google/Chrome/Application/chrome.exe', headless: true, args: ['--enable-webgl', '--use-angle=swiftshader']});
  try {
    const page = await browser.newPage({viewport: {width: 380, height: 560}}), errors = [];
    page.on('pageerror', e => errors.push(e.message));
    await page.route(url => url.host === 'roof.test', route => route.fulfill(route.request().url().includes('/measure/internal/') ? {status: 404, body: ''} : route.request().url().endsWith('.xml') ? {contentType: 'application/xml', body: xml} : {contentType: 'text/html', body: '<style>body{margin:0;font-family:Arial}#viewer{width:360px;height:500px}</style><div id="viewer"></div>'}));
    await page.goto('http://roof.test/');
    await page.addScriptTag({content: await source('libraries/apps/measurements/roof-viewer.js')});
    await page.addScriptTag({url: 'https://cdnjs.cloudflare.com/ajax/libs/three.js/r128/three.min.js'});
    await page.evaluate(() => { window.edits = []; window.viewer = FirstMeasureRoofViewer.mount(document.querySelector('#viewer'), {xmlUrl: '/model.xml', standalone: true, measurementSystem: 'metric', initialState: {area: true}, onMeasurementChange: (key, value) => window.edits.push([key, value])}); });
    await page.waitForFunction(() => document.querySelector('.fm-roof-canvas canvas') && document.querySelector('.fm-roof-message').hidden, {}, {timeout: 45000});
    const legend = name => page.getByRole('textbox', {name: name + ' length', exact: true});
    assert.equal(await legend('Ridge').inputValue(), '9.14', '30 ft of ridge');
    assert.equal(await legend('Rake').inputValue(), '10.66', 'two 17.49 ft rakes, 34.99 ft');
    const units = await page.locator('.fm-roof-key-row small').allTextContents();
    assert.ok(units.length && units.every(unit => unit === 'm'), JSON.stringify(units));
    assert.equal(await legend('Ridge').getAttribute('title'), 'Ridge · metres');
    assert.equal(await page.locator('[data-area]').getAttribute('title'), 'Area labels (m²)');
    // An edit typed in metres is stored in feet, and shown back as typed.
    await legend('Ridge').fill('10'); await legend('Ridge').press('Tab');
    assert.equal(await legend('Ridge').inputValue(), '10');
    const [[key, feet]] = await page.evaluate(() => window.edits);
    assert.match(key, /ridge/i); assert.ok(Math.abs(feet - 10 / 0.3048) < 1e-9, String(feet));
    await page.getByRole('tab', {name: 'Pitches', exact: true}).click();
    assert.equal(await page.locator('.fm-roof-pitches th[scope=row]').nth(1).innerText(), 'm²');
    assert.equal(await page.getByRole('textbox', {name: '7/12 pitch area', exact: true}).inputValue(), '48.4', '5.21 squares');
    await page.getByRole('tab', {name: 'Summary', exact: true}).click();
    const summary = await page.locator('.fm-roof-summary').innerText();
    assert.match(summary, /Roof area\s+48\.4 m²/, summary);
    assert.doesNotMatch(summary, /squares|sq ft|\bft\b/i, summary);
    // The face card.
    const box = await page.locator('.fm-roof-canvas canvas').boundingBox();
    await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
    await page.waitForSelector('[data-card]:not([hidden])');
    const card = await page.locator('[data-card] dl').innerText();
    assert.match(card, /Area\s+48\.4 m²/, card);
    assert.doesNotMatch(card, /\bsq\b|\bft\b/, card);
    assert.deepEqual(errors, []);
    await page.evaluate(() => window.viewer.destroy());
  } finally { await browser.close(); }
});
