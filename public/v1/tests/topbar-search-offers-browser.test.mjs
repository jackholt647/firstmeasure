// A top-bar search with no matching project offers, under No matches: Order a measurement report for what was
// typed, New project and New contact. Ordering asks Google; an answer that only completes the typed address
// (address-match.js) opens a project already there, or a new draft with the address filled in; anything else
// opens a new draft with the text typed and Google's suggestions open. Each offer needs its permission and
// feature switch, and nothing is saved by opening one. Google is stubbed.
import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { chromium } from 'playwright-core';

const publicRoot = path.resolve(import.meta.dirname, '..', '..');
const read = (relative) => readFile(path.join(publicRoot, relative), 'utf8');
const index = await read('portal/index.php');
const between = (text, start, end) => {
  const i = text.indexOf(start), j = text.indexOf(end, i);
  assert.ok(i >= 0 && j > i, `missing ${start}`);
  return text.slice(i, j);
};
const indexStyles = [...index.matchAll(/<style[^>]*>([\s\S]*?)<\/style>/g)].map((match) => match[1]).join('\n');
const mobileTopbar = between(index, '<div class="mobile-topbar">', '<!-- ====== SIDEBAR BACKDROP');
const desktopTopbar = between(index, '<div class="platform-topbar" id="platformTopbar">', '<div class="main-panels" id="mainPanels">');
const shots = process.env.TOPBAR_SEARCH_SCREENSHOTS || '';
const MOBILE_UA = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1';

const harness = (setup) => `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<style>${indexStyles}</style><style>html:root{--primary:#0f766e;--primary-rgb:15,118,110;--on-primary:#fff}body{margin:0;font-family:system-ui,sans-serif}</style></head><body>
${mobileTopbar}
<main class="main">${desktopTopbar}<div class="main-panels" id="mainPanels"><div class="fm-tabpanel active" style="height:900px">Content</div></div></main>
<script>
  window.setup = ${JSON.stringify(setup)};
  window.calls = { open:[], openProject:[], contact:[], geocode:[], search:[], saves:0 };
  window.__APP = { orgId:'org', userOrgId:'org', userId:'user' };
  const esc = (value) => String(value ?? '').replace(/[&<>"']/g, (c) => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' }[c]));
  const flags = { current: () => ({}), has: (group, flag) => group === 'platform' && flag === 'top_bar',
    value: (group, flag, fallback) => (group + '.' + flag) in setup.flags ? setup.flags[group + '.' + flag] : fallback, load: async () => ({}) };
  window.Portal = {
    cfg: window.__APP,
    util: { escapeHtml: esc, hasPerm: (key) => setup.perms.includes(key) },
    appFlags: flags,
    can: () => true,
    capabilities: { can: () => true },
    branchModules: { currentBranchId: () => 'default' },
    modules: {
      request: {
        open: (project, options) => { calls.open.push(options); },
        openProject: (project, options) => { calls.openProject.push({ id:project.id, options }); },
        hasReportOrder: (project) => project.measurement_project?.status === 'completed'
      },
      ...(setup.contacts ? { contacts: { open: (contact, options) => { calls.contact.push(contact); } } } : {})
    }
  };
  const projects = setup.projects || [];
  window.PlatformAPI = {
    appFlags: flags,
    actionItems: { list: async () => ({ items: [] }) },
    work: { configuration: async () => ({}) },
    request: async () => ({}),
    search: { projectsAndContacts: async (_org, options) => {
      calls.search.push(options.query);
      const needle = options.query.toLowerCase();
      return { results: projects.filter((project) => project.address.toLowerCase().includes(needle)).map((project) => ({ type:'project', id:project.id, project_id:project.id, title:project.title, subtitle:project.address })) };
    } },
    projects: { get: async (_org, id) => ({ document: { id, data: projects.find((project) => project.id === id) } }), save: async () => { calls.saves += 1; } }
  };
  window.FirstMateArtifactSearch = {
    TYPES: [{ id:'project', label:'Projects', singular:'Project', icon:'fa-folder' }, { id:'contact', label:'Contacts', singular:'Contact', icon:'fa-user' }],
    available() { return this.TYPES; }, type(id) { return this.TYPES.find((type) => type.id === id); },
    offered: () => true, loadOffered: async () => true, search: async () => []
  };
  // Google: the answers the test gives, by what was typed.
  window.google = { maps: {
    Geocoder: class { geocode(request, done){ calls.geocode.push(request.address); const answer = setup.geocode[request.address];
      setTimeout(() => answer ? done([{ formatted_address:answer, partial_match:false, geometry:{ location:{ lat:() => 39.74, lng:() => -104.99 } }, address_components:[{ long_name:'Denver', short_name:'Denver', types:['locality'] }] }], 'OK') : done([], 'ZERO_RESULTS'), 20); } }
  } };
</script>
<script src="/portal/scripts/topbar.js"></script>
</body></html>`;

const launch = () => chromium.launch({ executablePath: process.env.CHROME_PATH || 'C:/Program Files/Google/Chrome/Application/chrome.exe', headless: true });
const ALL_PERMS = ['order_reports', 'view_projects', 'manage_projects'];

async function openShell(browser, setup, { viewport = { width: 1600, height: 1000 }, mobile = false } = {}){
  const context = await browser.newContext({ viewport, ...(mobile ? { userAgent: MOBILE_UA, isMobile: true, hasTouch: true, deviceScaleFactor: 2 } : {}) });
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.route('https://shell.test/**', async (route) => {
    const url = new URL(route.request().url());
    if (url.pathname === '/') return route.fulfill({ contentType: 'text/html', body: harness({ perms: ALL_PERMS, flags: { 'platform.contacts': true }, contacts: true, geocode: {}, ...setup }) });
    const type = url.pathname.endsWith('.css') ? 'text/css' : 'application/javascript';
    return route.fulfill({ contentType: type, body: await read(url.pathname.slice(1)).catch(() => '') });
  });
  await page.goto('https://shell.test/');
  await page.waitForFunction(() => document.querySelector('.mobile-topbar')?.classList.contains('topbar-enabled') || document.getElementById('platformTopbar')?.offsetParent !== null);
  return { context, page, errors };
}

const searchInput = (mobile) => (mobile ? '#mobilePlatformGlobalSearch' : '#platformGlobalSearch');
const resultsBox = (mobile) => (mobile ? '#mobilePlatformSearchResults' : '#platformSearchResults');
async function typeSearch(page, text, mobile = false){
  await page.locator(searchInput(mobile)).fill(text);
  await page.waitForFunction(([box, typed]) => {
    const list = document.querySelector(`${box}.visible .ptb-search-result-list`);
    if (!list || /Searching/.test(list.textContent)) return false;
    const offer = list.querySelector('[data-search-offer]');
    return offer ? offer.textContent.includes(typed) : !!list.querySelector('.ptb-empty');
  }, [resultsBox(mobile), text]);
}
const offers = (page, mobile = false) => page.locator(`${resultsBox(mobile)} [data-search-offer]`).evaluateAll((rows) => rows.map((row) => [row.dataset.searchOffer, row.textContent.trim()]));
const shot = async (page, name) => { if (!shots) return; await mkdir(shots, { recursive: true }); await page.screenshot({ path: path.join(shots, `${name}.png`) }); };

test('no matches offers Order a measurement report, New project and New contact, in that order, reachable with the arrow keys', async () => {
  const browser = await launch();
  try {
    const { context, page, errors } = await openShell(browser, {});
    await typeSearch(page, '123 Main Street');
    assert.match(await page.locator('#platformSearchResults .ptb-search-offers-label').textContent(), /No matches/);
    assert.deepEqual(await offers(page), [
      ['report', 'Order a measurement report for "123 Main Street"'],
      ['project', 'New project for "123 Main Street"'],
      ['contact', 'New contact for "123 Main Street"']
    ]);
    await shot(page, 'offers-1600');
    await page.locator('#platformGlobalSearch').press('ArrowDown');
    assert.equal(await page.evaluate(() => document.activeElement?.dataset.searchOffer), 'report');
    await page.keyboard.press('ArrowDown');
    assert.equal(await page.evaluate(() => document.activeElement?.dataset.searchOffer), 'project');
    await page.keyboard.press('ArrowUp');
    await page.keyboard.press('ArrowUp');
    assert.equal(await page.evaluate(() => document.activeElement?.id), 'platformGlobalSearch', 'up from the first goes back to the box');
    await page.keyboard.press('ArrowDown');
    await page.keyboard.press('ArrowDown');
    await page.keyboard.press('Enter');
    await page.waitForFunction(() => calls.open.length === 1);
    assert.deepEqual(await page.evaluate(() => calls.open[0]), { workflow:'project', address:'123 Main Street' });
    assert.equal(await page.evaluate(() => calls.saves), 0);
    assert.deepEqual(errors, []);
    await context.close();
  } finally { await browser.close(); }
});

test('New contact opens an unsaved contact prefilled with the address, a name or an email', async () => {
  const browser = await launch();
  try {
    const { context, page } = await openShell(browser, {});
    for (const [text, expected] of [['123 Main Street', { address:'123 Main Street' }], ['Jane Doe', { name:'Jane Doe' }], ['jane@example.com', { email:'jane@example.com' }]]) {
      await typeSearch(page, text);
      await page.locator('[data-search-offer="contact"]').first().click();
      assert.deepEqual(await page.evaluate(() => calls.contact.at(-1)), expected);
    }
    assert.equal(await page.evaluate(() => calls.saves), 0);
    await context.close();
  } finally { await browser.close(); }
});

test('ordering an address Google only completes opens the order as a new draft with the address filled in', async () => {
  const browser = await launch();
  try {
    const { context, page, errors } = await openShell(browser, { geocode: { '123 Main Street': '123 Main St, Denver, CO 80202, USA' } });
    await typeSearch(page, '123 Main Street');
    await page.locator('[data-search-offer="report"]').click();
    await page.waitForFunction(() => calls.open.length === 1);
    const options = await page.evaluate(() => calls.open[0]);
    assert.equal(options.workflow, 'report');
    assert.equal(options.reportProject, 'new');
    assert.equal(options.address, '123 Main St, Denver, CO 80202, USA');
    assert.equal(options.resolvedAddress.formatted_address, '123 Main St, Denver, CO 80202, USA');
    assert.equal(options.resolvedAddress.lat, 39.74);
    assert.equal(options.addressSuggest, undefined);
    assert.deepEqual(await page.evaluate(() => calls.search), ['123 Main Street', '123 Main St'], 'the search, then a look for a project already at the address');
    assert.equal(await page.locator('#platformSearchResults').evaluate((box) => box.classList.contains('visible')), false);
    assert.deepEqual(errors, []);
    await context.close();
  } finally { await browser.close(); }
});

test('ordering an address with a project already there opens that project: on its order, or on Reports when it has a report', async () => {
  const browser = await launch();
  try {
    const projects = [
      { id:'p1', title:'Smith roof', address:'123 Main St, Denver, CO 80202, USA' },
      { id:'p2', title:'Jones roof', address:'9 Elm St, Denver, CO 80202, USA', measurement_project:{ status:'completed' } },
      { id:'p3', title:'Other town', address:'9 Elm St, Boulder, CO 80302, USA' }
    ];
    const { context, page } = await openShell(browser, { projects, geocode: {
      '123 Main Street Denver': '123 Main St, Denver, CO 80202, USA',
      '9 Elm Street, Denver': '9 Elm St, Denver, CO 80202, USA'
    } });
    // The typed text matches no project as written, so the offers show.
    await typeSearch(page, '123 Main Street Denver');
    await page.locator('[data-search-offer="report"]').click();
    await page.waitForFunction(() => calls.openProject.length === 1);
    assert.deepEqual(await page.evaluate(() => calls.openProject[0]), { id:'p1', options:{ workflow:'report', tab:'map', forceRefresh:true } });
    await typeSearch(page, '9 Elm Street, Denver');
    await page.locator('[data-search-offer="report"]').click();
    await page.waitForFunction(() => calls.openProject.length === 2);
    assert.deepEqual(await page.evaluate(() => calls.openProject[1]), { id:'p2', options:{ tab:'measurements' } });
    assert.equal(await page.evaluate(() => calls.open.length), 0, 'no new draft');
    await context.close();
  } finally { await browser.close(); }
});

test('ordering an address Google changes (Ave to St), or cannot find, opens a draft with the text typed and the suggestions open', async () => {
  const browser = await launch();
  try {
    const { context, page } = await openShell(browser, { geocode: { '123 Main Ave': '123 Main St, Denver, CO 80202, USA' } });
    for (const text of ['123 Main Ave', '77 Nowhere Rd']) {
      await typeSearch(page, text);
      await page.locator('[data-search-offer="report"]').click();
      await page.waitForFunction((count) => calls.open.length === count, text === '123 Main Ave' ? 1 : 2);
      assert.deepEqual(await page.evaluate(() => calls.open.at(-1)), { workflow:'report', reportProject:'new', address:text, addressSuggest:true });
    }
    assert.equal((await page.evaluate(() => calls.search)).includes('123 Main St'), false, 'no project lookup for an address that did not resolve cleanly');
    await context.close();
  } finally { await browser.close(); }
});

test('each offer needs its permission and feature switch', async () => {
  const browser = await launch();
  try {
    const cases = [
      [{ flags: { 'platform.contacts': true, 'firstmeasure.report_orders': false } }, ['project', 'contact']],
      [{ flags: { 'platform.contacts': false } }, ['report', 'project']],
      [{ perms: ['order_reports', 'view_projects'] }, ['report', 'project']],
      [{ contacts: false }, ['report', 'project']],
      [{ perms: ['view_projects', 'manage_projects'] }, ['contact']],
      [{ perms: [] }, []]
    ];
    for (const [setup, expected] of cases) {
      const { context, page } = await openShell(browser, setup);
      await typeSearch(page, '123 Main Street');
      assert.deepEqual((await offers(page)).map(([kind]) => kind), expected, JSON.stringify(setup));
      if (!expected.length) assert.match(await page.locator('#platformSearchResults .ptb-empty').textContent(), /No matches/);
      await context.close();
    }
  } finally { await browser.close(); }
});

test('phone: the offers are big tap targets in the search results', async () => {
  const browser = await launch();
  try {
    const { context, page, errors } = await openShell(browser, {}, { viewport: { width: 390, height: 844 }, mobile: true });
    await typeSearch(page, '123 Main Street', true);
    const rows = await page.locator('#mobilePlatformSearchResults [data-search-offer]').evaluateAll((items) => items.map((item) => { const r = item.getBoundingClientRect(); return { h:r.height, w:r.width }; }));
    assert.equal(rows.length, 3);
    for (const row of rows) assert.ok(row.h >= 48 && row.w >= 300, JSON.stringify(row));
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
    await shot(page, 'offers-390');
    await page.locator('#mobilePlatformSearchResults [data-search-offer="report"]').tap();
    await page.waitForFunction(() => calls.open.length === 1);
    assert.equal(await page.evaluate(() => calls.open[0].addressSuggest), true);
    assert.deepEqual(errors, []);
    await context.close();
  } finally { await browser.close(); }
});
