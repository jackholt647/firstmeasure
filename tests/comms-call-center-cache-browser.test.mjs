// GP-81: the Call Center never sits on "Loading communications…". A mode opens at once: from what it showed last on this
// page (and refreshes behind it), or, the first time, as its own layout with placeholder rows. The phone status is
// fetched beside a mode's data, not before it. Runs the real comms files in Chromium; every request is held until
// the test releases it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';

const { chromium } = createRequire(new URL('../public/v1/package.json', import.meta.url))('playwright-core');
const CHROME = process.env.CHROME_PATH || 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const file = (name) => readFileSync(new URL(`../public/libraries/apps/comms/${name}`, import.meta.url), 'utf8');
const ORIGIN = 'http://fm.test';
const STUBS = `
  window.__APP = { userOrgId: 'org_1', userId: 'user_1' };
  window.__held = [];
  const hold = (path) => new Promise((resolve) => window.__held.push({ path, resolve }));
  window.__release = (prefix, value) => { const left = []; for (const item of window.__held) (item.path.startsWith(prefix) ? item.resolve(value) : left.push(item)); window.__held = left; };
  window.__waiting = () => window.__held.map((item) => item.path.split('?')[0]);
  window.PlatformAPI = { appFlags: { has: (group, flag) => group === 'apps' && flag === 'comms' } };
  window.CommsAPI = { customer: (org, path) => hold(path) };
  let known = null;
  window.Portal = { CustomerPhone: { get status() { return known; }, refreshStatus: () => hold('voice/status').then((status) => (known = status)) },
    navigation: { read: () => ({}), registerSchema() {}, registerHandler() {}, push() {}, replace() {} } };
  window.AppChrome = {
    header: ({ strip }) => '<div data-app-header>' + (strip || '') + '</div>', tabs: () => '', settings: () => '', settingsTabs: () => '', resolve: (group, view) => view || 'center',
    tabStrip: ({ attribute, items }) => items.map((item) => '<button type="button" ' + (item.attribute || attribute) + '="' + item.id + '">' + item.title + '</button>').join(''),
  };`;
const PAGE = `<!doctype html><html><head><script>${STUBS}</script>
  <script src="/libraries/apps/comms/communications-ui.js"></script><script src="/libraries/apps/comms/workspace.js"></script></head>
  <body style="margin:0"><div id="app" style="height:800px"></div></body></html>`;
const STATUS = { permissions: { manage: true }, settings: { enabled: true } };
const QUEUE = { columns: [{ id: 'list_1', key: 'list_1', title: 'Storm leads', tasks: [{ id: 'entry_1', name: 'Ana Souza', phone: '+13035550110', ready: true }] }] };

const shown = (page) => page.evaluate(() => {
  const view = document.querySelector('.fmcm-view');
  return {
    mode: view.querySelector('.fmcc-dial-controls') ? 'call' : view.querySelector('.fmcc-filters') ? 'personal' : view.querySelector('.fmcc-stats') ? 'manager' : '',
    status: [...view.querySelectorAll('[role=status]')].map((el) => el.getAttribute('aria-label') || el.textContent),
    blank: !!view.querySelector(':scope > .fmcm-empty'),
    placeholders: view.querySelectorAll('.fmcc-skeleton').length,
    text: view.textContent,
  };
});

test('the Call Center draws each mode at once and fills it in as its data arrives', async () => {
  const browser = await chromium.launch({ executablePath: CHROME, headless: true });
  try {
    const page = await browser.newPage({ viewport: { width: 1300, height: 900 } });
    await page.route(`${ORIGIN}/**`, (route) => {
      const name = new URL(route.request().url()).pathname.split('/').pop();
      if (!name) return route.fulfill({ contentType: 'text/html', body: PAGE });
      return route.fulfill({ contentType: (name.endsWith('.css') ? 'text/css' : 'text/javascript') + '; charset=utf-8', body: file(name) });
    });
    await page.clock.install();
    await page.goto(`${ORIGIN}/`, { waitUntil: 'domcontentloaded' });
    await page.evaluate(() => { window.__handle = Portal.CommunicationsWorkspace.mount(document.getElementById('app'), { standalone: 'center' }); });
    await page.waitForFunction(() => Portal.CommunicationsUI.cssLoaded());

    // First visit, nothing has answered yet: the calling desk's layout with placeholders, not a blank "Loading…".
    let now = await shown(page);
    assert.equal(now.mode, 'call', 'the calling desk\'s controls');
    assert.deepEqual(now.status, ['Loading leads…'], 'one loading status');
    assert.equal(now.blank, false, 'no full-view loading message');
    assert.ok(now.placeholders >= 1);
    assert.doesNotMatch(now.text, /Browser calling is off/, 'no setup notice before the status is known');
    assert.deepEqual((await page.evaluate(() => window.__waiting())).sort(), ['call-lists/queue', 'call-scripts', 'voice/status'], 'leads are asked for with the status, not after it');
    // The 5-second refresh does not start the view over while it is still on its way (a slow answer was dropped every time).
    await page.evaluate(() => document.activeElement?.blur());
    await page.clock.runFor(16000);
    assert.equal((await page.evaluate(() => window.__waiting())).length, 3, 'no refresh over a load in flight');
    await page.evaluate((status) => window.__release('voice/status', status), STATUS);
    await page.evaluate((queue) => { window.__release('call-lists/queue', queue); window.__release('call-scripts', { scripts: [] }); }, QUEUE);
    await page.waitForFunction(() => document.querySelector('.fmcc-lead'));
    assert.equal((await shown(page)).placeholders, 0);
    await page.waitForFunction(() => window.__held.length === 0);

    // Personal for the first time: its layout at once, and its calls are asked for without waiting for the phone status.
    await page.click('[data-center-mode="personal"]');
    now = await shown(page);
    assert.equal(now.mode, 'personal', 'its filters');
    assert.equal(now.blank, false);
    assert.ok(now.placeholders >= 1, 'placeholder rows');
    assert.deepEqual(now.status, ['Loading your calls…']);
    assert.deepEqual((await page.evaluate(() => window.__waiting())).sort(), ['calls', 'voice/status'], 'status and calls together');
    await page.evaluate(() => window.__release('calls', { calls: [{ id: 'call_1', customer_name: 'Tom Lee', created_at: new Date().toISOString(), direction: 'outbound' }], total: 1 }));
    // The mode's rows wait for the status the same request started, then show.
    await page.evaluate((status) => window.__release('voice/status', status), STATUS);
    await page.waitForFunction(() => document.querySelector('.fmcc-history-row'));
    assert.match((await shown(page)).text, /Tom Lee/);

    // Back to the calling desk: what it showed last, at once, while it refreshes behind.
    await page.click('[data-center-mode="call"]');
    now = await shown(page);
    assert.equal(now.mode, 'call');
    assert.equal(now.placeholders, 0, 'no placeholders for a mode already shown');
    assert.match(now.text, /Ana Souza/);
    assert.ok((await page.evaluate(() => window.__waiting())).includes('call-lists/queue'), 'and it refreshes');
    await page.evaluate((status) => {
      window.__release('voice/status', status);
      window.__release('call-lists/queue', { columns: [{ id: 'list_1', key: 'list_1', title: 'Storm leads', tasks: [{ id: 'entry_2', name: 'Priya Raman', phone: '+13035550111', ready: true }] }] });
      window.__release('call-scripts', { scripts: [] });
    }, STATUS);
    await page.waitForFunction(() => /Priya Raman/.test(document.querySelector('.fmcm-view').textContent));
    await page.evaluate(() => window.__handle.destroy());

    // A new mount on the same page (opening the app again from another tab) starts from the cache too.
    await page.evaluate(() => { window.__held = []; window.__handle = Portal.CommunicationsWorkspace.mount(document.getElementById('app'), { standalone: 'center' }); });
    now = await shown(page);
    assert.equal(now.placeholders, 0);
    assert.match(now.text, /Priya Raman/);
    await page.evaluate(() => window.__handle.destroy());
  } finally {
    await browser.close();
  }
});
