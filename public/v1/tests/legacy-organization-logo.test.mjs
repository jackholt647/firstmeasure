// 1M8-242: reports of accounts imported from legacy showed no logo. Their default branch branding
// keeps the legacy key "organizations/<org>/logo.png", which outranked the platform logo URL in their
// global branding, and no production host has that file. The editor bundle handed the PDF the bare
// key, which does not load. Values below are Masters Roofing's production branding (2026-10-23).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import path from 'node:path';
import ts from 'typescript';

const source = fs.readFileSync(new URL('../firstmeasure/api.ts', import.meta.url), 'utf8');
const names = ['firstLogoValue', 'isAbsoluteOrDataUrl', 'toOptionalString', 'asRecord', 'mergeOrganizationContext',
  'normalizeOrganizationBrandingContext', 'resolvePortalOrganizationLogo', 'organizationLogoSlotUrl'];
function load({ media = {}, files = {} } = {}) {
  const tree = ts.createSourceFile('api.ts', source, ts.ScriptTarget.Latest, true), found = [];
  (function visit(n) { if (ts.isFunctionDeclaration(n) && names.includes(n.name?.text)) found.push(n.getText(tree)); ts.forEachChild(n, visit); })(tree);
  assert.equal(found.length, names.length);
  const js = ts.transpileModule(found.join('\n'), { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
  const context = {
    path: path.posix, INTERNAL_ROOT_DIR: '/internal', INTERNAL_ORGANIZATIONS_DIR: '/internal/organizations',
    readImageDataUrlIfExists: async (file) => files[file] ?? null,
    readMediaMetadata: async (orgId, mediaId) => { const m = media[`${orgId}/${mediaId}`]; if (!m) throw new Error('media_not_found'); return m; }
  };
  vm.createContext(context);
  vm.runInContext(js, context);
  return context;
}

const org = 'ed7788597b0aef0e8e81d694';
const legacyKey = `organizations/${org}/logo.png`;
const mediaUrl = `/v1/platform/organizations/${org}/media/organization_${org}_logo/logo`;
const logoSlot = { [`${org}/organization_${org}_logo`]: { slot: 'logo', owner: { type: 'organization', slot: 'logo' } } };
// Merged branding (branch over global over legacy snapshots), as readPlatformOrganizationBrandingContext builds it.
const importedBranding = { logo: legacyKey, logo_node_url: mediaUrl, logo_url: mediaUrl, colors: { primary: '#3050a0' } };

test('an imported account with a platform logo URL reports that URL, not the legacy key', async () => {
  const api = load({ media: logoSlot });
  const picked = api.firstLogoValue(importedBranding, {});
  assert.equal(picked, mediaUrl);
  assert.equal(await api.resolvePortalOrganizationLogo(picked, org), mediaUrl);
});

test('an imported account with only the legacy key reports its logo media slot', async () => {
  const api = load({ media: logoSlot });
  assert.equal(await api.resolvePortalOrganizationLogo(legacyKey, org), mediaUrl);
  // Without a logo-slot media the key is returned unchanged, as before.
  assert.equal(await load().resolvePortalOrganizationLogo(legacyKey, org), legacyKey);
  const notLogo = { [`${org}/organization_${org}_logo`]: { slot: 'gallery', owner: {} } };
  assert.equal(await load({ media: notLogo }).resolvePortalOrganizationLogo(legacyKey, org), legacyKey);
  // A legacy file still on disk keeps winning.
  const files = { [`/internal/${legacyKey}`]: 'data:image/png;base64,AAAA' };
  assert.equal(await load({ media: logoSlot, files }).resolvePortalOrganizationLogo(legacyKey, org), 'data:image/png;base64,AAAA');
});

test("a project's saved branding_defaults with the legacy key gives way to the platform logo", () => {
  const api = load({ media: logoSlot });
  const stored = { source: 'portal_organization_context', id: org, logo_url: legacyKey, branding: { logo: legacyKey, logo_url: legacyKey, logo_node_url: legacyKey } };
  const fresh = { source: 'portal_organization_context', id: org, logo_url: mediaUrl, branding: { logo: mediaUrl } };
  const merged = api.normalizeOrganizationBrandingContext(api.mergeOrganizationContext(stored, fresh));
  assert.equal(merged.branding.logo, mediaUrl);
  assert.equal(merged.branding.logo_url, mediaUrl);
  assert.equal(merged.branding.logo_node_url, mediaUrl);
});

test('absolute URLs and data URLs still win, and newer accounts are unchanged', () => {
  const api = load();
  const absolute = 'https://cdn.example.com/logo.png';
  assert.equal(api.firstLogoValue({ logo: legacyKey, logo_url: mediaUrl, logo_node_url: absolute }), absolute);
  assert.equal(api.firstLogoValue({ logo: mediaUrl }), mediaUrl);
  assert.equal(api.firstLogoValue({ logo: legacyKey }), legacyKey);
  assert.equal(api.firstLogoValue({}), undefined);
});
