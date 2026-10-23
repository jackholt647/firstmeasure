// 1M8-240: the language a visitor already saw follows them from each landing source into signup, onboarding and the
// organization, with no country or language dropdowns. Sources: the 1m8.ai website, the eu.1m8.ai website (both
// carry handoff.js) and the old landing pages built into app.1m8.ai (Meta campaigns), which take ?lang= directly.
// app.1m8.ai is served by PHP (pages) and the real API (in process); the websites are fixtures.
import test, {before, after} from 'node:test';
import assert from 'node:assert/strict';
import {spawn, spawnSync} from 'node:child_process';
import {createServer} from 'node:net';
import fs from 'node:fs';
import {mkdtemp, rm} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {chromium} from 'playwright-core';

const publicRoot = fileURLToPath(new URL('../../', import.meta.url));
const catalogs = path.join(publicRoot, 'libraries/platform-language/catalogs');
const manifest = JSON.parse(fs.readFileSync(path.join(catalogs, 'manifest.json'), 'utf8'));
const catalog = name => JSON.parse(fs.readFileSync(path.join(catalogs, manifest.namespaces[name]), 'utf8')).namespaces[name];
const signupText = catalog('signup'), onboardingText = catalog('onboarding');
const hasPhp = !!spawnSync('php', ['-v']).stdout?.length;
const APP = 'https://app.1m8.ai';

const LANGUAGES = [
  {lang: 'es', locale: 'es-ES', edge: 'ES', phone: '612 345 6', currency: 'EUR'},
  {lang: 'fr', locale: 'fr-FR', edge: 'FR', phone: '6 12 34 56 ', currency: 'EUR'},
  {lang: 'de', locale: 'de-DE', edge: 'DE', phone: '151 2345 67', currency: 'EUR'},
];

let app, profile, origin, child, browser, temporary;
async function freePort() {
  const server = createServer();
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const {port} = server.address();
  await new Promise(resolve => server.close(resolve));
  return port;
}

before(async () => {
  if (!hasPhp) return;
  temporary = await mkdtemp(path.join(os.tmpdir(), 'signup-language-'));
  Object.assign(process.env, {NODE_ENV: 'test', FIRSTMATE_ENV: 'test', FIRSTMEASURE_DATABASE_MODE: 'sqlite', DATABASE_URL: '', PLATFORM_HEARTBEAT_DISABLED: '1', WORK_SCHEDULER_DISABLED: '1', EMAIL_OUTBOUND_DISABLED: '1', CUSTOMER_CALL_WORKER_DISABLED: '1', FIRSTMEASURE_JOB_WORKERS: '0', V1_LOG_LEVEL: 'error', FIRSTMEASURE_INDEX_DB_PATH: path.join(temporary, 'measure/index.sqlite')});
  for (const name of ['PLATFORM', 'INTERNAL', 'CRM', 'FIRSTMEASURE', 'MESSAGING', 'CHANNELS', 'CALLS', 'PRICEBOOK']) process.env[name + '_STORAGE_ROOT'] = path.join(temporary, name.toLowerCase());
  app = await (await import('../src/app.js')).buildApp(); await app.ready();
  profile = await import('../commerce/profile.js');
  const port = await freePort();
  const binary = spawnSync('php', ['-r', 'echo PHP_BINARY;'], {encoding: 'utf8'}).stdout.trim();
  child = spawn(binary, ['-S', `127.0.0.1:${port}`, '-t', publicRoot], {env: {...process.env, TEMP: temporary, TMP: temporary, TMPDIR: temporary}, stdio: 'ignore'});
  origin = `http://127.0.0.1:${port}`;
  for (let attempt = 0; ; attempt++) {
    try { if ((await fetch(`${origin}/libraries/signup-language/handoff.js`)).ok) break; } catch { /* starting */ }
    if (attempt >= 100) throw Error('Test PHP server failed to start');
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  browser = await chromium.launch({executablePath: process.env.CHROME_PATH || 'C:/Program Files/Google/Chrome/Application/chrome.exe', headless: true});
});
after(async () => {
  await browser?.close();
  child?.kill();
  await app?.close();
  if (hasPhp) await (await import('./helpers/platform-fixture.js')).closePlatformFixtureStores();
  if (temporary) await rm(temporary, {recursive: true, force: true}).catch(() => {});
});

function website(host) {
  return `<!doctype html><html lang="${host === 'eu.1m8.ai' ? 'en-GB' : 'en'}"><head><meta charset="utf-8"><title>FirstMeasure</title>
<script src="https://app.1m8.ai/libraries/signup-language/handoff.js" defer></script></head>
<body><h1>Roof reports</h1><a id="signup" href="https://app.1m8.ai/portal/landing/variants/main-site-page/?cid=main&xid=5jw6qtkxcwx2">Sign up</a></body></html>`;
}

// One browser context per visitor: an English (US) browser in New York, so only the hand-off or the edge can decide.
async function visitor(edge) {
  const context = await browser.newContext({locale: 'en-US', timezoneId: 'America/New_York', viewport: {width: 1200, height: 900}});
  const registrations = [];
  await context.route('**/*', async route => {
    const request = route.request();
    const url = new URL(request.url());
    if (url.hostname === '1m8.ai' || url.hostname === 'www.1m8.ai' || url.hostname === 'eu.1m8.ai') {
      return url.pathname === '/' ? route.fulfill({status: 200, contentType: 'text/html', body: website(url.hostname)}) : route.abort();
    }
    if (url.origin !== APP) return route.abort();
    const headers = {...await request.allHeaders(), 'cf-ipcountry': edge};
    if (url.pathname.startsWith('/v1/')) {
      const response = await app.inject({method: request.method(), url: url.pathname + url.search, headers, payload: request.postData() ?? undefined});
      if (url.pathname.endsWith('/auth/legacy-action') && /"register"/.test(request.postData() || '')) registrations.push({body: response.json(), cookie: response.headers['set-cookie']});
      const out = {};
      for (const [name, value] of Object.entries(response.headers)) if (!['content-length', 'transfer-encoding', 'connection'].includes(name)) out[name] = Array.isArray(value) ? value.join('\n') : String(value);
      return route.fulfill({status: response.statusCode, headers: out, body: response.rawPayload});
    }
    const local = await fetch(origin + url.pathname + url.search, {headers: {'cf-ipcountry': edge}}).catch(() => null);
    if (!local) return route.abort();
    return route.fulfill({status: local.status, headers: {'content-type': local.headers.get('content-type') || 'text/html'}, body: Buffer.from(await local.arrayBuffer())});
  });
  return {context, registrations};
}

// Some landing pages place two widgets (wide and narrow layouts); the visitor uses the visible one.
const widget = page => page.locator('[data-firstmate-signup]').locator('visible=true').first();
const VISIBLE = "[...document.querySelectorAll('[data-firstmate-signup]')].find(h => h.getClientRects().length)";
async function widgetState(page) {
  await page.waitForFunction(`${VISIBLE}?.shadowRoot?.querySelector('select[name="phone_country"] option')`, null, {timeout: 20000});
  await page.waitForFunction(`${VISIBLE}.shadowRoot.querySelector('[data-form="register"] input[name="signup_language"]')?.value`, null, {timeout: 20000});
  return page.evaluate(visible => {
    const root = eval(visible).shadowRoot;
    return {
      tab: root.querySelector('[data-tab="register"]').textContent.trim(),
      phoneLabel: root.querySelector('[data-i18n="phone"]').textContent.trim(),
      submit: root.querySelector('[data-form="register"] button[type="submit"]').textContent.trim(),
      selects: [...root.querySelectorAll('select')].map(s => s.name),
      callingCode: root.querySelector('select[name="phone_country"]').value,
      language: root.querySelector('input[name="signup_language"]').value,
      text: root.textContent,
    };
  }, VISIBLE);
}

async function signUp(page, registrations, {email, phone}) {
  const form = widget(page).locator('[data-form="register"]');
  await form.locator('input[name="phone"]').fill(phone);
  await form.locator('input[name="email"]').fill(email);
  await form.locator('input[name="password"]').fill('signup-language-password-1');
  await form.locator('input[name="confirm_password"]').fill('signup-language-password-1');
  const before = registrations.length;
  await form.locator('button[type="submit"]').click();
  for (let i = 0; i < 200 && registrations.length === before; i++) await page.waitForTimeout(50);
  assert.equal(registrations.length, before + 1, 'the widget registered');
  const {body, cookie} = registrations.at(-1);
  assert.equal(body.success ?? !body.error, true, JSON.stringify(body));
  return {organization: body.organization_id || body.organization?.id || body.org_id, cookie};
}

// The organization's language, through the session the signup created, and onboarding text in it.
async function organizationLanguage(page, {organization, cookie}) {
  const pairs = (Array.isArray(cookie) ? cookie : [cookie]).filter(Boolean).map(v => v.split(';')[0]).join('; ');
  const localization = (await app.inject({method: 'GET', url: '/v1/platform/me/localization', headers: {cookie: pairs}})).json();
  const currency = (await profile.organizationProfile(organization)).currency;
  // Onboarding renders through PlatformLanguage configured with the organization's context.
  const onboarding = await page.evaluate(async context => {
    await window.PlatformLanguage.configure({context});
    await window.PlatformLanguage.ensure(['onboarding']);
    return {title: window.PlatformLanguage.text('onboarding', 'm_bc9847e2ca77cb', 'Auto Top-up'), invites: window.PlatformLanguage.text('onboarding', 'invites_sent', '{count} invites sent.', {count: 2})};
  }, localization.context);
  return {locale: localization.context?.locale, currency, onboarding};
}

function assertTranslated(state, locale, edge) {
  if (edge) assert.equal(state.callingCode, edge, 'the calling code defaults to the detected country');
  assert.equal(state.language, locale, 'the signup is sent in the hand-off language');
  assert.equal(state.tab, signupText[locale].tab_register);
  assert.equal(state.phoneLabel, signupText[locale].phone);
  assert.deepEqual(state.selects, ['phone_country'], 'only the calling-code picker; no country or language dropdown');
  assert.doesNotMatch(state.text, /\{[a-z_]+\}/, 'no raw placeholders');
}

async function assertOrganization(page, created, {locale, currency}) {
  const organization = await organizationLanguage(page, created);
  assert.equal(organization.locale, locale, 'the organization language');
  assert.equal(organization.currency, currency, 'the organization currency');
  assert.equal(organization.onboarding.title, onboardingText[locale].m_bc9847e2ca77cb, 'onboarding in the organization language');
  assert.doesNotMatch(organization.onboarding.invites, /\{|invites sent/, 'onboarding plural translated');
}

async function websiteSource(host, t) {
  for (const [index, language] of LANGUAGES.entries()) await t.test(`${host} → ${language.lang}`, async () => {
    const {context, registrations} = await visitor(language.edge);
    const page = await context.newPage();
    await page.goto(`https://${host}/`);
    await page.waitForFunction(() => window.FirstMateLanguageHandoff);
    // The visitor's browser translates the English page (as Chrome's translate does).
    await page.evaluate(lang => { document.documentElement.lang = lang; document.documentElement.classList.add('translated-ltr'); }, language.lang);
    await Promise.all([page.waitForURL(/app\.1m8\.ai\/portal\/landing\/variants\/main-site-page/), page.click('#signup')]);
    assert.equal(new URL(page.url()).searchParams.get('lang'), language.lang, 'the link carries ?lang=');
    const cookie = (await context.cookies(APP)).find(c => c.name === 'fm_lang');
    assert.equal(cookie?.value, language.lang); assert.equal(cookie?.domain, '.1m8.ai');
    assertTranslated(await widgetState(page), language.locale, language.edge);
    // The login page, opened later without ?lang, keeps the language from the cookie.
    const login = await context.newPage();
    await login.goto(`${APP}/portal/login.php?start=register`);
    await login.waitForFunction(() => document.documentElement.lang && document.documentElement.lang !== 'en', null, {timeout: 20000});
    assert.equal(await login.evaluate(() => document.documentElement.lang), language.locale);
    assert.equal((await login.locator('[data-i18n="tab_register"]').first().textContent()).trim(), signupText[language.locale].tab_register);
    assert.equal(await login.locator('select[name="signup_country"], select[name="signup_language"]').count(), 0);
    const created = await signUp(page, registrations, {email: `${host.replace(/\W/g, '-')}-${language.lang}@signup-language.example.test`, phone: language.phone + (host.startsWith('eu') ? 5 : 1) + index});
    await assertOrganization(login, created, language);
    await context.close();
  });
}

test('the 1m8.ai website hands its language to signup, onboarding and the organization', {skip: !hasPhp && 'php not installed'}, async t => websiteSource('1m8.ai', t));
test('the eu.1m8.ai website hands its language to signup, onboarding and the organization', {skip: !hasPhp && 'php not installed'}, async t => websiteSource('eu.1m8.ai', t));

test('the old app.1m8.ai landing pages take ?lang= for signup, onboarding and the organization', {skip: !hasPhp && 'php not installed'}, async t => {
  for (const [index, language] of LANGUAGES.entries()) await t.test(`meta-619a → ${language.lang}`, async () => {
    const {context, registrations} = await visitor(language.edge);
    const page = await context.newPage();
    await page.goto(`${APP}/portal/landing/variants/meta-619a/?lang=${language.lang}&cid=meta`);
    const state = await widgetState(page);
    assertTranslated(state, language.locale, language.edge);
    assert.equal(state.submit, signupText[language.locale].start_ordering_reports, "the Meta page's own button label is translated too");
    assert.equal((await context.cookies(APP)).find(c => c.name === 'fm_lang')?.value, language.lang, 'remembered for later pages');
    const created = await signUp(page, registrations, {email: `meta-${language.lang}@signup-language.example.test`, phone: language.phone + 8 + index});
    await assertOrganization(page, created, language);
    await context.close();
  });
  await t.test('the hand-off beats the location for language; the location keeps the currency', async () => {
    const {context, registrations} = await visitor('US');
    const page = await context.newPage();
    await page.goto(`${APP}/portal/landing/?lang=fr`);
    assertTranslated(await widgetState(page), 'fr-FR');
    const created = await signUp(page, registrations, {email: 'landing-fr-us@signup-language.example.test', phone: '(415) 555-0177'});
    await assertOrganization(page, created, {locale: 'fr-FR', currency: 'USD'});
    await context.close();
  });
});
