import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {chromium} from 'playwright-core';

/* 1M8-240: the calling-code picker offers the served countries, formats the number for the chosen country as it is
   typed, previews the international number and saves E.164. */
const libraries = new URL('../../libraries/', import.meta.url);
const COUNTRIES = [
  { code: 'GB', name: 'United Kingdom', calling_code: '44', language: 'en-GB' },
  { code: 'US', name: 'United States', calling_code: '1', language: 'en-US' },
  { code: 'CA', name: 'Canada', calling_code: '1', language: 'en-CA' },
  { code: 'FR', name: 'France', calling_code: '33', language: 'fr-FR' }
];

async function withPage(run) {
  const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH || 'C:/Program Files/Google/Chrome/Application/chrome.exe', headless: true });
  try {
    const page = await browser.newPage();
    const errors = []; page.on('pageerror', (error) => errors.push(error.message));
    await page.route('http://phone.test/**', async (route) => {
      const url = new URL(route.request().url());
      if (url.pathname.startsWith('/libraries/')) return route.fulfill({ contentType: 'application/javascript', body: await readFile(new URL(url.pathname.slice('/libraries/'.length), libraries)) });
      if (url.pathname === '/v1/platform/auth/signup-options') return route.fulfill({ contentType: 'application/json', body: JSON.stringify({ ok: true, country: 'GB', countries: [...COUNTRIES, { code: 'JP', name: 'Japan', calling_code: '81', language: 'ja-JP' }], phone_countries: COUNTRIES, languages: [{ code: 'en-GB', label: 'English (UK)' }] }) });
      return route.fulfill({ contentType: 'text/html', body: '<!doctype html><form id="f"><div class="form-group"><input name="phone" id="phone"></div></form>' });
    });
    await page.goto('http://phone.test/');
    await run(page);
    assert.deepEqual(errors, []);
  } finally { await browser.close(); }
}

test('the phone input formats for the chosen country, previews the international number and saves E.164', async () => {
  await withPage(async (page) => {
    await page.addScriptTag({ url: 'http://phone.test/libraries/phone-input/phone-input.js' });
    await page.evaluate((countries) => { window.phone = FirstMatePhoneInput.attach({ input: document.getElementById('phone'), countries, country: 'GB' }); return window.phone.ready; }, COUNTRIES);
    assert.deepEqual(await page.locator('select').evaluate((s) => [...s.options].map((o) => o.textContent)), ['GB +44', 'US +1', 'CA +1', 'FR +33']);
    const input = page.locator('#phone');
    await input.pressSequentially('02079460958');
    assert.equal(await input.inputValue(), '020 7946 0958');
    assert.equal(await page.locator('.fm-phone-preview').innerText(), 'Saved as +44 20 7946 0958');
    assert.equal(await page.evaluate(() => window.phone.e164()), '+442079460958');
    assert.equal(await page.evaluate(() => window.phone.valid()), true);
    // A short number is not valid and says what is missing.
    await input.fill(''); await input.pressSequentially('0207');
    assert.equal(await page.evaluate(() => window.phone.valid()), false);
    assert.match(await page.locator('.fm-phone-preview').innerText(), /Enter the full number for United Kingdom \(\+44\)/);
    // US: the familiar format and +1.
    await page.locator('select').selectOption('US');
    await input.fill(''); await input.pressSequentially('5555550123');
    assert.equal(await input.inputValue(), '(555) 555-0123');
    assert.equal(await page.evaluate(() => window.phone.e164()), '+15555550123');
    assert.equal(await page.locator('.fm-phone-preview').innerText(), 'Saved as +1 555 555 0123');
    // Typing + and a calling code picks that country.
    await input.fill(''); await input.pressSequentially('+33123456789');
    assert.equal(await page.locator('select').inputValue(), 'FR');
    assert.equal(await page.evaluate(() => window.phone.e164()), '+33123456789');
    // Backspace over the formatting is not undone.
    await page.locator('select').selectOption('US');
    await input.fill(''); await input.pressSequentially('5555550123'); await input.press('Backspace');
    assert.equal((await input.inputValue()).replace(/\D/g, ''), '555555012');
  });
});

test('a saved US number without a country code still reads and saves as +1', async () => {
  await withPage(async (page) => {
    await page.addScriptTag({ url: 'http://phone.test/libraries/phone-input/phone-input.js' });
    await page.locator('#phone').fill('5555550123');
    await page.evaluate((countries) => { window.phone = FirstMatePhoneInput.attach({ input: document.getElementById('phone'), countries, country: 'US' }); return window.phone.ready; }, COUNTRIES);
    assert.equal(await page.evaluate(() => window.phone.e164()), '+15555550123');
    await page.locator('#phone').fill('+15555550123');
    await page.evaluate((countries) => { document.querySelectorAll('select, .fm-phone-preview').forEach((e) => e.remove()); window.phone = FirstMatePhoneInput.attach({ input: document.getElementById('phone'), countries, country: 'GB' }); return window.phone.ready; }, COUNTRIES);
    assert.equal(await page.locator('select').inputValue(), 'US', 'a stored +1 number selects its country');
    assert.equal(await page.locator('#phone').inputValue(), '(555) 555-0123');
  });
});

test('the signup picker offers only the served countries and submits E.164', async () => {
  await withPage(async (page) => {
    await page.addScriptTag({ url: 'http://phone.test/libraries/signup-region/signup-region.js' });
    await page.evaluate(() => { window.region = FirstMateSignupRegion.mount({ form: document.getElementById('f'), phoneInput: document.getElementById('phone'), apiBase: 'http://phone.test/v1/platform' }); return window.region.ready; });
    await page.waitForFunction(() => !!document.querySelector('.fm-phone-preview'));
    assert.deepEqual(await page.locator('select[name="phone_country"]').evaluate((s) => [...s.options].map((o) => o.value)), ['GB', 'US', 'CA', 'FR'], 'Japan is offered as a country, not as a calling code');
    assert.equal(await page.locator('select[name="phone_country"]').inputValue(), 'GB');
    await page.locator('#phone').pressSequentially('07700900123');
    assert.equal(await page.locator('#phone').inputValue(), '07700 900123');
    assert.equal(await page.evaluate(() => window.region.phone()), '+447700900123');
    assert.equal(await page.evaluate(() => window.region.valid()), true);
    assert.equal(await page.evaluate(() => window.region.formatsAsNorthAmerican()), false, 'the host forms leave formatting to the picker');
  });
});
