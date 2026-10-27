import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { gzipSync, gunzipSync, brotliDecompressSync, inflateSync } from 'node:zlib';
import test from 'node:test';

// Saved undo history is uploaded as gzip. @fastify/compress passes an already-gzipped body through unchanged
// but labels it with the browser's preferred encoding (br in Chrome), so the download failed with
// "Failed to fetch" and the editor could not open any project saved with history. Artifacts must arrive
// byte for byte whatever the browser accepts (October 20 production release).
test('artifact downloads return stored bytes unchanged for every accepted encoding', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'artifact-encoding-test-'));
  Object.assign(process.env, {
    FIRSTMATE_ENV: 'test', FIRSTMEASURE_DATABASE_MODE: 'sqlite',
    FIRSTMEASURE_STORAGE_ROOT: path.join(root, 'projects'), FIRSTMEASURE_INDEX_DB_PATH: path.join(root, 'index.sqlite'),
    INTERNAL_STORAGE_ROOT: path.join(root, 'internal'), PLATFORM_STORAGE_ROOT: path.join(root, 'platform'),
    FIRSTMEASURE_JOB_WORKERS: '0'
  });
  const { default: Fastify } = await import('fastify');
  const { default: compress } = await import('@fastify/compress');
  const { registerFirstMeasureApi } = await import('../firstmeasure/api.js');
  const storage = await import('../firstmeasure/storage.js');
  const app = Fastify();
  // The same registration as src/app.ts.
  await app.register(compress, { global: true, encodings: ['br', 'gzip', 'deflate'], threshold: 1024 });
  await app.register(registerFirstMeasureApi, { prefix: '/v1/firstmeasure' });
  const decode = (encoding: string | undefined, body: Buffer) =>
    encoding === 'br' ? brotliDecompressSync(body) : encoding === 'gzip' ? gunzipSync(body) : encoding === 'deflate' ? inflateSync(body) : body;
  try {
    const project = await storage.createProject({ address: '1 Encoding Test Way' });
    const id = String(project.manifest.id);
    const history = gzipSync(Buffer.from(JSON.stringify({ version: 1, nodes: Array.from({ length: 3000 }, (_, i) => ['a', [i]]) })));
    assert.ok(history.length > 1024, 'large enough to be compressed if the route allowed it');
    const name = 'editor-history-' + 'a'.repeat(64) + '.bin';
    await storage.saveArtifact(id, name, history);
    for (const accept of ['gzip, deflate, br, zstd', 'gzip, deflate', 'gzip', '']) {
      const response = await app.inject({ method: 'GET', url: `/v1/firstmeasure/projects/${id}/artifacts/${name}`, headers: accept ? { 'accept-encoding': accept } : {} });
      assert.equal(response.statusCode, 200, response.body);
      const encoding = response.headers['content-encoding'] as string | undefined;
      assert.equal(encoding, undefined, `no content-encoding for "${accept}"`);
      assert.deepEqual(decode(encoding, response.rawPayload), history, `stored bytes for "${accept}"`);
    }
  } finally {
    await app.close();
  }
});
