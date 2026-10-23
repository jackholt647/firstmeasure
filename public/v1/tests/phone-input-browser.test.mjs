import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {chromium} from 'playwright-core';

/* 1M8-240: the signup's calling code is a styled list of the operating countries (no country or language lists); the phone shows the chosen country's national format as it is typed (Ben: United Kingdom 020 7946 0123,
   Sweden 070-123 45 67), its placeholder is that country's example number, and it is saved as E.164. */
const libraries = new URL('../../libraries/', import.meta.url);
const COUNTRIES = [
  { code: 'GB', name: 'United Kingdom', calling_code: '44', language: 'en-GB' },
  { code: 'US', name: 'United States', calling_code: '1', language: 'en-US' },
  { code: 'CA', name: 'Canada', calling_code: '1', language: 'en-US' },
  { code: 'SE', name: 'Sweden', calling_code: '46', language: 'sv-SE' },
  { code: 'FR', name: 'France', calling_code: '33', language: 'fr-FR' }
];
const BY_NAME = [...COUNTRIES].sort((a, b) => a.name.localeCompare(b.name));
const LANGUAGES = [{ code: 'en-US', label: 'English (US)' }, { code: 'en-GB', label: 'English (UK)' }, { code: 'fr-FR', label: 'Français' }, { code: 'sv-SE', label: 'Svenska' }];

async function withPage(run, options = { country: 'GB' }) {
  const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH || 'C:/Program Files/Google/Chrome/Application/chrome.exe', headless: true });
  try {
    const page = await browser.newPage();
    const errors = []; page.on('pageerror', (error) => errors.push(error.message));
    await page.route('http://phone.test/**', async (route) => {
      const url = new URL(route.request().url());
      if (url.pathname.startsWith('/libraries/')) return route.fulfill({ contentType: url.pathname.endsWith('.json') ? 'application/json' : 'application/javascript', body: await readFile(new URL(url.pathname.slice('/libraries/'.length), libraries)) });
      if (url.pathname === '/v1/platform/auth/signup-options') return route.fulfill({ contentType: 'application/json', body: JSON.stringify({ ok: true, country: options.country, language: options.country === 'SE' ? 'sv-SE' : 'en-GB', countries: [...COUNTRIES, { code: 'AU', name: 'Australia', calling_code: '61', language: 'en-GB' }], operating_countries: BY_NAME, phone_countries: COUNTRIES, languages: LANGUAGES }) });
      return route.fulfill({ contentType: 'text/html', body: '<!doctype html><style>input,select{height:42px;border:1px solid #ccc;border-radius:10px;padding:0 10px;width:100%}</style><form id="f"><div class="form-group"><label>Phone</label><input name="phone" id="phone"></div></form>' });
    });
    await page.goto('http://phone.test/');
    await run(page);
    assert.deepEqual(errors, []);
  } finally { await browser.close(); }
}

const loadPhone = async (page) => {
  await page.addScriptTag({ url: 'http://phone.test/libraries/select-list/select-list.js' });
  await page.addScriptTag({ url: 'http://phone.test/libraries/phone-input/phone-input.js' });
};
const attach = (page, country = 'GB') => page.evaluate(([countries, code]) => { window.phone = FirstMatePhoneInput.attach({ input: document.getElementById('phone'), countries, country: code }); return window.phone.ready; }, [COUNTRIES, country]);
const trigger = (page) => page.locator('.fm-select-list.compact .fm-select-list-trigger');
const pick = async (page, scope, value) => { await page.locator(`${scope} .fm-select-list-trigger`).click(); await page.locator(`${scope} [role="option"][data-value="${value}"]`).click(); };

test('the number takes the national format of the chosen country, and the placeholder is that country\'s example', async () => {
  await withPage(async (page) => {
    await loadPhone(page); await attach(page, 'GB');
    const input = page.locator('#phone');
    assert.equal(await input.getAttribute('placeholder'), '07400 123456', 'a UK example, not (555) 555-0123');
    await input.pressSequentially('02079460123');
    assert.equal(await input.inputValue(), '020 7946 0123', 'United Kingdom, as Ben wrote it');
    assert.equal(await page.evaluate(() => window.phone.e164()), '+442079460123');
    // Digits beyond the longest UK number are not taken.
    await input.pressSequentially('9999');
    assert.equal(await input.inputValue(), '020 7946 0123');
    assert.doesNotMatch(await page.locator('body').innerText(), /Saved as/);

    await input.fill('');
    await pick(page, '.fm-select-list.compact', 'SE');
    assert.equal((await trigger(page).innerText()).replace(/\s+/g, ' '), 'SE +46');
    assert.equal(await input.getAttribute('placeholder'), '070-123 45 67', 'Sweden\'s example, as Ben wrote it');
    await input.pressSequentially('0701234567');
    assert.equal(await input.inputValue(), '070-123 45 67');
    assert.equal(await page.evaluate(() => window.phone.e164()), '+46701234567');

    await pick(page, '.fm-select-list.compact', 'US');
    assert.equal(await input.getAttribute('placeholder'), '(201) 555-0123');
    await input.fill(''); await input.pressSequentially('5555550123');
    assert.equal(await input.inputValue(), '(555) 555-0123');
    assert.equal(await page.evaluate(() => window.phone.e164()), '+15555550123');
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

test('the calling code is a styled list of the offered countries, usable from the keyboard', async () => {
  await withPage(async (page) => {
    await loadPhone(page); await attach(page, 'GB');
    assert.equal(await page.locator('select').evaluate((s) => getComputedStyle(s).display), 'none');
    assert.equal(Math.round((await trigger(page).boundingBox()).height), Math.round((await page.locator('#phone').boundingBox()).height), 'as tall as the phone field');
    await trigger(page).click();
    const menu = page.locator('.fm-select-list.compact [role="listbox"]');
    assert.deepEqual(await menu.locator('[role="option"]').evaluateAll((o) => o.map((x) => x.innerText.replace(/\s+/g, ' ').trim())), ['GB United Kingdom +44', 'US United States +1', 'CA Canada +1', 'SE Sweden +46', 'FR France +33']);
    assert.deepEqual(await menu.evaluate((m) => { const s = getComputedStyle(m); return [s.borderRadius, s.backgroundColor, s.boxShadow !== 'none']; }), ['12px', 'rgb(255, 255, 255)', true]);
    await page.keyboard.press('ArrowDown'); await page.keyboard.press('ArrowDown'); await page.keyboard.press('Enter');
    assert.equal(await page.locator('select').inputValue(), 'CA');
    await trigger(page).press('Enter'); await page.keyboard.type('sw'); await page.keyboard.press('Enter');
    assert.equal(await page.locator('select').inputValue(), 'SE', 'type-ahead by name');
    await trigger(page).click(); await page.keyboard.press('Escape');
    assert.equal(await menu.isVisible(), false);
  });
});

test('saved numbers still display and save: a stored +1 number, a bare US number and a number from elsewhere', async () => {
  await withPage(async (page) => {
    await loadPhone(page);
    await page.locator('#phone').fill('+15555550123');
    await attach(page, 'GB');
    assert.equal(await page.evaluate(() => window.phone.country()), 'US');
    assert.equal(await page.locator('#phone').inputValue(), '(555) 555-0123');
    const reset = () => page.evaluate(() => document.querySelectorAll('.fm-select-list, select').forEach((e) => e.remove()));
    await reset(); await page.locator('#phone').fill('5555550123'); await attach(page, 'US');
    assert.equal(await page.locator('#phone').inputValue(), '(555) 555-0123');
    assert.equal(await page.evaluate(() => window.phone.e164()), '+15555550123');
    await reset(); await page.locator('#phone').fill('+61212345678'); await attach(page, 'GB');
    assert.equal(await page.locator('#phone').inputValue(), '+61 2 1234 5678');
    assert.equal(await page.evaluate(() => window.phone.e164()), '+61212345678');
  });
});

test('signup: only the calling code is offered, defaulting to the detected country; the language goes as a hidden field', async () => {
  await withPage(async (page) => {
    await page.addScriptTag({ url: 'http://phone.test/libraries/signup-region/signup-region.js' });
    await page.evaluate(() => { window.region = FirstMateSignupRegion.mount({ form: document.getElementById('f'), phoneInput: document.getElementById('phone'), apiBase: 'http://phone.test/v1/platform' }); return window.region.ready; });
    await page.waitForFunction(() => document.querySelectorAll('.fm-select-list').length === 1 && document.getElementById('phone').placeholder);
    // 1M8-240: no Country or Language dropdowns.
    assert.equal(await page.locator('select[name="signup_country"], select[name="signup_language"]').count(), 0);
    assert.equal(await page.locator('input[type="hidden"][name="signup_language"]').inputValue(), 'en-GB');
    assert.equal((await trigger(page).innerText()).replace(/\s+/g, ' '), 'GB +44');
    assert.equal(await page.locator('#phone').getAttribute('placeholder'), '07400 123456');
    // Choosing another calling code moves the example and the saved number with it.
    await pick(page, '.fm-select-list.compact', 'SE');
    assert.equal(await page.locator('#phone').getAttribute('placeholder'), '070-123 45 67');
    await page.locator('#phone').pressSequentially('0701234567');
    assert.equal(await page.locator('#phone').inputValue(), '070-123 45 67');
    assert.equal(await page.evaluate(() => window.region.phone()), '+46701234567');
    assert.equal(await page.evaluate(() => window.region.valid()), true);
    assert.equal(await page.evaluate(() => window.region.formatsAsNorthAmerican()), false, 'the host forms leave formatting to the picker');
    // The page's language can be set after detection; it is what the signup sends.
    await page.evaluate(() => window.region.setLanguage('fr-FR'));
    assert.equal(await page.locator('input[name="signup_language"]').inputValue(), 'fr-FR');
  });
});

test('without a detected country the calling code starts on the first offered country and nothing asks for a country', async () => {
  await withPage(async (page) => {
    await page.addScriptTag({ url: 'http://phone.test/libraries/signup-region/signup-region.js' });
    await page.evaluate(() => { window.region = FirstMateSignupRegion.mount({ form: document.getElementById('f'), phoneInput: document.getElementById('phone'), apiBase: 'http://phone.test/v1/platform' }); return window.region.ready; });
    await page.waitForFunction(() => document.querySelectorAll('.fm-select-list').length === 1);
    assert.equal(await page.locator('select[name="phone_country"]').inputValue(), 'GB');
    assert.doesNotMatch(await page.locator('body').innerText(), /Choose your country|Country\b(?! calling)/);
  }, { country: '' });
});
