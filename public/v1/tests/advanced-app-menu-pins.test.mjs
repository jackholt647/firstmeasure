// The apps overlay's pin edit mode, phone layout and instant pin saves (FM-480).
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';

const publicRoot = path.resolve(import.meta.dirname, '..', '..');
const [core, platformApi] = await Promise.all([
  readFile(path.join(publicRoot, 'portal/scripts/core.js'), 'utf8'),
  readFile(path.join(publicRoot, 'libraries/platform-api/platform-api.js'), 'utf8')
]);

const slice = (from, to) => {
  const start = core.indexOf(from);
  const end = core.indexOf(to, start);
  assert.ok(start >= 0 && end > start, `core.js has ${from}`);
  return core.slice(start, end);
};

// Runs core.js's real placement saver against a stub PlatformAPI.appFlags.
function placementSaver({ server }){
  const source = slice('  function stableJson(value){', '\n  }\n') + '\n  }\n'
    + slice('  const placementSaves = ', '  window.Portal.appFlags = {');
  const events = [];
  const sent = [];
  const orders = [];
  let cache = { app_placements: { ...server.placements }, app_order: [...(server.order || [])] };
  const api = {
    current: () => cache,
    applyPlacements: (placements, order) => { cache = { ...cache, app_placements: { ...placements }, ...(Array.isArray(order) ? { app_order: [...order] } : {}) }; return cache; },
    updatePlacements: async (orgId, placements, order) => {
      sent.push({ ...placements });
      orders.push(order);
      await server.answer(placements);
      cache = { app_placements: { ...placements }, app_order: [...(order || [])] };
      return cache;
    }
  };
  const window = {
    PlatformAPI: { appFlags: api },
    dispatchEvent: (event) => events.push(event.detail.app_placements ? { ...event.detail.app_placements } : null)
  };
  class CustomEvent { constructor(type, init){ this.type = type; this.detail = init?.detail; } }
  const run = new Function('window', 'APP', 'CustomEvent', `let lastAppFlagsKey = '';\n${source}\nreturn savePlacementsOptimistically;`);
  return { save: run(window, { userOrgId:'org_test' }, CustomEvent), events, sent, orders, shown: () => cache.app_placements, order: () => cache.app_order };
}

test('a pin shows before the server answers and rapid pins save one at a time with the newest placements', async () => {
  const pending = [];
  const server = { placements: { 'portal.crm':'sidebar' }, answer: () => new Promise((resolve) => pending.push(resolve)) };
  const saver = placementSaver({ server });
  const first = saver.save({ 'portal.crm':'more' });
  assert.deepEqual(saver.shown(), { 'portal.crm':'more' });
  assert.deepEqual(saver.events.at(-1), { 'portal.crm':'more' }, 'the left column re-renders at once');
  const second = saver.save({ 'portal.crm':'more', 'portal.feed':'sidebar' });
  const third = saver.save({ 'portal.crm':'more', 'portal.feed':'more' });
  assert.deepEqual(saver.shown(), { 'portal.crm':'more', 'portal.feed':'more' });
  assert.equal(saver.sent.length, 1, 'one save in flight');
  pending.shift()();
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(saver.shown(), { 'portal.crm':'more', 'portal.feed':'more' }, 'a finished save does not undo a newer pin');
  assert.equal(saver.sent.length, 2);
  assert.deepEqual(saver.sent[1], { 'portal.crm':'more', 'portal.feed':'more' }, 'queued pins collapse into the newest placements');
  pending.shift()();
  await Promise.all([first, second, third]);
});

test('a failed save puts back what the server last confirmed and every caller hears the failure', async () => {
  const server = { placements: { 'portal.crm':'sidebar' }, answer: () => Promise.reject(new Error('Saving failed')) };
  const saver = placementSaver({ server });
  const first = saver.save({ 'portal.crm':'more' });
  const second = saver.save({ 'portal.crm':'more', 'portal.feed':'sidebar' });
  assert.deepEqual(saver.shown(), { 'portal.crm':'more', 'portal.feed':'sidebar' });
  await assert.rejects(first, /Saving failed/);
  await assert.rejects(second, /Saving failed/);
  assert.deepEqual(saver.shown(), { 'portal.crm':'sidebar' });
  assert.deepEqual(saver.events.at(-1), { 'portal.crm':'sidebar' }, 'the rollback re-renders');
});

test('a new app order shows at once, is saved with the placements, and a pin keeps it (GP-52)', async () => {
  const server = { placements: { 'portal.crm':'sidebar', 'portal.feed':'sidebar' }, order: ['portal.crm', 'portal.feed'], answer: async () => {} };
  const saver = placementSaver({ server });
  const reorder = saver.save({ 'portal.crm':'sidebar', 'portal.feed':'sidebar' }, ['portal.feed', 'portal.crm']);
  assert.deepEqual(saver.order(), ['portal.feed', 'portal.crm'], 'the left column moves before the save');
  await reorder;
  assert.deepEqual(saver.orders.at(-1), ['portal.feed', 'portal.crm']);
  await saver.save({ 'portal.crm':'more', 'portal.feed':'sidebar' });
  assert.deepEqual(saver.orders.at(-1), ['portal.feed', 'portal.crm'], 'a save without an order sends the current one');
});

test('a failed reorder puts back the order the server last confirmed (GP-52)', async () => {
  const server = { placements: { 'portal.crm':'sidebar', 'portal.feed':'sidebar' }, order: ['portal.crm', 'portal.feed'], answer: () => Promise.reject(new Error('Saving failed')) };
  const saver = placementSaver({ server });
  const reorder = saver.save({ 'portal.crm':'sidebar', 'portal.feed':'sidebar' }, ['portal.feed', 'portal.crm']);
  assert.deepEqual(saver.order(), ['portal.feed', 'portal.crm']);
  await assert.rejects(reorder, /Saving failed/);
  assert.deepEqual(saver.order(), ['portal.crm', 'portal.feed']);
});

test('the platform API can show placements and the app order before saving them', () => {
  assert.match(platformApi, /applyPlacements\(placements = \{\}, order\)\{\s+if \(!cache\) return null;\s+cache = \{ \.\.\.cache, app_placements: normalizePlacements\(placements\), \.\.\.\(Array\.isArray\(order\) \? \{ app_order: normalizeAppOrder\(order\) \} : \{\}\) \};/);
  assert.match(platformApi, /app_order: normalizeAppOrder\(result\?\.app_order\)/);
  assert.match(platformApi, /\.\.\.\(Array\.isArray\(order\) \? \{ app_order: normalizeAppOrder\(order\) \} : \{\}\) \}\s+\}\);/, 'updatePlacements sends the order');
  assert.match(core, /if \(window\.PlatformAPI\.appFlags\.applyPlacements\) return savePlacementsOptimistically\(placements, order\);/);
});

// Runs core.js's real left-column sort against tabs and an organization order.
function sorter(order){
  const source = slice('  function portalTabUseRank(tab){', '  // The apps in the left column, top first');
  const window = { PlatformAPI: { appFlags: { current: () => ({ app_order: order }) } } };
  const cleanText = (...values) => values.map((value) => String(value ?? '').trim()).find(Boolean) || '';
  return new Function('window', 'cleanText', 'portalAppPill', `${source}\nreturn sortPortalTabs;`)(window, cleanText, (appId) => appId === 'portal.new' ? { kind:'new' } : null);
}

test('the left column follows the organization order, its first app is the home app (GP-52)', () => {
  const tabs = [
    { id:'projects', appId:'portal.projects', placement:'sidebar', order:1 },
    { id:'crm', appId:'portal.crm', placement:'sidebar', order:2 },
    { id:'new', appId:'portal.new', placement:'sidebar', order:3 },
    { id:'feed', appId:'portal.feed', placement:'more', order:0 },
    { id:'settings', appId:'portal.settings', placement:'settings', order:0 }
  ];
  const ids = (order) => sorter(order)(tabs).map((tab) => tab.id);
  assert.deepEqual(ids([]), ['projects', 'crm', 'new', 'feed', 'settings'], 'no order keeps the default');
  assert.deepEqual(ids(['portal.new', 'portal.crm']), ['new', 'crm', 'projects', 'feed', 'settings'], 'listed apps lead, even a new one; unlisted follow');
  assert.deepEqual(ids(['portal.feed', 'portal.crm']), ['crm', 'projects', 'new', 'feed', 'settings'], 'an unpinned app in the order stays out of the left column');
  const render = slice('  function renderTabs(){', '  function ensurePortalTabLoadingStyles(){');
  assert.match(core, /function defaultPortalTab\(list = \[\]\)\{[\s\S]{0,400}return list\[0\]\?\.id \|\| null;/, 'the portal opens the top app');
  assert.match(render, /orderIndex === 0 \? `<span class="fm-sidebar-app-home"/, 'the top app shows the house');
  assert.match(render, /data-sidebar-app-move="-1"[\s\S]{0,400}data-sidebar-app-move="1"/, 'up and down arrows');
  assert.match(render, /moveSidebarApp\(appId, Number\(button\.dataset\.sidebarAppMove\)\)/);
});

test('More apps orders pinned tiles like the left column and lists the left column sections (GP-52)', async () => {
  const render = slice('  function renderAdvancedAppMenu(', '  function openAdvancedAppMenu(');
  assert.match(render, /\(a\.pinned && b\.pinned \? pinnedRank\(a\) - pinnedRank\(b\) : 0\)/);
  assert.match(render, /entry\.pinned && entry\.appId === homeAppId \? `<i class="fas fa-house fm-advanced-app-home"/);
  const open = slice('  function openAdvancedAppMenu(', '  function initSidebarAppScrolling(');
  assert.match(open, /setSidebarPanel\('apps'\);[\s\S]{0,80}renderSidebarSections\(\);/, 'opening More apps shows the apps and the section switches');
  const sections = slice('  function sidebarSectionsMarkup(){', '  // Once the left column has an order');
  assert.match(sections, /const offered = \(mode\) => mode\.tab && sidebarSectionAvailable\(mode\.key\)/, 'a section that is off is still listed');
  assert.match(sections, /mode\.key !== 'channels' \|\| \(window\.Portal\?\.can\?\.\('apps\.channels'\) === true && launcherAppInExperience\(\{ appId:'portal\.channels' \}\)\)/, 'Channels is offered only once this person has Channels');
  assert.match(sections, /role="switch" aria-checked=/);
  assert.doesNotMatch(sections, /left_column_settings/, 'More apps offers the switches wherever it is on (the MVP platform has personal left column settings off)');
  assert.match(slice('  function renderTabs(){', '  function ensurePortalTabLoadingStyles(){'), /portalAppPill\(t\.appId\)\.kind === 'setup' \? sidebarSetupPillLabel\(\)/, 'the left column says Setup, not Setup required');
  const pins = await readFile(path.join(publicRoot, 'libraries/left-column-pins/left-column-pins.js'), 'utf8');
  assert.match(pins, /\.fm-advanced-app-tile\.has-subviews:has\(:focus-visible\) \.fm-advanced-app-subviews\{visibility:visible/, 'the first tile\'s focus on open does not roll out its views');
  assert.doesNotMatch(pins, /has-subviews:focus-within \.fm-advanced-app-subviews\{/);
  assert.match(sections, /const lastOn = mode\.enabled && onCount < 2;/, 'the last section on stays on');
  assert.match(sections, /window\.PlatformAPI\.preferences\.patch\(\{ \[preference\]: value \}\)/, 'a switch is the personal preference');
  assert.match(core, /\.sidebar\.sidebar-advanced-apps-open:not\(\.sidebar-manual\) \.fm-sidebar-sections/);
  const drag = slice('  function startSidebarAppDrag(event){', '  function moveSidebarApp(appId, offset){');
  assert.match(drag, /event\.pointerType === 'touch'/, 'touch scrolls; the arrows move apps there');
  assert.match(drag, /link\.closest\('\.sidebar-advanced-apps-open'\)/, 'dragging only reorders in More apps');
});

test('More apps switches the left column between thin and wide and plays its tour once (GP-52)', () => {
  const render = slice('  function renderAdvancedAppMenu(', '  function openAdvancedAppMenu(');
  assert.match(render, /data-advanced-sidebar-width="thin"[\s\S]{0,600}data-advanced-sidebar-width="wide"/);
  assert.match(render, /setLeftColumnWidthMode\(button\.dataset\.advancedSidebarWidth\)/);
  assert.match(render, /\$\{thinColumn && sectionsMarkup \? `<div class="fm-advanced-apps-sections"/, 'a thin column has its section switches beside Thin and Wide');
  const width = slice('  function setLeftColumnWidthMode(mode){', '\n  }\n');
  assert.match(width, /mode === 'thin' \? 'tooltip' : 'forced_expanded'/, 'thin is instant tooltips, wide is always expanded');
  assert.match(width, /saveSidebarPreference\('left_column_behavior', behavior\)/, 'the width is the personal sidebar behavior');
  assert.match(core, /@media\(max-width:820px\)\{\.fm-advanced-apps-column\{display:none\}\}/, 'desktop only');
  assert.match(core, /if \(behavior !== 'adaptive' && !document\.body\.classList\.contains\('fm-advanced-app-menu-open'\)\) sidebar\.classList\.remove\('sidebar-advanced-apps-open'\);/,
    'a thin or wide column keeps its More apps controls');
  // Collapsing the column with its own control kept More apps open but dropped its pins, and the overlay kept the
  // wide column's edge (GP-52, Jack's screenshot).
  assert.match(slice('  function setSidebarCompactExpanded(expanded){', '\n  }\n'), /if \(!document\.body\.classList\.contains\('fm-advanced-app-menu-open'\)\) sidebar\?\.classList\.remove\('sidebar-advanced-apps-open'\);/);
  assert.match(render, /if \(sidebar\) resizeObserver\.observe\(sidebar\);/, 'the overlay edge follows the column');
  assert.match(render, /sidebar\?\.addEventListener\('transitionend', setSidebarEdge, \{ signal \}\);/);
  assert.match(render, /const thinColumn = sidebarShownThin\(\);/, 'Thin and Wide show what the column looks like now');
  assert.match(slice('  function sidebarShownThin(){', '\n  }\n'), /!sidebar\.classList\.contains\('sidebar-compact-expanded'\)/);
  const tour = slice('  function offerMoreAppsTour(){', '\n  }\n');
  assert.match(tour, /if \(moreAppsTourAsked \|\| typeof window\.FirstMateGuides\?\.play !== 'function'\) return;/);
  assert.match(tour, /window\.FirstMateGuides\.play\('platform\.more_apps_tour'\)/);
  assert.match(slice('  function openAdvancedAppMenu(', '  function offerMoreAppsTour(){'), /renderAdvancedAppMenu\(launcher\);\s+offerMoreAppsTour\(\);/);
});

test('the overlay pins without waiting: edit mode, tap to pin, long press, stable order', () => {
  const render = slice('  function renderAdvancedAppMenu(', '  function openAdvancedAppMenu(');
  assert.doesNotMatch(render, /await updateAdvancedAppPin/, 'no pin waits for the server before the tile changes');
  assert.match(render, /tile\.classList\.toggle\('is-pinned', pinned\);[\s\S]{0,400}updateAdvancedAppPin\(appId, pinned\)/);
  assert.match(render, /data-advanced-apps-edit/);
  assert.match(render, /"m_e29e003014f22e","Edit pins"/);
  assert.match(render, /"m_03ae7f7f0d0d32","Tap apps to pin or unpin them\."/);
  assert.match(render, /if \(advancedAppMenuEditing && entry\?\.pinnable\) toggleAppPin\(entry\.appId\);/);
  assert.match(render, /event\.pointerType !== 'touch'[\s\S]{0,600}setEditing\(true\)/, 'touch and hold starts edit mode');
  assert.match(render, /if \(advancedAppMenuEditing\) setEditing\(false\);\s+else closeAdvancedAppMenu\(\);/, 'Escape leaves edit mode first');
  assert.match(render, /if \(!advancedAppMenuOrder\) advancedAppMenuOrder = sorted\.map/, 'tiles keep their places while the overlay is open');
  assert.match(render, /firstRender && !window\.matchMedia\?\.\('\(pointer: coarse\)'\)\.matches/, 'a phone does not light up the first tile');
  assert.match(core, /\.fm-advanced-apps-overlay\.is-editing \.fm-advanced-app-tile\{[^}]*animation:fmAdvancedAppWobble/);
  assert.match(core, /\.fm-advanced-apps-overlay\.is-editing \.fm-advanced-app-pin\{visibility:visible;opacity:1;pointer-events:auto/);
  assert.match(core, /prefers-reduced-motion:reduce\)\{[^}]*\.fm-advanced-apps-overlay\.is-editing \.fm-advanced-app-tile/);
});

test('phones get at least three columns of large tiles that scroll, with whole-word labels', () => {
  const render = slice('  function renderAdvancedAppMenu(', '  function openAdvancedAppMenu(');
  assert.match(render, /const compact = window\.matchMedia\?\.\('\(max-width: 820px\)'\)\.matches === true;/);
  assert.match(render, /const columns = Math\.max\(3, Math\.min\(6,/);
  assert.match(render, /label\.scrollWidth > label\.clientWidth \+ 1 && size > 9\.5/);
  assert.match(core, /\.fm-advanced-apps-overlay\.is-compact \.fm-advanced-apps-scroll\{[^}]*overflow-y:auto/);
  assert.match(core, /\.fm-advanced-apps-overlay\.is-compact \.fm-advanced-apps-grid\{[^}]*grid-template-columns:repeat\(var\(--fm-advanced-columns,3\),minmax\(0,1fr\)\)/);
  assert.match(core, /\.fm-advanced-apps-overlay\.is-compact \.fm-advanced-app-open strong\{[^}]*overflow-wrap:normal/);
});
