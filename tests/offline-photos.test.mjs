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
  eq(entry.label, { title: 'Photo', detail: 'Roof front.jpg' });
  eq(entry.media, [{ id: 'media_00112233aabbccdd', blob: 0 }]);
  // The grid's thumbnail URL and the viewer's file URL are answered from the stored file.
  for (const variant of ['?variant=thumb_320', '?variant=original']) {
    const file = await t.request('GET', `${ORG}/media/media_00112233aabbccdd/file${variant}`);
    eq([file.status, file.headers.get('x-fm-offline'), await file.text()], [200, 'queued', 'photo-bytes']);
  }
});

test('only project photos and photos with no project are queued; a slot upload, another owner and an upload without an id are not', async () => {
  const t = engine();
  t.server.down = true;
  const refused = async (fields) => { const answer = await t.json('POST', `${ORG}/media`, { body: photoForm('media_1', fields) }); return [answer.response.status, answer.data.error]; };
  eq(await refused({ replace_slot: 'true' }), [503, 'offline_unavailable'], 'a logo keeps the id its slot gives it');
  eq(await refused({ id: undefined }), [503, 'offline_unavailable']);
  eq(await refused({ owner_type: 'contact', owner_id: 'contact_1', slot: 'profile' }), [503, 'offline_unavailable']);
  eq(await refused({ slot: 'documents' }), [503, 'offline_unavailable'], 'another app\'s upload is followed by that app\'s own write');
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
  eq((await t.entries()).at(-1).label, { title: 'Video', detail: 'walk.mp4' });
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
  const body = { photos: [ref('media_a', { label: 'First', thumb: '/thumb-a' }), ref('media_b', { label: 'Roof front.jpg' })], remove: [] };
  const save = await t.json('POST', `${ORG}/projects/p1/photos`, { json: body });
  assert.match(save.queued, /^fmo1-/);
  eq(save.data.photos.map((photo) => photo.id), ['media_a', 'media_b']);
  eq([save.data.ok, save.data.project_id, save.data.project_revision, save.data.thumbnail_photo_id, save.data.document.id, save.data.document.data.title], [true, 'p1', 4, 'media_a', 'p1', 'Oak St']);
  eq(save.data.document.data.photos.map((photo) => photo.id), ['media_a', 'media_b']);
  eq((await t.entries()).map((entry) => [entry.write, entry.kind, entry.scope, entry.records]), [['media.upload', 'upload', 'project:p1', ['media_b']], ['photos.save', 'patch', 'project:p1', ['media_b']]]);

  // Every read shows it while it waits.
  const project = await t.json('GET', `${ORG}/projects/p1`);
  eq([project.response.headers.get('x-fm-offline'), project.data.document.data.photos.map((photo) => photo.id)], ['saved', ['media_a', 'media_b']]);
  eq((await t.json('GET', `${ORG}/projects`)).data.documents.map((document) => document.data.photos.length), [2, 0]);
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
  eq(list.body.photos.map((photo) => photo.id).sort(), ['media_a', 'media_b', 'media_sat']);
  eq(list.body.photos.find((photo) => photo.id === 'media_a'), ref('media_a', { label: 'First', tags: ['damage'], thumb: '/thumb-a' }));
  assert.match(list.headers['idempotency-key'], /^fmo1-/);
  assert.notEqual(list.headers['idempotency-key'], save.queued, 'a body the server has not seen has its own key');
  eq(t.of('synced').map((detail) => [detail.write, detail.status, detail.response.ok]), [['media.upload', 201, true], ['photos.save', 200, true]]);
  eq(await t.entries(), []);
  eq(await t.FM.db.list('blobs'), [], 'the original left the device');
  // The reads it touched were read again: the saved copies are the server's.
  t.server.down = true;
  eq((await t.json('GET', `${ORG}/projects/p1`)).data.document.data.photos.map((photo) => photo.id).sort(), ['media_a', 'media_b', 'media_sat']);
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
  t.server.on(`GET ${ORG}/projects/p1`, () => ({ json: projectDocument(photos) }));
  t.server.on(`GET ${ORG}/media`, () => ({ json: { ok: true, media: [{ id: 'media_a', kind: 'image', variants: { original: {}, thumb_320: {} } }, { id: 'media_owned', kind: 'image', variants: { original: {} } }, { id: 'media_clip', kind: 'video', variants: { original: {} } }] } }));
  t.server.on(`GET ${ORG}/media/`, () => ({ json: {} }));
  await t.FM.pins.pin(ME, 'p1');
  const asked = t.server.sent('GET').map((request) => request.path + request.query);
  eq(asked.slice(0, 2).sort(), [`${ORG}/media?project_id=p1`, `${ORG}/projects/p1`]);
  eq(asked.slice(2).sort(), [
    `${ORG}/media/media_a/file?variant=thumb_320`, `${ORG}/media/media_old/file?variant=thumb_320`,
    `${ORG}/media/media_owned/file?variant=original`, `${ORG}/media/media_small/file?variant=original`
  ]);
});
