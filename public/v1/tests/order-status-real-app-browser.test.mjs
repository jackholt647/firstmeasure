// 1M8-234: orders that are processing must not look cancelled. Chrome runs the real project-request app, the real
// measurements and map apps, the real project store, navigation, window manager and apps runtime, for an organization
// without platform expanded access (production's setup). Each order opens as the FirstMeasure-only board passes it, and
// the test reads what the customer sees: the report rows on the Summary tab, the Standard pane, and the Overview.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { chromium } from 'playwright-core';

const publicDir = new URL('../../', import.meta.url);
const SCRIPTS = ['/libraries/navigation/portal-navigation.js', '/portal/scripts/project_viewer.js', '/libraries/app-runtime/firstmate-embeddable-apps.js',
  '/libraries/apps/firstmate-apps-manifest.js', '/libraries/window-manager/window-manager.js', '/libraries/window-manager/window-shell.js',
  '/libraries/apps/measurements/project.js', '/libraries/apps/project-map/app.js', '/libraries/apps/project-request/app.js'];
const ID = '3c3c672ccc2961b09a287c8de2b3a0e0';
const hold = { reason: 'standard_release_window', status: 'holding', completed_at: '2026-10-22T20:36:43Z', expedite_option: 'standard_3_6',
  promised_delivery_at: '2099-10-23T00:28:09Z', scheduled_release_at: '2099-10-23T00:18:09Z' };
const ORDERS = {
  processing: { status: 'processing' },
  queued: { status: 'queued' },
  // Finished and waiting out the standard release window: the customer still sees it processing (the 1M8-234 order).
  held: { status: 'completed', has_report_pdf: true, has_summary_pdf: true, delivery: { release_hold: hold } },
  completed: { status: 'completed', has_report: true, has_report_pdf: true, has_summary_pdf: true,
    report_url: `/v1/firstmeasure/projects/${ID}/artifacts/Report.pdf`, summary_url: `/v1/firstmeasure/projects/${ID}/artifacts/Summary.pdf` },
  cancelled: { status: 'cancelled', cancelled_at: '2026-10-22T19:00:00Z' },
  exterior: { status: 'processing', measurement_scope: 'full_house', include_gutter_measurements: true, report_expedite_option: 'exteriors_standard',
    report_expedite_label: 'Standard · 24 hours', report_due_window_end: '2099-10-23T00:00:00Z', amount_charged: 25,
    manifest: { measurement_scope: 'full_house', report_expedite_option: 'exteriors_standard' } }
};

async function openOrder(browser, kind, options = {}) {
  const page = await browser.newPage({ viewport: { width: 1280, height: 860 } });
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.route('https://portal.test/**', async route => {
    const url = new URL(route.request().url());
    if (url.pathname.startsWith('/libraries/') || url.pathname.startsWith('/portal/scripts/')) {
      try { return await route.fulfill({ contentType: 'text/javascript', body: await readFile(new URL(url.pathname.slice(1), publicDir)) }); }
      catch { return route.fulfill({ status: 404, body: '' }); }
    }
    if (url.pathname.endsWith('.pdf')) return route.fulfill({ contentType: 'application/pdf', body: '%PDF-1.4' });
    return route.fulfill({ contentType: 'text/html', body: '<!doctype html><html><body></body></html>' });
  });
  await page.goto('https://portal.test/portal/?tab=projects');
  await page.evaluate(({ id, order, options }) => {
    // A support session impersonating the customer gets the same page, plus the PHP page's impersonation flags.
    window.__APP = { userEmail: 'owner@example.test', userOrgId: 'org_test', platformExpandedAssets: false,
      ...(options.impersonate ? { isImpersonating: true, realAdminEmail: 'support@1m8.ai' } : {}) };
    if (options.impersonate) document.body.insertAdjacentHTML('afterbegin', '<div id="impersonationBanner">SUPPORT MODE</div>');
    window.PlatformCommerce = { onReady: fn => fn(), price: () => 7, credit: v => '$' + v, cash: v => '$' + v, estimate: v => v, withVat: t => t, current: () => ({}) };
    window.Portal = {
      cfg: window.__APP,
      util: {
        $: (sel, root = document) => root.querySelector(sel),
        injectCSS: (key, css) => { if (document.getElementById('css-' + key)) return; const s = document.createElement('style'); s.id = 'css-' + key; s.textContent = css; document.head.append(s); },
        postAction: async (action, fields) => {
          (window.__actions ||= []).push({ action, ...fields });
          if (action === 'exteriors_quote' && options.exteriorQuote) return { data: { success: true, pricing_revision: 3, options: [
            { key: 'exteriors_standard', label: 'Standard · 24 hours', minutes: 1440, amount: 25 },
            { key: 'exteriors_same_day', label: 'Under 6 hours', minutes: 360, amount: 30 },
            { key: 'exteriors_priority', label: 'Under 3 hours', minutes: 180, amount: 35 }] } };
          return { data: { success: false } };
        }, hasPerm: () => true, formatDate: v => String(v || ''),
        fmUrl: p => 'https://portal.test/fm/' + p, fmJson: async () => ({ project: { files: options.orderFiles || [] } }), fmPost: async () => ({ projects: [] }), platformJson: async () => ({}),
        currentActor: () => ({ email: 'owner@example.test', organization_id: 'org_test' })
      },
      ui: { showToast: () => {} },
      // Capabilities loaded; this organization has no platform expanded access.
      capabilities: { current: () => ({ loaded_at: '1', org_id: 'org_test', definitions: [], definitions_by_key: {}, effective_by_key: new Proxy({}, { get: (t, k) => k !== 'platform.expanded_access' }) }),
        value: (k, f) => (k === 'platform.expanded_access' ? false : f) },
      platformExpandedAccess: () => options.expanded === true,
      appFlags: { current: () => ({}), has: (a, f) => f === 'measurement_report_summary', value: (a, f, d) => d }
    };
    window.PlatformAPI = { projects: { list: async () => ({ documents: [] }), get: async () => null, save: async () => { throw new Error('No platform writes without expanded access'); } }, appFlags: { current: () => ({}) } };
    // The FirstMeasure-only board row (core.js normalizeFirstMeasureProjectRecord over projects/list).
    const listRow = { id, folder: id, address: '340 Leslie Ct, Bristol, TN 37620, USA', project_type: 'residential', resident_name: 'Jason Mullins',
      lat: 36.59, lng: -82.2, pins: [{ lat: 36.59, lng: -82.2 }], created_at: '2026-10-22T18:38:09Z', queued_at: '2026-10-22T18:38:09Z',
      report_expedite_option: 'standard_3_6', ...order };
    const measurement = { id, project_id: id, folder: id, raw: listRow };
    window.__row = { ...listRow, id: 'project_1e0697y1uw90eq', platform_project_id: '', base_project_id: '', measurement, measurement_project: measurement };
    if (options.fullRow) {
      // projects/list's full row (buildLegacyProjectRow): no folder, so core.js keeps the order id and adds no
      // measurement object; the release hold arrives flattened.
      const { folder, delivery, ...row } = listRow;
      const hold = delivery?.release_hold || {};
      window.__row = { ...row, delivery_hold_status: hold.status || null, delivery_hold_reason: hold.reason || null,
        delivery_hold_scheduled_release_at: hold.scheduled_release_at || null, delivery_hold_promised_delivery_at: hold.promised_delivery_at || null,
        delivery_release_hold: hold, platform_project_id: '', base_project_id: '' };
    }
    if (options.seedDrafts) {
      // Drafts already in this browser's cache for the customer (the per-organization, per-person project store).
      localStorage.setItem('fm_platform_project_store_v1:org_test:owner@example.test', JSON.stringify({ version: 1, org_id: 'org_test', user_id: 'owner@example.test', projects: Object.fromEntries(options.seedDrafts.map(d => [d.id, d])), measurementIndex: {} }));
    }
    if (options.trayWidgets) {
      // The report viewer's mount: what the tray hands it is what the customer's model is drawn from.
      window.__model = [];
      window.FirstMateWidgets = { mount: (root, ref, context) => { const handle = { ready: Promise.resolve(), setVisible() {}, destroy() {}, update(next) { window.__model.push(next.data?.['reports.roof'] || null); root.innerHTML = '<div data-test-model>3D model</div>'; }, refresh() {} }; return handle; } };
    }
    if (options.refusedReads) {
      // Published project data refused: a person with expanded access but without permission to read it.
      const refuse = async () => { window.__refused = (window.__refused || 0) + 1; throw Object.assign(new Error('Refused'), { status: 403 }); };
      Object.assign(window.PlatformAPI, { baseUrl: () => 'https://portal.test/v1/platform', request: refuse, publication: { list: refuse, read: refuse } });
    }
    if (options.countReads) window.PlatformAPI.publication = new Proxy({}, { get: () => async () => { window.__published = (window.__published || 0) + 1; throw Object.assign(new Error('Refused'), { status: 403 }); } });
  }, { id: ID, order: ORDERS[kind], options });
  for (const src of SCRIPTS) await page.addScriptTag({ url: 'https://portal.test' + src });
  // Let the app's startup route restore finish before opening, as a board click does.
  await page.waitForTimeout(1200);
  // The board's FirstMeasure-only listing (core.js list_projects) runs before any order is opened.
  if (options.listPass) await page.evaluate(() => { window.__discarded = Portal.ProjectStore.discardDraftsShadowingOrders([window.__row]); });
  await page.evaluate(() => { window.__cachedBeforeOpen = Portal.ProjectStore.cachedIds(); });
  // The order opens from this page's copy (no platform read), for cases about the card rather than about opening.
  if (options.localOpen) await page.evaluate(() => { Portal.ProjectStore.hasPendingSave = () => true; });
  // A link names the project by id alone (a reload of the project's address, an emailed link).
  if (options.linkId) await page.evaluate(id => {
    window.__lookups = [];
    Portal.firstMeasureOrderForProject = async asked => { window.__lookups.push(asked); return asked === window.__row.id ? window.__row : null; };
    return Portal.modules.request.openProject({ id }, {}).catch(error => { window.__openError = error.code; });
  }, options.linkId);
  else await page.evaluate(() => Portal.modules.request.openProject(window.__row, {}));
  await page.waitForTimeout(1200);
  return { page, errors };
}

const visibleText = (page, selector) => page.evaluate(sel => [...document.querySelectorAll(sel)].filter(e => e.offsetParent).map(e => e.innerText.replace(/\s+/g, ' ').trim()), selector);
// An order opens on its Summary tab; the report's own card is on the Standard tab.
async function standardPane(page) {
  await page.locator('#rOverlay [data-tab="standard"]').first().click();
  await page.waitForTimeout(300);
  return (await visibleText(page, '.r-measure-pane.active')).join(' ');
}
async function summary(page) {
  await page.locator('#rOverlay [data-tab="summary"]').first().click();
  await page.waitForTimeout(300);
  return page.evaluate(() => [...document.querySelectorAll('.r-measure-pane.active .r-report-summary-row .r-report-summary-pill')]
    .map(e => e.textContent.trim().toLowerCase()).filter(Boolean));
}

test('1M8-234: processing, queued and release-held orders read Processing; ready says Ready; cancelled says Cancelled', async () => {
  const browser = await chromium.launch({ channel: 'chrome', headless: true });
  try {
    for (const [kind, expected] of [['processing', 'processing'], ['queued', 'processing'], ['held', 'processing'], ['completed', 'ready'], ['cancelled', 'cancelled']]) {
      const { page, errors } = await openOrder(browser, kind);
      const rows = await summary(page);
      assert.ok(rows.length >= 2, `${kind}: report rows ${JSON.stringify(rows)}`);
      assert.deepEqual([...new Set(rows.slice(0, 2))], [expected], `${kind}: report rows ${JSON.stringify(rows)}`);
      assert.ok(!rows.slice(0, 2).includes('not available'), `${kind} must not read like a closed order: ${JSON.stringify(rows)}`);
      assert.deepEqual(errors, [], kind);
      await page.close();
    }
  } finally { await browser.close(); }
});

test('1M8-234: an order still in work opens on its report with no new-order offer', async () => {
  const browser = await chromium.launch({ channel: 'chrome', headless: true });
  try {
    for (const kind of ['processing', 'queued', 'held']) {
      const { page } = await openOrder(browser, kind);
      const standard = await standardPane(page);
      assert.match(standard, /Standard Report Processing/, `${kind}: ${standard.slice(0, 200)}`);
      assert.doesNotMatch(standard, /cancelled|canceled|not available/i, kind);
      const orderOffers = await page.evaluate(() => [...document.querySelectorAll('#rOverlay .r-overview-initial-actions button')].filter(b => b.offsetParent && /order report/i.test(b.textContent)).length);
      assert.equal(orderOffers, 0, `${kind} offers to order again`);
      await page.close();
    }
  } finally { await browser.close(); }
});

test('Without expanded access, an order opens in a browser with no cached copy, from the board and from a link', async () => {
  const browser = await chromium.launch({ channel: 'chrome', headless: true });
  try {
    for (const [name, options] of [['board row', {}], ['full board row', { fullRow: true }], ['link', { linkId: 'project_1e0697y1uw90eq' }]]) {
      const { page, errors } = await openOrder(browser, 'processing', options);
      assert.deepEqual(await page.evaluate(() => window.__cachedBeforeOpen), [], name);
      assert.equal(await page.locator('#rOverlay .r-project-open-failure').count(), 0, name);
      assert.match(await standardPane(page), /Standard Report Processing/, name);
      assert.deepEqual(errors, [], name);
      await page.close();
    }
    // A link to something this organization has no order for still says so, and creates nothing.
    const { page } = await openOrder(browser, 'processing', { linkId: 'project_someone_elses' });
    assert.deepEqual(await page.evaluate(() => [window.__lookups, window.__openError, Portal.ProjectStore.cachedIds()]), [['project_someone_elses'], 'project_not_found', []]);
    assert.match((await page.locator('#rOverlay').innerText()), /could not be found/);
    await page.close();
  } finally { await browser.close(); }
});

// Jack's rule: the measurement widget shows the order status, the measurements or the order option, never "No measurements."
const tray = page => page.locator('#rTrayMeasurements').innerText().catch(() => '');
async function settledTray(page) {
  // The Overview's form is a page fragment this harness does not serve; the widget sits under its address step.
  await page.evaluate(() => { document.querySelector('#rOverlay .r-overview-details')?.insertAdjacentHTML('afterbegin', '<div id="rStepAddress"></div>'); document.querySelector('#rOverlay')?.classList.contains('details-tray-open') && document.querySelector('#rProjectIdentityTrigger')?.click(); document.querySelector('#rProjectIdentityTrigger')?.click(); });
  await page.waitForFunction(() => document.querySelector('#rTrayMeasurements') && !document.querySelector('#rTrayMeasurements .sw-measure-skeleton'), null, { timeout: 15000 });
  await page.waitForTimeout(300);
  return (await tray(page)).replace(/\s+/g, ' ');
}
test('The measurement widget of an order shows its status or its measurements, never an empty state', async () => {
  const browser = await chromium.launch({ channel: 'chrome', headless: true });
  try {
    for (const [kind, status] of [['processing', /Standard Report Processing/], ['queued', /Standard Report Pending|Standard Report Processing/], ['held', /Standard Report Processing/]]) {
      const { page, errors } = await openOrder(browser, kind, { trayWidgets: true, countReads: true });
      const text = await settledTray(page);
      assert.match(text, status, kind);
      assert.doesNotMatch(text, /No measurements|Order measurement report/, kind);
      assert.equal(await page.evaluate(() => window.__published || 0), 0, kind + ': nothing asks for data the platform refuses this customer');
      assert.deepEqual(errors, [], kind);
      await page.close();
    }
    // A cancelled order can be ordered again.
    {
      const { page } = await openOrder(browser, 'cancelled', { trayWidgets: true, countReads: true });
      const text = await settledTray(page);
      assert.match(text, /Order measurement report/);
      assert.doesNotMatch(text, /No measurements/);
      await page.close();
    }
    // Finished, for someone who cannot read published project data: the report's own model, from the order.
    const model = [{ name: 'Report.pdf' }, { name: 'Summary.pdf' }, { name: 'model_data.xml' }];
    for (const [name, options] of [['no expanded access', { countReads: true }], ['expanded, reads refused', { expanded: true, refusedReads: true, localOpen: true }]]) {
      const { page, errors } = await openOrder(browser, 'completed', { trayWidgets: true, orderFiles: model, ...options });
      const text = await settledTray(page);
      assert.doesNotMatch(text, /No measurements|Get measurements|Measurement report ready/, name);
      assert.match(await page.evaluate(() => window.__model.at(-1)?.xmlUrl || ''), /artifacts\/model_data\.xml$/, name);
      assert.equal(await page.locator('#rTrayMeasurements [data-test-model]').isVisible(), true, name);
      assert.deepEqual(errors, [], name);
      await page.close();
    }
    // Finished with no model to draw: it says the report is ready and opens it.
    const { page, errors } = await openOrder(browser, 'completed', { trayWidgets: true, orderFiles: [{ name: 'Report.pdf' }, { name: 'Summary.pdf' }] });
    assert.match(await settledTray(page), /Measurement report ready/);
    await page.locator('#rTrayMeasurements [data-measure-order-open]').click();
    await page.waitForTimeout(400);
    assert.equal(await page.locator('#rOverlay .r-measure-pane.active').isVisible(), true);
    assert.deepEqual(errors, []);
    await page.close();
  } finally { await browser.close(); }
});
test('With no order, the measurement widget offers the order, or manual entry, or says why not', async () => {
  const browser = await chromium.launch({ channel: 'chrome', headless: true });
  try {
    const page = await browser.newPage();
    await page.route('https://portal.test/**', async route => {
      const url = new URL(route.request().url());
      if (url.pathname.startsWith('/libraries/')) return route.fulfill({ contentType: 'text/javascript', body: await readFile(new URL(url.pathname.slice(1), publicDir)) });
      return route.fulfill({ contentType: 'text/html', body: '<!doctype html><html><body><div id="start"></div></body></html>' });
    });
    await page.goto('https://portal.test/');
    const draw = options => page.evaluate(async options => {
      const { mountMeasurementStart } = await import('/libraries/apps/materials/scope-of-work.js');
      const node = document.querySelector('#start');
      mountMeasurementStart(node, options);
      return { text: node.innerText.replace(/\s+/g, ' '), buttons: [...node.querySelectorAll('button')].map(b => [b.textContent, b.disabled]) };
    }, options);
    const order = 'Order measurement report', manual = 'Add measurements manually';
    const cases = [
      [{ canOrder: true, canEnter: true }, [[order, false], [manual, false]], /Get measurements/],
      [{ canOrder: true }, [[order, false]], /Get measurements/],
      [{ canEnter: true, orderBlocked: 'permission' }, [[manual, false]], /Ask a company administrator/],
      [{ orderBlocked: 'permission' }, [], /aren't available here.*Ask a company administrator/],
      [{ orderBlocked: 'feature' }, [], /aren't available here.*aren't turned on for this company/],
      [{}, [], /aren't available here/],
      [{ pending: true }, [], /Measurement report on order.*when it is ready/]
    ];
    for (const [options, buttons, message] of cases) {
      const shown = await draw(options);
      assert.deepEqual(shown.buttons, buttons, JSON.stringify(options));
      assert.match(shown.text, message, JSON.stringify(options));
      assert.doesNotMatch(shown.text, /No measurements/, JSON.stringify(options));
    }
  } finally { await browser.close(); }
});

const staleDraft = (id, extra = {}) => ({ id, title: '', address: '340 Leslie Ct, Bristol, TN 37620, USA', project_type: 'residential', lat: '36.59', lng: '-82.2',
  pins: [{ lat: 36.59, lng: -82.2 }], contacts: [{ name: 'Jason Mullins', phone: '', email: '' }], workflow_state: 'draft', workflow_intent: 'report',
  measurement: {}, measurement_project: {}, events: [], proposals: [], photos: [], updated_at: '2026-10-22T22:11:58Z', ...extra });

test('1M8-234: impersonating a customer, active orders open as orders and stale cached drafts at their address are discarded', async () => {
  const browser = await chromium.launch({ channel: 'chrome', headless: true });
  try {
    for (const kind of ['processing', 'queued', 'held']) {
      const { page, errors } = await openOrder(browser, kind, {
        impersonate: true, fullRow: true, listPass: true,
        seedDrafts: [
          staleDraft('project_mvk3j5kc_ffp4ewq6'),
          // Kept: a draft with work of its own, a draft touched in the last ten minutes, and a draft elsewhere.
          staleDraft('project_mvk3j5kc_withnote', { project_notes: 'Gate code 1234' }),
          staleDraft('project_mvk3j5kc_justnow', { updated_at: new Date().toISOString() }),
          staleDraft('project_mvk3j5kc_otheraddr', { address: '1 Other St, Bristol, TN 37620, USA' })
        ]
      });
      assert.deepEqual(await page.evaluate(() => window.__discarded), ['project_mvk3j5kc_ffp4ewq6'], kind);
      const cached = await page.evaluate(() => Portal.ProjectStore.cachedIds());
      assert.ok(!cached.includes('project_mvk3j5kc_ffp4ewq6') && ['withnote', 'justnow', 'otheraddr'].every(s => cached.includes('project_mvk3j5kc_' + s)), JSON.stringify(cached));
      const standard = await standardPane(page);
      assert.match(standard, /Standard Report Processing/, `${kind}: ${standard.slice(0, 200)}`);
      const orderOffers = await page.evaluate(() => [...document.querySelectorAll('#rOverlay .r-overview-initial-actions button')].filter(b => b.offsetParent && /order report/i.test(b.textContent)).length);
      assert.equal(orderOffers, 0, `${kind} offers to order again`);
      assert.deepEqual(await summary(page), ['processing', 'processing'], kind);
      assert.deepEqual(errors, [], kind);
      await page.close();
    }
  } finally { await browser.close(); }
});

test('1M8-234: the FirstMeasure-only order listing discards cache-only drafts at its orders\' addresses', async () => {
  const source = await readFile(new URL('portal/scripts/core.js', publicDir), 'utf8');
  const listing = source.slice(source.indexOf("    if (action === 'list_projects') {"), source.indexOf("    if (action === 'queue') {"));
  assert.match(listing, /discardDraftsShadowingOrders\?\.\(firstMeasureList\)[\s\S]*projectPageFromCandidates\(firstMeasureList, fields, \{ hydrateDetails: false \}\)/);
});

test('1M8-234: autosave never starts a draft inside an existing project', async () => {
  const source = await readFile(new URL('libraries/apps/project-request/app.js', publicDir), 'utf8');
  const start = source.indexOf('  function persistActiveBaseProject(');
  const body = source.slice(start, source.indexOf('\n  }', start));
  assert.match(body, /if \(!activeBaseProject && addressSelected && !viewingExistingProject\) ensureDraftBaseProject\(\);/);
});

test('A Full Exterior order says what was ordered and offers the faster deliveries for the difference', async () => {
  const browser = await chromium.launch({ channel: 'chrome', headless: true });
  try {
    const { page, errors } = await openOrder(browser, 'exterior', { exteriorQuote: true, localOpen: true });
    assert.match((await visibleText(page, '.r-measure-pane.active h3')).join(' '), /Full Exterior Report Summary/);
    await page.locator('#rOverlay [data-tab="standard"]').first().click();
    await page.waitForTimeout(300);
    const card = (await visibleText(page, '#rOverlay .r-report-pending-card'))[0] || await page.evaluate(() => document.querySelector('#rOverlay')?.innerText.slice(0, 1500) || 'no overlay');
    assert.match(card, /Full Exterior Report Processing/, card);
    assert.match(card, /Ordered Full Exterior · Standard · 24 hours/i, card);
    assert.match(card, /Roof, walls, windows, doors and gutters included\./, card);
    const offers = await page.evaluate(() => [...document.querySelectorAll('#rOverlay [data-select-upgrade-expedite]')].filter(b => b.offsetParent)
      .map(b => [b.dataset.selectUpgradeExpedite, b.innerText.replace(/\s+/g, ' ').trim(), b.disabled]).slice(0, 2));
    assert.deepEqual(offers.map(([key, , disabled]) => [key, disabled]), [['exteriors_same_day', false], ['exteriors_priority', false]], JSON.stringify(offers));
    assert.match(offers[0][1], /^Under 6 hours .*\+\$5(\.00)?$/, offers[0][1]);
    assert.match(offers[1][1], /^Under 3 hours .*\+\$10(\.00)?$/, offers[1][1]);
    assert.deepEqual(await page.evaluate(() => window.__actions.filter(a => a.action === 'exteriors_quote').map(a => a.structure_count)), [1]);
    assert.deepEqual(errors, []);
    await page.close();
  } finally { await browser.close(); }
});
