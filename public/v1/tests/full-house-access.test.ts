import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createHmac } from 'node:crypto';
import test from 'node:test';

test('full-house submission, isolation, persistence and revocation', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'full-house-test-'));
  Object.assign(process.env, {
    FIRSTMATE_ENV: 'test', FIRSTMEASURE_DATABASE_MODE: process.env.TEST_POSTGRES_URL ? 'postgres' : 'sqlite',
    FIRSTMEASURE_STORAGE_ROOT: path.join(root, 'projects'), FIRSTMEASURE_INDEX_DB_PATH: path.join(root, 'index.sqlite'),
    INTERNAL_STORAGE_ROOT: path.join(root, 'internal'), PLATFORM_STORAGE_ROOT: path.join(root, 'platform'),
    FIRSTMEASURE_JOB_WORKERS: '0', FIRSTMEASURE_INTERNAL_API_SECRET: 'full-house-test-secret',
    FIRSTMEASURE_FULL_HOUSE_EMAILS: 'owner@example.test', FIRSTMEASURE_FULL_HOUSE_ENABLED: '0',
    ...(process.env.TEST_POSTGRES_URL ? { DATABASE_URL: process.env.TEST_POSTGRES_URL, DATABASE_ADMIN_URL: process.env.TEST_POSTGRES_URL, POSTGRES_AUTO_MIGRATE: 'true', POSTGRES_ALLOW_EMPTY_IMPORT: 'true' } : {})
  });
  const { default: Fastify } = await import('fastify');
  const { registerFirstMeasureApi } = await import('../firstmeasure/api.js');
  const { saveInternalUser } = await import('../internal/storage.js');
  const storage = await import('../firstmeasure/storage.js');
  const index = await import('../firstmeasure/project_index.js');
  for (const email of ['owner@example.test', 'technician@example.test']) await saveInternalUser({ email, name: email, status: 'active', role: 'admin' });
  const app = Fastify();
  await app.register(registerFirstMeasureApi, { prefix: '/v1/firstmeasure' });
  // Exercise a non-FirstMeasure endpoint through the shared storage boundary too.
  const { installFullHouseAccess } = await import('../firstmeasure/full_house.js');
  installFullHouseAccess(app);
  app.get('/other/project/:id', request => storage.readManifest(String((request.params as { id: string }).id)));
  const signed = (email = 'owner@example.test', time = Math.floor(Date.now() / 1000)) => ({
    'x-full-house-user': email, 'x-full-house-time': String(time),
    'x-full-house-signature': createHmac('sha256', 'full-house-test-secret').update(`${email}\n${time}`).digest('hex')
  });
  const url = '/v1/firstmeasure/internal-exteriors/projects';
  const payload = { address: '100 Internal Test Way', measurement_scope: 'full_house', process_imagery: false };
  try {
    assert.equal((await app.inject({ method: 'POST', url, headers: signed(), payload })).statusCode, 404, 'off by default');
    process.env.FIRSTMEASURE_FULL_HOUSE_ENABLED = '1';
    for (const headers of [{}, { 'x-internal-user-email': 'owner@example.test' }, { 'x-firstmeasure-internal': 'full-house-test-secret' }, signed('technician@example.test'), signed('owner@example.test', 1)]) {
      assert.equal((await app.inject({ method: 'POST', url, headers, payload: { ...payload, actor: { email: 'owner@example.test' } } })).statusCode, 404);
    }
    assert.equal((await app.inject({ method: 'POST', url, headers: signed(), payload: { address: payload.address } })).statusCode, 400);
    const create = await app.inject({ method: 'POST', url, headers: signed(), payload });
    assert.equal(create.statusCode, 201, create.body);
    const id = create.json().folder as string;
    assert.match(id, /^fullhouse_[a-f0-9]{32}$/);
    assert.equal(create.json().project.manifest.measurement_scope, 'full_house');
    const roof = await storage.createProject({ address: payload.address });
    const base = `/v1/firstmeasure/projects/${id}`;
    for (const suffix of ['', '/editor', '/editor/pdf-state', '/app-metadata', '/pdf-state', '/artifacts', '/artifacts/internal-resource-test.png', '/thumbnail', '/google-3d/manifest.json']) {
      for (const headers of [{}, signed('technician@example.test')]) assert.equal((await app.inject({ method: 'GET', url: base + suffix, headers })).statusCode, 404, suffix);
    }
    assert.equal((await app.inject({ method: 'GET', url: `/other/project/${id}` })).statusCode, 404);
    for (const suffix of ['/queue/claim', '/status', '/qa/approve', '/report/send', '/instant/refund']) {
      assert.equal((await app.inject({ method: 'POST', url: base + suffix, headers: signed(), payload: {} })).statusCode >= 400, true, suffix);
    }
    const metadata = { exteriorsWalls: { version: 2, faces: [{ id: 'saved-wall' }] }, exteriorsRoofTrim: { edges: {} } };
    const save = await app.inject({ method: 'POST', url: base + '/editor/save', headers: signed(), payload: { metadata } });
    assert.equal(save.statusCode, 200, save.body);
    assert.deepEqual((await app.inject({ method: 'GET', url: base + '/app-metadata', headers: signed() })).json().value, metadata);
    const resource = await app.inject({ method: 'POST', url: base + '/artifacts', headers: signed(), payload: { file_name: 'internal-resource-test.png', content_text: 'private media' } });
    assert.equal(resource.statusCode, 200, resource.body);
    const download = await app.inject({ method: 'GET', url: base + '/artifacts/internal-resource-test.png', headers: signed() });
    assert.equal(download.statusCode, 200); assert.equal(download.body, 'private media'); assert.equal(download.headers['cache-control'], 'private, no-store');
    const roofBase = `/v1/firstmeasure/projects/${roof.manifest.id}`;
    assert.equal((await app.inject({ method: 'GET', url: roofBase })).statusCode, 200);
    for (const name of ['internal-resource-test.png', 'folder/internal-resource-test.png', ' internal-markup-test.json']) {
      assert.equal((await app.inject({ method: 'POST', url: roofBase + '/artifacts', headers: signed(), payload: { file_name: name, content_text: 'no' } })).statusCode, 403);
    }
    assert.equal((await app.inject({ method: 'POST', url: roofBase + '/artifacts', payload: { file_name: 'manifest.json', content_text: '{}' } })).statusCode, 400);
    assert.equal((await app.inject({ method: 'POST', url: '/v1/firstmeasure/projects', payload })).statusCode, 400);
    assert.equal((await app.inject({ method: 'PATCH', url: roofBase, payload: { measurement_scope: 'full_house' } })).statusCode, 400);
    for (const result of [await index.queryIndexedProjectManifests({ includeInstantOnly: true }), { projects: await index.listIndexedProjectManifests() }]) {
      assert.equal(result.projects.some(p => p.id === id), false);
      assert.equal(result.projects.some(p => p.id === roof.manifest.id), true);
    }
    assert.equal((await index.findIndexedProjectByNormalizedAddress(payload.address))?.id, roof.manifest.id);
    assert.equal((await index.queryIndexedQaCandidateManifests()).some(p => p.id === id), false);
    const { getQueueStatus, getClaimableQueueStatus } = await import('../firstmeasure/queue.js');
    const actor = { email: 'technician@example.test', name: 'Test technician' };
    const statusBefore = await getQueueStatus({ actor });
    await storage.saveArtifact(id, 'browser_thumbnail.png', 'test thumbnail');
    assert.deepEqual((await getQueueStatus({ actor })).queue_breakdown, statusBefore.queue_breakdown, 'thumbnail-ready private job stays out of technician queue counts');
    assert.notEqual((await getClaimableQueueStatus({ actor })).claimable_next_id, id, 'private job cannot be offered for claiming');
    const countsBefore = await index.getIndexedQueueCounts();
    await storage.patchManifest(id, { status: 'awaiting_review' });
    assert.equal((await index.getIndexedQueueCounts()).total, countsBefore.total);
    assert.equal((await index.readIndexedQueueChanges()).changes.some((row: { project_id: string }) => row.project_id === id), false);
    const list = await app.inject({ method: 'GET', url, headers: signed() });
    assert.equal(list.json().projects.some((p: { id: string }) => p.id === id), true);
    process.env.FIRSTMEASURE_FULL_HOUSE_ENABLED = '0';
    assert.equal((await app.inject({ method: 'GET', url: base, headers: signed() })).statusCode, 404);
    assert.equal((await app.inject({ method: 'GET', url: roofBase })).statusCode, 200);
  } finally { await app.close(); await index.closeFirstMeasureProjectIndex(); }
});
