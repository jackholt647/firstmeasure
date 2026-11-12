import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { createShakeDetector, SHAKE, watchShake } from '../../libraries/dev-console/shake.js';
import { trackerClient, composeIssue, groupIssues, DEFAULT_WORKSPACE, TRACKER } from '../../libraries/dev-console/tracker-client.js';

// The dev tray (docs/architecture/dev-console.md, "Quick tray"): the shake rule shared with the Android host, the
// Tracker contract the tray depends on, and the app's screenshot bridge.

/** Samples every 16 ms of linear acceleration along x following `wave(t)`; returns how many shakes fired. */
function run(wave, ms, { rules = SHAKE, gravity = false } = {}) {
  let shakes = 0;
  const d = createShakeDetector(() => shakes++, rules);
  for (let t = 0; t <= ms; t += 16) d.sample(wave(t), 0, (gravity ? 9.81 : 0) + (gravity ? 0 : 0.2), t, { gravity });
  return shakes;
}
const sine = (amp, hz) => (t) => amp * Math.sin((2 * Math.PI * hz * t) / 1000);

test('one quick hard shake fires once; it stays quiet for the cooldown', () => {
  // About two back-and-forth swings at 4 Hz and 2.5 g.
  assert.equal(run((t) => (t < 500 ? sine(25, 4)(t) : 0), 600), 1);
  // Shaking on for 3 s: once, then again only after the cooldown.
  const n = run(sine(25, 4), 3000);
  assert.ok(n >= 1 && n <= 2, `fired ${n} times`);
});

test('ordinary handling does not fire: walking, a bump and its rebound, slow strong swings, gentle shakes', () => {
  assert.equal(run(sine(6, 2), 5000), 0, 'walking: about 0.6 g at 2 Hz');
  assert.equal(run(sine(12, 4), 3000), 0, 'a gentle shake below the threshold');
  // Setting the phone down hard: one spike and a smaller rebound the other way.
  assert.equal(run((t) => (t >= 100 && t < 140 ? 30 : t >= 140 && t < 180 ? -18 : 0), 600), 0, 'a bump and rebound');
  // Three strong strokes, but spread over 1.5 s (waving the phone around): too slow.
  assert.equal(run(sine(25, 1), 1500), 0, 'slow swings');
});

test('raw accelerometer readings with gravity work too', () => {
  assert.equal(run((t) => (t < 400 ? 0 : t < 900 ? sine(28, 4)(t) : 0), 1000, { gravity: true }), 1);
  assert.equal(run(() => 0, 2000, { gravity: true }), 0, 'gravity alone is not a shake');
});

test('real sensors: a fast shake that reverses between samples, with noise on every axis, still fires', () => {
  // 50 Hz readings (Android SENSOR_DELAY_GAME), a hard 5 Hz shake that is nearly square: it flips sign between two
  // samples without reading near zero, while the other axes wobble by a few m/s².
  let seed = 7; const noise = () => ((seed = (seed * 16807) % 2147483647) / 2147483647 - 0.5) * 6;
  const fire = (wave, ms) => { let n = 0; const d = createShakeDetector(() => n++); for (let t = 0; t <= ms; t += 20) d.sample(wave(t), noise(), noise(), t); return n; };
  assert.equal(fire((t) => (t < 600 ? Math.sign(Math.sin((2 * Math.PI * 5 * t) / 1000) || 1) * 20 : 0), 700), 1, 'square shake');
  assert.equal(fire((t) => (t < 600 ? 16 * Math.sin((2 * Math.PI * 5 * t) / 1000) : 0), 700), 1, 'a moderate hard shake (about 1.6 g)');
  assert.equal(fire((t) => 5 * Math.sin((2 * Math.PI * 2 * t) / 1000), 5000), 0, 'walking with noise');
});

test('watchShake: the app event and devicemotion both open it; one shake fires once', () => {
  const listeners = {};
  const win = { addEventListener: (n, f) => { listeners[n] = f; }, removeEventListener: (n) => { delete listeners[n]; }, PhoneFeatures: null };
  let shakes = 0;
  const stop = watchShake(() => shakes++, win);
  for (let t = 0; t <= 600; t += 16) listeners.devicemotion({ timeStamp: t, acceleration: { x: sine(25, 4)(t), y: 0, z: 0 } });
  assert.equal(shakes, 1, 'devicemotion');
  listeners['fm:native:shake']();
  assert.equal(shakes, 2, 'the app event');
  // A raw-only browser (no linear acceleration): gravity is removed.
  for (let t = 5000; t <= 5600; t += 16) listeners.devicemotion({ timeStamp: t, acceleration: null, accelerationIncludingGravity: { x: sine(25, 4)(t), y: 9.81, z: 0 } });
  assert.equal(shakes, 3);
  stop();
  assert.deepEqual(Object.keys(listeners), []);
});

function fakeTracker(routes) {
  const calls = [];
  const store = new Map();
  const storage = { getItem: (k) => store.get(k) ?? null, setItem: (k, v) => store.set(k, v), removeItem: (k) => store.delete(k) };
  const fetch = async (url, init) => {
    calls.push({ url, ...init });
    const path = url.slice(`${TRACKER}/api/v1`.length);
    const [status, body] = (routes[`${init.method} ${path.split('?')[0]}`] || (() => [404, { error: 'nope' }]))(path, init);
    return { ok: status < 400, status, text: async () => JSON.stringify(body) };
  };
  return { calls, store, client: trackerClient({ fetch, storage }) };
}

test('Tracker: app sign-in, bearer without cookies, workspaces, issues, upload and create', async () => {
  const t = fakeTracker({
    'POST /auth/login': (_, init) => (JSON.parse(init.body).password === 'right' ? [200, { token: 'fts_abc', user: { id: 'u1', name: 'Jack', email: 'j@x' } }] : [401, { error: 'Wrong email or password' }]),
    'GET /projects': () => [200, [{ id: 'p1', name: 'Zeta', kind: 'workspace' }, { id: 'p2', name: DEFAULT_WORKSPACE, kind: 'workspace' }, { id: 'p3', name: 'A plain project', kind: 'project' }, { id: 'p4', name: 'Old', kind: 'workspace', archived_at: '2026-01-01' }]],
    'GET /issues': () => [200, [{ key: 'FM-1' }]],
    'POST /uploads': () => [201, { url: `${TRACKER}/uploads/abc.jpg` }],
    'POST /issues': (_, init) => [201, { key: 'FM-2', ...JSON.parse(init.body) }]
  });
  const { client, calls } = t;
  assert.equal(client.signedIn, false);
  await assert.rejects(client.signIn('j@x', 'wrong'), /Wrong email or password/);
  assert.equal(client.signedIn, false);
  assert.equal((await client.signIn('j@x', 'right')).name, 'Jack');
  assert.deepEqual(JSON.parse(calls[1].body), { email: 'j@x', password: 'right', token: true, label: 'FirstMate dev tray' });
  assert.equal(client.signedIn, true);
  assert.equal(JSON.parse(t.store.get('fm-dev-tray-tracker')).token, 'fts_abc', 'kept on this device');
  assert.equal(trackerClient({ fetch: async () => {}, storage: { getItem: (k) => t.store.get(k) } }).signedIn, true, 'and read back on the next page');

  const ws = await client.workspaces();
  assert.deepEqual(ws.map((w) => w.name), [DEFAULT_WORKSPACE, 'Zeta'], 'workspaces only, General platform work first, archived left out');
  const last = calls.at(-1);
  assert.equal(last.headers.Authorization, 'Bearer fts_abc');
  assert.equal(last.credentials, 'omit', 'never sends cookies across origins');
  assert.equal(last.headers['X-Tracker-Client'], undefined);

  await client.issues('p2', 'open');
  assert.match(calls.at(-1).url, /\/issues\?project=p2&status=open$/);
  await client.issues('p2', 'done', { now: Date.parse('2026-11-12T00:00:00Z') });
  assert.match(calls.at(-1).url, /status=closed&updated_since=2026-11-05T00%3A00%3A00.000Z/);

  const blob = new Blob([new Uint8Array([1, 2, 3])], { type: 'image/jpeg' });
  assert.equal((await client.upload(blob)).url, `${TRACKER}/uploads/abc.jpg`);
  const upload = calls.at(-1);
  assert.equal(upload.headers['Content-Type'], 'image/jpeg');
  assert.equal(upload.headers['X-Filename'], undefined, 'Tracker does not allow X-Filename across origins');
  assert.equal(upload.body, blob);

  const created = await client.create(composeIssue('Button is cut off', { workspaceId: 'p2' }));
  assert.equal(created.key, 'FM-2');
  assert.equal(created.status, 'Ready');
  assert.equal(created.project, 'p2');
});

test('Tracker: a 401 forgets the token; sign out forgets it too', async () => {
  const t = fakeTracker({
    'POST /auth/login': () => [200, { token: 'fts_abc', user: { name: 'Jack' } }],
    'GET /projects': () => [401, { error: 'Sign in required' }],
    'POST /auth/logout': () => [200, { ok: true }]
  });
  await t.client.signIn('j@x', 'p');
  await assert.rejects(t.client.workspaces(), (e) => e.status === 401);
  assert.equal(t.client.signedIn, false);
  assert.equal(t.store.has('fm-dev-tray-tracker'), false);
  await t.client.signIn('j@x', 'p');
  await t.client.signOut();
  assert.equal(t.client.signedIn, false);
  assert.equal(t.calls.at(-1).headers.Authorization, 'Bearer fts_abc', 'the token is revoked on Tracker');
});

test('Tracker unreachable is a clear error', async () => {
  const client = trackerClient({ fetch: async () => { throw new TypeError('Failed to fetch'); }, storage: null });
  await assert.rejects(client.workspaces(), (e) => e.status === 0 && /could not be reached/.test(e.message));
});

test('composeIssue: a short line is the title; a longer note goes untitled for the titler; screenshot and context follow', () => {
  const short = composeIssue('  Save button overlaps the map  ', { workspaceId: 'w', screenshotUrl: 'https://tracker.1m8.ai/uploads/a.jpg', page: '/portal/#projects', viewport: '390×844', app: 'FirstMate android 1.0.9' });
  assert.equal(short.title, 'Save button overlaps the map');
  assert.equal(short.status, 'Ready');
  assert.equal(short.description, '![Screenshot](https://tracker.1m8.ai/uploads/a.jpg)\n\n_Filed from the dev tray. Page: /portal/#projects · Screen: 390×844 · App: FirstMate android 1.0.9_');
  const long = composeIssue('First line\nSecond line', { workspaceId: 'w' });
  assert.equal('title' in long, false);
  assert.equal(long.description, 'First line\nSecond line');
  assert.equal('title' in composeIssue('x'.repeat(121), { workspaceId: 'w' }), false);
});

test('groupIssues: in progress first, then ready, then backlog; newest first within a stage', () => {
  const issue = (key, name, category, updated) => ({ key, status: { name, category, color: '#000' }, updated_at: updated });
  const groups = groupIssues([issue('A', 'Ready', 'unstarted', '2026-11-01'), issue('B', 'In progress', 'started', '2026-11-02'), issue('C', 'Ready', 'unstarted', '2026-11-03'), issue('D', 'Draft', 'backlog', '2026-11-04')]);
  assert.deepEqual(groups.map((g) => [g.name, g.issues.map((i) => i.key)]), [['In progress', ['B']], ['Ready', ['C', 'A']], ['Draft', ['D']]]);
});

test('PhoneFeatures.screenshot: only with the screenshot capability; returns the image the app sent', async () => {
  const source = fs.readFileSync(new URL('../../libraries/phone-features/phone-features.js', import.meta.url), 'utf8');
  const fixture = (capabilities) => {
    const sent = [], window = { addEventListener: () => {}, dispatchEvent: () => {}, FirstMeasureNative: { postMessage: (v) => sent.push(JSON.parse(v)) } };
    vm.runInNewContext(source, { window, document: { documentElement: { dataset: {} }, addEventListener: () => {} }, location: { href: 'https://dev.1m8.ai/portal/', origin: 'https://dev.1m8.ai' }, navigator: {}, URL, crypto: globalThis.crypto, File, Blob, Uint8Array, atob, btoa, CustomEvent: class { constructor(type, data) { Object.assign(this, { type, ...data }); } }, setTimeout, clearTimeout });
    const reply = (id, result, error) => window.FirstMeasureNative.onmessage({ data: JSON.stringify({ id, result, error }) });
    reply(sent[0].id, { bridgeVersion: 1, platform: 'android', capabilities });
    return { api: window.PhoneFeatures, sent, reply };
  };
  const old = fixture(['haptic']);
  await assert.rejects(old.api.screenshot(), { code: 'unsupported' });
  const f = fixture(['screenshot']);
  const pending = f.api.screenshot();
  await new Promise((r) => setImmediate(r));
  const call = f.sent.at(-1);
  assert.equal(call.method, 'screenshot');
  f.reply(call.id, { mime: 'image/jpeg', data: 'AQID', width: 1, height: 1 });
  const blob = await pending;
  assert.equal(blob.type, 'image/jpeg');
  assert.deepEqual([...new Uint8Array(await blob.arrayBuffer())], [1, 2, 3]);
  const bad = f.api.screenshot();
  await new Promise((r) => setImmediate(r));
  f.reply(f.sent.at(-1).id, { mime: 'text/html', data: 'AQID' });
  await assert.rejects(bad, { code: 'invalid_screenshot' });
});
