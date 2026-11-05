import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

// A customer full-house order keeps the editor's Resources files (tech uploads, saved
// frames, markup) beside the customer's own files: staff reach them, customers never do.
test('customer full-house orders: internal resources for staff only', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'fh-customer-resources-'));
  Object.assign(process.env, {
    FIRSTMATE_ENV: 'test', FIRSTMEASURE_DATABASE_MODE: 'sqlite', DATABASE_URL: '',
    FIRSTMEASURE_JOB_WORKERS: '0', EMAIL_OUTBOUND_DISABLED: '1', PLATFORM_HEARTBEAT_DISABLED: '1',
    FIRSTMEASURE_STORAGE_ROOT: path.join(root, 'reports'), FIRSTMEASURE_INDEX_DB_PATH: path.join(root, 'index.sqlite'),
    INTERNAL_STORAGE_ROOT: path.join(root, 'internal'), PLATFORM_STORAGE_ROOT: path.join(root, 'platform')
  });
  const storage = await import('../firstmeasure/storage.js');
  const { signedProjectFileQuery } = await import('../firstmeasure/access.js');
  const { buildApp } = await import('../src/app.js');
  const { staffInjector, customerFixture, ensureServiceSecretForTests, signedServiceHeaders } = await import('./helpers/security-fixture.js');
  await ensureServiceSecretForTests();
  const app = await buildApp();
  try {
    const customer = await customerFixture();
    const staff = staffInjector(app, {}, { email: 'drafter@example.test', role: 'technician' });
    await staff.sessionFor('drafter@example.test');
    const id = 'exteriors_' + 'b'.repeat(32), roofId = 'roof-resources-report';
    await storage.createProject({ id, address: 'Customer resources fixture', status: 'queued', measurement_scope: 'full_house', include_gutter_measurements: true }, { customerExteriors: true });
    await storage.patchManifest(id, { organization_id: customer.orgId });
    await storage.createProject({ id: roofId, address: 'Roof resources fixture', status: 'queued' });
    await storage.patchManifest(roofId, { organization_id: customer.orgId });
    await storage.saveArtifact(id, 'customer-reference-0.webm', Buffer.from('customer walkthrough'));
    const base = `/v1/firstmeasure/projects/${id}`, name = 'internal-resource-v2-12345678-1234-4234-8234-123456789abc-frame.png';

    // The editor's Resources script (PHP) signs as the staff member.
    const php = async (method: string, url: string, payload?: object) =>
      app.inject({ method: method as 'GET', url, headers: await signedServiceHeaders(method, url, 'drafter@example.test', payload), ...(payload ? { payload } : {}) });
    const saved = await php('POST', base + '/artifacts', { file_name: name, content_text: 'saved frame' });
    assert.equal(saved.statusCode, 200, saved.body);
    assert.equal((await php('GET', base + '/artifacts/' + name)).body, 'saved frame');
    assert.ok((await php('GET', base + '/artifacts')).json().files.some((f: { name: string }) => f.name === name), 'listed for staff');
    assert.equal((await staff({ method: 'GET', url: base + '/artifacts/' + name })).statusCode, 200, 'staff session');
    assert.equal((await php('GET', base + '/artifacts/customer-reference-0.webm')).body, 'customer walkthrough', 'frame source readable');

    // Customers keep their own files and never see the drafting resources.
    assert.equal((await app.inject({ method: 'GET', url: base + '/artifacts/customer-reference-0.webm', headers: customer.headers })).statusCode, 200);
    assert.equal((await app.inject({ method: 'GET', url: base + '/artifacts/' + name, headers: customer.headers })).statusCode, 403);
    assert.equal((await app.inject({ method: 'GET', url: `${base}/artifacts/${name}?${signedProjectFileQuery(id, name)}` })).statusCode, 403, 'signed link');
    assert.equal((await app.inject({ method: 'GET', url: base + '/artifacts', headers: customer.headers })).statusCode, 403);
    assert.equal((await app.inject({ method: 'POST', url: base + '/artifacts', headers: customer.headers, payload: { file_name: name, content_text: 'x' } })).statusCode, 403);

    // Other projects are unchanged: no internal resources at all.
    assert.equal((await php('POST', `/v1/firstmeasure/projects/${roofId}/artifacts`, { file_name: name, content_text: 'no' })).statusCode, 403);
  } finally {
    await app.close();
    await rm(root, { recursive: true, force: true, maxRetries: 3 }).catch(() => undefined);
  }
});
