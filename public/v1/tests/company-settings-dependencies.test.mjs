import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { runInNewContext } from 'node:vm';

const source = async (file) => readFile(new URL(`../../${file}`, import.meta.url), 'utf8');

test('Company settings loads its shared Brand Kit before mounting through either entry point', async () => {
  const [portal, manifest, library, css] = await Promise.all([
    source('portal/index.php'), source('libraries/apps/firstmate-apps-manifest.js'),
    source('libraries/brand-kit/brand-kit.js'), source('libraries/brand-kit/brand-kit.css')
  ]);
  assert.match(portal, /brand-kit\/brand-kit\.js[\s\S]*?settings\/company\.js/);
  const registered = [];
  runInNewContext(manifest, {
    window: { FirstMateEmbeddableApps: { registerManifest: (value) => registered.push(value), registerApp: () => {} } },
    document: { currentScript: { src: 'https://example.test/libraries/apps/firstmate-apps-manifest.js' } }, URL
  });
  const settings = registered.find((entry) => entry.id === 'portal.company_settings');
  const helperIndex = settings.bundles.findIndex((url) => url.includes('/brand-kit/brand-kit.js'));
  const companyIndex = settings.bundles.findIndex((url) => url.includes('/settings/company.js'));
  assert.ok(helperIndex >= 0 && helperIndex < companyIndex, 'lazy mounting must load Brand Kit before Company settings');

  const links = [];
  const window = {};
  runInNewContext(library, { window, URL, document: {
    currentScript: { src: 'https://example.test/libraries/brand-kit/brand-kit.js?v=regression' },
    getElementById: () => null, createElement: () => ({}), head: { appendChild: (link) => links.push(link) }
  } });
  const markup = window.PlatformBrandKit.markup({ prefix: 'cs', extendedPalette: true, advancedLogos: true });
  for (const id of ['PaletteStrip', 'LogoStage', 'LogoFile', 'AlternateLogoList', 'BrandFont']) {
    assert.ok(markup.includes(`id="cs${id}"`));
  }
  for (const method of ['renderPalette', 'renderLogoAppearance', 'renderAlternates']) {
    assert.equal(typeof window.PlatformBrandKit[method], 'function');
  }
  assert.equal(links[0].href, 'https://example.test/libraries/brand-kit/brand-kit.css?v=regression');
  assert.match(css, /company-brand-stack/);
});
