// 1M8-241: "VAT included" belongs only to the workflows that add credit to the account. Chrome runs the real
// platform-commerce runtime with a euro (VAT-included) account, the real project-request order flow, and the
// add-credit surfaces (the signup "Load your account" step, the billing top-up cards, Stripe credit checkout).
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { chromium } from 'playwright-core';

const publicDir = new URL('../../', import.meta.url);
const read = path => readFile(new URL(path, publicDir), 'utf8');
const EURO = { currency: 'EUR', credit_display: 'currency', minor_digits: 2, vat_included: true,
  report_prices: { residential: 25, commercial: 40, multifamily: 40, gutters: 5, weather: 0, instant_residential: 0, instant_commercial: 0, instant_multifamily: 0 } };
const SCRIPTS = ['/libraries/platform-commerce/platform-commerce.js', '/libraries/navigation/portal-navigation.js', '/portal/scripts/project_viewer.js',
  '/libraries/app-runtime/firstmate-embeddable-apps.js', '/libraries/apps/firstmate-apps-manifest.js', '/libraries/window-manager/window-manager.js',
  '/libraries/window-manager/window-shell.js', '/libraries/apps/measurements/project.js', '/libraries/apps/project-map/app.js', '/libraries/apps/firstmeasure/order/exteriors.js',
  '/libraries/apps/firstmeasure/order/app.js', '/libraries/apps/project-request/app.js'];

async function portal(browser) {
  const page = await browser.newPage({ viewport: { width: 1280, height: 860 } });
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.route('https://portal.test/**', async route => {
    const url = new URL(route.request().url());
    if (url.pathname.startsWith('/libraries/') || url.pathname.startsWith('/portal/scripts/')) {
      try { return await route.fulfill({ contentType: 'text/javascript', body: await readFile(new URL(url.pathname.slice(1), publicDir)) }); }
      catch { return route.fulfill({ status: 404, body: '' }); }
    }
    return route.fulfill({ contentType: 'text/html', body: '<!doctype html><html><body></body></html>' });
  });
  await page.goto('https://portal.test/portal/?tab=projects');
  await page.evaluate(() => {
    window.__APP = { userEmail: 'owner@example.test', userOrgId: 'org_eu', platformExpandedAssets: false };
    window.Portal = {
      cfg: window.__APP,
      util: {
        $: (sel, root = document) => root.querySelector(sel),
        injectCSS: (key, css) => { if (document.getElementById('css-' + key)) return; const s = document.createElement('style'); s.id = 'css-' + key; s.textContent = css; document.head.append(s); },
        postAction: async () => ({ data: { success: false } }), hasPerm: () => true, formatDate: v => String(v || ''),
        fmUrl: p => 'https://portal.test/fm/' + p, fmJson: async () => ({}), fmPost: async () => ({ projects: [] }), platformJson: async () => ({}),
        currentActor: () => ({ email: 'owner@example.test', organization_id: 'org_eu' })
      },
      ui: { showToast: () => {} },
      capabilities: { current: () => ({ loaded_at: '1', org_id: 'org_eu', definitions: [], definitions_by_key: {}, effective_by_key: new Proxy({}, { get: (t, k) => k !== 'platform.expanded_access' }) }),
        value: (k, f) => (k === 'platform.expanded_access' ? false : f) },
      appFlags: { current: () => ({}), has: () => false, value: (a, f, d) => d }
    };
    window.PlatformAPI = { projects: { list: async () => ({ documents: [] }), get: async () => null }, appFlags: { current: () => ({}) } };
    // Installed by the proposals bundle, which these tests do not load.
    window.handleProposalPreviewKeydown = () => {};
  });
  await page.addScriptTag({ url: 'https://portal.test' + SCRIPTS[0] });
  await page.evaluate(profile => window.PlatformCommerce.set(profile), EURO);
  for (const src of SCRIPTS.slice(1)) await page.addScriptTag({ url: 'https://portal.test' + src });
  await page.waitForTimeout(1200);
  return { page, errors };
}

test('1M8-241: the order flow shows euro report prices without "VAT included"', async () => {
  const browser = await chromium.launch({ channel: 'chrome', headless: true });
  try {
    const { page, errors } = await portal(browser);
    // A saved project with an address, ordering its report: the order form shows the property-type step.
    await page.evaluate(() => Portal.modules.request.openProject({ id: 'project_mveu00aa_draft001', title: '12 Rue de Rivoli', address: '12 Rue de Rivoli, 75004 Paris, France', lat: '48.8566', lng: '2.3522', workflow_state: 'draft', measurement: {}, measurement_project: {}, contacts: [], photos: [], proposals: [], events: [] }, { workflow: 'report', tab: 'map' }));
    await page.waitForTimeout(800);
    const cards = await page.evaluate(() => [...document.querySelectorAll('#rOverlay .r-type-btn[data-type]')].map(card => card.textContent.replace(/\s+/g, ' ').trim()));
    assert.ok(cards.length >= 3, JSON.stringify(cards));
    assert.ok(cards.some(text => text.includes('€25')), JSON.stringify(cards));
    assert.ok(cards.every(text => !/VAT/i.test(text)), JSON.stringify(cards));
    await page.locator('#rOverlay .r-type-btn[data-type="residential"]').first().click({ timeout: 3000 }).catch(() => {});
    await page.waitForTimeout(300);
    const overlay = await page.evaluate(() => document.querySelector('#rOverlay')?.innerText || '');
    assert.doesNotMatch(overlay, /VAT/i);
    assert.deepEqual(errors, []);
  } finally { await browser.close(); }
});

test('1M8-241: adding credit still says the price includes VAT', async () => {
  const browser = await chromium.launch({ channel: 'chrome', headless: true });
  try {
    const { page } = await portal(browser);
    // The billing top-up cards ("More credit needed" / "Load your account") label the amount with withVat.
    assert.equal(await page.evaluate(() => PlatformCommerce.withVat(PlatformCommerce.credit(25))), '€25.00, VAT included');
    const billing = await read('libraries/apps/billing/app.js');
    assert.match(billing, /\$\('#bFirstReportTotal'\)\.textContent = window\.PlatformCommerce\.withVat\(fmtCredit\(required\)\);/);
    // The signup "Load your account" step adds its note under the credit tiers.
    const wizard = await read('libraries/apps/onboarding/wizard.js');
    const start = wizard.indexOf('  function creditText(');
    const note = await page.evaluate(code => { const esc = v => String(v); return new Function('esc', code + '; return vatNoteHtml();')(esc); },
      wizard.slice(start, wizard.indexOf('\n  }', wizard.indexOf('  function vatNoteHtml(')) + 4));
    assert.match(note, /ob-vat-note[^>]*>Prices include VAT\./);
    assert.match(wizard, /Load your account[\s\S]{0,400}\$\{vatNoteHtml\(\)\}/);
    // Stripe credit checkout states it (covered server-side by europe-pricing.test.ts).
    const api = await read('v1/platform/api.ts');
    assert.match(api, /if \(reportPricesIncludeVat\(\)\) fields\["line_items\[0\]\[price_data\]\[product_data\]\[description\]"\] \+= "\. VAT included\.";/);
  } finally { await browser.close(); }
});

test('1M8-241: the order flow no longer labels report prices with VAT', async () => {
  const shell = await read('libraries/apps/project-request/app.js');
  assert.doesNotMatch(shell, /withVat|reportVatText|vat_included/);
});
