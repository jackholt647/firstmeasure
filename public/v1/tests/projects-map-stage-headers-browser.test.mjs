import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { chromium } from 'playwright-core';

// GP-114: My Projects > Map lists its projects under a collapsible header per stage
// (or board), in stage order, instead of a row of filter pills. A collapsed header
// hides its projects from the list and the map, and stays collapsed next time.
const mapViewSource = () => readFile(new URL('../../libraries/apps/projects/map-view.js', import.meta.url), 'utf8');

async function setup(){
  const browser = await chromium.launch({ executablePath:process.env.CHROME_PATH || 'C:/Program Files/Google/Chrome/Application/chrome.exe', headless:true });
  const context = await browser.newContext({ viewport:{ width:1100, height:760 } });
  const errors = [];
  const open = async () => {
    const page = await context.newPage();
    page.on('pageerror', (error) => errors.push(error.message));
    // localStorage needs a real origin; the page itself is served from here.
    await page.route('https://map.test/**', (route) => route.fulfill({ contentType:'text/html', body:'<style>body{margin:0;font:14px Arial,sans-serif}#host{height:640px;padding:12px;box-sizing:border-box}</style><main id="host"></main>' }));
    await page.goto('https://map.test/');
    await page.evaluate(() => {
      window.__APP = { userOrgId:'org_a', userId:'user_a' };
      // The pin layer is attached at once so its markers are in the page.
      class OverlayView { setMap(){ this.onAdd?.(); } getProjection(){ return null; } getPanes(){ return { overlayMouseTarget:document.body }; } }
      class GoogleMap { addListener(){} getProjection(){ return null; } getZoom(){ return 4; } setMapTypeId(){} moveCamera(){} fitBounds(){} }
      window.google = { maps:{ Map:GoogleMap, OverlayView, LatLngBounds:class { extend(){} }, LatLng:class {}, event:{ trigger(){}, addListenerOnce(){} }, ControlPosition:{} } };
    });
    await page.addScriptTag({ content:await mapViewSource() });
    return page;
  };
  return { browser, open, errors };
}

const point = (i) => ({ lat:30 + i / 100, lng:-97.74 });
const MODEL = {
  groupLabel:'stage', scopeKey:'board:sales',
  // The viewer's stage order; the items arrive in its project order, not by stage.
  groups:[{ id:'lead', title:'New lead', color:'#2563eb' }, { id:'proposal', title:'Proposal', color:'#ea580c' }, { id:'won', title:'Won', color:'#16a34a' }],
  items:[
    { id:'p1', title:'Ada', line1:'1 Main St', address:'1 Main St', groupId:'proposal', groupTitle:'Proposal', color:'#ea580c', point:point(1) },
    { id:'p2', title:'Ben', line1:'', groupId:'lead', groupTitle:'New lead', color:'#2563eb' },
    { id:'p3', title:'Cy', line1:'3 Oak Ave', address:'3 Oak Ave', groupId:'lead', groupTitle:'New lead', color:'#2563eb', point:point(3) },
    { id:'p4', title:'Di', line1:'4 Elm Rd', address:'4 Elm Rd', groupId:'won', groupTitle:'Won', color:'#16a34a', point:point(4) }
  ]
};
const draw = (page, model = MODEL) => page.evaluate((model) => window.FirstMateProjectsMap.update(document.querySelector('#host'), model), model);
const listed = (page) => page.locator('.pm-list').evaluate((list) => [...list.querySelectorAll('.pm-group-head, .pm-row')].map((el) => el.classList.contains('pm-group-head') ? `# ${el.querySelector('.pm-group-title').textContent} ${el.querySelector('.pm-group-count').textContent} ${el.getAttribute('aria-expanded')}` : el.dataset.id));
const pins = (page) => page.evaluate(() => [...document.querySelectorAll('.pm-marker:not(.is-leaving)')].map((el) => el.dataset.id).sort());

test('projects are listed under a header per stage, in stage order, with no filter pills', async () => {
  const { browser, open, errors } = await setup();
  try {
    const page = await open();
    await draw(page);
    await page.locator('.pm-group-head').first().waitFor();
    // Located projects first in each stage, then those without a location.
    assert.deepEqual(await listed(page), ['# New lead 2 true', 'p3', 'p2', '# Proposal 1 true', 'p1', '# Won 1 true', 'p4']);
    assert.equal(await page.locator('.pm-legend, .pm-chip, .pm-section').count(), 0);
    await page.waitForFunction(() => document.querySelectorAll('.pm-marker').length === 3);
    assert.deepEqual(await pins(page), ['p1', 'p3', 'p4']);
    assert.deepEqual(errors, []);
  } finally { await browser.close(); }
});

test('a collapsed header hides its stage from the list and the map, and stays collapsed next time', async () => {
  const { browser, open, errors } = await setup();
  try {
    const page = await open();
    await draw(page);
    await page.waitForFunction(() => document.querySelectorAll('.pm-marker').length === 3);
    await page.locator('.pm-row[data-id="p3"]').click();
    const lead = page.locator('.pm-group-head[data-group="lead"]');
    await lead.click();
    assert.deepEqual(await listed(page), ['# New lead 2 false', '# Proposal 1 true', 'p1', '# Won 1 true', 'p4']);
    assert.deepEqual(await pins(page), ['p1', 'p4']);
    assert.equal(await page.locator('.pm-preview').count(), 0, 'a selected project in a collapsed stage is let go');
    assert.equal(await page.evaluate(() => document.activeElement?.dataset.group), 'lead', 'the keyboard stays on the header');
    // The tray still counts every project; the line under it is about the expanded stages.
    assert.equal(await page.locator('.pm-tray-title strong').textContent(), '4 projects');
    await page.locator('.pm-tray-sub').getByText('All on the map').waitFor();
    await page.keyboard.press('Enter');
    assert.deepEqual(await listed(page), ['# New lead 2 true', 'p3', 'p2', '# Proposal 1 true', 'p1', '# Won 1 true', 'p4']);
    await page.locator('.pm-group-head[data-group="won"]').click();
    assert.deepEqual(await pins(page), ['p1', 'p3']);

    const again = await open();
    await draw(again);
    await again.locator('.pm-group-head').first().waitFor();
    assert.deepEqual(await listed(again), ['# New lead 2 true', 'p3', 'p2', '# Proposal 1 true', 'p1', '# Won 1 false']);
    // Each board remembers its own headers.
    await draw(again, { ...MODEL, scopeKey:'board:production' });
    assert.deepEqual((await listed(again)).filter((entry) => entry.startsWith('#')), ['# New lead 2 true', '# Proposal 1 true', '# Won 1 true']);
    assert.deepEqual(errors, []);
  } finally { await browser.close(); }
});

test('with all boards shown, the headers are the boards', async () => {
  const { browser, open, errors } = await setup();
  try {
    const page = await open();
    await draw(page, {
      groupLabel:'board', scopeKey:'board:all',
      groups:[{ id:'sales', title:'Sales', color:'#2563eb' }, { id:'production', title:'Production', color:'#7c3aed' }],
      items:[
        { id:'p1', title:'Ada', groupId:'production', groupTitle:'Production', color:'#7c3aed', point:point(1) },
        { id:'p2', title:'Ben', groupId:'sales', groupTitle:'Sales', color:'#2563eb', point:point(2) }
      ]
    });
    await page.locator('.pm-group-head').first().waitFor();
    assert.deepEqual(await listed(page), ['# Sales 1 true', 'p2', '# Production 1 true', 'p1']);
    assert.deepEqual(errors, []);
  } finally { await browser.close(); }
});
