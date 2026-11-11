// Offline photos in a real browser (docs/architecture/offline.md, "Photos and files"): the real service worker,
// engine, media contract, page API and platform-api.js in headless Chrome, with real pictures, against a small
// local server that stands in for the portal page and the media and project routes and can drop every connection.
// The contract's rules are covered case by case, without a browser, in tests/offline-photos.test.mjs.
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';

const { chromium } = createRequire(new URL('../public/v1/package.json', import.meta.url))('playwright-core');
const CHROME = process.env.CHROME_PATH || 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const real = (file) => readFileSync(new URL('../public/' + file, import.meta.url));
const sha = (bytes) => createHash('sha256').update(bytes).digest('hex');
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const ORG = '/v1/platform/organizations/org_1';

/** TEST ONLY: short waits, a budget checked on every write, and the free space the test sets. */
const TEST_CONFIG = `
FMOffline.configure({ limits: { readTimeoutMs: 700, readTimeoutAfterFailureMs: 250, budgetCheckBytes: 1 }, estimate: async () => self.__testSpace || { quota: 1e12, usage: 0 } });
self.addEventListener('message', (event) => { if (event.data && event.data.test === 'space') self.__testSpace = event.data.value; });
`;

function parseMultipart(raw, contentType) {
  const boundary = Buffer.from('--' + /boundary=(.+)$/.exec(contentType)[1]);
  const parts = {};
  for (let at = raw.indexOf(boundary); at !== -1;) {
    const next = raw.indexOf(boundary, at + boundary.length);
    if (next === -1) break;
    const part = raw.subarray(at + boundary.length + 2, next - 2);
    const split = part.indexOf('\r\n\r\n');
    const head = part.subarray(0, split).toString();
    const name = /name="([^"]+)"/.exec(head)[1];
    const file = /filename="([^"]*)"/.exec(head);
    parts[name] = file ? { name: file[1], type: (/Content-Type: (.+)/i.exec(head) || [])[1], bytes: Buffer.from(part.subarray(split + 4)) } : part.subarray(split + 4).toString();
    at = next;
  }
  return parts;
}

/** The portal page, the offline files of a release, and the media and project routes, on a port of its own. */
async function site() {
  const s = { down: false, log: [], media: new Map(), uploads: [], photos: [{ id: 'media_first', photo_id: 'media_first', media_id: 'media_first', kind: 'media_reference', label: 'First' }], revision: 3 };
  const fixed = {
    '/portal/sw.js': real('portal/sw.js'),
    '/libraries/platform-offline/offline-core.js': real('libraries/platform-offline/offline-core.js'),
    '/libraries/platform-offline/platform-offline.js': real('libraries/platform-offline/platform-offline.js'),
    '/libraries/platform-offline/contracts/core.js': real('libraries/platform-offline/contracts/core.js'),
    '/libraries/platform-offline/contracts/media.js': real('libraries/platform-offline/contracts/media.js'),
    '/libraries/platform-offline/contracts/index.js': Buffer.from("self.FM_OFFLINE_CONTRACTS = ['core.js', 'media.js', 'test-config.js'];"),
    '/libraries/platform-offline/contracts/test-config.js': Buffer.from(TEST_CONFIG),
    '/libraries/platform-api/platform-api.js': real('libraries/platform-api/platform-api.js')
  };
  const manifest = () => ({ enabled: true, release: 'r1', generated_at: new Date().toISOString(), files: Object.fromEntries(Object.entries(fixed).filter(([path]) => path !== '/portal/sw.js').map(([path, bytes]) => [path, [sha(bytes), bytes.length]])), shells: ['/portal/'], external: [] });
  const shell = () => `<!doctype html><html><head><meta charset="utf-8"><title>Portal</title>
<script>window.__APP = { userId: 'user_1', userOrgId: 'org_1', platformSessionCookieName: 'fm_platform_session', platformApiBase: location.origin + '/v1/platform' };</script>
<script src="/libraries/platform-offline/platform-offline.js"></script>
<script src="/libraries/platform-api/platform-api.js"></script>
</head><body><div id="grid"></div></body></html>`;
  const projectDocument = () => ({ ok: true, document: { id: 'p1', revision: s.revision, data: { id: 'p1', title: 'Oak St', photos: s.photos } } });

  function api(request) {
    const { method, path, query } = request;
    const file = /\/media\/([^/]+)\/file$/.exec(path);
    if (method === 'GET' && file) {
      const stored = s.media.get(file[1]);
      if (!stored) return { status: 404, json: { ok: false, error: 'media_not_found' } };
      const variant = new URLSearchParams(query).get('variant') || 'original';
      // As the server answers: a rendition never changes, the original is asked about every time.
      if (variant.startsWith('thumb')) return stored.record.variants[variant] ? { bytes: Buffer.from('server ' + variant + ' of ' + file[1]), type: 'image/webp', headers: { 'Cache-Control': 'private, max-age=31536000, immutable' } } : { status: 404, json: { ok: false, error: 'variant_not_found' } };
      return { bytes: stored.bytes, type: stored.record.content_type, headers: { 'Cache-Control': 'private, no-cache' } };
    }
    if (method === 'GET' && path === `${ORG}/projects/p1`) return { json: projectDocument() };
    if (method === 'GET' && path === `${ORG}/media`) {
      const project = new URLSearchParams(query).get('project_id');
      return { json: { ok: true, media: [...s.media.values()].map((item) => item.record).filter((record) => !project || record.owner.id === project) } };
    }
    if (method === 'POST' && path === `${ORG}/media`) {
      const form = parseMultipart(request.raw, request.headers['content-type']);
      const part = form.file;
      const id = form.id || (form.replace_slot === 'true' ? `${form.owner_type}_${form.owner_id}_${form.slot}` : 'media_server_' + (s.uploads.length + 1));
      const existing = s.media.get(id);
      // Another owner's id cannot be taken over; the same owner's is replaced.
      if (existing && (existing.record.owner.type !== form.owner_type || existing.record.owner.id !== form.owner_id)) return { status: 409, json: { ok: false, error: 'media_id_taken' } };
      const large = !/small/.test(part.name);
      const variants = Object.fromEntries(['original', ...(large ? ['thumb_160', 'thumb_320', 'thumb_640'] : [])].map((variant) => [variant, { path: variant }]));
      const record = { id, organization_id: 'org_1', owner: { type: form.owner_type, id: form.owner_id, slot: form.slot }, kind: 'image', content_type: part.type, file_name: part.name, size_bytes: part.bytes.length, variants, metadata: { ...JSON.parse(form.metadata || '{}'), uploaded_by_user_id: 'user_1' }, created_at: new Date().toISOString() };
      s.media.set(id, { record, bytes: part.bytes });
      s.uploads.push({ id, fields: form, key: request.headers['idempotency-key'], replay: request.headers['x-fm-offline-replay'] || null, size: part.bytes.length });
      return { status: 201, json: { ok: true, media: record } };
    }
    if (method === 'POST' && path === `${ORG}/projects/p1/photos`) {
      const remove = new Set(request.body.remove);
      const seen = new Set();
      const next = [];
      for (const photo of [...request.body.photos, ...s.photos]) { if (seen.has(photo.id) || remove.has(photo.id)) continue; seen.add(photo.id); next.push(photo); }
      s.photos = next; s.revision++;
      return { json: { ok: true, project_id: 'p1', photos: s.photos, thumbnail_photo_id: '', thumbnail_photo: null, project_revision: s.revision, document: projectDocument().document } };
    }
    return null;
  }

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://localhost');
    const path = url.pathname;
    if (s.down) { req.socket.destroy(); return; }
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const raw = Buffer.concat(chunks);
    const entry = { method: req.method, path, query: url.search, headers: req.headers, raw, body: null };
    if (raw.length && /json/.test(req.headers['content-type'] || '')) { try { entry.body = JSON.parse(raw.toString()); } catch { entry.body = null; } }
    s.log.push(entry);
    const send = (status, headers, body) => { res.writeHead(status, { 'Cache-Control': 'no-store', ...headers }); res.end(body); };
    const json = (status, body, headers = {}) => send(status, { 'Content-Type': 'application/json', ...headers }, JSON.stringify(body));
    if (path === '/v1/platform/offline/assets') return json(200, manifest());
    if (path.startsWith('/v1/')) {
      if (s.down) { req.socket.destroy(); return; }
      const answer = api(entry);
      if (!answer) return json(404, { ok: false, error: 'not_found' });
      if (answer.bytes) return send(answer.status || 200, { 'Content-Type': answer.type || 'application/octet-stream', ...answer.headers }, answer.bytes);
      return json(answer.status || 200, answer.json, answer.headers);
    }
    if (path === '/portal/' || path === '/portal/index.php') return send(200, { 'Content-Type': 'text/html; charset=utf-8', 'X-FirstMate-Release': 'r1', 'X-FirstMate-Identity': 'user_1/org_1', 'Set-Cookie': 'fm_platform_session_csrf=csrf-token-1; Path=/' }, shell());
    const bytes = fixed[path];
    if (!bytes) return send(404, { 'Content-Type': 'text/plain' }, 'not found');
    return send(200, { 'Content-Type': 'text/javascript' }, bytes);
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  s.origin = `http://127.0.0.1:${server.address().port}`;
  s.close = () => new Promise((resolve) => { server.closeAllConnections(); server.close(resolve); });
  s.requests = (method, prefix, from = 0) => s.log.slice(from).filter((entry) => entry.method === method && entry.path.startsWith(prefix));
  return s;
}

async function withBrowser(run) {
  const s = await site();
  const browser = await chromium.launch({ executablePath: CHROME, headless: true });
  const context = await browser.newContext();
  try { await run(s, context); } finally { await browser.close(); await s.close(); }
}

/** Opens the portal, waits until the worker knows who is signed in and the code set is on the device. */
async function openPortal(context, s) {
  const page = await context.newPage();
  await page.goto(s.origin + '/portal/');
  await page.evaluate(() => window.PlatformOffline.ready);
  await page.evaluate(() => {
    window.__events = [];
    for (const type of ['queued', 'synced', 'failed', 'discarded']) window.PlatformOffline.on(type, (detail) => window.__events.push({ type, detail }));
    // A real photo: a JPEG of the given size, with something in it, taken at the given time.
    window.makePhoto = (name, width, height, takenAt) => new Promise((resolve) => {
      const canvas = document.createElement('canvas');
      canvas.width = width; canvas.height = height;
      const context = canvas.getContext('2d');
      const gradient = context.createLinearGradient(0, 0, width, height);
      gradient.addColorStop(0, '#1d4ed8'); gradient.addColorStop(1, '#f97316');
      context.fillStyle = gradient; context.fillRect(0, 0, width, height);
      context.fillStyle = '#fff'; context.font = `${Math.round(height / 6)}px sans-serif`; context.fillText(name, width / 10, height / 2);
      canvas.toBlob((blob) => resolve(new File([blob], name, { type: 'image/jpeg', lastModified: takenAt })), 'image/jpeg', 0.9);
    });
    window.photos = {};
    // What the Photos tab does for one file (projectMedia.uploadMedia: the upload, then the project's list save).
    window.addPhoto = async (name, width, height, takenAt) => {
      const file = window.photos[name] || (window.photos[name] = await window.makePhoto(name, width, height, takenAt));
      const project = (await window.PlatformAPI.projects.get('org_1', 'p1')).document.data;
      const result = await window.PlatformAPI.projectMedia.uploadMedia('org_1', 'p1', project, file, { thumbnails: true, compression: { quality: 0.88, max_width: 2400, max_height: 2400 } });
      const kept = result.upload.offlineCopy ? await result.upload.offlineCopy : null;
      return { queued: result.queued, media: result.media, photo: { id: result.photo.id, media_id: result.photo.media_id, thumb: result.photo.thumb, src: result.photo.src }, size: file.size, kept, listed: (result.document?.data?.photos || []).map((photo) => photo.id) };
    };
    // What an <img> of the grid gets for a URL: its natural size, and where the answer came from.
    window.picture = async (url) => {
      let response;
      try { response = await fetch(url, { credentials: 'include' }); } catch (error) { return { error: String(error) }; }
      const blob = await response.blob();
      const size = await new Promise((resolve) => { const image = new Image(); image.onload = () => resolve([image.naturalWidth, image.naturalHeight]); image.onerror = () => resolve(null); image.src = URL.createObjectURL(blob); });
      return { status: response.status, offline: response.headers.get('x-fm-offline'), type: response.headers.get('content-type'), bytes: blob.size, size };
    };
  });
  await page.evaluate(() => window.PlatformOffline.checkForUpdate());
  return page;
}
const state = (page) => page.evaluate(() => window.PlatformOffline.state());
const until = async (probe, message, ms = 10000) => { const end = Date.now() + ms; for (;;) { const value = await probe(); if (value) return value; if (Date.now() > end) assert.fail('timed out: ' + message); await sleep(50); } };
const get = (page, path) => page.evaluate(async (path) => { try { const response = await fetch(path, { credentials: 'include' }); return { status: response.status, offline: response.headers.get('x-fm-offline'), json: await response.json() }; } catch (error) { return { error: String(error) }; } }, path);
const device = (page) => page.evaluate(async () => {
  const database = await new Promise((resolve, reject) => { const request = indexedDB.open('fm-offline-v1'); request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error); });
  const all = (store) => new Promise((resolve, reject) => { const request = database.transaction(store).objectStore(store).getAll(); request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error); });
  const out = { outbox: (await all('outbox')).sort((a, b) => a.seq - b.seq).map((row) => ({ id: row.id, write: row.write, kind: row.kind, scope: row.scope, state: row.state, records: row.records })), blobs: (await all('blobs')).map((row) => ({ entry: row.k[0], name: row.name, size: row.size })), media: (await all('media')).map((row) => row.k[2]).sort() };
  database.close();
  return out;
});
const file = (id, variant) => `${ORG}/media/${id}/file?variant=${variant}`;
const TAKEN = Date.parse('2026-11-10T16:20:00.000Z');

// ---------------------------------------------------------------------------------------------------------------

test('a photo taken with no connection is in the grid\'s reads from the stored file, survives a closed page, is sent once, and leaves a small copy behind', async () => {
  await withBrowser(async (s, context) => {
    let page = await openPortal(context, s);
    // What the Photos tab reads, once with a connection.
    await get(page, `${ORG}/projects/p1`);
    await get(page, `${ORG}/media`);

    s.down = true;
    const added = await page.evaluate(([taken]) => window.addPhoto('roof.jpg', 1600, 1200, taken), [TAKEN]);
    const id = added.media.id;
    assert.match(id, /^media_[0-9a-f]{16}$/, 'the record is named on the device, in the server\'s own format');
    assert.match(added.queued, /^fmo1-/);
    assert.deepEqual([added.photo.id, added.photo.media_id, added.listed.slice().sort()], [id, id, [id, 'media_first'].sort()], 'the photo is the same record in the list');
    // The answer is the record the route would give: the worker read the picture's size, so its variants are right.
    assert.deepEqual([added.media.width, added.media.height, Object.keys(added.media.variants)], [1600, 1200, ['original', 'thumb_160', 'thumb_320', 'thumb_640']]);
    assert.deepEqual([added.media.variants.thumb_320.width, added.media.variants.thumb_320.height, added.media.owner, added.media.size_bytes], [320, 240, { type: 'project', id: 'p1', slot: 'photos' }, added.size]);
    assert.equal(added.media.metadata.taken_at, new Date(TAKEN).toISOString(), 'when it was taken, not when it was queued');
    assert.ok(Date.parse(added.media.metadata.uploaded_at) > TAKEN);
    assert.deepEqual(added.kept, [true, true], 'the small copy is on the device under the two thumbnail URLs');

    // The grid's reads show it, and its picture URLs are answered on the device.
    const project = await get(page, `${ORG}/projects/p1`);
    assert.deepEqual([project.offline, project.json.document.data.photos.map((photo) => photo.id).sort()], ['saved', [id, 'media_first'].sort()]);
    assert.deepEqual((await get(page, `${ORG}/media`)).json.media.map((item) => item.id), [id]);
    const original = await page.evaluate((url) => window.picture(url), added.photo.src);
    assert.deepEqual([original.status, original.offline, original.type, original.bytes, original.size], [200, 'queued', 'image/jpeg', added.size, [1600, 1200]], 'the viewer gets the stored file');
    const thumb = await page.evaluate((url) => window.picture(url), added.photo.thumb);
    assert.equal(new URL(added.photo.thumb).pathname + new URL(added.photo.thumb).search, file(id, 'thumb_320'));
    assert.deepEqual([thumb.status, thumb.type, thumb.size], [200, 'image/jpeg', [640, 480]], 'the grid gets the 640 px copy, not the full file');
    assert.ok(thumb.bytes < added.size / 2);
    await until(async () => (await state(page)).pending === 2, 'the upload and the list save wait');
    assert.equal(await page.evaluate((id) => window.PlatformOffline.isPending(id), id), true);
    let d = await device(page);
    assert.deepEqual(d.outbox.map((entry) => [entry.write, entry.kind, entry.scope, entry.state, entry.records]), [['media.upload', 'upload', 'project:p1', 'waiting', [id]], ['photos.save', 'patch', 'project:p1', 'waiting', [id]]]);
    assert.deepEqual(d.blobs, [{ entry: added.queued, name: 'roof.jpg', size: added.size }], 'one file is kept for the upload');
    assert.deepEqual(d.media, [file(id, 'thumb_320'), file(id, 'thumb_640')]);

    // The page is closed and opened again, still without a connection.
    await page.close();
    page = await openPortal(context, s);
    assert.equal((await state(page)).pending, 2);
    assert.equal(await page.evaluate((id) => window.PlatformOffline.isPending(id), id), true);
    assert.deepEqual((await page.evaluate((id) => window.PlatformOffline.pending({ record: id }), id)).map((entry) => [entry.write, entry.state]), [['media.upload', 'waiting'], ['photos.save', 'waiting']]);
    assert.ok((await get(page, `${ORG}/projects/p1`)).json.document.data.photos.some((photo) => photo.id === id));
    assert.deepEqual((await page.evaluate((url) => window.picture(url), file(id, 'original'))).size, [1600, 1200]);

    // The connection returns.
    s.down = false;
    const mark = s.log.length;
    await page.evaluate(() => window.PlatformOffline.syncNow());
    await until(async () => (await state(page)).pending === 0, 'both changes are sent');
    assert.equal(s.uploads.length, 1, 'uploaded once');
    assert.deepEqual([s.uploads[0].id, s.uploads[0].key, s.uploads[0].replay, s.uploads[0].size], [id, added.queued, '1', added.size], 'the same record id, under the key it was queued with');
    assert.deepEqual([s.uploads[0].fields.owner_type, s.uploads[0].fields.owner_id, s.uploads[0].fields.slot, JSON.parse(s.uploads[0].fields.metadata).taken_at], ['project', 'p1', 'photos', new Date(TAKEN).toISOString()]);
    // The list save follows the upload, with nothing removed.
    const writes = s.log.slice(mark).filter((request) => request.method === 'POST').map((request) => request.path);
    assert.deepEqual(writes, [`${ORG}/media`, `${ORG}/projects/p1/photos`]);
    const [save] = s.requests('POST', `${ORG}/projects/p1/photos`, mark);
    assert.deepEqual([save.body.photos.map((photo) => photo.id).sort(), save.body.remove], [[id, 'media_first'].sort(), []]);
    assert.deepEqual(s.photos.map((photo) => photo.id).sort(), [id, 'media_first'].sort(), 'the project has it once');
    assert.equal(s.media.size, 1);
    const synced = await until(async () => { const list = await page.evaluate(() => window.__events.filter((event) => event.type === 'synced').map((event) => [event.detail.write, event.detail.status])); return list.length === 2 ? list : null; }, 'the page hears both');
    assert.deepEqual(synced, [['media.upload', 201], ['photos.save', 200]]);
    assert.equal(await page.evaluate((id) => window.PlatformOffline.isPending(id), id), false);

    // The original left the device; the small copy answers the thumbnail URLs with the server away, and was never downloaded.
    d = await device(page);
    assert.deepEqual([d.outbox, d.blobs], [[], []]);
    s.down = true;
    for (const variant of ['thumb_320', 'thumb_640']) {
      const kept = await page.evaluate((url) => window.picture(url), file(id, variant));
      assert.deepEqual([kept.status, kept.offline, kept.type, kept.size], [200, 'saved', 'image/jpeg', [640, 480]], variant);
    }
    assert.ok((await page.evaluate((url) => window.picture(url), file(id, 'original'))).error, 'the full picture is not kept');
    assert.equal(s.requests('GET', `${ORG}/media/${id}/file`).length, 0, 'no thumbnail was downloaded');
    s.down = false;
    // With a connection the same thumbnail URL is still answered from the device (a rendition never changes).
    assert.equal((await page.evaluate((url) => window.picture(url), file(id, 'thumb_320'))).offline, 'saved');

    // The rolling budget lets these copies go like any other file: least recently used first.
    await page.evaluate(() => window.PlatformOffline.settings.set('mediaBudgetMb', 0.02));
    s.down = true;
    const second = await page.evaluate(([taken]) => window.addPhoto('gutter.jpg', 1600, 1200, taken), [TAKEN + 60000]);
    await until(async () => { const kept = (await device(page)).media; return !kept.includes(file(id, 'thumb_320')) && !kept.includes(file(id, 'thumb_640')); }, 'the older copies were evicted');
    assert.ok((await page.evaluate((url) => window.picture(url), file(id, 'thumb_320'))).error, 'gone from the device');
    // The waiting photo is still shown: its file is in the queue, not in the cache.
    assert.deepEqual((await page.evaluate((url) => window.picture(url), file(second.media.id, 'thumb_320'))).status, 200);
  });
});

test('a small picture the server makes no thumbnails for still shows after it is uploaded', async () => {
  await withBrowser(async (s, context) => {
    const page = await openPortal(context, s);
    await get(page, `${ORG}/projects/p1`);
    s.down = true;
    const added = await page.evaluate(([taken]) => window.addPhoto('small-label.jpg', 600, 400, taken), [TAKEN]);
    const id = added.media.id;
    assert.deepEqual([added.media.width, Object.keys(added.media.variants)], [600, ['original']], 'no thumbnails are promised for a picture under 1024 px');
    assert.equal(new URL(added.photo.thumb).search, '?variant=thumb_320');
    assert.deepEqual(added.kept, [true]);
    assert.deepEqual((await device(page)).media, [file(id, 'original')], 'the file itself is kept: the grid shows a small picture from its original');
    s.down = false;
    await page.evaluate(() => window.PlatformOffline.syncNow());
    await until(async () => (await state(page)).pending === 0, 'sent');
    assert.deepEqual((await device(page)).blobs, []);
    // With a connection the original is asked for (it can change under its URL); without one the device's copy answers.
    const online = await page.evaluate((url) => window.picture(url), file(id, 'original'));
    assert.deepEqual([online.offline, online.size], [null, [600, 400]]);
    s.down = true;
    const kept = await page.evaluate((url) => window.picture(url), file(id, 'original'));
    assert.deepEqual([kept.status, kept.offline, kept.size, kept.bytes], [200, 'saved', [600, 400], added.size]);
  });
});

test('with a connection the same photo sent again replaces its record; another owner and a slot upload are not affected', async () => {
  await withBrowser(async (s, context) => {
    const page = await openPortal(context, s);
    const result = await page.evaluate(async ([taken]) => {
      const file = await window.makePhoto('porch.jpg', 1200, 900, taken);
      const options = { ownerType: 'project', ownerId: 'p1', slot: 'photos', metadata: { source: 'project_photo_upload' } };
      const first = await window.PlatformAPI.media.upload('org_1', file, options);
      const again = await window.PlatformAPI.media.upload('org_1', file, options);                      // a retry: the same file
      const elsewhere = await window.PlatformAPI.media.upload('org_1', file, { ...options, ownerId: 'p2' });
      const other = await window.PlatformAPI.media.upload('org_1', await window.makePhoto('porch.jpg', 1200, 900, taken), options);
      const logo = await window.PlatformAPI.media.upload('org_1', file, { ownerType: 'organization', ownerId: 'org_1', slot: 'logo', replaceSlot: true });
      const given = await window.PlatformAPI.media.upload('org_1', file, { ...options, id: 'media_given_by_caller' });
      return { first: first.media.id, again: again.media.id, elsewhere: elsewhere.media.id, other: other.media.id, logo: logo.media.id, given: given.media.id, queued: [first.queued, again.queued] };
    }, [TAKEN]);
    assert.match(result.first, /^media_[0-9a-f]{16}$/);
    assert.equal(result.again, result.first, 'the same file to the same owner is the same record');
    assert.notEqual(result.elsewhere, result.first, 'the same file for another project is another record');
    assert.notEqual(result.other, result.first, 'another file is another record');
    assert.equal(result.logo, 'organization_org_1_logo', 'a slot upload sends no id: the server names it by its slot');
    assert.equal(result.given, 'media_given_by_caller');
    assert.deepEqual(result.queued, [undefined, undefined], 'nothing waited');
    assert.equal(s.uploads.length, 6);
    assert.deepEqual([s.uploads[0].id, s.uploads[1].id, s.uploads[4].fields.id], [result.first, result.first, undefined]);
    assert.equal([...s.media.keys()].filter((id) => id === result.first).length, 1);
    assert.equal([...s.media.values()].filter((item) => item.record.owner.id === 'p1' && item.record.file_name === 'porch.jpg').length, 3, 'the retry added no record (first, another file, the caller\'s id)');
    // The capture time is sent for a picture, and not for a slot upload.
    assert.equal(JSON.parse(s.uploads[0].fields.metadata).taken_at, new Date(TAKEN).toISOString());
    assert.equal(s.uploads[4].fields.metadata, undefined);
  });
});

test('the small copy is drawn the way the picture is shown: a phone photo stored on its side comes out upright', async () => {
  // A phone keeps a portrait photo as landscape pixels with an EXIF orientation. Here: 1600x1200 stored, red on
  // the stored left and blue on the stored right, orientation 6 (shown turned a quarter clockwise: red on top).
  const sharp = createRequire(new URL('../public/v1/package.json', import.meta.url))('sharp');
  const half = (color) => sharp({ create: { width: 800, height: 1200, channels: 3, background: color } }).png().toBuffer();
  const stored = await sharp({ create: { width: 1600, height: 1200, channels: 3, background: '#000' } })
    .composite([{ input: await half('#e11d48'), left: 0, top: 0 }, { input: await half('#1d4ed8'), left: 800, top: 0 }])
    .withMetadata({ orientation: 6 }).jpeg({ quality: 90 }).toBuffer();
  await withBrowser(async (s, context) => {
    const page = await openPortal(context, s);
    const copy = await page.evaluate(async (base64) => {
      const bytes = Uint8Array.from(atob(base64), (char) => char.charCodeAt(0));
      const file = new File([bytes], 'portrait.jpg', { type: 'image/jpeg' });
      const made = await window.PlatformAPI.media.smallImageCopy(file);
      const bitmap = await createImageBitmap(made.blob);
      const canvas = document.createElement('canvas');
      canvas.width = bitmap.width; canvas.height = bitmap.height;
      const context = canvas.getContext('2d');
      context.drawImage(bitmap, 0, 0);
      const at = (x, y) => { const [r, , b] = context.getImageData(x, y, 1, 1).data; return r > b ? 'red' : 'blue'; };
      return { picture: [made.width, made.height], copy: [bitmap.width, bitmap.height], type: made.blob.type, top: at(240, 100), bottom: at(240, 540) };
    }, stored.toString('base64'));
    assert.deepEqual(copy, { picture: [1200, 1600], copy: [480, 640], type: 'image/jpeg', top: 'red', bottom: 'blue' });
  });
});

test('a device short on space refuses the photo and says what the person can do', async () => {
  await withBrowser(async (s, context) => {
    const page = await openPortal(context, s);
    await get(page, `${ORG}/projects/p1`);
    await page.evaluate(() => navigator.serviceWorker.controller.postMessage({ test: 'space', value: { quota: 100 * 1024 * 1024, usage: 95 * 1024 * 1024 } }));
    await sleep(100);
    s.down = true;
    const refused = await page.evaluate(async ([taken]) => {
      try { await window.addPhoto('full.jpg', 1600, 1200, taken); return null; } catch (error) { return { code: error.code, status: error.status, message: error.message }; }
    }, [TAKEN]);
    assert.deepEqual([refused.code, refused.status], ['offline_storage_full', 507]);
    assert.match(refused.message, /out of space/);
    assert.match(refused.message, /Connect to the internet so the photos that are waiting can upload, or lower the picture storage/);
    assert.deepEqual((await device(page)).outbox, [], 'nothing is queued, and nothing pretends to be saved');
  });
});
