// What people see of offline (docs/architecture/offline.md, "What people see"): the real offline-ui.js in headless
// Chrome against a fake PlatformOffline, on a page with the portal's chrome in miniature. Every indicator state,
// the tray, Retry and Discard, a conflict, the badge, the project control, device settings and sign-out.
// The engine and the worker have their own tests (offline-core.test.mjs, offline-sw-browser.test.mjs).
//   node --test tests/offline-ui-browser.test.mjs          (FMO_SHOTS=<folder> also saves screenshots)
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { readFileSync, mkdirSync } from 'node:fs';
import { createRequire } from 'node:module';

const { chromium } = createRequire(new URL('../public/v1/package.json', import.meta.url))('playwright-core');
const CHROME = process.env.CHROME_PATH || 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const SHOTS = process.env.FMO_SHOTS || '';
const UI_FILE = new URL('../public/libraries/platform-offline/offline-ui.js', import.meta.url);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** TEST ONLY: PlatformOffline as offline-ui.js sees it, with switches the tests flip (window.fake). */
const FAKE = `
(() => {
  const handlers = {};
  const S = { supported: true, controlled: true, online: true, pending: 0, failed: 0, conflicts: 0, syncing: false, blocked: null, lastSyncAt: null, savedPage: false,
    code: { release: 'r1', status: 'ready', progress: 1 },
    storage: { quota: 10 * 1073741824, usage: 48 * 1048576, reads: 6 * 1048576, media: 2 * 1048576, queued: 0, persisted: true, budgets: { reads: 150 * 1048576, media: 300 * 1048576 } } };
  let entries = [];
  let pins = [];
  const settings = { saveToCameraRoll: false, autoPinRecent: true, readsBudgetMb: 150, mediaBudgetMb: 300 };
  const calls = [];
  const copy = (value) => JSON.parse(JSON.stringify(value));
  const emit = (type, detail) => { for (const handler of [...(handlers[type] || [])]) handler(detail); };
  const count = () => {
    S.pending = entries.filter((e) => e.state === 'waiting' || e.state === 'delegated').length;
    S.failed = entries.filter((e) => e.state === 'failed' || e.state === 'parked').length;
    S.conflicts = entries.filter((e) => e.state === 'conflict').length;
  };
  window.PlatformOffline = {
    ready: Promise.resolve(copy(S)),
    state: () => copy(S),
    on(type, handler) { (handlers[type] = handlers[type] || new Set()).add(handler); return () => handlers[type].delete(handler); },
    pending: async (filter) => copy(entries.filter((e) => !filter || !filter.record || e.records.includes(String(filter.record)))),
    isPending: (id) => entries.some((e) => e.records.includes(String(id))),
    retry: async (id) => { calls.push(['retry', id]); const e = entries.find((x) => x.id === id); if (window.fake.failNext) { window.fake.failNext = false; throw new Error('refused'); } if (e) { e.state = 'waiting'; e.error = null; } count(); emit('state', copy(S)); return e; },
    discard: async (id) => { calls.push(['discard', id]); const e = entries.find((x) => x.id === id); entries = entries.filter((x) => x.id !== id); count(); emit('discarded', e); emit('state', copy(S)); return true; },
    resolve: async (id, choices) => { calls.push(['resolve', id, choices]); if (window.fake.failNext) { window.fake.failNext = false; throw new Error('refused'); } const e = entries.find((x) => x.id === id); if (e) { e.state = 'waiting'; e.conflict = null; } count(); emit('state', copy(S)); return e; },
    syncNow: async () => { calls.push(['syncNow']); return { sent: 0, blocked: null }; },
    checkForUpdate: async () => S.code,
    pinProject: async (org, project, options) => { calls.push(['pin', org, project, !!(options && options.auto)]); await new Promise((r) => setTimeout(r, window.fake.pinMs || 0)); pins = pins.filter((p) => p.project !== project).concat([{ org, project, auto: !!(options && options.auto), at: Date.now(), refreshedAt: Date.now(), reads: 4, media: 2 }]); return pins[pins.length - 1]; },
    unpinProject: async (org, project) => { calls.push(['unpin', org, project]); pins = pins.filter((p) => p.project !== project); return true; },
    pinned: async () => copy(pins),
    settings: { get: (name) => settings[name], set: async (name, value) => { calls.push(['setting', name, value]); settings[name] = value; if (name === 'readsBudgetMb') S.storage.budgets.reads = value * 1048576; if (name === 'mediaBudgetMb') S.storage.budgets.media = value * 1048576; return value; } },
    signedOut: async () => { calls.push(['signedOut']); return true; },
    removeSaved: async () => { calls.push(['removeSaved']); S.storage.reads = 0; S.storage.media = 0; S.storage.usage = 40 * 1048576; emit('state', copy(S)); return copy(S); },
    measure: async () => { calls.push(['measure']); return copy(S); }
  };
  window.fake = {
    calls, failNext: false, pinMs: 0,
    set(patch) { Object.assign(S, patch); emit('state', copy(S)); },
    storage(patch) { Object.assign(S.storage, patch); emit('state', copy(S)); },
    entries(list) { entries = copy(list); count(); emit('state', copy(S)); },
    synced(id) { const e = entries.find((x) => x.id === id); entries = entries.filter((x) => x.id !== id); count(); S.lastSyncAt = Date.now(); emit('synced', Object.assign({}, e, { state: 'synced', status: 200 })); emit('state', copy(S)); },
    pins(list) { pins = copy(list); },
    emit
  };
})();
`;

/** The portal's chrome in miniature: the same ids and classes, and the same rule for which bar shows. */
const page = (query) => `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>offline ui</title>
<style>
  html,body{margin:0;height:100%;font:14px system-ui,sans-serif;background:#f0f2f5}
  body{display:flex}
  .mobile-topbar{display:none}
  .sidebar{width:250px;flex:none;display:flex;flex-direction:column;background:#fff;border-right:1px solid #ddd;padding:14px;box-sizing:border-box}
  .sidebar.compact{width:48px;padding:6px}
  .sidebar-scroll{flex:1;display:flex;flex-direction:column;min-height:0}
  .sidebar-fill{flex:1}
  .sidebar-footer{border-top:1px solid #eee;padding-top:8px}
  .main{flex:1;min-width:0;display:flex;flex-direction:column}
  .platform-topbar{height:46px;flex:0 0 46px;display:flex;align-items:center;justify-content:flex-end;gap:12px;padding:0 18px;background:#fff;border-bottom:1px solid #eee}
  .platform-topbar-app-left{flex:1 1 auto;min-width:0;display:flex;align-items:center;overflow:hidden}
  .platform-topbar-app-left:empty{display:none}
  .platform-search{width:min(440px,46vw);height:30px;border:1px solid #ccc;border-radius:999px;box-sizing:border-box}
  .ptb-bell{width:34px;height:34px;border-radius:999px;border:1px solid #ccc;background:#fff;flex:none}
  #content{padding:20px;display:grid;gap:10px;align-content:start}
  .v-tile,.v-lrow{background:#fff;border:1px solid #ddd;border-radius:10px;padding:10px}
  @media (max-width:820px){
    body{flex-direction:column}
    .sidebar,.platform-topbar{display:none}
    .mobile-topbar{display:grid;grid-template-columns:40px minmax(0,1fr) 40px;align-items:center;height:56px;padding:0 14px;background:#fff;border-bottom:1px solid #ddd}
    .mob-logo{grid-column:2;min-width:0;display:flex;align-items:center;justify-content:center}
    .mob-tab-heading{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-weight:700}
    .mob-hamburger,.mob-new-req{width:40px;height:40px}
  }
</style></head><body>
<div class="mobile-topbar"><button class="mob-hamburger" id="mobMenuBtn">=</button><div class="mob-logo"><span class="mob-tab-heading">My Projects</span></div><button class="mob-new-req" id="mobNewReqBtn">+</button></div>
<aside class="sidebar" id="mainSidebar"><div class="sidebar-scroll"><div class="sidebar-fill"></div><div id="sidebarBottomLinks"></div><div class="sidebar-footer"><button id="accountSwitcherButton">Account</button> <a id="logoutLink" href="/portal/logout.php">Log out</a></div></div></aside>
<main class="main">
  <div class="platform-topbar" id="platformTopbar"><div class="platform-topbar-app-left" id="platformTopbarAppLeft"></div><div class="platform-search"></div><button class="ptb-bell" id="todoBtn"></button><button class="ptb-bell" id="platformBell"></button></div>
  <div id="content">
    <div class="v-tile" data-id="p1"><div class="v-body"><div class="v-addr"><div>14 Ridge Road</div><div class="l2">Austin</div></div></div></div>
    <div class="v-lrow" data-id="p2"><div class="v-laddr"><div class="v-laddr1">8 Gable Court</div></div></div>
    <div class="v-tile" data-id="p3"><div class="v-body"><div class="v-addr"><div>31 Eave Lane</div></div></div></div>
    <div id="badgeHost"></div><div id="settingsHost"></div>
  </div>
</main>
<script>window.__APP = { userId: 'user_1', userOrgId: 'org_1' };</script>
<script>${FAKE}</script>
${query.includes('lang=1') ? `<script>window.PlatformLanguage = { asked: [], text(ns, key, fallback, values) { this.asked.push(ns + '/' + key); return ns === 'platform-offline' && key === 'label_note' ? 'Note (from the catalog)' : '«' + String(fallback).replace(/\\{count[^]*$/, (values && values.count) + ' …').replace(/\\{(\\w+)\\}/g, (m, name) => (values && values[name] != null ? values[name] : m)) + '»'; }, ensure: async () => {} };</script>` : ''}
${query.includes('native=1') ? `<script>window.PhoneFeatures = { isNative: () => true, supports: (name) => name === 'photoLibrarySave' };</script>` : ''}
<script src="/libraries/platform-offline/offline-ui.js"></script>
</body></html>`;

/** The project window's frame: its header, as project-request/app.js builds it. */
const projectPage = () => `<!doctype html><html lang="en" class="project-window-embedded"><head><meta charset="utf-8"><title>project window</title>
<style>html,body{margin:0;font:14px system-ui,sans-serif}.r-window-bar{display:flex;align-items:stretch;height:48px;background:#fff;border-bottom:1px solid #ddd}.r-window-identity{display:flex;align-items:center;gap:8px;min-width:0;padding:0 12px}#rProjectIdentityTrigger{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;border:0;background:none;font:inherit;font-weight:700}.r-window-bar-actions{margin-left:auto;width:46px}</style></head><body>
<div id="rOverlay"><div class="r-win"><div class="r-modal-header r-window-bar fm-shell-header" data-window-mobile="false"><div class="r-window-identity fm-shell-identity"><i></i><button type="button" id="rProjectIdentityTrigger"><span id="rWindowProjectTitle">Eva Eave 31 Eave Lane</span></button><div class="r-stagebar" id="rProjectStageBar"></div></div><div class="r-window-bar-actions"></div></div></div></div>
<script>window.__APP = { userId: 'user_1', userOrgId: 'org_1' };</script>
<script>${FAKE}</script>
<script src="/libraries/platform-offline/offline-ui.js"></script>
</body></html>`;

async function site() {
  const server = http.createServer((request, response) => {
    const url = new URL(request.url, 'http://x');
    const send = (type, body) => { response.writeHead(200, { 'Content-Type': type, 'Cache-Control': 'no-store' }); response.end(body); };
    if (url.pathname === '/libraries/platform-offline/offline-ui.js') return send('text/javascript; charset=utf-8', readFileSync(UI_FILE));
    if (url.pathname === '/portal/logout.php') return send('text/html; charset=utf-8', '<!doctype html><title>signed out</title><p id="out">signed out</p>');
    if (url.pathname === '/portal/project') return send('text/html; charset=utf-8', projectPage());
    if (url.pathname === '/portal/host') return send('text/html; charset=utf-8', page(url.search).replace('<div id="badgeHost">', `<iframe id="projectFrame" src="/portal/project?projectWindow=t1&project=p1" style="position:fixed;left:60px;top:40px;width:calc(100% - 120px);height:calc(100% - 80px);border:0;z-index:2147483100;background:#fff"></iframe><div id="badgeHost">`));
    if (url.pathname === '/portal/') return send('text/html; charset=utf-8', page(url.search));
    response.writeHead(404); response.end('not found');
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return { origin: 'http://127.0.0.1:' + server.address().port, close: () => new Promise((resolve) => server.close(resolve)) };
}

let browser, web;
test.before(async () => { web = await site(); browser = await chromium.launch({ executablePath: CHROME, headless: true }); if (SHOTS) mkdirSync(SHOTS, { recursive: true }); });
test.after(async () => { await browser?.close(); await web?.close(); });

async function open(options = {}) {
  const context = await browser.newContext({ viewport: { width: options.width || 1280, height: options.height || 800 } });
  const tab = await context.newPage();
  const errors = [];
  tab.on('pageerror', (error) => errors.push(String(error.message)));
  let navigations = 0;
  tab.on('framenavigated', (frame) => { if (frame === tab.mainFrame()) navigations++; });
  await tab.goto(web.origin + (options.path || '/portal/') + (options.query || ''));
  await tab.waitForFunction(() => !!window.PlatformOfflineUI);
  const shot = async (name) => { if (SHOTS) await tab.screenshot({ path: `${SHOTS}/${name}-${options.width || 1280}.png` }); };
  return { tab, context, errors, shot, navigations: () => navigations - 1 };
}
const pillText = (tab) => tab.evaluate(() => { const pill = document.querySelector('.fmo-pill'); if (!pill || pill.hidden || !pill.getClientRects().length) return null; return [...pill.querySelectorAll('.fmo-text>span')].filter((n) => n.getClientRects().length).map((n) => n.textContent).join('|'); });
const entry = (id, more) => Object.assign({ id, contract: 'project.notes', write: 'notes.post', kind: 'create', scope: 'project:p1', label: { title: 'Note', detail: 'Call the adjuster back' }, records: ['rec_' + id], state: 'waiting', attempts: 0, error: null, conflict: null, createdAt: Date.now() - 5 * 60000, nextAt: 0 }, more || {});
const CONFLICT = { revision: 7, fields: [
  { path: 'title', base: 'Ridge repair', mine: 'Ridge and valley repair', theirs: 'Ridge repair (insurance)' },
  { path: 'address.city', base: 'Austin', mine: 'Round Rock', theirs: 'Cedar Park' },
  { path: 'squares', base: 24, mine: 26.5, theirs: 25 },
  { path: 'install_date', base: '2026-11-20', mine: '2026-11-24', theirs: '2026-12-01' },
  { path: 'assignees', base: [{ id: 1, name: 'Ana Ruiz' }], mine: [{ id: 1, name: 'Ana Ruiz' }, { id: 2, name: 'Ben Cho' }], theirs: [{ id: 3, name: 'Dee Park' }] },
  { path: 'tags', base: [], mine: ['hail', 'urgent'], theirs: null }
] };

test('the indicator is hidden while everything is normal and says each situation in one element', async () => {
  const { tab, context, errors, shot, navigations } = await open({ width: 1500 });   // wide enough for the full sentence
  assert.equal(await pillText(tab), null, 'nothing shows when online with nothing waiting');
  assert.equal(await tab.locator('.fmo-slot').count(), 1);

  await tab.evaluate(() => window.fake.set({ online: false }));
  assert.match(await pillText(tab), /^Offline\. Changes are saved on this device and sent when you reconnect\.$/);
  assert.equal(await tab.evaluate(() => window.PlatformOfflineUI.state().host), 'topbar');
  await shot('ind-offline');

  await tab.evaluate(() => window.fake.set({ online: false, savedPage: true }));
  assert.match(await pillText(tab), /You are seeing what was saved on this device/);

  await tab.evaluate((list) => window.fake.entries(list), [entry('a'), entry('b'), entry('c')]);
  assert.match(await pillText(tab), /^Offline\. 3 changes are saved on this device and will be sent when you reconnect\.$/);
  await shot('ind-offline-waiting');

  await tab.evaluate(() => window.fake.set({ online: true, savedPage: false, syncing: true }));
  assert.equal(await pillText(tab), 'Sending 3 changes…');
  await shot('ind-sending');

  await tab.evaluate(() => { window.fake.synced('a'); window.fake.synced('b'); });
  assert.equal(await pillText(tab), 'Sending 1 change…');
  await tab.evaluate(() => { window.fake.synced('c'); window.fake.set({ syncing: false }); });
  assert.equal(await pillText(tab), 'All changes sent.');
  await shot('ind-sent');
  await tab.waitForFunction(() => document.querySelector('.fmo-pill').hidden, null, { timeout: 8000 });
  assert.equal(await pillText(tab), null, '"All changes sent" goes away by itself');

  // A discarded change was not sent: nothing may say it was.
  await tab.evaluate((list) => window.fake.entries(list), [entry('d', { state: 'failed', error: { status: 422, code: 'invalid', message: 'Text is required' } })]);
  assert.equal(await pillText(tab), '1 change was not sent and needs you.');
  assert.equal(await tab.locator('.fmo-pill').getAttribute('data-tone'), 'attention');
  await shot('ind-attention');
  await tab.evaluate(() => window.PlatformOffline.discard('d'));
  assert.equal(await pillText(tab), null, 'no "sent" after a discard');

  await tab.evaluate((list) => { window.fake.entries(list); window.fake.set({ blocked: 'sign-in' }); }, [entry('e'), entry('f')]);
  assert.equal(await pillText(tab), 'Sign in again to send 2 waiting changes.');
  await shot('ind-signin');

  await tab.evaluate(() => { window.fake.entries([]); window.fake.set({ blocked: null, savedPage: true }); });
  assert.equal(await pillText(tab), 'Back online. This page is the copy saved on this device.');
  await shot('ind-saved-copy');

  await tab.evaluate(() => window.fake.set({ savedPage: false, code: { release: null, status: 'downloading', progress: 0.42, next: 'r2' } }));
  assert.match(await pillText(tab), /so it opens without a connection: 42%$/);
  assert.equal(await tab.locator('.fmo-pill .fmo-bar > span').evaluate((n) => n.style.width), '42%');
  await shot('ind-download');
  await tab.evaluate(() => window.fake.set({ code: { release: 'r2', status: 'ready', progress: 1 } }));
  assert.match(await pillText(tab), /It now opens without a connection\.$/);

  // A later release downloads behind the one in use: nothing to tell anyone.
  await tab.waitForFunction(() => document.querySelector('.fmo-pill').hidden, null, { timeout: 8000 });
  await tab.evaluate(() => window.fake.set({ code: { release: 'r2', status: 'downloading', progress: 0.3, next: 'r3' } }));
  assert.equal(await pillText(tab), null);

  assert.equal(await tab.locator('.fmo-pill').count(), 1, 'one element that changes, not a stack');
  assert.equal(navigations(), 0, 'nothing loaded a page');
  assert.deepEqual(errors, []);
  await context.close();
});

test('the indicator sits where the chrome is and never over a control', async () => {
  const overlaps = (tab) => tab.evaluate(() => {
    const pill = document.querySelector('.fmo-pill').getBoundingClientRect();
    const hit = (a, b) => a.left < b.right - 0.5 && b.left < a.right - 0.5 && a.top < b.bottom - 0.5 && b.top < a.bottom - 0.5;
    return [...document.querySelectorAll('.platform-search,.ptb-bell,#accountSwitcherButton,#mobMenuBtn,#mobNewReqBtn,.mob-tab-heading')].filter((node) => node.getClientRects().length && hit(pill, node.getBoundingClientRect())).map((node) => node.id || node.className);
  });
  const wide = await open({ width: 1280 });
  await wide.tab.evaluate(() => window.fake.set({ online: false }));
  assert.equal(await wide.tab.evaluate(() => window.PlatformOfflineUI.state().host), 'topbar');
  assert.equal(await pillText(wide.tab), 'Offline', 'the short form where the full sentence has no room');
  const searchBefore = await wide.tab.evaluate(() => document.querySelector('.platform-search').getBoundingClientRect().left);
  assert.deepEqual(await overlaps(wide.tab), []);
  await wide.tab.evaluate(() => window.fake.set({ online: true }));
  assert.equal(await wide.tab.evaluate(() => document.querySelector('.platform-search').getBoundingClientRect().left), searchBefore, 'showing the pill does not move the search field');

  // An app that uses the left of the top bar keeps its room: the pill takes the short form beside it.
  await wide.tab.evaluate(() => { document.getElementById('platformTopbarAppLeft').innerHTML = '<b>Schedule: week of November 9</b>'; window.fake.set({ online: false }); });
  assert.equal(await pillText(wide.tab), 'Offline');
  assert.deepEqual(await overlaps(wide.tab), []);

  // Top bar off: the sidebar, above the account button; a compact sidebar leaves the icon.
  await wide.tab.evaluate(() => { document.getElementById('platformTopbar').style.display = 'none'; window.dispatchEvent(new CustomEvent('fm:platform-topbar-visibility')); });
  assert.equal(await wide.tab.evaluate(() => window.PlatformOfflineUI.state().host), 'sidebar');
  assert.equal(await pillText(wide.tab), 'Offline');
  assert.deepEqual(await overlaps(wide.tab), []);
  assert.ok(await wide.tab.evaluate(() => document.querySelector('.fmo-slot').getBoundingClientRect().bottom <= document.querySelector('.sidebar-footer').getBoundingClientRect().top + 0.5));
  await wide.shot('ind-sidebar');
  await wide.tab.evaluate(() => document.getElementById('mainSidebar').classList.add('compact'));
  await wide.tab.waitForFunction(() => document.querySelector('.fmo-pill').getBoundingClientRect().width <= 34);
  assert.equal(await pillText(wide.tab), '', 'only the icon fits a compact sidebar');
  assert.match(await wide.tab.locator('.fmo-pill').getAttribute('aria-label'), /^Offline\. Changes are saved on this device/);
  await wide.shot('ind-sidebar-compact');
  await wide.context.close();

  const phone = await open({ width: 390, height: 780 });
  await phone.tab.evaluate((list) => { window.fake.set({ online: false }); window.fake.entries(list); }, [entry('a')]);
  assert.equal(await phone.tab.evaluate(() => window.PlatformOfflineUI.state().host), 'mobile');
  assert.equal(await pillText(phone.tab), 'Offline · 1', 'a phone bar has room for the word and the count');
  assert.deepEqual(await overlaps(phone.tab), []);
  assert.ok(await phone.tab.evaluate(() => document.querySelector('.fmo-pill').getBoundingClientRect().right <= document.querySelector('#mobNewReqBtn').getBoundingClientRect().left));
  await phone.shot('ind-phone');
  // The window grows: the same element moves to the top bar.
  await phone.tab.setViewportSize({ width: 1280, height: 800 });
  await phone.tab.waitForFunction(() => window.PlatformOfflineUI.state().host === 'topbar');
  assert.equal(await phone.tab.locator('.fmo-slot').count(), 1);
  assert.deepEqual(phone.errors, []);
  await phone.context.close();
});

test('the tray lists what waits, retries, discards after asking, and sends now', async () => {
  const { tab, context, errors, shot, navigations } = await open();
  const made = Date.now() - 3 * 3600000;
  await tab.evaluate(([list, last]) => { window.fake.set({ online: false, lastSyncAt: last }); window.fake.entries(list); }, [[
    entry('w1', { createdAt: made }),
    entry('w2', { kind: 'upload', label: { title: 'Photo', detail: 'IMG_2041.jpg' }, state: 'delegated' }),
    entry('f1', { kind: 'patch', label: { title: 'Project details', detail: '14 Ridge Road' }, state: 'failed', error: { status: 422, code: 'invalid_request', message: 'The address is missing a city.' } }),
    entry('c1', { kind: 'patch', label: { title: 'Project details', detail: '8 Gable Court' }, state: 'conflict', conflict: CONFLICT })
  ], new Date(new Date().setHours(12, 0, 0, 0) - 24 * 3600000).getTime()]);
  await tab.locator('.fmo-pill').click();
  const tray = tab.locator('.fmo-tray');
  await tray.waitFor();
  assert.equal(await tray.getAttribute('role'), 'dialog');
  assert.equal(await tab.evaluate(() => document.activeElement.id), 'fmoTrayTitle', 'focus moves into the tray');
  assert.equal(await tab.locator('.fmo-pill').getAttribute('aria-expanded'), 'true');
  assert.match(await tray.locator('.fmo-status p').innerText(), /2 changes were not sent and need you/);
  assert.match(await tray.locator('.fmo-status small').first().innerText(), /^Last sent yesterday at /);
  assert.deepEqual(await tray.locator('.fmo-group').allInnerTexts(), ['Not sent', 'Waiting to be sent']);
  const rows = await tray.locator('.fmo-entry').evaluateAll((nodes) => nodes.map((n) => [n.dataset.entry, n.querySelector('.fmo-entry-title').textContent, n.querySelector('.fmo-entry-detail')?.textContent, n.querySelector('.fmo-chip').textContent]));
  assert.deepEqual(rows, [['f1', 'Project details', '14 Ridge Road', 'Not sent'], ['c1', 'Project details', '8 Gable Court', 'Needs your choice'], ['w1', 'Note', 'Call the adjuster back', 'Waiting'], ['w2', 'Photo', 'IMG_2041.jpg', 'Uploading in the background']]);
  assert.match(await tray.locator('[data-entry=w1] .fmo-entry-meta').innerText(), /^Made (today|yesterday) at \d/);
  assert.match(await tray.locator('[data-entry=f1] .fmo-entry-error').innerText(), /did not accept this change \(422\)\. The address is missing a city\./);
  assert.equal(await tray.locator('[data-entry=w1] button').count(), 0, 'a waiting change needs nothing from the person');
  await shot('tray-list');

  // Discard asks first and says the change will be lost; "Keep it" changes nothing.
  await tray.locator('[data-entry=f1] button', { hasText: 'Discard' }).click();
  assert.match(await tray.locator('[data-entry=f1] .fmo-entry-actions p').innerText(), /never sent and will be lost/);
  assert.equal(await tab.evaluate(() => document.activeElement.textContent), 'Keep it', 'the safe answer has the focus');
  await shot('tray-discard-ask');
  await tab.keyboard.press('Enter');
  assert.equal(await tab.evaluate(() => window.fake.calls.filter((call) => call[0] === 'discard').length), 0);
  assert.equal(await tray.locator('[data-entry=f1]').count(), 1);

  // Retry that the worker refuses says so; a retry that works moves the change back to waiting.
  await tab.evaluate(() => { window.fake.failNext = true; });
  await tray.locator('[data-entry=f1] button', { hasText: 'Retry' }).click();
  await tray.locator('[data-entry=f1] [role=alert]').waitFor();
  await tray.locator('[data-entry=f1] button', { hasText: 'Retry' }).click();
  await tab.waitForFunction(() => document.querySelector('[data-entry=f1]')?.dataset.state === 'waiting');
  assert.deepEqual(await tab.evaluate(() => window.fake.calls.filter((call) => call[0] === 'retry')), [['retry', 'f1'], ['retry', 'f1']]);

  await tab.evaluate((list) => window.fake.entries(list), [entry('w1'), entry('f2', { state: 'failed', error: { status: 404, code: 'not_found', message: 'not_found' } })]);
  assert.match(await tray.locator('[data-entry=f2] .fmo-entry-error').innerText(), /^What this change was for no longer exists\.$/);
  await tray.locator('[data-entry=f2] button', { hasText: 'Discard' }).click();
  await tray.locator('[data-entry=f2] button', { hasText: 'Discard change' }).click();
  await tab.waitForFunction(() => !document.querySelector('[data-entry=f2]'));
  assert.deepEqual(await tab.evaluate(() => window.fake.calls.filter((call) => call[0] === 'discard')), [['discard', 'f2']]);

  assert.equal(await tray.locator('.fmo-foot .fmo-grow').innerText(), '1 change is waiting to be sent.');
  assert.equal(await tray.locator('.fmo-status p').innerText(), 'Offline. 1 change is saved on this device and will be sent when you reconnect.');
  await tray.locator('.fmo-foot button', { hasText: 'Send now' }).click();
  await tab.waitForFunction(() => window.fake.calls.some((call) => call[0] === 'syncNow'));

  // Escape closes the tray and gives the focus back to the indicator.
  await tab.keyboard.press('Escape');
  await tab.waitForFunction(() => document.querySelector('.fmo-layer').hidden);
  assert.equal(await tab.evaluate(() => document.activeElement.className), 'fmo-pill');
  assert.equal(await tab.locator('.fmo-pill').getAttribute('aria-expanded'), 'false');

  // Nothing waiting: the tray says so, and Send now has nothing to do.
  await tab.evaluate(() => { window.fake.entries([]); window.fake.set({ online: true }); window.PlatformOfflineUI.open(); });
  assert.match(await tray.locator('.fmo-status p').innerText(), /^Nothing is waiting\. Everything you changed has been sent\.$/);
  assert.equal(await tray.locator('.fmo-foot button').isDisabled(), true);
  await tab.locator('.fmo-scrim').click({ position: { x: 5, y: 300 } });
  await tab.waitForFunction(() => document.querySelector('.fmo-layer').hidden);

  // Signed out on the server: the queue is paused, and the tray offers the sign-in.
  await tab.evaluate((list) => { window.fake.entries(list); window.fake.set({ blocked: 'sign-in' }); window.PlatformOfflineUI.open(); }, [entry('w1')]);
  assert.equal(await tray.locator('.fmo-status button', { hasText: 'Sign in' }).count(), 1);
  assert.equal(navigations(), 0);
  assert.deepEqual(errors, []);
  await context.close();
});

test('the tray warns when the browser may clear waiting changes, and not in the app', async () => {
  const browserTab = await open();
  await browserTab.tab.evaluate((list) => { window.fake.storage({ persisted: false }); window.fake.entries(list); window.PlatformOfflineUI.open(); }, [entry('w1')]);
  assert.match(await browserTab.tab.locator('.fmo-warn').innerText(), /Safari clears a site's storage after seven days without a visit[^]*would be lost[^]*The FirstMate app does not have this limit\./);
  await browserTab.shot('tray-storage-warning');
  await browserTab.tab.evaluate(() => window.fake.entries([]));
  assert.equal(await browserTab.tab.locator('.fmo-warn').count(), 0, 'nothing waits: no warning');
  await browserTab.tab.evaluate((list) => { window.fake.storage({ persisted: true }); window.fake.entries(list); }, [entry('w1')]);
  assert.equal(await browserTab.tab.locator('.fmo-warn').count(), 0, 'storage is persistent: no warning');
  await browserTab.context.close();

  const app = await open({ query: '?native=1' });
  await app.tab.evaluate((list) => { window.fake.storage({ persisted: false }); window.fake.entries(list); window.PlatformOfflineUI.open(); }, [entry('w1')]);
  await app.tab.locator('.fmo-tray').waitFor();
  assert.equal(await app.tab.locator('.fmo-warn').count(), 0);
  await app.context.close();
});

test('a conflict shows both values of each field readably and is settled by the person', async () => {
  const { tab, context, errors, shot } = await open();
  await tab.evaluate((list) => window.fake.entries(list), [entry('c1', { kind: 'patch', label: { title: 'Project details', detail: '8 Gable Court' }, state: 'conflict', conflict: CONFLICT })]);
  await tab.locator('.fmo-pill').click();
  await tab.locator('[data-entry=c1] button', { hasText: 'Review' }).click();
  const tray = tab.locator('.fmo-tray');
  assert.equal(await tray.getAttribute('data-view'), 'conflict');
  assert.deepEqual(await tray.locator('.fmo-field-name').allInnerTexts(), ['Title', 'Address › City', 'Squares', 'Install date', 'Assignees', 'Tags']);
  const values = await tray.locator('.fmo-field').evaluateAll((nodes) => nodes.map((n) => [n.querySelector('[data-side=mine] .fmo-value').innerText, n.querySelector('[data-side=theirs] .fmo-value').innerText]));
  assert.deepEqual(values[0], ['Ridge and valley repair', 'Ridge repair (insurance)']);
  assert.deepEqual(values[2], ['26.5', '25']);
  assert.match(values[3][0], /Nov 24, 2026/);
  assert.match(values[3][1], /Dec 1, 2026/);
  assert.deepEqual(values[4], ['Ana Ruiz, Ben Cho', 'Dee Park'], 'a list of records reads as their names');
  assert.deepEqual(values[5], ['hail, urgent', 'Empty']);
  assert.ok(values.flat().every((text) => !/[{}\[\]"]/.test(text)), 'no raw JSON for common values');
  assert.equal(await tray.locator('.fmo-field .fmo-before').first().innerText(), 'Before: Ridge repair');
  // Side by side: both values of a field share a row.
  const sides = await tray.locator('.fmo-field').first().evaluate((n) => [...n.querySelectorAll('.fmo-side')].map((s) => s.getBoundingClientRect()).map((r) => [Math.round(r.top), Math.round(r.left)]));
  assert.equal(sides[0][0], sides[1][0]);
  assert.ok(sides[1][1] > sides[0][1]);
  assert.deepEqual(await tray.locator('.fmo-side b').evaluateAll((nodes) => [...new Set(nodes.map((n) => n.textContent))]), ['Yours', 'The server\'s']);
  await shot('conflict');

  const send = tray.locator('.fmo-foot button');
  assert.equal(await send.isDisabled(), true, 'nothing is sent before every field is chosen');
  assert.equal(await tray.locator('.fmo-foot .fmo-grow').innerText(), '6 fields left to choose');
  await tray.locator('[data-path="title"] [data-side=theirs]').click();
  assert.equal(await tray.locator('.fmo-foot .fmo-grow').innerText(), '5 fields left to choose');
  // The keyboard: the two values of a field are one radio group.
  await tray.locator('[data-path="address.city"] input[value=mine]').focus();
  await tab.keyboard.press('ArrowRight');
  assert.equal(await tray.locator('[data-path="address.city"] input[value=theirs]').isChecked(), true);
  assert.equal(await tab.evaluate(() => document.activeElement.value), 'theirs', 'a redraw keeps the focus where it was');
  await tray.locator('button', { hasText: 'Keep all of mine' }).click();
  assert.equal(await tray.locator('input[value=mine]:checked').count(), 6);
  await tray.locator('[data-path="squares"] [data-side=theirs]').click();
  await tray.locator('[data-path="tags"] [data-side=theirs]').click();
  assert.equal(await tray.locator('.fmo-foot .fmo-grow').innerText(), 'Every field is chosen.');
  await shot('conflict-chosen');

  await tab.evaluate(() => { window.fake.failNext = true; });
  await send.click();
  await tray.locator('.fmo-foot [role=alert]').waitFor();
  assert.equal(await tray.getAttribute('data-view'), 'conflict', 'a failed save keeps the choices on screen');
  await send.click();
  await tab.waitForFunction(() => document.querySelector('.fmo-tray').dataset.view === 'list');
  const resolved = await tab.evaluate(() => window.fake.calls.filter((call) => call[0] === 'resolve').pop());
  assert.deepEqual(resolved, ['resolve', 'c1', { title: 'mine', 'address.city': 'mine', squares: 'theirs', install_date: 'mine', assignees: 'mine', tags: 'theirs' }]);
  assert.equal(await tab.locator('[data-entry=c1]').getAttribute('data-state'), 'waiting');

  // Escape in the conflict view goes back to the list first.
  await tab.evaluate((list) => window.fake.entries(list), [entry('c2', { kind: 'patch', state: 'conflict', conflict: { revision: 1, fields: [{ path: 'items.#order', base: [1, 2, 3], mine: [3, 1, 2], theirs: [2, 1, 3] }, { path: 'contact', base: null, mine: { first: 'Eva', phone: '555-0102' }, theirs: { first: 'Eve', phone: '555-0199' } }] } })]);
  await tab.locator('[data-entry=c2] button', { hasText: 'Review' }).click();
  assert.deepEqual(await tray.locator('.fmo-field-name').allInnerTexts(), ['Order of items', 'Contact']);
  assert.match(await tray.locator('[data-path="contact"] [data-side=mine] .fmo-value').innerText(), /First\s+Eva\s+Phone\s+555-0102/);
  await tab.keyboard.press('Escape');
  assert.equal(await tray.getAttribute('data-view'), 'list');
  assert.deepEqual(errors, []);
  await context.close();
});

test('the tray is a bottom sheet in a narrow window and fits the conflict view', async () => {
  const { tab, context, errors, shot } = await open({ width: 390, height: 780 });
  await tab.evaluate((list) => { window.fake.set({ online: false }); window.fake.entries(list); }, [entry('w1'), entry('f1', { state: 'failed', error: { status: 403, code: 'forbidden' } }), entry('c1', { kind: 'patch', label: { title: 'Project details', detail: '8 Gable Court' }, state: 'conflict', conflict: CONFLICT })]);
  await tab.locator('.fmo-pill').click();
  const box = await tab.locator('.fmo-tray').boundingBox();
  assert.equal(Math.round(box.x), 0);
  assert.equal(Math.round(box.width), 390);
  assert.equal(Math.round(box.y + box.height), 780, 'the sheet sits on the bottom edge');
  assert.ok(box.y >= 40, 'and leaves the top of the page in view');
  assert.match(await tab.locator('[data-entry=f1] .fmo-entry-error').innerText(), /^You are not allowed to make this change\.$/);
  await shot('tray-list');
  await tab.locator('[data-entry=c1] button', { hasText: 'Review' }).click();
  const wide = await tab.locator('.fmo-tray').evaluate((n) => n.scrollWidth <= n.clientWidth + 1 && [...n.querySelectorAll('.fmo-side')].every((s) => s.getBoundingClientRect().right <= 390));
  assert.ok(wide, 'nothing spills past the sheet');
  await shot('conflict');
  assert.deepEqual(errors, []);
  await context.close();
});

test('waitingBadge shows only while its record waits, fails or is in conflict', async () => {
  const { tab, context, errors, shot } = await open();
  await tab.evaluate(() => {
    const host = document.getElementById('badgeHost');
    host.innerHTML = '<div id="rowA">Note A </div><div id="rowB">Note B </div><div id="rowC">Note C </div>';
    window.badgeA = window.PlatformOfflineUI.waitingBadge({ record: 'rec_a' });
    window.badgeB = window.PlatformOfflineUI.waitingBadge({ record: 'rec_b' });
    window.badgeC = window.PlatformOfflineUI.waitingBadge({ record: 'rec_c', compact: true });
    document.getElementById('rowA').append(window.badgeA); document.getElementById('rowB').append(window.badgeB); document.getElementById('rowC').append(window.badgeC);
  });
  const badge = (name) => tab.evaluate((n) => { const b = window[n]; return b.hidden ? null : [b.dataset.state, b.innerText.trim(), b.getAttribute('role')]; }, name);
  assert.ok(await tab.evaluate(() => window.badgeA instanceof HTMLElement));
  assert.equal(await badge('badgeA'), null);

  await tab.evaluate((list) => window.fake.entries(list), [entry('a'), entry('b', { state: 'failed', error: { status: 422 } }), entry('c', { state: 'conflict', conflict: CONFLICT })]);
  await tab.waitForFunction(() => window.badgeB.dataset.state === 'failed');
  assert.deepEqual(await badge('badgeA'), ['waiting', 'Waiting to send', null]);
  assert.deepEqual(await badge('badgeB'), ['failed', 'Not sent', 'button']);
  assert.deepEqual(await badge('badgeC'), ['conflict', '', 'button'], 'a compact badge keeps its words for screen readers');
  assert.match(await tab.evaluate(() => window.badgeC.getAttribute('aria-label')), /^Needs your choice\./);
  assert.match(await tab.evaluate(() => window.badgeA.title), /sent when you reconnect/);
  await shot('badges');

  // A badge that needs the person opens the tray at that change; a waiting one is only information.
  await tab.evaluate(() => window.badgeA.click());
  assert.equal(await tab.evaluate(() => window.PlatformOfflineUI.state().open), false);
  await tab.evaluate(() => window.badgeB.click());
  await tab.locator('.fmo-tray [data-entry=b][data-flash]').waitFor();
  await tab.keyboard.press('Escape');
  await tab.evaluate(() => window.badgeC.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })));
  await tab.waitForFunction(() => document.querySelector('.fmo-tray').dataset.view === 'conflict');
  await tab.keyboard.press('Escape'); await tab.keyboard.press('Escape');

  await tab.evaluate(() => window.fake.synced('a'));
  await tab.waitForFunction(() => window.badgeA.hidden);
  await tab.evaluate(() => window.fake.entries([]));
  await tab.waitForFunction(() => window.badgeB.hidden && window.badgeC.hidden);
  // A badge made while its record already waits shows at once.
  await tab.evaluate((list) => { window.fake.entries(list); window.late = window.PlatformOfflineUI.waitingBadge({ record: 'rec_z' }); }, [entry('z')]);
  assert.equal(await tab.evaluate(() => window.late.hidden), false);
  assert.deepEqual(errors, []);
  await context.close();
});

test('the project window offers "Available offline", and lists mark saved projects only while offline', async () => {
  const { tab, context, errors, shot } = await open({ path: '/portal/host' });
  const frame = tab.frameLocator('#projectFrame');
  const button = frame.locator('.fmo-proj');
  await button.waitFor();
  assert.equal(await button.getAttribute('data-state'), 'none');
  assert.match(await button.getAttribute('aria-label'), /^Available offline\. This project is not saved on this device\.$/);
  assert.ok(await frame.locator('.r-window-identity').evaluate((n) => n.querySelector('#rProjectIdentityTrigger').nextElementSibling.classList.contains('fmo-slot')), 'beside the project title');

  await tab.frames()[1].evaluate(() => { window.fake.pinMs = 400; });
  await button.click();
  const panel = tab.locator('.fmo-pop');                    // drawn in the top page, above the window
  await panel.waitFor();
  assert.equal(await panel.locator('[data-project-status]').innerText(), 'This project is not saved on this device.');
  await shot('project-not-saved');
  await panel.locator('button', { hasText: 'Keep on this device' }).click();
  await tab.waitForFunction(() => document.querySelector('.fmo-pop [data-project-status]')?.dataset.projectStatus === 'downloading');
  assert.equal(await button.getAttribute('data-state'), 'downloading');
  await tab.waitForFunction(() => document.querySelector('.fmo-pop [data-project-status]')?.dataset.projectStatus === 'saved');
  assert.match(await panel.innerText(), /Saved on this device just now\.[^]*You chose to keep this project on this device\./);
  assert.equal(await button.getAttribute('data-state'), 'saved');
  assert.deepEqual(await tab.frames()[1].evaluate(() => window.fake.calls.filter((call) => call[0] === 'pin')), [['pin', 'org_1', 'p1', false]]);
  await shot('project-saved');
  await panel.locator('button', { hasText: 'Remove from this device' }).click();
  await tab.waitForFunction(() => document.querySelector('.fmo-pop [data-project-status]')?.dataset.projectStatus === 'none');
  await tab.keyboard.press('Escape');
  await tab.waitForFunction(() => !document.querySelector('.fmo-pop'));

  // A project kept because it was opened recently reads as such, and can be kept for good.
  await tab.frames()[1].evaluate(() => { window.fake.pinMs = 0; window.fake.pins([{ org: 'org_1', project: 'p1', auto: true, at: Date.now(), refreshedAt: Date.now() - 2 * 3600000, reads: 5, media: 1 }]); window.dispatchEvent(new CustomEvent('fm:project-modal:hydrated', { detail: { projectId: 'p1' } })); });
  await tab.waitForFunction(() => document.querySelector('#projectFrame').contentDocument.querySelector('.fmo-proj').dataset.state === 'saved');
  await button.click();
  assert.match(await panel.innerText(), /Kept automatically because you opened it recently\./);
  await panel.locator('button', { hasText: 'Always keep' }).click();
  await tab.waitForFunction(() => /You chose to keep/.test(document.querySelector('.fmo-pop')?.innerText || ''));
  await tab.keyboard.press('Escape');

  // The indicator shows in the window's own header, since the window covers the page's.
  await tab.frames()[1].evaluate(() => window.fake.set({ online: false }));
  assert.equal(await frame.locator('.fmo-pill .fmo-s').innerText(), 'Offline');
  await frame.locator('.fmo-pill').click();
  await tab.locator('.fmo-tray').waitFor();              // the tray too is drawn by the top page
  assert.equal(await frame.locator('.fmo-tray').count(), 0);
  await shot('project-window-tray');
  await tab.keyboard.press('Escape');
  // On a phone the window's header has little room: the icon alone, with a count when changes wait.
  await tab.frames()[1].evaluate(() => { document.querySelector('.r-window-bar').dataset.windowMobile = 'true'; window.dispatchEvent(new Event('resize')); });
  await tab.waitForFunction(() => document.querySelector('#projectFrame').contentDocument.querySelector('.fmo-slot').dataset.size === 'tiny');
  assert.equal(await frame.locator('.fmo-pill .fmo-text').evaluate((n) => n.getClientRects().length), 0);
  assert.ok(await frame.locator('.fmo-pill').evaluate((n) => n.getBoundingClientRect().width <= 29));
  await tab.frames()[1].evaluate(() => window.fake.entries([{ id: 'a', kind: 'create', label: { title: 'Note' }, records: ['r'], state: 'waiting', createdAt: Date.now() }]));
  assert.equal(await frame.locator('.fmo-pill .fmo-t').innerText(), '1');
  await tab.frames()[1].evaluate(() => { window.fake.entries([]); document.querySelector('.r-window-bar').dataset.windowMobile = 'false'; window.dispatchEvent(new Event('resize')); });

  // Lists in the page: no mark while online; offline, the projects on this device are marked.
  assert.equal(await tab.locator('#content .fmo-mark').count(), 0);
  await tab.evaluate(() => { window.fake.pins([{ org: 'org_1', project: 'p1', auto: true, at: 1, refreshedAt: Date.now(), reads: 3, media: 0 }, { org: 'org_1', project: 'p2', auto: false, at: 1, refreshedAt: Date.now(), reads: 3, media: 0 }, { org: 'org_1', project: 'p3', auto: false, at: 1, refreshedAt: null, reads: 0, media: 0 }]); window.fake.set({ online: false }); });
  await tab.waitForFunction(() => document.querySelectorAll('#content .fmo-mark').length === 2);
  assert.deepEqual(await tab.locator('#content [data-id]').evaluateAll((nodes) => nodes.map((n) => [n.dataset.id, !!n.querySelector('.fmo-mark')])), [['p1', true], ['p2', true], ['p3', false]]);
  assert.equal(await tab.locator('#content .fmo-mark').first().getAttribute('aria-label'), 'Saved on this device');
  // A list drawn again while offline is marked again.
  await tab.evaluate(() => { const row = document.querySelector('.v-lrow'); row.innerHTML = '<div class="v-laddr"><div class="v-laddr1">8 Gable Court</div></div>'; });
  await tab.waitForFunction(() => !!document.querySelector('.v-lrow .fmo-mark'));
  await tab.evaluate(() => window.fake.set({ online: true }));
  await tab.waitForFunction(() => document.querySelectorAll('#content .fmo-mark').length === 0);
  assert.deepEqual(errors, []);
  await context.close();
});

test('device settings show space, the two limits as choices, and remove saved data after asking', async () => {
  const { tab, context, errors, shot } = await open();
  await tab.evaluate(() => { window.fake.pins([{ org: 'org_1', project: 'p1', auto: true, at: 1, refreshedAt: Date.now(), reads: 3, media: 0 }, { org: 'org_1', project: 'p2', auto: false, at: 1, refreshedAt: Date.now(), reads: 3, media: 0 }]); window.fake.storage({ queued: 3 * 1048576 }); window.stop = window.PlatformOfflineUI.mountSettings(document.getElementById('settingsHost')); });
  const host = tab.locator('#settingsHost');
  await host.locator('[data-set=remove] .fmo-set-line', { hasText: '2 projects are saved on this device.' }).waitFor();
  assert.match(await host.locator('.fmo-set-total').innerText(), /^48 MB used of about 10 GB this browser allows$/);
  assert.deepEqual(await host.locator('.fmo-legend li').evaluateAll((nodes) => nodes.map((n) => n.innerText.replace(/\s+/g, ' ').trim())), ['The app 37 MB', 'Saved data limit 150 MB 6 MB', 'Pictures limit 300 MB 2 MB', 'Waiting changes 3 MB']);
  assert.equal(await host.locator('.fmo-meter > span').count(), 4);
  const choices = (index) => host.locator('.fmo-seg').nth(index).locator('label').evaluateAll((nodes) => nodes.map((n) => n.querySelector('b').textContent + ' ' + n.querySelector('small').textContent));
  assert.deepEqual(await choices(0), ['Less 50 MB', 'Standard 150 MB', 'More 500 MB']);
  assert.deepEqual(await choices(1), ['Less 100 MB', 'Standard 300 MB', 'More 1 GB']);
  assert.equal(await host.locator('input[name="fmo-readsBudgetMb"]:checked').getAttribute('value'), '150');
  assert.equal(await host.locator('input[type=number]').count(), 0, 'no raw numbers to type');
  await shot('settings');

  await host.locator('.fmo-seg').first().locator('label', { hasText: 'More' }).click();
  await tab.waitForFunction(() => window.fake.calls.some((call) => call[0] === 'setting' && call[1] === 'readsBudgetMb' && call[2] === 500));
  await host.locator('.fmo-legend li', { hasText: 'limit 500 MB' }).waitFor();
  await host.locator('.fmo-seg').nth(1).locator('label', { hasText: 'Less' }).click();
  await tab.waitForFunction(() => window.fake.calls.some((call) => call[0] === 'setting' && call[1] === 'mediaBudgetMb' && call[2] === 100));
  assert.equal(await host.locator('input[data-fk=autoPinRecent]').isChecked(), true);
  await host.locator('input[data-fk=autoPinRecent]').uncheck({ force: true });
  await tab.waitForFunction(() => window.fake.calls.some((call) => call[0] === 'setting' && call[1] === 'autoPinRecent' && call[2] === false));
  assert.equal(await host.locator('input[data-fk=saveToCameraRoll]').count(), 0, 'the camera roll switch is only in the app');

  // Removing saved data asks first, says waiting changes are kept, and lets go of kept projects.
  await tab.evaluate((list) => window.fake.entries(list), [entry('w1')]);
  assert.match(await host.locator('[data-set=remove]').innerText(), /1 change is waiting to be sent\.[^]*Changes waiting to be sent are kept and still sent\./);
  await host.locator('button', { hasText: 'Remove saved data from this device' }).click();
  assert.match(await host.locator('[data-set=remove] .fmo-actions p').innerText(), /^Remove saved data now\? Changes waiting to be sent are kept\.$/);
  await shot('settings-remove-ask');
  await host.locator('button', { hasText: 'Cancel' }).click();
  assert.equal(await tab.evaluate(() => window.fake.calls.some((call) => call[0] === 'removeSaved')), false);
  await host.locator('button', { hasText: 'Remove saved data from this device' }).click();
  await host.locator('button', { hasText: /^Remove saved data$/ }).click();
  await host.locator('[role=status]', { hasText: 'Saved data was removed. Waiting changes were kept.' }).waitFor();
  assert.deepEqual(await tab.evaluate(() => window.fake.calls.filter((call) => ['unpin', 'removeSaved', 'discard'].includes(call[0]))), [['unpin', 'org_1', 'p1'], ['unpin', 'org_1', 'p2'], ['removeSaved']]);
  assert.match(await host.locator('[data-set=remove]').innerText(), /No projects are saved on this device\.[^]*1 change is waiting to be sent\./);

  // "Show waiting changes" opens the tray; the tray's own "This device" shows the same settings.
  await host.locator('button', { hasText: 'Show waiting changes' }).click();
  await tab.locator('.fmo-tray [data-entry=w1]').waitFor();
  await tab.locator('.fmo-tray button[aria-label="This device"]').click();
  assert.equal(await tab.locator('.fmo-tray').getAttribute('data-view'), 'device');
  assert.equal(await tab.locator('.fmo-tray .fmo-set [data-set]').count(), 3);
  await shot('tray-device');
  await tab.keyboard.press('Escape');
  assert.equal(await tab.locator('.fmo-tray').getAttribute('data-view'), 'list');
  assert.deepEqual(errors, []);
  await context.close();

  const app = await open({ query: '?native=1' });
  await app.tab.evaluate(() => window.PlatformOfflineUI.mountSettings(document.getElementById('settingsHost')));
  const roll = app.tab.locator('#settingsHost input[data-fk=saveToCameraRoll]');
  assert.equal(await roll.count(), 1);
  await roll.check({ force: true });
  await app.tab.waitForFunction(() => window.fake.calls.some((call) => call[0] === 'setting' && call[1] === 'saveToCameraRoll' && call[2] === true));
  await app.context.close();
});

test('signing out asks first while changes wait', async () => {
  const { tab, context, errors, shot } = await open();
  // Nothing waiting: the link works as always.
  assert.equal(await tab.evaluate(() => window.PlatformOfflineUI.confirmSignOut()), true);

  await tab.evaluate((list) => window.fake.entries(list), [entry('w1'), entry('w2')]);
  await tab.locator('#logoutLink').click();
  const dialog = tab.locator('.fmo-dialog');
  await dialog.waitFor();
  assert.equal(await dialog.getAttribute('role'), 'alertdialog');
  assert.match(await dialog.innerText(), /2 changes have not been sent yet\. If you sign out now they stay on this device and are sent the next time you sign in here\./);
  assert.equal(await tab.evaluate(() => document.activeElement.textContent), 'Stay signed in');
  await shot('signout');
  await tab.keyboard.press('Escape');
  await tab.waitForFunction(() => !document.querySelector('.fmo-dialog'));
  assert.match(tab.url(), /\/portal\/$/, 'staying keeps the page');

  // Code that signs out without a link asks the same question.
  const answer = tab.evaluate(() => window.PlatformOfflineUI.confirmSignOut());
  await dialog.locator('button', { hasText: 'Stay signed in' }).click();
  assert.equal(await answer, false);

  await tab.locator('#logoutLink').click();
  await dialog.locator('button', { hasText: 'Sign out anyway' }).click();
  await tab.waitForURL(/\/portal\/logout\.php$/);
  assert.deepEqual(errors, []);
  await context.close();
});

test('every string goes through PlatformLanguage in the platform-offline namespace, and no page is loaded without a click', async () => {
  const { tab, context, errors } = await open({ query: '?lang=1' });
  await tab.evaluate((list) => { window.fake.set({ online: false }); window.fake.entries(list); window.PlatformOfflineUI.open(); }, [entry('w1', { label: { key: 'label_note', title: 'Note', detail: 'Call the adjuster back' } }), entry('f1', { state: 'failed', error: { status: 500 } })]);
  await tab.locator('.fmo-tray [data-entry=w1]').waitFor();
  assert.equal(await tab.locator('[data-entry=w1] .fmo-entry-title').innerText(), 'Note (from the catalog)', 'a contract label key is read from the catalog, its title is the fallback');
  assert.equal(await tab.locator('.fmo-tray h2').innerText(), '«Changes on this device»');
  const asked = await tab.evaluate(() => [...new Set(window.PlatformLanguage.asked)]);
  assert.ok(asked.length > 8);
  assert.ok(asked.every((key) => key.startsWith('platform-offline/')), 'only the platform-offline namespace');
  const strings = await tab.evaluate(() => window.PlatformOfflineUI.strings);
  for (const key of asked) assert.ok(key === 'platform-offline/label_note' || key.slice('platform-offline/'.length) in strings, key + ' has English in the strings table');
  for (const key of ['connect_once_title', 'connect_once_body', 'connect_once_retry']) assert.ok(strings[key], key);
  assert.deepEqual(errors, []);
  await context.close();

  // The catalog source holds the same English, with ICU messages marked as such.
  const source = JSON.parse(readFileSync(new URL('../public/v1/platform/localization/catalog-source.json', import.meta.url), 'utf8'))['platform-offline'];
  assert.ok(source, 'catalog-source.json has the platform-offline namespace');
  const english = Object.fromEntries(Object.entries(source).map(([key, value]) => [key, typeof value === 'string' ? value : value.message]));
  for (const [key, text] of Object.entries(strings)) assert.equal(english[key], text, 'catalog English for ' + key);
  for (const [key, value] of Object.entries(source)) if (/\{/.test(typeof value === 'string' ? value : value.message)) assert.equal(value.format, 'icu', key + ' takes values, so it is an ICU message');

  // The two reloads in the file are inside click handlers: the tray's "Load the latest" and nothing else.
  const code = readFileSync(UI_FILE, 'utf8');
  const reloads = [...code.matchAll(/location\.(reload|assign|replace|href\s*=)/g)].map((match) => code.slice(code.lastIndexOf('\n', match.index) + 1, code.indexOf('\n', match.index)));
  assert.equal(reloads.length, 2);
  for (const line of reloads) assert.match(line, /on: \{ click: \(\) => \{ window\.location\.(reload\(\)|assign\('\/portal\/login\.php'\)); \} \}/);
});
