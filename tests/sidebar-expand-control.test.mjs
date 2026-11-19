// GP-115: the thin left column has no "Keep sidebar expanded" control. It is thin or wide, switched only with
// More apps > Thin / Wide (setLeftColumnWidthMode), and nothing pins a thin column open: not the control, not a
// stored pin, not dragging its edge. Guards public/portal/scripts/core.js.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const CORE = readFileSync(new URL('../public/portal/scripts/core.js', import.meta.url), 'utf8');

test('the left column expand control stays off', () => {
  assert.match(CORE, /const SIDEBAR_EXPAND_CONTROL = false;/);
  assert.match(CORE, /if \(!SIDEBAR_EXPAND_CONTROL\) document\.getElementById\('sidebarCompactToggle'\)\?\.remove\(\);/);
});

test('nothing pins a thin left column open', () => {
  assert.match(CORE, /let sidebarCompactExpanded = SIDEBAR_EXPAND_CONTROL && loadSidebarCompactExpandedPreference\(\);/);
  assert.match(CORE, /function setSidebarCompactExpanded\(expanded\)\{\n[^\n]*\n\s*if \(!SIDEBAR_EXPAND_CONTROL\) expanded = false;/);
  assert.match(CORE, /if \(!SIDEBAR_EXPAND_CONTROL && !window\.Portal\.sidebarMode\.expanded\(\)\) return;/);
});

test('More apps switches between Thin and Wide', () => {
  assert.match(CORE, /function setLeftColumnWidthMode\(mode\)\{\n\s*const behavior = mode === 'thin' \? 'tooltip' : 'forced_expanded';/);
  assert.match(CORE, /data-advanced-sidebar-width="thin"/);
  assert.match(CORE, /data-advanced-sidebar-width="wide"/);
});
