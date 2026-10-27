// 1M8-246: signup asks for neither the person's name nor the company's, so every account created since the
// October 20 release kept the "Your Company" placeholder. Chrome runs the real onboarding wizard: its welcome page
// asks for both while they are unsaved, nothing leaves the page without them, and they are saved through the same
// org_update_my action Company Settings uses. An account that already has both sees them as before.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { chromium } from 'playwright-core';

const wizard = await readFile(new URL('../../libraries/apps/onboarding/wizard.js', import.meta.url), 'utf8');

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

test('1M8-246: a new signup names itself and its company on the welcome page before anything else', async () => {
  const browser = await chromium.launch({ channel: 'chrome', headless: true });
  try {
    const { page, errors } = await onboarding(browser, { orgName: 'Your Company', userName: '' });
    const company = page.locator('#obCompanyName');
    const name = page.locator('#obFullName');
    assert.equal(await company.isVisible(), true);
    assert.equal(await name.isVisible(), true);
    assert.equal(await company.inputValue(), '', 'the placeholder is never offered as the name');
    assert.doesNotMatch(await page.locator('#obPage0').innerText(), /Your Company/);

    // Empty: the page refuses to continue, marks both and saves nothing.
    await skipToEnd(page);
    assert.equal(await currentPage(page), 0);
    assert.equal(await company.getAttribute('aria-invalid'), 'true');
    assert.equal(await name.getAttribute('aria-invalid'), 'true');
    assert.ok((await page.evaluate(() => window.toasts)).some(t => /name and company/i.test(t)));
    assert.deepEqual((await updates(page)).filter(p => 'name' in p || 'full_name' in p), []);

    // "Your Company" typed back in is still the placeholder.
    await name.fill('Dana Reyes');
    await company.fill('your company');
    await page.locator('#obSkip0').click();
    await page.waitForTimeout(150);
    assert.equal(await currentPage(page), 0);
    assert.equal(await company.getAttribute('aria-invalid'), 'true');
    assert.equal(await name.getAttribute('aria-invalid'), 'false');

    await company.fill('  Reyes Roofing LLC ');
    assert.deepEqual(await page.locator('.ob-prev-orgname').allInnerTexts(), ['Reyes Roofing LLC'], 'the sample report shows the name as typed');
    await skipToEnd(page);
    assert.notEqual(await currentPage(page), 0);
    const saved = (await updates(page)).filter(p => 'name' in p);
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
