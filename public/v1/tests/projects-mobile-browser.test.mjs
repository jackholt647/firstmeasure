import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { chromium } from 'playwright-core';

// My Projects on a phone (390x844, a mobile user agent) and on a desktop: the real
// viewer.js and map-view.js mounted in a stub portal with three projects on one board.
const source = (path) => readFile(new URL(`../../libraries/apps/projects/${path}`, import.meta.url), 'utf8');
const MOBILE_UA = 'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Mobile Safari/537.36';

async function setup({ mobile = true, view = 'stages', camera = true } = {}){
  const browser = await chromium.launch({ executablePath:process.env.CHROME_PATH || 'C:/Program Files/Google/Chrome/Application/chrome.exe', headless:true });
  const context = await browser.newContext(mobile
    ? { viewport:{ width:390, height:844 }, userAgent:MOBILE_UA, isMobile:true, hasTouch:true }
    : { viewport:{ width:1280, height:800 } });
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.setContent('<meta name="viewport" content="width=device-width, initial-scale=1"><style>html,body{margin:0;height:100%;font:14px Arial,sans-serif}.main-panels{height:100%;box-sizing:border-box;padding:12px;overflow:auto}</style><div class="main-panels" id="mainPanels"><div class="fm-tabpanel active" id="tab_viewer" style="height:100%"></div></div>');
  await page.evaluate(({ view, camera }) => {
    const projects = [
      { id:'p1', address:'1 Main St, Austin, TX 78701', title:'1 Main St, Austin, TX 78701', lat:30.26, lng:-97.74, created_at:'2026-10-01 10:00:00', status:'project' },
      { id:'p2', address:'2 Oak Ave, Austin, TX 78702', title:'Ada Lovelace', customer_name:'Ada Lovelace', lat:30.27, lng:-97.73, created_at:'2026-10-02 10:00:00', status:'project' },
      { id:'p3', address:'3 Elm Rd, Austin, TX 78703', title:'3 Elm Rd, Austin, TX 78703', lat:30.3, lng:-97.7, created_at:'2026-10-03 10:00:00', status:'project' }
    ];
    const board = { id:'sales', title:'Sales', color:'#2563eb', columns:[
      { id:'lead', title:'Lead', color:'#f59e0b', cards:[{ project_id:'p1' }, { project_id:'p2' }] },
      { id:'won', title:'Won', color:'#16a34a', cards:[{ project_id:'p3' }] }
    ] };
    const flags = { platform:{ project_boards:true, project_stages_view:true, expanded_access:true }, apps:{ project_map:true } };
    window.opened = [];
    window.cameraCalls = [];
    window.__APP = { userOrgId:'org_test', userId:'user_test' };
    if (camera) window.FirstMateCamera = { open(options){ window.cameraCalls.push(options); return { close(){} }; } };
    class OverlayView { setMap(){ this.onAdd?.(); } getProjection(){ return null; } getPanes(){ return { overlayMouseTarget:document.querySelector('.pm-canvas') }; } }
    class GoogleMap { constructor(){ } addListener(){} getProjection(){ return null; } getZoom(){ return 12; } getCenter(){ return null; } setMapTypeId(){} moveCamera(){} fitBounds(){} }
    window.google = { maps:{ Map:GoogleMap, OverlayView, LatLngBounds:class { extend(){} }, LatLng:class {}, event:{ trigger(){}, addListenerOnce(){} }, ControlPosition:{} } };
    const css = new Map();
    window.Portal = {
      util:{
        $:(selector, root = document) => root.querySelector(selector),
        escapeHtml:(value) => String(value ?? '').replace(/[&<>"']/g, (c) => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' }[c])),
        injectCSS:(id, text) => { if (css.has(id)) return; const style = document.createElement('style'); style.textContent = text; document.head.appendChild(style); css.set(id, style); },
        formatDate:(value) => String(value || ''),
        postAction:async (action) => ({ data:action === 'list_projects' ? { projects:projects.map((p) => ({ ...p })) } : {} }),
        enableSafeBackdropClose(){}, fmJson:async () => ({}), fmPost:async () => ({}), fmUrl:(path) => `/v1/${path}`, googleMapsApiKey:() => '', currentActor:() => ({}),
        hasPerm:() => false
      },
      apps:{ registerPortalApp(app){ window.viewerApp = app; } },
      appFlags:{ value:(group, key, fallback) => (flags[group] && key in flags[group] ? flags[group][key] : fallback) },
      navigation:{ read:() => ({ projectView:view }) },
      routeState:{ set(){} },
      currentUser:{ id:'user_test', permissions:{}, appEntitlements:[] },
      credits:{ refreshCredits(){} },
      ProjectViewer:{ renderTabs(){} },
      // The project window: record what opens.
      modules:{ request:{ openProject:(project) => window.opened.push(project.id) } }
    };
    window.PlatformAPI = { work:{ boards:async () => ({ boards:[board] }) } };
  }, { view, camera });
  await page.addScriptTag({ content:await source('map-view.js') });
  await page.addScriptTag({ content:await source('viewer.js') });
  await page.evaluate(() => window.viewerApp.mount(document.querySelector('#tab_viewer')));
  return { browser, page, errors };
}

const cameraIds = (page) => page.evaluate(() => window.cameraCalls.map((call) => [call.projectId, call.projectTitle, call.orgId, typeof call.onDone]));

test('on a phone the title is the top bar\'s: one compact row of icon view buttons and Manage view', async () => {
  const { browser, page, errors } = await setup({ view:'list' });
  try {
    await page.locator('.v-lrow[data-id="p1"]').waitFor();
    assert.equal(await page.locator('.v-title').isVisible(), false, 'no second title or icon in the content');
    const labels = await page.locator('.v-view-switch .v-btn .btn-label').evaluateAll((els) => els.filter((el) => el.offsetParent).length);
    assert.equal(labels, 0, 'view buttons are icons');
    assert.deepEqual(await page.locator('.v-view-switch .v-btn:not([hidden])').evaluateAll((els) => els.map((el) => [el.getAttribute('aria-label'), el.getAttribute('data-fm-tooltip')])), [['Stages', 'Stages'], ['List', 'List'], ['Tiles', 'Tiles'], ['Map', 'Map']]);
    const [switcher, manage] = await Promise.all([page.locator('.v-view-switch').boundingBox(), page.locator('#vManageView').boundingBox()]);
    assert.ok(Math.abs(switcher.y + switcher.height / 2 - (manage.y + manage.height / 2)) < 2, 'one row');
    assert.ok(manage.height <= 40 && switcher.height <= 40);
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
    await page.locator('#vManageView').click();
    await page.locator('#vManageViewPanel').waitFor({ state:'visible' });
    const panel = await page.locator('#vManageViewPanel').boundingBox();
    assert.ok(panel.x >= 0 && panel.x + panel.width <= 390, 'Manage view fits the phone');
    assert.deepEqual(errors, []);
  } finally { await browser.close(); }
});

test('the camera on a Stages card, a List row and a Tiles card opens the camera for that project and never the project', async () => {
  const { browser, page, errors } = await setup({ view:'stages' });
  try {
    await page.locator('.v-stage-col.is-mobile-active .v-stage-card[data-id="p2"]').waitFor();
    await page.locator('.v-stage-card[data-id="p2"] [data-v-camera]').click();
    assert.deepEqual(await cameraIds(page), [['p2', 'Ada Lovelace', 'org_test', 'function']]);
    assert.deepEqual(await page.evaluate(() => window.opened), [], 'the project did not open');
    await page.locator('#vViewList').click();
    await page.locator('.v-lrow[data-id="p1"] [data-v-camera]').click();
    await page.locator('#vViewTiles').click();
    await page.locator('.v-tile[data-id="p3"] [data-v-camera]').click();
    assert.deepEqual((await cameraIds(page)).map(([id, title]) => [id, title]), [['p2', 'Ada Lovelace'], ['p1', '1 Main St'], ['p3', '3 Elm Rd']]);
    assert.deepEqual(await page.evaluate(() => window.opened), []);
    // The keyboard reaches it too, and the card itself still opens the project.
    await page.locator('#vViewStages').click();
    await page.locator('.v-stage-card[data-id="p1"] [data-v-camera]').focus();
    await page.keyboard.press('Enter');
    assert.equal((await cameraIds(page)).length, 4);
    assert.deepEqual(await page.evaluate(() => window.opened), []);
    await page.locator('.v-stage-card[data-id="p1"] .v-stage-name').click();
    assert.deepEqual(await page.evaluate(() => window.opened), ['p1'], 'the card itself still opens the project');
    // New photos fill a tile that has no picture yet, in place.
    await page.locator('#vViewTiles').click();
    await page.route('https://photos.test/**', (route) => route.fulfill({ contentType:'image/gif', body:Buffer.from('R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7', 'base64') }));
    await page.evaluate(() => window.cameraCalls[2].onDone([{ id:'m1', thumb:'https://photos.test/new-photo-thumb.jpg' }]));
    await page.waitForFunction(() => document.querySelector('.v-tile[data-id="p3"] .v-thumb img')?.complete);
    assert.equal(await page.locator('.v-tile[data-id="p3"] .v-thumb img').getAttribute('src'), 'https://photos.test/new-photo-thumb.jpg');
    // A tile that already shows a picture keeps it.
    await page.evaluate(() => window.cameraCalls[2].onDone([{ id:'m2', thumb:'https://photos.test/second.jpg' }]));
    assert.equal(await page.locator('.v-tile[data-id="p3"] .v-thumb img').getAttribute('src'), 'https://photos.test/new-photo-thumb.jpg');
    assert.deepEqual(errors, []);
  } finally { await browser.close(); }
});

test('the map pin preview on a phone: Open project is an icon, the camera sits beside it, both work', async () => {
  const { browser, page, errors } = await setup({ view:'map' });
  try {
    await page.locator('.pm-row[data-id="p2"]').waitFor({ state:'attached' });
    // The map fills the content area, edge to edge, with the controls floating over it.
    assert.equal(await page.evaluate(() => getComputedStyle(document.querySelector('#mainPanels')).paddingTop), '0px');
    const [root, wrap] = await Promise.all([page.locator('.pm-root').boundingBox(), page.locator('.v-wrap').boundingBox()]);
    assert.deepEqual([root.x, root.y, root.width, root.height], [wrap.x, wrap.y, wrap.width, wrap.height]);
    assert.deepEqual([root.x, root.y, root.width, root.height], [0, 0, 390, 844]);
    const chrome = await page.locator('.v-actions').boundingBox();
    assert.ok(chrome.y < 30, 'the controls float at the top of the map');
    const top = await page.evaluate(() => parseFloat(getComputedStyle(document.querySelector('.v-wrap')).getPropertyValue('--pm-top')));
    assert.ok(top >= chrome.y + chrome.height - 1, 'the map knows how much the controls cover');
    const controls = await page.locator('.pm-controls').boundingBox();
    assert.ok(controls.y >= chrome.y + chrome.height, 'map controls sit below the floating row');
    // Selecting a project from the tray shows its preview.
    await page.locator('.pm-tray-toggle').click();
    await page.locator('.pm-row[data-id="p2"]').click();
    await page.evaluate(() => document.querySelector('.pm-marker[data-id="p2"] .pm-pin')?.click());
    const preview = page.locator('.pm-preview-card');
    await preview.waitFor({ state:'attached' });
    assert.equal(await page.locator('.pm-open-label').isVisible(), false, 'no words on the Open button');
    assert.equal(await page.locator('.pm-open').getAttribute('aria-label'), 'Open project');
    assert.equal(await page.locator('.pm-camera').getAttribute('aria-label'), 'Take photos');
    const [camera, open] = await Promise.all([page.locator('.pm-camera').evaluate((el) => getComputedStyle(el).display), page.locator('.pm-open').evaluate((el) => el.getBoundingClientRect().width)]);
    assert.notEqual(camera, 'none', 'the camera shows on a phone');
    assert.ok(open <= 36, 'Open project is an icon button');
    await page.locator('.pm-camera').evaluate((el) => el.click());
    assert.deepEqual((await cameraIds(page)).map(([id]) => id), ['p2']);
    assert.deepEqual(await page.evaluate(() => window.opened), []);
    await page.locator('.pm-open').evaluate((el) => el.click());
    assert.deepEqual(await page.evaluate(() => window.opened), ['p2'], 'Open project still opens it');
    assert.deepEqual(errors, []);
  } finally { await browser.close(); }
});

test('without the camera library there are no camera buttons', async () => {
  const { browser, page, errors } = await setup({ view:'list', camera:false });
  try {
    await page.locator('.v-lrow[data-id="p1"]').waitFor();
    assert.equal(await page.locator('[data-v-camera]').count(), 0);
    assert.deepEqual(errors, []);
  } finally { await browser.close(); }
});

test('on a desktop the title stays, cameras are hidden and the map is the background under a floating header', async () => {
  const { browser, page, errors } = await setup({ mobile:false, view:'map' });
  try {
    await page.locator('.pm-tray').waitFor();
    assert.equal(await page.locator('.v-title').isVisible(), true);
    assert.equal(await page.locator('.v-view-switch .btn-label').first().isVisible(), true);
    assert.equal(await page.locator('#vViewMap').getAttribute('data-fm-tooltip'), null);
    const chrome = page.locator('.v-chrome');
    const [box, style] = await Promise.all([chrome.boundingBox(), chrome.evaluate((el) => { const s = getComputedStyle(el); return { position:s.position, radius:parseFloat(s.borderTopLeftRadius), background:s.backgroundColor }; })]);
    assert.equal(style.position, 'absolute');
    assert.ok(style.radius >= 12, 'a rounded panel');
    assert.match(style.background, /rgba\(242, 244, 247, 0\.\d+\)/, 'semi-solid grey');
    const root = await page.locator('.pm-root').boundingBox();
    assert.deepEqual([root.x, root.y, root.width, root.height], [0, 0, 1280, 800], 'the map fills the content area');
    const tray = await page.locator('.pm-tray').boundingBox();
    assert.ok(tray.y >= box.y + box.height, 'the tray floats below the header');
    await page.locator('#vViewList').click();
    await page.locator('.v-lrow[data-id="p1"]').waitFor();
    assert.equal(await page.locator('[data-v-camera]').first().isVisible(), false, 'no camera on a desktop');
    assert.equal(await page.evaluate(() => getComputedStyle(document.querySelector('#mainPanels')).paddingTop), '12px', 'other views keep the page padding');
    assert.equal(await page.locator('.v-wrap.is-map').count(), 0);
    assert.deepEqual(errors, []);
  } finally { await browser.close(); }
});
