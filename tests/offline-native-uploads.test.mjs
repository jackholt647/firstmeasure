// The native hand-off (public/libraries/platform-offline/native-uploads.js; docs/architecture/offline.md, "Photos and
// files"; the bridge contract is native/firstmate/README.md, "Offline"): the real module, engine and media contract,
// with a Map in place of IndexedDB, a scripted server, and a stand-in for the app's host that keeps files and jobs
// the way the README says the hosts do. A "page" is one load of the portal; the device's store and the host outlive it.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { webcrypto } from 'node:crypto';
import vm from 'node:vm';

const read = (file) => readFileSync(new URL('../public/libraries/platform-offline/' + file, import.meta.url), 'utf8');
const ORIGIN = 'https://app.test';
const ME = { user: 'user_1', org: 'org_1' };
const ORG = '/v1/platform/organizations/org_1';
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const eq = (actual, expected, message) => assert.deepStrictEqual(JSON.parse(JSON.stringify(actual ?? null)), JSON.parse(JSON.stringify(expected ?? null)), message);
const bridgeError = (code) => Object.assign(new Error(code), { code });

/** TEST ONLY: a project's own create, as another app's contract queues it in the project's scope. */
const PROJECT_CONTRACT = `FMOffline.contracts.add({ id: 'projects-test', writes: [{ id: 'project.create', match: 'POST /v1/test/projects', kind: 'create', scope: (ctx) => 'project:' + ctx.body.id, records: (ctx) => [ctx.body.id], respond: (ctx) => ({ ok: true, project: { id: ctx.body.id } }) }] });`;

/** The app's host as the README describes it: handed-over files, jobs, answers kept until acknowledged. */
function fakeHost() {
  const host = { puts: new Map(), jobs: new Map(), captures: new Map(), calls: [], capabilities: ['offlineUploads', 'photoLibrarySave'], failPut: null, failEnqueue: null };
  const view = (job) => ({ id: job.id, state: job.state, status: job.status, body: job.body, bodyTruncated: false, error: job.error, attempts: job.attempts, size: job.size, createdAt: 1, updatedAt: 2 });
  host.offlineUploads = {
    available: () => host.capabilities.includes('offlineUploads'),
    async put(id, offset, data, done) { host.calls.push(['put', id, offset, done]); const put = host.puts.get(id); return { size: put ? put.size : 0, done: !!(put && put.done), accepted: true }; },
    async putBlob(id, blob) {
      host.calls.push(['putBlob', id, blob.size]);
      if (host.failPut) throw bridgeError(host.failPut);
      host.puts.set(id, { size: blob.size, text: await blob.text(), done: true });
      return { size: blob.size, done: true, accepted: true };
    },
    async enqueue(job) {
      host.calls.push(['enqueue', job.id, job.source ? Object.keys(job.source)[0] : 'job']);
      if (host.failEnqueue) throw bridgeError(host.failEnqueue);
      if (!job.headers || !job.headers['Idempotency-Key']) throw bridgeError('idempotency_key_required');
      const existing = host.jobs.get(job.id);
      if (existing) {
        // The same id again changes nothing, except that a failed job (or one waiting for a sign-in) is queued again with this request.
        if (existing.state !== 'failed' && existing.state !== 'needs_sign_in') return { id: job.id, state: existing.state, created: false, requeued: false };
        Object.assign(existing, { state: 'queued', status: null, body: null, error: null, request: Object.assign({}, existing.request, { url: job.url, fields: job.fields, headers: job.headers, csrfCookie: job.csrfCookie }) });
        return { id: job.id, state: 'queued', created: false, requeued: true };
      }
      let file = null;
      if (job.source && job.source.put) {
        file = host.puts.get(job.source.put);
        if (!file) throw bridgeError('unknown_source');
        if (job.size != null && job.size !== file.size) throw bridgeError('size_mismatch');
        host.puts.delete(job.source.put);
      } else if (job.source && job.source.cameraToken) {
        file = host.captures.get(job.source.cameraToken);
        if (!file) throw bridgeError('unknown_source');
        host.captures.delete(job.source.cameraToken);
      } else throw bridgeError('unknown_source');
      host.jobs.set(job.id, { id: job.id, state: 'queued', status: null, body: null, error: null, attempts: 0, size: file.size, file, request: job });
      return { id: job.id, state: 'queued', created: true, requeued: false, savedToPhotos: job.saveToPhotos === true, photosError: null };
    },
    async status(ids) { host.calls.push(['status', ids ? ids.length : 'all']); return (ids ? [...ids].map((id) => host.jobs.get(id)).filter(Boolean) : [...host.jobs.values()]).map(view); },
    async ack(ids) { host.calls.push(['ack', ...ids]); const acked = [...ids].filter((id) => host.jobs.get(id) && host.jobs.get(id).state === 'done'); acked.forEach((id) => host.jobs.delete(id)); return { acked }; },
    async cancel(id) { host.calls.push(['cancel', id]); const cancelled = host.jobs.delete(id) | host.puts.delete(id); return { cancelled: !!cancelled }; }
  };
  /** What the background uploader recorded for a job. */
  host.answer = (id, state, status = null, body = null, error = null) => Object.assign(host.jobs.get(id), { state, status, body: body == null ? null : JSON.stringify(body), error, attempts: host.jobs.get(id).attempts + 1 });
  host.did = (from = 0) => host.calls.slice(from).filter((call) => call[0] !== 'status').map((call) => call.slice(0, 3));
  return host;
}

function fakeServer() {
  const routes = [];
  const server = {
    down: false, log: [],
    on(pattern, handler) { routes.unshift({ pattern, handler }); return server; },
    async fetch(input, init) {
      const request = input instanceof Request ? input : new Request(input, init);
      const url = new URL(request.url);
      const entry = { method: request.method, path: url.pathname, headers: Object.fromEntries(request.headers) };
      if (server.down) throw new TypeError('Failed to fetch');
      server.log.push(entry);
      const route = routes.find((item) => `${entry.method} ${entry.path}`.startsWith(item.pattern));
      const answer = route ? await route.handler(entry) : { status: 404, json: { ok: false, error: 'not_found' } };
      return new Response(JSON.stringify(answer.json), { status: answer.status || 200, headers: { 'Content-Type': 'application/json' } });
    }
  };
  return server;
}

/** One device: its store, its host and its server outlive the pages opened on it. */
function device() {
  const d = { host: fakeHost(), server: fakeServer(), rows: null, settings: { saveToCameraRoll: false } };
  /** Loads the portal: the engine, the contracts, then native-uploads.js as platform-offline.js loads it. */
  d.open = async (identity = ME) => {
    const timers = [];
    const handlers = new Map();
    const navigator = { onLine: true };
    const context = vm.createContext({ URL, URLSearchParams, Request, Response, Headers, Blob, File, FormData, AbortController, TextEncoder, TextDecoder, crypto: webcrypto, console, navigator, location: { origin: ORIGIN },
      setTimeout: (work, ms) => { timers.push({ work, ms }); return timers.length; }, clearTimeout: () => {} });
    context.self = context; context.window = context;
    context.document = { visibilityState: 'visible', addEventListener() {} };
    context.addEventListener = () => {};
    context.__APP = { userId: identity.user, userOrgId: identity.org };
    vm.runInContext(read('offline-core.js'), context, { filename: 'offline-core.js' });
    const FM = context.FMOffline;
    FM.configure({ fetch: d.server.fetch, identity: async () => identity, csrf: async () => 'csrf-1', estimate: async () => ({ quota: 1e12, usage: 0 }), limits: { backoffMs: [20, 20, 20, 20], backoffMaxMs: 20 } });
    for (const file of ['contracts/core.js', 'contracts/media.js']) vm.runInContext(read(file), context, { filename: file });
    vm.runInContext(PROJECT_CONTRACT, context);
    // What the device kept from the page before this one.
    for (const [store, rows] of Object.entries(d.rows || {})) for (const row of rows) await FM.db.put(store, row);
    const events = [];
    for (const type of ['queued', 'synced', 'failed', 'discarded']) FM.events.on(type, (detail) => { events.push({ type, detail }); for (const handler of handlers.get(type) || []) handler(detail); });
    const calls = [];
    context.PhoneFeatures = { ready: Promise.resolve({ capabilities: d.host.capabilities }), supports: (name) => d.host.capabilities.includes(name), offlineUploads: d.host.offlineUploads };
    context.PlatformOffline = { csrfCookie: 'fm_platform_session_csrf', settings: { get: (name) => d.settings[name] }, on: (type, handler) => { if (!handlers.has(type)) handlers.set(type, []); handlers.get(type).push(handler); }, syncNow: () => { calls.push('syncNow'); return FM.replay.run({ force: true }); } };
    const page = { FM, events, calls, timers, identity, of: (type) => events.filter((event) => event.type === type).map((event) => event.detail) };
    page.load = async () => { vm.runInContext(read('native-uploads.js'), context, { filename: 'native-uploads.js' }); page.native = context.PlatformOfflineNativeUploads; if (page.native) await page.native.pump(); return page; };
    /** The worker's part: a photo taken without a connection is queued (the upload, then the project's list save). */
    page.takePhoto = async (id, options = {}) => {
      const form = new FormData();
      form.append('file', new File([options.bytes || 'photo ' + id], options.name || id + '.jpg', { type: options.type || 'image/jpeg' }));
      for (const [name, value] of Object.entries({ id, owner_type: 'project', owner_id: options.project || 'p1', slot: 'photos', collection: 'projects', scope: 'projects', replace_slot: 'false', thumbnails: 'true', metadata: JSON.stringify({ taken_at: '2026-11-10T16:20:00.000Z' }) })) form.append(name, value);
      const was = d.server.down; d.server.down = true;
      const upload = await FM.api.plan(new Request(ORIGIN + `${ORG}/media`, { method: 'POST', body: form }), identity, {})();
      let save = null;
      if (options.list !== false) save = await FM.api.plan(new Request(ORIGIN + `${ORG}/projects/${options.project || 'p1'}/photos`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ photos: [{ id, media_id: id }], remove: [] }) }), identity, {})();
      d.server.down = was;
      return { entry: upload.headers.get('x-fm-offline-queued'), save: save && save.headers.get('x-fm-offline-queued') };
    };
    page.entries = async () => { FM.queue.invalidate(); return (await FM.queue.all()).map((entry) => ({ id: entry.id, write: entry.write, state: entry.state, user: entry.user, key: entry.key, step: entry.delegated && entry.delegated.step, error: entry.error && entry.error.status })); };
    page.pump = () => page.native.pump();
    /** The page is closed: only what the device stores stays. */
    page.close = async () => { d.rows = {}; for (const store of ['outbox', 'blobs', 'meta']) d.rows[store] = await FM.db.list(store); };
    return page;
  };
  return d;
}

const uploaded = (id) => ({ ok: true, media: { id, from: 'server' } });

// ---------------------------------------------------------------------------------------------------------------

test('a waiting upload is marked delegated, its file handed to the host and queued there; the answer is reported and acknowledged', async () => {
  const d = device();
  const page = await (await d.open()).load();
  assert.ok(page.native, 'the module starts where the bridge reports offlineUploads');
  const taken = await page.takePhoto('media_1');
  await page.pump();
  eq(d.host.did(), [['putBlob', taken.entry, 13], ['enqueue', taken.entry, 'put']]);
  eq((await page.entries()).map((entry) => [entry.write, entry.state, entry.step]), [['media.upload', 'delegated', 'queued'], ['photos.save', 'waiting', undefined]]);
  // The job is the queued request: the entry's URL, text fields, headers and key, and the name of the CSRF cookie.
  const job = d.host.jobs.get(taken.entry);
  eq([job.file.text, job.request.url, job.request.fileField, job.request.fileName, job.request.contentType, job.request.size, job.request.csrfCookie, job.request.saveToPhotos], ['photo media_1', `${ORG}/media`, 'file', 'media_1.jpg', 'image/jpeg', 13, 'fm_platform_session_csrf', false]);
  eq(job.request.headers, { 'Idempotency-Key': taken.entry, 'X-FM-Offline-User': 'user_1', 'X-FM-Offline-Org': 'org_1', 'X-FM-Offline-Replay': '1', Accept: 'application/json' });
  eq([job.request.fields.id, job.request.fields.owner_type, job.request.fields.owner_id, job.request.fields.slot, JSON.parse(job.request.fields.metadata).taken_at], ['media_1', 'project', 'p1', 'photos', '2026-11-10T16:20:00.000Z']);
  assert.ok(Object.values(job.request.fields).every((value) => typeof value === 'string'));

  // The page never sends what the host holds, and the list save behind it waits its turn.
  d.server.on(`POST ${ORG}`, () => ({ json: { ok: true } }));
  d.server.on(`GET ${ORG}/projects/p1`, () => ({ json: { ok: true, document: { id: 'p1', revision: 1, data: { photos: [] } } } }));
  eq(await page.FM.replay.run({ force: true }), { sent: 0, blocked: null });
  eq(d.server.log, []);
  // Polling while the host uploads changes nothing.
  let mark = d.host.calls.length;
  await page.pump();
  eq(d.host.did(mark), []);
  assert.ok(page.timers.some((timer) => timer.ms === 5000), 'it polls while the host holds an entry');

  // 2xx: the answer is recorded in the queue, then acknowledged; the list save follows from the page.
  d.host.answer(taken.entry, 'done', 201, uploaded('media_1'));
  mark = d.host.calls.length;
  await page.pump();
  eq(d.host.did(mark), [['ack', taken.entry]]);
  eq(page.of('synced').map((detail) => [detail.id, detail.write, detail.status, detail.response.media.from]), [[taken.entry, 'media.upload', 201, 'server']]);
  eq(d.host.jobs.size, 0);
  eq((await page.entries()).map((entry) => [entry.write, entry.state]), [['photos.save', 'waiting']]);
  eq((await page.FM.replay.run({ force: true })).sent, 1);
  eq(d.server.log.filter((request) => request.method === 'POST').map((request) => request.path), [`${ORG}/projects/p1/photos`], 'the upload itself was never sent from the page');
});

test('the answer table: a refusal waits for the person, a sign-in pauses the queue, server trouble and a redirect are tried again, a lost file is handed over again', async () => {
  const d = device();
  const page = await (await d.open()).load();
  const photo = async (id) => { const taken = await page.takePhoto(id, { list: false }); await page.pump(); return taken.entry; };
  const stateOf = async (id) => (await page.entries()).find((entry) => entry.id === id);

  // Any other 4xx: failed, shown to the person. The host keeps the job and its file.
  const refused = await photo('media_refused');
  d.host.answer(refused, 'failed', 422, { ok: false, error: 'unsupported_media', message: 'Not a picture' });
  await page.pump();
  eq([(await stateOf(refused)).state, (await stateOf(refused)).error, page.of('failed').map((detail) => [detail.id, detail.error.code, detail.error.message])], ['failed', 422, [[refused, 'unsupported_media', 'Not a picture']]]);
  assert.equal(d.host.jobs.get(refused).state, 'failed');
  let mark = d.host.calls.length;
  await page.pump();
  eq(d.host.did(mark), [], 'a failed change is left alone until the person decides');
  // Retry: the same job again, with the entry's new key (the server keeps a refusal under the old one).
  await page.FM.queue.retry(refused);
  const retried = await stateOf(refused);
  assert.notEqual(retried.key, refused);
  mark = d.host.calls.length;
  await page.pump();
  eq(d.host.did(mark), [['enqueue', refused, 'job']], 'the host has the file: nothing is handed over twice');
  eq([d.host.jobs.get(refused).state, d.host.jobs.get(refused).request.headers['Idempotency-Key'], (await stateOf(refused)).state], ['queued', retried.key, 'delegated']);
  // Discard: the job and its file leave the host too.
  mark = d.host.calls.length;
  await page.FM.queue.discard(refused);
  await page.pump();
  eq(d.host.did(mark), [['cancel', refused]]);
  eq([d.host.jobs.has(refused), await stateOf(refused)], [false, undefined]);

  // 401 (or 403 csrf_required, or no CSRF cookie): the host waits for a sign-in; the queue says so, once.
  const unsigned = await photo('media_unsigned');
  d.host.answer(unsigned, 'needs_sign_in', 401, { ok: false, error: 'unauthorized' });
  await page.pump();
  eq([(await page.FM.state.queue(ME)).blocked, (await stateOf(unsigned)).state], ['sign-in', 'delegated']);
  await page.FM.queue.resume(ME);                                    // the person signed in: a page of theirs loaded
  await page.pump();
  eq((await page.FM.state.queue(ME)).blocked, null, 'not paused again for the same job');
  d.host.answer(unsigned, 'done', 201, uploaded('media_unsigned'));  // the host queued it again by itself and it arrived
  await page.pump();
  eq(await stateOf(unsigned), undefined);

  // The eighth 5xx (or 408, 425, 429, a 3xx) in a row: counted as one server error and tried again later.
  const busy = await photo('media_busy');
  d.host.answer(busy, 'failed', 503, { ok: false, error: 'unavailable' }, 'retries_exhausted');
  await page.pump();
  eq([(await stateOf(busy)).state, d.host.jobs.get(busy).state], ['waiting', 'failed'], 'waiting in the queue\'s own backoff');
  await sleep(40);
  mark = d.host.calls.length;
  await page.pump();
  eq(d.host.did(mark), [['enqueue', busy, 'job']]);
  eq([(await stateOf(busy)).state, d.host.jobs.get(busy).state], ['delegated', 'queued']);

  // A redirect is never an upload's answer (iOS records it without a status): the same as no answer.
  d.host.answer(busy, 'failed', null, null, 'redirected');
  await page.pump();
  eq((await stateOf(busy)).state, 'waiting');
  await sleep(40);
  await page.pump();
  eq([(await stateOf(busy)).state, d.host.jobs.get(busy).state], ['delegated', 'queued']);

  // The host lost the file: the job is cancelled and the stored file handed over again.
  d.host.answer(busy, 'failed', null, null, 'file_missing');
  mark = d.host.calls.length;
  await page.pump();
  eq(d.host.did(mark), [['cancel', busy], ['putBlob', busy, 16], ['enqueue', busy, 'put']]);
  eq(d.host.jobs.get(busy).state, 'queued');

  // A URL the host will not send to: the page sends the entry itself, and the host's job is gone.
  d.host.answer(busy, 'failed', null, null, 'untrusted_url');
  d.server.on(`POST ${ORG}/media`, () => ({ status: 201, json: uploaded('media_busy') }));
  await page.pump();
  await sleep(20);
  eq([d.host.jobs.has(busy), page.calls.includes('syncNow'), page.native.leftToPage()[busy]], [false, true, 'untrusted_url']);
  eq(d.server.log.filter((request) => request.method === 'POST').map((request) => [request.path, request.headers['idempotency-key']]), [[`${ORG}/media`, busy]]);
  eq(await stateOf(busy), undefined);
});

test('a file the host cannot take is uploaded by the page instead, never by both', async () => {
  const d = device();
  const page = await (await d.open()).load();
  d.server.on(`POST ${ORG}/media`, () => ({ status: 201, json: uploaded('media_big') }));
  d.host.failPut = 'file_too_large';
  const taken = await page.takePhoto('media_big', { list: false });
  await page.pump();
  await sleep(20);
  eq([page.native.leftToPage()[taken.entry], d.host.jobs.size, d.host.puts.size], ['file_too_large', 0, 0]);
  eq(d.server.log.filter((request) => request.method === 'POST').length, 1, 'sent once, from the page');
  eq(await page.entries(), []);
  // The bridge not answering is not a refusal: the entry stays with the host's side and is tried again.
  d.host.failPut = 'timeout';
  const later = await page.takePhoto('media_later', { list: false });
  await page.pump();
  eq([(await page.entries()).map((entry) => [entry.state, entry.step]), page.native.leftToPage()[later.entry]], [[['delegated', 'file']], undefined]);
  eq((await page.FM.replay.run({ force: true })).sent, 0, 'and the page does not send it meanwhile');
});

test('closing the page between any two steps: the next start reads the host\'s status and carries on', async () => {
  const d = device();
  let page = await (await d.open()).load();
  // Closed after the entry was marked delegated, before the host had the job (the bridge call never returned).
  d.host.failPut = 'timeout';
  const first = await page.takePhoto('media_1', { list: false });
  await page.pump();
  eq((await page.entries()).map((entry) => [entry.state, entry.step]), [['delegated', 'file']]);
  await page.close();
  d.host.failPut = null;
  let mark = d.host.calls.length;
  page = await (await d.open()).load();
  eq(d.host.did(mark), [['putBlob', first.entry, 13], ['enqueue', first.entry, 'put']], 'the host had no such job: handed over again');
  eq((await page.entries()).map((entry) => [entry.state, entry.step]), [['delegated', 'queued']]);

  // Closed while the host uploads; it finishes with the app closed.
  await page.close();
  d.host.answer(first.entry, 'done', 201, uploaded('media_1'));
  mark = d.host.calls.length;
  page = await (await d.open()).load();
  eq(d.host.did(mark), [['ack', first.entry]]);
  eq([page.of('synced').map((detail) => detail.response.media.id), await page.entries(), d.host.jobs.size], [['media_1'], [], 0]);

  // Closed after the answer was recorded, before it was acknowledged: the next start lets the answer go.
  const second = await page.takePhoto('media_2', { list: false });
  await page.pump();
  d.host.answer(second.entry, 'done', 201, uploaded('media_2'));
  const ack = d.host.offlineUploads.ack;
  d.host.offlineUploads.ack = async () => { throw bridgeError('timeout'); };
  await page.pump();
  eq([await page.entries(), d.host.jobs.get(second.entry).state], [[], 'done']);
  await page.close();
  d.host.offlineUploads.ack = ack;
  mark = d.host.calls.length;
  page = await (await d.open()).load();
  eq([d.host.did(mark), d.host.jobs.size], [[['ack', second.entry]], 0]);

  // The app's data was cleared on the host's side only: the job is gone, the entry and its file are not.
  const third = await page.takePhoto('media_3', { list: false });
  await page.pump();
  d.host.jobs.clear();
  mark = d.host.calls.length;
  await page.pump();
  eq(d.host.did(mark), [['putBlob', third.entry, 13], ['enqueue', third.entry, 'put']]);
  // A job that has not arrived is never cancelled because its change is missing from the queue.
  const stray = { id: 'fmo1-someone-elses', state: 'queued', status: null, body: null, error: null, attempts: 0, size: 5, file: { size: 5 }, request: {} };
  d.host.jobs.set(stray.id, stray);
  mark = d.host.calls.length;
  await page.pump();
  eq([d.host.did(mark), d.host.jobs.has(stray.id)], [[], true]);
});

test('uploads go to the host in an order the server can take: behind the project\'s own create, not behind an earlier photo\'s list save', async () => {
  const d = device();
  const page = await (await d.open()).load();
  // A project made without a connection, then two photos in it.
  d.server.down = true;
  await page.FM.api.plan(new Request(ORIGIN + '/v1/test/projects', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id: 'p9' }) }), ME, {})();
  const one = await page.takePhoto('media_1', { project: 'p9' });
  const two = await page.takePhoto('media_2', { project: 'p9' });
  await page.pump();
  eq(d.host.did(), [], 'the project has to exist first');
  eq((await page.entries()).map((entry) => [entry.write, entry.state]), [['project.create', 'waiting'], ['media.upload', 'waiting'], ['photos.save', 'waiting'], ['media.upload', 'waiting'], ['photos.save', 'waiting']]);
  // The page sends the create; it sends neither upload.
  d.server.down = false;
  d.server.on('POST /v1/test/projects', () => ({ status: 201, json: { ok: true } }));
  eq((await page.FM.replay.run({ force: true })).sent, 1);
  eq(d.server.log.filter((request) => request.method === 'POST').map((request) => request.path), ['/v1/test/projects']);
  await page.pump();
  eq(d.host.did(), [['putBlob', one.entry, 13], ['enqueue', one.entry, 'put'], ['putBlob', two.entry, 13], ['enqueue', two.entry, 'put']], 'both photos are with the host at once');
  // Someone else's waiting photo on this device is not this page's to hand over.
  await page.close();
  const other = await d.open({ user: 'user_2', org: 'org_1' });
  await other.takePhoto('media_theirs', { list: false });
  await other.close();
  const mark = d.host.calls.length;
  const again = await (await d.open()).load();
  eq(d.host.did(mark), []);
  eq((await again.entries()).filter((entry) => entry.user === 'user_2').map((entry) => entry.state), ['waiting']);
});

test('the camera roll setting is passed on, a native camera capture is queued by its token, and a browser never loads any of this', async () => {
  const d = device();
  const page = await (await d.open()).load();
  // Off by default: nothing is saved to the camera roll.
  const plain = await page.takePhoto('media_plain', { list: false });
  await page.pump();
  eq(d.host.jobs.get(plain.entry).request.saveToPhotos, false);
  // On: the host saves a copy when it creates the job. A file that is not a picture or a video never is.
  d.settings.saveToCameraRoll = true;
  const kept = await page.takePhoto('media_kept', { list: false });
  await page.pump();
  eq(d.host.jobs.get(kept.entry).request.saveToPhotos, true);
  // An app without the camera roll capability is not asked.
  d.host.capabilities = ['offlineUploads'];
  const older = await page.takePhoto('media_older', { list: false });
  await page.pump();
  eq(d.host.jobs.get(older.entry).request.saveToPhotos, false);

  // A native camera capture (Android) is already in the host's storage: the job takes it by its token.
  d.host.captures.set('token-1', { size: 9000, text: 'native capture' });
  await page.native.useCameraToken('media_native', { token: 'token-1', size: 9000 });
  let mark = d.host.calls.length;
  const native = await page.takePhoto('media_native', { list: false });
  await page.pump();
  eq(d.host.did(mark), [['enqueue', native.entry, 'cameraToken']], 'no bytes cross the bridge');
  eq([d.host.jobs.get(native.entry).file.text, d.host.jobs.get(native.entry).request.size, d.host.captures.size], ['native capture', 9000, 0]);
  // A token the host no longer has (released, or iOS): the stored file is handed over instead.
  await page.native.useCameraToken('media_gone', { token: 'token-gone', size: 1 });
  mark = d.host.calls.length;
  const gone = await page.takePhoto('media_gone', { list: false });
  await page.pump();
  eq(d.host.did(mark), [['enqueue', gone.entry, 'cameraToken'], ['putBlob', gone.entry, 16], ['enqueue', gone.entry, 'put']]);

  // A host that does not report offlineUploads (an older app): nothing is delegated and the page sends as a browser does.
  const old = device();
  old.host.capabilities = [];
  const browser = await (await old.open()).load();
  old.server.on(`POST ${ORG}/media`, () => ({ status: 201, json: uploaded('media_web') }));
  await browser.takePhoto('media_web', { list: false });
  await browser.pump();
  eq([old.host.did(), (await browser.entries()).map((entry) => entry.state)], [[], ['waiting']]);
  eq((await browser.FM.replay.run({ force: true })).sent, 1);
});
