import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { chromium } from 'playwright-core';

// My Projects on a phone (390x844, a mobile user agent) and on a desktop: the real
// viewer.js and map-view.js mounted in a stub portal with three projects on one board.
const source = (path) => readFile(new URL(`../../libraries/apps/projects/${path}`, import.meta.url), 'utf8');
const MOBILE_UA = 'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Mobile Safari/537.36';

// scenario 'mixed': the board's first and last stages are empty, p2 has a picture and p4 is a
// named project on no board whose stage id is one of the board's stages.
async function setup({ mobile = true, view = 'stages', camera = true, scenario = '', size = null } = {}){
  const browser = await chromium.launch({ executablePath:process.env.CHROME_PATH || 'C:/Program Files/Google/Chrome/Application/chrome.exe', headless:true });
  const context = await browser.newContext(mobile
    ? { viewport:size || { width:390, height:844 }, userAgent:MOBILE_UA, isMobile:true, hasTouch:true }
    : { viewport:size || { width:1280, height:800 } });
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.route('https://photos.test/**', (route) => route.fulfill({ contentType:'image/gif', body:Buffer.from('R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7', 'base64') }));
  await page.setContent('<meta name="viewport" content="width=device-width, initial-scale=1"><style>html,body{margin:0;height:100%;font:14px Arial,sans-serif}.main-panels{height:100%;box-sizing:border-box;padding:12px;overflow:auto}</style><div class="main-panels" id="mainPanels"><div class="fm-tabpanel active" id="tab_viewer" style="height:100%"></div></div>');
  await page.evaluate(({ view, camera, scenario }) => {
    const projects = [
      { id:'p1', address:'1 Main St, Austin, TX 78701', title:'1 Main St, Austin, TX 78701', lat:30.26, lng:-97.74, created_at:'2026-10-01 10:00:00', status:'project' },
      { id:'p2', address:'2 Oak Ave, Austin, TX 78702', title:'Ada Lovelace', customer_name:'Ada Lovelace', lat:30.27, lng:-97.73, created_at:'2026-10-02 10:00:00', status:'project' },
      { id:'p3', address:'3 Elm Rd, Austin, TX 78703', title:'3 Elm Rd, Austin, TX 78703', lat:30.3, lng:-97.7, created_at:'2026-10-03 10:00:00', status:'project' }
    ];
    const board = { id:'sales', title:'Sales', color:'#2563eb', columns:[
      { id:'lead', title:'Lead', color:'#f59e0b', cards:[{ project_id:'p1' }, { project_id:'p2' }] },
      { id:'won', title:'Won', color:'#16a34a', cards:[{ project_id:'p3' }] }
    ] };
    if (scenario === 'mixed') {
      projects[1].thumbnail = 'https://photos.test/p2/thumbnail';
      projects.push({ id:'p4', address:'4 Pine Ct, Austin, TX 78704', title:'Pine Court roof repair', stage_id:'won', lat:30.31, lng:-97.71, created_at:'2026-10-04 10:00:00', status:'project' });
      board.columns.unshift({ id:'new', title:'New lead', color:'#667085', cards:[] });
      board.columns.push({ id:'lost', title:'Lost', color:'#ef4444', cards:[] });
    }
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
  }, { view, camera, scenario });
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
    assert.ok(open <= 40, 'Open project is an icon button');
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

// ---- Phone QA fixes (2026-10-26): each item on a phone, and the desktop left as it was. ----

// The box once the opening animations (the sheet sliding up, the preview popping in) have finished.
const rect = (page, selector) => page.locator(selector).first().evaluate(async (el) => {
  await Promise.all(document.getAnimations().filter((animation) => animation.effect?.getComputedTiming().iterations !== Infinity).map((animation) => animation.finished.catch(() => null)));
  const r = el.getBoundingClientRect();
  return { x:r.x, y:r.y, width:r.width, height:r.height, bottom:r.bottom, right:r.right };
});

test('a phone opens Stages on the first stage that has projects, and keeps a stage the person picks', async () => {
  const { browser, page, errors } = await setup({ view:'stages', scenario:'mixed' });
  try {
    await page.locator('.v-stage-col.is-mobile-active .v-stage-card[data-id="p1"]').waitFor();
    assert.equal(await page.locator('.v-stage-col.is-mobile-active').getAttribute('data-stage'), 'lead', 'not the empty New lead stage');
    assert.equal(await page.locator('.v-mobile-stage-option[aria-selected="true"]').getAttribute('data-stage'), 'lead');
    // A stage the person picks stays picked, even an empty one.
    await page.locator('.v-mobile-stage-option[data-stage="new"]').click();
    await page.locator('#vViewList').click();
    await page.locator('#vViewStages').click();
    await page.locator('.v-stage-col.is-mobile-active').waitFor();
    assert.equal(await page.locator('.v-stage-col.is-mobile-active').getAttribute('data-stage'), 'new');
    assert.deepEqual(errors, []);
  } finally { await browser.close(); }
});

test('a phone List shows the stages with projects first and folds the empty ones into one line', async () => {
  const { browser, page, errors } = await setup({ view:'list', scenario:'mixed' });
  try {
    await page.locator('.v-lrow[data-id="p1"]').waitFor();
    const order = await page.locator('#vListScroll > *').evaluateAll((els) => els.map((el) => el.dataset.stage || el.className));
    assert.deepEqual(order, ['lead', 'won', '__no_board__', 'v-list-empty-groups'], 'stages with projects, then one line for the rest');
    const toggle = page.locator('.v-list-empty-toggle');
    assert.equal(await toggle.getAttribute('aria-expanded'), 'false');
    assert.match(await toggle.innerText(), /Empty stages[\s\S]*New lead · Lost[\s\S]*2/);
    assert.equal(await page.locator('.v-list-group[data-stage="new"]').isVisible(), false);
    const line = await rect(page, '.v-list-empty-toggle');
    assert.ok(line.height <= 48, 'one line');
    await toggle.click();
    assert.equal(await page.locator('.v-list-group[data-stage="new"]').isVisible(), true, 'the empty stages can still be opened');
    assert.deepEqual(errors, []);
  } finally { await browser.close(); }
});

test('a phone names every project the same way: its name, then its address beneath (List, Tiles, Map)', async () => {
  const { browser, page, errors } = await setup({ view:'list', scenario:'mixed' });
  try {
    await page.locator('.v-lrow[data-id="p4"]').waitFor();
    const listNames = (id) => page.locator(`.v-lrow[data-id="${id}"]`).evaluate((row) => [row.querySelector('.v-laddr1').textContent, row.querySelector('.v-laddr2').textContent]);
    assert.deepEqual(await listNames('p4'), ['Pine Court roof repair', '4 Pine Ct, Austin, TX 78704']);
    assert.deepEqual(await listNames('p2'), ['Ada Lovelace', '2 Oak Ave, Austin, TX 78702']);
    assert.deepEqual(await listNames('p1'), ['1 Main St', 'Austin, TX 78701'], 'a project named by its address shows it once');
    assert.equal(await page.locator('.v-lrow[data-id="p2"] [data-col="resident"]').isVisible(), false, 'the contact is not repeated under its own name');
    await page.locator('#vViewTiles').click();
    await page.locator('.v-tile[data-id="p4"]').waitFor();
    const tileNames = (id) => page.locator(`.v-tile[data-id="${id}"] .v-addr`).evaluate((el) => Array.from(el.children).map((line) => line.textContent));
    assert.deepEqual(await tileNames('p4'), ['Pine Court roof repair', '4 Pine Ct, Austin, TX 78704']);
    assert.deepEqual(await tileNames('p2'), ['Ada Lovelace', '2 Oak Ave, Austin, TX 78702']);
    assert.deepEqual(await tileNames('p1'), ['1 Main St', 'Austin, TX 78701']);
    await page.locator('#vViewMap').click();
    await page.locator('.pm-row[data-id="p4"]').waitFor({ state:'attached' });
    const mapNames = (id) => page.locator(`.pm-row[data-id="${id}"]`).evaluate((row) => [row.querySelector('.pm-row-title').textContent, row.querySelector('.pm-row-addr').textContent]);
    assert.deepEqual(await mapNames('p4'), ['Pine Court roof repair', '4 Pine Ct, Austin, TX 78704']);
    assert.deepEqual(await mapNames('p2'), ['Ada Lovelace', '2 Oak Ave, Austin, TX 78702']);
    assert.deepEqual(errors, []);
  } finally { await browser.close(); }
});

test('a phone Tile with no picture is a compact card; one with a picture keeps its image', async () => {
  const { browser, page, errors } = await setup({ view:'tiles', scenario:'mixed' });
  try {
    await page.locator('.v-tile[data-id="p1"]').waitFor();
    // Its picture candidates are guesses that all fail: the card becomes compact.
    await page.waitForFunction(() => document.querySelector('.v-tile[data-id="p1"]').classList.contains('v-tile-compact'));
    const compact = await rect(page, '.v-tile[data-id="p1"]');
    assert.ok(compact.height < 200, `no blank image area (${compact.height}px)`);
    // What was the image area is only the row of badges (here Processing).
    assert.ok((await rect(page, '.v-tile[data-id="p1"] .v-thumb')).height <= 40, 'the image area takes no room');
    assert.equal(await page.locator('.v-tile[data-id="p1"] .v-thumb .v-badge').isVisible(), true, 'its badge still shows');
    // A picture that loads opens the card's image area.
    await page.waitForFunction(() => !document.querySelector('.v-tile[data-id="p2"]').classList.contains('v-tile-compact'));
    const pictured = await rect(page, '.v-tile[data-id="p2"] .v-thumb');
    assert.ok(pictured.height >= 120, 'a picture still shows');
    assert.deepEqual(errors, []);
  } finally { await browser.close(); }
});

test('the phone map colours a pin by its stage, and its preview is wide with 40px close and camera', async () => {
  const { browser, page, errors } = await setup({ view:'map', scenario:'mixed' });
  try {
    await page.locator('.pm-row[data-id="p4"]').waitFor({ state:'attached' });
    const color = (id) => page.locator(`.pm-row[data-id="${id}"]`).evaluate((el) => el.style.getPropertyValue('--pin-color'));
    assert.equal(await color('p1'), '#f59e0b', 'by the board stage, as the List and Stages show it');
    assert.equal(await color('p4'), '#16a34a', 'a project on no board with a board stage id takes that stage colour');
    await page.locator('.pm-tray-toggle').click();
    await page.locator('.pm-row[data-id="p4"]').click();
    await page.locator('.pm-preview-card').waitFor({ state:'attached' });
    const card = await rect(page, '.pm-preview-card');
    assert.ok(card.width >= 300 && card.width <= 366, `the preview is wide (${card.width}px)`);
    for (const selector of ['.pm-preview-close', '.pm-camera', '.pm-open']) {
      const box = await rect(page, selector);
      assert.deepEqual([box.width, box.height], [40, 40], selector);
    }
    assert.equal(await page.locator('.pm-preview-title').evaluate((el) => getComputedStyle(el).whiteSpace), 'normal', 'a long name wraps instead of being cut');
    assert.deepEqual(errors, []);
  } finally { await browser.close(); }
});

test('a phone Manage view is a bottom sheet with our own dropdowns', async () => {
  const { browser, page, errors } = await setup({ view:'tiles', scenario:'mixed' });
  try {
    await page.locator('.v-tile[data-id="p1"]').waitFor();
    await page.locator('#vManageView').click();
    const panel = page.locator('#vManageViewPanel');
    await panel.waitFor({ state:'visible' });
    assert.equal(await panel.evaluate((el) => el.matches(':popover-open')), true, 'in the top layer');
    const sheet = await rect(page, '#vManageViewPanel');
    assert.deepEqual([sheet.x, sheet.width, Math.round(sheet.bottom)], [0, 390, 844], 'full width, on the bottom edge');
    assert.equal(await page.locator('#vManageViewPanel select').evaluateAll((els) => els.filter((el) => el.getClientRects().length).length), 0, 'no native selects');
    assert.equal(await page.locator('#vManageViewPanel .v-dd-trigger').count(), 2, 'Stage and Order by');
    const close = await rect(page, '.v-manage-close');
    assert.deepEqual([close.width, close.height], [40, 40]);
    // Choosing from a dropdown changes the view and the sheet stays open.
    const orderBy = page.locator('#vManageViewPanel .v-dd-trigger').nth(1);
    await orderBy.click();
    assert.equal(await orderBy.getAttribute('aria-expanded'), 'true');
    assert.ok((await rect(page, '#vManageViewPanel .v-dd-list:not([hidden]) .v-dd-option')).height >= 44);
    await page.locator('#vManageViewPanel .v-dd-list:not([hidden]) .v-dd-option[data-value="resident"]').click();
    assert.equal(await page.locator('.v-tile').first().getAttribute('data-id'), 'p2', 'sorted by contact');
    assert.equal(await panel.evaluate((el) => el.matches(':popover-open')), true, 'still open');
    assert.match(await page.locator('#vManageViewPanel .v-dd-trigger').nth(1).innerText(), /Primary contact/);
    // A tap on the dimmed backdrop closes it and reaches nothing underneath.
    await page.mouse.click(195, 60);
    assert.equal(await panel.isVisible(), false);
    assert.equal(await page.locator('#vManageView').getAttribute('aria-expanded'), 'false');
    assert.deepEqual(await page.evaluate(() => window.opened), []);
    // The close button closes it too.
    await page.locator('#vManageView').click();
    await panel.waitFor({ state:'visible' });
    await page.locator('.v-manage-close').click();
    assert.equal(await panel.isVisible(), false);
    assert.deepEqual(errors, []);
  } finally { await browser.close(); }
});

test('a desktop (1600x1000) is unchanged: every List group in order, address rows, image tiles, the Manage view dropdown and the map preview', async () => {
  const { browser, page, errors } = await setup({ mobile:false, view:'list', scenario:'mixed', size:{ width:1600, height:1000 } });
  try {
    await page.locator('.v-lrow[data-id="p1"]').waitFor();
    const order = await page.locator('#vListScroll > *').evaluateAll((els) => els.map((el) => el.dataset.stage || el.className));
    assert.deepEqual(order, ['new', 'lead', 'won', 'lost', '__no_board__']);
    assert.equal(await page.locator('.v-list-empty-groups').count(), 0);
    assert.deepEqual(await page.locator('.v-lrow[data-id="p4"]').evaluate((row) => [row.querySelector('.v-laddr1').textContent, row.querySelector('.v-laddr2').textContent]), ['4 Pine Ct', 'Austin, TX 78704']);
    assert.equal(await page.locator('.v-lhead').isVisible(), true);
    await page.locator('#vManageView').click();
    const panel = page.locator('#vManageViewPanel');
    await panel.waitFor({ state:'visible' });
    assert.equal(await panel.evaluate((el) => el.hasAttribute('popover') || getComputedStyle(el).position), 'absolute', 'a dropdown panel, not a sheet');
    await page.locator('#vManageView').click();
    await page.locator('#vViewTiles').click();
    await page.locator('.v-tile[data-id="p1"]').waitFor();
    assert.equal(await page.locator('.v-tile-compact').count(), 0);
    assert.equal((await rect(page, '.v-tile[data-id="p1"] .v-thumb')).height, 168, 'the image area stays');
    assert.deepEqual(await page.locator('.v-tile[data-id="p4"] .v-addr').evaluate((el) => Array.from(el.children).map((line) => line.textContent)), ['4 Pine Ct', 'Austin, TX 78704']);
    await page.locator('#vManageView').click();
    await panel.waitFor({ state:'visible' });
    assert.equal(await page.locator('#vManageViewPanel select').evaluateAll((els) => els.filter((el) => el.getClientRects().length).length), 2, 'native selects');
    assert.equal(await page.locator('#vManageViewPanel .v-dd, #vManageViewPanel .v-manage-close').evaluateAll((els) => els.filter((el) => el.getClientRects().length).length), 0);
    await page.locator('#vManageView').click();
    await page.locator('#vViewStages').click();
    await page.locator('.v-stage-col[data-stage="new"]').waitFor();
    assert.equal(await page.locator('.v-stage-col').evaluateAll((cols) => cols.filter((col) => col.getClientRects().length).length), 5, 'every stage column shows');
    await page.locator('#vViewMap').click();
    await page.locator('.pm-row[data-id="p2"]').waitFor();
    await page.locator('.pm-row[data-id="p2"]').click();
    await page.locator('.pm-preview-card').waitFor({ state:'attached' });
    assert.equal((await rect(page, '.pm-preview-card')).width, 260);
    const close = await rect(page, '.pm-preview-close');
    assert.deepEqual([close.width, close.height], [26, 26]);
    assert.equal(await page.locator('.pm-camera').evaluate((el) => getComputedStyle(el).display), 'none');
    assert.deepEqual(errors, []);
  } finally { await browser.close(); }
});
