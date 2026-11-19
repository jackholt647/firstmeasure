// GP-60: the global Invoices tab looks like My Projects. Its header is the title alone (no subtitle, no Refresh) with
// an Outstanding / Needs invoicing / History switch tinted in the primary colour (never black) and New invoice; on a
// phone the portal's top bar carries the title, so the tab starts with one control row, the summary is one row and
// invoices are cards. Whoever can set payments up is offered it while online payments are not set up, and New invoice
// opens the project's own Generate invoice dialog through the route (moneyView=new_invoice), carried into the
// project window. Runs the real file in Chromium with a stubbed portal.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';

const { chromium } = createRequire(new URL('../public/v1/package.json', import.meta.url))('playwright-core');
const CHROME = process.env.CHROME_PATH || 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const source = (path) => readFileSync(new URL(`../public/libraries/${path}`, import.meta.url), 'utf8');
const ORIGIN = 'http://fm.test';
const PAGE = `<!doctype html><html><head><style>:root{--primary:#d93025;--primary-rgb:217,48,37}body{margin:0;font-family:sans-serif}</style><script>
  window.__nav = [];
  window.__setup = 0;
  window.__perms = { manage_projects:true, manage_company_settings:true };
  window.__readiness = { ready:false, reason:'no_merchant_account' };
  window.FirstMateEmbeddableApps = { registerApp(app){ window.__invoicesApp = app; } };
  window.Portal = {
    util:{ injectCSS(id, css){ if (document.getElementById(id)) return; const s = document.createElement('style'); s.id = id; s.textContent = css; document.head.appendChild(s); }, hasPerm:(p) => window.__perms[p] === true },
    ui:{ showToast(){} },
    navigation:{ read:() => ({ tab:'invoices' }), push(){}, replace(){}, registerHandler:() => () => {}, navigate(patch){ window.__nav.push(patch); } },
    appSetup:{ has:(id) => id === 'platform.money', run(){ window.__setup++; return Promise.resolve(true); } }
  };
  window.PlatformAPI = { projects:{ list:async () => ({ documents:[{ id:'project_a', data:{ id:'project_a', title:'12 Oak St', address:'12 Oak St', contacts:[{ name:'Dana Lee', primary:true }] } }] }) } };
  window.PaymentsAPI = {
    intake:{ readiness:async () => ({ readiness:window.__readiness }) },
    invoices:{
      listAll:async () => ({ summary:{ outstanding_cents:375000, outstanding_count:1, draft_cents:0, draft_count:0, overdue_cents:0, production_hold_count:0, aging:{} }, settings:{}, invoices:[
        { id:'inv_1', invoice_number:'INV-1', status:'due', issue_date:'2026-11-01', due_date:'2026-11-30', total_cents:375000, balance_due_cents:375000, project_ref:{ title:'2208 Rhoda Way', address:'Rancho Cordova, CA' }, customer:{ name:'Sam Ray' } }
      ] }),
      uninvoiced:async () => ({ projects:[] })
    }
  };
</script><script src="/libraries/apps/invoices/app.js"></script></head><body><div id="root" style="height:800px"></div></body></html>`;

async function mount(browser, viewport){
  const page = await browser.newPage({ viewport });
  await page.route(`${ORIGIN}/**`, (route) => {
    const url = new URL(route.request().url());
    if (url.pathname === '/') return route.fulfill({ contentType:'text/html', body:PAGE });
    return route.fulfill({ contentType:'text/javascript', body:source(url.pathname.replace('/libraries/', '')) });
  });
  await page.goto(`${ORIGIN}/`, { waitUntil:'domcontentloaded' });
  await page.evaluate(() => { window.__handle = window.__invoicesApp.mount({ root:document.getElementById('root'), orgId:'org_1' }); });
  await page.waitForSelector('.inv-cards');
  await page.waitForSelector('[data-inv-setup]');
  return page;
}
const shown = (page, selector) => page.evaluate((s) => { const el = document.querySelector(s); return !!el && getComputedStyle(el).display !== 'none' && el.getBoundingClientRect().height > 0; }, selector);

test('desktop: title only, the view switch in the primary colour, New invoice and Set up payments', async () => {
  const browser = await chromium.launch({ executablePath:CHROME, headless:true });
  try {
    const page = await mount(browser, { width:1440, height:900 });
    assert.equal(await page.evaluate(() => document.querySelector('.inv-heading h1')?.textContent), 'Invoices');
    assert.equal(await page.locator('.inv-heading p, .inv-top p').count(), 0, 'no subtitle');
    assert.equal(await page.locator('[data-inv-refresh]').count(), 0, 'no Refresh button');
    assert.deepEqual(await page.evaluate(() => [...document.querySelectorAll('.inv-top .inv-switch [data-inv-view]')].map((b) => b.dataset.invView)), ['outstanding', 'needs_invoicing', 'history'], 'the switch sits in the header');
    const active = await page.evaluate(() => { const s = getComputedStyle(document.querySelector('.inv-switch button.active')); return [s.backgroundColor, s.color]; });
    assert.equal(active[0], 'rgba(217, 48, 37, 0.1)', 'the chosen view is tinted with the primary colour, not black');
    assert.equal(active[1], 'rgb(217, 48, 37)');
    assert.equal(await page.evaluate(() => getComputedStyle(document.querySelector('.inv-chip.active')).backgroundColor), 'rgba(217, 48, 37, 0.1)', 'aging filter chips are not black either');
    assert.equal(await shown(page, '[data-inv-new]'), true);
    await page.click('[data-inv-setup]');
    assert.equal(await page.evaluate(() => window.__setup), 1, 'Set up payments opens the payment setup');
    await page.click('[data-inv-view="history"]');
    assert.equal(await page.evaluate(() => document.querySelector('.inv-switch button.active')?.dataset.invView), 'history');
  } finally {
    await browser.close();
  }
});

test('New invoice picks a project and opens its Generate invoice dialog through the route', async () => {
  const browser = await chromium.launch({ executablePath:CHROME, headless:true });
  try {
    const page = await mount(browser, { width:1440, height:900 });
    await page.click('[data-inv-new]');
    await page.waitForSelector('[data-inv-pick="project_a"]');
    assert.equal(await shown(page, '.inv-modal [data-inv-setup]'), true, 'the payment setup is offered while creating an invoice');
    await page.click('[data-inv-pick="project_a"]');
    assert.deepEqual(await page.evaluate(() => window.__nav), [{ project:'project_a', projectTab:'money', moneyView:'new_invoice' }]);
  } finally {
    await browser.close();
  }
});

test('payments set up, or no permission to set them up: no setup prompt', async () => {
  const browser = await chromium.launch({ executablePath:CHROME, headless:true });
  try {
    const page = await mount(browser, { width:1440, height:900 });
    await page.evaluate(() => { window.__readiness = { ready:true, reason:'' }; return window.__handle.refresh(); });
    await page.waitForFunction(() => !document.querySelector('[data-inv-setup]'));
    await page.evaluate(() => { window.__readiness = { ready:false, reason:'no_merchant_account' }; window.__perms.manage_company_settings = false; return window.__handle.refresh(); });
    await page.waitForTimeout(200);
    assert.equal(await page.locator('[data-inv-setup]').count(), 0);
  } finally {
    await browser.close();
  }
});

test('phone: no second header, one control row, the summary in one row, invoices as cards', async () => {
  const browser = await chromium.launch({ executablePath:CHROME, headless:true });
  try {
    const page = await mount(browser, { width:390, height:844 });
    assert.equal(await shown(page, '.inv-heading'), false, 'the portal top bar carries the title');
    const row = await page.evaluate(() => ['.inv-mobile-title', '.inv-switch', '[data-inv-new]'].map((s) => { const r = document.querySelector(s).getBoundingClientRect(); return Math.round(r.top + r.height / 2); }));
    assert.ok(Math.max(...row) - Math.min(...row) <= 2, `one control row ${row}`);
    const tops = await page.evaluate(() => [...document.querySelectorAll('.inv-card')].map((c) => Math.round(c.getBoundingClientRect().top)));
    assert.equal(tops.length, 5);
    assert.equal(new Set(tops).size, 1, 'the five summary cards are one row');
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth), 390, 'nothing widens the page');
    assert.equal(await page.evaluate(() => getComputedStyle(document.querySelector('.inv-table thead')).display), 'none');
    assert.equal(await page.evaluate(() => getComputedStyle(document.querySelector('tr[data-invoice]')).display), 'grid', 'each invoice is a card');
  } finally {
    await browser.close();
  }
});

test('the Finance tab opens Generate invoice for moneyView=new_invoice, carried into project windows', () => {
  const money = source('apps/money/project.js');
  assert.match(money, /view === 'new_invoice'[\s\S]{0,200}openModal\(\{ type:'invoice' \}\)/);
  assert.match(source('apps/firstmate-apps-manifest.js'), /moneyView:\{[^}]*'new_invoice'/);
  assert.match(source('window-manager/project-windows.js'), /PROJECT_SCOPED_ROUTE_KEYS=\[[^\]]*'moneyView'/);
});
