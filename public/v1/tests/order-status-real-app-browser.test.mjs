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
  cancelled: { status: 'cancelled', cancelled_at: '2026-10-22T19:00:00Z' }
};

async function openOrder(browser, kind) {
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
  await page.evaluate(({ id, order }) => {
    window.__APP = { userEmail: 'owner@example.test', userOrgId: 'org_test', platformExpandedAssets: false };
    window.PlatformCommerce = { onReady: fn => fn(), price: () => 7, credit: v => '$' + v, cash: v => '$' + v, estimate: v => v, withVat: t => t, current: () => ({}) };
    window.Portal = {
      cfg: window.__APP,
      util: {
        $: (sel, root = document) => root.querySelector(sel),
        injectCSS: (key, css) => { if (document.getElementById('css-' + key)) return; const s = document.createElement('style'); s.id = 'css-' + key; s.textContent = css; document.head.append(s); },
        postAction: async () => ({ data: { success: false } }), hasPerm: () => true, formatDate: v => String(v || ''),
        fmUrl: p => 'https://portal.test/fm/' + p, fmJson: async () => ({}), fmPost: async () => ({ projects: [] }), platformJson: async () => ({}),
        currentActor: () => ({ email: 'owner@example.test', organization_id: 'org_test' })
      },
      ui: { showToast: () => {} },
      // Capabilities loaded; this organization has no platform expanded access.
      capabilities: { current: () => ({ loaded_at: '1', org_id: 'org_test', definitions: [], definitions_by_key: {}, effective_by_key: new Proxy({}, { get: (t, k) => k !== 'platform.expanded_access' }) }),
        value: (k, f) => (k === 'platform.expanded_access' ? false : f) },
      appFlags: { current: () => ({}), has: (a, f) => f === 'measurement_report_summary', value: (a, f, d) => d }
    };
    window.PlatformAPI = { projects: { list: async () => ({ documents: [] }), get: async () => null, save: async () => { throw new Error('No platform writes without expanded access'); } }, appFlags: { current: () => ({}) } };
    // The FirstMeasure-only board row (core.js normalizeFirstMeasureProjectRecord over projects/list).
    const listRow = { id, folder: id, address: '340 Leslie Ct, Bristol, TN 37620, USA', project_type: 'residential', resident_name: 'Jason Mullins',
      lat: 36.59, lng: -82.2, pins: [{ lat: 36.59, lng: -82.2 }], created_at: '2026-10-22T18:38:09Z', queued_at: '2026-10-22T18:38:09Z',
      report_expedite_option: 'standard_3_6', ...order };
    const measurement = { id, project_id: id, folder: id, raw: listRow };
    window.__row = { ...listRow, id: 'project_1e0697y1uw90eq', platform_project_id: '', base_project_id: '', measurement, measurement_project: measurement };
  }, { id: ID, order: ORDERS[kind] });
  for (const src of SCRIPTS) await page.addScriptTag({ url: 'https://portal.test' + src });
  // Let the app's startup route restore finish before opening, as a board click does.
  await page.waitForTimeout(1200);
  await page.evaluate(() => Portal.modules.request.openProject(window.__row, {}));
  await page.waitForTimeout(1200);
  return { page, errors };
}

const visibleText = (page, selector) => page.evaluate(sel => [...document.querySelectorAll(sel)].filter(e => e.offsetParent).map(e => e.innerText.replace(/\s+/g, ' ').trim()), selector);
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
      const standard = await visibleText(page, '.r-measure-pane.active');
      assert.match(standard.join(' '), /Standard Report Processing/, `${kind}: ${standard.join(' ').slice(0, 200)}`);
      assert.doesNotMatch(standard.join(' '), /cancelled|canceled|not available/i, kind);
      const orderOffers = await page.evaluate(() => [...document.querySelectorAll('#rOverlay .r-overview-initial-actions button')].filter(b => b.offsetParent && /order report/i.test(b.textContent)).length);
      assert.equal(orderOffers, 0, `${kind} offers to order again`);
      await page.close();
    }
  } finally { await browser.close(); }
});

test('1M8-234: autosave never starts a draft inside an existing project', async () => {
  const source = await readFile(new URL('libraries/apps/project-request/app.js', publicDir), 'utf8');
  const start = source.indexOf('  function persistActiveBaseProject(');
  const body = source.slice(start, source.indexOf('\n  }', start));
  assert.match(body, /if \(!activeBaseProject && addressSelected && !viewingExistingProject\) ensureDraftBaseProject\(\);/);
});
