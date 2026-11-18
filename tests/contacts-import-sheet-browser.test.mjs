// FM-544: on a phone, importing contacts opens as a bottom sheet (window-manager mobileSheet) over the contact list,
// with the Import / History / Tags / Preferences tabs as an icon bar at the bottom of the sheet. Desktop keeps the
// inline workspace with the tabs on top. Runs the real contacts app, contacts settings and window manager in Chromium
// against a stubbed portal, at the reporter's phone size (433×870) and on a desktop.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';

const { chromium } = createRequire(new URL('../public/v1/package.json', import.meta.url))('playwright-core');
const CHROME = process.env.CHROME_PATH || 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const read = (file) => readFileSync(new URL(`../public/libraries/${file}`, import.meta.url), 'utf8');

const PORTAL_STUB = `
  window.__route = { tab:'contacts' };
  const handlers = [];
  const patch = (next) => { for (const [key, value] of Object.entries(next)) { if (value == null) delete window.__route[key]; else window.__route[key] = value; } };
  window.Portal = {
    cfg:{ orgId:'org_test' }, util:{ hasPerm:() => true }, ui:{ showToast(){} },
    appFlags:{ current:() => ({}), has:() => true, load:async () => {} },
    apps:{ registerPortalApp(app){ window.__contactsApp = app; }, unregisterPortalApp(){} },
    tabs:{ renderTabs(){}, activateTab(){} },
    navigation:{
      read:() => ({ ...window.__route }),
      push(next){ patch(next); },
      backOrClose(keys, next){ patch(next); handlers.forEach(handler => handler.apply({ ...window.__route })); },
      registerHandler(id, handler){ handlers.push(handler); return () => {}; },
      registerSchema(){}
    }
  };
  window.PlatformAPI = {
    projects:{ list:async () => ({ documents:[] }) },
    contacts:{ listAll:async () => [], settings:async () => ({ settings:{ tags:[] } }) },
    contactImports:{ preview:async () => ({}), discard:async () => {}, list:async () => ({ imports:[] }) }
  };`;

async function openContacts(browser, viewport){
  const page = await browser.newPage({ viewport });
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  // A real origin: the app reads localStorage, which about:blank refuses.
  await page.route('https://contacts.test/**', route => route.fulfill({ contentType: 'text/html', body: '<!doctype html><html><head></head><body style="margin:0"><main class="main"><div id="mainPanels"><div id="contactsRoot"></div></div></main></body></html>' }));
  await page.goto('https://contacts.test/portal/');
  await page.addScriptTag({ content: PORTAL_STUB });
  for (const file of ['window-manager/window-manager.js', 'apps/settings/contacts.js', 'apps/contacts/app.js']) await page.addScriptTag({ content: read(file) });
  await page.waitForFunction(() => window.__contactsApp, null, { timeout: 5000 }).catch(error => { throw new Error(`${error.message} ${errors.join(' | ')}`); });
  await page.evaluate(() => window.__contactsApp.mount(document.getElementById('contactsRoot')));
  await page.waitForSelector('[data-ct-open-import]');
  return { page, errors };
}

test('phone: import opens as a bottom sheet over the list with icon tabs at the bottom', async () => {
  const browser = await chromium.launch({ executablePath: CHROME });
  try {
    const { page, errors } = await openContacts(browser, { width: 433, height: 870 });
    await page.click('[data-ct-open-import]');
    await page.waitForSelector('.ct-import-sheet:not([hidden])');
    await page.waitForTimeout(450);
    const open = await page.evaluate(() => {
      const sheet = document.querySelector('.ct-import-sheet'), box = sheet.getBoundingClientRect();
      const tabs = [...sheet.querySelectorAll('.ct-import-sheet-tabs .cti-subtab')];
      return {
        route: { ...window.__route }, mode: sheet.dataset.window, isSheet: sheet.dataset.windowSheet,
        top: box.top, height: box.height, listBehind: !!document.querySelector('#contactsRoot [data-ct-results]'),
        inlineWorkspace: !!document.querySelector('#contactsRoot .ct-workspace-body'),
        tabsInPage: sheet.querySelectorAll('.cti-page .cti-subtabs').length,
        tabs: tabs.map(tab => ({ id: tab.dataset.ctiSubtab, icon: tab.querySelector('i')?.className, iconShown: getComputedStyle(tab.querySelector('i')).display !== 'none', active: tab.classList.contains('active'), bottom: tab.getBoundingClientRect().bottom }))
      };
    });
    assert.deepEqual(open.route, { tab: 'contacts', contactsWorkspace: 'import', contactsSettingsView: 'import' });
    assert.equal(open.mode, 'fullscreen');
    assert.equal(open.isSheet, 'true', 'the import window is a phone sheet');
    assert.ok(open.top > 40 && open.height > 870 * .8, `the sheet covers most of the screen, below its top (top ${open.top}, height ${open.height})`);
    assert.ok(open.listBehind && !open.inlineWorkspace, 'the contact list stays behind the sheet');
    assert.equal(open.tabsInPage, 0, 'no tab strip above the page');
    assert.deepEqual(open.tabs.map(tab => [tab.id, tab.icon]), [
      ['import', 'fas fa-file-import'], ['history', 'fas fa-clock-rotate-left'], ['tags', 'fas fa-tags'], ['preferences', 'fas fa-sliders']
    ]);
    assert.ok(open.tabs.every(tab => tab.iconShown), 'each tab shows its icon');
    assert.ok(open.tabs.every(tab => tab.bottom >= 870 - 2), 'the tabs sit at the bottom of the sheet');
    assert.equal(open.tabs.find(tab => tab.active)?.id, 'import');

    await page.click('.ct-import-sheet-tabs [data-cti-subtab=history]');
    const history = await page.evaluate(() => ({ view: window.__route.contactsSettingsView, active: document.querySelector('.ct-import-sheet-tabs .cti-subtab.active')?.dataset.ctiSubtab, bars: document.querySelectorAll('.ct-import-sheet-tabs .cti-subtabs').length }));
    assert.deepEqual(history, { view: 'history', active: 'history', bars: 1 });

    // Tapping the dimmed page above the sheet puts it away and leaves the route.
    await page.mouse.click(200, 20);
    await page.waitForFunction(() => !document.querySelector('.ct-import-sheet'));
    const closed = await page.evaluate(() => ({ route: { ...window.__route }, backdrops: document.querySelectorAll('.fm-window-backdrop').length }));
    assert.deepEqual(closed, { route: { tab: 'contacts' }, backdrops: 0 });
    assert.deepEqual(errors, []);
  } finally { await browser.close(); }
});

test('desktop: import stays an inline workspace with the tabs on top and no icons', async () => {
  const browser = await chromium.launch({ executablePath: CHROME });
  try {
    const { page, errors } = await openContacts(browser, { width: 1280, height: 860 });
    await page.click('[data-ct-open-import]');
    await page.waitForSelector('.ct-workspace-body .cti-subtabs');
    const desktop = await page.evaluate(() => ({
      sheet: !!document.querySelector('.ct-import-sheet'),
      tabs: document.querySelectorAll('.ct-workspace-body .cti-page > .cti-subtabs .cti-subtab').length,
      iconsShown: [...document.querySelectorAll('.cti-subtab > i')].filter(icon => getComputedStyle(icon).display !== 'none').length
    }));
    assert.deepEqual(desktop, { sheet: false, tabs: 4, iconsShown: 0 });
    assert.deepEqual(errors, []);
  } finally { await browser.close(); }
});
