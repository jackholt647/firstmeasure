// The left column's footer has two layouts, chosen per organization by platform.sidebar_footer_layout:
// "stacked" (the default) keeps the account on its own full-width row at the bottom with Settings, Apps and
// Help & support as a row of icons above it; "inline" puts all four in one row of icons. Chrome runs the real
// launcher code and stylesheet from core.js with the portal's own styles (index.php) and the account switcher's,
// expanded, collapsed to the narrow icon column, and as the phone drawer.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { chromium } from 'playwright-core';

const read = path => readFile(new URL('../../' + path, import.meta.url), 'utf8');
const [core, portal, switcher, capabilityDefs, capabilities, company] = await Promise.all([
  read('portal/scripts/core.js'), read('portal/index.php'), read('libraries/account-switcher/account-switcher.js'),
  read('v1/platform/capability_defs.ts'), read('v1/platform/capabilities.ts'), read('libraries/apps/settings/company.js')
]);
// The Settings gate (1M8-236), where this checkout has it; renderSidebarLaunchers may call into it.
const gateStart = core.indexOf('  const SETTINGS_PERMISSIONS = ');
const gate = gateStart < 0 ? '' : core.slice(gateStart, core.indexOf('  function renderSidebarLaunchers('));
const launchers = core.slice(core.indexOf('  function renderSidebarLaunchers('), core.indexOf('  function renderTabs('));
const cssStart = core.indexOf("injectCSS('sidebar_links', `") + "injectCSS('sidebar_links', `".length;
const sidebarCss = core.slice(cssStart, core.indexOf('`);', cssStart));
const portalCss = [...portal.slice(0, portal.indexOf('<body')).matchAll(/<style[^>]*>([\s\S]*?)<\/style>/g)].map(match => match[1]).join('\n');
const switcherStart = switcher.indexOf('style.textContent = `') + 'style.textContent = `'.length;
const switcherCss = switcher.slice(switcherStart, switcher.indexOf('`;', switcherStart));

async function sidebar(browser, { layout, width, height = 900, compact = false, drawer = false }) {
  const page = await browser.newPage({ viewport: { width, height } });
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.setContent(`<!doctype html><html><head><style>${portalCss}\n${switcherCss}\n${sidebarCss}\n.sidebar,.sidebar *{transition:none!important;animation:none!important}</style></head><body>
    <aside class="sidebar apps-list-enabled${compact ? ' sidebar-compact' : ''}${drawer ? ' mob-open' : ''}" id="mainSidebar"><div class="sidebar-scroll">
      <div id="sidebarLinks"><div id="sidebarMainLinks"></div></div>
      <div id="sidebarBottomLinks" aria-label="Sidebar settings"></div>
      <div class="sidebar-footer">
        <button type="button" class="fm-account-switcher-trigger" id="accountSwitcherButton" aria-haspopup="dialog" aria-expanded="false" aria-label="Choose account">
          <span class="fm-account-avatar">J</span><span class="fm-account-trigger-copy"><strong>Jack Holt</strong><small>jack@example.test</small></span><i class="fm-account-trigger-chevron" aria-hidden="true">^</i>
        </button>
      </div>
    </div></aside>
    <main class="main"></main></body></html>`);
  await page.addScriptTag({ content: `
    const caps = ${JSON.stringify({ 'platform.more_apps': true, ...(layout ? { 'platform.sidebar_footer_layout': layout } : {}) })};
    window.Portal = { currentUser: { permissions: { '*': true } },
      appFlags: { current: () => ({}), has: () => false, value: (group, key, fallback) => fallback },
      capabilities: { current: () => ({ loaded_at: '1' }), value: (key, fallback) => (key in caps ? caps[key] : fallback) } };
    function hasPerm() { return true; }
    function escapeHtml(value) { return String(value ?? '').replace(/[&<>"']/g, c => '&#' + c.charCodeAt(0) + ';'); }
    let preservedSidebarAccountButton = null, advancedAppMenuOpen = false;
    const appCatalogEntries = () => [{ key: 'contacts', label: 'Contacts', icon: 'fa-address-book', addable: true }];
    const advancedAppMenuEnabled = () => false, closeAdvancedAppMenu = () => {}, renderAdvancedAppMenu = () => {}, openAdvancedAppMenu = () => {};
    const openAppCatalogModal = () => {}, updateAdvancedAppPin = () => {};
    function activateTab() {}
    ${gate}
    ${launchers}
    window.renderFooter = () => renderSidebarLaunchers(document.getElementById('sidebarBottomLinks'), [{ id: 'company_settings', placement: 'settings' }]);
    renderFooter();
  ` });
  return { page, errors };
}

const footerState = page => page.evaluate(() => {
  const box = element => {
    if (!element) return null;
    const rect = element.getBoundingClientRect();
    return { left: rect.left, right: rect.right, top: rect.top, bottom: rect.bottom, width: rect.width, height: rect.height };
  };
  const shown = element => !!element && element.getClientRects().length > 0 && getComputedStyle(element).visibility !== 'hidden';
  const bottom = document.getElementById('sidebarBottomLinks');
  const account = document.getElementById('accountSwitcherButton');
  const name = account?.querySelector('.fm-account-trigger-copy');
  const avatar = account?.querySelector('.fm-account-avatar');
  const launcher = key => bottom.querySelector(key === 'settings' ? '[data-tab="company_settings"]' : `[data-launcher="${key}"]`);
  return {
    layout: document.getElementById('mainSidebar').dataset.footerLayout,
    classes: bottom.className,
    sidebar: box(document.getElementById('mainSidebar')),
    viewport: { width: innerWidth, height: innerHeight },
    row: Object.fromEntries(['settings', 'more', 'help'].map(key => [key, shown(launcher(key)) ? box(launcher(key)) : null])),
    accountInRow: bottom.contains(account),
    account: shown(account) ? box(account) : null,
    name: shown(name) ? name.textContent.trim() : null,
    avatar: shown(avatar),
    userIcon: shown(account?.querySelector('.fm-account-launcher-user'))
  };
});

const inside = (inner, outer) => inner.left >= outer.left - 0.5 && inner.right <= outer.right + 0.5;
const inView = (rect, viewport) => rect.top >= 0 && rect.bottom <= viewport.height + 0.5 && rect.left >= 0 && rect.right <= viewport.width + 0.5;

test('stacked is the default: the account has its own full-width row below Settings, Apps and Help & support', async () => {
  const browser = await chromium.launch({ channel: 'chrome', headless: true });
  try {
    for (const layout of [undefined, 'stacked']) {
      const { page, errors } = await sidebar(browser, { layout, width: 1600 });
      const state = await footerState(page);
      assert.equal(state.layout, 'stacked', JSON.stringify(state));
      assert.match(state.classes, /sidebar-launchers-split/);
      const row = Object.values(state.row);
      assert.ok(row.every(Boolean), 'Settings, Apps and Help & support are all shown: ' + JSON.stringify(state.row));
      assert.ok(row.every(rect => Math.abs(rect.top - row[0].top) < 1), 'they share one row');
      assert.ok(row[0].right <= row[1].left && row[1].right <= row[2].left, 'in the order Settings, Apps, Help & support');
      assert.equal(state.accountInRow, false);
      assert.ok(state.account && state.account.top >= Math.max(...row.map(rect => rect.bottom)), 'the account is below the row');
      assert.ok(state.account.width >= state.sidebar.width * 0.8, 'and full width: ' + JSON.stringify(state.account));
      assert.equal(state.name, 'Jack Holtjack@example.test', "it shows the person's name");
      assert.equal(state.avatar, true);
      assert.equal(state.userIcon, false, 'not the bare user icon of the inline row');
      assert.ok(inView(state.account, state.viewport));
      assert.deepEqual(errors, []);
      await page.close();
    }
  } finally { await browser.close(); }
});

test('stacked collapsed: the icons stack in the narrow column with the avatar at the bottom', async () => {
  const browser = await chromium.launch({ channel: 'chrome', headless: true });
  try {
    const { page, errors } = await sidebar(browser, { width: 1600, compact: true });
    const state = await footerState(page);
    assert.ok(state.sidebar.width < 80, 'the column is collapsed: ' + state.sidebar.width);
    const row = Object.values(state.row);
    assert.ok(row.every(Boolean), JSON.stringify(state.row));
    assert.ok(row[0].bottom <= row[1].top && row[1].bottom <= row[2].top, 'Settings, Apps and Help & support stack vertically');
    assert.ok(row.every(rect => inside(rect, state.sidebar)), 'inside the narrow column');
    assert.ok(state.account && inside(state.account, state.sidebar), 'the account fits the column: ' + JSON.stringify(state.account));
    assert.ok(state.account.top >= row[2].bottom, 'below Help & support');
    assert.equal(state.avatar, true, 'the avatar stays');
    assert.equal(state.name, null, 'the name is hidden in the narrow column');
    assert.ok(inView(state.account, state.viewport));
    assert.deepEqual(errors, []);
  } finally { await browser.close(); }
});

test('stacked on a phone: the drawer shows the icon row and the account row, both in view', async () => {
  const browser = await chromium.launch({ channel: 'chrome', headless: true });
  try {
    const { page, errors } = await sidebar(browser, { width: 390, height: 844, drawer: true });
    const state = await footerState(page);
    assert.ok(state.sidebar.left >= -0.5 && state.sidebar.width > 200, 'the drawer is open: ' + JSON.stringify(state.sidebar));
    const row = Object.values(state.row);
    assert.ok(row.every(rect => rect && inView(rect, state.viewport) && inside(rect, state.sidebar)), JSON.stringify(state.row));
    assert.ok(row.every(rect => Math.abs(rect.top - row[0].top) < 1));
    assert.ok(state.account && inView(state.account, state.viewport) && state.account.top >= row[0].bottom, JSON.stringify(state.account));
    assert.equal(state.name, 'Jack Holtjack@example.test');
    assert.deepEqual(errors, []);
  } finally { await browser.close(); }
});

test('inline: Settings, Apps, Help & support and the account share one row of icons, expanded, collapsed and on a phone', async () => {
  const browser = await chromium.launch({ channel: 'chrome', headless: true });
  try {
    for (const setup of [{ width: 1600 }, { width: 1600, compact: true }, { width: 390, height: 844, drawer: true }]) {
      const { page, errors } = await sidebar(browser, { layout: 'inline', ...setup });
      const state = await footerState(page);
      assert.equal(state.layout, 'inline');
      assert.match(state.classes, /sidebar-launchers-integrated/);
      assert.equal(state.accountInRow, true);
      const icons = [...Object.values(state.row), state.account];
      assert.ok(icons.every(rect => rect && inView(rect, state.viewport) && inside(rect, state.sidebar)), JSON.stringify(setup) + JSON.stringify(state));
      if (setup.compact) assert.ok(icons.every((rect, index) => !index || icons[index - 1].bottom <= rect.top), 'stacked in the narrow column');
      else assert.ok(icons.every(rect => Math.abs(rect.top - icons[0].top) < 1), 'one row');
      assert.equal(state.userIcon, true, 'the account is the user icon');
      assert.equal(state.name, null);
      assert.deepEqual(errors, []);
      await page.close();
    }
  } finally { await browser.close(); }
});

test('switching the layout re-renders the footer either way', async () => {
  const browser = await chromium.launch({ channel: 'chrome', headless: true });
  try {
    const { page, errors } = await sidebar(browser, { layout: 'inline', width: 1600 });
    assert.equal((await footerState(page)).accountInRow, true);
    await page.evaluate(() => { const value = Portal.capabilities.value; Portal.capabilities.value = (key, fallback) => key === 'platform.sidebar_footer_layout' ? 'stacked' : value(key, fallback); renderFooter(); });
    let state = await footerState(page);
    assert.equal(state.accountInRow, false);
    assert.equal(state.name, 'Jack Holtjack@example.test');
    await page.evaluate(() => { const value = Portal.capabilities.value; Portal.capabilities.value = (key, fallback) => key === 'platform.sidebar_footer_layout' ? 'inline' : value(key, fallback); renderFooter(); });
    state = await footerState(page);
    assert.equal(state.accountInRow, true);
    assert.equal(state.userIcon, true);
    assert.deepEqual(errors, []);
  } finally { await browser.close(); }
});

test('the layout is an organization setting that defaults to stacked, also for FirstMeasure-only organizations', () => {
  assert.match(capabilityDefs, /key: "platform\.sidebar_footer_layout",[\s\S]{0,120}kind: "setting",[\s\S]{0,400}default: "stacked",\s*options: \[\["stacked", [^\]]+\], \["inline", [^\]]+\]\]/);
  assert.doesNotMatch(capabilityDefs, /key: "platform\.separate_user_section"/);
  assert.match(capabilities, /"platform\.sidebar_footer_layout", "platform\.cobrand_sidebar_logo"/);
  assert.match(company, /key: 'platform\.sidebar_footer_layout',[\s\S]{0,120}type: 'select',\s*defaultValue: 'stacked'/);
  assert.match(core, /capabilities\.value\?\.\('platform\.sidebar_footer_layout', 'stacked'\)/);
});
