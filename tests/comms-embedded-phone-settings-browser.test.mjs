// GP-79: the Call Center's Settings tab shows Settings › Phone Settings inside the app, as its own pane under the
// Settings tabs, instead of taking the person to the organization's Settings. It is the same page Settings mounts
// (FirstMatePhoneSettings through sms-registration.js), and it is taken down when the person leaves the tab.
// Runs the real comms files and sms-registration.js in Chromium; the shared chrome and the phone page are stubs.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';

const { chromium } = createRequire(new URL('../public/v1/package.json', import.meta.url))('playwright-core');
const CHROME = process.env.CHROME_PATH || 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const FILES = {
  'communications-ui.js': '../public/libraries/apps/comms/communications-ui.js',
  'workspace.js': '../public/libraries/apps/comms/workspace.js',
  'communications.css': '../public/libraries/apps/comms/communications.css',
  'sms-registration.js': '../public/libraries/apps/settings/sms-registration.js',
};
const file = (name) => readFileSync(new URL(FILES[name], import.meta.url), 'utf8');
const ORIGIN = 'http://fm.test';
const STUBS = `
  window.__APP = { userOrgId: 'org_1', userId: 'user_1' };
  window.__routes = []; window.__phoneMounts = []; window.__destroyed = 0;
  window.PlatformAPI = { appFlags: { has: (group, flag) => group === 'apps' && flag === 'comms' } };
  window.CommsAPI = { customer: () => new Promise(() => {}) };
  window.Portal = { CustomerPhone: { refreshStatus: () => new Promise(() => {}) }, navigation: {
    read: () => ({ tab: 'chat', communicationsView: 'history' }), registerSchema() {}, registerHandler() {},
    push: (patch) => window.__routes.push(['push', patch]), navigate: (patch) => window.__routes.push(['navigate', patch]),
    write: (patch) => window.__routes.push(['write', patch]), applyCurrent() {} } };
  window.AppChrome = {
    header: () => '<div data-app-header><button type="button" data-view="setup">Settings</button></div>',
    tabs: () => '', tabStrip: () => '', settings: () => '', resolve: (group, view) => view || 'history',
    settingsTabs: (group, selected, attribute, back) => '<nav class="app-tabs"><button type="button" ' + attribute + '="' + back + '">Back</button><button type="button" ' + attribute + '="setup" aria-current="' + (selected === 'setup' ? 'page' : 'false') + '">Phone setup</button></nav>',
  };
  window.FirstMatePhoneSettings = { mount: async (root, options) => {
    window.__phoneMounts.push({ inApp: !!root.closest('.fmcm-view'), orgId: options.orgId, initialTab: options.initialTab, registration: typeof options.registration });
    root.innerHTML = '<div class="ph"><nav class="ph-nav"><button type="button" data-tab="personal" aria-current="page">My Phone</button><button type="button" data-tab="numbers" aria-current="false">Numbers &amp; Users</button></nav></div>';
    return { destroy: () => { window.__destroyed += 1; } };
  } };`;
const PAGE = `<!doctype html><html><head><script>${STUBS}</script>
  <script src="/libraries/apps/settings/sms-registration.js"></script>
  <script src="/libraries/apps/comms/communications-ui.js"></script><script src="/libraries/apps/comms/workspace.js"></script></head>
  <body style="margin:0"><div id="app" style="height:800px"></div></body></html>`;

test('the Call Center Settings tab mounts Phone Settings in the app, not organization Settings', async () => {
  const browser = await chromium.launch({ executablePath: CHROME, headless: true });
  try {
    const page = await browser.newPage({ viewport: { width: 1200, height: 900 } });
    await page.route(`${ORIGIN}/**`, (route) => {
      const name = new URL(route.request().url()).pathname.split('/').pop();
      if (!FILES[name]) return route.fulfill({ contentType: 'text/html', body: PAGE });
      return route.fulfill({ contentType: name.endsWith('.css') ? 'text/css' : 'text/javascript', body: file(name) });
    });
    await page.goto(`${ORIGIN}/`, { waitUntil: 'domcontentloaded' });
    await page.evaluate(() => { window.__handle = Portal.CommunicationsWorkspace.mount(document.getElementById('app'), {}); });
    await page.waitForFunction(() => Portal.CommunicationsUI.cssLoaded());
    await page.click('[data-app-header] [data-view="setup"]');
    await page.waitForFunction(() => window.__phoneMounts.length === 1 && document.querySelector('[data-phone-settings] .ph-nav'));

    const mounted = await page.evaluate(() => window.__phoneMounts[0]);
    assert.deepEqual(mounted, { inApp: true, orgId: 'org_1', initialTab: 'personal', registration: 'function' }, 'the Settings page, in the app\'s own pane');
    const routes = await page.evaluate(() => window.__routes);
    assert.equal(routes.some(([, patch]) => patch.tab === 'company_settings'), false, 'never sent to organization Settings');
    assert.deepEqual(routes.at(-1), ['push', { tab: 'chat', communicationsView: 'setup' }], 'Settings is the app\'s own sub-tab');
    assert.equal(await page.locator('.fmcm-view > .app-tabs [data-view="setup"][aria-current="page"]').count(), 1, 'under the app\'s Settings tabs');
    // The app's button styles do not reshape the page's menu (communications.css).
    assert.equal(await page.evaluate(() => getComputedStyle(document.querySelector('[data-phone-settings] .ph-nav button')).justifyContent), 'flex-start');

    await page.click('.fmcm-view > .app-tabs [data-view="history"]');
    await page.waitForFunction(() => window.__destroyed === 1);
    await page.evaluate(() => window.__handle.destroy());
    assert.equal(await page.evaluate(() => window.__destroyed), 1, 'taken down once, when leaving Settings');
  } finally {
    await browser.close();
  }
});
