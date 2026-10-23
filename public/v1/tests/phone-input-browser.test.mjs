import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {chromium} from 'playwright-core';

/* 1M8-240: the calling-code picker offers only the countries the platform operates in, in a styled list; the number is
   shown in the chosen country's national format as it is typed (Ben: United Kingdom 020 7946 0123, Sweden 070-123 45 67)
   and saved as E.164. No "Saved as" line. */
const libraries = new URL('../../libraries/', import.meta.url);
const COUNTRIES = [
  { code: 'GB', name: 'United Kingdom', calling_code: '44' },
  { code: 'US', name: 'United States', calling_code: '1' },
  { code: 'CA', name: 'Canada', calling_code: '1' },
  { code: 'SE', name: 'Sweden', calling_code: '46' },
  { code: 'FR', name: 'France', calling_code: '33' }
];

async function withPage(run) {
  const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH || 'C:/Program Files/Google/Chrome/Application/chrome.exe', headless: true });
  try {
    const page = await browser.newPage();
    const errors = []; page.on('pageerror', (error) => errors.push(error.message));
    await page.route('http://phone.test/**', async (route) => {
      const url = new URL(route.request().url());
      if (url.pathname.startsWith('/libraries/')) return route.fulfill({ contentType: 'application/javascript', body: await readFile(new URL(url.pathname.slice('/libraries/'.length), libraries)) });
      if (url.pathname === '/v1/platform/auth/signup-options') return route.fulfill({ contentType: 'application/json', body: JSON.stringify({ ok: true, country: 'GB', countries: [...COUNTRIES, { code: 'AU', name: 'Australia', calling_code: '61' }], phone_countries: COUNTRIES, languages: [{ code: 'en-GB', label: 'English (UK)' }] }) });
      return route.fulfill({ contentType: 'text/html', body: '<!doctype html><style>input{height:42px;border:1px solid #ccc;border-radius:10px;padding:0 10px}</style><form id="f"><div class="form-group"><input name="phone" id="phone"></div></form>' });
    });
    await page.goto('http://phone.test/');
    await run(page);
    assert.deepEqual(errors, []);
  } finally { await browser.close(); }
}

const attach = (page, country = 'GB') => page.evaluate(([countries, code]) => { window.phone = FirstMatePhoneInput.attach({ input: document.getElementById('phone'), countries, country: code }); return window.phone.ready; }, [COUNTRIES, country]);

test('the number takes the national format of the chosen country as it is typed, with no "Saved as" line', async () => {
  await withPage(async (page) => {
    await page.addScriptTag({ url: 'http://phone.test/libraries/phone-input/phone-input.js' });
    await attach(page, 'GB');
    const input = page.locator('#phone');
    await input.pressSequentially('02079460123');
    assert.equal(await input.inputValue(), '020 7946 0123', 'United Kingdom, as Ben wrote it');
    assert.equal(await page.evaluate(() => window.phone.e164()), '+442079460123');
    assert.equal(await page.locator('.fm-phone-preview').count(), 0);
    assert.doesNotMatch(await page.locator('body').innerText(), /Saved as/);

    // Sweden through the styled list.
    await input.fill('');
    await page.locator('.fm-phone-cc-trigger').click();
    await page.locator('.fm-phone-cc-option[data-code="SE"]').click();
    assert.equal((await page.locator('.fm-phone-cc-trigger').innerText()).replace(/\s+/g, ' '), 'SE +46');
    await input.pressSequentially('0701234567');
    assert.equal(await input.inputValue(), '070-123 45 67', 'Sweden, as Ben wrote it');
    assert.equal(await page.evaluate(() => window.phone.e164()), '+46701234567');
    assert.equal(await page.evaluate(() => window.phone.valid()), true);

    // US keeps its familiar format; changing the country reformats the digits typed so far.
    await page.locator('.fm-phone-cc-trigger').click();
    await page.locator('.fm-phone-cc-option[data-code="US"]').click();
    await input.fill(''); await input.pressSequentially('5555550123');
    assert.equal(await input.inputValue(), '(555) 555-0123');
    assert.equal(await page.evaluate(() => window.phone.e164()), '+15555550123');
    // A short number is not valid.
    await input.fill(''); await input.pressSequentially('555');
    assert.equal(await page.evaluate(() => window.phone.valid()), false);
    // Typing + and a calling code picks that country.
    await input.fill(''); await input.pressSequentially('+33123456789');
    assert.equal(await page.evaluate(() => window.phone.country()), 'FR');
    assert.equal(await page.evaluate(() => window.phone.e164()), '+33123456789');
    // Backspace over the formatting is not undone.
    await page.evaluate(() => window.phone.setCountry('US'));
    await input.fill(''); await input.pressSequentially('5555550123'); await input.press('Backspace');
    assert.equal((await input.inputValue()).replace(/\D/g, ''), '555555012');
  });
});

test('the picker is a styled list of the offered countries, usable from the keyboard, and the native select keeps the value', async () => {
  await withPage(async (page) => {
    await page.addScriptTag({ url: 'http://phone.test/libraries/phone-input/phone-input.js' });
    await attach(page, 'GB');
    assert.equal(await page.locator('select').evaluate((s) => getComputedStyle(s).display), 'none');
    const trigger = page.locator('.fm-phone-cc-trigger');
    assert.equal(await trigger.getAttribute('aria-haspopup'), 'listbox');
    assert.equal(Math.round((await trigger.boundingBox()).height), Math.round((await page.locator('#phone').boundingBox()).height), 'as tall as the phone field');
    await trigger.click();
    const menu = page.locator('[role="listbox"]');
    assert.equal(await menu.isVisible(), true);
    assert.deepEqual(await menu.locator('[role="option"]').evaluateAll((o) => o.map((x) => x.innerText.replace(/\s+/g, ' ').trim())), ['GB United Kingdom +44', 'US United States +1', 'CA Canada +1', 'SE Sweden +46', 'FR France +33']);
    assert.equal(await menu.locator('[aria-selected="true"]').getAttribute('data-code'), 'GB');
    const card = await menu.evaluate((m) => { const s = getComputedStyle(m); return [s.borderRadius, s.backgroundColor, s.boxShadow !== 'none']; });
    assert.deepEqual(card, ['12px', 'rgb(255, 255, 255)', true]);
    await page.keyboard.press('ArrowDown'); await page.keyboard.press('ArrowDown'); await page.keyboard.press('Enter');
    assert.equal(await menu.isVisible(), false);
    assert.equal(await page.locator('select').inputValue(), 'CA');
    await trigger.press('Enter'); await page.keyboard.type('sw'); await page.keyboard.press('Enter');
    assert.equal(await page.locator('select').inputValue(), 'SE', 'type-ahead by name');
    await trigger.click(); await page.keyboard.press('Escape');
    assert.equal(await menu.isVisible(), false);
  });
});

test('saved numbers still display and save: a stored +1 number and a bare US number', async () => {
  await withPage(async (page) => {
    await page.addScriptTag({ url: 'http://phone.test/libraries/phone-input/phone-input.js' });
    await page.locator('#phone').fill('+15555550123');
    await attach(page, 'GB');
    assert.equal(await page.evaluate(() => window.phone.country()), 'US');
    assert.equal(await page.locator('#phone').inputValue(), '(555) 555-0123');
    assert.equal(await page.evaluate(() => window.phone.e164()), '+15555550123');
    await page.evaluate(() => document.querySelectorAll('.fm-phone-cc, select').forEach((e) => e.remove()));
    await page.locator('#phone').fill('5555550123');
    await attach(page, 'US');
    assert.equal(await page.locator('#phone').inputValue(), '(555) 555-0123');
    assert.equal(await page.evaluate(() => window.phone.e164()), '+15555550123');
    // A stored number from a country not offered keeps its international format and value.
    await page.evaluate(() => document.querySelectorAll('.fm-phone-cc, select').forEach((e) => e.remove()));
    await page.locator('#phone').fill('+61212345678');
    await attach(page, 'GB');
    assert.equal(await page.locator('#phone').inputValue(), '+61 2 1234 5678');
    assert.equal(await page.evaluate(() => window.phone.e164()), '+61212345678');
  });
});

test('the signup form offers only the operating countries and submits E.164', async () => {
  await withPage(async (page) => {
    await page.addScriptTag({ url: 'http://phone.test/libraries/signup-region/signup-region.js' });
    await page.evaluate(() => { window.region = FirstMateSignupRegion.mount({ form: document.getElementById('f'), phoneInput: document.getElementById('phone'), apiBase: 'http://phone.test/v1/platform' }); return window.region.ready; });
    await page.waitForFunction(() => !!document.querySelector('.fm-phone-cc-trigger'));
    assert.deepEqual(await page.locator('select[name="phone_country"] option').evaluateAll((o) => o.map((x) => x.value)), ['GB', 'US', 'CA', 'SE', 'FR'], 'Australia is an account country, not a calling code');
    assert.equal((await page.locator('.fm-phone-cc-trigger').innerText()).replace(/\s+/g, ' '), 'GB +44');
    await page.locator('#phone').pressSequentially('07700900123');
    assert.equal(await page.locator('#phone').inputValue(), '07700 900123');
    assert.equal(await page.evaluate(() => window.region.phone()), '+447700900123');
    assert.equal(await page.evaluate(() => window.region.valid()), true);
    assert.equal(await page.evaluate(() => window.region.formatsAsNorthAmerican()), false, 'the host forms leave formatting to the picker');
  });
});
