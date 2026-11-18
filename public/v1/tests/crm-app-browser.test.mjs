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
  await enableExpandedPlatformFixture(orgId, { 'apps.assistant': true });
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
<script src="/libraries/project-trays/project-trays.js"></script>
<script>
// The shared assistant stands in for itself (FM-551): the CRM's bar mounts it with these options.
window.PlatformAssistant={mountSurface(container,options){window.__agent=options;container.innerHTML='<div class="fma-drawer fma-embedded"><div class="fma-head"><span class="fma-head-title"></span><button type="button" data-fma="closeSurface">x</button></div><div class="fma-body"><div class="fma-stage"></div><div class="fma-composer"><textarea data-fma="input" placeholder="Ask"></textarea></div></div></div>';container.querySelector('[data-fma=closeSurface]').onclick=()=>options.onClose?.();return {ready:Promise.resolve(),refresh(){},destroy(){},endVoice(){}};}};
</script>
<script src="/libraries/apps/crm/app.js?v=test"></script>
</head><body><div id="main"><div data-portal-loading>Loading CRM...</div></div><script>window.__mounted=window.__crm.mount({roots:{main:document.getElementById('main')},orgId:'__ORG__'});</script></body></html>`;

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
    assert.equal(await page.locator('[data-portal-loading]').count(), 0, 'the CRM replaces the portal loading placeholder');
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
    assert.equal(await page.locator('.crm-intro [data-crm-tip]').isVisible(), true, 'the sources intro is an (i) (FM-493)');
    assert.equal(await page.locator('.crm-intro .crm-hint-tip').isVisible(), false, 'not a paragraph');
    await page.locator('[data-open-panel="duplicates"]').first().click();
    await page.waitForSelector('.crm-content .crm-empty, .crm-content .crm-dup');
    await shot(page, '08-duplicates');
    await page.locator('[data-open-panel="settings"]').first().click();
    await page.waitForSelector('[data-setup] .crm-packs');
    await page.waitForSelector('[data-routing] h3');
    await shot(page, '09-settings');
    // FM-494: each section's explanation is an (i) beside its heading, not a paragraph under it; hover shows it.
    assert.equal(await page.locator('.crm-page p.crm-dim', { hasText: /Adds the views|Who owns each new lead|Points for each rule|Do something when a contact/ }).count(), 0, 'no intro paragraphs under the settings headings');
    const routingTip = page.locator('[data-routing] h3 [data-crm-tip]').first();
    assert.equal(await routingTip.locator('.crm-hint-tip').isVisible(), false, 'the tip is hidden until asked for');
    await routingTip.hover();
    assert.match(await routingTip.locator('.crm-hint-tip').innerText(), /Who owns each new lead/, 'hovering the (i) shows the routing explanation');
    await page.mouse.move(0, 0);

    // Lead routing: by rules, a rule with conditions edited in the filter editor, people, saved as organization rules.
    const routing = page.locator('[data-routing]');
    await routing.locator('[data-rt-enabled]').check();
    await routing.locator('[data-rt-method]').selectOption('rules');
    await routing.locator('[data-rt-radd]').click();
    await routing.locator('[data-rt-rlabel="0"]').fill('Referrals');
    await routing.locator('[data-rt-rcond="0"]').click();
    await page.locator('.crm-pop select[data-ffield]').first().selectOption('source_kind');
    await page.locator('.crm-pop [data-fapply]').click();
    await routing.locator('summary').filter({ hasText: 'Choose people' }).first().click();
    await routing.locator('[data-rt-person="rule:0"]').first().check();
    await routing.locator('summary').filter({ hasText: 'Choose people' }).first().click();
    await routing.locator('[data-rt-person="pool"]').first().check();
    await routing.locator('[data-rt-scoring]').check();
    await routing.locator('[data-rt-sadd]').click();
    await routing.locator('[data-rt-slabel="0"]').fill('Any lead');
    await routing.locator('[data-rt-save]').click();
    await page.waitForFunction(() => !document.querySelector('[data-routing] [data-rt-save]')?.disabled);
    await routing.scrollIntoViewIfNeeded();
    await shot(page, '09b-routing');
    const saved = await inject('GET', `/v1/crm/organizations/${orgId}/routing`);
    assert.equal(saved.routing.routing.method, 'rules');
    assert.equal(saved.routing.routing.rules[0].label, 'Referrals');
    assert.equal(saved.routing.routing.rules[0].conditions.rules[0].field, 'source_kind');
    assert.equal(saved.routing.routing.rules[0].user_ids.length, 1);
    assert.equal(saved.routing.scoring.rules[0].points, 10);
    const orgRules = (await inject('GET', `/v1/work/organizations/${orgId}/branches/default/automation-rules`)).rules.map((r) => r.id);
    assert.ok(orgRules.includes('crm_routing_assign') && orgRules.includes('crm_routing_score_lead_received'), orgRules.join(', '));

    // Contact automations: a birthday call, saved as a rule on the contact date.
    const contactRules = page.locator('[data-contact-rules]');
    await contactRules.locator('[data-cr-add]').click();
    await contactRules.locator('[data-cr-title="0"]').fill('Birthday call');
    await contactRules.locator('[data-cr-trigger="0"]').selectOption('date');
    await contactRules.locator('[data-cr-days="0"]').fill('2');
    await contactRules.locator('[data-cr-dir="0"]').selectOption('before');
    await contactRules.locator('[data-cr-a="0.0.title"]').fill('Call {{contact.first_name}} before their birthday');
    await contactRules.locator('[data-cr-add-action="0"]').selectOption('text');
    await contactRules.locator('[data-cr-save]').click();
    await page.waitForFunction(() => !document.querySelector('[data-contact-rules] [data-cr-save]')?.disabled);
    await contactRules.scrollIntoViewIfNeeded();
    await shot(page, '09c-contact-automations');
    const savedContactRules = await inject('GET', `/v1/crm/organizations/${orgId}/contact-rules`);
    const birthday = savedContactRules.contact_rules.rules[0];
    assert.equal(birthday.trigger.kind, 'date');
    assert.equal(birthday.trigger.date_field, 'birthday');
    assert.equal(birthday.trigger.offset_days, -2);
    assert.deepEqual(birthday.actions.map((a) => a.kind), ['todo', 'text']);
    const contactRuleIds = (await inject('GET', `/v1/work/organizations/${orgId}/branches/default/automation-rules`)).rules.map((r) => r.id);
    assert.ok(contactRuleIds.includes(`contact_rule_${birthday.id}`) && contactRuleIds.includes('crm_routing_assign'), 'contact automations and routing keep the rules of the other');

    // Appointments as an agenda.
    await page.locator('.crm-rail').getByText('Upcoming appointments', { exact: true }).click();
    await page.waitForSelector('.crm-agenda, .crm-content .crm-empty');
    await settle(page);
    await shot(page, '10-appointments');
    assert.deepEqual(errors, [], 'no page errors');

    // A phone (FM-478): one row of icon controls under a view picker, the view's own search beneath it,
    // the rail and popovers as sheets from the bottom, the list as cards and the drawer a full sheet.
    const phone = await openPage(browser, { width: 390, height: 844 });
    current = phone.page;
    await settle(phone.page);
    await shot(phone.page, '11-phone-list');
    const box = (selector) => phone.page.locator(selector).first().evaluate((el) => { const r = el.getBoundingClientRect(); return { top: r.top, bottom: r.bottom, left: r.left, right: r.right, height: r.height }; });
    assert.equal(await phone.page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, 'nothing wider than the phone');
    assert.equal(await phone.page.locator('.crm-head [data-display]').isVisible(), false, 'Display moves into the view menu');
    assert.equal(await phone.page.locator('.crm-head .crm-seg button span').first().isVisible(), false, 'icons, not words');
    const picker = await box('.crm-view-pick'), more = await box('[data-view-menu]'), search = await box('.crm-search');
    assert.ok(Math.abs(picker.top - more.top) < 2, 'the picker and the controls share one row');
    assert.ok(search.top >= picker.bottom, 'the view search sits under the controls');
    await phone.page.locator('.crm-view-pick').click();
    await phone.page.waitForFunction(() => { const r = document.querySelector('.crm-rail').getBoundingClientRect(); return Math.abs(r.bottom - innerHeight) < 2 && getComputedStyle(document.querySelector('.crm-rail')).visibility === 'visible'; });
    assert.equal(await phone.page.locator('.crm-view-pick').getAttribute('aria-expanded'), 'true');
    await shot(phone.page, '11a-phone-views');
    // New view (FM-492): its sheet takes the rail's place instead of opening underneath it.
    await phone.page.locator('.crm-rail [data-new-view]').click();
    await phone.page.waitForSelector('.crm-pop [data-nv-name]');
    await phone.page.waitForFunction(() => !document.querySelector('.crm').classList.contains('rail-open'));
    await phone.page.waitForTimeout(350);
    assert.equal(await phone.page.locator('.crm-pop [data-nv-name]').evaluate((el) => { const r = el.getBoundingClientRect(); return el.contains(document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2)); }), true, 'the New view sheet is on top, not under the rail');
    // FM-508: New view asks for a name and what the view lists, says filters come next, and saves the view.
    assert.deepEqual(await phone.page.locator('.crm-pop [data-nv]').evaluateAll((els) => els.map((el) => el.value)), ['opportunities', 'contacts', 'follow_ups', 'appointments']);
    assert.match(await phone.page.locator('.crm-pop .crm-nv-next').innerText(), /filters/i, 'it says filters come next');
    await shot(phone.page, '11a2-phone-new-view');
    await phone.page.locator('.crm-pop [data-nv-create]').click();
    assert.equal(await phone.page.locator('.crm-pop .crm-nv-error').isVisible(), true, 'a view needs a name');
    await phone.page.locator('.crm-pop [data-nv-name]').fill('Homeowners to call back');
    await phone.page.locator('.crm-pop [data-nv="contacts"]').check();
    await phone.page.locator('.crm-pop [data-nv-create]').click();
    await phone.page.waitForFunction(() => document.querySelector('.crm-pop h5')?.textContent.includes('Homeowners to call back'));
    assert.equal(await phone.page.locator('.crm-pick-name').innerText(), 'Homeowners to call back', 'the new view is open');
    assert.ok(await phone.page.locator('.crm-pop [data-frow]').count() >= 1, 'the filter editor opens on it');
    const created = (await inject('GET', `/v1/crm/organizations/${orgId}/views`)).views.find((v) => v.name === 'Homeowners to call back');
    assert.equal(created?.collection, 'contacts');
    assert.equal(created?.pinned, true, 'pinned to the rail');
    await phone.page.locator('.crm-pop [data-fcancel]').click();
    await phone.page.waitForFunction(() => !document.querySelector('.crm-pop'));
    await phone.page.locator('.crm-view-pick').click();
    await phone.page.waitForFunction(() => document.querySelector('.crm').classList.contains('rail-open'));
    await phone.page.locator('.crm-rail').getByText('New leads', { exact: true }).click();
    await phone.page.waitForFunction(() => !document.querySelector('.crm').classList.contains('rail-open'));
    await settle(phone.page);
    // The filter count badge (FM-496): the accent's on-colour, not the chip's dark label colour.
    assert.deepEqual(await phone.page.locator('[data-add-filter] .crm-filter-count').evaluate((el) => { const s = getComputedStyle(el); return { display: s.display, color: s.color }; }), { display: 'grid', color: 'rgb(255, 255, 255)' }, 'white count on the red filter badge');
    await phone.page.locator('[data-add-filter]').click();
    await phone.page.waitForSelector('.crm-pop');
    await phone.page.waitForTimeout(350);
    const sheet = await box('.crm-pop');
    assert.ok(Math.abs(sheet.bottom - 844) < 2, `a filter opens as a sheet from the bottom: ${JSON.stringify(sheet)}`);
    assert.notEqual(await phone.page.evaluate(() => document.activeElement?.tagName), 'INPUT', 'no keyboard thrown up over the sheet');
    await shot(phone.page, '11b-phone-filter');
    await phone.page.keyboard.press('Escape');
    await phone.page.locator('.crm-content [data-row]').first().click();
    await phone.page.waitForSelector('.crm-drawer:not([hidden]) .crm-drawer-actions');
    await shot(phone.page, '12-phone-drawer');
    // CRM settings on a phone (FM-494): a tap opens an (i) tip inside the panel and a tap elsewhere closes it.
    await phone.page.keyboard.press('Escape');
    await phone.page.locator('.crm-view-pick').click();
    await phone.page.waitForFunction(() => document.querySelector('.crm').classList.contains('rail-open'));
    await phone.page.locator('.crm-rail [data-open-panel="settings"]').first().click();
    await phone.page.waitForSelector('[data-routing] h3 [data-crm-tip]');
    const phoneTip = phone.page.locator('[data-routing] h3 [data-crm-tip]').first();
    await phoneTip.click();
    assert.equal(await phoneTip.getAttribute('aria-expanded'), 'true', 'a tap opens the tip');
    const tipBox = await phoneTip.locator('.crm-hint-tip').evaluate((el) => { const r = el.getBoundingClientRect(), p = el.closest('.crm-panel').getBoundingClientRect(); return { left: r.left, right: r.right, panelLeft: p.left, panelRight: p.right }; });
    assert.ok(tipBox.left >= tipBox.panelLeft && tipBox.right <= tipBox.panelRight, `the tip stays inside the panel: ${JSON.stringify(tipBox)}`);
    assert.equal(await phone.page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, 'an open tip does not widen the page');
    await shot(phone.page, '13-phone-settings-tip');
    const customTip = phone.page.locator('details[data-rt-custom] summary [data-crm-tip]');
    await customTip.click();
    assert.equal(await phoneTip.getAttribute('aria-expanded'), 'false', 'opening another tip closes the first');
    assert.equal(await phone.page.locator('details[data-rt-custom]').evaluate((el) => el.open), false, 'the (i) in Custom code does not open the code');
    await phone.page.locator('[data-routing] h3').first().click({ position: { x: 2, y: 2 } });
    assert.equal(await phone.page.locator('[data-crm-tip][aria-expanded="true"]').count(), 0, 'a tap elsewhere closes it');
    // Settings on a phone (FM-495): every dropdown is drawn with its own chevron at a finger's height, nothing is
    // wider than the phone, and a funnel step stacks its event under its name.
    await phone.page.waitForSelector('[data-funnel] .crm-step');
    if (await phone.page.locator('[data-rs-add]').count()) await phone.page.locator('[data-rs-add]').click();
    const controls = await phone.page.evaluate(() => [...document.querySelectorAll('.crm-page select:not(.crm-btn), .crm-page input[type=text]:not(.crm-btn)')].filter((el) => el.offsetParent).map((el) => { const s = getComputedStyle(el); return { name: el.outerHTML.slice(0, 60), select: el.tagName === 'SELECT', appearance: s.appearance, chevron: s.backgroundImage.includes('svg'), border: s.borderTopWidth, height: el.getBoundingClientRect().height, right: el.getBoundingClientRect().right }; }));
    assert.ok(controls.some((c) => c.select), 'settings has dropdowns');
    for (const c of controls) {
      assert.equal(c.border, '1px', `${c.name} has a border`);
      assert.ok(c.height >= 44, `${c.name} is ${c.height}px high`);
      assert.ok(c.right <= 390, `${c.name} fits the phone`);
      if (c.select) assert.ok(c.appearance === 'none' && c.chevron, `${c.name} is a drawn dropdown`);
    }
    assert.equal(await phone.page.evaluate(() => document.querySelector('.crm-page').scrollWidth <= document.querySelector('.crm-page').clientWidth), true, 'nothing wider than the phone in settings');
    const step = await phone.page.locator('[data-funnel] .crm-step').first().evaluate((row) => { const r = (el) => el.getBoundingClientRect(); return { name: r(row.querySelector('[data-fl]')), event: r(row.querySelector('[data-fe]')), remove: r(row.querySelector('[data-fx]')) }; });
    assert.ok(step.event.top >= step.name.bottom - 1, 'the event sits under the step name');
    assert.ok(Math.abs(step.remove.top + step.remove.height / 2 - (step.name.top + step.name.height / 2)) < 4, 'remove is on the name row');
    await phone.page.locator('[data-funnel]').scrollIntoViewIfNeeded();
    await shot(phone.page, '13b-phone-settings-funnel');
    // On a phone the Sources intro is an (i) at the right under the picker, beside the toolbar, and its tip hangs from it (FM-493).
    await phone.page.locator('.crm-view-pick').click();
    await phone.page.waitForFunction(() => document.querySelector('.crm').classList.contains('rail-open'));
    await phone.page.locator('.crm-rail [data-open-panel="sources"]').click();
    await phone.page.waitForSelector('.crm-tree');
    const info = phone.page.locator('.crm-intro [data-crm-tip]');
    assert.equal(await phone.page.locator('.crm-intro .crm-hint-tip').isVisible(), false, 'the sources intro is hidden until asked for');
    const pick = await box('.crm-view-pick'), icon = await box('.crm-intro [data-crm-tip]'), add = await box('[data-src-add]');
    assert.ok(icon.top >= pick.bottom && Math.abs(icon.right - pick.right) < 2, `the (i) is under the picker, at its right: ${JSON.stringify({ pick, icon })}`);
    assert.ok(Math.abs(add.top - icon.top) < 2, 'beside the toolbar, taking no row of its own');
    await info.click();
    assert.equal(await info.getAttribute('aria-expanded'), 'true', 'a tap opens the tip');
    const tip = await box('.crm-intro .crm-hint-tip');
    assert.ok(tip.top >= icon.bottom && Math.abs(tip.right - icon.right) < 2 && tip.left >= 0 && tip.right - tip.left > 200, `the tip hangs under the (i), right-aligned, inside the screen: ${JSON.stringify({ icon, tip })}`);
    assert.equal(await phone.page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, 'the tip does not widen the page');
    await shot(phone.page, '14-phone-sources-tip');
    await phone.page.mouse.click(20, 800);
    assert.equal(await info.getAttribute('aria-expanded'), 'false', 'a tap elsewhere closes it');
    assert.deepEqual(phone.errors, [], 'no page errors on a phone');
  } catch (error) {
    if (current) await shot(current, 'failure').catch(() => null);
    throw error;
  } finally { await browser.close(); }
});

test('the CRM tab: the magic button opens the assistant bar, which changes and saves views (FM-551)', async () => {
  const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH || 'C:/Program Files/Google/Chrome/Application/chrome.exe', headless: true });
  let current = null;
  try {
    const phone = await openPage(browser, { width: 433, height: 870 });
    const { page, errors } = phone;
    current = page;
    await page.locator('.crm-view-pick').click();
    await page.waitForFunction(() => document.querySelector('.crm').classList.contains('rail-open'));
    await page.locator('.crm-rail').getByText('New leads', { exact: true }).click();
    await page.waitForFunction(() => !document.querySelector('.crm').classList.contains('rail-open'));
    await settle(page);
    // The magic button sits beside Filter, to its left, on the search row.
    const box = (selector) => page.locator(selector).first().evaluate((el) => { const r = el.getBoundingClientRect(); return { top: r.top, left: r.left, right: r.right, bottom: r.bottom }; });
    const search = await box('.crm-search'), magic = await box('[data-ai-open]'), filter = await box('[data-add-filter]');
    assert.ok(magic.left >= search.right && magic.right <= filter.left && Math.abs(magic.top - filter.top) < 2, `search, magic, filter in one row: ${JSON.stringify({ search, magic, filter })}`);
    assert.equal(await page.locator('.crm-agent-host').count(), 0, 'nothing is mounted until it is asked for');
    await page.locator('[data-ai-open]').click();
    await page.waitForFunction(() => document.querySelector('.crm-agent-host')?.dataset.trayOpen === 'true');
    await page.waitForTimeout(500);
    const bar = await box('.crm-agent-bar');
    assert.ok(Math.abs(bar.bottom - 870) < 2 && bar.top > 435, `the bar sits at the bottom: ${JSON.stringify(bar)}`);
    assert.equal(await page.locator('[data-ai-open]').getAttribute('aria-pressed'), 'true');
    assert.equal(await page.locator('.crm-agent-bar .fm-project-agent-history').count(), 1, 'the project agent bar, with its Conversation control');
    await shot(page, '15-phone-ai-bar');
    // It runs in the person's private CRM conversation and sends what is on screen.
    const thread = await page.evaluate(async () => (await window.__agent.loadContext()).main_thread);
    assert.equal(thread.subject_id, 'crm');
    const context = await page.evaluate(() => window.__agent.getContext());
    assert.equal(context.surface, 'crm');
    assert.equal(context.crm.collection, 'opportunities');
    assert.equal(context.crm.view_name, 'New leads');
    assert.equal(context.crm.unsaved_changes, false);
    // A view the assistant shows is an unsaved change of the view on screen.
    await page.evaluate(() => window.__agent.onReply({ role: 'assistant', data: { renders: [{ type: 'crm_view', collection: 'opportunities', definition: { filter: { match: 'all', rules: [{ field: 'source_kind', operator: 'in', value: ['web_form'] }] }, sort: [{ key: 'created_at', dir: 'desc' }], group_by: '', layout: 'list', columns: [] } }] } }));
    await settle(page);
    await page.waitForSelector('.crm-savebar:not([hidden])');
    assert.match(await page.locator('.crm-chips').innerText(), /Source type/);
    assert.equal(await page.evaluate(() => window.__agent.getContext().crm.unsaved_changes), true);
    // Saved as a new view, it carries the magic tag in the views list and the title.
    page.once('dialog', (dialog) => dialog.accept('Web form leads from the website and landing pages'));
    await page.locator('[data-save-as]').click();
    await page.waitForFunction(() => document.querySelector('.crm-pick-name')?.textContent.includes('Web form leads from'));
    const saved = (await inject('GET', `/v1/crm/organizations/${orgId}/views`)).views.find((v) => v.name === 'Web form leads from the website and landing pages');
    assert.equal(saved?.definition.origin, 'ai', 'the view is marked as made by the AI');
    assert.equal(await page.locator(`.crm-rail [data-open-view="${saved.id}"] .crm-ai-tag`).count(), 1, 'the magic tag in the views list');
    assert.equal(await page.locator('.crm-pick-line .crm-ai-tag').count(), 1, 'and by the title');
    assert.equal(await page.locator('.crm-pick-line .crm-ai-tag').isVisible(), true, 'the tag stays in view beside a long name');
    assert.equal(await page.locator('[data-ai-open]').getAttribute('title'), null, 'no title tooltip left over the chips after a tap on a phone');
    assert.equal(await page.locator('.crm-rail [data-open-view] .crm-ai-tag').count(), 1, 'only on views the AI made');
    // A view the assistant saved opens.
    const pipeline = (await inject('GET', `/v1/crm/organizations/${orgId}/views`)).views.find((v) => v.name === 'Pipeline');
    await page.evaluate((id) => window.__agent.onReply({ role: 'assistant', data: { renders: [{ type: 'crm_view', view_id: id, saved: true }] } }), pipeline.id);
    await page.waitForFunction(() => document.querySelector('.crm-pick-name')?.textContent.includes('Pipeline'));
    await shot(page, '16-phone-ai-applied');
    // Escape (or the bar's own close) puts it away.
    await page.locator('.crm-agent-bar textarea').focus();
    await page.keyboard.press('Escape');
    await page.waitForFunction(() => document.querySelector('.crm-agent-host').dataset.trayOpen === 'false');
    assert.equal(await page.locator('[data-ai-open]').getAttribute('aria-pressed'), 'false');
    // On a desktop the button is beside Filter and the bar is a bottom bar over the view.
    const desk = await openPage(browser, { width: 1440, height: 900 });
    current = desk.page;
    await settle(desk.page);
    const deskMagic = await desk.page.locator('[data-ai-open]').evaluate((el) => { const r = el.getBoundingClientRect(), f = el.nextElementSibling.getBoundingClientRect(); return { right: r.right, filterLeft: f.left, filter: el.nextElementSibling.matches('[data-add-filter]') }; });
    assert.ok(deskMagic.filter && deskMagic.right <= deskMagic.filterLeft, 'left of Filter');
    await desk.page.locator('[data-ai-open]').click();
    await desk.page.waitForFunction(() => document.querySelector('.crm-agent-host')?.dataset.trayOpen === 'true');
    await desk.page.waitForTimeout(500);
    const deskBar = await desk.page.locator('.crm-agent-bar').evaluate((el) => { const r = el.getBoundingClientRect(); return { width: r.width, bottom: r.bottom }; });
    assert.ok(deskBar.width <= 681 && Math.abs(deskBar.bottom - 900) < 2, `a bottom bar: ${JSON.stringify(deskBar)}`);
    await shot(desk.page, '17-desktop-ai-bar');
    assert.deepEqual([...errors, ...desk.errors], [], 'no page errors');
  } catch (error) {
    if (current) await shot(current, 'failure-ai').catch(() => null);
    throw error;
  } finally { await browser.close(); }
});
