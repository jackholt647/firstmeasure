// The portal's left column puts apps people use first, then apps still waiting on setup ("Setup"), then apps
// not started yet ("New"), each by the tab's order (FM-479). The sort is read from public/portal/scripts/core.js.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..');
const source = fs.readFileSync(path.join(root, 'public/portal/scripts/core.js'), 'utf8');

function functionSource(name){
  const start = source.indexOf(`  function ${name}(`);
  assert.ok(start >= 0, `core.js defines ${name}`);
  const end = source.indexOf('\n  }\n', start);
  return source.slice(start, end + 4);
}

function sorter(pills){
  const portalAppPill = (appId) => pills[appId] ? { kind: pills[appId] } : null;
  const cleanText = (value) => String(value ?? '').trim();
  return new Function('portalAppPill', 'pinnedAppOrder', 'cleanText', `${functionSource('portalTabUseRank')}\n${functionSource('sortPortalTabs')}\nreturn sortPortalTabs;`)(portalAppPill, () => [], cleanText);
}

const tab = (id, order, placement = 'sidebar') => ({ id, appId: `portal.${id}`, order, placement });

test('new and setup-pending apps sit below the apps in use', () => {
  const tabs = [
    tab('projects', 10), tab('channels', 20), tab('invoices', 30), tab('scheduling', 40),
    tab('money', 50), tab('crm', 60), tab('company_settings', 5, 'settings'), tab('extra', 1, 'more')
  ];
  const sort = sorter({ 'portal.channels': 'new', 'portal.invoices': 'new', 'portal.money': 'setup', 'portal.crm': 'coming_soon', 'portal.extra': 'new' });
  assert.deepEqual(sort(tabs).map((t) => t.id),
    ['projects', 'scheduling', 'crm', 'money', 'channels', 'invoices', 'extra', 'company_settings']);
});

test('with no pills the order is placement, then the tab order', () => {
  const tabs = [tab('b', 2), tab('s', 0, 'settings'), tab('a', 1), tab('m', 0, 'more')];
  assert.deepEqual(sorter({})(tabs).map((t) => t.id), ['a', 'b', 'm', 's']);
});

test('renderTabs and the pinned subviews both use the shared sort', () => {
  assert.match(functionSource('renderTabs'), /sortPortalTabs\(/);
  assert.match(functionSource('insertSidebarSubviewLinks'), /sortPortalTabs\(/);
  // No second copy of the old placement-then-order sort that ignores the pills.
  assert.doesNotMatch(source, /\?\? 3\) \|\| a\.order - b\.order/);
});

// GP-70: "New" on the More apps launcher when an app only in the apps menu is new; never for "Setup" or a pinned app.
test('the More apps launcher says New only for a new app outside the left column', () => {
  const launcherPill = (entries, pills) => new Function('appLauncherEntries', 'portalAppPill',
    `${functionSource('moreAppsNewPill')}\nreturn moreAppsNewPill();`)(() => entries, (id) => pills[id] ? { kind: pills[id], label: pills[id] } : null);
  const entry = (key, placement) => ({ key, placement });
  assert.equal(launcherPill([entry('portal.crm', 'sidebar')], { 'portal.crm': 'new' }), null);
  assert.equal(launcherPill([entry('portal.pricebook', 'more')], { 'portal.pricebook': 'setup' }), null);
  assert.equal(launcherPill([entry('portal.pricebook', 'more')], { 'portal.pricebook': 'coming_soon' }), null);
  assert.equal(launcherPill([entry('portal.money', 'more'), entry('portal.pricebook', 'more')], { 'portal.money': 'setup', 'portal.pricebook': 'new' })?.kind, 'new');
  assert.match(functionSource('renderSidebarLaunchers'), /moreAppsNewPill\(\)/);
});
