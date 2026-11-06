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

// FM-351: Purchase is sent from the server (public/v1/platform/tiktok-events.ts) with event id
// stripe_purchase:<checkout session>. A browser Purchase would be counted again unless it used that same id.
test('no browser code sends a TikTok Purchase beside the server one', () => {
  const offenders = [];
  const walk = dir => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const file = path.join(dir, entry.name);
      if (entry.isDirectory()) { if (!['unused', 'node_modules', 'v1', 'dist', 'media'].includes(entry.name)) walk(file); }
      else if (/\.(js|php|html)$/.test(entry.name) && /ttq\.track\(\s*['"]Purchase['"]/.test(fs.readFileSync(file, 'utf8'))) offenders.push(path.relative(root, file));
    }
  };
  walk(path.join(root, 'public'));
  assert.deepEqual(offenders, []);
});
