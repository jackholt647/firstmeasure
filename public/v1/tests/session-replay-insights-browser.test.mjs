import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test, { after, before } from 'node:test';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';

// Session replay search (docs/architecture/session-replay-search.md): two sessions of a small app are recorded
// through the real routes, indexed, and questioned through the tool endpoint a language model uses.
// node --experimental-sqlite --import tsx --test tests/session-replay-insights-browser.test.mjs

const PUBLIC = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const ORIGIN = 'http://replay-insights.test';
const TYPES = { '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.html': 'text/html' };
let app = null, storageRoot = '';
const cookieValue = (setCookie, name) => (Array.isArray(setCookie) ? setCookie : setCookie ? [setCookie] : []).find((v) => v.startsWith(`${name}=`))?.split(';')[0].split('=').slice(1).join('=') || '';

async function register(label, internal) {
  const { nextTestPhone } = await import('./helpers/platform-fixture.js');
  const suffix = Math.random().toString(36).slice(2, 8);
  const email = `${label}-${suffix}@example.test`;
  const response = await app.inject({ method: 'POST', url: '/v1/platform/auth/register', payload: {
    phone: nextTestPhone(), email, password: 'correct horse battery staple', name: label, company: `${label} Co`, organization_id: `org_${label}_${suffix}` } });
  assert.equal(response.statusCode, 201, response.body);
  if (internal) await (await import('../internal/storage.js')).saveInternalUser({ email, name: label, status: 'active', role: 'admin' });
  return { email, orgId: response.json().organization.id, session: cookieValue(response.headers['set-cookie'], 'fm_platform_session'), csrf: cookieValue(response.headers['set-cookie'], 'fm_platform_session_csrf') };
}

const PAGE = `<!DOCTYPE html><html><head><meta charset="utf-8"><title>Acme Projects</title>
<style>body{font-family:Arial,sans-serif;margin:0}nav button{margin:6px}.panel{padding:16px}[role=dialog]{border:1px solid #999;padding:12px;margin:12px}.error{color:#b00}</style></head>
<body><nav role="tablist" aria-label="Sections"><button role="tab" id="tab-projects" aria-selected="true">Projects</button><button role="tab" id="tab-settings" aria-selected="false">Settings</button></nav>
<main class="panel" id="main"><h1 id="title">Projects</h1><button id="new">New project</button> <button id="broken">Broken</button><ul id="list"><li>Smith roof</li></ul></main>
<script>window.__APP={platformApiBase: location.origin + '/v1/platform', platformSessionCookieName: 'fm_platform_session'};
const main = document.getElementById('main');
function show(tab) {
  document.getElementById('tab-projects').setAttribute('aria-selected', String(tab === 'projects'));
  document.getElementById('tab-settings').setAttribute('aria-selected', String(tab === 'settings'));
  document.getElementById('title').textContent = tab === 'projects' ? 'Projects' : 'Settings';
  history.pushState({}, '', '/app/acme?tab=' + tab);
}
document.getElementById('tab-projects').onclick = () => show('projects');
document.getElementById('tab-settings').onclick = () => show('settings');
document.getElementById('new').onclick = () => {
  const box = document.createElement('div');
  box.setAttribute('role', 'dialog'); box.setAttribute('aria-modal', 'true'); box.id = 'dialog';
  box.innerHTML = '<h2>New project</h2><label for="name">Project name</label> <input id="name"> <button id="save">Save</button><div id="msg"></div>';
  main.appendChild(box);
  box.querySelector('#save').onclick = () => {
    const name = box.querySelector('#name').value.trim();
    if (!name) { box.querySelector('#msg').innerHTML = '<div class="error" role="alert">Project name is required</div>'; return; }
    const li = document.createElement('li'); li.textContent = name; document.getElementById('list').appendChild(li); box.remove();
  };
};
</script><script src="/libraries/platform-api/platform-api.js"></script></body></html>`;

before(async () => {
  storageRoot = await mkdtemp(path.join(os.tmpdir(), 'firstmate-replay-insights-'));
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
  await (await import('../session-replay/insights/store.js')).closeReplayInsightsDatabase();
  await (await import('../session-replay/storage.js')).closeSessionReplayDatabase();
  await (await import('../platform/sql_store.js')).closeSqlStoresForTests();
  try { await rm(storageRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); } catch (error) { if (!['EBUSY', 'EPERM'].includes(error?.code)) throw error; }
});

async function contextFor(browser, who) {
  const context = await browser.newContext({ viewport: { width: 1200, height: 800 } });
  await context.addCookies([{ name: 'fm_platform_session', value: who.session, url: ORIGIN }, { name: 'fm_platform_session_csrf', value: who.csrf, url: ORIGIN }]);
  await context.route('**/*', async (route) => {
    const request = route.request(), url = new URL(request.url());
    if (url.origin !== ORIGIN) return route.abort();
    if (url.pathname === '/app/acme') return route.fulfill({ status: 200, contentType: 'text/html', body: PAGE });
    if (url.pathname.startsWith('/v1/')) {
      const response = await app.inject({ method: request.method(), url: url.pathname + url.search, payload: request.postDataBuffer() || undefined, headers: { ...request.headers(), host: 'replay-insights.test' } });
      return route.fulfill({ status: response.statusCode, headers: { 'content-type': String(response.headers['content-type'] || 'application/json') }, body: response.body });
    }
    try { return route.fulfill({ status: 200, contentType: TYPES[path.extname(url.pathname)] || 'application/octet-stream', body: await readFile(path.join(PUBLIC, decodeURIComponent(url.pathname))) }); }
    catch { return route.fulfill({ status: 404, body: '' }); }
  });
  return context;
}

async function record(browser, owner, script) {
  const context = await contextFor(browser, owner);
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (error) => errors.push(String(error)));
  await page.goto(ORIGIN + '/app/acme?tab=projects');
  await page.waitForFunction(() => window.FMReplay && window.FMReplay.status().recording === true);
  await page.waitForTimeout(2800); // past the page's load window
  await script(page);
  await page.waitForTimeout(1800);
  await page.evaluate(() => window.FMReplay.flush());
  await page.waitForFunction(() => window.FMReplay.status().chunks_queued === 0);
  const id = await page.evaluate(() => window.FMReplay.sessionId);
  assert.deepEqual(errors, []);
  await context.close();
  return id;
}

test('recorded sessions are indexed and answer behaviour questions through the tool endpoint', { timeout: 240000 }, async () => {
  const owner = await register('owner');
  const admin = await register('admin', true);
  const call = async (who, tool, input) => {
    const response = await app.inject({ method: 'POST', url: '/v1/platform/session-replay/insights/call', payload: { tool, input },
      headers: { cookie: `fm_platform_session=${who.session}`, 'x-platform-csrf': decodeURIComponent(who.csrf) } });
    return response;
  };
  const ask = async (tool, input = {}) => {
    const response = await call(admin, tool, input);
    assert.equal(response.statusCode, 200, response.body);
    const body = response.json();
    assert.equal(body.ok, true, JSON.stringify(body));
    return body.result;
  };
  const toggled = await app.inject({ method: 'PUT', url: `/v1/platform/session-replay/admin/organizations/${owner.orgId}`, payload: { enabled: true },
    headers: { cookie: `fm_platform_session=${admin.session}`, 'x-platform-csrf': decodeURIComponent(admin.csrf) } });
  assert.equal(toggled.statusCode, 200, toggled.body);

  const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH || 'C:/Program Files/Google/Chrome/Application/chrome.exe', headless: true });
  let first, second;
  try {
    first = await record(browser, owner, async (page) => {
      await page.click('#new');
      await page.waitForTimeout(300);
      await page.click('#save');
      await page.waitForTimeout(300);
      await page.click('#name');
      await page.keyboard.type('Jones gutters', { delay: 30 });
      await page.click('#save');
      await page.waitForTimeout(1600);
      await page.click('#tab-settings');
      await page.waitForTimeout(1600);
      await page.click('#tab-projects');
      await page.waitForTimeout(1600);
      for (let i = 0; i < 4; i++) await page.click('#broken', { delay: 20 });
      await page.waitForTimeout(1600);
      await page.keyboard.press('Escape');
    });
    second = await record(browser, owner, async (page) => {
      await page.click('#new');
      await page.waitForTimeout(300);
      await page.click('#name');
      await page.keyboard.type('Lee windows', { delay: 30 });
      await page.click('#save');
      await page.waitForTimeout(1600);
      await page.click('#broken');
      await page.waitForTimeout(1600);
    });
  } finally {
    await browser.close();
  }

  // Customers cannot search replays.
  const denied = await app.inject({ method: 'GET', url: '/v1/platform/session-replay/insights/tools', headers: { cookie: `fm_platform_session=${owner.session}` } });
  assert.equal(denied.statusCode, 403);
  const manifest = (await app.inject({ method: 'GET', url: '/v1/platform/session-replay/insights/tools', headers: { cookie: `fm_platform_session=${admin.session}` } })).json();
  assert.ok(manifest.guide.length > 200);
  assert.ok(manifest.tools.length >= 12 && manifest.tools.every((tool) => tool.name && tool.description && tool.input_schema));

  const indexed = await ask('replay_index_now', {});
  assert.equal(indexed.indexed, 2, JSON.stringify(indexed));
  const again = await ask('replay_index_now', { session_id: first });
  assert.ok(again.steps > 10);

  const overview = await ask('replay_overview', { org_id: owner.orgId });
  assert.equal(overview.sessions, 2);
  assert.equal(overview.index_coverage.indexed_sessions, 2);
  assert.ok(overview.friction.rage_clicks >= 1 && overview.friction.on_screen_errors >= 1, JSON.stringify(overview));

  const screens = (await ask('replay_screens', { org_id: owner.orgId })).screens;
  const projects = screens.find((s) => s.url_pattern.includes('tab=projects'));
  const settings = screens.find((s) => s.url_pattern.includes('tab=settings'));
  assert.ok(projects && settings, JSON.stringify(screens));
  assert.equal(projects.sessions, 2);

  const targets = (await ask('replay_targets', { org_id: owner.orgId, screen_id: projects.screen_id })).targets;
  const byLabel = (label) => targets.find((t) => t.label === label);
  assert.ok(byLabel('New project') && byLabel('Save') && byLabel('Broken'), JSON.stringify(targets.map((t) => t.label)));
  assert.equal(byLabel('New project').sessions, 2);
  assert.ok(byLabel('New project').then.some((n) => n.what.includes('Project name') || n.what.includes('Save')), JSON.stringify(byLabel('New project').then));

  const newProject = await ask('replay_target', { target_id: byLabel('New project').target_id });
  assert.ok(newProject.outcomes.dialog >= 2, JSON.stringify(newProject.outcomes));

  const following = await ask('replay_next', { target_id: byLabel('New project').target_id });
  assert.ok(following.next_clicks.length >= 1);

  const flows = await ask('replay_flows', { screen_id: projects.screen_id, length: 3 });
  assert.ok(flows.paths.some((p) => p.steps[0].what === '(entered the screen)' && p.steps[1].what.includes('New project')), JSON.stringify(flows.paths.slice(0, 5)));

  const friction = await ask('replay_friction', { org_id: owner.orgId });
  assert.equal(friction.rage_clicks[0].what, 'button "Broken"');
  assert.ok(friction.dead_clicks.some((d) => d.what === 'button "Broken"'), JSON.stringify(friction.dead_clicks));
  assert.ok(friction.on_screen_errors.some((e) => e.message === 'Project name is required'), JSON.stringify(friction.on_screen_errors));
  assert.ok(friction.clicks_followed_by_errors.some((d) => d.what === 'button "Save"'), JSON.stringify(friction.clicks_followed_by_errors));

  const both = await ask('replay_find_sessions', { org_id: owner.orgId, target_ids: [byLabel('New project').target_id, byLabel('Save').target_id], ordered: true });
  assert.equal(both.matched, 2);
  const raging = await ask('replay_find_sessions', { org_id: owner.orgId, has: ['rage'] });
  assert.deepEqual(raging.sessions.map((s) => s.session_id), [first]);
  const texted = await ask('replay_search_text', { org_id: owner.orgId, query: 'required' });
  assert.deepEqual(texted.sessions.map((s) => s.session_id), [first]);
  assert.match(texted.sessions[0].snippet, /required/i);
  const typed = await ask('replay_search_text', { org_id: owner.orgId, query: 'Lee windows' });
  assert.deepEqual(typed.sessions.map((s) => s.session_id), [second]);

  const timeline = await ask('replay_session_timeline', { session_id: first });
  assert.match(timeline.timeline, /clicked button "New project" .*→ dialog/);
  assert.match(timeline.timeline, /ERROR MESSAGE shown: "Project name is required"/);
  assert.match(timeline.timeline, /edited field "Project name": \d+ changes/);
  assert.match(timeline.timeline, /RAGE CLICKED "Broken" 4 times/);
  assert.match(timeline.timeline, /opened screen ".*settings/);
  assert.match(timeline.timeline, /pressed Escape/);
  assert.doesNotMatch(timeline.timeline, /Jones gutters/, 'field values never appear in timelines');

  const lines = timeline.timeline.split('\n');
  const saveLine = lines.find((line) => /clicked button "Save" .*→ error/.test(line));
  assert.ok(saveLine, timeline.timeline);
  const [minutes, seconds] = saveLine.trim().split(/\s+/)[0].split(':').map(Number);
  const onScreen = await ask('replay_screen_at', { session_id: first, seconds: minutes * 60 + seconds + 0.5 });
  assert.match(onScreen.outline, /\[button #save\] Save/);
  assert.match(onScreen.outline, /Project name is required/);
  assert.match(onScreen.url, /tab=projects/);

  const link = await ask('replay_link', { session_id: first });
  assert.match(link.url, /viewer\.html#session=/);
  const bad = (await call(admin, 'replay_flows', {})).json();
  assert.equal(bad.ok, false);
  assert.match(bad.result.error, /screen_id/);
});
