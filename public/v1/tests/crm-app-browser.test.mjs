import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test, { after, before } from 'node:test';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';

// The CRM app (docs/architecture/crm.md, "The CRM app") in a real browser against the real
// server: the page loads platform-api.js and the app, and every /v1 request is answered by
// the in-process server. Run with CRM_SCREENSHOTS=<dir> to keep a screenshot of each screen.
// node --experimental-sqlite --import tsx --test tests/crm-app-browser.test.mjs

const PUBLIC = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const ORIGIN = 'http://crm.test';
const SHOTS = process.env.CRM_SCREENSHOTS || '';
let app = null, storageRoot = '', session = null, orgId = '', userId = '';

const TYPES = { '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png', '.html': 'text/html' };
const cookieValue = (setCookie, name) => (Array.isArray(setCookie) ? setCookie : setCookie ? [setCookie] : []).find((v) => v.startsWith(`${name}=`))?.split(';')[0].split('=').slice(1).join('=') || '';

before(async () => {
  storageRoot = await mkdtemp(path.join(os.tmpdir(), 'firstmate-crm-app-browser-'));
  Object.assign(process.env, {
    NODE_ENV: 'test', PLATFORM_HEARTBEAT_DISABLED: '1', WORK_SCHEDULER_DISABLED: '1', FIRSTMEASURE_JOB_WORKERS: '0',
    PLATFORM_STORAGE_ROOT: path.join(storageRoot, 'platform'), CRM_STORAGE_ROOT: path.join(storageRoot, 'crm'),
    FIRSTMEASURE_STORAGE_ROOT: path.join(storageRoot, 'firstmeasure'), FIRSTMEASURE_INDEX_DB_PATH: path.join(storageRoot, 'firstmeasure', 'projects_index.sqlite'),
    PRICEBOOK_STORAGE_ROOT: path.join(storageRoot, 'pricebook'), EMAIL_OUTBOUND_DISABLED: '1', V1_LOG_LEVEL: 'error'
  });
  const { buildApp } = await import('../src/app.js');
  app = await buildApp();
  await app.ready();
  const { nextTestPhone, enableExpandedPlatformFixture } = await import('./helpers/platform-fixture.js');
  const suffix = Math.random().toString(36).slice(2, 8);
  const registered = await app.inject({ method: 'POST', url: '/v1/platform/auth/register', payload: {
    phone: nextTestPhone(), email: `owner-${suffix}@example.test`, password: 'correct horse battery staple', name: 'Dana Owner', company: 'Summit Roofing', organization_id: `org_crm_ui_${suffix}`
  } });
  assert.equal(registered.statusCode < 400, true, registered.body);
  orgId = JSON.parse(registered.body).organization.id;
  userId = JSON.parse(registered.body).user?.id || '';
  session = { session: cookieValue(registered.headers['set-cookie'], 'fm_platform_session'), csrf: cookieValue(registered.headers['set-cookie'], 'fm_platform_session_csrf') };
  await enableExpandedPlatformFixture(orgId);
  await seed();
});
after(async () => {
  if (app) await app.close();
  await (await import('./helpers/platform-fixture.js')).closePlatformFixtureStores();
  await (await import('../platform/sql_store.js')).closeSqlStoresForTests();
  try { await rm(storageRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); } catch (error) { if (!['EBUSY', 'EPERM'].includes(error?.code)) throw error; }
});

const inject = async (method, url, payload) => {
  const response = await app.inject({ method, url, payload, headers: { cookie: `fm_platform_session=${session.session}; fm_platform_session_csrf=${session.csrf}`, 'x-platform-csrf': decodeURIComponent(session.csrf) } });
  assert.ok(response.statusCode < 400, `${method} ${url}: ${response.statusCode} ${response.body}`);
  return JSON.parse(response.body || 'null');
};

/** A roofing company a few weeks in: leads from every channel, some booked, some sold, some lost. */
async function seed() {
  const base = `/v1/crm/organizations/${orgId}`;
  await inject('POST', `${base}/presets/apply`, { industry: 'roofing', employees: 30, capabilities: true });
  const { receiveLead } = await import('../leads/receive.js');
  const { drainWorkEvents } = await import('../work/engine.js');
  const { updateProjectData } = await import('../platform/project_document_mutation.js');
  const { setOpportunityOutcome } = await import('../work/opportunities.js');
  const day = 86_400_000, now = Date.now();
  const leads = [
    ['Maria Gonzalez', '412 Birch Ln', { kind: 'web_form', page_url: 'https://summit.example.test/storm?utm_source=google&utm_campaign=hail&gclid=g1' }, 'insurance_roof_sale'],
    ['James Whitfield', '88 Ridge Rd', { kind: 'canvassing', provider: 'Canvassing' }, 'insurance_roof_sale'],
    ['Priya Shah', '7 Lakeview Ct', { kind: 'web_form', page_url: 'https://summit.example.test/?utm_source=facebook' }, 'sales_pipeline'],
    ['Tom Becker', '1550 Old Mill Rd', { kind: 'missed_call', provider: 'Phone' }, ''],
    ['Alicia Moreno', '300 Cedar St', { kind: 'referral' }, 'sales_pipeline'],
    ['Greg Olsen', '19 Fox Hollow', { kind: 'web_form' }, ''],
    ['Hannah Lee', '402 Summit Ave', { kind: 'canvassing', provider: 'Canvassing' }, 'insurance_roof_sale'],
    ['Robert King', '75 Harbor Dr', { kind: 'web_form', page_url: 'https://summit.example.test/?utm_source=google' }, 'sales_pipeline'],
    ['Sofia Rossi', '12 Vine St', { kind: 'live_chat', provider: 'Live chat' }, ''],
    ['Derek Chu', '980 Elm Park', { kind: 'missed_call', provider: 'Phone' }, 'sales_pipeline'],
    ['Nina Patel', '61 Meadow Way', { kind: 'web_form', page_url: 'https://summit.example.test/?utm_source=google&gclid=g2' }, 'insurance_roof_sale'],
    ['Carlos Ruiz', '233 Pine Ridge', { kind: 'referral' }, 'sales_pipeline']
  ];
  for (const [index, [name, address, source, scope]] of leads.entries()) {
    const projectId = `crm_ui_${index + 1}`;
    const [first, ...rest] = name.split(' ');
    await receiveLead(orgId, { project_id: projectId, source, address, title: address, contacts: [{ name, first_name: first, last_name: rest.join(' '), phone: `555-01${String(index).padStart(2, '0')}-${1000 + index * 37}`, email: `${first.toLowerCase()}@example.test` }] });
    await drainWorkEvents();
    if (scope && scope !== 'sales_pipeline') await inject('POST', `/v1/scopes/organizations/${orgId}/projects/${projectId}/scopes`, { template_id: scope }).catch(() => null);
    const events = index % 3 === 0 ? [] : [{ id: `ev_${index}`, title: index % 2 ? 'Roof inspection' : 'Sales appointment', start_at: new Date(now + ((index % 5) - 1) * day + 15 * 3600_000).toISOString(), end_at: new Date(now + ((index % 5) - 1) * day + 16.5 * 3600_000).toISOString(), status: 'scheduled', event_type_default_id: 'sales_appointment', appointment_configuration: { id: 'sales' }, confirmation: index % 4 ? 'pending' : 'confirmed', resource_refs: [] }];
    // Booking and holding the appointment are work events, as the scheduling writers record them.
    const { emitWorkEvent } = await import('../work/engine.js');
    for (const event of events) {
      const payload = { event_id: event.id, event_type_default_id: event.event_type_default_id, start_at: event.start_at, event: { ...event, assigned_user_ids: [userId] } };
      await emitWorkEvent({ organization_id: orgId, branch_id: 'default', project_id: projectId, type: 'project.event_scheduled', idempotency_key: `seed:${projectId}:${event.id}:scheduled`, payload, context: { actor_user_id: userId } });
      if (Date.parse(event.end_at) < now) await emitWorkEvent({ organization_id: orgId, branch_id: 'default', project_id: projectId, type: 'project.event.completed', idempotency_key: `seed:${projectId}:${event.id}:completed`, payload, context: {} });
    }
    await updateProjectData(orgId, projectId, (data) => ({
      ...data, events,
      ...(index % 4 === 1 ? { proposals: [{ proposal_id: `prop_${index}`, status: index === 1 ? 'signed' : 'sent', total_cents: 1_480_000 + index * 92_000 }] } : {}),
      ...(scope === 'insurance_roof_sale' ? { custom_field_values: { ...(data.custom_field_values || {}), claim: { status: index % 2 ? 'filed' : 'adjuster_scheduled', carrier: 'State Farm', number: `SF-${2210 + index}` } } } : {})
    }));
  }
  await drainWorkEvents();
  await setOpportunityOutcome(orgId, { project_id: 'crm_ui_2', outcome: 'won', reason: 'Signed' });
  await setOpportunityOutcome(orgId, { project_id: 'crm_ui_10', outcome: 'lost', reason: 'Price' });
  await setOpportunityOutcome(orgId, { project_id: 'crm_ui_12', outcome: 'lost', reason: 'Went with another contractor' });
  await drainWorkEvents();
  const meta = await inject('GET', `${base}/meta`);
  const again = meta.outcomes.find((o) => o.action === 'reschedule');
  for (const id of ['crm_ui_3', 'crm_ui_5', 'crm_ui_8']) await inject('POST', `${base}/results`, { project_id: id, disposition: 'voicemail', outcome_id: again.id, note: 'Left a voicemail about the inspection.' });
  const month = new Date().toISOString().slice(0, 8);
  await inject('PUT', `${base}/spend/new`, { source_id: 'google_ads', period_start: `${month}01`, period_end: `${month}28`, amount_cents: 420000 });
  await inject('PUT', `${base}/spend/new`, { source_id: 'meta_ads', period_start: `${month}01`, period_end: `${month}28`, amount_cents: 150000 });
}

const HARNESS = `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<link rel="stylesheet" href="https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.0.0/css/all.min.css">
<style>:root{--primary:#d93025;--primary-rgb:217,48,37}html,body{margin:0;height:100%;font-family:Inter,-apple-system,"Segoe UI",Roboto,Arial,sans-serif;background:#fff}#main{height:100vh}</style>
<script>window.__APP={orgId:'__ORG__'};window.FirstMateEmbeddableApps={registerApp(def){window.__crm=def;}};</script>
<script src="/libraries/platform-language/platform-language.js"></script>
<script src="/libraries/platform-terminology/platform-terminology.js"></script>
<script src="/libraries/platform-api/platform-api.js"></script>
<script src="/libraries/apps/crm/app.js?v=test"></script>
</head><body><div id="main"></div><script>window.__mounted=window.__crm.mount({roots:{main:document.getElementById('main')},orgId:'__ORG__'});</script></body></html>`;

async function openPage(browser, viewport) {
  const context = await browser.newContext({ viewport, deviceScaleFactor: 1 });
  await context.addCookies([{ name: 'fm_platform_session', value: session.session, url: ORIGIN }, { name: 'fm_platform_session_csrf', value: session.csrf, url: ORIGIN }]);
  await context.route('**/*', async (route) => {
    const request = route.request(), url = new URL(request.url());
    if (url.origin !== ORIGIN) return url.hostname.endsWith('cdnjs.cloudflare.com') ? route.continue().catch(() => route.abort()) : route.abort();
    if (url.pathname === '/harness.html') return route.fulfill({ status: 200, contentType: 'text/html', body: HARNESS.replaceAll('__ORG__', orgId) });
    if (url.pathname.startsWith('/v1/')) {
      const started = Date.now();
      const response = await app.inject({ method: request.method(), url: url.pathname + url.search, payload: request.postData() || undefined, headers: { ...request.headers(), host: 'crm.test' } });
      if (process.env.CRM_TIMING) console.log('TIMING', request.method(), url.pathname, response.statusCode, Date.now() - started, 'ms');
      if (response.statusCode >= 400) console.log('API', request.method(), url.pathname + url.search, response.statusCode, response.body.slice(0, 400));
      return route.fulfill({ status: response.statusCode, headers: { 'content-type': String(response.headers['content-type'] || 'application/json') }, body: response.body });
    }
    try { const body = await readFile(path.join(PUBLIC, decodeURIComponent(url.pathname))); return route.fulfill({ status: 200, contentType: TYPES[path.extname(url.pathname)] || 'application/octet-stream', body }); }
    catch { return route.fulfill({ status: 404, body: '' }); }
  });
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto(`${ORIGIN}/harness.html`);
  await page.waitForSelector('.crm-rail', { state: 'attached', timeout: 20000 });
  await page.waitForSelector('.crm-content table, .crm-content .crm-empty, .crm-content .crm-board', { timeout: 20000 });
  return { context, page, errors };
}
async function shot(page, name) {
  if (!SHOTS) return;
  await mkdir(SHOTS, { recursive: true });
  await page.waitForTimeout(250);
  await page.screenshot({ path: path.join(SHOTS, `${name}.png`) });
}
const settle = (page) => page.waitForFunction(() => !document.querySelector('.crm-content .crm-loading'), null, { timeout: 20000 });

test('the CRM tab: views, filters, the board, the drawer, a worklist, reports, sources and setup', async () => {
  const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH || 'C:/Program Files/Google/Chrome/Application/chrome.exe', headless: true });
  let current = null;
  try {
    const { page, errors } = await openPage(browser, { width: 1440, height: 900 });
    current = page;
    // The rail: the pinned base views and the roofing pack's views, with live counts.
    const rail = await page.locator('.crm-rail').innerText();
    for (const name of ['New leads', 'Pipeline', 'Follow-ups due', 'Upcoming appointments']) assert.ok(rail.includes(name), `rail shows ${name}`);
    await settle(page);
    await shot(page, '01-new-leads');

    // The pipeline board, grouped by stage.
    await page.locator('.crm-rail').getByText('Pipeline', { exact: true }).click();
    await page.waitForSelector('.crm-board');
    await settle(page);
    assert.ok(await page.locator('.crm-board .crm-col').count() >= 2, 'stage columns');
    await shot(page, '02-pipeline-board');

    // A list with every open lead; a filter changes the view and offers Save.
    await page.locator('.crm-rail').getByText('Gone quiet', { exact: true }).click().catch(() => null);
    await page.locator('.crm-rail').getByText('New leads', { exact: true }).click();
    await page.waitForSelector('.crm-content table');
    await page.keyboard.press('f');
    await page.waitForSelector('.crm-pop');
    await shot(page, '03-filter-picker');
    await page.keyboard.press('Escape');

    // The drawer beside the list.
    await page.locator('.crm-rail').getByText('Pipeline', { exact: true }).click();
    await page.waitForSelector('.crm-board');
    await page.locator('[data-layout="list"]').first().click();
    await page.waitForSelector('.crm-content table', { timeout: 10000 });
    await settle(page);
    await page.locator('.crm-content tbody tr[data-row]').first().click();
    await page.waitForSelector('.crm-drawer:not([hidden]) .crm-drawer-actions');
    const drawer = await page.locator('.crm-drawer').innerText();
    assert.ok(/Call|Text/.test(drawer) && /history/i.test(drawer), 'the drawer shows actions and history');
    await shot(page, '04-drawer');
    await page.keyboard.press('Escape');

    // Work this list: record a result and move on.
    await page.locator('[data-worklist]').first().click();
    await page.waitForSelector('.crm-worklist:not([hidden]) .crm-wl-body .crm-outcomes');
    await shot(page, '05-worklist');
    const before = await page.locator('.crm-wl-head .crm-dim').innerText();
    await page.locator('.crm-worklist [data-rd="no_answer"]').click();
    await page.locator('.crm-worklist .crm-outcome').first().click();
    await page.locator('.crm-worklist [data-rsave]').click();
    await page.waitForFunction((text) => document.querySelector('.crm-wl-head .crm-dim')?.textContent !== text, before, { timeout: 10000 });
    await page.locator('.crm-worklist [data-wl-close]').first().click();

    // Reports: the funnel by source with spend.
    await page.locator('[data-open-panel="reports"]').first().click();
    await page.waitForSelector('.crm-bars');
    const report = await page.locator('.crm-content').innerText();
    assert.ok(report.includes('Google Ads') && /spend/i.test(report), 'the funnel groups by source with spend');
    await shot(page, '06-reports');

    // Sources, Duplicates and Settings with the setup.
    await page.locator('[data-open-panel="sources"]').first().click();
    await page.waitForSelector('.crm-tree');
    await shot(page, '07-sources');
    await page.locator('[data-open-panel="duplicates"]').first().click();
    await page.waitForSelector('.crm-content .crm-empty, .crm-content .crm-dup');
    await shot(page, '08-duplicates');
    await page.locator('[data-open-panel="settings"]').first().click();
    await page.waitForSelector('[data-setup] .crm-packs');
    await shot(page, '09-settings');

    // Appointments as an agenda.
    await page.locator('.crm-rail').getByText('Upcoming appointments', { exact: true }).click();
    await page.waitForSelector('.crm-agenda, .crm-content .crm-empty');
    await settle(page);
    await shot(page, '10-appointments');
    assert.deepEqual(errors, [], 'no page errors');

    // A phone: the list becomes cards and the drawer a sheet.
    const phone = await openPage(browser, { width: 390, height: 844 });
    current = phone.page;
    await settle(phone.page);
    await shot(phone.page, '11-phone-list');
    await phone.page.locator('.crm-content [data-row]').first().click();
    await phone.page.waitForSelector('.crm-drawer:not([hidden]) .crm-drawer-actions');
    await shot(phone.page, '12-phone-drawer');
    assert.deepEqual(phone.errors, [], 'no page errors on a phone');
  } catch (error) {
    if (current) await shot(current, 'failure').catch(() => null);
    throw error;
  } finally { await browser.close(); }
});
