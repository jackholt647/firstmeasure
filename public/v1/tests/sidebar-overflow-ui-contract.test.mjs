import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';

const publicRoot = path.resolve(import.meta.dirname, '..', '..');
const [portal, core] = await Promise.all([
  readFile(path.join(publicRoot, 'portal/index.php'), 'utf8'),
  readFile(path.join(publicRoot, 'portal/scripts/core.js'), 'utf8')
]);

test('the app list owns sidebar overflow while banners and launchers remain fixed', () => {
  assert.match(portal, /\.sidebar-scroll\{[\s\S]{0,260}flex:1 1 auto;[\s\S]{0,120}min-height:0;[\s\S]{0,120}overflow:hidden;/);
  assert.match(core, /#sidebarMainLinks\{[\s\S]{0,220}flex:1 1 auto;[\s\S]{0,160}overflow-y:auto;/);
  assert.match(portal, /\.sidebar-attention-slot\{flex:0 0 auto;/);

  const appsPanel = portal.indexOf('id="sidebarAppsPanel"');
  const attentionSlot = portal.indexOf('id="sidebarAttentionSlot"');
  const bottomLinks = portal.indexOf('id="sidebarBottomLinks"');
  assert.ok(appsPanel >= 0 && appsPanel < attentionSlot && attentionSlot < bottomLinks);
});

test('directional controls follow available height and app-list scroll position', () => {
  assert.match(portal, /id="sidebarAppsScrollUp"[^>]+aria-label="Scroll apps up"/);
  assert.match(portal, /id="sidebarAppsScrollDown"[^>]+aria-label="Scroll apps down"/);
  assert.match(core, /const maxScroll = Math\.max\(0, list\.scrollHeight - list\.clientHeight\)/);
  assert.match(core, /const canScrollUp = overflowing && list\.scrollTop > 1/);
  assert.match(core, /const canScrollDown = overflowing && list\.scrollTop < maxScroll - 1/);
  assert.match(core, /up\.hidden = !canScrollUp/);
  assert.match(core, /down\.hidden = !canScrollDown/);
  assert.match(portal, /#sidebarAppsScrollUp\{[\s\S]{0,260}linear-gradient\(to bottom/);
  assert.match(portal, /#sidebarAppsScrollDown\{[\s\S]{0,260}linear-gradient\(to top/);
  assert.match(core, /new ResizeObserver\(update\)/);
  assert.match(core, /new MutationObserver\(update\)/);
});
