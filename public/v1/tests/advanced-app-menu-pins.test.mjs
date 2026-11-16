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
  let cache = { app_placements: { ...server.placements } };
  const api = {
    current: () => cache,
    applyPlacements: (placements) => { cache = { ...cache, app_placements: { ...placements } }; return cache; },
    updatePlacements: async (orgId, placements) => {
      sent.push({ ...placements });
      await server.answer(placements);
      cache = { app_placements: { ...placements } };
      return cache;
    }
  };
  const window = {
    PlatformAPI: { appFlags: api },
    dispatchEvent: (event) => events.push(event.detail.app_placements ? { ...event.detail.app_placements } : null)
  };
  class CustomEvent { constructor(type, init){ this.type = type; this.detail = init?.detail; } }
  const run = new Function('window', 'APP', 'CustomEvent', `let lastAppFlagsKey = '';\n${source}\nreturn savePlacementsOptimistically;`);
  return { save: run(window, { userOrgId:'org_test' }, CustomEvent), events, sent, shown: () => cache.app_placements };
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

test('the platform API can show placements before saving them', () => {
  assert.match(platformApi, /applyPlacements\(placements = \{\}\)\{\s+if \(!cache\) return null;\s+cache = \{ \.\.\.cache, app_placements: normalizePlacements\(placements\) \};/);
  assert.match(core, /if \(window\.PlatformAPI\.appFlags\.applyPlacements\) return savePlacementsOptimistically\(placements\);/);
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
