// 1M8-243: every customer can reach support, whatever their permissions or app settings. Chrome runs the real sidebar
// launcher code and its stylesheet from core.js, the Settings gate (1M8-236), and the real help card
// (libraries/apps/help/app.js), for a customer who can only view reports, so Settings is not offered.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { chromium } from 'playwright-core';

const read = path => readFile(new URL('../../' + path, import.meta.url), 'utf8');
const [core, portal, help] = await Promise.all([read('portal/scripts/core.js'), read('portal/index.php'), read('libraries/apps/help/app.js')]);
const gate = core.slice(core.indexOf('  const SETTINGS_PERMISSIONS = '), core.indexOf('  function renderSidebarLaunchers('));
const launchers = core.slice(core.indexOf('  function renderSidebarLaunchers('), core.indexOf('  function renderTabs('));
const cssStart = core.indexOf("injectCSS('sidebar_links', `") + "injectCSS('sidebar_links', `".length;
const sidebarCss = core.slice(cssStart, core.indexOf('`);', cssStart));

async function sidebar(browser, { permissions, flags = [], capabilities = {}, width = 1280 }) {
  const page = await browser.newPage({ viewport: { width, height: 800 } });
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.setContent(`<!doctype html><html><head><style>
      body{margin:0;font-family:system-ui;display:flex;height:100vh}
      .sidebar{width:260px;display:flex;flex-direction:column;border-right:1px solid #ddd}
      .sidebar-scroll{display:flex;flex-direction:column;flex:1;min-height:0;padding:12px}
      ${sidebarCss}</style></head><body>
    <aside class="sidebar" id="mainSidebar"><div class="sidebar-scroll">
      <div id="sidebarLinks"></div>
      <div id="sidebarBottomLinks" aria-label="Sidebar settings"></div>
      <div class="sidebar-footer">
        <button type="button" class="fm-account-switcher-trigger" id="accountSwitcherButton" aria-label="Choose account">
          <span class="fm-account-avatar">R</span><span class="fm-account-trigger-copy"><strong>Report Viewer</strong></span>
        </button>
      </div>
    </div></aside>
    <main style="flex:1"></main></body></html>`);
  await page.addScriptTag({ content: `
    const flagsOn = new Set(${JSON.stringify(flags)});
    const caps = ${JSON.stringify(capabilities)};
    window.Portal = { currentUser: { permissions: ${JSON.stringify(permissions)} },
      appFlags: { current: () => ({}), has: (group, key) => flagsOn.has(group + '.' + key), value: (group, key, fallback) => flagsOn.has(group + '.' + key) || fallback },
      capabilities: { current: () => ({ loaded_at: '1' }), value: (key, fallback) => (key in caps ? caps[key] : fallback) } };
    function hasPerm(key) { const p = window.Portal.currentUser.permissions || {}; return !!p['*'] || !!p[key]; }
    function escapeHtml(value) { return String(value ?? '').replace(/[&<>"']/g, c => '&#' + c.charCodeAt(0) + ';'); }
    let preservedSidebarAccountButton = null, advancedAppMenuOpen = false;
    const appCatalogEntries = () => [{ key: 'contacts', label: 'Contacts', icon: 'fa-address-book', addable: true }];
    const advancedAppMenuEnabled = () => false, closeAdvancedAppMenu = () => {}, renderAdvancedAppMenu = () => {}, openAdvancedAppMenu = () => {};
    const openAppCatalogModal = () => {}, updateAdvancedAppPin = () => {};
    window.activated = [];
    function activateTab(id) { window.activated.push(id); }
    ${gate}
    ${launchers}
    renderSidebarLaunchers(document.getElementById('sidebarBottomLinks'), [{ id: 'company_settings', placement: 'settings' }]);
  ` });
  await page.addScriptTag({ content: help });
  return { page, errors };
}

const helpState = page => page.evaluate(() => {
  const launcher = document.querySelector('#mainSidebar [data-launcher="help"]');
  const popup = document.getElementById('fmHelpPopup');
  const box = element => element?.getBoundingClientRect();
  const rect = box(launcher), card = box(popup);
  const style = popup && getComputedStyle(popup);
  return {
    settings: !!document.querySelector('#sidebarBottomLinks [data-tab="company_settings"]'),
    launcher: !!launcher, label: launcher?.getAttribute('aria-label'),
    launcherVisible: !!rect && rect.width > 0 && rect.height > 0 && rect.right <= innerWidth && rect.bottom <= innerHeight,
    open: !!popup && popup.classList.contains('fm-open') && style.visibility === 'visible',
    email: popup?.querySelector('a.fmHelp-email')?.getAttribute('href'),
    cardInView: !!card && card.left >= 0 && card.top >= 0 && card.right <= innerWidth && card.bottom <= innerHeight,
    clearOfSidebar: !!card && card.left >= document.getElementById('mainSidebar').getBoundingClientRect().right,
    floatingButton: !!document.getElementById('fmHelpBtn')
  };
});

async function opensSupport(page, errors) {
  let state = await helpState(page);
  assert.ok(state.launcher && state.launcherVisible, JSON.stringify(state));
  assert.equal(state.label, 'Help & support');
  assert.equal(state.open, false, 'the card stays closed until asked for');
  assert.equal(state.floatingButton, false, 'no floating button over the page');
  await page.locator('#mainSidebar [data-launcher="help"]').click();
  await page.waitForTimeout(350);
  state = await helpState(page);
  assert.ok(state.open && state.cardInView && state.clearOfSidebar, JSON.stringify(state));
  assert.equal(state.email, 'mailto:support@1m8.ai');
  await page.keyboard.press('Escape');
  await page.waitForTimeout(350);
  assert.equal((await helpState(page)).open, false, 'Escape closes it');
  await page.locator('#mainSidebar [data-launcher="help"]').click();
  await page.waitForTimeout(100);
  assert.equal((await helpState(page)).open, true, 'it opens again');
  await page.locator('#mainSidebar [data-launcher="help"]').click();
  await page.waitForTimeout(100);
  assert.equal((await helpState(page)).open, false, 'the launcher toggles it closed');
  assert.deepEqual(errors, []);
  return state;
}

test('1M8-243: a customer without Settings access has Help & support, which opens support@1m8.ai', async () => {
  const browser = await chromium.launch({ channel: 'chrome', headless: true });
  try {
    // The default sidebar: launchers share one row with the user icon.
    const { page, errors } = await sidebar(browser, { permissions: { view_reports: true } });
    assert.equal((await helpState(page)).settings, false, 'Settings is not offered to this customer (1M8-236)');
    await opensSupport(page, errors);
  } finally { await browser.close(); }
});

test('1M8-243: Help & support is there with More apps and a separate user section, with or without Settings', async () => {
  const browser = await chromium.launch({ channel: 'chrome', headless: true });
  try {
    for (const setup of [
      { permissions: { view_reports: true }, capabilities: { 'platform.separate_user_section': true } },
      { permissions: { view_reports: true }, capabilities: { 'platform.separate_user_section': true, 'platform.more_apps': true } },
      { permissions: { '*': true }, capabilities: { 'platform.separate_user_section': true, 'platform.more_apps': true } },
      { permissions: { '*': true }, capabilities: { 'platform.more_apps': true } }
    ]) {
      const { page, errors } = await sidebar(browser, setup);
      assert.equal((await helpState(page)).settings, !!setup.permissions['*'], JSON.stringify(setup));
      await opensSupport(page, errors);
      await page.close();
    }
  } finally { await browser.close(); }
});

test('1M8-243: on a phone the card opens in the corner and closes the sidebar drawer', async () => {
  const browser = await chromium.launch({ channel: 'chrome', headless: true });
  try {
    const { page, errors } = await sidebar(browser, { permissions: { view_reports: true }, width: 390 });
    await page.evaluate(() => { window.drawerClosed = 0; window.__mobileSidebar = { close: () => { window.drawerClosed += 1; } }; });
    await page.locator('#mainSidebar [data-launcher="help"]').click();
    await page.waitForTimeout(350);
    const state = await helpState(page);
    assert.ok(state.open && state.cardInView, JSON.stringify(state));
    assert.equal(await page.evaluate(() => window.drawerClosed), 1);
    assert.deepEqual(errors, []);
  } finally { await browser.close(); }
});

test('1M8-243: the portal loads the help card again, without its floating button', () => {
  assert.match(portal, /\n  <script src="\.\.\/libraries\/apps\/help\/app\.js\?v=<\?= portalAssetVersion\('\.\.\/libraries\/apps\/help\/app\.js'\) \?>"><\/script>\n/);
  assert.doesNotMatch(portal, /<!--[^>]*\n\s*<script src="\.\.\/libraries\/apps\/help\/app\.js/);
  assert.doesNotMatch(help, /fmHelpBtn/);
  assert.match(launchers, /data-fm-help-open|fmHelpOpen/);
});
