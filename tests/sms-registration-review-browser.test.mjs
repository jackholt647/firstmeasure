// GP-151: the registration's Review step. Its missing-field list is a failure message: it shows only after Submit
// Registration was pressed with something missing, never on arrival. The phone number is a narrow column (one heading,
// the number, "Add another number") beside Texting program. Runs the real workflow (setup-wizard.js +
// sms-registration.js) in Chromium against stubbed messaging endpoints; nothing is submitted.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';

const { chromium } = createRequire(new URL('../public/v1/package.json', import.meta.url))('playwright-core');
const CHROME = process.env.CHROME_PATH || 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const lib = (path) => readFileSync(new URL(`../public/libraries/${path}`, import.meta.url), 'utf8');
const ORIGIN = 'https://fm.test';
const PROFILE = {
  id: 'sms_profile_test',
  brand: { companyName: 'GP151 Roofing LLC', displayName: 'GP151 Roofing', website: 'https://example.com', firstName: 'Sandbox', lastName: 'Tester' },
  campaign: { selectedNumber: '+12062041000' },
  provider_refs: { mock_phone_number: '+12062041000' }
};

const review = (page) => page.evaluate(() => {
  const box = (selector) => { const rect = document.querySelector(selector)?.getBoundingClientRect(); return rect && { left: rect.left, right: rect.right, top: rect.top, width: rect.width }; };
  const number = document.querySelector('.sms-review-number');
  return {
    checklist: document.querySelector('[data-sms-summary-checklist]')?.textContent || null,
    stepErrors: document.querySelector('[data-sms-step-errors]')?.textContent || '',
    note: document.querySelector('[data-fm-note]')?.textContent || '',
    headings: [...(number?.querySelectorAll('h4, .sms-final-row span') || [])].map((el) => el.textContent.trim()),
    addInside: !!number?.querySelector('[data-sms-fix-step="number"]'),
    addElsewhere: document.querySelectorAll('.sms-workspace [data-sms-fix-step="number"]').length - (number?.querySelectorAll('[data-sms-fix-step="number"]').length || 0),
    number: box('.sms-review-number'),
    program: box('.sms-program')
  };
});

test('the Review step lists missing fields only after a failed submit, with the number beside the program', async () => {
  const browser = await chromium.launch({ executablePath: CHROME, headless: true });
  try {
    const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
    const submits = [];
    await page.route(`${ORIGIN}/**`, async (route) => {
      const request = route.request(), url = new URL(request.url()), method = request.method();
      if (url.pathname === '/') return route.fulfill({ contentType: 'text/html', body: '<!doctype html><html><head></head><body></body></html>' });
      if (url.pathname.endsWith('/sms/setup')) return route.fulfill({ json: { profiles: [PROFILE], telnyx: {} } });
      if (/submit-(brand|campaign)/.test(url.pathname)) { submits.push(url.pathname); return route.fulfill({ status: 500, json: {} }); }
      if (/\/sms\/compliance-profiles(\/[^/]+)?$/.test(url.pathname) && method !== 'GET') {
        return route.fulfill({ status: method === 'POST' ? 201 : 200, json: { profile: { ...PROFILE, ...JSON.parse(request.postData() || '{}'), id: PROFILE.id } } });
      }
      return route.fulfill({ json: {} });
    });
    await page.goto(`${ORIGIN}/`);
    await page.addScriptTag({ content: lib('setup-wizard/setup-wizard.js') });
    await page.addScriptTag({ content: lib('apps/settings/sms-registration.js') });
    await page.evaluate(() => { window.FirstMateSmsRegistration.open({ orgId: 'org_test' }); });
    const wizard = page.locator('[data-fm-wizard="sms-workflow"]');
    await wizard.locator('[data-fm-step="summary"]').click();
    await wizard.locator('#smsSubmitMock').waitFor();

    let now = await review(page);
    assert.equal(now.checklist, null, 'no missing-field message before Submit Registration is pressed');
    assert.equal(now.stepErrors, '');
    assert.doesNotMatch(now.note, /missing|finish/i, 'the footer does not list missing fields yet either');
    assert.deepEqual(now.headings, ['Phone number'], 'the number column has one heading, not a second "Phone number" label');
    assert.equal(now.addInside, true, '"Add another number" sits inside the number column');
    assert.equal(now.addElsewhere, 0);
    assert.ok(now.number.right <= now.program.left && Math.abs(now.number.top - now.program.top) < 1, 'number and Texting program share a row');
    assert.ok(now.number.width <= 260 && now.number.width < now.program.width / 2, `the number column is narrow (${now.number.width}px)`);

    await wizard.locator('#smsSubmitMock').click();
    await wizard.locator('[data-sms-summary-checklist]').waitFor();
    now = await review(page);
    assert.match(now.checklist, /missing field/, 'a failed submit lists what is missing');
    assert.match(now.checklist, /permission to text customers/);
    assert.equal(now.stepErrors, '', 'the list shows once, not again as step errors');
    assert.deepEqual(submits, [], 'nothing was submitted');

    await page.setViewportSize({ width: 600, height: 900 });
    now = await review(page);
    assert.ok(now.program.top > now.number.top, 'on a narrow screen Texting program goes under the number');
  } finally {
    await browser.close();
  }
});
