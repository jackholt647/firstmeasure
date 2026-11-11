// The offline photo contract (public/libraries/platform-offline/contracts/media.js; docs/architecture/offline.md,
// "Photos and files") run by the real engine as the service worker runs it, with a Map in place of IndexedDB and a
// scripted server in place of the network. The same pipeline in a real browser, with real pictures and the media
// cache, is tests/offline-photos-browser.test.mjs.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { webcrypto } from 'node:crypto';
import vm from 'node:vm';

const read = (file) => readFileSync(new URL('../public/libraries/platform-offline/' + file, import.meta.url), 'utf8');
const ORIGIN = 'https://app.test';
const ME = { user: 'user_1', org: 'org_1' };
const ORG = '/v1/platform/organizations/org_1';
const eq = (actual, expected, message) => assert.deepStrictEqual(JSON.parse(JSON.stringify(actual ?? null)), JSON.parse(JSON.stringify(expected ?? null)), message);

/** A scripted server: routes answer, `down` drops every request, `log` keeps what arrived. */
function fakeServer() {
  const routes = [];
  const server = {
    down: false, log: [],
    on(pattern, handler) { routes.unshift({ pattern, handler }); return server; },
    sent: (pattern) => server.log.filter((entry) => `${entry.method} ${entry.path}`.startsWith(pattern)),
    async fetch(input, init) {
      const request = input instanceof Request ? input : new Request(input, init);
      const url = new URL(request.url);
      const headers = Object.fromEntries(request.headers);
      let body = null;
      if (request.method !== 'GET' && request.method !== 'HEAD') {
        if ((headers['content-type'] || '').includes('multipart/form-data')) { body = {}; for (const [name, value] of (await request.formData()).entries()) body[name] = typeof value === 'string' ? value : { name: value.name, type: value.type, text: await value.text() }; }
        else { const text = await request.text(); try { body = JSON.parse(text); } catch { body = text; } }
      }
      const entry = { method: request.method, path: url.pathname, query: url.search, headers, body };
      if (server.down) throw new TypeError('Failed to fetch');
      server.log.push(entry);
      const route = routes.find((item) => `${entry.method} ${entry.path}`.startsWith(item.pattern));
      const answer = route ? await route.handler(entry) : { status: 404, json: { ok: false, error: 'not_found' } };
      return new Response(JSON.stringify(answer.json), { status: answer.status || 200, headers: { 'Content-Type': 'application/json' } });
    }
  };
  return server;
}

/** The engine with the real contracts, as one service worker holds it. */
function engine() {
  const server = fakeServer();
  const clock = { now: Date.parse('2026-11-11T15:00:00.000Z') };
  const navigator = { onLine: true };
  const context = vm.createContext({ URL, URLSearchParams, Request, Response, Headers, Blob, File, FormData, AbortController, TextEncoder, TextDecoder, crypto: webcrypto, console, setTimeout, clearTimeout, navigator, location: { origin: ORIGIN } });
  context.self = context;
  vm.runInContext(read('offline-core.js'), context, { filename: 'offline-core.js' });
  const FM = context.FMOffline;
  FM.configure({ fetch: server.fetch, now: () => clock.now, identity: async () => ME, csrf: async () => 'csrf-1', estimate: async () => ({ quota: 1e12, usage: 0 }), limits: { readTimeoutMs: 80, readTimeoutAfterFailureMs: 30 } });
  vm.runInContext(read('contracts/core.js'), context, { filename: 'contracts/core.js' });
  vm.runInContext(read('contracts/notes.js'), context, { filename: 'contracts/notes.js' });
  vm.runInContext(read('contracts/media.js'), context, { filename: 'contracts/media.js' });
  const events = [];
  for (const type of ['queued', 'synced', 'failed', 'conflict', 'discarded']) FM.events.on(type, (detail) => events.push({ type, detail }));
  const waits = [];
  const request = async (method, path, init = {}) => {
    const headers = { ...(init.headers || {}) };
    let body = init.body;
    if (init.json !== undefined) { body = JSON.stringify(init.json); headers['Content-Type'] = 'application/json'; }
    const plan = FM.api.plan(new Request(ORIGIN + path, { method, headers, body }), ME, { waitUntil: (promise) => waits.push(promise) });
    if (!plan) return 'untouched';
    return plan();
  };
  const json = async (method, path, init) => { const response = await request(method, path, init); const data = await response.json(); while (waits.length) await waits.shift(); return { response, data, queued: response.headers.get('x-fm-offline-queued') }; };
  const entries = async () => (await FM.queue.list(ME)).map((entry) => ({ ...entry }));
  return { FM, server, clock, navigator, events, request, json, entries, of: (type) => events.filter((event) => event.type === type).map((event) => event.detail) };
}

/** The form platform-api.js sends for a project photo (media.upload through projectMedia.uploadMedia). */
function photoForm(id, fields = {}, file = new File(['photo-bytes'], 'Roof front.jpg', { type: 'image/jpeg' })) {
  const form = new FormData();
  form.append('file', file);
  const all = {
    id, owner_type: 'project', owner_id: 'p1', slot: 'photos', collection: 'projects', scope: 'projects', replace_slot: 'false', thumbnails: 'true',
    compression: JSON.stringify({ quality: 0.88, max_width: 2400, max_height: 2400 }),
    metadata: JSON.stringify({ field: 'photos', source: 'project_photo_upload', uploaded_at: '2026-11-11T15:00:00.000Z', taken_at: '2026-11-11T14:58:00.000Z' }),
    ...fields
  };
  for (const [name, value] of Object.entries(all)) if (value !== undefined) form.append(name, value);
  return form;
}
/** A photo reference as the page keeps it in a project's photo list. */
const ref = (id, extra = {}) => ({ id, photo_id: id, media_id: id, kind: 'media_reference', label: id, ...extra });
const projectDocument = (photos, revision = 4) => ({ ok: true, document: { id: 'p1', revision, data: { id: 'p1', title: 'Oak St', photos, thumbnail_photo_id: 'media_a' } } });

test('a project photo taken without a connection is queued with the record the route would answer, and its file is on the device', async () => {
  const t = engine();
  t.server.down = true;
  const queued = await t.json('POST', `${ORG}/media`, { body: photoForm('media_00112233aabbccdd') });
  assert.equal(queued.response.status, 200);
  assert.match(queued.queued, /^fmo1-/);
  const media = queued.data.media;
  eq([queued.data.ok, media.id, media.organization_id, media.kind, media.content_type, media.file_name, media.size_bytes], [true, 'media_00112233aabbccdd', 'org_1', 'image', 'image/jpeg', 'Roof-front.jpg', 11]);
  eq(media.owner, { type: 'project', id: 'p1', slot: 'photos' });
  eq([media.scope, media.collection, media.schema_version], ['projects', 'projects', 1]);
  // Nothing here can decode the picture, so it is taken to be large, as a phone's photos are: thumbnails are named.
  eq(Object.keys(media.variants), ['original', 'thumb_160', 'thumb_320', 'thumb_640']);
  eq(media.variants.original, { path: 'original/original.jpg', content_type: 'image/jpeg', file_name: 'Roof-front.jpg', size_bytes: 11 });
  eq(media.variants.thumb_320, { path: 'renditions/thumb_320.webp', content_type: 'image/webp', file_name: 'thumb_320.webp', size_bytes: 0 });
  eq(media.renditions.map((item) => item.variant), ['thumb_160', 'thumb_320', 'thumb_640']);
  eq(media.markup, { layers: [], current_layer_id: null });
  eq([media.processing.thumbnails.sizes, media.processing.thumbnails.largeThreshold, media.processing.compression.quality, media.processing.compression.maxWidth], [[160, 320, 640], 1024, 88, 2400]);
  // The capture time and who took it, with the project it belongs to.
  eq(media.metadata, { field: 'photos', source: 'project_photo_upload', uploaded_at: '2026-11-11T15:00:00.000Z', taken_at: '2026-11-11T14:58:00.000Z', uploaded_by_user_id: 'user_1', project_id: 'p1' });
  eq([media.created_at, media.updated_at], ['2026-11-11T15:00:00.000Z', '2026-11-11T15:00:00.000Z']);

  const [entry] = await t.entries();
  eq([entry.contract, entry.write, entry.kind, entry.scope, entry.records, entry.state], ['media', 'media.upload', 'upload', 'project:p1', ['media_00112233aabbccdd'], 'waiting']);
  eq(entry.label, { key: 'sync_photo_new', title: 'Photo', detail: 'Roof front.jpg' });
  eq(entry.media, [{ id: 'media_00112233aabbccdd', blob: 0 }]);
  // The grid's thumbnail URL and the viewer's file URL are answered from the stored file.
  for (const variant of ['?variant=thumb_320', '?variant=original']) {
    const file = await t.request('GET', `${ORG}/media/media_00112233aabbccdd/file${variant}`);
    eq([file.status, file.headers.get('x-fm-offline'), await file.text()], [200, 'queued', 'photo-bytes']);
  }
});

test('only project photos, photos with no project and a contact\'s files are queued; a slot upload, another owner and an upload without an id are not', async () => {
  const t = engine();
  t.server.down = true;
  const refused = async (fields) => { const answer = await t.json('POST', `${ORG}/media`, { body: photoForm('media_1', fields) }); return [answer.response.status, answer.data.error]; };
  eq(await refused({ replace_slot: 'true' }), [503, 'offline_unavailable'], 'a logo keeps the id its slot gives it');
  eq(await refused({ id: undefined }), [503, 'offline_unavailable']);
  eq(await refused({ owner_type: 'equipment_unit', owner_id: 'unit_1', slot: 'photos' }), [503, 'offline_unavailable']);
  eq(await refused({ owner_type: 'contact', owner_id: '', slot: 'media' }), [503, 'offline_unavailable'], 'a contact file names its contact');
  eq(await refused({ owner_type: 'contact', owner_id: 'contact_1', slot: 'logo' }), [503, 'offline_unavailable'], 'a branding slot is never a contact\'s');
  eq(await refused({ slot: 'documents' }), [503, 'offline_unavailable'], 'a project document goes to the documents route');
  eq(await refused({ owner_id: '' }), [503, 'offline_unavailable'], 'a project photo names its project');
  eq(await t.entries(), []);
  // A photo with no project yet (the Feed camera) waits in the person's own scope.
  const feed = await t.json('POST', `${ORG}/media`, { body: photoForm('media_feed', { owner_type: 'organization', owner_id: undefined, collection: undefined, scope: undefined, metadata: JSON.stringify({ source: 'feed_camera_capture', upload_batch_id: 'feed_1', project_id: 'ignored' }) }) });
  eq(feed.data.media.owner, { type: 'organization', id: 'org_1', slot: 'photos' });
  eq(feed.data.media.metadata, { source: 'feed_camera_capture', upload_batch_id: 'feed_1', uploaded_by_user_id: 'user_1' }, 'an unpaired photo names no project');
  eq((await t.entries()).map((entry) => entry.scope), ['user:user_1']);
  // A video, a small GIF: no thumbnails are promised.
  const video = await t.json('POST', `${ORG}/media`, { body: photoForm('media_video', {}, new File(['video-bytes'], 'walk.mp4', { type: 'video/mp4' })) });
  eq([video.data.media.kind, Object.keys(video.data.media.variants)], ['video', ['original']]);
  eq((await t.entries()).at(-1).label, { key: 'sync_video_new', title: 'Video', detail: 'walk.mp4' });
  const gif = await t.json('POST', `${ORG}/media`, { body: photoForm('media_gif', {}, new File(['gif'], 'a.gif', { type: 'image/gif' })) });
  eq(Object.keys(gif.data.media.variants), ['original']);
});

test('with a connection the upload and the list save reach the server as sent', async () => {
  const t = engine();
  t.server.on(`POST ${ORG}/media`, (request) => ({ status: 201, json: { ok: true, media: { id: request.body.id, from: 'server' } } }));
  t.server.on(`POST ${ORG}/projects/p1/photos`, (request) => ({ json: { ok: true, photos: request.body.photos, from: 'server' } }));
  const upload = await t.json('POST', `${ORG}/media`, { body: photoForm('media_1') });
  eq([upload.response.status, upload.data.media, upload.queued], [201, { id: 'media_1', from: 'server' }, null]);
  const saved = await t.json('POST', `${ORG}/projects/p1/photos`, { json: { photos: [ref('media_1')], remove: [] } });
  eq([saved.data.from, saved.queued], ['server', null]);
  const [sent, list] = t.server.sent('POST');
  eq([sent.body.id, sent.body.owner_id, sent.body.file.text, JSON.parse(sent.body.metadata).taken_at], ['media_1', 'p1', 'photo-bytes', '2026-11-11T14:58:00.000Z']);
  assert.match(sent.headers['idempotency-key'], /^fmo1-/);
  eq(list.body, { photos: [ref('media_1')], remove: [] });
  eq(await t.entries(), []);
});

test('the queued photo is in the project\'s photo list and media lists on every read, then the upload and the list save are sent in order, once', async () => {
  const t = engine();
  let photos = [ref('media_a', { label: 'First' })];
  let library = [{ id: 'media_a', owner: { type: 'project', id: 'p1', slot: 'photos' }, metadata: { project_id: 'p1' } }];
  // (The scripted server takes the route registered last that matches, so the one project comes after the list.)
  t.server.on(`GET ${ORG}/projects`, () => ({ json: { ok: true, documents: [projectDocument(photos).document, { id: 'p2', data: { photos: [] } }] } }));
  t.server.on(`GET ${ORG}/projects/p1`, () => ({ json: projectDocument(photos) }));
  t.server.on(`GET ${ORG}/media`, (request) => ({ json: { ok: true, media: request.query.includes('unassigned') ? [] : library } }));
  t.server.on('GET /v1/channels/organizations/org_1/feed/catalog', () => ({ json: { ok: true, media: library, unassigned_media: [] } }));
  // What the Photos tab, My Projects and the Feed read, once with a connection.
  for (const path of [`${ORG}/projects/p1`, `${ORG}/projects`, `${ORG}/media`, `${ORG}/media?project_id=p1`, `${ORG}/media?project_id=p2`, `${ORG}/media?unassigned=true`, '/v1/channels/organizations/org_1/feed/catalog']) await t.json('GET', path);

  t.server.down = true;
  const upload = await t.json('POST', `${ORG}/media`, { body: photoForm('media_b') });
  const record = upload.data.media;
  // The page's list save: every photo as the page has it, the new one last (projectMedia.upsertPhoto).
  const body = { photos: [{ id: 'top_down_thumbnail', src: '/v1/firstmeasure/projects/p1/thumbnail' }, ref('media_a', { label: 'First', thumb: '/thumb-a' }), ref('media_b', { label: 'Roof front.jpg' })], remove: [] };
  const save = await t.json('POST', `${ORG}/projects/p1/photos`, { json: body });
  assert.match(save.queued, /^fmo1-/);
  eq(save.data.photos.map((photo) => photo.id), ['top_down_thumbnail', 'media_a', 'media_b']);
  eq([save.data.ok, save.data.project_id, save.data.project_revision, save.data.thumbnail_photo_id, save.data.document.id, save.data.document.data.title], [true, 'p1', 4, 'media_a', 'p1', 'Oak St']);
  eq(save.data.document.data.photos.map((photo) => photo.id), ['top_down_thumbnail', 'media_a', 'media_b']);
  eq((await t.entries()).map((entry) => [entry.write, entry.kind, entry.scope, entry.records]), [['media.upload', 'upload', 'project:p1', ['media_b']], ['photos.save', 'patch', 'project:p1', ['media_b']]]);
  // One photo is one change to a person: the list save is quiet beside its upload.
  eq((await t.entries()).map((entry) => !!entry.quiet), [false, true]);
  const told = await t.FM.state.queue({ user: 'user_1', org: 'org_1' });
  eq([told.pending, told.shown], [2, 1]);

  // Every read shows it while it waits.
  const project = await t.json('GET', `${ORG}/projects/p1`);
  eq([project.response.headers.get('x-fm-offline'), project.data.document.data.photos.map((photo) => photo.id)], ['saved', ['top_down_thumbnail', 'media_a', 'media_b']]);
  eq((await t.json('GET', `${ORG}/projects`)).data.documents.map((document) => document.data.photos.length), [3, 0]);
  eq((await t.json('GET', `${ORG}/media`)).data.media.map((item) => item.id), ['media_a', 'media_b']);
  eq((await t.json('GET', `${ORG}/media?project_id=p1`)).data.media.at(-1), record);
  eq((await t.json('GET', `${ORG}/media?project_id=p2`)).data.media.map((item) => item.id), ['media_a'], 'the scripted list is not filtered; the queued photo is not added to another project\'s list');
  eq((await t.json('GET', `${ORG}/media?unassigned=true`)).data.media, []);
  const catalog = (await t.json('GET', '/v1/channels/organizations/org_1/feed/catalog')).data;
  eq([catalog.media.map((item) => item.id), catalog.unassigned_media], [['media_b', 'media_a'], []]);

  // Meanwhile someone in the office tagged the first photo and the satellite photo was saved into the project.
  photos = [ref('media_a', { label: 'First', tags: ['damage'] }), ref('media_sat', { source: 'satellite_top_down' })];
  t.server.down = false;
  t.server.on(`POST ${ORG}/media`, (request) => { library = [...library, { id: request.body.id, owner: { type: 'project', id: 'p1', slot: 'photos' }, metadata: { project_id: 'p1' }, variants: { original: {}, thumb_320: {} } }]; return { status: 201, json: { ok: true, media: library.at(-1) } }; });
  t.server.on(`POST ${ORG}/projects/p1/photos`, (request) => { photos = [...request.body.photos]; return { json: { ok: true, project_id: 'p1', photos } }; });
  const mark = t.server.log.length;
  eq(await t.FM.replay.run(), { sent: 2, blocked: null });
  const sent = t.server.log.slice(mark).filter((request) => request.method === 'POST' || request.path === `${ORG}/projects/p1`).map((request) => `${request.method} ${request.path}`);
  eq(sent.slice(0, 3), [`POST ${ORG}/media`, `GET ${ORG}/projects/p1`, `POST ${ORG}/projects/p1/photos`], 'the upload, then the list as the server has it now, then the save');
  const [posted] = t.server.sent(`POST ${ORG}/media`);
  eq([posted.body.id, posted.body.file, posted.headers['idempotency-key'], posted.headers['x-fm-offline-replay']], ['media_b', { name: 'Roof front.jpg', type: 'image/jpeg', text: 'photo-bytes' }, upload.queued, '1']);
  const [list] = t.server.sent(`POST ${ORG}/projects/p1/photos`);
  // Merged photo by photo: the office's tag is kept, the satellite photo is kept, the new photo is added. Nothing is removed.
  eq(list.body.remove, []);
  eq(list.body.photos.map((photo) => photo.id).sort(), ['media_a', 'media_b', 'media_sat', 'top_down_thumbnail']);
  eq(list.body.photos.find((photo) => photo.id === 'media_a'), ref('media_a', { label: 'First', tags: ['damage'], thumb: '/thumb-a' }));
  assert.match(list.headers['idempotency-key'], /^fmo1-/);
  assert.notEqual(list.headers['idempotency-key'], save.queued, 'a body the server has not seen has its own key');
  eq(t.of('synced').map((detail) => [detail.write, detail.status, detail.response.ok]), [['media.upload', 201, true], ['photos.save', 200, true]]);
  eq(await t.entries(), []);
  eq(await t.FM.db.list('blobs'), [], 'the original left the device');
  // The reads it touched were read again: the saved copies are the server's.
  t.server.down = true;
  eq((await t.json('GET', `${ORG}/projects/p1`)).data.document.data.photos.map((photo) => photo.id).sort(), ['media_a', 'media_b', 'media_sat', 'top_down_thumbnail']);
  eq((await t.json('GET', `${ORG}/media`)).data.media.map((item) => item.id), ['media_a', 'media_b']);
});

test('a list save the server already has is not sent again; trashing and removing are merged with what others did', async () => {
  const t = engine();
  let photos = [ref('media_a'), ref('media_b'), ref('media_c')];
  t.server.on(`GET ${ORG}/projects/p1`, () => ({ json: projectDocument(photos) }));
  t.server.on(`POST ${ORG}/projects/p1/photos`, (request) => { const gone = new Set(request.body.remove); photos = request.body.photos.filter((photo) => !gone.has(photo.id)); return { json: { ok: true, project_id: 'p1', photos } }; });
  await t.json('GET', `${ORG}/projects/p1`);
  t.server.down = true;
  // Trash the first photo and remove the second for good (the page sends the whole list and what it took out).
  const trash = await t.json('POST', `${ORG}/projects/p1/photos`, { json: { photos: [ref('media_a', { in_trash: true }), ref('media_b'), ref('media_c')], remove: [] } });
  const remove = await t.json('POST', `${ORG}/projects/p1/photos`, { json: { photos: [ref('media_a', { in_trash: true }), ref('media_c')], remove: ['media_b'] } });
  eq(remove.data.photos.map((photo) => [photo.id, !!photo.in_trash]), [['media_a', true], ['media_c', false]]);
  eq((await t.json('GET', `${ORG}/projects/p1`)).data.document.data.photos.map((photo) => photo.id), ['media_a', 'media_c']);
  eq((await t.entries()).map((entry) => entry.records), [[], ['media_b']]);
  // Meanwhile the office renamed the third photo and added a fourth.
  photos = [ref('media_a'), ref('media_b'), ref('media_c', { label: 'Chimney' }), ref('media_d')];
  t.server.down = false;
  eq((await t.FM.replay.run()).sent, 2);
  const [first, second] = t.server.sent(`POST ${ORG}/projects/p1/photos`);
  eq(first.body.photos.map((photo) => [photo.id, !!photo.in_trash, photo.label]), [['media_a', true, 'media_a'], ['media_b', false, 'media_b'], ['media_c', false, 'Chimney'], ['media_d', false, 'media_d']]);
  eq(first.body.remove, []);
  eq([second.body.photos.map((photo) => photo.id), second.body.remove], [['media_a', 'media_c', 'media_d'], ['media_b']]);
  eq(photos.map((photo) => [photo.id, photo.label]), [['media_a', 'media_a'], ['media_c', 'Chimney'], ['media_d', 'media_d']]);

  // The first answer was lost: the same save again finds the server already has it and sends nothing.
  t.server.down = true;
  await t.json('POST', `${ORG}/projects/p1/photos`, { json: { photos: photos.map((photo) => ({ ...photo })), remove: [] } });
  t.server.down = false;
  const mark = t.server.sent(`POST ${ORG}/projects/p1/photos`).length;
  eq((await t.FM.replay.run()).sent, 1);
  assert.equal(t.server.sent(`POST ${ORG}/projects/p1/photos`).length, mark, 'nothing to change, so no request');
  eq(t.of('synced').at(-1).response, null);
});

test('a photo with no project and its pairing wait in the person\'s scope, in order; the Feed shows both while they wait', async () => {
  const t = engine();
  let unassigned = [{ id: 'media_old', owner: { type: 'organization', id: 'org_1', slot: 'photos' }, metadata: {}, file_name: 'old.jpg', content_type: 'image/jpeg', variants: { original: {}, thumb_320: {} } }];
  t.server.on(`GET ${ORG}/media`, () => ({ json: { ok: true, media: unassigned } }));
  t.server.on('GET /v1/channels/organizations/org_1/feed/catalog', () => ({ json: { ok: true, media: [], unassigned_media: unassigned } }));
  t.server.on(`GET ${ORG}/projects/p1`, () => ({ json: projectDocument([ref('media_a')]) }));
  for (const path of [`${ORG}/media?unassigned=true`, '/v1/channels/organizations/org_1/feed/catalog', `${ORG}/projects/p1`]) await t.json('GET', path);
  t.server.down = true;
  const feedForm = (id) => photoForm(id, { owner_type: 'organization', owner_id: undefined, collection: undefined, scope: undefined, metadata: JSON.stringify({ source: 'feed_camera_capture', upload_batch_id: 'feed_1' }) });
  await t.json('POST', `${ORG}/media`, { body: feedForm('media_new') });
  eq((await t.json('GET', '/v1/channels/organizations/org_1/feed/catalog')).data.unassigned_media.map((item) => item.id), ['media_new', 'media_old']);
  eq((await t.json('GET', `${ORG}/media?unassigned=true`)).data.media.map((item) => item.id), ['media_old', 'media_new']);

  const assign = await t.json('POST', `${ORG}/media/assign`, { json: { project_id: 'p1', media_ids: ['media_new', 'media_old'] } });
  eq([assign.data.ok, assign.data.project_id, assign.data.assigned, assign.data.already_assigned], [true, 'p1', ['media_new', 'media_old'], []]);
  eq(assign.data.media.map((item) => [item.id, item.owner.type, item.owner.id, item.metadata.project_id, item.metadata.paired_from]), [['media_new', 'project', 'p1', 'p1', 'organization'], ['media_old', 'project', 'p1', 'p1', 'organization']]);
  eq(assign.data.photos.map((photo) => [photo.id, photo.kind]), [['media_a', 'media_reference'], ['media_new', 'media_reference'], ['media_old', 'media_reference']]);
  eq((await t.entries()).map((entry) => [entry.write, entry.kind, entry.scope]), [['media.upload', 'upload', 'user:user_1'], ['media.assign', 'action', 'user:user_1']]);
  // They left Unassigned and are the project's photos.
  const catalog = (await t.json('GET', '/v1/channels/organizations/org_1/feed/catalog')).data;
  eq([catalog.unassigned_media, catalog.media.map((item) => [item.id, item.owner.id])], [[], [['media_new', 'p1'], ['media_old', 'p1']]]);
  eq((await t.json('GET', `${ORG}/media?unassigned=true`)).data.media, []);
  eq((await t.json('GET', `${ORG}/projects/p1`)).data.document.data.photos.map((photo) => photo.id), ['media_a', 'media_new', 'media_old']);

  t.server.down = false;
  t.server.on(`POST ${ORG}/media`, (request) => ({ status: 201, json: { ok: true, media: { id: request.body.id } } }));
  t.server.on(`POST ${ORG}/media/assign`, (request) => { unassigned = []; return { json: { ok: true, project_id: 'p1', assigned: request.body.media_ids } }; });
  eq((await t.FM.replay.run()).sent, 2);
  eq(t.server.sent('POST').map((request) => request.path), [`${ORG}/media`, `${ORG}/media/assign`], 'the upload first, then the pairing');
  eq(t.server.sent(`POST ${ORG}/media/assign`)[0].body, { project_id: 'p1', media_ids: ['media_new', 'media_old'] });
});

test('a pinned project downloads its photo list and the thumbnail its grid shows for each photo', async () => {
  const t = engine();
  const photos = [ref('media_a', { variants: ['original', 'thumb_320'] }), ref('media_small', { variants: ['original'] }), ref('media_old'), ref('media_video', { media_type: 'video' }), { id: 'top_down_thumbnail', src: '/somewhere' }];
  const pinned = projectDocument(photos);
  pinned.document.data.contacts = [{ contact_id: 'contact_aaaa1111', name: 'Olive' }];
  t.server.on(`GET ${ORG}/projects/p1`, () => ({ json: pinned }));
  t.server.on(`GET ${ORG}/media`, () => ({ json: { ok: true, media: [{ id: 'media_a', kind: 'image', variants: { original: {}, thumb_320: {} } }, { id: 'media_owned', kind: 'image', variants: { original: {} } }, { id: 'media_clip', kind: 'video', variants: { original: {} } }] } }));
  t.server.on(`GET ${ORG}/media/`, () => ({ json: {} }));
  await t.FM.pins.pin(ME, 'p1');
  // (The notes contract, loaded beside this one, asks for the project's channel; that is its own test's.)
  const asked = [...new Set(t.server.sent('GET').map((request) => request.path + request.query).filter((url) => url.startsWith(ORG)))];
  eq(asked.slice(0, 2).sort(), [`${ORG}/media?project_id=p1`, `${ORG}/projects/p1`]);
  eq(asked.slice(2).sort(), [
    `${ORG}/media/media_a/file?variant=thumb_320`, `${ORG}/media/media_old/file?variant=thumb_320`,
    `${ORG}/media/media_owned/file?variant=original`, `${ORG}/media/media_small/file?variant=original`,
    // The files of the project's contact, as the contact window lists them.
    `${ORG}/media?contact_id=contact_aaaa1111`
  ]);
});

// ---------------------------------------------------------------------------------------------------------------
// Renaming and tagging (PATCH .../media/:id)
// ---------------------------------------------------------------------------------------------------------------

const mediaItem = (id, extra = {}) => ({ id, organization_id: 'org_1', owner: { type: 'project', id: 'p1', slot: 'photos' }, kind: 'image', content_type: 'image/jpeg', file_name: 'IMG_0001.jpg', variants: { original: { file_name: 'IMG_0001.jpg' }, thumb_320: { file_name: 'thumb_320.webp' } }, metadata: { project_id: 'p1' }, updated_at: '2026-11-10T10:00:00.000Z', ...extra });

/** A scripted media library that renames and tags the way the route does. */
function library(t, items) {
  const state = { items };
  const find = (request) => state.items.find((item) => request.path.endsWith('/' + item.id));
  t.server.on(`GET ${ORG}/media`, () => ({ json: { ok: true, media: state.items } }));
  t.server.on('GET /v1/channels/organizations/org_1/feed/catalog', () => ({ json: { ok: true, media: state.items, unassigned_media: [] } }));
  t.server.on(`GET ${ORG}/media/`, (request) => { const item = find(request); return item ? { json: { ok: true, media: item } } : { status: 404, json: { ok: false, error: 'not_found' } }; });
  t.server.on(`PATCH ${ORG}/media/`, (request) => {
    const item = find(request);
    if (!item) return { status: 404, json: { ok: false, error: 'not_found' } };
    if (request.body.name !== undefined) Object.assign(item, { label: request.body.name, file_name: request.body.name + '.jpg' });
    if (request.body.tags !== undefined) Object.assign(item, { tags: request.body.tags, metadata: { ...item.metadata, tags: request.body.tags } });
    item.updated_at = '2026-11-11T16:00:00.000Z';
    return { json: { ok: true, media: item } };
  });
  return state;
}

test('renaming and tagging a photo without a connection shows in every list at once, and the two edits do not conflict with each other', async () => {
  const t = engine();
  const lib = library(t, [mediaItem('media_aaaa1111'), mediaItem('media_bbbb2222', { file_name: 'IMG_0002.jpg' })]);
  // With a connection the request reaches the server as sent.
  const online = await t.json('PATCH', `${ORG}/media/media_bbbb2222`, { json: { tags: ['gutter'] } });
  eq([online.queued, online.data.media.tags, t.server.sent('PATCH').at(-1).body], [null, ['gutter'], { tags: ['gutter'] }]);
  for (const path of [`${ORG}/media`, `${ORG}/media?project_id=p1`, '/v1/channels/organizations/org_1/feed/catalog']) await t.json('GET', path);

  t.server.down = true;
  const renamed = await t.json('PATCH', `${ORG}/media/media_aaaa1111`, { json: { name: 'Front: elevation' } });
  assert.match(renamed.queued, /^fmo1-/);
  // The route's answer: the name it keeps, the file name with the old extension, each variant renamed with its own.
  eq([renamed.data.ok, renamed.data.media.label, renamed.data.media.file_name, renamed.data.media.metadata.label, renamed.data.media.variants.original.file_name, renamed.data.media.variants.thumb_320.file_name, renamed.data.media.updated_at],
    [true, 'Front- elevation', 'Front- elevation.jpg', 'Front- elevation', 'Front- elevation.jpg', 'Front- elevation.webp', '2026-11-11T15:00:00.000Z']);
  const tagged = await t.json('PATCH', `${ORG}/media/media_aaaa1111`, { json: { tags: ['#Damage', 'north side', 'damage'] } });
  eq([tagged.data.media.tags, tagged.data.media.metadata.tags, tagged.data.media.label], [['damage', 'north_side'], ['damage', 'north_side'], 'Front- elevation'], 'the second edit starts from the first');
  eq((await t.entries()).map((entry) => [entry.write, entry.kind, entry.scope, entry.records, entry.label.key, entry.label.detail, entry.after]), [
    ['media.update', 'patch', 'media:media_aaaa1111', ['media_aaaa1111'], 'sync_photo_renamed', 'Front- elevation', []],
    ['media.update', 'patch', 'media:media_aaaa1111', ['media_aaaa1111'], 'sync_photo_tagged', '#damage #north_side', []]
  ]);
  // Every list that shows the photo, on any later load.
  for (const path of [`${ORG}/media`, `${ORG}/media?project_id=p1`]) {
    const shown = (await t.json('GET', path)).data.media.map((item) => [item.id, item.label || '', item.tags || []]);
    eq(shown, [['media_aaaa1111', 'Front- elevation', ['damage', 'north_side']], ['media_bbbb2222', '', ['gutter']]], path);
  }
  eq((await t.json('GET', '/v1/channels/organizations/org_1/feed/catalog')).data.media[0].label, 'Front- elevation');
  // An empty name, or a body with neither, is not a change this contract knows.
  eq((await t.json('PATCH', `${ORG}/media/media_aaaa1111`, { json: { name: '  ' } })).data.error, 'offline_unavailable');

  // Sent one after the other; each sends only its own field.
  t.server.down = false;
  eq((await t.FM.replay.run()).sent, 2);
  eq(t.server.sent('PATCH').slice(1).map((request) => request.body), [{ name: 'Front- elevation' }, { tags: ['damage', 'north_side'] }]);
  eq(t.of('conflict'), []);
  eq([lib.items[0].label, lib.items[0].tags], ['Front- elevation', ['damage', 'north_side']]);
  eq(await t.entries(), []);
});

test('an edit the server also changed is merged per field and per tag; only the same name changed on both sides asks', async () => {
  const t = engine();
  const lib = library(t, [mediaItem('media_aaaa1111', { tags: ['roof'], metadata: { project_id: 'p1', tags: ['roof'] } })]);
  await t.json('GET', `${ORG}/media`);
  t.server.down = true;
  await t.json('PATCH', `${ORG}/media/media_aaaa1111`, { json: { tags: ['roof', 'damage'] } });
  // Meanwhile the office renamed it and added a tag of its own.
  Object.assign(lib.items[0], { label: 'Ridge', file_name: 'Ridge.jpg', tags: ['roof', 'ridge'] });
  t.server.down = false;
  eq((await t.FM.replay.run()).sent, 1);
  eq(t.server.sent('PATCH').at(-1).body, { tags: ['roof', 'ridge', 'damage'] }, 'both tags are kept, and the name is not sent');
  eq(lib.items[0].label, 'Ridge');

  // A tag taken off here while the office added another: the removal and the addition both hold.
  await t.json('GET', `${ORG}/media`);
  t.server.down = true;
  await t.json('PATCH', `${ORG}/media/media_aaaa1111`, { json: { tags: ['ridge', 'damage'] } });
  lib.items[0].tags = ['roof', 'ridge', 'damage', 'chimney'];
  t.server.down = false;
  await t.FM.replay.run();
  eq(t.server.sent('PATCH').at(-1).body, { tags: ['ridge', 'damage', 'chimney'] });

  // The first answer was lost: sent again, the server already has it and nothing is sent.
  await t.json('GET', `${ORG}/media`);
  t.server.down = true;
  await t.json('PATCH', `${ORG}/media/media_aaaa1111`, { json: { tags: ['ridge', 'damage', 'chimney'] } });
  t.server.down = false;
  const before = t.server.sent('PATCH').length;
  eq((await t.FM.replay.run()).sent, 1);
  assert.equal(t.server.sent('PATCH').length, before);

  // The same field on both sides: the name asks, and the person's choice is sent.
  await t.json('GET', `${ORG}/media`);
  t.server.down = true;
  await t.json('PATCH', `${ORG}/media/media_aaaa1111`, { json: { name: 'Ridge cap' } });
  Object.assign(lib.items[0], { label: 'Ridge vent', file_name: 'Ridge vent.jpg' });
  t.server.down = false;
  await t.FM.replay.run();
  const [entry] = await t.entries();
  eq([entry.state, entry.conflict.fields.map((field) => [field.path, field.base, field.mine, field.theirs])], ['conflict', [['name', 'Ridge', 'Ridge cap', 'Ridge vent']]]);
  await t.FM.queue.resolve(entry.id, { name: 'mine' });
  await t.FM.replay.run();
  eq([t.server.sent('PATCH').at(-1).body, await t.entries()], [{ name: 'Ridge cap' }, []]);
});

test('a photo that still waits to upload is renamed and tagged on the device, and the edits are sent after its upload', async () => {
  const t = engine();
  const lib = library(t, []);
  t.server.on(`GET ${ORG}/projects/p1`, () => ({ json: projectDocument([]) }));
  for (const path of [`${ORG}/media`, `${ORG}/projects/p1`]) await t.json('GET', path);
  t.server.down = true;
  await t.json('POST', `${ORG}/media`, { body: photoForm('media_00112233aabbccdd') });
  await t.json('POST', `${ORG}/projects/p1/photos`, { json: { photos: [ref('media_00112233aabbccdd')], remove: [] } });
  // The record's own read is answered from the waiting upload.
  const own = await t.json('GET', `${ORG}/media/media_00112233aabbccdd`);
  eq([own.response.headers.get('x-fm-offline'), own.data.media.file_name], ['queued', 'Roof-front.jpg']);
  const renamed = await t.json('PATCH', `${ORG}/media/media_00112233aabbccdd`, { json: { name: 'Front elevation' } });
  eq([renamed.data.media.label, renamed.data.media.file_name, renamed.data.media.owner, renamed.data.media.metadata.taken_at], ['Front elevation', 'Front elevation.jpg', { type: 'project', id: 'p1', slot: 'photos' }, '2026-11-11T14:58:00.000Z']);
  await t.json('PATCH', `${ORG}/media/media_00112233aabbccdd`, { json: { tags: ['damage'] } });
  const [upload, , rename, tag] = await t.entries();
  eq([rename.scope, rename.after, tag.after], ['media:media_00112233aabbccdd', [upload.id], [upload.id]], 'held behind the upload, which is in the scope of its project');
  eq((await t.json('GET', `${ORG}/media`)).data.media.map((item) => [item.id, item.label, item.tags]), [['media_00112233aabbccdd', 'Front elevation', ['damage']]]);
  eq((await t.json('GET', `${ORG}/media/media_00112233aabbccdd`)).data.media.label, 'Front elevation');

  // With a connection again but the upload still waiting, a further edit is queued behind it, not sent ahead.
  t.server.down = false;
  t.server.on(`POST ${ORG}/media`, (request) => { lib.items.push(mediaItem(request.body.id, { file_name: 'Roof-front.jpg' })); return { status: 201, json: { ok: true, media: lib.items.at(-1) } }; });
  t.server.on(`POST ${ORG}/projects/p1/photos`, (request) => ({ json: { ok: true, project_id: 'p1', photos: request.body.photos } }));
  const mark = t.server.log.length;
  const again = await t.json('PATCH', `${ORG}/media/media_00112233aabbccdd`, { json: { tags: ['damage', 'front'] } });
  assert.match(again.queued, /^fmo1-/);
  eq(t.server.log.slice(mark).filter((request) => request.method === 'PATCH'), []);

  await t.FM.replay.run();
  const order = t.server.log.slice(mark).filter((request) => request.method !== 'GET').map((request) => `${request.method} ${request.path.replace(ORG, '')}`);
  eq(order.indexOf('POST /media') < order.indexOf('PATCH /media/media_00112233aabbccdd'), true, order.join(', '));
  eq(t.server.sent('PATCH').map((request) => request.body), [{ name: 'Front elevation' }, { tags: ['damage'] }, { tags: ['damage', 'front'] }]);
  eq([lib.items[0].label, lib.items[0].tags, await t.entries()], ['Front elevation', ['damage', 'front'], []]);
});

// ---------------------------------------------------------------------------------------------------------------
// Uploads of other apps: a contact's files, a project's documents list, checklist evidence, a note's files
// ---------------------------------------------------------------------------------------------------------------

const formOf = (fields, file, name = 'file') => { const form = new FormData(); form.append(name, file); for (const [key, value] of Object.entries(fields)) if (value !== undefined) form.append(key, value); return form; };
const CHANNELS = '/v1/channels/organizations/org_1';
const CHECKLISTS = '/v1/workforce/organizations/org_1/crew/projects/p1/checklists';

test('a contact\'s picture and files wait in the contact\'s scope and show in that contact\'s list only', async () => {
  const t = engine();
  t.server.on(`GET ${ORG}/media`, () => ({ json: { ok: true, media: [] } }));
  for (const path of [`${ORG}/media?contact_id=contact_aaaa1111`, `${ORG}/media?contact_id=contact_bbbb2222`, `${ORG}/media?project_id=p1`]) await t.json('GET', path);
  t.server.down = true;
  const contactForm = (id, slot, file) => formOf({ id, owner_type: 'contact', owner_id: 'contact_aaaa1111', slot, collection: 'contacts', scope: 'contact', metadata: JSON.stringify({ contact_draft: false }) }, file);
  const picture = await t.json('POST', `${ORG}/media`, { body: contactForm('media_1111111111111111', 'profile', new File(['png-bytes'], 'profile-photo.png', { type: 'image/png' })) });
  eq([picture.response.status, picture.data.media.owner, picture.data.media.scope, picture.data.media.collection, picture.data.media.metadata], [200, { type: 'contact', id: 'contact_aaaa1111', slot: 'profile' }, 'contact', 'contacts', { contact_draft: false, uploaded_by_user_id: 'user_1' }]);
  const doc = await t.json('POST', `${ORG}/media`, { body: contactForm('media_2222222222222222', 'document', new File(['pdf-bytes'], 'Warranty.pdf', { type: 'application/pdf' })) });
  eq([doc.data.media.kind, Object.keys(doc.data.media.variants)], ['pdf', ['original']]);
  eq((await t.entries()).map((entry) => [entry.write, entry.kind, entry.scope, entry.records, entry.label.key, entry.label.detail]), [
    ['media.upload', 'upload', 'contact:contact_aaaa1111', ['media_1111111111111111'], 'sync_contact_picture', ''],
    ['media.upload', 'upload', 'contact:contact_aaaa1111', ['media_2222222222222222'], 'sync_contact_file', 'Warranty.pdf']
  ]);
  // A picture the server would refuse is not kept to be refused later.
  eq((await t.json('POST', `${ORG}/media`, { body: contactForm('media_3333333333333333', 'profile', new File(['x'], 'notes.pdf', { type: 'application/pdf' })) })).data.error, 'offline_unavailable');
  // The contact window's list has both; another contact's list and a project's list have neither.
  eq((await t.json('GET', `${ORG}/media?contact_id=contact_aaaa1111`)).data.media.map((item) => item.id), ['media_1111111111111111', 'media_2222222222222222']);
  eq((await t.json('GET', `${ORG}/media?contact_id=contact_bbbb2222`)).data.media, []);
  eq((await t.json('GET', `${ORG}/media?project_id=p1`)).data.media, []);
  // The picture is shown from the device.
  const file = await t.request('GET', `${ORG}/media/media_1111111111111111/file?variant=original`);
  eq([file.status, await file.text()], [200, 'png-bytes']);

  t.server.down = false;
  t.server.on(`POST ${ORG}/media`, (request) => ({ status: 201, json: { ok: true, media: { id: request.body.id } } }));
  eq((await t.FM.replay.run()).sent, 2);
  eq(t.server.sent(`POST ${ORG}/media`).map((request) => [request.body.id, request.body.owner_type, request.body.owner_id, request.body.slot, request.body.file.name]), [
    ['media_1111111111111111', 'contact', 'contact_aaaa1111', 'profile', 'profile-photo.png'], ['media_2222222222222222', 'contact', 'contact_aaaa1111', 'document', 'Warranty.pdf']
  ]);
  eq(await t.entries(), []);
});

test('a file added to a project\'s documents list is in the list at once and arrives once', async () => {
  const t = engine();
  const existing = { id: 'media_old', document_id: 'media_old', media_id: 'media_old', title: 'Permit' };
  const special = { id: 'roof_report_pdf', title: 'Roof Measurement Report', special: true };
  let server = { ok: true, project_id: 'p1', documents: [special, existing], special_documents: [special], uploaded_documents: [existing] };
  t.server.on(`GET ${ORG}/projects/p1`, () => ({ json: { ok: true, document: { id: 'p1', revision: 2, data: { id: 'p1', documents: [existing] } } } }));
  t.server.on(`GET ${ORG}/projects/p1/documents`, () => ({ json: server }));
  t.server.on(`GET ${ORG}/media`, () => ({ json: { ok: true, media: [] } }));
  for (const path of [`${ORG}/projects/p1`, `${ORG}/projects/p1/documents`, `${ORG}/media`]) await t.json('GET', path);
  const form = () => formOf({ metadata: JSON.stringify({ title: 'Signed contract.pdf', label: 'Signed contract.pdf', document_type: 'document', source: 'project_document_upload' }), id: 'media_4444444444444444' }, new File(['pdf-bytes'], 'Signed contract.pdf', { type: 'application/pdf' }));

  t.server.down = true;
  // Without the id the page makes, the server would name the file: that cannot wait.
  eq((await t.json('POST', `${ORG}/projects/p1/documents`, { body: formOf({ metadata: '{}' }, new File(['x'], 'a.pdf', { type: 'application/pdf' })) })).data.error, 'offline_unavailable');
  const queued = await t.json('POST', `${ORG}/projects/p1/documents`, { body: form() });
  assert.match(queued.queued, /^fmo1-/);
  const { document, media } = queued.data;
  eq([document.id, document.document_id, document.media_id, document.kind, document.title, document.label, document.document_type, document.type, document.type_label, document.icon, document.source, document.file_name, document.content_type, document.size_bytes, document.special, document.interactive],
    ['media_4444444444444444', 'media_4444444444444444', 'media_4444444444444444', 'media_reference', 'Signed contract.pdf', 'Signed contract.pdf', 'document', 'document', 'Document', 'fa-file-lines', 'project_document_upload', 'Signed-contract.pdf', 'application/pdf', 9, false, true]);
  eq([media.owner, media.scope, media.collection, media.kind, Object.keys(media.variants), media.metadata.field, media.metadata.document_id, media.metadata.uploaded_by_user_id, 'project_id' in media.metadata], [{ type: 'project', id: 'p1', slot: 'documents' }, 'documents', 'projects', 'pdf', ['original'], 'documents', 'p1', 'user_1', false]);
  eq([queued.data.project_id, queued.data.documents.map((item) => item.id), queued.data.special_documents.map((item) => item.id), queued.data.uploaded_documents.map((item) => item.id)], ['p1', ['roof_report_pdf', 'media_old', 'media_4444444444444444'], ['roof_report_pdf'], ['media_old', 'media_4444444444444444']]);
  eq((await t.entries()).map((entry) => [entry.write, entry.kind, entry.scope, entry.records, entry.label]), [['documents.upload', 'upload', 'project:p1', ['media_4444444444444444'], { key: 'sync_project_document', title: 'Project document', detail: 'Signed contract.pdf' }]]);
  // Every read that lists it, on any later load, and the file itself.
  const listed = (await t.json('GET', `${ORG}/projects/p1/documents`)).data;
  eq([listed.documents.map((item) => item.id), listed.uploaded_documents.map((item) => item.id)], [['roof_report_pdf', 'media_old', 'media_4444444444444444'], ['media_old', 'media_4444444444444444']]);
  eq((await t.json('GET', `${ORG}/projects/p1`)).data.document.data.documents.map((item) => item.id), ['media_old', 'media_4444444444444444']);
  eq((await t.json('GET', `${ORG}/media`)).data.media.map((item) => item.id), ['media_4444444444444444']);
  eq(await (await t.request('GET', `${ORG}/media/media_4444444444444444/file?variant=original`)).text(), 'pdf-bytes');

  t.server.down = false;
  t.server.on(`POST ${ORG}/projects/p1/documents`, (request) => { server = { ...server, documents: [...server.documents, { id: request.body.id }], uploaded_documents: [...server.uploaded_documents, { id: request.body.id }] }; return { status: 201, json: { ok: true, document: { id: request.body.id }, ...server } }; });
  eq((await t.FM.replay.run()).sent, 1);
  const [sent] = t.server.sent(`POST ${ORG}/projects/p1/documents`);
  eq([sent.body.id, sent.body.file, JSON.parse(sent.body.metadata).title, sent.headers['idempotency-key']], ['media_4444444444444444', { name: 'Signed contract.pdf', type: 'application/pdf', text: 'pdf-bytes' }, 'Signed contract.pdf', queued.queued]);
  eq([await t.entries(), await t.FM.db.list('blobs')], [[], []]);
  eq((await t.json('GET', `${ORG}/projects/p1/documents`)).data.uploaded_documents.map((item) => item.id), ['media_old', 'media_4444444444444444'], 'listed once');
});

test('checklist evidence added without a connection is on its item at once and arrives once', async () => {
  const t = engine();
  let checklists = [{ id: 'cl_1', items: [{ id: 'item_1', checklist_id: 'cl_1', title: 'Photograph the deck', metadata: { required_attachments: [{ id: 'req_1', kind: 'photo' }], attachments: [] } }, { id: 'item_2', checklist_id: 'cl_1', metadata: {} }] }];
  t.server.on(`GET ${CHECKLISTS}`, () => ({ json: { ok: true, checklists } }));
  t.server.on(`GET ${ORG}/media`, () => ({ json: { ok: true, media: [] } }));
  for (const path of [CHECKLISTS, `${ORG}/media`]) await t.json('GET', path);
  t.server.down = true;
  const target = `${CHECKLISTS}/cl_1/items/item_1/attachments`;
  eq((await t.json('POST', target, { body: formOf({ requirement_id: 'req_1' }, new File(['x'], 'deck.jpg', { type: 'image/jpeg' })) })).data.error, 'offline_unavailable', 'without the media id the page makes');
  const queued = await t.json('POST', target, { body: formOf({ requirement_id: 'req_1', media_id: 'media_5555555555555555' }, new File(['deck-bytes'], 'Deck photo.jpg', { type: 'image/jpeg' })) });
  eq(queued.data.attachment, { media_id: 'media_5555555555555555', file_name: 'Deck-photo.jpg', content_type: 'image/jpeg', size_bytes: 10, kind: 'photo', requirement_id: 'req_1' });
  eq([queued.data.ok, queued.data.item.id, queued.data.item.title, queued.data.item.metadata.required_attachments, queued.data.item.metadata.attachments], [true, 'item_1', 'Photograph the deck', [{ id: 'req_1', kind: 'photo' }], [{ ...queued.data.attachment, attached_by_user_id: 'user_1', attached_at: '2026-11-11T15:00:00.000Z' }]]);
  const pdf = await t.json('POST', `${CHECKLISTS}/cl_1/items/item_2/attachments`, { body: formOf({ media_id: 'media_6666666666666666' }, new File(['pdf'], 'permit.pdf', { type: 'application/pdf' })) });
  eq([pdf.data.attachment.kind, pdf.data.attachment.requirement_id], ['document', '']);
  eq((await t.entries()).map((entry) => [entry.write, entry.kind, entry.scope, entry.records, entry.label.key]), [['checklist.evidence', 'upload', 'project:p1', ['media_5555555555555555'], 'sync_checklist_photo'], ['checklist.evidence', 'upload', 'project:p1', ['media_6666666666666666'], 'sync_checklist_file']]);
  // The checklist as any later load reads it; a photo is also one of the project's photos, as the route makes it.
  const shown = (await t.json('GET', CHECKLISTS)).data.checklists[0].items.map((item) => (item.metadata.attachments || []).map((attachment) => attachment.media_id));
  eq(shown, [['media_5555555555555555'], ['media_6666666666666666']]);
  const records = (await t.json('GET', `${ORG}/media`)).data.media.map((item) => [item.id, item.owner, item.metadata.source, item.metadata.checklist_item_id]);
  eq(records, [['media_5555555555555555', { type: 'project', id: 'p1', slot: 'photos' }, 'checklist_evidence', 'item_1'], ['media_6666666666666666', { type: 'project', id: 'p1', slot: 'checklist_evidence' }, 'checklist_evidence', 'item_2']]);
  eq(await (await t.request('GET', `${ORG}/media/media_5555555555555555/file?variant=thumb_320`)).text(), 'deck-bytes');

  t.server.down = false;
  t.server.on(`POST ${CHECKLISTS}/cl_1/items/`, (request) => ({ json: { ok: true, attachment: { media_id: request.body.media_id }, item: {} } }));
  eq((await t.FM.replay.run()).sent, 2);
  eq(t.server.sent(`POST ${CHECKLISTS}`).map((request) => [request.path.split('/').at(-2), request.body.media_id, request.body.requirement_id, request.body.file.name]), [['item_1', 'media_5555555555555555', 'req_1', 'Deck photo.jpg'], ['item_2', 'media_6666666666666666', undefined, 'permit.pdf']]);
  eq(await t.entries(), []);
});

test('a note\'s file waits on the device and its note is sent after it; a note whose file the device does not hold is not queued', async () => {
  const t = engine();
  const notesUrl = `${CHANNELS}/channels/chan_1/messages?limit=200&view=notes`;
  let messages = [];
  t.server.on(`GET ${CHANNELS}/channels/chan_1/messages`, () => ({ json: { ok: true, channel: { id: 'chan_1', project_id: 'p1' }, messages } }));
  await t.json('GET', notesUrl);
  t.server.down = true;
  const upload = (fields, file = new File(['photo-bytes'], 'Leak.jpg', { type: 'image/jpeg' })) => t.json('POST', `${CHANNELS}/uploads`, { body: formOf({ channel_id: 'chan_1', ...fields }, file) });
  // An upload the server would name (another caller of the route), and one for a project made on this device.
  eq((await upload({})).data.error, 'offline_unavailable');
  eq((await upload({ channel_id: 'chan_local_p9', attachment_id: 'att_00000000000000000000000000000001', media_id: 'media_7777777777777777' })).data.error, 'offline_unavailable');
  const file = await upload({ attachment_id: 'att_00000000000000000000000000000001', media_id: 'media_7777777777777777' });
  eq(file.data, { ok: true, attachment: { id: 'att_00000000000000000000000000000001', organization_id: 'org_1', channel_id: 'chan_1', message_id: null, media_id: 'media_7777777777777777', file_name: 'Leak.jpg', content_type: 'image/jpeg', size_bytes: 11, uploaded_by: 'user_1', created_at: '2026-11-11T15:00:00.000Z' } });
  eq(await (await t.request('GET', `${ORG}/media/media_7777777777777777/file`)).text(), 'photo-bytes', 'the composer and the note show the file from the device');
  const body = (extra) => ({ text: 'Leak by the chimney', project_note: true, pin: false, client_msg_id: 'note_aaaa1111', audience: [], tags: [], mention_users: [], attachment_ids: ['att_00000000000000000000000000000001'], metadata: { media_upload: { version: 1 } }, ...extra });
  // A file the server already has is named by an id this device knows nothing of.
  eq((await t.json('POST', `${CHANNELS}/channels/chan_1/messages`, { json: body({ attachment_ids: ['att_ffffffffffffffffffffffffffffffff'], client_msg_id: 'note_bbbb2222' }) })).data.error, 'offline_unavailable');
  const note = await t.json('POST', `${CHANNELS}/channels/chan_1/messages`, { json: body() });
  assert.match(note.queued, /^fmo1-/);
  eq(note.data.message.attachments, [{ ...file.data.attachment, message_id: 'note_aaaa1111' }]);
  const [first, second] = await t.entries();
  eq([[first.write, first.kind, first.scope, first.records, first.media, first.label], [second.write, second.scope, second.after]], [
    ['note.upload', 'upload', 'attachment:att_00000000000000000000000000000001', ['att_00000000000000000000000000000001', 'media_7777777777777777'], [{ id: 'media_7777777777777777', blob: 0 }], { key: 'sync_note_file', title: 'Note attachment', detail: 'Leak.jpg' }],
    ['note.post', 'project:p1', [first.id]]
  ]);
  eq((await t.json('GET', notesUrl)).data.messages.map((message) => [message.text, message.attachments.map((item) => item.media_id)]), [['Leak by the chimney', ['media_7777777777777777']]]);

  // The file is refused once: the note is not sent ahead of it.
  t.server.down = false;
  let refuse = true;
  t.server.on(`POST ${CHANNELS}/uploads`, (request) => (refuse ? { status: 413, json: { ok: false, error: 'too_large' } } : { status: 201, json: { ok: true, attachment: { id: request.body.attachment_id, media_id: request.body.media_id } } }));
  t.server.on(`POST ${CHANNELS}/channels/chan_1/messages`, (request) => { messages = [{ id: 'msg_1', text: request.body.text, attachments: request.body.attachment_ids.map((id) => ({ id, media_id: 'media_7777777777777777' })) }]; return { status: 201, json: { ok: true, message: messages[0] } }; });
  await t.FM.replay.run();
  eq([(await t.entries()).map((entry) => [entry.write, entry.state]), t.server.sent(`POST ${CHANNELS}/channels/chan_1/messages`).length], [[['note.upload', 'failed'], ['note.post', 'waiting']], 0]);
  refuse = false;
  await t.FM.queue.retry(first.id);
  await t.FM.replay.run();
  eq(t.server.sent('POST').slice(-2).map((request) => request.path.replace(CHANNELS, '')), ['/uploads', '/channels/chan_1/messages'], 'the file, then the note');
  const sent = t.server.sent(`POST ${CHANNELS}/uploads`).at(-1);
  eq([sent.body.attachment_id, sent.body.media_id, sent.body.channel_id, sent.body.file.text], ['att_00000000000000000000000000000001', 'media_7777777777777777', 'chan_1', 'photo-bytes']);
  eq(t.server.sent(`POST ${CHANNELS}/channels/chan_1/messages`)[0].body.attachment_ids, ['att_00000000000000000000000000000001']);
  eq([await t.entries(), await t.FM.db.list('blobs')], [[], []]);
});
