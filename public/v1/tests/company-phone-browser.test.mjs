import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {chromium} from 'playwright-core';

/* FM-576: Settings › Company information's Company phone is typed as at signup (1M8-240): a calling-code picker that
   starts at the organization's country, the number in that country's national format and its example number as the
   placeholder. A Swiss company's phone was US-formatted ((555) 123-4567) whatever its country. This runs the Company
   phone helpers from settings/company.js against the shared phone input. */
const libraries = new URL('../../libraries/', import.meta.url);
const COMPANY = await readFile(new URL('apps/settings/company.js', libraries), 'utf8');
const HELPERS = COMPANY.slice(COMPANY.indexOf('/* FM-576: the company phone'), COMPANY.indexOf('function renderCompany('));
const COUNTRIES = [
  { code: 'US', name: 'United States', calling_code: '1' },
  { code: 'CA', name: 'Canada', calling_code: '1' },
  { code: 'GB', name: 'United Kingdom', calling_code: '44' },
  { code: 'DE', name: 'Germany', calling_code: '49' },
  { code: 'CH', name: 'Switzerland', calling_code: '41' }
];

async function withSettings(run, { country, detected = 'US', phone = '' }) {
  const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH || 'C:/Program Files/Google/Chrome/Application/chrome.exe', headless: true });
  try {
    const page = await browser.newPage();
    const errors = []; page.on('pageerror', (error) => errors.push(error.message));
    await page.route('http://settings.test/**', async (route) => {
      const url = new URL(route.request().url());
      if (url.pathname.startsWith('/libraries/')) return route.fulfill({ contentType: url.pathname.endsWith('.json') ? 'application/json' : 'application/javascript', body: await readFile(new URL(url.pathname.slice('/libraries/'.length), libraries)) });
      // Signup's calling codes: the operating countries plus the detected one (commerce/signup-options.ts).
      if (url.pathname === '/v1/platform/auth/signup-options') return route.fulfill({ contentType: 'application/json', body: JSON.stringify({ ok: true, country: detected, countries: [...COUNTRIES, { code: 'AT', name: 'Austria', calling_code: '43' }], phone_countries: COUNTRIES.filter((entry) => entry.code !== 'CH' || detected === 'CH') }) });
      return route.fulfill({ contentType: 'text/html', body: '<!doctype html><div id="pane"><label class="cs-field company-contact-phone" for="csCompanyPhone"><span>Company phone</span><input id="csCompanyPhone" inputmode="tel" autocomplete="tel"></label></div>' });
    });
    await page.goto('http://settings.test/');
    await page.evaluate(([helpers, org]) => {
      const state = { id: 'org_1', country: org.country, company_phone: org.phone };
      const input = document.getElementById('csCompanyPhone');
      // eslint-disable-next-line no-new-func
      window.settings = new Function('state', `${helpers}; return { attachCompanyPhone, showCompanyPhone, companyPhoneValue };`)(state);
      window.settings.state = state;
      window.settings.showCompanyPhone(input, state.company_phone);
      window.settings.attachCompanyPhone(input);
      return input.__fmPhoneStart.then(() => input.__fmPhone?.ready);
    }, [HELPERS, { country, phone }]);
    await page.waitForFunction(() => document.getElementById('csCompanyPhone').placeholder);
    await run(page);
    assert.deepEqual(errors, []);
  } finally { await browser.close(); }
}

const input = (page) => page.locator('#csCompanyPhone');
const saved = (page) => page.evaluate(() => window.settings.companyPhoneValue(document.getElementById('csCompanyPhone')));
const pick = async (page, value) => { await page.locator('.fm-select-list-trigger').click(); await page.locator(`[role="option"][data-value="${value}"]`).click(); };

test('a Swiss company types its phone in Swiss format, from Switzerland or anywhere else', async () => {
  for (const detected of ['CH', 'US']) {
    await withSettings(async (page) => {
      assert.equal((await page.locator('.fm-select-list-trigger').innerText()).replace(/\s+/g, ' '), 'CH +41');
      assert.equal(await input(page).getAttribute('placeholder'), '078 123 45 67', 'a Swiss example, not (555) 123-4567');
      await input(page).pressSequentially('0781234567');
      assert.equal(await input(page).inputValue(), '078 123 45 67');
      assert.equal(await saved(page), '078 123 45 67', 'saved as the company prints it');
      assert.equal(await page.evaluate(() => window.settings.state.company_phone), '078 123 45 67');
    }, { country: 'CH', detected });
  }
});

test('a saved number shows in its country\'s format, and a number from another country is saved with its calling code', async () => {
  await withSettings(async (page) => {
    assert.equal(await input(page).inputValue(), '078 123 45 67', 'an earlier save as bare digits');
    await pick(page, 'DE');
    await input(page).fill('');
    await input(page).pressSequentially('030123456');
    assert.equal(await saved(page), '+49 30 123456', 'reads back as Germany');
    // A reload writes the saved number back.
    await page.evaluate(() => { const field = document.getElementById('csCompanyPhone'); field.blur(); window.settings.showCompanyPhone(field, '+49 30 123456'); });
    assert.equal(await page.locator('select').inputValue(), 'DE');
    assert.equal(await input(page).inputValue(), '030 123456');
    await page.evaluate(() => window.settings.showCompanyPhone(document.getElementById('csCompanyPhone'), '0441234567'));
    assert.equal(await page.locator('select').inputValue(), 'CH', 'a national number is the company\'s own country');
    assert.equal(await input(page).inputValue(), '044 123 45 67');
  }, { country: 'CH', phone: '0781234567' });
});

test('a US company keeps (555) 123-4567 and its saved numbers as they were', async () => {
  await withSettings(async (page) => {
    assert.equal((await page.locator('.fm-select-list-trigger').innerText()).replace(/\s+/g, ' '), 'US +1');
    assert.equal(await input(page).inputValue(), '(555) 123-4567');
    await input(page).fill('');
    await input(page).pressSequentially('2015550123');
    assert.equal(await saved(page), '(201) 555-0123');
  }, { country: 'US', detected: 'CH', phone: '(555) 123-4567' });
});
