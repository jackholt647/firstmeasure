import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test, { after, before } from 'node:test';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';

// The flow editor (docs/architecture/flows.md, "The editor") in a real browser against the real server: CRM settings ›
// Flows lists the organization's flows, the editor draws a whole flow as a map, edits it in place, plays it in the
// preview, saves it with expected_version, shows the server's validation issues next to the field they name, makes a
// new flow and archives one. Read-only is the same map with nothing to edit. FLOW_SCREENSHOTS=<dir> keeps screenshots.
// node --experimental-sqlite --import tsx --test tests/flow-editor-browser.test.mjs

const PUBLIC = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const ORIGIN = 'http://flows.test';
const SHOTS = process.env.FLOW_SCREENSHOTS || '';
let app = null, storageRoot = '', session = null, orgId = '';

const TYPES = { '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png', '.html': 'text/html' };
const cookieValue = (setCookie, name) => (Array.isArray(setCookie) ? setCookie : setCookie ? [setCookie] : []).find((v) => v.startsWith(`${name}=`))?.split(';')[0].split('=').slice(1).join('=') || '';

before(async () => {
  storageRoot = await mkdtemp(path.join(os.tmpdir(), 'firstmate-flow-editor-browser-'));
  Object.assign(process.env, {
    NODE_ENV: 'test', PLATFORM_HEARTBEAT_DISABLED: '1', WORK_SCHEDULER_DISABLED: '1', FIRSTMEASURE_JOB_WORKERS: '0',
    PLATFORM_STORAGE_ROOT: path.join(storageRoot, 'platform'), CRM_STORAGE_ROOT: path.join(storageRoot, 'crm'),
    FIRSTMEASURE_STORAGE_ROOT: path.join(storageRoot, 'firstmeasure'), FIRSTMEASURE_INDEX_DB_PATH: path.join(storageRoot, 'firstmeasure', 'projects_index.sqlite'),
    PRICEBOOK_STORAGE_ROOT: path.join(storageRoot, 'pricebook'), EMAIL_OUTBOUND_DISABLED: '1', V1_LOG_LEVEL: 'error', CORS_ALLOWED_ORIGINS: ORIGIN
  });
  const { buildApp } = await import('../src/app.js');
  app = await buildApp();
  await app.ready();
  const { nextTestPhone, enableExpandedPlatformFixture } = await import('./helpers/platform-fixture.js');
  const suffix = Math.random().toString(36).slice(2, 8);
  const registered = await app.inject({ method: 'POST', url: '/v1/platform/auth/register', payload: {
    phone: nextTestPhone(), email: `owner-${suffix}@example.test`, password: 'correct horse battery staple', name: 'Dana Owner', company: 'Summit Roofing', organization_id: `org_flow_ui_${suffix}`
  } });
  assert.equal(registered.statusCode < 400, true, registered.body);
  orgId = JSON.parse(registered.body).organization.id;
  session = { session: cookieValue(registered.headers['set-cookie'], 'fm_platform_session'), csrf: cookieValue(registered.headers['set-cookie'], 'fm_platform_session_csrf') };
  await enableExpandedPlatformFixture(orgId, {});
  await inject('POST', `/v1/crm/organizations/${orgId}/presets/apply`, { industry: 'roofing', employees: 30, capabilities: true });
  const { newLeadFlow, SUGGESTED_QUESTIONS } = await import('../flows/new-lead.js');
  await inject('POST', `/v1/flows/organizations/${orgId}/flows`, { id: 'new_lead_call', definition: newLeadFlow({ contact: 'call', no_answer: ['text', 'retry'], questions: SUGGESTED_QUESTIONS.slice(0, 3) }) });
});
after(async () => {
  if (app) await app.close();
  await (await import('./helpers/platform-fixture.js')).closePlatformFixtureStores();
  await (await import('../platform/sql_store.js')).closeSqlStoresForTests();
  try { await rm(storageRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); } catch (error) { if (!['EBUSY', 'EPERM'].includes(error?.code)) throw error; }
});

async function inject(method, url, payload) {
  const response = await app.inject({ method, url, payload, headers: { cookie: `fm_platform_session=${session.session}; fm_platform_session_csrf=${session.csrf}`, 'x-platform-csrf': decodeURIComponent(session.csrf) } });
  assert.ok(response.statusCode < 400, `${method} ${url}: ${response.statusCode} ${response.body}`);
  return JSON.parse(response.body || 'null');
}

const HARNESS = `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<link rel="stylesheet" href="https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.0.0/css/all.min.css">
<style>:root{--primary:#2563eb;--primary-rgb:37,99,235}html,body{margin:0;height:100%;font-family:Inter,-apple-system,"Segoe UI",Roboto,Arial,sans-serif;background:#fff}#main{height:100vh}</style>
<script>window.__APP={orgId:'__ORG__'};window.FirstMateEmbeddableApps={registerApp(def){window.__crm=def;}};window.PlatformAssistant={mountSurface(c){return {ready:Promise.resolve(),refresh(){},destroy(){},endVoice(){}};}};</script>
<script src="/libraries/platform-language/platform-language.js"></script>
<script src="/libraries/platform-terminology/platform-terminology.js"></script>
<script src="/libraries/platform-api/platform-api.js"></script>
<script src="/libraries/flows/flow-player.js"></script>
<script src="/libraries/flows/flow-editor.js"></script>
<script src="/libraries/apps/crm/app.js?v=test"></script>
</head><body><div id="main"><div data-portal-loading>Loading CRM...</div></div><div id="side" style="position:fixed;left:0;top:0;width:520px;height:700px;display:none;background:#fff"></div>
<script>window.__mounted=window.__crm.mount({roots:{main:document.getElementById('main')},orgId:'__ORG__'});</script></body></html>`;

async function openPage(browser, viewport) {
  const context = await browser.newContext({ viewport, deviceScaleFactor: 1 });
  await context.addCookies([{ name: 'fm_platform_session', value: session.session, url: ORIGIN }, { name: 'fm_platform_session_csrf', value: session.csrf, url: ORIGIN }]);
  const requests = [];
  await context.route('**/*', async (route) => {
    const request = route.request(), url = new URL(request.url());
    if (url.origin !== ORIGIN) return url.hostname.endsWith('cdnjs.cloudflare.com') ? route.continue().catch(() => route.abort()) : route.abort();
    if (url.pathname === '/harness.html') return route.fulfill({ status: 200, contentType: 'text/html', body: HARNESS.replaceAll('__ORG__', orgId) });
    if (url.pathname.startsWith('/v1/')) {
      const response = await app.inject({ method: request.method(), url: url.pathname + url.search, payload: request.postData() || undefined, headers: { ...request.headers(), host: 'flows.test' } });
      if (url.pathname.includes('/v1/flows/')) requests.push({ method: request.method(), path: url.pathname, body: request.postData() ? JSON.parse(request.postData()) : null, status: response.statusCode, ...(response.statusCode >= 400 ? { error: response.body.slice(0, 300) } : {}) });
      return route.fulfill({ status: response.statusCode, headers: { 'content-type': String(response.headers['content-type'] || 'application/json') }, body: response.body });
    }
    try { const body = await readFile(path.join(PUBLIC, decodeURIComponent(url.pathname))); return route.fulfill({ status: 200, contentType: TYPES[path.extname(url.pathname)] || 'application/octet-stream', body }); }
    catch { return route.fulfill({ status: 404, body: '' }); }
  });
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('dialog', (dialog) => dialog.accept());
  await page.goto(`${ORIGIN}/harness.html`);
  await page.waitForSelector('.crm-rail', { state: 'attached', timeout: 20000 });
  return { context, page, errors, requests };
}
async function shot(page, name) {
  if (!SHOTS) return;
  await mkdir(SHOTS, { recursive: true });
  await page.waitForTimeout(250);
  await page.screenshot({ path: path.join(SHOTS, `${name}.png`) });
}

test('CRM settings › Flows: the map, in-place edits, preview, save, server issues, new flow, archive, read-only', async () => {
  const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH || 'C:/Program Files/Google/Chrome/Application/chrome.exe', headless: true });
  let page = null, errors = [], requests = [];
  try {
    ({ page, errors, requests } = await openPage(browser, { width: 1440, height: 900 }));

    // CRM settings has a Flows subtab listing the organization's flows.
    await page.locator('[data-open-panel="settings"]').first().click();
    await page.waitForSelector('.crm-subtabs [data-settings-tab="flows"]');
    await page.locator('[data-settings-tab="flows"]').click();
    await page.waitForSelector('.crm-flow-row[data-flow="new_lead_call"]');
    assert.match(await page.locator('.crm-flow-row[data-flow="new_lead_call"]').innerText(), /New lead call[\s\S]*Call script/);
    await shot(page, '01-flows-list');

    // The editor draws the whole flow: every step, the outcomes, and a line from each way out to where it leads.
    await page.locator('[data-flow-open="new_lead_call"]').click();
    await page.waitForSelector('.fm-flow-editor-modal .fme-map');
    const flow = (await inject('GET', `/v1/flows/organizations/${orgId}/flows/new_lead_call?latest=1`)).flow;
    assert.equal(await page.locator('.fme-card[data-step]').count(), flow.definition.steps.length, 'one card per step');
    assert.equal(await page.locator('.fme-outcome-card').count(), flow.definition.outcomes.length, 'one card per outcome');
    await page.waitForFunction(() => document.querySelectorAll('.fme-wires path').length >= 5);
    const dial = page.locator('.fme-card[data-step="dial"]');
    assert.match(await dial.innerText(), /They answered[\s\S]*No answer[\s\S]*Wrong number[\s\S]*Not a lead/, 'the first step shows its choice options and where each goes');
    assert.ok(await page.locator('.fme-wires path[data-wire="dial>outcome:not_a_lead"]').count(), 'a wire from Wrong number to the Not a lead outcome');
    assert.equal(await page.locator('.fme-seg [data-kind-set="call"]').getAttribute('aria-pressed'), 'true', 'it is a call script');
    await shot(page, '02-editor-map');

    // In place: open "They answered", edit the greeting with a template, add a question, send an option to an outcome.
    await page.locator('.fme-card[data-step="greet"]').click();
    const greet = page.locator('.fme-card[data-step="greet"][aria-current="true"]');
    await greet.waitFor();
    const say = greet.locator('[data-block-kind="say"] textarea').first();
    await say.fill('Hi, this is Dana with Summit Roofing. ');
    await greet.locator('[data-block-kind="say"] .fme-chip', { hasText: 'contact.first_name' }).click();
    assert.match(await say.inputValue(), /Summit Roofing\. \{\{contact\.first_name\}\}$/, 'a template chip inserts at the cursor');
    await greet.locator('[data-add-block="ask"]').click();
    const ask = greet.locator('[data-block-kind="ask"]').last();
    await ask.locator('input[data-path$=".label"]').fill('How old is the roof?');
    await ask.locator('select[data-path$=".input"]').selectOption('number');
    await ask.locator('select[data-saves-to]').selectOption('custom');
    await ask.locator('input[data-path$=".saves_to"]').fill('project.cf.roof_age');
    await page.locator('.fme-card[data-step="next"]').click();
    const next = page.locator('.fme-card[data-step="next"][aria-current="true"]');
    await next.locator('[data-block-kind="choice"] select[data-option-target$=".options.1"]').selectOption('outcome:call_back');
    assert.match(await next.locator('.fme-exits').innerText(), /Call them back later[\s\S]*Call back later/, 'the exit now ends at the outcome');
    assert.equal(await page.locator('.fme-status').innerText(), 'Unsaved changes');
    await shot(page, '03-editing');

    // Play runs the unsaved definition in the flow player's preview.
    await page.locator('[data-play]').click();
    await page.waitForSelector('.fme-play .fmf-preview-tag');
    assert.match(await page.locator('.fme-play .fmf').innerText(), /Did they answer\?/);
    await page.locator('.fme-play .fmf-option', { hasText: 'They answered' }).click();
    await page.waitForSelector('.fme-play .fmf[data-step="greet"]');
    assert.match(await page.locator('.fme-play .fmf-say').first().innerText(), /Summit Roofing/, 'the preview plays the edited greeting');
    assert.ok(await page.locator('.fme-play [data-key^="answer_"]').count(), 'the new question is in the preview');
    await shot(page, '04-preview');
    await page.locator('[data-play-close]').click();

    // A server issue is drawn next to the field it names: the new question reuses an answer key.
    await page.locator('.fme-card[data-step="greet"]').click();
    await page.locator('.fme-card[data-step="greet"] [data-block-kind="ask"]').last().locator('input[data-path$=".key"]').fill('need');
    await page.locator('[data-save]').click();
    const issue = page.locator('.fme-card[data-step="greet"] [data-block-kind="ask"] .fme-issue');
    await issue.first().waitFor();
    assert.match(await issue.first().innerText(), /asked twice/);
    assert.match(await page.locator('.fme-banner').innerText(), /Not saved/);
    await shot(page, '05-server-issue');

    // Fixed and saved: PUT with expected_version, a new version with every edit.
    await page.locator('.fme-card[data-step="greet"] [data-block-kind="ask"]').last().locator('input[data-path$=".key"]').fill('roof_age');
    assert.equal(await issue.count(), 0, 'editing the field clears its issue');
    await page.locator('[data-save]').click();
    await page.waitForFunction(() => /version 2/.test(document.querySelector('.fme-status')?.textContent || ''));
    const put = requests.filter((r) => r.method === 'PUT' && r.path.endsWith('/flows/new_lead_call'));
    assert.deepEqual(put.map((r) => [r.status, r.body.expected_version]), [[400, 1], [200, 1]]);
    const saved = (await inject('GET', `/v1/flows/organizations/${orgId}/flows/new_lead_call?latest=1`)).flow;
    const greetStep = saved.definition.steps.find((s) => s.id === 'greet');
    assert.equal(greetStep.blocks[0].text, 'Hi, this is Dana with Summit Roofing. {{contact.first_name}}');
    assert.deepEqual(greetStep.blocks.at(-1), { id: 'ask_1', kind: 'ask', label: 'How old is the roof?', key: 'roof_age', input: 'number', options: [], required: false, placeholder: '', saves_to: 'project.cf.roof_age' });
    assert.equal(saved.definition.steps.find((s) => s.id === 'next').blocks[1].options[1].outcome, 'call_back');

    // Someone else saves meanwhile: the next save is refused as a conflict and offers Reload.
    await inject('PUT', `/v1/flows/organizations/${orgId}/flows/new_lead_call`, { definition: { ...saved.definition, description: 'Changed elsewhere' }, expected_version: 2 });
    await page.locator('.fme-name').fill('New lead call (mine)');
    await page.locator('[data-save]').click();
    await page.waitForSelector('.fme-banner [data-reload]');
    await page.locator('.fme-banner [data-reload]').click();
    await page.waitForFunction(() => /version 3/.test(document.querySelector('.fme-status')?.textContent || ''));
    assert.equal(await page.locator('.fme-name').inputValue(), 'New lead call');
    await page.locator('.fme-top [data-close]').click();
    await page.waitForSelector('.fm-flow-editor-modal', { state: 'detached' });

    // New flow: a blank workflow, named, given a second step and a New menu entry, saved with POST.
    await page.locator('[data-flow-new]').click();
    await page.locator('[data-flow-blank="workflow"]').click();
    await page.waitForSelector('.fm-flow-editor-modal .fme-card[data-step="step_1"]');
    assert.equal(await page.locator('.fme-status').innerText(), 'Not saved yet');
    await page.locator('.fme-name').fill('T-shirt order');
    await page.locator('.fme-card[data-step="step_1"] [data-block-kind="say"] textarea').fill('Take the order.');
    await page.locator('.fme-card[data-step="step_1"] select[data-target="steps.0.next"]').selectOption('new-step');
    assert.equal(await page.locator('.fme-card[data-step]').count(), 2, 'picking "+ A new step" makes one and links it');
    await page.locator('[data-settings]').click();
    await page.locator('input[data-path="entry.new_menu.enabled"]').check();
    await page.locator('input[data-path="entry.new_menu.label"]').fill('T-shirt');
    await shot(page, '06-new-flow');
    await page.locator('[data-save]').click();
    await page.waitForFunction(() => /version 1/.test(document.querySelector('.fme-status')?.textContent || ''));
    const created = requests.find((r) => r.method === 'POST' && /\/flows$/.test(r.path));
    assert.equal(created.status, 201);
    await page.locator('.fme-top [data-close]').click();
    await page.waitForSelector('.crm-flow-row:has-text("T-shirt order")');
    const menu = await inject('GET', `/v1/flows/organizations/${orgId}/flows/new-menu`);
    assert.deepEqual(menu.flows.map((entry) => entry.label), ['T-shirt'], 'the new flow is a New menu item');

    // Archive takes it out of the list and the New menu; Show archived brings it back with Restore.
    const row = page.locator('.crm-flow-row', { hasText: 'T-shirt order' });
    await row.locator('[data-flow-archive]').click();
    await page.waitForSelector('.crm-flow-row:has-text("T-shirt order")', { state: 'detached' });
    assert.deepEqual((await inject('GET', `/v1/flows/organizations/${orgId}/flows/new-menu`)).flows, []);
    await page.locator('[data-flows-archived]').check();
    await page.waitForSelector('.crm-flow-row.archived:has-text("T-shirt order") [data-archived="1"]');

    // Read-only (how the automations hub opens a flow): the same map, nothing to edit.
    await page.evaluate(() => { const side = document.getElementById('side'); side.style.display = 'block'; window.__ro = window.FirstMateFlowEditor.mount(side, { flowId: 'new_lead_call', readOnly: true }); });
    await page.waitForSelector('#side .fme[data-readonly] .fme-card[data-step="dial"]');
    assert.equal(await page.locator('#side [data-save]').count(), 0, 'no save button');
    await page.locator('#side .fme-card[data-step="greet"]').click();
    await page.waitForSelector('#side .fme-card[data-step="greet"][aria-current="true"]');
    assert.equal(await page.locator('#side .fme-card[data-step="greet"] textarea:not([disabled]), #side .fme-card[data-step="greet"] input:not([disabled])').count(), 0, 'every field is read-only');
    assert.equal(await page.locator('#side [data-add-block]').first().isVisible(), false, 'no add buttons');
    // The side panel is narrow, so the map stacks its columns and leaves out the lines.
    assert.equal(await page.locator('#side .fme-wires').evaluate((node) => getComputedStyle(node).display), 'none');
    await shot(page, '07-read-only-narrow');

    assert.deepEqual(errors, [], 'no page errors');
  } catch (error) {
    // What the page showed when it failed, so a failure says more than a timeout.
    if (page) console.log('PAGE', errors, requests.slice(-4), (await page.locator('body').innerText().catch(() => '')).slice(0, 1500));
    throw error;
  } finally {
    await browser.close();
  }
});
