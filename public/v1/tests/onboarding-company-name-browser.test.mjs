// 1M8-246: signup asks for neither the person's name nor the company's, so every account created since the
// October 20 release kept the "Your Company" placeholder. Chrome runs the real onboarding wizard: its welcome page
// asks for both while they are unsaved, nothing leaves the page without them, and they are saved through the same
// org_update_my action Company Settings uses. An account that already has both sees them as before.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { chromium } from 'playwright-core';

const wizard = await readFile(new URL('../../libraries/apps/onboarding/wizard.js', import.meta.url), 'utf8');
const banners = await readFile(new URL('../../libraries/platform-banners/platform-banners.js', import.meta.url), 'utf8');

async function onboarding(browser, app) {
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.route('https://portal.test/**', route => route.fulfill({ contentType: 'text/html', body: '<!doctype html><html><body></body></html>' }));
  await page.goto('https://portal.test/portal/');
  await page.evaluate((app) => {
    window.__APP = { userEmail: 'owner@example.test', userOrgId: 'org_new', showOnboarding: true, ...app };
    window.calls = [];
    window.toasts = [];
    window.Portal = {
      cfg: window.__APP,
      util: {
        $: (sel, root = document) => root.querySelector(sel),
        escapeHtml: v => String(v ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])),
        injectCSS: (key, css) => { const s = document.createElement('style'); s.textContent = css; document.head.append(s); },
        postAction: async (action, payload = {}) => {
          window.calls.push({ action, payload });
          if (action === 'org_get_my') return { data: { success: true, org: { name: window.__APP.orgName || 'Your Company' } } };
          if (action === 'pj_search') return { data: { success: true, results: [] } };
          return { data: { success: true } };
        }
      },
      ui: { showToast: (title, body) => window.toasts.push(`${title}: ${body}`) }
    };
    window.PlatformAPI = { request: async () => ({ organization: { name: window.__APP.orgName || 'Your Company' } }) };
  }, app);
  await page.addScriptTag({ content: wizard });
  await page.locator('#obOverlay').waitFor({ timeout: 5000 });
  return { page, errors };
}

const updates = page => page.evaluate(() => window.calls.filter(call => call.action === 'org_update_my').map(call => call.payload));
const currentPage = page => page.evaluate(() => window.Portal.modules.onboarding_wizard.currentPage());

// Skip walks the welcome page to its end (website → logo → preview → continue).
async function skipToEnd(page) {
  for (let i = 0; i < 4 && await currentPage(page) === 0; i += 1) {
    await page.locator('#obSkip0').click();
    await page.waitForTimeout(150);
  }
}

test('1M8-246: the welcome page offers name and company, both optional (Jack, 2026-11-03)', async () => {
  const browser = await chromium.launch({ channel: 'chrome', headless: true });
  try {
    // Left empty: the page continues and saves no name.
    let { page, errors } = await onboarding(browser, { orgName: 'Your Company', userName: '' });
    let company = page.locator('#obCompanyName');
    let name = page.locator('#obFullName');
    assert.equal(await company.isVisible(), true);
    assert.equal(await name.isVisible(), true);
    assert.equal(await company.inputValue(), '', 'the placeholder is never offered as the name');
    assert.doesNotMatch(await page.locator('#obPage0').innerText(), /Your Company/);
    await skipToEnd(page);
    assert.notEqual(await currentPage(page), 0, 'empty names never block the welcome page');
    assert.deepEqual((await updates(page)).filter(p => 'name' in p || 'full_name' in p), []);
    assert.deepEqual(await page.evaluate(() => window.toasts), []);
    assert.deepEqual(errors, []);
    await page.close();

    // Only one given, and "your company" typed back is still the placeholder: only the real name is saved.
    ({ page, errors } = await onboarding(browser, { orgName: 'Your Company', userName: '' }));
    await page.locator('#obFullName').fill('Dana Reyes');
    await page.locator('#obCompanyName').fill('your company');
    await skipToEnd(page);
    assert.notEqual(await currentPage(page), 0);
    let saved = (await updates(page)).filter(p => 'name' in p || 'full_name' in p);
    assert.deepEqual(saved.map(p => [p.name, p.full_name]), [[undefined, 'Dana Reyes']]);
    await page.close();

    // Both given: both saved as typed.
    ({ page, errors } = await onboarding(browser, { orgName: 'Your Company', userName: '' }));
    company = page.locator('#obCompanyName');
    name = page.locator('#obFullName');
    await name.fill('Dana Reyes');
    await company.fill('  Reyes Roofing LLC ');
    assert.deepEqual(await page.locator('.ob-prev-orgname').allInnerTexts(), ['Reyes Roofing LLC'], 'the sample report shows the name as typed');
    await skipToEnd(page);
    assert.notEqual(await currentPage(page), 0);
    saved = (await updates(page)).filter(p => 'name' in p);
    assert.equal(saved.length, 1, JSON.stringify(await updates(page)));
    assert.equal(saved[0].name, 'Reyes Roofing LLC');
    assert.equal(saved[0].full_name, 'Dana Reyes');
    assert.equal(await page.evaluate(() => window.__APP.orgName), 'Reyes Roofing LLC');
    // The team page lists the owner by the name just given.
    assert.equal(await page.locator('.ob-user-name').first().innerText(), 'Dana Reyes');
    assert.deepEqual(errors, []);
  } finally { await browser.close(); }
});

test('1M8-246: only what is missing is asked; an account with both keeps the welcome names', async () => {
  const browser = await chromium.launch({ channel: 'chrome', headless: true });
  try {
    let { page } = await onboarding(browser, { orgName: 'Reyes Roofing LLC', userName: '' });
    assert.equal(await page.locator('#obCompanyName').count(), 0);
    assert.equal(await page.locator('#obFullName').count(), 1);
    await page.close();

    ({ page } = await onboarding(browser, { orgName: 'Reyes Roofing LLC', userName: 'Dana Reyes' }));
    assert.equal(await page.locator('#obCompanyName').count(), 0);
    assert.equal(await page.locator('#obFullName').count(), 0);
    assert.equal(await page.locator('.ob-welcome-names .ob-name-org').innerText(), 'Reyes Roofing LLC');
    assert.equal(await page.locator('.ob-welcome-names .ob-name-user').innerText(), 'Dana Reyes');
    await skipToEnd(page);
    assert.notEqual(await currentPage(page), 0);
    assert.deepEqual((await updates(page)).filter(p => 'name' in p || 'full_name' in p), [], 'a saved name is never rewritten');
  } finally { await browser.close(); }
});

// Ben, November 3: "Add your company name" showed for a moment after setting up a new account. The attention feed is
// read at page load, while the organization still has the signup placeholder; the wizard then saved the name, but
// nothing re-read the feed, so a wizard finished within one 10 s poll uncovered the stale bar. The real wizard and the
// real banner library run against a feed that, like the server, lists the entry only while the name is a placeholder.
test('a new account that names its company in onboarding never uncovers the company name banner', async () => {
  const browser = await chromium.launch({ channel: 'chrome', headless: true });
  try {
    const { page, errors } = await onboarding(browser, { orgName: 'Your Company', userName: '' });
    await page.evaluate(() => {
      window.Portal.cfg.userOrgId = 'org_new';
      window.feedReads = [];
      // One pending read per call; tests release them in any order.
      window.PlatformAPI.attention = {
        list: () => new Promise((resolve) => {
          const placeholder = /^(your company)?$/i.test(String(window.__APP.orgName || '').trim());
          const entries = placeholder ? [{ id: 'attention_company_name_missing', priority: 110, title: 'Add your company name', body: 'Documents, emails and the portal show a placeholder instead of your company name.', cta_label: 'Add company name', tone: 'orange', state: 'active', visible_surfaces: ['topbar', 'notification'], user_state: {} }] : [];
          window.feedReads.push(() => resolve({ ok: true, entries }));
        })
      };
      const save = window.Portal.util.postAction;
      window.Portal.util.postAction = async (action, payload = {}) => {
        if (action === 'org_update_my' && payload.name) window.__APP.orgName = payload.name;
        return save(action, payload);
      };
    });
    await page.addScriptTag({ content: banners });
    const releaseReads = () => page.evaluate(() => { const reads = window.feedReads.splice(0); reads.forEach((release) => release()); return reads.length; });
    const topbar = () => page.locator('#fmAttentionTopbar').count();
    // The feed read at page load lists the banner, hidden behind the wizard.
    await page.waitForFunction(() => window.feedReads.length === 1);
    await releaseReads();
    assert.equal(await topbar(), 1);

    // A poll is in flight with the placeholder when the name is saved; it answers after the refresh the save triggers.
    await page.evaluate(() => { window.PlatformBanners.load('org_new'); });
    const pendingPoll = await page.evaluate(() => window.feedReads.length);
    await page.locator('#obFullName').fill('Dana Reyes');
    await page.locator('#obCompanyName').fill('Reyes Roofing LLC');
    await skipToEnd(page);
    await page.waitForFunction((n) => window.feedReads.length > n, pendingPoll);
    await page.evaluate(() => window.feedReads.pop()());
    await page.waitForFunction(() => !document.getElementById('fmAttentionTopbar'));
    await releaseReads();
    assert.equal(await topbar(), 0, 'the older poll must not put the banner back');

    // Finish at once, inside one poll: the dashboard shows without the banner.
    await page.locator('#obSkip1').click();
    await page.locator('#obSkip2').click();
    await page.locator('#obOverlay').waitFor({ state: 'detached', timeout: 5000 });
    assert.equal(await topbar(), 0);
    assert.deepEqual(errors, []);
  } finally { await browser.close(); }
});

test('an organization that really has no company name still gets the banner', async () => {
  const browser = await chromium.launch({ channel: 'chrome', headless: true });
  try {
    const page = await browser.newPage();
    await page.route('https://portal.test/**', route => route.fulfill({ contentType: 'text/html', body: '<!doctype html><html><body></body></html>' }));
    await page.goto('https://portal.test/portal/');
    await page.evaluate(() => {
      window.Portal = { cfg: { userOrgId: 'org_old' } };
      window.PlatformAPI = { attention: { list: async () => ({ ok: true, entries: [{ id: 'attention_company_name_missing', priority: 110, title: 'Add your company name', tone: 'orange', state: 'active', visible_surfaces: ['topbar'], user_state: {} }] }) } };
    });
    await page.addScriptTag({ content: banners });
    await page.locator('#fmAttentionTopbar').waitFor({ timeout: 5000 });
    assert.match(await page.locator('#fmAttentionTopbar').innerText(), /Add your company name/);
  } finally { await browser.close(); }
});
