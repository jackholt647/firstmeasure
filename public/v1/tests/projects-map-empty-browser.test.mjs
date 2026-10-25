import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { chromium } from 'playwright-core';

// My Projects > Map with nothing to draw: the map still starts (at the US default
// view the Project Map app uses) and the tray explains why it is empty.
const mapViewSource = () => readFile(new URL('../../libraries/apps/projects/map-view.js', import.meta.url), 'utf8');

async function setup(width = 1100){
  const browser = await chromium.launch({ executablePath:process.env.CHROME_PATH || 'C:/Program Files/Google/Chrome/Application/chrome.exe', headless:true });
  const page = await browser.newPage({ viewport:{ width, height:760 } });
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.setContent('<style>body{margin:0;font:14px Arial,sans-serif}#host{height:640px;padding:12px;box-sizing:border-box}</style><main id="host"></main>');
  await page.evaluate(() => {
    window.mapOptions = [];
    class OverlayView { setMap(){} getProjection(){ return null; } getPanes(){ return { overlayMouseTarget:document.body }; } }
    class GoogleMap {
      constructor(el, options){ window.mapOptions.push({ center:options.center, zoom:options.zoom }); }
      addListener(){} getProjection(){ return null; } getZoom(){ return 4; } setMapTypeId(){} moveCamera(){ window.cameraMoved = true; } fitBounds(){ window.cameraMoved = true; }
    }
    window.google = { maps:{ Map:GoogleMap, OverlayView, LatLngBounds:class { extend(){} }, LatLng:class {}, event:{ trigger(){}, addListenerOnce(){} }, ControlPosition:{} } };
  });
  await page.addScriptTag({ content:await mapViewSource() });
  return { browser, page, errors };
}
const draw = (page, model) => page.evaluate((model) => window.FirstMateProjectsMap.update(document.querySelector('#host'), { groups:[], groupLabel:'stage', scopeKey:'board:sales', ...model }), model);

test('an organization with no projects sees a map with an empty tray', async () => {
  const { browser, page, errors } = await setup();
  try {
    await draw(page, { items:[], empty:'none' });
    await page.locator('.pm-empty.is-view').getByText('No projects yet', { exact:true }).waitFor();
    await page.waitForFunction(() => window.mapOptions.length === 1);
    assert.deepEqual(await page.evaluate(() => window.mapOptions[0]), { center:{ lat:39.8283, lng:-98.5795 }, zoom:4 });
    assert.equal(await page.evaluate(() => !!window.cameraMoved), false);
    assert.equal(await page.locator('.pm-canvas').count(), 1);
    assert.equal(await page.locator('.pm-status').isHidden(), true);
    assert.equal(await page.locator('.pm-tray-title strong').textContent(), 'Projects');
    assert.equal(await page.locator('.pm-tray-sub').textContent(), '');
    assert.doesNotMatch(await page.locator('#host').innerText(), /New Project/);
    assert.deepEqual(errors, []);
  } finally { await browser.close(); }
});

test('with no projects, New project sits under the message and starts one', async () => {
  const { browser, page, errors } = await setup();
  try {
    await page.evaluate(() => { window.created = 0; });
    await page.evaluate(() => window.FirstMateProjectsMap.update(document.querySelector('#host'), { groups:[], groupLabel:'stage', scopeKey:'board:sales', items:[], empty:'none', create:() => { window.created += 1; } }));
    const empty = page.locator('.pm-empty.is-view');
    await empty.getByText('No projects yet', { exact:true }).waitFor();
    const button = empty.getByRole('button', { name:'New project' });
    await button.waitFor();
    const [title, action] = await Promise.all([empty.locator('strong').boundingBox(), button.boundingBox()]);
    assert.ok(action.y > title.y + title.height - 1, 'the button is under the message');
    await button.click();
    assert.equal(await page.evaluate(() => window.created), 1);
    await draw(page, { items:[], empty:'filtered' });
    await page.locator('.pm-empty.is-view').getByText('Nothing matches these filters', { exact:true }).waitFor();
    assert.equal(await page.getByRole('button', { name:'New project' }).count(), 0, 'filters that leave nothing do not offer it');
    assert.deepEqual(errors, []);
  } finally { await browser.close(); }
});

test('filters that leave nothing say so, and projects replace the empty state', async () => {
  const { browser, page, errors } = await setup();
  try {
    await draw(page, { items:[], empty:'filtered' });
    await page.locator('.pm-empty.is-view').getByText('Nothing matches these filters', { exact:true }).waitFor();
    await draw(page, { items:[{ id:'p1', title:'Ada Lovelace', line1:'1 Main St', address:'1 Main St', groupId:'lead', groupTitle:'Lead', color:'#f59e0b', point:{ lat:30.26, lng:-97.74 } }], groups:[{ id:'lead', title:'Lead', color:'#f59e0b' }] });
    await page.locator('.pm-row').getByText('Ada Lovelace').waitFor();
    assert.equal(await page.locator('.pm-empty').count(), 0);
    assert.equal(await page.locator('.pm-tray-title strong').textContent(), '1 project');
    assert.deepEqual(errors, []);
  } finally { await browser.close(); }
});

test('on a phone the empty tray peeks over the map without overflowing', async () => {
  const { browser, page, errors } = await setup(390);
  try {
    await draw(page, { items:[], empty:'none' });
    await page.locator('.pm-tray-head').waitFor();
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
    await page.locator('.pm-tray-toggle').click();
    await page.locator('.pm-empty.is-view').getByText('No projects yet', { exact:true }).waitFor({ state:'visible' });
    assert.deepEqual(errors, []);
  } finally { await browser.close(); }
});
