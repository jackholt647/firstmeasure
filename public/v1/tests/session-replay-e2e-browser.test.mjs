import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, mkdir } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test, { after, before } from 'node:test';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';

// Session replay end to end (docs/architecture/session-replay.md): a signed-in page that
// loads platform-api.js records through the real routes once a platform administrator
// switches the organization on, and the viewer lists the session and plays it.
// REPLAY_SCREENSHOTS=<dir> keeps screenshots of the viewer.
// node --experimental-sqlite --import tsx --test tests/session-replay-e2e-browser.test.mjs

const PUBLIC = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const ORIGIN = 'http://replay-e2e.test';
const SHOTS = process.env.REPLAY_SCREENSHOTS || '';
const TYPES = { '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png', '.html': 'text/html' };
let app = null, storageRoot = '';
const cookieValue = (setCookie, name) => (Array.isArray(setCookie) ? setCookie : setCookie ? [setCookie] : []).find((v) => v.startsWith(`${name}=`))?.split(';')[0].split('=').slice(1).join('=') || '';

async function register(label, internal) {
  const { nextTestPhone } = await import('./helpers/platform-fixture.js');
  const suffix = Math.random().toString(36).slice(2, 8);
  const email = `${label}-${suffix}@example.test`;
  const response = await app.inject({ method: 'POST', url: '/v1/platform/auth/register', payload: {
    phone: nextTestPhone(), email, password: 'correct horse battery staple', name: label === 'owner' ? 'Dana Owner' : 'Platform Admin', company: `${label} Roofing`, organization_id: `org_${label}_${suffix}`
  } });
  assert.equal(response.statusCode, 201, response.body);
  if (internal) await (await import('../internal/storage.js')).saveInternalUser({ email, name: label, status: 'active', role: 'admin' });
  return { email, orgId: response.json().organization.id, session: cookieValue(response.headers['set-cookie'], 'fm_platform_session'), csrf: cookieValue(response.headers['set-cookie'], 'fm_platform_session_csrf') };
}

const PAGE = `<!DOCTYPE html><html><head><meta charset="utf-8"><title>Projects</title>
<style>body{font-family:Arial,sans-serif;margin:0;background:#f6f7f9}header{background:#1f2937;color:#fff;padding:14px 20px;font-weight:700}
.wrap{display:flex}nav{width:200px;background:#fff;height:100vh;border-right:1px solid #e5e7eb}nav a{display:block;padding:10px 16px;color:#111;text-decoration:none}
nav a:hover{background:#fee2e2}main{padding:20px;flex:1}.card{background:#fff;border:1px solid #e5e7eb;border-radius:10px;padding:14px;margin-bottom:10px}
.menu{display:none;background:#fff;border:1px solid #ddd;border-radius:8px;position:absolute;padding:6px}.menu.open{display:block}button{padding:8px 14px;border-radius:8px;border:0;background:#dc2626;color:#fff}</style>
</head><body><header>FirstMate</header><div class="wrap"><nav><a href="#">Today</a><a href="#">Projects</a><a href="#">Schedule</a></nav>
<main><div class="card"><button id="new">New project</button><div class="menu" id="menu"><div>Roof</div><div>Siding</div><div>Gutters</div></div></div>
<div class="card"><input id="search" placeholder="Search projects"> <input id="pw" type="password" placeholder="PIN"></div><div id="results"></div></main></div>
<script>window.__APP={platformApiBase: location.origin + '/v1/platform', platformSessionCookieName: 'fm_platform_session'};
document.getElementById('new').addEventListener('click',()=>document.getElementById('menu').classList.toggle('open'));
document.getElementById('search').addEventListener('input',(e)=>{const q=e.target.value;document.getElementById('results').innerHTML=['Smith roof','Jones siding','Lee gutters','Park windows'].filter(n=>n.toLowerCase().includes(q.toLowerCase())).map(n=>'<div class="card">'+n+'</div>').join('');});</script>
<script src="/libraries/platform-api/platform-api.js"></script></body></html>`;

before(async () => {
  storageRoot = await mkdtemp(path.join(os.tmpdir(), 'firstmate-replay-e2e-'));
  Object.assign(process.env, {
    NODE_ENV: 'test', PLATFORM_HEARTBEAT_DISABLED: '1', WORK_SCHEDULER_DISABLED: '1', FIRSTMEASURE_JOB_WORKERS: '0',
    PLATFORM_STORAGE_ROOT: path.join(storageRoot, 'platform'), INTERNAL_STORAGE_ROOT: path.join(storageRoot, 'internal'), CRM_STORAGE_ROOT: path.join(storageRoot, 'crm'),
    FIRSTMEASURE_STORAGE_ROOT: path.join(storageRoot, 'firstmeasure'), FIRSTMEASURE_INDEX_DB_PATH: path.join(storageRoot, 'firstmeasure', 'projects_index.sqlite'),
    PRICEBOOK_STORAGE_ROOT: path.join(storageRoot, 'pricebook'), EMAIL_OUTBOUND_DISABLED: '1', V1_LOG_LEVEL: 'error'
  });
  const { buildApp } = await import('../src/app.js');
  app = await buildApp();
  await app.ready();
});
after(async () => {
  if (app) await app.close();
  await (await import('./helpers/platform-fixture.js')).closePlatformFixtureStores();
  await (await import('../session-replay/storage.js')).closeSessionReplayDatabase();
  await (await import('../platform/sql_store.js')).closeSqlStoresForTests();
  try { await rm(storageRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); } catch (error) { if (!['EBUSY', 'EPERM'].includes(error?.code)) throw error; }
});

async function contextFor(browser, who) {
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1 });
  await context.addCookies([{ name: 'fm_platform_session', value: who.session, url: ORIGIN }, { name: 'fm_platform_session_csrf', value: who.csrf, url: ORIGIN }]);
  await context.route('**/*', async (route) => {
    const request = route.request(), url = new URL(request.url());
    if (url.origin !== ORIGIN) return route.abort();
    if (url.pathname === '/app/projects') return route.fulfill({ status: 200, contentType: 'text/html', body: PAGE });
    if (url.pathname.startsWith('/v1/')) {
      const response = await app.inject({ method: request.method(), url: url.pathname + url.search, payload: request.postData() || undefined, headers: { ...request.headers(), host: 'replay-e2e.test' } });
      return route.fulfill({ status: response.statusCode, headers: { 'content-type': String(response.headers['content-type'] || 'application/json') }, body: response.body });
    }
    try { const body = await readFile(path.join(PUBLIC, decodeURIComponent(url.pathname))); return route.fulfill({ status: 200, contentType: TYPES[path.extname(url.pathname)] || 'application/octet-stream', body }); }
    catch { return route.fulfill({ status: 404, body: '' }); }
  });
  return context;
}

test('a signed-in page records through the platform and the viewer plays it back', { timeout: 180000 }, async () => {
  const owner = await register('owner');
  const admin = await register('admin', true);
  const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH || 'C:/Program Files/Google/Chrome/Application/chrome.exe', headless: true });
  try {
    // Off by default: the page loads only the loader.
    const ownerContext = await contextFor(browser, owner);
    const page = await ownerContext.newPage();
    const errors = [];
    page.on('pageerror', (error) => errors.push(String(error)));
    await page.goto(ORIGIN + '/app/projects');
    await page.waitForFunction(() => window.FMReplay && window.FMReplay.status().state === 'off');
    assert.equal(await page.evaluate(() => typeof window.FMReplayRecorder), 'undefined');

    // A platform administrator switches the organization on in the viewer.
    const adminContext = await contextFor(browser, admin);
    const viewer = await adminContext.newPage();
    const viewerErrors = [];
    viewer.on('pageerror', (error) => viewerErrors.push(String(error)));
    viewer.on('response', async (response) => { if (response.status() >= 400) viewerErrors.push(response.status() + ' ' + response.url() + ' ' + (await response.text().catch(() => '')).slice(0, 300)); });
    await viewer.goto(ORIGIN + '/libraries/session-replay/viewer.html');
    await viewer.waitForSelector('#org-panel:not([hidden])', { timeout: 15000 }).catch(async (error) => {
      throw new Error(error.message + '\nviewer: ' + (await viewer.textContent('body')).replace(/\s+/g, ' ').slice(0, 400) + '\nerrors: ' + viewerErrors.join('\n'));
    });
    await viewer.click('#org-more');
    await viewer.fill('#org-search', owner.orgId);
    await viewer.waitForSelector(`#org-list input[data-org="${owner.orgId}"]`, { state: 'attached' });
    await viewer.click(`#org-list input[data-org="${owner.orgId}"] + span`);
    await viewer.waitForFunction((orgId) => document.querySelector(`#org-list input[data-org="${orgId}"]`).checked, owner.orgId);

    // The next page load records.
    await page.reload();
    await page.waitForFunction(() => window.FMReplay && window.FMReplay.status().recording === true);
    await page.mouse.move(100, 160, { steps: 8 });
    await page.mouse.move(80, 200, { steps: 8 });
    await page.click('#new');
    await page.click('#search');
    await page.keyboard.type('roof', { delay: 40 });
    await page.click('#pw');
    await page.keyboard.type('4321', { delay: 40 });
    await page.evaluate(() => window.FMReplay.overlay(true));
    await page.waitForTimeout(1200);
    if (SHOTS) { await mkdir(SHOTS, { recursive: true }); await page.screenshot({ path: path.join(SHOTS, 'recorded-page-overlay.png') }); }
    await page.evaluate(() => window.FMReplay.flush());
    await page.waitForFunction(() => window.FMReplay.status().chunks_queued === 0 && window.FMReplay.status().chunks_sent > 0);
    const stats = await page.evaluate(() => window.FMReplay.status());
    assert.equal(stats.upload_failures, 0);
    const sessionId = stats.session_id;

    // The viewer lists it and plays it.
    await viewer.goto(ORIGIN + '/libraries/session-replay/viewer.html#session=' + sessionId);
    await viewer.waitForFunction(() => document.querySelector('.fmr-frame iframe') && document.querySelectorAll('#event-list .event').length > 3);
    await viewer.waitForFunction(() => /owner/i.test(document.querySelector('#session-list').textContent), null, { timeout: 15000 }).catch(async (error) => {
      throw new Error(error.message + '\nlist: ' + (await viewer.textContent('#session-list')).slice(0, 300) + '\nerrors: ' + viewerErrors.join('\n'));
    });
    const events = await viewer.$$eval('#event-list .event .d', (nodes) => nodes.map((node) => node.textContent));
    assert.ok(events.some((text) => text.includes('Clicked') && text.includes('New project')), events.join(' | '));
    assert.ok(events.some((text) => text.includes('Typed in a field')), events.join(' | '));
    await viewer.click('#play');
    await viewer.waitForTimeout(2500);
    const replayed = await viewer.evaluate(() => {
      const doc = document.querySelector('.fmr-frame iframe').contentDocument;
      return { menuOpen: doc.getElementById('menu')?.classList.contains('open'), search: doc.getElementById('search')?.value, pin: doc.getElementById('pw')?.value };
    });
    assert.deepEqual(replayed, { menuOpen: true, search: 'roof', pin: '****' });
    if (SHOTS) {
      await viewer.screenshot({ path: path.join(SHOTS, 'viewer-events.png') });
      await viewer.click('.tab[data-tab="storage"]');
      await viewer.waitForTimeout(300);
      await viewer.screenshot({ path: path.join(SHOTS, 'viewer-storage.png') });
      await viewer.click('.tab[data-tab="performance"]');
      await viewer.waitForTimeout(300);
      await viewer.screenshot({ path: path.join(SHOTS, 'viewer-performance.png') });
    }
    assert.deepEqual(errors, []);
    assert.deepEqual(viewerErrors, []);
  } finally {
    await browser.close();
  }
});
