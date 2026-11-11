// The offline engine (docs/architecture/offline.md): public/libraries/platform-offline/offline-core.js run as the
// service worker runs it, with a Map in place of IndexedDB and a scripted server in place of the network.
// The worker, the page API and the code sets are covered in a real browser by tests/offline-sw-browser.test.mjs.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { webcrypto } from 'node:crypto';
import vm from 'node:vm';

const read = (file) => readFileSync(new URL('../public/libraries/platform-offline/' + file, import.meta.url), 'utf8');
const engineSource = read('offline-core.js');
const coreContract = read('contracts/core.js');
const ORIGIN = 'https://app.test';
const ME = { user: 'user_1', org: 'org_1' };
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
// The engine runs in its own context, so its arrays and objects are compared by value (as JSON), not by prototype.
const eq = (actual, expected, message) => assert.deepStrictEqual(JSON.parse(JSON.stringify(actual ?? null)), JSON.parse(JSON.stringify(expected ?? null)), message);

/** A scripted server: routes answer, `down` drops every request, `log` keeps what arrived. */
function fakeServer() {
  const routes = [];
  const server = {
    down: false, log: [], csrf: 'csrf-1', inFlight: 0, maxInFlight: 0,
    on(pattern, handler) { routes.unshift({ pattern, handler }); return server; },
    sent: (pattern) => server.log.filter((entry) => `${entry.method} ${entry.path}`.startsWith(pattern)),
    async fetch(input, init) {
      const request = input instanceof Request ? input : new Request(input, init);
      const url = new URL(request.url);
      const headers = Object.fromEntries(request.headers);
      let body = null;
      const type = headers['content-type'] || '';
      if (request.method !== 'GET' && request.method !== 'HEAD') {
        if (type.includes('multipart/form-data')) { body = {}; for (const [name, value] of (await request.formData()).entries()) body[name] = typeof value === 'string' ? value : { name: value.name, type: value.type, text: await value.text() }; }
        else { const text = await request.text(); try { body = JSON.parse(text); } catch { body = text; } }
      }
      const entry = { method: request.method, path: url.pathname, query: url.search, headers, body };
      if (server.down) throw new TypeError('Failed to fetch');
      server.log.push(entry);
      const route = routes.find((item) => `${entry.method} ${entry.path}`.startsWith(item.pattern));
      server.inFlight++; server.maxInFlight = Math.max(server.maxInFlight, server.inFlight);
      let answer;
      try { answer = route ? await route.handler(entry) : { status: 404, json: { ok: false, error: 'not_found' } }; } finally { server.inFlight--; }
      if (answer === 'drop') throw new TypeError('Failed to fetch');
      if (answer.body !== undefined) return new Response(answer.body, { status: answer.status || 200, headers: answer.headers || {} });
      return new Response(JSON.stringify(answer.json), { status: answer.status || 200, headers: { 'Content-Type': 'application/json', ...(answer.headers || {}) } });
    }
  };
  return server;
}

/** TEST ONLY: one small contract with every kind of write. Real contracts live in platform-offline/contracts/. */
function addTestContract(FM) {
  FM.contracts.add({
    id: 'test',
    boot: ['GET /v1/boot'],
    reads: [{ id: 'actions', match: 'POST /v1/platform/portal-action', when: (ctx) => ctx.body.action === 'list_notes', key: (ctx) => ({ action: ctx.body.action, project: ctx.body.project_id }) }],
    prefetch: [
      (ctx) => [`/v1/projects/${ctx.project}`],
      { url: (ctx) => `/v1/projects/${ctx.project}/notes`, each: (json) => json.notes.map((note) => `/v1/notes/${note.id}`) }
    ],
    writes: [
      {
        id: 'notes.post', match: 'POST /v1/projects/:project/notes', kind: 'create',
        scope: (ctx) => `project:${ctx.params.project}`,
        label: (ctx) => ({ title: 'Note', detail: ctx.body.text }),
        records: (ctx) => [ctx.body.id],
        respond: (ctx) => ({ ok: true, note: { id: ctx.body.id, text: ctx.body.text, waiting: true } }),
        effects: (ctx) => [{
          match: 'GET /v1/projects/:project/notes', when: (m) => m.project === ctx.params.project,
          apply: (json) => ({ ...json, notes: [...json.notes.filter((note) => note.id !== ctx.body.id), ctx.response.note] })
        }]
      },
      { id: 'notes.star', match: 'POST /v1/notes/:note/star', kind: 'action', scope: (ctx) => `project:${ctx.body.project_id}`, records: (ctx) => [ctx.params.note], respond: () => ({ ok: true }) },
      {
        id: 'project.patch', match: 'PATCH /v1/projects/:project', kind: 'patch',
        scope: (ctx) => `project:${ctx.params.project}`, records: (ctx) => [ctx.params.project],
        respond: (ctx) => ({ ok: true, project: { id: ctx.params.project, ...ctx.body } }),
        effects: (ctx) => [{ match: 'GET /v1/projects/:project', apply: (json) => ({ ...json, project: { ...json.project, ...ctx.body } }) }],
        conflict: {
          current: (ctx) => `/v1/projects/${ctx.params.project}`,
          pick: (json) => ({ doc: json.project, revision: json.project.revision }),
          fields: (ctx) => Object.keys(ctx.body),
          send: (ctx, merged, revision) => ({ ...merged, expected_revision: revision })
        }
      },
      { id: 'media.upload', match: 'POST /v1/platform/organizations/:org/media', kind: 'upload', scope: (ctx) => `project:${ctx.body.project_id}`, records: (ctx) => [ctx.body.id], respond: (ctx) => ({ ok: true, media: { id: ctx.body.id, waiting: true } }) },
      { id: 'actions.save', match: 'POST /v1/platform/portal-action', kind: 'action', when: (ctx) => ctx.body.action === 'save_thing', scope: () => 'actions', respond: () => ({ success: true, queued: true }) },
      { id: 'links.add', match: 'POST /v1/links', kind: 'action', scope: (ctx) => `link:${ctx.body.from}`, respond: () => ({ ok: true }) }
    ]
  });
}

/** A fresh engine in its own context, as one service worker would hold it. */
function engine(options = {}) {
  const server = options.server || fakeServer();
  const clock = { now: 1_800_000_000_000 };
  const navigator = { onLine: true };
  const space = { quota: 10 ** 12, usage: 0 };
  const context = vm.createContext({ URL, URLSearchParams, Request, Response, Headers, Blob, File, FormData, AbortController, TextEncoder, TextDecoder, crypto: webcrypto, console, setTimeout, clearTimeout, navigator, location: { origin: ORIGIN } });
  context.self = context;
  vm.runInContext(engineSource, context, { filename: 'offline-core.js' });
  const FM = context.FMOffline;
  FM.configure({ fetch: server.fetch, now: () => clock.now, identity: async () => options.identity || ME, csrf: async () => server.csrf, estimate: async () => space, limits: { readTimeoutMs: 80, readTimeoutAfterFailureMs: 30 } });
  if (options.store) FM.configure({}); // (the store is per context; a second engine shares nothing)
  vm.runInContext(coreContract, context, { filename: 'contracts/core.js' });
  addTestContract(FM);
  const events = [];
  for (const type of ['queued', 'synced', 'failed', 'conflict', 'discarded', 'state']) FM.events.on(type, (detail) => events.push({ type, detail }));
  const waits = [];
  /** What the worker does with a request from a page of `identity`: the answer, or 'untouched' when it does not answer. */
  const request = async (method, path, init = {}, identity = ME) => {
    const headers = { ...(init.headers || {}) };
    let body = init.body;
    if (init.json !== undefined) { body = JSON.stringify(init.json); headers['Content-Type'] = 'application/json'; }
    const req = new Request(ORIGIN + path, { method, headers, body, signal: init.signal });
    const plan = FM.api.plan(req, identity, { waitUntil: (promise) => waits.push(promise) });
    if (!plan) return 'untouched';
    return plan();
  };
  const settle = async () => { while (waits.length) await waits.shift(); };
  const json = async (method, path, init, identity) => { const response = await request(method, path, init, identity); const data = await response.json(); await settle(); return { response, data }; };
  const entries = async () => (await FM.queue.list(ME)).map((entry) => ({ ...entry }));
  return { FM, server, clock, navigator, space, events, request, json, settle, entries, of: (type) => events.filter((event) => event.type === type).map((event) => event.detail) };
}

const note = (id, text, project = 'p1') => ['POST', `/v1/projects/${project}/notes`, { json: { id, text } }];

// ---------------------------------------------------------------------------------------------------------------
// Routes and keys
// ---------------------------------------------------------------------------------------------------------------

test('route patterns match by method, :params, * and **', () => {
  const { FM } = engine();
  const { compile } = FM.util;
  eq({ ...compile('GET /v1/channels/:org/messages/:id').match('GET', '/v1/channels/o%201/messages/m2') }, { org: 'o 1', id: 'm2' });
  assert.equal(compile('GET /v1/channels/:org/messages').match('POST', '/v1/channels/o1/messages'), null);
  assert.ok(compile('/v1/a/*/c').match('DELETE', '/v1/a/b/c'));
  assert.equal(compile('/v1/a/*/c').match('GET', '/v1/a/b/b/c'), null);
  assert.ok(compile('/v1/**/events/stream').match('GET', '/v1/platform/organizations/o1/events/stream'));
  assert.ok(compile('/v1/payments/**').match('POST', '/v1/payments'));
  assert.ok(compile('/v1/payments/**').match('POST', '/v1/payments/checkout/prepare'));
  assert.equal(compile('/v1/payments/**').match('GET', '/v1/paymentsx'), null);
  assert.ok(compile('GET /v1/things').match('GET', '/v1/things/'), 'a trailing slash is the same route');
});

test('a saved read\'s key ignores query order and cache-busters, and keeps repeated values in order', () => {
  const { FM } = engine();
  const key = (path) => FM.reads.key('GET', new URL(ORIGIN + path));
  assert.equal(key('/v1/list?b=2&a=1'), 'GET /v1/list?a=1&b=2');
  assert.equal(key('/v1/list?a=1&b=2&_=1700000000&cb=9&_t=4'), 'GET /v1/list?a=1&b=2');
  assert.equal(key('/v1/list?tag=z&tag=a&q=hello%20world'), 'GET /v1/list?q=hello%20world&tag=z&tag=a');
  assert.equal(key('/v1/list'), 'GET /v1/list');
  assert.notEqual(key('/v1/list?a=1'), key('/v1/list?a=2'));
});

// ---------------------------------------------------------------------------------------------------------------
// Saved reads
// ---------------------------------------------------------------------------------------------------------------

test('a JSON GET is saved and answered from the device when the network fails', async () => {
  const t = engine();
  t.server.on('GET /v1/projects/p1', () => ({ json: { project: { id: 'p1', title: 'Oak St' } } }));
  const first = await t.json('GET', '/v1/projects/p1?b=2&a=1');
  assert.equal(first.response.headers.get('x-fm-offline'), null, 'online: the network answer, untouched');
  assert.equal(first.data.project.title, 'Oak St');
  t.server.down = true;
  t.clock.now += 5000;
  const saved = await t.json('GET', '/v1/projects/p1?a=1&b=2&_=123');
  assert.equal(saved.response.status, 200);
  assert.equal(saved.response.headers.get('x-fm-offline'), 'saved');
  assert.equal(saved.response.headers.get('x-fm-saved-at'), new Date(t.clock.now - 5000).toISOString());
  assert.equal(saved.data.project.title, 'Oak St');
  await assert.rejects(t.request('GET', '/v1/projects/never-seen'), /Failed to fetch/, 'nothing saved: the page gets the network failure');
});

test('a slow network is answered from the device, and its late answer still replaces the saved copy', async () => {
  const t = engine();
  let title = 'First';
  let delay = 0;
  t.server.on('GET /v1/projects/p1', async () => { await sleep(delay); return { json: { project: { title } } }; });
  await t.json('GET', '/v1/projects/p1');
  title = 'Second'; delay = 200;                      // slower than the 80 ms the test allows
  const started = Date.now();
  const slow = await t.request('GET', '/v1/projects/p1');
  assert.ok(Date.now() - started < 190, 'answered before the network did');
  assert.equal(slow.headers.get('x-fm-offline'), 'saved');
  assert.equal((await slow.json()).project.title, 'First');
  await t.settle();                                   // the network answer arrives and is stored
  t.server.down = true;
  assert.equal((await t.json('GET', '/v1/projects/p1')).data.project.title, 'Second');
});

test('after a failure the wait is the short one; any answer restores the long one', async () => {
  const t = engine();
  let delay = 0;
  t.server.on('GET /v1/a', async () => { await sleep(delay); return { json: { a: 1 } }; });
  await t.json('GET', '/v1/a');
  t.server.down = true;
  await t.json('GET', '/v1/a');
  assert.equal(t.FM.net.lastFailed, true);
  t.server.down = false; delay = 55;                  // between the short wait (30) and the long one (80)
  assert.equal((await t.json('GET', '/v1/a')).response.headers.get('x-fm-offline'), 'saved', 'short wait after a failure');
  assert.equal(t.FM.net.lastFailed, false, 'the late answer says the connection is back');
  assert.equal((await t.json('GET', '/v1/a')).response.headers.get('x-fm-offline'), null, 'long wait again: the network answers in time');
});

test('deny-listed routes, the realtime stream and replayed requests are never answered or saved', async () => {
  const t = engine();
  t.server.on('GET /v1/', () => ({ json: { secret: true } }));
  for (const path of ['/v1/platform/organizations/org_1/events/stream', '/v1/platform/organizations/org_1/events/poll?after=4', '/v1/platform/auth/session', '/v1/payments/accounts/a1', '/v1/platform/session-replay/sessions', '/v1/assistant/threads/t1', '/v1/platform/offline/assets', '/v1/documents/d1/collab/stream']) {
    assert.equal(await t.request('GET', path), 'untouched', path);
  }
  assert.equal(await t.request('POST', '/v1/platform/auth/logout', { json: {} }), 'untouched');
  assert.equal(await t.request('POST', '/v1/payments/checkout', { json: {} }), 'untouched');
  assert.equal(await t.request('GET', '/v1/projects/p1', { headers: { Accept: 'text/event-stream' } }), 'untouched');
  assert.equal(await t.request('GET', '/v1/projects/p1', { headers: { 'X-FM-Offline-Replay': '1' } }), 'untouched');
  assert.equal(await t.request('POST', '/v1/projects/p1/notes', { json: { id: 'n1', text: 'x' }, headers: { 'X-FM-Offline-Replay': '1' } }), 'untouched');
  assert.equal((await t.FM.db.list('responses')).length, 0);
  assert.equal(t.server.log.length, 0, 'the worker made no request of its own');
});

test('only JSON 200 answers are saved', async () => {
  const t = engine();
  t.server.on('GET /v1/file', () => ({ body: 'plain text', headers: { 'Content-Type': 'text/plain' } }));
  t.server.on('GET /v1/missing', () => ({ status: 404, json: { ok: false } }));
  t.server.on('GET /v1/good', () => ({ json: { ok: true } }));
  for (const path of ['/v1/file', '/v1/missing', '/v1/good']) { await (await t.request('GET', path)).text(); await t.settle(); }
  eq((await t.FM.db.list('responses')).map((row) => row.k[2]), ['GET /v1/good']);
});

test('a declared POST read is saved by its key; other bodies of the same route are not reads', async () => {
  const t = engine();
  t.server.on('POST /v1/platform/portal-action', (request) => ({ json: { success: true, notes: [`${request.body.project_id}-note`] } }));
  const list = (project, extra = {}) => t.json('POST', '/v1/platform/portal-action', { json: { action: 'list_notes', project_id: project, ...extra } });
  eq((await list('p1')).data.notes, ['p1-note']);
  eq((await list('p2')).data.notes, ['p2-note']);
  t.server.down = true;
  const saved = await list('p1', { nonce: 'ignored-by-the-key' });
  assert.equal(saved.response.headers.get('x-fm-offline'), 'saved');
  eq(saved.data.notes, ['p1-note']);
  eq((await list('p2')).data.notes, ['p2-note']);
  const other = await t.json('POST', '/v1/platform/portal-action', { json: { action: 'delete_everything' } });
  assert.equal(other.response.status, 503);
  assert.equal(other.data.error, 'offline_unavailable');
});

// ---------------------------------------------------------------------------------------------------------------
// Queued changes
// ---------------------------------------------------------------------------------------------------------------

test('a contract write that gets no answer is queued, answered with respond(ctx) and shown in later reads', async () => {
  const t = engine();
  t.server.on('GET /v1/projects/p1/notes', () => ({ json: { notes: [{ id: 'n0', text: 'on the server' }] } }));
  await t.json('GET', '/v1/projects/p1/notes');
  t.server.down = true;
  const queued = await t.json(...note('n1', 'Call the homeowner'));
  assert.equal(queued.response.status, 200);
  const id = queued.response.headers.get('x-fm-offline-queued');
  assert.match(id, /^fmo1-[0-9a-f-]{36}$/);
  eq(queued.data, { ok: true, note: { id: 'n1', text: 'Call the homeowner', waiting: true } });
  const [entry] = await t.entries();
  assert.equal(entry.id, id);
  eq([entry.contract, entry.write, entry.kind, entry.scope, entry.state], ['test', 'notes.post', 'create', 'project:p1', 'waiting']);
  eq({ ...entry.label }, { title: 'Note', detail: 'Call the homeowner' });
  eq([...entry.records], ['n1']);
  eq(t.of('queued').map((detail) => detail.id), [id]);
  assert.equal((await t.FM.state.queue(ME)).pending, 1);
  eq([...(await t.FM.queue.records(ME))], ['n1']);
  // Saved read: the queued note is in the list.
  const offline = await t.json('GET', '/v1/projects/p1/notes');
  assert.equal(offline.response.headers.get('x-fm-offline'), 'saved');
  eq(offline.data.notes.map((item) => item.id), ['n0', 'n1']);
  // Fresh read: the server does not have it yet, the answer still shows it.
  t.server.down = false;
  const fresh = await t.json('GET', '/v1/projects/p1/notes');
  assert.equal(fresh.response.headers.get('x-fm-offline'), null);
  assert.equal(fresh.response.headers.get('x-fm-offline-overlay'), '1');
  eq(fresh.data.notes.map((item) => item.id), ['n0', 'n1']);
  // Another project's list is untouched, and so is the stored copy (effects are applied when read).
  t.server.on('GET /v1/projects/p2/notes', () => ({ json: { notes: [] } }));
  const other = await t.request('GET', '/v1/projects/p2/notes');
  assert.equal(other.headers.get('x-fm-offline-overlay'), null);
  eq(JSON.parse((await t.FM.reads.row(ME, 'GET /v1/projects/p1/notes')).body).notes.map((item) => item.id), ['n0']);
});

test('the first send already carries the idempotency key and the identity; an HTTP error is an answer, not a reason to queue', async () => {
  const t = engine();
  t.server.on('POST /v1/projects/p1/notes', () => ({ status: 422, json: { ok: false, error: 'invalid' } }));
  const refused = await t.json('POST', '/v1/projects/p1/notes', { json: { id: 'n1', text: 'x' }, headers: { 'X-Platform-CSRF': 'page-token' } });
  assert.equal(refused.response.status, 422);
  assert.equal(refused.response.headers.get('x-fm-offline-queued'), null);
  assert.equal((await t.entries()).length, 0);
  const [sent] = t.server.sent('POST /v1/projects/p1/notes');
  assert.match(sent.headers['idempotency-key'], /^fmo1-/);
  assert.equal(sent.headers['x-fm-offline-user'], 'user_1');
  assert.equal(sent.headers['x-fm-offline-org'], 'org_1');
  assert.equal(sent.headers['x-platform-csrf'], 'page-token', 'the page\'s own headers go through');
  eq(sent.body, { id: 'n1', text: 'x' });
});

test('a write with no contract fails offline with offline_unavailable; online it is the server\'s answer', async () => {
  const t = engine();
  t.server.on('POST /v1/things', () => ({ status: 201, json: { ok: true, id: 't1' } }));
  const online = await t.json('POST', '/v1/things', { json: { a: 1 } });
  assert.equal(online.response.status, 201);
  t.server.down = true;
  const offline = await t.json('POST', '/v1/things', { json: { a: 1 } });
  assert.equal(offline.response.status, 503);
  eq(offline.data, { ok: false, error: 'offline_unavailable' });
  assert.equal((await t.entries()).length, 0, 'never queued, never reported as saved');
  // A route with contracts whose `when` do not match is the same.
  const unmatched = await t.json('POST', '/v1/platform/portal-action', { json: { action: 'something_else' } });
  assert.equal(unmatched.data.error, 'offline_unavailable');
});

test('a write made online while its scope has waiting entries is queued behind them; other scopes go straight through', async () => {
  const t = engine();
  t.server.on('POST /v1/projects/', () => ({ json: { ok: true, from: 'server' } }));
  t.server.down = true;
  await t.json(...note('n1', 'first'));
  t.server.down = false;
  const second = await t.json(...note('n2', 'second'));
  assert.ok(second.response.headers.get('x-fm-offline-queued'), 'queued behind n1');
  assert.equal(t.server.sent('POST /v1/projects/p1/notes').length, 0, 'not sent ahead of the waiting entry');
  const other = await t.json(...note('n3', 'elsewhere', 'p2'));
  assert.equal(other.data.from, 'server');
  eq((await t.entries()).map((entry) => entry.records[0]), ['n1', 'n2']);
});

test('a device that is known to be offline queues without trying the network', async () => {
  const t = engine();
  t.navigator.onLine = false;
  t.server.on('POST /v1/projects/p1/notes', () => ({ json: { ok: true } }));
  const queued = await t.json(...note('n1', 'offline'));
  assert.ok(queued.response.headers.get('x-fm-offline-queued'));
  assert.equal(t.server.log.length, 0);
});

test('nothing is saved or queued for a page that has not said who is signed in', async () => {
  const t = engine();
  t.server.on('GET /v1/projects/p1', () => ({ json: { project: {} } }));
  assert.equal(await t.request('GET', '/v1/projects/p1', {}, null), 'untouched');
  t.server.down = true;
  const write = await t.request(...note('n1', 'x'), null);
  assert.equal(write.status, 503);
  assert.equal((await write.json()).error, 'offline_unavailable');
  assert.equal((await t.FM.db.list('outbox')).length, 0);
  assert.equal((await t.FM.db.list('responses')).length, 0);
});

test('a contract that throws never costs the request: it goes to the network as if there were no contract', async () => {
  const t = engine();
  t.FM.contracts.add({ id: 'broken', writes: [{ id: 'boom', match: 'POST /v1/boom', kind: 'action', when: () => { throw new Error('contract bug'); }, respond: () => ({ ok: true }) }] });
  t.server.on('POST /v1/boom', () => ({ json: { ok: true, from: 'server' } }));
  assert.equal((await t.json('POST', '/v1/boom', { json: {} })).data.from, 'server');
});

// ---------------------------------------------------------------------------------------------------------------
// Replay
// ---------------------------------------------------------------------------------------------------------------

test('replay sends in order per scope with the same key, the identity, the replay mark and a fresh CSRF token; 2xx removes the entry and re-reads what it touched', async () => {
  const t = engine();
  let serverNotes = [];
  t.server.on('GET /v1/projects/p1/notes', () => ({ json: { notes: serverNotes } }));
  t.server.on('POST /v1/projects/p1/notes', (request) => { serverNotes = [...serverNotes, { id: request.body.id, text: request.body.text, number: serverNotes.length + 1 }]; return { status: 201, json: { ok: true, note: serverNotes.at(-1) } }; });
  await t.json('GET', '/v1/projects/p1/notes');
  t.server.down = true;
  const ids = [];
  for (const [id, text] of [['n1', 'one'], ['n2', 'two'], ['n3', 'three']]) ids.push((await t.json(...note(id, text))).response.headers.get('x-fm-offline-queued'));
  t.server.down = false; t.server.log.length = 0; t.server.csrf = 'csrf-fresh';
  const result = await t.FM.replay.run();
  assert.equal(result.sent, 3);
  const posts = t.server.sent('POST /v1/projects/p1/notes');
  eq(posts.map((post) => post.body.id), ['n1', 'n2', 'n3'], 'oldest first');
  eq(posts.map((post) => post.headers['idempotency-key']), ids, 'the key each was queued with');
  for (const post of posts) {
    assert.equal(post.headers['x-fm-offline-replay'], '1');
    assert.equal(post.headers['x-fm-offline-user'], 'user_1');
    assert.equal(post.headers['x-fm-offline-org'], 'org_1');
    assert.equal(post.headers['x-platform-csrf'], 'csrf-fresh');
    assert.equal(post.headers['content-type'], 'application/json');
  }
  assert.equal((await t.entries()).length, 0);
  const synced = t.of('synced');
  eq(synced.map((detail) => detail.id), ids);
  eq({ ...synced[0].response.note }, { id: 'n1', text: 'one', number: 1 }, 'the real answer');
  assert.equal(synced[0].status, 201);
  // The saved read was read again, so the copy on the device is the server's.
  const reread = t.server.sent('GET /v1/projects/p1/notes');
  assert.ok(reread.length >= 1 && reread.every((get) => get.headers['x-fm-offline-replay'] === '1'));
  t.server.down = true;
  const saved = await t.json('GET', '/v1/projects/p1/notes');
  eq(saved.data.notes.map((item) => item.number), [1, 2, 3]);
  const state = await t.FM.state.queue(ME);
  eq([state.pending, state.failed, state.conflicts, state.lastSyncAt], [0, 0, 0, t.clock.now]);
});

test('scopes replay side by side, three at a time, each in its own order', async () => {
  const t = engine();
  t.server.down = true;
  for (const project of ['p1', 'p2', 'p3', 'p4', 'p5']) for (const n of [1, 2]) await t.json(...note(`${project}-n${n}`, 'x', project));
  t.server.down = false; t.server.log.length = 0; t.server.maxInFlight = 0;
  t.server.on('POST /v1/projects/', async () => { await sleep(15); return { json: { ok: true } }; });
  assert.equal((await t.FM.replay.run()).sent, 10);
  assert.equal(t.server.maxInFlight, 3);
  for (const project of ['p1', 'p2', 'p3', 'p4', 'p5']) eq(t.server.sent(`POST /v1/projects/${project}/notes`).map((post) => post.body.id), [`${project}-n1`, `${project}-n2`]);
});

test('no answer: the entry stays and is retried after 2 s, 5 s, 15 s, 1 min, then every 5 min', async () => {
  const t = engine();
  t.server.down = true;
  await t.json(...note('n1', 'x'));
  const waits = [];
  for (let i = 0; i < 6; i++) {
    const before = t.clock.now;
    await t.FM.replay.run();
    const [entry] = await t.entries();
    assert.equal(entry.state, 'waiting');
    waits.push(entry.nextAt - before);
    t.clock.now = entry.nextAt - 1;
    assert.equal((await t.FM.replay.run()).sent, 0);
    assert.equal((await t.entries())[0].attempts, i + 1, 'not tried before it is due');
    t.clock.now = entry.nextAt;
  }
  eq(waits, [2000, 5000, 15000, 60000, 300000, 300000]);
  t.server.down = false;
  t.server.on('POST /v1/projects/p1/notes', () => ({ json: { ok: true } }));
  assert.equal((await t.FM.replay.run()).sent, 1);
});

test('no answer stops the run: what was not already on its way is not tried', async () => {
  const t = engine();
  t.server.down = true;
  await t.json(...note('a1', 'x', 'p1')); await t.json(...note('a2', 'x', 'p1')); await t.json(...note('b1', 'x', 'p2'));
  await t.FM.replay.run();
  // The first entry of each scope was already on its way; nothing after them is sent into a dead connection.
  eq((await t.entries()).map((entry) => [entry.records[0], entry.attempts]), [['a1', 1], ['a2', 0], ['b1', 1]]);
  eq(t.FM.net.lastFailed, true);
});

test('401 pauses the queue until the same person signs in again', async () => {
  const t = engine();
  t.server.down = true;
  await t.json(...note('n1', 'x')); await t.json(...note('n2', 'x'));
  t.server.down = false;
  let signedIn = false;
  t.server.on('POST /v1/projects/p1/notes', () => (signedIn ? { json: { ok: true } } : { status: 401, json: { ok: false, error: 'unauthorized' } }));
  eq({ ...(await t.FM.replay.run()) }, { sent: 0, blocked: 'sign-in' });
  assert.equal((await t.FM.state.queue(ME)).blocked, 'sign-in');
  assert.equal(t.server.sent('POST').length, 1, 'the run stopped at the first 401');
  signedIn = true;
  assert.equal((await t.FM.replay.run()).blocked, 'sign-in', 'still paused: nobody signed in');
  assert.equal(t.server.sent('POST').length, 1);
  await t.FM.queue.resume(ME);                         // what the worker does when a page of this person loads
  assert.equal((await t.FM.replay.run()).sent, 2);
  assert.equal((await t.FM.state.queue(ME)).blocked, null);
});

test('403 csrf_required is retried once with a fresh token, then pauses', async () => {
  const t = engine();
  t.server.down = true;
  await t.json(...note('n1', 'x'));
  t.server.down = false;
  t.server.csrf = 'stale';
  t.server.on('POST /v1/projects/p1/notes', (request) => {
    if (request.headers['x-platform-csrf'] !== 'good') { t.server.csrf = 'good'; return { status: 403, json: { ok: false, error: 'csrf_required' } }; }
    return { json: { ok: true } };
  });
  assert.equal((await t.FM.replay.run()).sent, 1);
  eq(t.server.sent('POST').map((post) => post.headers['x-platform-csrf']), ['stale', 'good']);

  const u = engine();
  u.server.down = true;
  await u.json(...note('n1', 'x'));
  u.server.down = false;
  u.server.on('POST /v1/projects/p1/notes', () => ({ status: 403, json: { error: { code: 'csrf_required' } } }));
  assert.equal((await u.FM.replay.run()).blocked, 'sign-in');
  assert.equal(u.server.sent('POST').length, 2, 'one retry, no more');
  assert.equal((await u.entries())[0].state, 'waiting', 'still queued');
});

test('offline_identity_mismatch parks the entry; it is sent again only when the same person signs in', async () => {
  const t = engine();
  t.server.down = true;
  await t.json(...note('n1', 'x')); await t.json(...note('n2', 'x', 'p2'));
  t.server.down = false;
  let mismatch = true;
  t.server.on('POST /v1/projects/', () => (mismatch ? { status: 409, json: { ok: false, error: 'offline_identity_mismatch' } } : { json: { ok: true } }));
  await t.FM.replay.run();
  eq((await t.entries()).map((entry) => entry.state), ['parked', 'parked']);
  eq(t.of('failed').map((detail) => detail.error.code), ['offline_identity_mismatch', 'offline_identity_mismatch']);
  assert.equal((await t.FM.state.queue(ME)).failed, 2);
  const sent = t.server.sent('POST').length;
  mismatch = false;
  await t.FM.replay.run(); t.clock.now += 600000; await t.FM.replay.run();
  assert.equal(t.server.sent('POST').length, sent, 'a parked entry is never sent by itself');
  await t.FM.queue.resume(ME);
  assert.equal((await t.FM.replay.run()).sent, 2);
});

test('another person\'s entries are never replayed or shown', async () => {
  const server = fakeServer();
  const t = engine({ server });
  server.down = true;
  await t.json(...note('mine', 'x'));
  const other = { user: 'user_2', org: 'org_1' };
  await t.request(...note('theirs', 'y'), other);
  server.down = false;
  server.on('POST /v1/projects/p1/notes', () => ({ json: { ok: true } }));
  server.on('GET /v1/projects/p1/notes', () => ({ json: { notes: [] } }));
  assert.equal((await t.FM.replay.run()).sent, 1);
  eq(server.sent('POST').map((post) => [post.body.id, post.headers['x-fm-offline-user']]), [['mine', 'user_1']]);
  const left = await t.FM.db.list('outbox');
  eq(left.map((entry) => [entry.user, entry.records[0]]), [['user_2', 'theirs']]);
  // Their queued note overlays their reads, not mine.
  eq((await t.json('GET', '/v1/projects/p1/notes')).data.notes, []);
  eq((await t.json('GET', '/v1/projects/p1/notes', {}, other)).data.notes.map((item) => item.id), ['theirs']);
  assert.equal((await t.FM.state.queue(other)).pending, 1);
});

test('idempotency_in_progress is retried after 2 s', async () => {
  const t = engine();
  t.server.down = true;
  await t.json(...note('n1', 'x'));
  t.server.down = false;
  let busy = true;
  t.server.on('POST /v1/projects/p1/notes', () => (busy ? { status: 409, json: { ok: false, error: 'idempotency_in_progress' } } : { json: { ok: true } }));
  await t.FM.replay.run();
  const [entry] = await t.entries();
  eq([entry.state, entry.nextAt - t.clock.now, entry.attempts], ['waiting', 2000, 0]);
  busy = false; t.clock.now += 2000;
  assert.equal((await t.FM.replay.run()).sent, 1);
});

test('another 4xx fails the entry and waits for the person: retry sends it under a new key, discard drops it', async () => {
  const t = engine();
  t.server.down = true;
  const first = (await t.json('POST', '/v1/notes/n9/star', { json: { project_id: 'p1' } })).response.headers.get('x-fm-offline-queued');
  await t.json('POST', '/v1/notes/n8/star', { json: { project_id: 'p1' } });
  t.server.down = false;
  let allowed = false;
  t.server.on('POST /v1/notes/n9/star', () => (allowed ? { json: { ok: true } } : { status: 403, json: { ok: false, error: 'forbidden', message: 'You cannot star notes' } }));
  t.server.on('POST /v1/notes/n8/star', () => ({ json: { ok: true } }));
  assert.equal((await t.FM.replay.run()).sent, 1, 'a failed action does not hold its scope');
  const [failed] = await t.entries();
  eq([failed.state, failed.error.status, failed.error.code, failed.error.message], ['failed', 403, 'forbidden', 'You cannot star notes']);
  eq(t.of('failed').map((detail) => detail.id), [first]);
  eq([(await t.FM.state.queue(ME)).failed, (await t.FM.state.queue(ME)).pending], [1, 0]);
  await t.FM.replay.run();
  assert.equal(t.server.sent('POST /v1/notes/n9/star').length, 1, 'not sent again by itself');
  allowed = true;
  await t.FM.queue.retry(first);
  assert.equal((await t.FM.replay.run()).sent, 1);
  const keys = t.server.sent('POST /v1/notes/n9/star').map((post) => post.headers['idempotency-key']);
  assert.equal(keys[0], first);
  assert.ok(keys[1].startsWith('fmo1-') && keys[1] !== first, 'the server keeps a refusal under its key, so a retry needs a new one');
  // discard
  t.server.down = true;
  const again = (await t.json('POST', '/v1/notes/n7/star', { json: { project_id: 'p1' } })).response.headers.get('x-fm-offline-queued');
  assert.equal(await t.FM.queue.discard(again), true);
  assert.equal((await t.entries()).length, 0);
  eq(t.of('discarded').map((detail) => detail.id), [again]);
});

test('5xx is retried like no answer, eight times, then fails', async () => {
  const t = engine();
  t.server.down = true;
  await t.json('POST', '/v1/notes/n9/star', { json: { project_id: 'p1' } });
  await t.json('POST', '/v1/notes/n8/star', { json: { project_id: 'p2' } });
  t.server.down = false;
  t.server.on('POST /v1/notes/n9/star', () => ({ status: 502, body: 'Bad gateway', headers: { 'Content-Type': 'text/html' } }));
  t.server.on('POST /v1/notes/n8/star', () => ({ json: { ok: true } }));
  assert.equal((await t.FM.replay.run()).sent, 1, 'a server error on one scope does not stop the others');
  const waits = [];
  for (let i = 0; i < 7; i++) {
    const [entry] = await t.entries();
    assert.equal(entry.state, 'waiting');
    waits.push(entry.nextAt - t.clock.now);
    t.clock.now = entry.nextAt;
    await t.FM.replay.run();
  }
  eq(waits, [2000, 5000, 15000, 60000, 300000, 300000, 300000]);
  const [entry] = await t.entries();
  eq([entry.state, entry.error.status], ['failed', 502]);
  assert.equal(t.server.sent('POST /v1/notes/n9/star').length, 8);
  const key = entry.key;
  await t.FM.queue.retry(entry.id);
  assert.equal((await t.entries())[0].key, key, 'a 5xx freed the key: the retry keeps it');
});

test('a failed create holds the rest of its scope; other scopes go on', async () => {
  const t = engine();
  t.server.down = true;
  const create = (await t.json(...note('n1', 'x'))).response.headers.get('x-fm-offline-queued');
  await t.json('POST', '/v1/notes/n1/star', { json: { project_id: 'p1' } });
  await t.json(...note('m1', 'y', 'p2'));
  t.server.down = false;
  let valid = false;
  t.server.on('POST /v1/projects/p1/notes', () => (valid ? { json: { ok: true } } : { status: 400, json: { ok: false, error: 'invalid_note' } }));
  t.server.on('POST /v1/projects/p2/notes', () => ({ json: { ok: true } }));
  t.server.on('POST /v1/notes/n1/star', () => ({ json: { ok: true } }));
  assert.equal((await t.FM.replay.run()).sent, 1);
  assert.equal(t.server.sent('POST /v1/notes/n1/star').length, 0, 'the star needs the note: held');
  eq((await t.entries()).map((entry) => entry.state), ['failed', 'waiting']);
  // A new change of that scope made online also waits its turn.
  const later = await t.json('POST', '/v1/notes/n1/star', { json: { project_id: 'p1' } });
  assert.ok(later.response.headers.get('x-fm-offline-queued'));
  valid = true;
  await t.FM.queue.retry(create);
  assert.equal((await t.FM.replay.run()).sent, 3);
  eq(t.server.sent('POST /v1/').slice(-3).map((post) => post.path), ['/v1/projects/p1/notes', '/v1/notes/n1/star', '/v1/notes/n1/star']);
});

test('a change that names a record another scope\'s waiting change makes is sent after it', async () => {
  const t = engine();
  t.server.down = true;
  const queuedId = (answer) => answer.response.headers.get('x-fm-offline-queued');
  const create = queuedId(await t.json(...note('note-made-here', 'x')));                                         // scope project:p1 makes the note
  await t.json('POST', '/v1/links', { json: { from: 'contact-7', note: 'note-made-here' } });                    // scope link:contact-7 names it
  await t.json('POST', '/v1/links', { json: { from: 'contact-8', note: 'a-note-the-server-has' } });             // names nothing made here
  eq((await t.entries()).map((entry) => entry.after), [[], [create], []]);
  t.server.down = false;
  let valid = false;
  t.server.on('POST /v1/projects/p1/notes', async () => { await sleep(30); return valid ? { json: { ok: true } } : { status: 400, json: { ok: false, error: 'invalid_note' } }; });
  t.server.on('POST /v1/links', () => ({ json: { ok: true } }));
  const sentPaths = () => t.server.sent('POST /v1/').map((post) => (post.body && post.body.from ? `link:${post.body.from}` : post.path));

  // The create fails: the link that names its note waits with it; the other scope goes on.
  assert.equal((await t.FM.replay.run()).sent, 1);
  eq(sentPaths(), ['/v1/projects/p1/notes', 'link:contact-8']);
  eq((await t.entries()).map((entry) => entry.state), ['failed', 'waiting']);

  // A change made with a connection that names the waiting record is queued behind it, not sent ahead of it.
  const online = await t.json('POST', '/v1/links', { json: { from: 'contact-9', note: 'note-made-here' } });
  assert.ok(queuedId(online));
  assert.equal(t.server.sent('POST /v1/links').length, 1);
  // One that names nothing made here is sent at once.
  assert.equal(queuedId(await t.json('POST', '/v1/links', { json: { from: 'contact-10', note: 'a-note-the-server-has' } })), null);

  // Once the create is sent, what was held goes in the same run, after it.
  valid = true;
  await t.FM.queue.retry(create);
  assert.equal((await t.FM.replay.run()).sent, 3);
  eq(sentPaths().slice(-3), ['/v1/projects/p1/notes', 'link:contact-7', 'link:contact-9']);
  eq(await t.entries(), []);

  // A short id is never taken as naming a record: it could be part of any text.
  t.server.down = true;
  await t.json(...note('n1', 'x'));
  await t.json('POST', '/v1/links', { json: { from: 'contact-11', note: 'n1' } });
  eq((await t.entries()).map((entry) => entry.after), [[], []]);
});

test('discarding the change that makes a record lets what names it go (and the server answers for it)', async () => {
  const t = engine();
  t.server.down = true;
  const create = (await t.json(...note('note-made-here', 'x'))).response.headers.get('x-fm-offline-queued');
  await t.json('POST', '/v1/links', { json: { from: 'contact-7', note: 'note-made-here' } });
  t.server.down = false;
  t.server.on('POST /v1/links', () => ({ status: 404, json: { ok: false, error: 'note_not_found' } }));
  await t.FM.queue.discard(create);
  assert.equal((await t.FM.replay.run()).sent, 0);
  eq((await t.entries()).map((entry) => [entry.write, entry.state, entry.error.code]), [['links.add', 'failed', 'note_not_found']]);
});

test('replay.run does nothing without a signed-in person, and one run at a time', async () => {
  const t = engine({ identity: { user: '', org: '' } });
  eq({ ...(await t.FM.replay.run()) }, { sent: 0, blocked: null });
  const u = engine();
  u.server.down = true;
  await u.json(...note('n1', 'x'));
  u.server.down = false;
  u.server.on('POST /v1/projects/p1/notes', async () => { await sleep(20); return { json: { ok: true } }; });
  const [a, b] = await Promise.all([u.FM.replay.run(), u.FM.replay.run()]);
  assert.equal(a, b);
  assert.equal(u.server.sent('POST').length, 1);
});

// ---------------------------------------------------------------------------------------------------------------
// Conflicts
// ---------------------------------------------------------------------------------------------------------------

test('merge3: one side\'s change wins, objects merge by key, arrays of items with ids merge by id', () => {
  const { FM } = engine();
  const merge = (base, mine, theirs, options) => { const result = FM.merge3(base, mine, theirs, options); return { value: JSON.parse(JSON.stringify(result.value ?? null)), conflicts: result.conflicts.map((conflict) => conflict.path) }; };
  eq(merge('a', 'b', 'a'), { value: 'b', conflicts: [] });
  eq(merge('a', 'a', 'c'), { value: 'c', conflicts: [] });
  eq(merge('a', 'b', 'b'), { value: 'b', conflicts: [] });
  eq(merge('a', 'b', 'c', { path: 'title' }), { value: 'b', conflicts: ['title'] });
  // objects by key, including added and removed keys
  eq(merge({ street: '1 Oak', city: 'Troy', zip: '1' }, { street: '2 Oak', city: 'Troy' }, { street: '1 Oak', city: 'Albany', zip: '1', county: 'A' }, { path: 'address' }),
    { value: { street: '2 Oak', city: 'Albany', county: 'A' }, conflicts: [] });
  eq(merge({ a: { b: 1 } }, { a: { b: 2 } }, { a: { b: 3 } }, { path: 'doc' }).conflicts, ['doc.a.b']);
  // arrays by id: my addition, their addition, their edit, my removal
  const base = [{ id: 1, qty: 1 }, { id: 2, qty: 1 }, { id: 3, qty: 1 }];
  const mine = [{ id: 1, qty: 1 }, { id: 3, qty: 1 }, { id: 'new-mine', qty: 5 }];
  const theirs = [{ id: 1, qty: 9 }, { id: 2, qty: 1 }, { id: 'new-theirs', qty: 7 }, { id: 3, qty: 1 }];
  eq(merge(base, mine, theirs, { path: 'items' }), { value: [{ id: 1, qty: 9 }, { id: 'new-theirs', qty: 7 }, { id: 3, qty: 1 }, { id: 'new-mine', qty: 5 }], conflicts: [] });
  // the same item changed differently, and removed on one side but edited on the other
  eq(merge([{ id: 1, qty: 1 }], [{ id: 1, qty: 2 }], [{ id: 1, qty: 3 }], { path: 'items' }).conflicts, ['items.#1.qty']);
  eq(merge([{ id: 1, qty: 1 }], [], [{ id: 1, qty: 3 }], { path: 'items' }).conflicts, ['items.#1']);
  // only my reorder, only theirs, and both differently
  const abc = [{ id: 'a' }, { id: 'b' }, { id: 'c' }];
  const ids = (list) => list.map((item) => item.id).join('');
  assert.equal(ids(merge(abc, [abc[2], abc[0], abc[1]], abc).value), 'cab');
  assert.equal(ids(merge(abc, abc, [abc[1], abc[0], abc[2]]).value), 'bac');
  eq(merge(abc, [abc[2], abc[0], abc[1]], [abc[1], abc[0], abc[2]], { path: 'rows' }).conflicts, ['rows.#order']);
  // lists without ids and mixed types are a conflict when both changed
  eq(merge(['a'], ['a', 'b'], ['a', 'c'], { path: 'tags' }).conflicts, ['tags']);
  // choices settle conflicts
  eq(merge('a', 'b', 'c', { path: 'title', choose: () => 'theirs' }), { value: 'c', conflicts: [] });
  eq(merge('a', 'b', 'c', { path: 'title', choose: () => 'mine' }), { value: 'b', conflicts: [] });
});

test('a patch merges three ways on replay and is sent with expected_revision', async () => {
  const t = engine();
  let project = { id: 'p1', revision: 4, title: 'Oak St', address: { street: '1 Oak', city: 'Troy' }, notes: 'old' };
  t.server.on('GET /v1/projects/p1', () => ({ json: { project } }));
  t.server.on('PATCH /v1/projects/p1', (request) => { const { expected_revision: expected, ...change } = request.body; if (expected !== project.revision) return { status: 409, json: { ok: false, error: 'revision_conflict' } }; project = { ...project, ...change, revision: project.revision + 1 }; return { json: { ok: true, project } }; });
  await t.json('GET', '/v1/projects/p1');
  t.server.down = true;
  const queued = await t.json('PATCH', '/v1/projects/p1', { json: { title: 'Oak Street', address: { street: '1 Oak', city: 'Albany' } } });
  assert.equal(queued.data.project.title, 'Oak Street');
  const [entry] = await t.entries();
  eq([entry.kind, entry.base.revision, entry.base.doc.title], ['patch', 4, 'Oak St']);
  assert.equal((await t.json('GET', '/v1/projects/p1')).data.project.title, 'Oak Street', 'shown while it waits');
  // Someone else changed the street and the notes on the server.
  project = { ...project, revision: 5, address: { street: '9 Elm', city: 'Troy' }, notes: 'new' };
  t.server.down = false; t.server.log.length = 0;
  assert.equal((await t.FM.replay.run()).sent, 1);
  const [patch] = t.server.sent('PATCH /v1/projects/p1');
  eq(patch.body, { title: 'Oak Street', address: { street: '9 Elm', city: 'Albany' }, expected_revision: 5 });
  assert.notEqual(patch.headers['idempotency-key'], entry.id, 'a merged body is new to the server: its own key');
  assert.match(patch.headers['idempotency-key'], /^fmo1-/);
  eq(project.address, { street: '9 Elm', city: 'Albany' });
  assert.equal(project.notes, 'new', 'their change to a field I did not touch is kept');
  assert.equal(t.of('synced')[0].response.project.revision, 6);
});

test('a 409 on a patch repeats the merge; a change the server already has is not sent again', async () => {
  const t = engine();
  let project = { id: 'p1', revision: 1, title: 'A', phone: '1' };
  let races = 2;
  t.server.on('GET /v1/projects/p1', () => ({ json: { project } }));
  t.server.on('PATCH /v1/projects/p1', (request) => {
    if (races > 0) { races--; project = { ...project, revision: project.revision + 1, phone: String(project.revision + 1) }; return { status: 409, json: { ok: false, error: 'revision_conflict' } }; }
    const { expected_revision: expected, ...change } = request.body;
    if (expected !== project.revision) return { status: 409, json: { ok: false, error: 'revision_conflict' } };
    project = { ...project, ...change, revision: project.revision + 1 };
    return { json: { ok: true, project } };
  });
  await t.json('GET', '/v1/projects/p1');
  t.server.down = true;
  await t.json('PATCH', '/v1/projects/p1', { json: { title: 'B' } });
  t.server.down = false;
  assert.equal((await t.FM.replay.run()).sent, 1);
  const patches = t.server.sent('PATCH /v1/projects/p1');
  eq(patches.map((patch) => patch.body.expected_revision), [1, 2, 3]);
  assert.equal(new Set(patches.map((patch) => patch.headers['idempotency-key'])).size, 3, 'each different body has its own key');
  eq([project.title, project.phone], ['B', '3']);

  // The first send reached the server but its answer was lost: on replay nothing is left to change.
  const u = engine();
  let doc = { id: 'p1', revision: 1, title: 'A' };
  u.server.on('GET /v1/projects/p1', () => ({ json: { project: doc } }));
  await u.json('GET', '/v1/projects/p1');
  u.server.on('PATCH /v1/projects/p1', (request) => { doc = { ...doc, title: request.body.title, revision: 2 }; return 'drop'; });
  await u.json('PATCH', '/v1/projects/p1', { json: { title: 'B' } });
  assert.equal((await u.entries()).length, 1, 'no answer: queued');
  u.server.log.length = 0;
  assert.equal((await u.FM.replay.run()).sent, 1);
  assert.equal(u.server.sent('PATCH').length, 0);
  assert.equal(u.of('synced')[0].response, null);
});

test('both sides changed the same field differently: the entry waits in conflict until the person chooses per field', async () => {
  const t = engine();
  let project = { id: 'p1', revision: 1, title: 'A', phone: '1', color: 'red' };
  t.server.on('GET /v1/projects/p1', () => ({ json: { project } }));
  t.server.on('PATCH /v1/projects/p1', (request) => { const { expected_revision: expected, ...change } = request.body; project = { ...project, ...change, revision: project.revision + 1 }; return { json: { ok: true, project, expected } }; });
  await t.json('GET', '/v1/projects/p1');
  t.server.down = true;
  const id = (await t.json('PATCH', '/v1/projects/p1', { json: { title: 'Mine', phone: '2', color: 'blue' } })).response.headers.get('x-fm-offline-queued');
  await t.json('POST', '/v1/notes/n1/star', { json: { project_id: 'p1' } });
  project = { ...project, revision: 2, title: 'Theirs', phone: '3' };
  t.server.down = false;
  t.server.on('POST /v1/notes/n1/star', () => ({ json: { ok: true } }));
  assert.equal((await t.FM.replay.run()).sent, 1, 'a conflict does not hold the rest of its scope');
  const [entry] = await t.entries();
  assert.equal(entry.state, 'conflict');
  eq(entry.conflict.fields.map((field) => ({ ...field })), [{ path: 'title', base: 'A', mine: 'Mine', theirs: 'Theirs' }, { path: 'phone', base: '1', mine: '2', theirs: '3' }]);
  eq(t.of('conflict').map((detail) => [detail.id, detail.fields.length]), [[id, 2]]);
  assert.equal((await t.FM.state.queue(ME)).conflicts, 1);
  assert.equal(t.server.sent('PATCH').length, 0, 'nothing was sent');
  await assert.rejects(t.FM.queue.resolve(id, { title: 'mine' }), /phone/);
  await t.FM.queue.resolve(id, { title: 'mine', phone: 'theirs' });
  assert.equal((await t.FM.replay.run()).sent, 1);
  const [patch] = t.server.sent('PATCH');
  eq(patch.body, { title: 'Mine', color: 'blue', expected_revision: 2 });
  eq([project.title, project.phone, project.color], ['Mine', '3', 'blue']);
  assert.equal((await t.entries()).length, 0);
});

test('a later offline edit starts from what the person saw, so two edits of one record do not conflict with each other', async () => {
  const t = engine();
  let project = { id: 'p1', revision: 1, title: 'A', phone: '1' };
  t.server.on('GET /v1/projects/p1', () => ({ json: { project } }));
  t.server.on('PATCH /v1/projects/p1', (request) => { const { expected_revision: expected, ...change } = request.body; if (expected !== project.revision) return { status: 409, json: { error: 'revision_conflict' } }; project = { ...project, ...change, revision: project.revision + 1 }; return { json: { ok: true, project } }; });
  await t.json('GET', '/v1/projects/p1');
  t.server.down = true;
  await t.json('PATCH', '/v1/projects/p1', { json: { title: 'B' } });
  await t.json('PATCH', '/v1/projects/p1', { json: { title: 'C', phone: '2' } });
  const [, second] = await t.entries();
  assert.equal(second.base.doc.title, 'B', 'the second edit\'s base includes the first');
  t.server.down = false;
  assert.equal((await t.FM.replay.run()).sent, 2);
  eq([project.title, project.phone, project.revision], ['C', '2', 3]);
});

// ---------------------------------------------------------------------------------------------------------------
// Files
// ---------------------------------------------------------------------------------------------------------------

function photoForm(id, text = 'photo-bytes') {
  const form = new FormData();
  form.append('id', id);
  form.append('project_id', 'p1');
  form.append('file', new File([text], 'roof.jpg', { type: 'image/jpeg' }));
  return form;
}

test('a queued upload keeps its file, answers that media id\'s file URLs from it, and deletes it after upload', async () => {
  const t = engine();
  t.server.down = true;
  const queued = await t.json('POST', '/v1/platform/organizations/org_1/media', { body: photoForm('media_1') });
  const id = queued.response.headers.get('x-fm-offline-queued');
  eq(queued.data, { ok: true, media: { id: 'media_1', waiting: true } });
  const blobs = await t.FM.db.list('blobs');
  eq(blobs.map((row) => [row.k[0], row.name, row.type, row.size]), [[id, 'roof.jpg', 'image/jpeg', 11]]);
  const [entry] = await t.entries();
  eq(entry.media.map((item) => ({ ...item })), [{ id: 'media_1', blob: 0 }]);
  assert.equal(entry.headers['content-type'], undefined, 'the multipart boundary is made again when it is sent');
  // The app's ordinary thumbnail and file URLs work while it waits.
  for (const path of ['/v1/platform/organizations/org_1/media/media_1/file?variant=thumb_320', '/v1/platform/organizations/org_1/media/media_1/file']) {
    const file = await t.request('GET', path);
    eq([file.status, file.headers.get('content-type'), file.headers.get('x-fm-offline'), await file.text()], [200, 'image/jpeg', 'queued', 'photo-bytes']);
  }
  const part = await t.request('GET', '/v1/platform/organizations/org_1/media/media_1/file', { headers: { Range: 'bytes=0-4' } });
  eq([part.status, part.headers.get('content-range'), await part.text()], [206, 'bytes 0-4/11', 'photo']);
  // Upload.
  t.server.down = false;
  t.server.on('POST /v1/platform/organizations/org_1/media', () => ({ status: 201, json: { ok: true, media: { id: 'media_1' } } }));
  assert.equal((await t.FM.replay.run()).sent, 1);
  const [upload] = t.server.sent('POST /v1/platform/organizations/org_1/media');
  assert.match(upload.headers['content-type'], /^multipart\/form-data; boundary=/);
  eq(upload.body, { id: 'media_1', project_id: 'p1', file: { name: 'roof.jpg', type: 'image/jpeg', text: 'photo-bytes' } });
  assert.equal(upload.headers['idempotency-key'], id);
  assert.equal((await t.FM.db.list('blobs')).length, 0, 'the original left the device');
  assert.equal((await t.entries()).length, 0);
});

test('too little free space refuses a queued file with offline_storage_full', async () => {
  const t = engine();
  t.server.down = true;
  t.space.quota = 100 * 1024 * 1024; t.space.usage = 95 * 1024 * 1024;       // 5 MB free, the reserve is 10 MB
  const refused = await t.json('POST', '/v1/platform/organizations/org_1/media', { body: photoForm('media_1') });
  assert.equal(refused.response.status, 507);
  eq(refused.data, { ok: false, error: 'offline_storage_full' });
  assert.equal((await t.entries()).length, 0);
  assert.equal((await t.FM.db.list('blobs')).length, 0);
  // A change without a file is small and still queued.
  assert.ok((await t.json(...note('n1', 'x'))).response.headers.get('x-fm-offline-queued'));
  t.space.usage = 0;
  assert.ok((await t.json('POST', '/v1/platform/organizations/org_1/media', { body: photoForm('media_2') })).response.headers.get('x-fm-offline-queued'));
});

test('a delegated upload waits for the host\'s answer and keeps its scope in order', async () => {
  const t = engine();
  t.server.down = true;
  const id = (await t.json('POST', '/v1/platform/organizations/org_1/media', { body: photoForm('media_1') })).response.headers.get('x-fm-offline-queued');
  await t.json('POST', '/v1/notes/n1/star', { json: { project_id: 'p1' } });
  t.server.down = false;
  t.server.on('POST /v1/notes/n1/star', () => ({ json: { ok: true } }));
  await t.FM.queue.delegate(id, { host: 'android' });
  assert.equal((await t.FM.replay.run()).sent, 0, 'the host is uploading: the scope waits');
  assert.equal((await t.FM.state.queue(ME)).pending, 2);
  assert.equal(await t.FM.replay.report(id, new Response(JSON.stringify({ ok: true, media: { id: 'media_1' } }), { status: 201, headers: { 'Content-Type': 'application/json' } })), 'done');
  assert.equal(t.of('synced')[0].response.media.id, 'media_1');
  assert.equal((await t.FM.replay.run()).sent, 1);
});

test('an entry something else will send (configure external) is never sent by replay, and its scope waits', async () => {
  const t = engine();
  t.server.down = true;
  const id = (await t.json('POST', '/v1/platform/organizations/org_1/media', { body: photoForm('media_1') })).response.headers.get('x-fm-offline-queued');
  await t.json('POST', '/v1/notes/n1/star', { json: { project_id: 'p1' } });
  await t.json('POST', '/v1/notes/n2/star', { json: { project_id: 'p2' } });
  t.server.down = false;
  t.server.on('POST /v1/notes/', () => ({ json: { ok: true } }));
  t.server.on('POST /v1/platform/organizations/org_1/media', () => ({ status: 201, json: { ok: true, media: { id: 'media_1' } } }));
  // The native app's uploader takes waiting uploads: what the hook is asked about is the public entry.
  const asked = [];
  t.FM.configure({ external: (entry) => { asked.push([entry.id, entry.kind, entry.state]); return entry.kind === 'upload'; } });
  assert.equal((await t.FM.replay.run()).sent, 1, 'only the other project\'s change is sent');
  eq(t.server.sent('POST').map((request) => request.path), ['/v1/notes/n2/star']);
  eq(asked.find((item) => item[0] === id), [id, 'upload', 'waiting']);
  eq((await t.entries()).map((entry) => [entry.kind, entry.state]), [['upload', 'waiting'], ['action', 'waiting']], 'the upload was not touched and the change behind it waits');
  // Left to the page after all (the host cannot take it): replay sends it and what waited behind it.
  t.FM.configure({ external: () => false });
  assert.equal((await t.FM.replay.run()).sent, 2);
  eq(t.server.sent('POST').map((request) => request.path), ['/v1/notes/n2/star', '/v1/platform/organizations/org_1/media', '/v1/notes/n1/star']);
});

// ---------------------------------------------------------------------------------------------------------------
// Identity, budgets, pins
// ---------------------------------------------------------------------------------------------------------------

test('sign-out removes a person\'s saved reads and keeps their queued changes', async () => {
  const t = engine();
  const other = { user: 'user_2', org: 'org_1' };
  t.server.on('GET /v1/projects/p1', () => ({ json: { project: { id: 'p1' } } }));
  await t.json('GET', '/v1/projects/p1');
  await t.json('GET', '/v1/projects/p1', {}, other);
  t.server.down = true;
  await t.json(...note('n1', 'x'));
  await t.FM.identity.set(ME);
  await t.FM.identity.signOut('user_1');
  eq((await t.FM.db.list('responses')).map((row) => row.k[0]), ['user_2']);
  assert.equal(await t.FM.identity.get(), null);
  assert.equal((await t.entries()).length, 1, 'the queue stays for when they sign in again');
  await assert.rejects(t.request('GET', '/v1/projects/p1'), /Failed to fetch/);
  // Signing out of every remembered account asks who has anything here.
  eq(await t.FM.identity.users(), ['user_2']);
  await t.FM.identity.signOut('user_2');
  eq(await t.FM.identity.users(), []);
});

test('saved reads keep to their budget, least recently used first; boot reads and pinned projects stay', async () => {
  const t = engine();
  const big = 'x'.repeat(400 * 1024);
  t.server.on('GET /v1/', (request) => ({ json: { path: request.path, big } }));
  t.server.on('GET /v1/projects/p9/notes', () => ({ json: { notes: [{ id: 'n1' }], big } }));
  await t.json('GET', '/v1/boot');                       // a contract names it as a boot read
  await t.FM.pins.pin(ME, 'p9');                         // /v1/projects/p9, its notes and /v1/notes/n1
  for (const name of ['a', 'b', 'c', 'd']) { t.clock.now += 1000; await t.json('GET', `/v1/list/${name}`); }
  t.clock.now += 4 * 3600000;
  t.server.down = true;
  await t.json('GET', '/v1/list/a');                     // used again: now the most recent
  await sleep(5);
  await t.FM.settings.set('readsBudgetMb', 2.4);                // eight reads of 0.4 MB are on the device
  await t.FM.reads.enforce();
  const kept = (await t.FM.db.list('responses')).map((row) => row.k[2]).sort();
  eq(kept, ['GET /v1/boot', 'GET /v1/list/a', 'GET /v1/notes/n1', 'GET /v1/projects/p9', 'GET /v1/projects/p9/notes']);
  eq((await t.FM.pins.list(ME)).map((pin) => [pin.project, pin.reads, pin.auto]), [['p9', 3, false]]);
  // Unpinned, its reads may be evicted like any other.
  await t.FM.pins.unpin(ME, 'p9');
  await t.FM.settings.set('readsBudgetMb', 1);
  await t.FM.reads.enforce();
  eq((await t.FM.db.list('responses')).map((row) => row.k[2]).sort(), ['GET /v1/boot', 'GET /v1/list/a']);
});

test('the ten most recently opened projects stay pinned automatically; a pin the person made is never dropped for them', async () => {
  const t = engine();
  t.server.on('GET /v1/', () => ({ json: { notes: [] } }));
  await t.FM.pins.pin(ME, 'chosen');
  for (let i = 1; i <= 12; i++) { t.clock.now += 1000; await t.FM.pins.pin(ME, `auto${i}`, { auto: true }); }
  const pinned = (await t.FM.pins.list(ME)).map((pin) => pin.project);
  assert.equal(pinned.length, 11);
  assert.ok(pinned.includes('chosen') && pinned.includes('auto12') && pinned.includes('auto3') && !pinned.includes('auto2') && !pinned.includes('auto1'));
  await t.FM.settings.set('autoPinRecent', false);
  assert.equal(await t.FM.pins.pin(ME, 'auto13', { auto: true }), null);
});

test('state and storage report what is on the device', async () => {
  const t = engine();
  t.server.on('GET /v1/projects/p1', () => ({ json: { project: { id: 'p1' } } }));
  await t.json('GET', '/v1/projects/p1');
  t.server.down = true;
  await t.json(...note('n1', 'x'));
  await t.json('POST', '/v1/platform/organizations/org_1/media', { body: photoForm('media_1') });
  const report = await t.FM.storage.report();
  assert.equal(report.reads, JSON.stringify({ project: { id: 'p1' } }).length);
  assert.equal(report.media, 0);
  assert.equal(report.queued, 11 + JSON.stringify({ id: 'n1', text: 'x' }).length);
  eq({ ...report.budgets }, { reads: 150 * 1024 * 1024, media: 300 * 1024 * 1024 });
  eq([report.quota, report.usage], [10 ** 12, 0]);
  const state = t.of('state').at(-1);
  eq([state.online, state.syncing, state.queue.pending, [...state.queue.records].sort().join()], [false, false, 2, 'media_1,n1']);
});

// ---------------------------------------------------------------------------------------------------------------
// Records made on the device: seeds, a create the server already has, and POST reads of a pinned project
// ---------------------------------------------------------------------------------------------------------------

/** TEST ONLY: a record that is created with a device-made id, then renamed. */
function addThingsContract(FM) {
  FM.contracts.add({
    id: 'things',
    reads: [{ id: 'things.search', match: 'POST /v1/things/search', when: (ctx) => !!ctx.body.project, key: (ctx) => ({ project: ctx.body.project }) }],
    prefetch: [(ctx) => [{ url: '/v1/things/search', body: { project: ctx.project, nonce: 'not-in-the-key' } }, { url: '/v1/things/search', body: { other: true } }, { url: '/v1/things/delete-all', body: {} }]],
    writes: [
      {
        id: 'things.create', match: 'POST /v1/things', kind: 'create', scope: (ctx) => `thing:${ctx.body.id}`, records: (ctx) => [ctx.body.id],
        label: (ctx) => ({ title: 'Thing', detail: ctx.body.name }),
        respond: (ctx) => ({ ok: true, thing: { id: ctx.body.id, name: ctx.body.name, revision: 0 } }),
        duplicate: (ctx, answer) => answer.status === 409 && answer.code === 'thing_exists',
        effects: (ctx) => [
          { match: 'GET /v1/things/:id', when: (m) => m.id === ctx.body.id, seed: () => ({ ok: true, thing: ctx.response.thing }) },
          { match: 'GET /v1/things', apply: (json) => ({ ...json, things: [...json.things, ctx.response.thing] }) }
        ]
      },
      {
        id: 'things.rename', match: 'POST /v1/things/:id/rename', kind: 'action', scope: (ctx) => `thing:${ctx.params.id}`, records: (ctx) => [ctx.params.id],
        label: () => ({ title: 'Rename' }),
        respond: async (ctx) => ({ ok: true, was: ((await ctx.saved(`/v1/things/${ctx.params.id}`)) || { thing: {} }).thing.name || null }),
        effects: (ctx) => [{ match: 'GET /v1/things/:id', when: (m) => m.id === ctx.params.id, apply: (json) => ({ ...json, thing: { ...json.thing, name: ctx.body.name } }) }]
      }
    ]
  });
}

test('a record made on the device answers its own reads from the queued create, also when the server says 404', async () => {
  const t = engine();
  addThingsContract(t.FM);
  t.server.down = true;
  await t.json('POST', '/v1/things', { json: { id: 't1', name: 'First' } });
  const made = await t.json('GET', '/v1/things/t1');
  assert.equal(made.response.status, 200);
  assert.equal(made.response.headers.get('x-fm-offline'), 'queued');
  eq(made.data, { ok: true, thing: { id: 't1', name: 'First', revision: 0 } });
  await assert.rejects(t.request('GET', '/v1/things/t2'), /Failed to fetch/, 'another record is not seeded');
  // A later change sees the seeded record (ctx.saved) and is applied on top of it.
  const renamed = await t.json('POST', '/v1/things/t1/rename', { json: { name: 'Second' } });
  eq(renamed.data, { ok: true, was: 'First' });
  assert.equal((await t.json('GET', '/v1/things/t1')).data.thing.name, 'Second');
  // Back online with the create still waiting: the server does not know the record yet.
  t.server.down = false;
  t.server.on('GET /v1/things/t1', () => ({ status: 404, json: { ok: false, error: 'not_found' } }));
  const early = await t.json('GET', '/v1/things/t1');
  assert.equal(early.response.status, 200);
  assert.equal(early.data.thing.name, 'Second');
  assert.equal((await t.FM.db.list('responses')).length, 0, 'a seeded answer is never stored as a saved read');
  // Once it is sent, reads are the server's again.
  t.server.on('POST /v1/things', () => ({ json: { ok: true } }));
  t.server.on('GET /v1/things/t1', () => ({ json: { ok: true, thing: { id: 't1', name: 'Second', revision: 2 } } }));
  assert.equal((await t.FM.replay.run()).sent, 2);
  const real = await t.json('GET', '/v1/things/t1');
  assert.equal(real.response.headers.get('x-fm-offline'), null);
  assert.equal(real.data.thing.revision, 2);
});

test('a create the server already has is done: the refusal a contract names as a duplicate removes the entry', async () => {
  const t = engine();
  addThingsContract(t.FM);
  t.server.down = true;
  await t.json('POST', '/v1/things', { json: { id: 't1', name: 'First' } });
  await t.json('POST', '/v1/things/t1/rename', { json: { name: 'Second' } });
  await t.json('POST', '/v1/things', { json: { id: 't9', name: 'Other' } });
  t.server.down = false;
  // The first try reached the server and its answer was lost; the repeat is refused as already there.
  t.server.on('POST /v1/things', (request) => (request.body.id === 't1' ? { status: 409, json: { ok: false, error: 'thing_exists' } } : { status: 409, json: { ok: false, error: 'thing_locked' } }));
  t.server.on('POST /v1/things/t1/rename', () => ({ json: { ok: true } }));
  assert.equal((await t.FM.replay.run()).sent, 2, 'the duplicate create counts as sent, and the rename behind it goes on');
  const synced = t.of('synced').find((entry) => entry.write === 'things.create');
  eq([synced.status, synced.response], [200, null]);
  eq((await t.entries()).map((entry) => [entry.write, entry.state, entry.error.code]), [['things.create', 'failed', 'thing_locked']], 'any other 409 still fails');
});

test('a pinned project also downloads the POST reads its contracts name, and only declared reads are ever sent', async () => {
  const t = engine();
  addThingsContract(t.FM);
  t.server.on('GET /v1/', () => ({ json: { notes: [] } }));
  t.server.on('POST /v1/things/search', (request) => ({ json: { found: [request.body.project] } }));
  await t.FM.pins.pin(ME, 'p7');
  const posts = t.server.sent('POST /v1/things');
  eq(posts.map((post) => [post.path, post.body.project, post.headers['x-platform-csrf'], post.headers['x-fm-offline-replay']]), [['/v1/things/search', 'p7', 'csrf-1', '1']]);
  assert.equal((await t.FM.pins.list(ME))[0].reads, 3, 'the project, its notes list and the search');
  t.server.down = true;
  const saved = await t.json('POST', '/v1/things/search', { json: { project: 'p7' } });
  assert.equal(saved.response.headers.get('x-fm-offline'), 'saved');
  eq(saved.data, { found: ['p7'] });
});

/** TEST ONLY: an action that carries its own key in the body, as a publication action does. */
function addActionContract(FM, safeToRepeat) {
  FM.contracts.add({
    id: 'actions',
    writes: [{
      id: 'act', match: 'POST /v1/actions/invoke', kind: 'action', scope: (ctx) => `thing:${ctx.body.target}`, records: (ctx) => [ctx.body.target],
      label: () => ({ title: 'Action' }),
      respond: () => ({ receipt: { status: 'succeeded' } }),
      ...(safeToRepeat ? { resend: (ctx, answer) => (answer.status === 409 && answer.code === 'action_outcome_uncertain' ? { ...ctx.body, idempotencyKey: ctx.body.idempotencyKey + '-again' } : null) } : {})
    }]
  });
}

test('an action whose own key the server will not take twice is sent again once, in the form its contract gives', async () => {
  const t = engine();
  addActionContract(t.FM, true);
  t.server.down = true;
  await t.json('POST', '/v1/actions/invoke', { json: { action: 'set', target: 't1', input: { done: true }, idempotencyKey: 'k1' } });
  t.server.down = false;
  // The server started the action under k1 once and does not know how it ended: that key is refused for good.
  t.server.on('POST /v1/actions/invoke', (request) => (request.body.idempotencyKey === 'k1' ? { status: 409, json: { error: 'action_outcome_uncertain' } } : { json: { receipt: { status: 'succeeded' } } }));
  assert.equal((await t.FM.replay.run()).sent, 1);
  const posts = t.server.sent('POST /v1/actions/invoke');
  eq(posts.map((post) => post.body.idempotencyKey), ['k1', 'k1-again']);
  assert.notEqual(posts[0].headers['idempotency-key'], posts[1].headers['idempotency-key'], 'a new body goes under a new key');
  eq(await t.entries(), []);
  // Refused again in its new form: it waits for the person, it is not sent in a loop.
  t.server.down = true;
  await t.json('POST', '/v1/actions/invoke', { json: { action: 'set', target: 't2', input: {}, idempotencyKey: 'k2' } });
  t.server.down = false;
  t.server.on('POST /v1/actions/invoke', () => ({ status: 409, json: { error: 'action_outcome_uncertain' } }));
  await t.FM.replay.run();
  eq((await t.entries()).map((entry) => [entry.state, entry.error.code]), [['failed', 'action_outcome_uncertain']]);
  assert.equal(t.server.sent('POST /v1/actions/invoke').length, 4);
});

test('without a contract that says an action may be repeated, an uncertain outcome waits for the person', async () => {
  const t = engine();
  addActionContract(t.FM, false);
  t.server.down = true;
  await t.json('POST', '/v1/actions/invoke', { json: { action: 'charge', target: 't1', input: {}, idempotencyKey: 'k1' } });
  t.server.down = false;
  t.server.on('POST /v1/actions/invoke', () => ({ status: 409, json: { error: 'action_outcome_uncertain' } }));
  await t.FM.replay.run();
  eq((await t.entries()).map((entry) => [entry.state, entry.error.status, entry.error.code]), [['failed', 409, 'action_outcome_uncertain']]);
  assert.equal(t.server.sent('POST /v1/actions/invoke').length, 1, 'sent once, with the key it was made with');
  assert.equal(t.server.sent('POST /v1/actions/invoke')[0].body.idempotencyKey, 'k1');
});

test('a patch\'s effects can merge over a newer answer with the record as it was (ctx.base), and find and queued see the device', async () => {
  const t = engine();
  t.FM.contracts.add({
    id: 'lists',
    writes: [{
      id: 'list.patch', match: 'PATCH /v1/lists/:id', kind: 'patch', scope: (ctx) => `list:${ctx.params.id}`, records: (ctx) => [ctx.params.id],
      label: () => ({ title: 'List' }),
      respond: async (ctx) => ({ ok: true, found: (await ctx.find('GET /v1/lists/:id')).map((read) => read.params.id), earlier: (await ctx.queued(ctx.params.id)).map((entry) => entry.write) }),
      effects: (ctx) => [{ match: 'GET /v1/lists/:id', when: (m) => m.id === ctx.params.id, apply: (json) => ({ ...json, list: { ...json.list, items: t.FM.merge3(ctx.base.items, ctx.body.items, json.list.items).value } }) }],
      conflict: { current: (ctx) => `/v1/lists/${ctx.params.id}`, pick: (json, ctx) => ({ doc: json.list, revision: json.list.revision, asked: ctx.params.id }), send: (ctx, merged, revision) => ({ ...merged, expected_revision: revision }) }
    }]
  });
  let items = [{ id: 'a', n: 1 }, { id: 'b', n: 1 }];
  t.server.on('GET /v1/lists/l1', () => ({ json: { list: { id: 'l1', revision: 1, items } } }));
  await t.json('GET', '/v1/lists/l1');
  t.server.down = true;
  const first = await t.json('PATCH', '/v1/lists/l1', { json: { items: [{ id: 'a', n: 2 }, { id: 'b', n: 1 }] } });
  eq(first.data, { ok: true, found: ['l1'], earlier: [] });
  eq((await t.json('PATCH', '/v1/lists/l1', { json: { items: [{ id: 'a', n: 3 }, { id: 'b', n: 1 }] } })).data.earlier, ['list.patch'], 'the second change sees the first');
  await t.FM.queue.discard((await t.entries())[1].id);
  // The server gained an item meanwhile: the waiting change is shown over it, not instead of it.
  t.server.down = false;
  items = [{ id: 'a', n: 1 }, { id: 'b', n: 1 }, { id: 'c', n: 9 }];
  eq((await t.json('GET', '/v1/lists/l1')).data.list.items, [{ id: 'a', n: 2 }, { id: 'b', n: 1 }, { id: 'c', n: 9 }]);
});
