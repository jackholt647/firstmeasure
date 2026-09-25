import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { runInNewContext } from 'node:vm';

const publicRoot = path.resolve(import.meta.dirname, '..', '..');
const [library, company, studio, portal] = await Promise.all([
  readFile(path.join(publicRoot, 'libraries/brand-kit/brand-kit.js'), 'utf8'),
  readFile(path.join(publicRoot, 'libraries/apps/settings/company.js'), 'utf8'),
  readFile(path.join(publicRoot, 'libraries/apps/documents/studio.js'), 'utf8'),
  readFile(path.join(publicRoot, 'portal/index.php'), 'utf8')
]);

test('Company Information and Doc Studio render the same shared Brand Kit controls', () => {
  const window = { location: { href:'https://example.test/portal/' } };
  runInNewContext(library, {
    window,
    document: { currentScript:{ src:'https://example.test/libraries/brand-kit/brand-kit.js' }, getElementById:() => ({}) },
    URL
  });
  const companyMarkup = window.PlatformBrandKit.markup({ prefix:'cs', extendedPalette:true, advancedLogos:true });
  const studioMarkup = window.PlatformBrandKit.markup({ prefix:'ds', extendedPalette:true, advancedLogos:true });
  const normalized = (markup, prefix) => markup.replace(new RegExp(`(id|for|name|data-brandkit-root)=\"${prefix}`, 'g'), '$1=\"XX');
  assert.equal(normalized(companyMarkup, 'cs'), normalized(studioMarkup, 'ds'));
  for (const id of ['Primary','Secondary','PaletteStrip','GeneratePalette','LogoStage','LogoFile','AlternateLogoList','LogoBackground','LogoCorners','BrandFont']) {
    assert.match(companyMarkup, new RegExp(`id="cs${id}"`));
    assert.match(studioMarkup, new RegExp(`id="ds${id}"`));
  }
  assert.match(studioMarkup, /class="company-brand-stack"[\s\S]*id="dsPaletteStrip"[\s\S]*id="dsBrandFont"[\s\S]*id="dsLogoStage"/);
  assert.match(portal, /brand-kit\/brand-kit\.js[\s\S]*?settings\/company\.js/);
  assert.match(company, /PlatformBrandKit\.markup\(\{ prefix:'cs'/);
  assert.match(studio, /PlatformBrandKit\.markup\(\{ prefix:'ds'/);
  assert.doesNotMatch(studio, /data-brand-save/);
});

test('Brand Kit resolves the saved company logo across branding layers', () => {
  const window = { PlatformAPI:{ media:{ fileUrl:(org, media) => `/v1/platform/organizations/${org}/media/${media}/original` } } };
  runInNewContext(library, { window, document:{}, URL });
  const resolve = window.PlatformBrandKit.resolveLogo;
  assert.equal(resolve('org-1', { logo_media_id:'media-1' }), '/v1/platform/organizations/org-1/media/media-1/original');
  assert.equal(resolve('org-1', { logo_node_url:'/v1/platform/organizations/org-1/media/media-2/logo' }), '/v1/platform/organizations/org-1/media/media-2/logo');
  assert.equal(resolve('org-1', { logo:'/v1/platform/organizations/org-1/media/media-2/logo' }, { logo:'/organizations/org-1/logo.png' }), '/v1/platform/organizations/org-1/media/media-2/logo');
  assert.equal(resolve('org-1', { logo:'/images/logo_red.png' }), '');
});
