// GP-150: the registration's Number step shows that numbers are being fetched. While the draft saves and the provider
// search runs, the results show a spinner and placeholder cards at once, without taking focus or the caret from the
// area code field; the found numbers replace them. Runs the real workflow (setup-wizard.js + sms-registration.js) in
// Chromium against stubbed messaging endpoints, with the number search held open.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';

const { chromium } = createRequire(new URL('../public/v1/package.json', import.meta.url))('playwright-core');
const CHROME = process.env.CHROME_PATH || 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const lib = (path) => readFileSync(new URL(`../public/libraries/${path}`, import.meta.url), 'utf8');
const ORIGIN = 'https://fm.test';
const NUMBERS = ['+12062041000', '+12062371137', '+12062681274'].map((phone_number) => ({ phone_number, locality: 'Seattle', region: 'US' }));

const state = (page) => page.evaluate(() => ({
  loading: !!document.querySelector('.sms-number-search.is-loading'),
  skeletons: document.querySelectorAll('.sms-number-skeleton').length,
  spinner: !!document.querySelector('[data-sms-number-results] [role=status] .fa-spinner'),
  options: document.querySelectorAll('[data-sms-choose-number]').length,
  busy: document.querySelector('#sms-number-search')?.getAttribute('aria-busy') || null,
  focused: document.activeElement?.id || '',
  caret: document.querySelector('#sms-number-search')?.selectionStart
}));

test('the Number step shows a fetching state while numbers load', async () => {
  const browser = await chromium.launch({ executablePath: CHROME, headless: true });
  try {
    const page = await browser.newPage({ viewport: { width: 1200, height: 900 } });
    let profile = null, searches = 0;
    const held = [];
    await page.route(`${ORIGIN}/**`, async (route) => {
      const request = route.request(), url = new URL(request.url()), method = request.method();
      if (url.pathname === '/') return route.fulfill({ contentType: 'text/html', body: '<!doctype html><html><head></head><body></body></html>' });
      if (url.pathname.endsWith('/sms/setup')) return route.fulfill({ json: { profiles: [], telnyx: {} } });
      if (url.pathname.endsWith('/available-numbers')) {
        searches += 1;
        return held.push(() => route.fulfill({ json: { numbers: NUMBERS } }));
      }
      if (/\/sms\/compliance-profiles(\/[^/]+)?$/.test(url.pathname) && method !== 'GET') {
        profile = { ...(profile || {}), ...JSON.parse(request.postData() || '{}'), id: 'sms_profile_test' };
        return route.fulfill({ status: method === 'POST' ? 201 : 200, json: { profile } });
      }
      return route.fulfill({ json: {} });
    });
    await page.goto(`${ORIGIN}/`);
    await page.addScriptTag({ content: lib('setup-wizard/setup-wizard.js') });
    await page.addScriptTag({ content: lib('apps/settings/sms-registration.js') });
    await page.evaluate(() => { window.FirstMateSmsRegistration.open({ orgId: 'org_test' }); });
    const wizard = page.locator('[data-fm-wizard="sms-workflow"]');
    await wizard.locator('[data-fm-step="number"]').click();
    const field = wizard.locator('#sms-number-search');
    await field.click();
    await field.pressSequentially('206', { delay: 30 });

    let now = await state(page);
    assert.equal(now.loading, true, 'typing an area code shows the fetching state at once, before the search starts');
    assert.equal(now.skeletons, 4);
    assert.equal(now.spinner, true);
    assert.equal(now.busy, 'true');
    assert.deepEqual([now.focused, now.caret], ['sms-number-search', 3], 'the field keeps focus and the caret');

    for (let waited = 0; !held.length; waited += 50) {
      assert.ok(waited < 5000, 'the number search starts after the draft is saved');
      await page.waitForTimeout(50);
    }
    now = await state(page);
    assert.equal(now.loading, true, 'still fetching while the provider search is open');
    assert.equal(now.options, 0);

    held.shift()();
    await wizard.locator('[data-sms-choose-number]').first().waitFor();
    now = await state(page);
    assert.deepEqual({ loading: now.loading, skeletons: now.skeletons, spinner: now.spinner, options: now.options, busy: now.busy }, { loading: false, skeletons: 0, spinner: false, options: 3, busy: null });
    assert.equal(searches, 1);
  } finally {
    await browser.close();
  }
});
