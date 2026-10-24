// The app's signup form embedded on the FirstMate websites (1M8-240 follow-up). A website page on 1m8.ai or eu.1m8.ai
// loads https://app.1m8.ai/portal/landing/shared/signup-widget.js; the form renders on the website page and calls the
// app's API cross-origin. app.1m8.ai is served by PHP (pages) and the real API (in process); the websites are fixtures.
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
import {getExampleNumber} from 'libphonenumber-js';

const publicRoot = fileURLToPath(new URL('../../', import.meta.url));
const catalogs = path.join(publicRoot, 'libraries/platform-language/catalogs');
const manifest = JSON.parse(fs.readFileSync(path.join(catalogs, 'manifest.json'), 'utf8'));
const signupText = JSON.parse(fs.readFileSync(path.join(catalogs, manifest.namespaces.signup), 'utf8')).namespaces.signup;
const examples = JSON.parse(fs.readFileSync(path.join(publicRoot, 'libraries/vendor/libphonenumber-js-1.12.31/examples.mobile.json'), 'utf8'));
const hasPhp = !!spawnSync('php', ['-v']).stdout?.length;
const APP = 'https://app.1m8.ai';
const CHROME = process.env.CHROME_PATH || 'C:/Program Files/Google/Chrome/Application/chrome.exe';

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
  temporary = await mkdtemp(path.join(os.tmpdir(), 'signup-embed-'));
  Object.assign(process.env, {NODE_ENV: 'test', FIRSTMATE_ENV: 'test', FIRSTMEASURE_DATABASE_MODE: 'sqlite', DATABASE_URL: '', PLATFORM_HEARTBEAT_DISABLED: '1', WORK_SCHEDULER_DISABLED: '1', EMAIL_OUTBOUND_DISABLED: '1', CUSTOMER_CALL_WORKER_DISABLED: '1', FIRSTMEASURE_JOB_WORKERS: '0', V1_LOG_LEVEL: 'error', FIRSTMEASURE_INDEX_DB_PATH: path.join(temporary, 'measure/index.sqlite'),
    PUBLIC_BASE_URL: APP,
    // The production list, plus a cross-site origin used only to show what third-party cookie blocking would do.
    SIGNUP_EMBED_ORIGINS: 'https://1m8.ai,https://www.1m8.ai,https://eu.1m8.ai,https://partner.example'});
  for (const name of ['PLATFORM', 'INTERNAL', 'CRM', 'FIRSTMEASURE', 'MESSAGING', 'CHANNELS', 'CALLS', 'PRICEBOOK']) process.env[name + '_STORAGE_ROOT'] = path.join(temporary, name.toLowerCase());
  app = await (await import('../src/app.js')).buildApp(); await app.ready();
  profile = await import('../commerce/profile.js');
  const port = await freePort();
  const binary = spawnSync('php', ['-r', 'echo PHP_BINARY;'], {encoding: 'utf8'}).stdout.trim();
  child = spawn(binary, ['-S', `127.0.0.1:${port}`, '-t', publicRoot], {env: {...process.env, TEMP: temporary, TMP: temporary, TMPDIR: temporary}, stdio: 'ignore'});
  origin = `http://127.0.0.1:${port}`;
  for (let attempt = 0; ; attempt++) {
    try { if ((await fetch(`${origin}/portal/landing/shared/signup-widget.js`)).ok) break; } catch { /* starting */ }
    if (attempt >= 100) throw Error('Test PHP server failed to start');
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  browser = await chromium.launch({executablePath: CHROME, headless: true});
});
after(async () => {
  await browser?.close();
  child?.kill();
  await app?.close();
  if (hasPhp) await (await import('./helpers/platform-fixture.js')).closePlatformFixtureStores();
  if (temporary) await rm(temporary, {recursive: true, force: true}).catch(() => {});
});

/** A website landing page that embeds the app's form, as the website pages will. */
function websitePage({lang = 'en', requireBonus = false} = {}) {
  return `<!doctype html><html lang="${lang}"><head><meta charset="utf-8"><title>Website landing</title></head><body>
<h1>Roof reports</h1>
<div data-firstmate-signup data-mode="register" data-landing-variant="website-meta" data-submit-label="Start Ordering Reports"${requireBonus ? ' data-require-bonus="true"' : ''}></div>
<script src="${APP}/portal/landing/shared/signup-widget.js" defer></script>
</body></html>`;
}

// One browser context per visitor (an English US browser in New York), with app.1m8.ai routed to PHP and the API.
async function visitor(edge, {use = browser, lang, requireBonus} = {}) {
  const context = await use.newContext({locale: 'en-US', timezoneId: 'America/New_York', viewport: {width: 1200, height: 900}});
  const calls = [];
  await context.route('**/*', async route => {
    const request = route.request();
    const url = new URL(request.url());
    if (['https://1m8.ai', 'https://www.1m8.ai', 'https://eu.1m8.ai', 'https://evil.example', 'https://partner.example'].includes(url.origin)) {
      return url.pathname === '/landing/' ? route.fulfill({status: 200, contentType: 'text/html', body: websitePage({lang, requireBonus})}) : route.abort();
    }
    if (url.origin !== APP) return route.abort();
    const headers = {...await request.allHeaders(), 'cf-ipcountry': edge, 'x-forwarded-proto': 'https', host: 'app.1m8.ai'};
    if (url.pathname.startsWith('/v1/')) {
      const response = await app.inject({method: request.method(), url: url.pathname + url.search, headers, payload: request.postData() ?? undefined});
      calls.push({method: request.method(), path: url.pathname, origin: headers.origin || '', status: response.statusCode, body: request.postData() || '', json: (() => { try { return response.json(); } catch { return null; } })()});
      const out = {};
      for (const [name, value] of Object.entries(response.headers)) if (!['content-length', 'transfer-encoding', 'connection'].includes(name)) out[name] = Array.isArray(value) ? value.join('\n') : String(value);
      return route.fulfill({status: response.statusCode, headers: out, body: response.rawPayload});
    }
    // The page the signup lands on in the app: a stub that asks the API who is signed in.
    if (url.pathname === '/portal/' ) return route.fulfill({status: 200, contentType: 'text/html', body: '<!doctype html><title>App</title><p>Signed in app</p>'});
    const local = await fetch(origin + url.pathname + url.search).catch(() => null);
    if (!local) return route.abort();
    return route.fulfill({status: local.status, headers: {'content-type': local.headers.get('content-type') || 'text/html'}, body: Buffer.from(await local.arrayBuffer())});
  });
  return {context, calls};
}

const widget = page => page.locator('[data-firstmate-signup]').first();
async function formReady(page) {
  await page.waitForFunction(() => document.querySelector('[data-firstmate-signup]')?.shadowRoot?.querySelector('[data-form="register"] input[name="signup_language"]')?.value, null, {timeout: 20000});
  await page.waitForFunction(() => document.querySelector('[data-firstmate-signup]').shadowRoot.querySelector('input[name="phone"]').placeholder, null, {timeout: 20000});
  return page.evaluate(() => {
    const root = document.querySelector('[data-firstmate-signup]').shadowRoot;
    return {
      tab: root.querySelector('[data-tab="register"]').textContent.trim(),
      submit: root.querySelector('[data-form="register"] button[type="submit"]').textContent.trim(),
      selects: [...root.querySelectorAll('select')].map(s => s.name),
      callingCode: root.querySelector('select[name="phone_country"]').value,
      placeholder: root.querySelector('input[name="phone"]').placeholder,
      language: root.querySelector('input[name="signup_language"]').value,
      htmlLang: document.documentElement.getAttribute('lang'),
    };
  });
}

async function fillAndSubmit(page, {email, phone}) {
  const form = widget(page).locator('[data-form="register"]');
  await form.locator('input[name="phone"]').fill(phone);
  await form.locator('input[name="email"]').fill(email);
  await form.locator('input[name="password"]').fill('signup-embed-password-1');
  await form.locator('input[name="confirm_password"]').fill('signup-embed-password-1');
  await form.locator('button[type="submit"]').click();
}

const registration = calls => calls.find(c => c.path === '/v1/platform/auth/legacy-action' && /"register"/.test(c.body));

/** Sign up from a website page and land in the app, signed in. */
async function signUpFromWebsite(t, {site, edge, lang, query = '', email, phone, locale, currency, use}) {
  const {context, calls} = await visitor(edge, {lang, use});
  const page = await context.newPage();
  await page.goto(`${site}/landing/${query}`);
  const state = await formReady(page);
  assert.equal(state.language, locale, 'the form is in the visitor\'s language');
  assert.equal(state.tab, signupText[locale]?.tab_register ?? signupText['en-US'].tab_register);
  assert.equal(state.submit, signupText[locale]?.start_ordering_reports ?? signupText['en-US'].start_ordering_reports);
  assert.deepEqual(state.selects, ['phone_country'], 'no country or language dropdowns');
  assert.equal(state.callingCode, edge, 'the calling code is the detected country');
  const example = getExampleNumber(edge, examples).formatNational();
  await page.waitForFunction(value => document.querySelector('[data-firstmate-signup]').shadowRoot.querySelector('input[name="phone"]').placeholder === value, example, {timeout: 20000})
    .catch(() => null);
  assert.equal(await page.evaluate(() => document.querySelector('[data-firstmate-signup]').shadowRoot.querySelector('input[name="phone"]').placeholder), example, `the ${edge} example number, from the app through the API`);
  assert.equal(state.htmlLang, lang, 'the website page keeps its own <html lang>');
  await Promise.all([page.waitForURL(`${APP}/portal/**`, {timeout: 20000}), fillAndSubmit(page, {email, phone})]);
  const sent = registration(calls);
  assert.equal(sent.origin, site, 'the browser named the website origin');
  assert.equal(sent.status, 200, JSON.stringify(sent.json));
  // Signed in on landing: the app session cookie set by the cross-origin signup is sent from the app page.
  const me = await page.evaluate(async () => { const r = await fetch('/v1/platform/me/localization', {credentials: 'include'}); return {status: r.status, body: await r.json()}; });
  assert.equal(me.status, 200, 'signed in when the signup lands in the app');
  assert.equal(me.body.context.locale, locale, 'the organization language');
  const organization = sent.json.organization_id || sent.json.organization?.id || sent.json.org_id;
  assert.equal((await profile.organizationProfile(organization)).currency, currency);
  await context.close();
  return {sent, page};
}

test('the app form embedded on a website signs up, keeps attribution and lands signed in, in es, fr and en-GB', {skip: !hasPhp && 'php not installed'}, async t => {
  await t.test('1m8.ai Spanish page (html lang es-US) -> es-ES', async () => {
    const {sent} = await signUpFromWebsite(t, {site: 'https://1m8.ai', edge: 'ES', lang: 'es-US', query: '?cid=meta-es&xid=bonus-token-1&fbclid=fb-click-1&utm_source=facebook', email: 'embed-es@signup-embed.example.test', phone: '612 345 671', locale: 'es-ES', currency: 'EUR'});
    const body = JSON.parse(sent.body);
    assert.equal(body.campaign, 'meta-es', 'campaign kept');
    assert.equal(body.landing_variant, 'website-meta', 'landing variant kept');
    assert.equal(body.xid, 'bonus-token-1', 'bonus token kept');
    assert.equal(body.acquisition_bonus_token, 'bonus-token-1');
    assert.match(body.attribution_metadata || '', /fb-click-1/, 'Meta click id kept');
    assert.equal(body.signup_language, 'es-ES');
  });
  await t.test('1m8.ai with ?lang=fr -> fr-FR', async () => {
    await signUpFromWebsite(t, {site: 'https://1m8.ai', edge: 'FR', lang: 'en', query: '?lang=fr&cid=meta', email: 'embed-fr@signup-embed.example.test', phone: '6 12 34 56 72', locale: 'fr-FR', currency: 'EUR'});
  });
  await t.test('eu.1m8.ai UK page (html lang en-GB) from GB -> en-GB', async () => {
    await signUpFromWebsite(t, {site: 'https://eu.1m8.ai', edge: 'GB', lang: 'en-GB', query: '?cid=uk2', email: 'embed-gb@signup-embed.example.test', phone: '07400 123473', locale: 'en-GB', currency: 'EUR'});
  });
});

test('the form sends its funnel events in batches and every one is recorded', {skip: !hasPhp && 'php not installed'}, async () => {
  // Production's ledger still had the retired PHP module's UNIQUE (campaign, actor, type) index, which refused every
  // anonymous interaction after the first per campaign and type (500 on compatibility, 503 from the web nodes).
  const {DatabaseSync} = await import('node:sqlite');
  const referrals = await import('../internal/crm/referrals.js');
  await referrals.ensureReferralDatabase();
  await referrals.saveAcquisitionCampaign({code: 'meta-funnel', display_name: 'Funnel campaign'});
  const ledger = new DatabaseSync(path.join(temporary, 'crm', 'databases', 'referrals.sqlite'));
  // Earlier tests in this file recorded repeated events, which the old index could not hold.
  ledger.exec('DELETE FROM referral_events');
  ledger.exec('CREATE UNIQUE INDEX IF NOT EXISTS idx_referral_events_unique ON referral_events(partner_id, actor_email, actor_org_id, event_type)');
  const {context, calls} = await visitor('US', {lang: 'en'});
  const page = await context.newPage();
  await page.goto('https://1m8.ai/landing/?cid=meta-funnel');
  await formReady(page);
  await Promise.all([page.waitForURL(`${APP}/portal/**`, {timeout: 20000}), fillAndSubmit(page, {email: 'funnel@signup-embed.example.test', phone: '(415) 555-0195'})]);
  for (let i = 0; i < 100 && !calls.some(c => c.path === '/v1/platform/acquisition/event' && /signup_register_success/.test(c.body)); i++) await page.waitForTimeout(50);
  const sent = calls.filter(c => c.path === '/v1/platform/acquisition/event' && c.method === 'POST');
  const events = sent.flatMap(c => JSON.parse(c.body).events || [JSON.parse(c.body)]);
  assert.ok(sent.every(c => c.status === 200), `every request recorded: ${sent.map(c => c.status).join(',')}`);
  assert.ok(sent.every(c => Array.isArray(JSON.parse(c.body).events)), 'sent as batches');
  assert.ok(events.length > 20 && sent.length * 3 < events.length, `${events.length} events in ${sent.length} requests`);
  assert.ok(events.every(e => e.acquisition_code === 'meta-funnel' && e.event_id), 'each event keeps its campaign and id');
  for (const step of ['signup_widget_ready', 'signup_field_focus', 'signup_field_input', 'signup_register_submit_attempt', 'signup_register_success']) {
    assert.ok(events.some(e => e.event_type === step), `${step} sent`);
  }
  const stored = ledger.prepare("SELECT event_type, COUNT(*) AS n FROM referral_events WHERE code = 'meta-funnel' OR json_extract(metadata_json, '$.acquisition_code') = 'meta-funnel' GROUP BY event_type").all();
  ledger.close();
  const storedCount = stored.reduce((sum, row) => sum + Number(row.n), 0);
  assert.equal(storedCount, events.length, `every event is in the ledger: ${JSON.stringify(stored)}`);
  assert.ok(Number(stored.find(row => row.event_type === 'signup_field_input')?.n) > 1, 'repeated anonymous interactions of one type are all kept');
  await context.close();
});

test('an origin that is not a FirstMate website is refused', {skip: !hasPhp && 'php not installed'}, async () => {
  const {context, calls} = await visitor('US', {lang: 'en'});
  const page = await context.newPage();
  await page.goto('https://evil.example/landing/');
  await page.waitForFunction(() => document.querySelector('[data-firstmate-signup]')?.shadowRoot?.querySelector('[data-form="register"]'), null, {timeout: 20000});
  await page.waitForTimeout(500);
  await fillAndSubmit(page, {email: 'evil@signup-embed.example.test', phone: '(415) 555-0190'});
  for (let i = 0; i < 100 && !registration(calls); i++) await page.waitForTimeout(50);
  assert.equal(registration(calls)?.status, 403);
  assert.equal(registration(calls)?.json?.error, 'origin_not_allowed');
  assert.ok(calls.filter(c => c.path.startsWith('/v1/platform/auth/')).every(c => c.status === 403), 'every auth call from it is refused');
  assert.equal((await context.cookies(APP)).some(c => /session/.test(c.name)), false, 'no session');
  // The server refuses it without a browser too, and still answers the app and the websites.
  const direct = await app.inject({method: 'POST', url: '/v1/platform/auth/legacy-action', headers: {origin: 'https://evil.example', 'content-type': 'application/json'}, payload: {action: 'register', email: 'evil2@signup-embed.example.test', password: 'x'}});
  assert.equal(direct.statusCode, 403);
  for (const allowed of ['https://app.1m8.ai', 'https://1m8.ai', 'https://www.1m8.ai', 'https://eu.1m8.ai']) {
    const options = await app.inject({method: 'GET', url: '/v1/platform/auth/signup-options', headers: {origin: allowed, host: 'app.1m8.ai', 'x-forwarded-proto': 'https'}});
    assert.equal(options.statusCode, 200, allowed);
  }
  for (const refused of ['https://1m8.ai.evil.example', 'http://1m8.ai', 'https://evil-1m8.ai', 'null']) {
    const options = await app.inject({method: 'GET', url: '/v1/platform/auth/signup-options', headers: {origin: refused, host: 'app.1m8.ai', 'x-forwarded-proto': 'https'}});
    assert.equal(options.statusCode, 403, refused);
  }
  await context.close();
});

test('a redirect after signup stays in the app', {skip: !hasPhp && 'php not installed'}, async () => {
  const {context} = await visitor('US', {lang: 'en'});
  const page = await context.newPage();
  await page.goto('https://1m8.ai/landing/?redirect=https://evil.example/steal&cid=meta');
  await formReady(page);
  await Promise.all([page.waitForURL(`${APP}/portal/**`, {timeout: 20000}), fillAndSubmit(page, {email: 'redirect@signup-embed.example.test', phone: '(415) 555-0191'})]);
  assert.equal(new URL(page.url()).origin, APP, 'not sent to the redirect parameter\'s site');
  await context.close();
});

test('a landing page that promises a bonus never creates an account without it', {skip: !hasPhp && 'php not installed'}, async () => {
  const {context, calls} = await visitor('US', {lang: 'en', requireBonus: true});
  const page = await context.newPage();
  await page.goto('https://1m8.ai/landing/?cid=unknown-campaign');
  await formReady(page);
  await fillAndSubmit(page, {email: 'bonus@signup-embed.example.test', phone: '(415) 555-0192'});
  await page.waitForFunction(() => document.querySelector('[data-firstmate-signup]').shadowRoot.querySelector('[data-register-notice]')?.textContent.trim(), null, {timeout: 20000});
  const notice = await page.evaluate(() => document.querySelector('[data-firstmate-signup]').shadowRoot.querySelector('[data-register-notice]').textContent.trim());
  assert.equal(notice, signupText['en-US'].err_bonus_unconfirmed);
  assert.equal(registration(calls), undefined, 'no account created');
  await context.close();
});

test('Safari-style third-party cookie blocking: the websites are the same site, so the signup still lands signed in', {skip: !hasPhp && 'php not installed'}, async t => {
  // Chromium's third-party cookie phase-out blocks cookies across sites, as Safari does.
  const blocking = await chromium.launch({executablePath: CHROME, headless: true, args: ['--test-third-party-cookie-phaseout']});
  try {
    await t.test('from 1m8.ai: signed in', async () => {
      await signUpFromWebsite(t, {use: blocking, site: 'https://1m8.ai', edge: 'US', lang: 'en', query: '?cid=meta', email: 'embed-blocked@signup-embed.example.test', phone: '(415) 555-0193', locale: 'en-US', currency: 'USD'});
    });
    await t.test('control: from another site the blocked cookie never reaches the app', async () => {
      const {context, calls} = await visitor('US', {use: blocking, lang: 'en'});
      const page = await context.newPage();
      await page.goto('https://partner.example/landing/');
      await formReady(page);
      await Promise.all([page.waitForURL(`${APP}/portal/**`, {timeout: 20000}), fillAndSubmit(page, {email: 'embed-cross-site@signup-embed.example.test', phone: '(415) 555-0194'})]);
      assert.equal(registration(calls).status, 200);
      const me = await page.evaluate(async () => (await fetch('/v1/platform/me/localization', {credentials: 'include'})).status);
      assert.notEqual(me, 200, 'cross-site, the cookie is blocked: this is what the same-site setup avoids');
      await context.close();
    });
  } finally { await blocking.close(); }
});

// 2026-10-24: Meta ads open the app's landing pages with utm_campaign=<Meta's numeric campaign id>. The page puts that in
// data-campaign; it must stay a hint, so the campaign that owns the landing page (and its bonus) wins over a stray
// campaign that happens to be named after the id. Sending it as an explicit acquisition_code dropped every bonus.
test('a Meta ad\'s utm_campaign does not take the bonus away from the landing page\'s campaign', {skip: !hasPhp && 'php not installed'}, async t => {
  const referrals = await import('../internal/crm/referrals.js');
  const storage = await import('../platform/storage.js');
  await referrals.saveAcquisitionCampaign({
    code: 'meta-6-19-1', display_name: 'Meta 6/19 B', channel: 'Meta', landing_page: '/portal/landing/variants/meta-619b/', landing_variant: 'meta-619b',
    bonus_offer_sets: {'offer-set-1': {id: 'offer-set-1', token: 'meta-b-bonus', label: 'Offer Set 1', status: 'active', tiers: [{customer_pays: 100, match_percent: 25}]}}
  });
  // Made in June by a visit that used the id as a code: no landing page, no bonus.
  await referrals.saveAcquisitionCampaign({code: '52513030142937', display_name: '52513030142937', channel: 'ig', landing_variant: 'meta-619a', bonus_offer_sets: {}});
  const meta = '?utm_source=fb&utm_medium=Facebook_Mobile_Reels&utm_campaign=52513030142937&utm_content=52550775522537&utm_id=52513030142937&fbclid=fb-click-2';
  const visit = async (query, email, phone) => {
    const {context, calls} = await visitor('US', {lang: 'en'});
    const page = await context.newPage();
    await page.goto(`${APP}/portal/landing/variants/meta-619b/${query}`);
    await formReady(page);
    await page.waitForFunction(() => document.querySelector('[data-firstmate-signup]')?.dataset.bonusReady, null, {timeout: 20000});
    const track = calls.find(c => c.path === '/v1/platform/acquisition/public/track');
    const result = {bonusReady: await page.evaluate(() => document.querySelector('[data-firstmate-signup]').dataset.bonusReady), sent: JSON.parse(track.body), track: track.json};
    if (email) {
      // The landing page is itself under /portal/, so wait for the app page the signup lands on.
      await Promise.all([page.waitForURL(url => url.pathname === '/portal/', {timeout: 20000}), fillAndSubmit(page, {email, phone})]);
      const sent = registration(calls);
      assert.equal(sent.status, 200, JSON.stringify(sent.json));
      result.organization = await storage.readOrganization(sent.json.organization_id || sent.json.organization?.id || sent.json.org_id);
    }
    await context.close();
    return result;
  };
  await t.test('Meta ad link: the page\'s campaign and its bonus, through signup', async () => {
    const r = await visit(meta, 'meta-utm@signup-embed.example.test', '(415) 555-0195');
    assert.equal(r.track.link?.code, 'meta-6-19-1', 'the campaign that owns the landing page');
    assert.equal(r.track.bonus_offer?.token, 'meta-b-bonus', 'with its bonus');
    assert.equal(r.bonusReady, 'true');
    assert.equal(r.sent.acquisition_code, '', 'utm_campaign is not sent as an explicit code');
    assert.equal(r.sent.utm_campaign, '52513030142937', 'it is still recorded');
    assert.equal(r.organization.acquisition_code, 'meta-6-19-1');
    assert.equal(r.organization.acquisition_bonus_offer?.token, 'meta-b-bonus', 'the account has the bonus');
  });
  await t.test('a link that names the code with cid still gets that campaign', async () => {
    const r = await visit('?cid=52513030142937&utm_campaign=52513030142937');
    assert.equal(r.sent.acquisition_code, '52513030142937');
    assert.equal(r.track.link?.code, '52513030142937');
    assert.equal(r.bonusReady, 'false');
  });
});
