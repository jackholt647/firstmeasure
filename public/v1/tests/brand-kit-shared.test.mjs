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
  assert.match(portal, /brand-kit\/brand-kit\.js[\s\S]*?settings\/company\.js/);
  assert.match(company, /PlatformBrandKit\.markup\(\{ prefix:'cs'/);
  assert.match(studio, /PlatformBrandKit\.markup\(\{ prefix:'ds'/);
  assert.doesNotMatch(studio, /data-brand-save/);
});
