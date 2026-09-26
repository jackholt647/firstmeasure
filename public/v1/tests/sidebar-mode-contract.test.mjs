import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';

const publicRoot = path.resolve(import.meta.dirname, '..', '..');
const portalIndex = await readFile(path.join(publicRoot, 'portal/index.php'), 'utf8');
const portalCore = await readFile(path.join(publicRoot, 'portal/scripts/core.js'), 'utf8');
const capabilityDefs = await readFile(path.join(publicRoot, 'v1/platform/capability_defs.ts'), 'utf8');
const companySettings = await readFile(path.join(publicRoot, 'libraries/apps/settings/company.js'), 'utf8');
const documentStudio = await readFile(path.join(publicRoot, 'libraries/apps/documents/studio.js'), 'utf8');
const webEditor = await readFile(path.join(publicRoot, 'libraries/apps/web-editor/app.js'), 'utf8');
const webEditorCss = await readFile(path.join(publicRoot, 'libraries/apps/web-editor/web-editor.css'), 'utf8');

test('portal exposes a reusable compact sidebar mode', () => {
  assert.match(portalCore, /window\.Portal\.sidebarMode\s*=\s*\{/);
  assert.match(portalCore, /requestCompact:\s*requestCompactSidebar/);
  assert.match(portalCore, /releaseCompact:\s*releaseCompactSidebar/);
  assert.match(portalCore, /setExpanded:\s*setSidebarCompactExpanded/);
  assert.match(portalCore, /sidebarCompactOwners\.size\s*>\s*0/);
  assert.match(portalCore, /handles\.get\(prevId\)\?\.setActive\?\.\(false\)/);
});

test('compact sidebar remains a flex-layout rail and expands on hover', () => {
  assert.match(portalIndex, /--sidebar-compact:48px/);
  assert.match(portalIndex, /\.sidebar\.sidebar-compact\{width:var\(--sidebar-compact\)\}/);
  assert.match(portalIndex, /\.sidebar\.sidebar-compact:hover,[\s\S]*?width:var\(--sidebar\)/);
  assert.match(portalIndex, /logo_square\.png/);
  assert.match(portalIndex, /id="sidebarCompactToggle"/);
  assert.match(portalIndex, /sidebar-new-mini-icon/);
  assert.doesNotMatch(portalIndex, /sidebar-mode-compact-arrow|sidebar-mode-icon/);
  assert.match(portalIndex, /sidebar-compact[^}]*?\.sidebar-mode-tabs\{display:none\}/s);
  assert.match(portalIndex, /#sidebarMainLinks\{[\s\S]*?overflow-y:auto/);
});

test('temporary compact expansion can overlap while pinned expansion still pushes', () => {
  assert.match(portalCore, /left_column_expansion_mode/);
  assert.match(portalCore, /sidebar-compact-overlap/);
  assert.match(portalIndex, /sidebar-compact-overlap:hover:not\(\.sidebar-compact-expanded\)/);
  assert.match(portalIndex, /margin-right:calc\(var\(--sidebar-compact\) - var\(--sidebar\)\)/);
});

test('feature flags can make the compact rail global', () => {
  assert.match(portalCore, /always_collapsible_left_column/);
  assert.match(portalCore, /GLOBAL_COMPACT_SIDEBAR_OWNER/);
  assert.match(portalCore, /applySidebarLayoutFeatureFlags\(\)/);
});

test('the arrow lock state persists locally per organization and user', () => {
  assert.match(portalCore, /SIDEBAR_COMPACT_STATE_STORAGE_KEY[\s\S]*?APP\.userOrgId[\s\S]*?APP\.userId/);
  assert.match(portalCore, /localStorage\?\.getItem\(SIDEBAR_COMPACT_STATE_STORAGE_KEY\) === '1'/);
  assert.match(portalCore, /localStorage\?\.setItem\(SIDEBAR_COMPACT_STATE_STORAGE_KEY, expanded \? '1' : '0'\)/);
  assert.match(portalCore, /function setSidebarCompactExpanded\(expanded\)[\s\S]*?saveSidebarCompactExpandedPreference\(sidebarCompactExpanded\)/);
  assert.doesNotMatch(portalCore, /if \(!compact\) sidebarCompactExpanded = false/);
});

test('My Settings owns left-column layout controls', () => {
  assert.doesNotMatch(capabilityDefs, /key: "platform\.left_column_expansion_mode"/);
  assert.match(companySettings, /data-my-left-column-expansion-mode/);
  assert.match(companySettings, /data-my-always-collapsible-left-column/);
});

test('compact sidebar ignores a pointer exit through the browser left edge', () => {
  assert.match(portalIndex, /sidebar-compact\.sidebar-compact-edge-held[\s\S]*?width:var\(--sidebar\)/);
  assert.match(portalIndex, /:not\(\.sidebar-compact-edge-held\):not\(\.sidebar-compact-expanded\)/);
  assert.match(portalCore, /event\.relatedTarget === null && event\.clientX <= leftEdge/);
  assert.match(portalCore, /classList\.add\('sidebar-compact-edge-held'\)/);
  assert.match(portalCore, /addEventListener\('mouseenter',[\s\S]*?classList\.remove\('sidebar-compact-edge-held'\)/);
});

test('Doc Studio owns compact mode only while an editor is active', () => {
  assert.match(documentStudio, /requestCompact\?\.\('documents\.studio\.editor'\)/);
  assert.match(documentStudio, /function closeTemplateEditor\(\)[\s\S]*?releaseEditorSidebar\(\)/);
  assert.match(documentStudio, /function closeWorkflowEditor\(\)[\s\S]*?releaseEditorSidebar\(\)/);
  assert.match(documentStudio, /function closeThemeEditor\(\)[\s\S]*?releaseEditorSidebar\(\)/);
  assert.match(documentStudio, /if \(!state\.active\) releaseEditorSidebar\(\)/);
  assert.match(documentStudio, /destroy\(\)\{[\s\S]*?releaseEditorSidebar\(\)/);
});

test('Web Editor uses the shared sidebar mode instead of covering portal chrome', () => {
  assert.match(webEditor, /requestCompact\?\.\('web-editor\.page-editor'\)/);
  assert.match(webEditor, /async function openEditor\(\)\{[\s\S]*?requestEditorSidebar\(\)/);
  assert.match(webEditor, /function gotoSites\(\)\{[\s\S]*?releaseEditorSidebar\(\)/);
  assert.match(webEditor, /function gotoSite\(siteId, options = \{\}\)\{[\s\S]*?releaseEditorSidebar\(\)/);
  assert.doesNotMatch(webEditor, /function destroyEditor\(\)\{\s*releaseEditorSidebar\(\)/);
  assert.match(webEditor, /if \(!state\.active\) releaseEditorSidebar\(\)/);
  assert.match(webEditorCss, /\.fmwe-editor\.fullscreen\s*\{\s*position:\s*absolute;/);
  assert.doesNotMatch(webEditorCss, /\.fmwe-editor\.fullscreen\s*\{\s*position:\s*fixed;/);
});
