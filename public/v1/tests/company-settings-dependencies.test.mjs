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

test('Company font saves preserve branding and support separate or unified title fonts', async () => {
  const company = await source('libraries/apps/settings/company.js');
  const start = company.indexOf('  async function saveOrg(');
  const end = company.indexOf('  async function saveReportSettings(', start);
  const saved = [];
  const window = { PlatformAPI: {
    branches: {
      get: async () => ({ data: { unrelated:'retained', branding:{logo:'/existing.svg',typography:{custom:'retained'}} } }),
      save: async (_org,_branch,data) => saved.push(data)
    },
    branchModules: {
      get: async () => ({ data:{other:'retained',branding:{logo:'/existing.svg',typography:{custom:'retained'}}} }),
      save: async (_org,_branch,_module,data) => saved.push(data)
    }
  } };
  const save = runInNewContext(`${company.slice(start,end)}; saveOrg`, {
    window, currentOrgId:()=>'org',currentBranchId:()=>'default',DEFAULT_LOGO:'/images/logo_red.png',
    companyLogoForSave:()=>'/fallback.svg',normalizeLogoDisplay:value=>value || {},
    normalizeOrganizationBusinessAddress:value=>value,normalizeBrandPalette:value=>value
  });
  for (const title_font of ['Poppins','']) {
    assert.equal((await save({font_family:'Inter',title_font,palette:['#112233'],logo_display:{shape:'circle'}})).ok,true);
    for (const data of saved.slice(-2)) {
      assert.equal(data.branding.logo,'/existing.svg');
      assert.equal(data.branding.typography.custom,'retained');
      assert.equal(data.branding.typography.document_font_family,'Inter');
      assert.equal(data.branding.typography.body_font_family,'Inter');
      assert.equal(data.branding.typography.display_font_family,title_font);
      assert.equal(data.branding.typography.heading_font_family,title_font);
    }
  }
});
