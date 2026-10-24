// Pinnable app subviews, the apps overlay roll-out, drag-to-pin and the
// collapsed column width (docs/architecture/app-experience.md, "Left-column pins").
import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { chromium } from 'playwright-core';

const publicRoot = path.resolve(import.meta.dirname, '..', '..');
const read = (relative) => readFile(path.join(publicRoot, relative), 'utf8');
const [core, index, manifestSource, viewer] = await Promise.all([
  read('portal/scripts/core.js'),
  read('portal/index.php'),
  read('libraries/apps/firstmate-apps-manifest.js'),
  read('libraries/apps/projects/viewer.js')
]);
const insertSidebarSubviewLinks = core.slice(core.indexOf('  function insertSidebarSubviewLinks('), core.indexOf('  function renderTabs(){'));
const sidebarLinksCss = (() => {
  const start = core.indexOf("injectCSS('sidebar_links', `") + "injectCSS('sidebar_links', `".length;
  return core.slice(start, core.indexOf('`);', start));
})();
const indexStyles = [...index.matchAll(/<style[^>]*>([\s\S]*?)<\/style>/g)].map((match) => match[1]).join('\n');

const launch = () => chromium.launch({ executablePath: process.env.CHROME_PATH || 'C:/Program Files/Google/Chrome/Application/chrome.exe', headless: true });

const harness = ({ preferences = {}, flags = {}, patchFails = false } = {}) => `<!doctype html><html><head><meta charset="utf-8">
<style>${indexStyles}\n${sidebarLinksCss}\n:root{--sidebar:250px;--sidebar-compact:48px}.sidebar{position:fixed;left:0;top:0;bottom:0;transition:none!important}.test-main{position:fixed;left:300px;top:20px}</style>
</head><body>
<aside class="sidebar apps-list-enabled" id="mainSidebar"><div class="sidebar-scroll"><div class="sidebar-panel active" id="sidebarAppsPanel"><div id="sidebarLinks"><div id="sidebarMainLinks">
  <div class="fm-link" data-tab="viewer"><button type="button" class="fm-sidebar-app-pin is-pinned" data-sidebar-app-pin="portal.viewer"><i class="fas fa-thumbtack"></i></button><div class="ic"><i class="fas fa-folder-open"></i></div><div class="tx">My Projects</div></div>
  <div class="fm-link" data-tab="contacts"><div class="ic"><i class="fas fa-address-book"></i></div><div class="tx">My Contacts</div></div>
</div></div></div></div></aside>
<main class="test-main">
  <div class="v-view-switch">
    <button class="v-btn" id="vViewList" data-app-subview="portal.viewer:list">List</button>
    <button class="v-btn" id="vViewMap" data-app-subview="portal.viewer:map">Map</button>
  </div>
  <div id="overlayHost" style="position:relative;margin-top:40px"></div>
</main>
<script>
  window.APP = {};
  window.serverPrefs = ${JSON.stringify(preferences)};
  window.patches = [];
  window.navigations = [];
  window.viewClicks = 0;
  window.flags = ${JSON.stringify(flags)};
  window.Portal = {
    currentUser: { identity: { preferences: JSON.parse(JSON.stringify(window.serverPrefs)) } },
    appFlags: { value: (group, flag, fallback) => window.flags[group + '.' + flag] ?? fallback },
    navigation: {
      read: () => Object.fromEntries(new URLSearchParams(location.search)),
      navigate: (patch, options) => {
        window.navigations.push({ patch, options });
        const url = new URL(location.href);
        Object.entries(patch).forEach(([key, value]) => url.searchParams.set(key, value));
        history.pushState({}, '', url);
        window.dispatchEvent(new CustomEvent('fm:route-state:updated', { detail: { route: Object.fromEntries(url.searchParams) } }));
      }
    }
  };
  window.PlatformAPI = { preferences: { patch: async (patch) => {
    window.patches.push(patch);
    if (${patchFails}) throw new Error('Save failed');
    window.serverPrefs = { ...window.serverPrefs, ...patch };
    return { preferences: window.serverPrefs };
  } } };
  window.PlatformUI = { toasts: [], showToast(message){ this.toasts.push(message); } };
  window.FirstMateEmbeddableApps = { registerManifest(){}, registerApp(){}, getApp(){ return null; } };
  document.getElementById('vViewList').addEventListener('click', () => { window.viewClicks += 1; });
</script>
<script src="/libraries/apps/firstmate-apps-manifest.js"></script>
<script src="/libraries/left-column-pins/left-column-pins.js"></script>
<script>
  const TabRegistry = { tabs: new Map([
    ['viewer', { id:'viewer', appId:'portal.viewer', title:'My Projects', placement:'sidebar', order:10 }],
    ['contacts', { id:'contacts', appId:'portal.contacts', title:'My Contacts', placement:'sidebar', order:20 }],
    ['crm', { id:'crm', appId:'portal.crm', title:'CRM', placement:'more', order:15 }]
  ]) };
  const advancedAppMenuEnabled = () => true;
  const terminologyLabel = (key, fallback) => fallback;
  ${insertSidebarSubviewLinks}
  window.insertSidebarSubviewLinks = insertSidebarSubviewLinks;
  window.pinnedApps = [];
  FirstMateLeftColumnPins.configure({
    dragEnabled: () => true,
    describeApp: (appId) => {
      const tab = [...TabRegistry.tabs.values()].find((item) => item.appId === appId);
      return tab ? { tabId: tab.id, label: tab.title, icon: 'fa-filter', pinned: tab.placement === 'sidebar' } : null;
    },
    pinApp: async (appId) => {
      window.pinnedApps.push(appId);
      const tab = [...TabRegistry.tabs.values()].find((item) => item.appId === appId);
      tab.placement = 'sidebar';
      const link = document.createElement('div');
      link.className = 'fm-link';
      link.dataset.tab = tab.id;
      link.innerHTML = '<div class="ic"><i class="fas fa-filter"></i></div><div class="tx">' + tab.title + '</div>';
      document.querySelector('#sidebarMainLinks [data-tab="contacts"]').before(link);
      insertSidebarSubviewLinks();
    },
    landingBefore: (payload) => {
      const order = TabRegistry.tabs.get(payload.tabId)?.order ?? 1000;
      return [...document.getElementById('sidebarMainLinks').children].find((node) => node.dataset?.tab && TabRegistry.tabs.get(node.dataset.tab)?.order > order) || null;
    },
    closeOverlay(){}
  });
  window.addEventListener('fm:left-column-pins:updated', () => insertSidebarSubviewLinks());
  insertSidebarSubviewLinks();
  window.renderOverlay = () => {
    const extras = FirstMateLeftColumnPins.overlayTileExtras({ appId:'portal.viewer', tabId:'viewer', label:'My Projects', pinnable:true });
    const crm = '<article class="fm-advanced-app-tile" data-pin-drag-app="portal.crm" style="position:relative;width:120px;height:120px;margin-top:12px;background:#f2f4f7"><button type="button" class="fm-advanced-app-open">CRM</button></article>';
    document.getElementById('overlayHost').innerHTML = '<div class="fm-advanced-apps-overlay-test"><article class="fm-advanced-app-tile' + extras.className + '" data-pin-drag-app="portal.viewer" style="position:relative;width:120px;height:120px;background:#f2f4f7"><button type="button" class="fm-advanced-app-open" data-advanced-app-open="apps.projects">My Projects</button>' + extras.html + '</article>' + crm + '</div>';
    FirstMateLeftColumnPins.bindOverlay(document.querySelector('.fm-advanced-apps-overlay-test'), {});
  };
</script>
</body></html>`;

async function openPage(browser, options = {}, contextOptions = {}){
  const context = await browser.newContext({ viewport: { width: 1280, height: 850 }, ...contextOptions });
  await context.route('http://fm.test/**', async (route) => {
    const url = new URL(route.request().url());
    if (url.pathname === '/portal') return route.fulfill({ contentType: 'text/html', body: harness(options) });
    return route.fulfill({ contentType: 'application/javascript', body: await read(url.pathname.slice(1)) });
  });
  const page = await context.newPage();
  await page.goto('http://fm.test/portal?tab=viewer');
  return { context, page };
}

const sidebarOrder = (page) => page.$$eval('#sidebarMainLinks > *', (nodes) => nodes.map((node) => node.dataset.subviewKey || node.dataset.tab || node.className));

test('My Projects declares its views as pinnable subviews and marks its view buttons', () => {
  assert.match(manifestSource, /id: 'portal\.viewer'[\s\S]{0,700}subviews: \[/);
  for (const [id, param] of [['stages', 'stages'], ['list', 'list'], ['tiles', 'tiles'], ['map', 'map']]) {
    assert.match(manifestSource, new RegExp(`\\{ id: '${id}',[^\\n]+route: \\{ projectView: '${param}' \\}`));
    assert.match(viewer, new RegExp(`data-app-subview="portal\\.viewer:${id}"`));
  }
  assert.match(manifestSource, /id: 'map',[^\n]+requires: \{ appFlags: \[\['apps', 'project_map'\]\] \}/);
  assert.match(manifestSource, /id: 'stages',[^\n]+\['platform', 'project_stages_view'\]/);
  assert.match(index, /left-column-pins\/left-column-pins\.js\?v=<\?= portalAssetVersion\('\.\.\/libraries\/left-column-pins\/left-column-pins\.js'\) \?>"><\/script>\s*<script src="scripts\/core\.js/);
  assert.doesNotMatch(core, /portal\.viewer:|projectView/, 'the shell does not special-case My Projects');
});

test('subview pins are personal, follow their app, survive a reload and open the app in that view', async () => {
  const browser = await launch();
  try {
    const flags = { 'apps.project_map': true };
    let { context, page } = await openPage(browser, { flags });
    assert.deepEqual(await page.evaluate(() => FirstMateLeftColumnPins.subviews('portal.viewer').map((item) => item.id)), ['list', 'tiles', 'map'], 'stages needs its flags');
    await page.evaluate(() => FirstMateLeftColumnPins.setPinned('portal.viewer:map', true));
    assert.deepEqual(await page.evaluate(() => window.patches), [{ left_column_pins: ['portal.viewer:map'] }]);
    assert.deepEqual(await sidebarOrder(page), ['viewer', 'portal.viewer:map', 'contacts']);
    await page.evaluate(() => FirstMateLeftColumnPins.setPinned('portal.viewer:list', true));
    assert.deepEqual(await sidebarOrder(page), ['viewer', 'portal.viewer:list', 'portal.viewer:map', 'contacts'], 'subviews keep their declared order');
    const saved = await page.evaluate(() => window.serverPrefs);
    await context.close();

    ({ context, page } = await openPage(browser, { flags, preferences: saved }));
    assert.deepEqual(await sidebarOrder(page), ['viewer', 'portal.viewer:list', 'portal.viewer:map', 'contacts'], 'pins survive a reload');
    await page.click('.fm-link-subview[data-subview-key="portal.viewer:map"]');
    assert.deepEqual(await page.evaluate(() => window.navigations.at(-1).patch), { tab: 'viewer', projectView: 'map' });
    assert.deepEqual(await page.evaluate(() => ({
      map: document.querySelector('[data-subview-key="portal.viewer:map"]').classList.contains('active'),
      list: document.querySelector('[data-subview-key="portal.viewer:list"]').classList.contains('active'),
      parent: document.querySelector('#sidebarMainLinks [data-tab="viewer"]').classList.contains('active')
    })), { map: true, list: false, parent: false });
    await page.evaluate(() => { window.flags['apps.project_map'] = false; insertSidebarSubviewLinks(); });
    assert.deepEqual(await sidebarOrder(page), ['viewer', 'portal.viewer:list', 'contacts'], 'a view whose flag is off is not shown');
    await page.evaluate(() => document.getElementById('mainSidebar').classList.add('sidebar-advanced-apps-open'));
    await page.waitForTimeout(350);
    await page.click('[data-sidebar-subview-pin="portal.viewer:list"]');
    await page.waitForFunction(() => window.serverPrefs.left_column_pins.length === 1);
    assert.deepEqual(await page.evaluate(() => window.serverPrefs.left_column_pins), ['portal.viewer:map'], 'unpinning keeps the hidden view pinned');
    await context.close();

    ({ context, page } = await openPage(browser, { flags, patchFails: true }));
    await assert.rejects(page.evaluate(() => FirstMateLeftColumnPins.setPinned('portal.viewer:tiles', true)));
    assert.deepEqual(await page.evaluate(() => FirstMateLeftColumnPins.pinnedKeys()), [], 'a failed save rolls back');
    assert.deepEqual(await sidebarOrder(page), ['viewer', 'contacts']);
    await context.close();
  } finally {
    await browser.close();
  }
});

test('hovering or focusing an app in the apps overlay rolls out its subviews, each with its own pin', async () => {
  const browser = await launch();
  try {
    const { context, page } = await openPage(browser, { flags: { 'apps.project_map': true } });
    await page.evaluate(() => window.renderOverlay());
    const list = page.locator('.fm-advanced-app-subviews');
    assert.equal(await list.evaluate((node) => getComputedStyle(node).visibility), 'hidden');
    await page.hover('.fm-advanced-app-tile.has-subviews');
    await page.waitForFunction(() => getComputedStyle(document.querySelector('.fm-advanced-app-subviews')).opacity === '1');
    assert.equal(await page.locator('.fm-advanced-subview').count(), 3);
    assert.match(await list.evaluate((node) => getComputedStyle(node).transitionDuration), /[1-9]/, 'the roll-out is animated');
    await page.click('[data-advanced-subview-pin="portal.viewer:map"]');
    await page.waitForFunction(() => window.serverPrefs.left_column_pins?.includes('portal.viewer:map'));
    assert.equal(await page.getAttribute('[data-advanced-subview-pin="portal.viewer:map"]', 'aria-pressed'), 'true');
    assert.deepEqual(await sidebarOrder(page), ['viewer', 'portal.viewer:map', 'contacts']);

    await page.evaluate(() => document.activeElement?.blur());
    await page.mouse.move(1200, 800);
    await page.waitForFunction(() => getComputedStyle(document.querySelector('.fm-advanced-app-subviews')).visibility === 'hidden');
    await page.focus('.fm-advanced-app-open');
    await page.keyboard.press('Tab');
    assert.equal(await page.evaluate(() => document.activeElement.dataset.advancedSubviewsToggle), 'portal.viewer');
    await page.keyboard.press('Tab');
    assert.equal(await page.evaluate(() => document.activeElement.dataset.advancedSubviewPin), 'portal.viewer:list', 'keyboard focus reaches each pin');
    assert.equal(await list.evaluate((node) => getComputedStyle(node).visibility), 'visible');
    await page.keyboard.press('Enter');
    await page.waitForFunction(() => window.serverPrefs.left_column_pins?.includes('portal.viewer:list'));
    await page.click('[data-advanced-subview-open="portal.viewer:tiles"]');
    assert.deepEqual(await page.evaluate(() => window.navigations.at(-1).patch), { tab: 'viewer', projectView: 'tiles' });

    await page.emulateMedia({ reducedMotion: 'reduce' });
    assert.equal(await list.evaluate((node) => getComputedStyle(node).transitionDuration), '0s', 'reduced motion turns the roll-out off');
    await context.close();
  } finally {
    await browser.close();
  }
});

test('on touch the subviews open with a disclosure tap', async () => {
  const browser = await launch();
  try {
    const { context, page } = await openPage(browser, { flags: { 'apps.project_map': true } }, { viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });
    await page.evaluate(() => window.renderOverlay());
    await page.tap('.fm-advanced-app-open');
    await page.evaluate(() => document.activeElement?.blur());
    await page.waitForTimeout(400);
    assert.equal(await page.locator('.fm-advanced-app-subviews').evaluate((node) => getComputedStyle(node).visibility), 'hidden', 'no hover roll-out on touch');
    await page.tap('[data-advanced-subviews-toggle]');
    assert.equal(await page.getAttribute('[data-advanced-subviews-toggle]', 'aria-expanded'), 'true');
    await page.evaluate(() => document.activeElement?.blur());
    await page.waitForFunction(() => getComputedStyle(document.querySelector('.fm-advanced-app-subviews')).visibility === 'visible');
    await page.tap('[data-advanced-subview-pin="portal.viewer:map"]');
    await page.waitForFunction(() => window.serverPrefs.left_column_pins?.includes('portal.viewer:map'));
    await context.close();
  } finally {
    await browser.close();
  }
});

async function dragTo(page, selector, x, y, { release = true } = {}){
  const box = await page.locator(selector).boundingBox();
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width / 2 + 10, box.y + box.height / 2, { steps: 2 });
  await page.mouse.move(x, y, { steps: 8 });
  if (release) await page.mouse.up();
}

test('dragging a view button or an app tile onto the left column pins it', async () => {
  const browser = await launch();
  try {
    const { context, page } = await openPage(browser, { flags: { 'apps.project_map': true } });
    await dragTo(page, '#vViewList', 60, 200, { release: false });
    assert.equal(await page.locator('.fm-pin-ghost').count(), 1);
    assert.equal(await page.evaluate(() => document.getElementById('mainSidebar').classList.contains('fm-pin-drop-over')), true, 'the left column shows it is a drop target');
    await page.waitForSelector('.fm-pin-drop-slot.is-open');
    assert.deepEqual(await sidebarOrder(page), ['viewer', 'fm-pin-drop-slot is-open', 'contacts'], 'the slot shows where it lands');
    await page.mouse.up();
    await page.waitForFunction(() => window.serverPrefs.left_column_pins?.includes('portal.viewer:list'));
    await page.waitForFunction(() => !document.querySelector('.fm-pin-ghost') && !document.querySelector('.fm-pin-drop-slot'));
    assert.deepEqual(await sidebarOrder(page), ['viewer', 'portal.viewer:list', 'contacts']);
    assert.equal(await page.evaluate(() => window.viewClicks), 0, 'a drag does not also switch the view');
    assert.deepEqual(await page.evaluate(() => window.serverPrefs), { left_column_pins: ['portal.viewer:list'] }, 'the same stored state as pinning from the overlay');

    await page.click('#vViewList');
    assert.equal(await page.evaluate(() => window.viewClicks), 1, 'an ordinary click still switches the view');

    await dragTo(page, '#vViewMap', 900, 500);
    await page.waitForFunction(() => !document.querySelector('.fm-pin-ghost'));
    assert.equal(await page.evaluate(() => window.serverPrefs.left_column_pins.includes('portal.viewer:map')), false, 'dropping elsewhere does not pin');

    await dragTo(page, '#vViewMap', 60, 200, { release: false });
    await page.keyboard.press('Escape');
    await page.mouse.up();
    await page.waitForFunction(() => !document.querySelector('.fm-pin-ghost'));
    assert.equal(await page.evaluate(() => window.serverPrefs.left_column_pins.includes('portal.viewer:map')), false, 'Escape cancels a drag');

    await page.evaluate(() => window.renderOverlay());
    await dragTo(page, '[data-pin-drag-app="portal.crm"]', 60, 200);
    await page.waitForFunction(() => window.pinnedApps.length === 1);
    assert.deepEqual(await page.evaluate(() => window.pinnedApps), ['portal.crm'], 'an app pins through the shell, like its overlay pin');
    await page.waitForFunction(() => !document.querySelector('.fm-pin-ghost'));
    assert.deepEqual(await sidebarOrder(page), ['viewer', 'portal.viewer:list', 'crm', 'contacts']);
    await context.close();
  } finally {
    await browser.close();
  }
});

test('the collapsed column widens while the apps overlay is open so pins sit beside icons', async () => {
  const browser = await launch();
  try {
    const { context, page } = await openPage(browser, {});
    const measure = () => page.evaluate(() => {
      const sidebar = document.getElementById('mainSidebar');
      const link = document.querySelector('#sidebarMainLinks [data-tab="viewer"]');
      return {
        width: Math.round(sidebar.getBoundingClientRect().width),
        pinRight: Math.round(link.querySelector('.fm-sidebar-app-pin').getBoundingClientRect().right),
        iconLeft: Math.round(link.querySelector('.ic').getBoundingClientRect().left),
        iconRight: Math.round(link.querySelector('.ic').getBoundingClientRect().right)
      };
    });
    await page.addStyleTag({ content: '*,*:before,*:after{transition:none!important;animation:none!important}' });
    await page.evaluate(() => document.getElementById('mainSidebar').classList.add('sidebar-compact', 'sidebar-manual'));
    assert.equal((await measure()).width, 48);
    await page.evaluate(() => document.getElementById('mainSidebar').classList.add('sidebar-advanced-apps-open'));
    const open = await measure();
    assert.equal(open.width, 78);
    assert.ok(open.pinRight <= open.iconLeft, `pin (${open.pinRight}) must not overlap the icon (${open.iconLeft})`);
    assert.ok(open.iconRight <= open.width, 'the icon stays inside the column');
    await page.evaluate(() => document.getElementById('mainSidebar').classList.remove('sidebar-manual'));
    assert.equal((await measure()).width, 250, 'an adaptive column still opens fully');
    await context.close();
    assert.match(indexStyles, /\.sidebar\{[^}]*transition:width \.2s/, 'the width change is animated');
  } finally {
    await browser.close();
  }
});
