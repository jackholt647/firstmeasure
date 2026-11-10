// FM-381: a report order that needs a credit top-up is placed when the person comes back from Stripe, and they are put
// back in the project they ordered from. The order used to reach billing (and through it the checkout) only through
// localStorage: on a browser whose storage is full the write failed silently, the checkout carried no order, and the
// return placed nothing and opened nothing, leaving the new project an unordered draft ("No projects").
// Chrome runs, with storage really full, the order window's real credit gate (taken from project-request/app.js) and
// the real billing app: the gate hands billing the order, the checkout carries it, and the return page (storage still
// full) places it once and reopens the project it was ordered from.
import test from 'node:test';
import assert from 'node:assert/strict';
import { access, readFile } from 'node:fs/promises';
import { chromium } from 'playwright-core';

const publicDir = new URL('../../', import.meta.url);
const requestSource = await readFile(new URL('libraries/apps/project-request/app.js', publicDir), 'utf8');
const USD = { currency: 'USD', credit_display: 'currency', minor_digits: 2, vat_included: false,
  report_prices: { residential: 7, commercial: 12, multifamily: 12, gutters: 2, weather: 0, instant_residential: 0, instant_commercial: 0, instant_multifamily: 0 } };
const PROJECT_ID = 'project_mwfm381a_topup01';

function functionSource(name) {
  const start = requestSource.indexOf(`  async function ${name}(`) >= 0 ? requestSource.indexOf(`  async function ${name}(`) : requestSource.indexOf(`  function ${name}(`);
  assert.ok(start >= 0, `Missing ${name}`);
  return requestSource.slice(start, requestSource.indexOf('\n  }\n', start) + 4);
}

// The order window on a saved draft project with a roof report chosen, and the window's own credit gate.
const ORDER_WINDOW = `
  const PENDING_ORDER_KEY = 'fm_pending_order_v1';
  const $ = (sel) => document.querySelector(sel);
  const cfg = window.__APP;
  const projectWindowBridge = null;
  let activeBaseProject = { id: ${JSON.stringify(PROJECT_ID)} };
  let selectedType = 'residential', reportSelection = 'roof', includeInstantPreview = false, includeWeatherReport = false;
  let reorderSourceCanReopenInPlace = false, reorderMeasurementProjectId = '';
  const collectContacts = () => [], primaryContact = () => ({}), manualProjectTitle = () => '';
  const hasSelectedAddons = () => true, hasGutterAddon = () => false, hasWeatherAddon = () => false, hasHolidayLightsAddon = () => false;
  const selectedReportMode = () => 'full', selectedReportExpeditePayload = () => ({}), selectedReportExpediteOption = () => null;
  const getMarkersData = () => [{ lat: 40.1372294, lng: -105.1655673 }], collectCcEmails = () => [];
  const currentPrice = () => 7, currentPriceQuote = () => ({ original_amount: 7 }), fmtCredit = (v) => '$' + v;
  const showToast = () => {}, reportCreditViewOverride = () => '', firstReportCheckoutEligible = async () => false;
  ${['capturePendingOrder', 'openCreditTopupForPurchase', 'openReportCreditGateTopup', 'ensureCreditsOrGate'].map(functionSource).join('\n')}
  window.ensureCreditsOrGate = ensureCreditsOrGate;
`;
const ORDER_FORM = `<input id="rAddress" value="4945 Maxwell Ave, Longmont, CO 80503, USA"><input id="rLat" value="40.1372294">
  <input id="rLng" value="-105.1655673"><input id="rCustom" value="0"><input id="rComps" value="{}"><textarea id="rTechNotes"></textarea>`;

async function chromePath() {
  for (const file of [process.env.CHROME_PATH, 'C:/Program Files/Google/Chrome/Application/chrome.exe', '/usr/bin/chromium', chromium.executablePath()].filter(Boolean)) {
    try { await access(file); return file; } catch {}
  }
}

// Fills this origin's localStorage until the browser refuses more, as a browser that has kept years of caches.
const fillStorage = () => {
  let n = 0;
  for (let size = 1 << 20; size >= 64;) {
    try { localStorage.setItem(`fm381_fill_${n++}`, 'x'.repeat(size)); } catch { size >>= 1; }
  }
  try { localStorage.setItem('fm381_probe', 'x'.repeat(256)); return false; } catch { return true; }
};

// A portal page signed in to one organization and person, with no credit before the top-up and a server that answers
// as dev does. The return page reopens projects through the project app.
function portalSetup({ returnPage = false, checkoutOrder = null } = {}) {
  window.__APP = { userEmail: 'owner@example.test', userId: 'user_fm381', userOrgId: 'org_fm381' };
  window.opened = [];
  window.Portal = {
    cfg: { ...window.__APP, ...(returnPage ? { stripePaidFlag: '1' } : {}) },
    util: {
      $: (sel, root = document) => root.querySelector(sel),
      injectCSS: (key, css) => { const s = document.createElement('style'); s.textContent = css; document.head.append(s); },
      postAction: async (action, payload) => {
        await window.fm381Post({ action, payload: JSON.parse(JSON.stringify(payload || {})) });
        if (action === 'stripe_create_checkout') return { data: { success: true, url: 'https://portal.test/stripe-checkout', session_id: 'cs_test_fm381' } };
        if (action === 'stripe_pending_order') return { data: { success: true, order: checkoutOrder } };
        if (action === 'stripe_fulfill_session') return { data: { success: true, paid_dollars: 7 } };
        if (action === 'queue') return { data: { success: true, folder: 'fm381folder' } };
        return { data: { success: false } };
      },
      hasPerm: () => true
    },
    ui: { showToast: () => {} },
    credits: { lastCredits: returnPage ? 7 : 0, refreshCredits: async () => ({ ok: true }) },
    navigation: { replace() {} },
    appFlags: { current: () => ({}), has: () => false, value: (a, f, d) => d },
    ProjectStore: { fromQueue: (fields, data) => ({ id: fields.platform_project_id, measurement: { id: data.folder } }), saveRemote: async (project) => project, cache: (project) => project },
    modules: returnPage ? { request: { openProject: async (project) => { window.opened.push(project); } } } : {}
  };
}

test('FM-381: with storage full, a topped-up report order is placed on the Stripe return and its project reopens', async () => {
  const browser = await chromium.launch({ executablePath: await chromePath(), headless: true });
  try {
    const context = await browser.newContext({ viewport: { width: 1280, height: 860 } });
    const posts = [];
    await context.exposeFunction('fm381Post', (post) => { posts.push(post); });
    await context.route('https://portal.test/**', async route => {
      const url = new URL(route.request().url());
      if (url.pathname.startsWith('/libraries/')) return route.fulfill({ contentType: 'text/javascript', body: await readFile(new URL(url.pathname.slice(1), publicDir)) });
      return route.fulfill({ contentType: 'text/html', body: '<!doctype html><html><body></body></html>' });
    });
    const open = async (url, setup, form = '') => {
      const page = await context.newPage();
      const errors = [];
      page.on('pageerror', error => errors.push(error.message));
      await page.goto(url);
      if (form) await page.setContent(`<!doctype html><html><body>${form}</body></html>`);
      await page.evaluate(setup);
      await page.addScriptTag({ url: 'https://portal.test/libraries/platform-commerce/platform-commerce.js' });
      await page.evaluate(value => window.PlatformCommerce.set(value), USD);
      await page.addScriptTag({ url: 'https://portal.test/libraries/apps/billing/app.js' });
      return { page, errors };
    };

    // The order: no credit, and storage that refuses every write.
    const order = await open('https://portal.test/portal/', `(${portalSetup})()`, ORDER_FORM);
    assert.equal(await order.page.evaluate(fillStorage), true, 'storage refuses writes');
    await order.page.evaluate(ORDER_WINDOW);
    assert.equal(await order.page.evaluate(() => window.ensureCreditsOrGate()), false, 'the order waits for credit');
    await order.page.waitForSelector('#bOverlay.active', { timeout: 10000 });
    // The credit modal shows the order it will place: it came to billing with the gate, not through storage.
    assert.equal(await order.page.evaluate(() => localStorage.getItem('fm_pending_order_v1')), null);
    assert.match(await order.page.locator('#bPendingCard').innerText(), /4945 Maxwell Ave/);
    await order.page.locator('#bGo').click();
    await order.page.waitForURL('https://portal.test/stripe-checkout', { timeout: 10000 });
    assert.deepEqual(order.errors, []);
    // The server keeps the order with the checkout (rememberStripePendingOrder), so the return can place it.
    const checkout = posts.find(post => post.action === 'stripe_create_checkout');
    assert.ok(checkout?.payload.pending_order, 'the checkout carries the order');
    const pending = JSON.parse(checkout.payload.pending_order);
    assert.equal(pending.fields.platform_project_id, PROJECT_ID);
    assert.equal(pending.fields.address, '4945 Maxwell Ave, Longmont, CO 80503, USA');
    assert.match(pending.fields.client_order_id, /^order_/);
    assert.equal(pending.organization_id, 'org_fm381');

    // The return: a new page, storage still full. The order comes back from the checkout, is placed once with its
    // project, and that project's window opens again.
    posts.length = 0;
    const back = await open('https://portal.test/portal/index.php?paid=1&session_id=cs_test_fm381', `(${portalSetup})(${JSON.stringify({ returnPage: true, checkoutOrder: pending })})`);
    await back.page.waitForFunction(() => window.opened.length > 0, null, { timeout: 15000 });
    await back.page.waitForTimeout(500);
    const queued = posts.filter(post => post.action === 'queue');
    assert.equal(queued.length, 1, JSON.stringify(posts.map(post => post.action)));
    assert.equal(queued[0].payload.platform_project_id, PROJECT_ID);
    assert.equal(queued[0].payload.client_order_id, pending.fields.client_order_id);
    assert.deepEqual(await back.page.evaluate(() => window.opened.map(project => project.id)), [PROJECT_ID]);
    assert.equal(await back.page.evaluate(() => localStorage.getItem('fm_pending_order_v1')), null);
    assert.deepEqual(back.errors, []);
  } finally { await browser.close(); }
});
