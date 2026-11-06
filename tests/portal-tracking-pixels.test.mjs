// The TikTok Pixel (FM-348) is on every customer portal page and every landing page variant,
// printed in <head> from the one include, public/portal/tiktok-pixel.php.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..');
const portal = path.join(root, 'public/portal');
const read = file => fs.readFileSync(path.join(portal, file), 'utf8');
const PORTAL_PAGES = ['index.php', 'login.php', 'activate.php', 'mobile/index.php'];
const variantsDir = path.join(portal, 'landing/variants');
const VARIANTS = fs.readdirSync(variantsDir).filter(name => fs.existsSync(path.join(variantsDir, name, 'index.php')));
// A variant that only sets a mode and requires another variant gets the pixel from that one.
const wrapperTarget = source => /^<\?php\s+declare\(strict_types=1\);\s+\$landingVariantMode = '[a-z_]+';\s+require dirname\(__DIR__\) \. '\/([a-z0-9_-]+)\/index\.php';\s*$/.exec(source)?.[1];

function assertPrintsPixel(file) {
  const source = read(file);
  const target = file.startsWith('landing/variants/') && wrapperTarget(source);
  if (target) return assertPrintsPixel(`landing/variants/${target}/index.php`);
  assert.match(source, /require_once [^;]+ \. '\/tiktok-pixel\.php';/, `${file} requires the TikTok pixel include`);
  const head = source.slice(0, source.indexOf('</head>'));
  assert.ok(head.includes('<?= fm_tiktok_pixel() ?>'), `${file} prints the TikTok pixel in <head>`);
  assert.ok(!/ttq\.load\(/.test(source), `${file} uses the include, not a pasted copy`);
}

test('the include loads pixel DBN2ED3C77UF91065S40 and records a page view', () => {
  const include = read('tiktok-pixel.php');
  assert.match(include, /const FM_TIKTOK_PIXEL_ID = 'DBN2ED3C77UF91065S40';/);
  assert.ok(include.includes('https://analytics.tiktok.com/i18n/pixel/events.js'));
  assert.ok(include.includes('ttq.load({$id});') && include.includes('ttq.page();'));
  assert.ok(!/\?>/.test(include.replace(/^<\?php/, '')), 'the include prints nothing when required or requested');
});

test('every customer portal page prints the TikTok pixel', () => {
  for (const file of PORTAL_PAGES) assertPrintsPixel(file);
});

test('every landing page variant prints the TikTok pixel', () => {
  assert.ok(VARIANTS.length >= 11, `found variants: ${VARIANTS.join(', ')}`);
  for (const name of VARIANTS) assertPrintsPixel(`landing/variants/${name}/index.php`);
});

test('a portal page with the Meta Pixel or Google tag also has the TikTok pixel', () => {
  const pages = [];
  const walk = dir => {
    for (const entry of fs.readdirSync(path.join(portal, dir), { withFileTypes: true })) {
      const rel = dir ? `${dir}/${entry.name}` : entry.name;
      if (entry.isDirectory()) { if (!['unused', 'v1', 'media'].includes(entry.name)) walk(rel); }
      else if (entry.name.endsWith('.php')) pages.push(rel);
    }
  };
  walk('');
  const tracked = pages.filter(file => /fbq\('init'|googletagmanager\.com\/gtag/.test(read(file)));
  assert.ok(tracked.length >= 10, `found tracked pages: ${tracked.join(', ')}`);
  for (const file of tracked) assertPrintsPixel(file);
});

// FM-352: the include also owns TikTok's browser CompleteRegistration on app-hosted pages. It listens
// for the shared signup widget's firstmate:auth-success and sends the event only for a new account.
function runPixelScript(page, times = 1) {
  const include = read('tiktok-pixel.php');
  const script = include.slice(include.indexOf('<script>') + 8, include.indexOf('</script>')).replace('{$id}', '"DBN2ED3C77UF91065S40"');
  const listeners = [];
  page.document = {
    addEventListener: (type, fn) => listeners.push({ type, fn }),
    createElement: () => ({}),
    getElementsByTagName: () => [{ parentNode: { insertBefore() {} } }]
  };
  for (let i = 0; i < times; i++) new Function('window', 'document', script).call(page, page, page.document);
  return (type, target, detail) => { for (const l of listeners) if (l.type === type) l.fn({ target, detail }); };
}
const widgetHost = { matches: selector => selector === '[data-firstmate-signup]' };
const spyPixel = () => { const calls = []; return { calls, page: () => {}, track: (...args) => calls.push(args) }; };

test('a new account from the signup widget sends CompleteRegistration once', () => {
  const page = {};
  const dispatch = runPixelScript(page, 2); // printed twice on one page still listens once
  const pixel = spyPixel();
  page.ttq = pixel;
  dispatch('firstmate:auth-success', widgetHost, { mode: 'register', first_login: true, redirect: '/portal/?onboarding=1' });
  dispatch('firstmate:auth-success', widgetHost, { mode: 'register', first_login: true, redirect: '/portal/?onboarding=1' });
  assert.deepEqual(pixel.calls, [['CompleteRegistration']]);
});

test('logins, errors and other elements do not send CompleteRegistration', () => {
  const page = {};
  const dispatch = runPixelScript(page);
  const pixel = spyPixel();
  page.ttq = pixel;
  dispatch('firstmate:auth-success', widgetHost, { mode: 'login', first_login: false });
  dispatch('firstmate:auth-success', widgetHost, { mode: 'register' });
  dispatch('firstmate:auth-success', widgetHost, { mode: 'register', first_login: 'true' });
  dispatch('firstmate:auth-success', widgetHost, undefined);
  dispatch('firstmate:auth-success', { matches: () => false }, { first_login: true });
  dispatch('firstmate:auth-success', null, { first_login: true });
  dispatch('firstmate:signup-error', widgetHost, { first_login: true });
  dispatch('firstmate:ready', widgetHost, { first_login: true });
  assert.deepEqual(pixel.calls, []);
});

test('a missing or failing TikTok SDK never interrupts signup', () => {
  const page = {};
  const dispatch = runPixelScript(page);
  page.ttq = undefined;
  assert.doesNotThrow(() => dispatch('firstmate:auth-success', widgetHost, { first_login: true }));
  page.ttq = { track() { throw new Error('blocked'); } };
  assert.doesNotThrow(() => dispatch('firstmate:auth-success', widgetHost, { first_login: true }));
  const pixel = spyPixel();
  page.ttq = pixel;
  dispatch('firstmate:auth-success', widgetHost, { first_login: true });
  assert.deepEqual(pixel.calls, [['CompleteRegistration']], 'a failed attempt does not use up the one event');
});

test('the signup widget never sends TikTok events itself', () => {
  // The website (1m8.ai) embeds the same widget and counts signups with its own listener.
  const widget = read('landing/shared/signup-widget.js');
  assert.ok(!/\bttq\b/.test(widget), 'signup-widget.js leaves TikTok to the page listener');
  assert.match(widget, /emit\(host, 'auth-success', \{ mode: state\.active, first_login: !!\(data && data\.first_login\)/);
});
