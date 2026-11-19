// GP-11: a project's Calls look like its Email and Texts: the calls on the left, the selected call's details, outcome,
// recording and transcript on the right (comms/workspace.js projectCalls in comms/project.js's .fmco-split). On a
// phone the list and the call take turns. The Communications app's own call history stays a table.
// Runs the real files in Chromium with the comms API stubbed.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';

const { chromium } = createRequire(new URL('../public/v1/package.json', import.meta.url))('playwright-core');
const CHROME = process.env.CHROME_PATH || 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const file = (name) => readFileSync(new URL(`../public/libraries/apps/comms/${name}`, import.meta.url), 'utf8');
const ORIGIN = 'http://fm.test';
const PAGE = `<!doctype html><html><head><meta charset="utf-8"><script>window.FirstMateEmbeddableApps={registerApp(app){window.__commsApp=app;}};</script>
  <script src="/libraries/apps/comms/communications-ui.js"></script><script src="/libraries/apps/comms/workspace.js"></script><script src="/libraries/apps/comms/project.js"></script></head>
  <body style="margin:0;font-family:Arial"><div id="panel" hidden></div><div class="fmco-content" id="calls" style="height:640px;display:flex;flex-direction:column"></div><div id="app" style="height:640px"></div></body></html>`;

const CALLS = [
  { id: 'call_1', customer_name: 'Dana Reyes', customer_number: '+12065550101', business_number: '+12065550199', direction: 'inbound', mode: 'browser', state: 'ended', created_at: '2026-11-18T17:00:00Z', connected_at: '2026-11-18T17:00:05Z', ended_at: '2026-11-18T17:03:17Z', wrap_up_state: 'saved', result: { disposition: 'appointment_set', next_action: 'send_estimate' }, notes: 'Wants an estimate for the back roof.', metadata: { consent: { state: 'granted' } } },
  { id: 'call_2', customer_name: 'Dana Reyes', customer_number: '+12065550101', business_number: '+12065550199', direction: 'outbound', mode: 'external', state: 'ended', created_at: '2026-11-17T15:00:00Z', wrap_up_state: 'needs_wrap_up', metadata: {} },
];

async function open(browser, viewport) {
  const page = await browser.newPage({ viewport });
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.route(`${ORIGIN}/**`, async (route) => {
    const url = new URL(route.request().url());
    if (url.pathname === '/') return route.fulfill({ contentType: 'text/html', body: PAGE });
    const name = url.pathname.split('/').pop();
    if (url.pathname.endsWith('/media')) return route.fulfill({ contentType: 'audio/mpeg', body: '' });
    return route.fulfill({ contentType: name.endsWith('.css') ? 'text/css' : 'text/javascript', body: file(name) });
  });
  // workspace.js takes Portal.CustomerPhone when it loads, so the stubs come first.
  await page.addInitScript((calls) => {
    window.requests = []; window.opened = [];
    window.__APP = { orgId: 'org_1', userId: 'user_1' };
    window.CommsAPI = {
      customerUrl: (org, path) => `/v1/comms/organizations/${org}/${path}`,
      customer: async (_org, path) => {
        window.requests.push(path);
        if (path.startsWith('calls?')) return { calls, next_cursor: '' };
        if (path === 'calls/call_1') return { call: calls[0], permissions: { recordings: true } };
        if (path === 'calls/call_2') return { call: calls[1], permissions: { recordings: true } };
        if (path === 'calls/call_1/artifacts') return { artifacts: [{ id: 'art_rec', kind: 'recording', state: 'ready', expires_at: '2027-01-01T00:00:00Z' }, { id: 'art_tx', kind: 'transcript', state: 'ready', data: { text: 'Hi, this is Dana about the roof.' } }] };
        if (path === 'calls/call_2/artifacts') return { artifacts: [] };
        return {};
      },
    };
    window.Portal = { CustomerPhone: { status: { channels: { calls: 'ready' }, permissions: { recordings: true } }, refreshStatus: async () => Portal.CustomerPhone.status, open: async (input) => { window.opened.push(input); return true; } } };
  }, CALLS);
  await page.goto(`${ORIGIN}/`, { waitUntil: 'domcontentloaded' });
  await page.evaluate(() => { document.getElementById('panel').innerHTML = window.__commsApp.panelHtml({}); });// the tab's styles
  await page.waitForFunction(() => Portal.CommunicationsUI.cssLoaded());
  return { page, errors };
}

const box = (page, selector) => page.evaluate((s) => { const el = document.querySelector(s); if (!el || getComputedStyle(el).display === 'none') return null; const r = el.getBoundingClientRect(); return r.width && r.height ? { x: r.x, y: r.y, w: r.width, h: r.height } : null; }, selector);

test('a project\'s Calls are a list on the left and the selected call on the right', async () => {
  const browser = await chromium.launch({ executablePath: CHROME, headless: true });
  try {
    const { page, errors } = await open(browser, { width: 1200, height: 800 });
    await page.evaluate(() => { window.handle = Portal.CommunicationsWorkspace.mount(document.getElementById('calls'), { projectId: 'project_1' }); });
    await page.waitForSelector('[data-project-calls] .fmco-call-row');
    assert.equal(await page.locator('#calls table').count(), 0, 'no history table in a project');
    assert.equal(await page.locator('.fmco-call-row').count(), 2);
    assert.match(await page.locator('.fmco-call-row').nth(1).innerText(), /Needs outcome/);
    const list = await box(page, '[data-call-list]'), pane = await box(page, '[data-call-detail]');
    assert.ok(list && pane && pane.x > list.x + list.w - 1 && Math.abs(list.y - pane.y) < 2, 'list and call side by side');
    assert.match(await page.locator('[data-call-detail]').innerText(), /Select a call/);

    await page.locator('.fmco-call-row').first().click();
    await page.waitForSelector('[data-call-detail] .fmco-call-transcript');
    const detail = await page.locator('[data-call-detail]').innerText();
    for (const text of ['Dana Reyes', 'Appointment set', '3m 12s', 'Send estimate', 'Wants an estimate', 'Hi, this is Dana about the roof.']) assert.ok(detail.includes(text), `detail shows ${text}`);
    assert.equal(await page.locator('[data-call-detail] audio').getAttribute('src'), '/v1/comms/organizations/org_1/calls/call_1/artifacts/art_rec/media');
    assert.equal(await page.locator('.fmco-call-row.active').count(), 1);
    assert.ok((await page.evaluate(() => window.requests)).includes('conversation-workflow'), 'an inbound call is marked read');

    // A list refresh keeps the open call's pane (a playing recording is not interrupted).
    await page.evaluate(() => { document.querySelector('[data-call-detail] audio').dataset.mark = '1'; return window.handle.refresh(true, true); });
    assert.equal(await page.locator('[data-call-detail] audio[data-mark]').count(), 1);

    await page.locator('.fmco-call-row').nth(1).click();
    await page.waitForSelector('[data-call-detail] .fmco-call-needs');
    await page.locator('[data-call-detail] .fmco-call-needs [data-action="open-call"]').click();
    await page.locator('[data-call-detail] [data-action="call-back"]').click();
    assert.deepEqual(await page.evaluate(() => window.opened), [{ call_id: 'call_2' }, { project_id: 'project_1', customer_number: '+12065550101', contact_id: '' }]);
    await page.evaluate(() => window.handle.destroy());
    assert.deepEqual(errors, []);
  } finally {
    await browser.close();
  }
});

test('on a phone the call list and the call take turns', async () => {
  const browser = await chromium.launch({ executablePath: CHROME, headless: true });
  try {
    const { page, errors } = await open(browser, { width: 390, height: 844 });
    await page.evaluate(() => { window.handle = Portal.CommunicationsWorkspace.mount(document.getElementById('calls'), { projectId: 'project_1' }); });
    await page.waitForSelector('[data-project-calls] .fmco-call-row');
    assert.ok(await box(page, '[data-call-list]'));
    assert.equal(await box(page, '[data-call-detail]'), null, 'only the list');
    await page.locator('.fmco-call-row').first().click();
    await page.waitForSelector('[data-call-detail] .fmco-call-transcript');
    assert.equal(await box(page, '[data-call-list]'), null, 'only the call');
    const pane = await box(page, '[data-call-detail]');
    assert.ok(pane.w >= 380, 'the call takes the width');
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), 'nothing overflows sideways');
    await page.locator('[data-call-detail] [data-action="close-call"]').click();
    assert.ok(await box(page, '[data-call-list]'), 'back to the list');
    assert.deepEqual(errors, []);
  } finally {
    await browser.close();
  }
});

test('the Communications app keeps its call history table', async () => {
  const browser = await chromium.launch({ executablePath: CHROME, headless: true });
  try {
    const { page, errors } = await open(browser, { width: 1200, height: 800 });
    await page.evaluate(() => {
      window.AppChrome = { resolve: () => 'history', header: () => '', tabs: () => '' };
      window.handle = Portal.CommunicationsWorkspace.mount(document.getElementById('app'), { standalone: 'history' });
    });
    await page.waitForSelector('#app table');
    assert.equal(await page.locator('#app [data-project-calls]').count(), 0);
    assert.deepEqual(errors, []);
  } finally {
    await browser.close();
  }
});
