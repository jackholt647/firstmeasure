import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import { createHash, generateKeyPairSync } from 'node:crypto';
import { publish, download, validateManifest } from './release-channel.mjs';

const prefix = 'production/_releases/v1';
const { privateKey, publicKey } = generateKeyPairSync('ed25519');
const decoded = value => JSON.parse(Buffer.from(JSON.parse(value).payload, 'base64'));
function memoryStore() {
  const objects = new Map();
  return { objects, get: async key => {
    if (!objects.has(key)) throw Object.assign(new Error('missing'), { name: 'NoSuchKey' });
    const value = objects.get(key);
    return { Body: Readable.from([value]), ContentLength: value.length };
  }, put: async (key, body) => {
    const parts = []; for await (const chunk of body) parts.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from([chunk]));
    objects.set(key, Buffer.concat(parts));
  } };
}
async function fixture(fn) {
  const dir = await mkdtemp(path.join(tmpdir(), 'fm-release-test-'));
  try {
    const payload = Buffer.from('reviewed Linux build fixture');
    const archive = path.join(dir, 'payload.tar.gz'); await writeFile(archive, payload);
    const m = { schema: 1, environment: 'production', role: 'web', platform: 'linux-x64',
      release_id: 'a'.repeat(40), sha256: createHash('sha256').update(payload).digest('hex'), size: payload.length };
    await fn({ dir, payload, archive, m, store: memoryStore() });
  } finally { await rm(dir, { recursive: true, force: true }); }
}

test('publishing verifies artifact then atomically exposes a usable target; download matches', () => fixture(async ({ dir, archive, payload, m, store }) => {
  await publish(store, prefix, m, archive, 'none', privateKey);
  const folder = path.join(dir, 'download');
  assert.deepEqual(await download(store, prefix, folder, publicKey), m);
  assert.deepEqual(await readFile(path.join(folder, 'release.tar.gz')), payload);
}));
test('corrupt upload never promotes a channel', () => fixture(async ({ archive, m, store }) => {
  const put = store.put;
  store.put = async (key, body) => { await put(key, body); if (key.endsWith('.tar.gz')) store.objects.set(key, Buffer.from('corrupt')); };
  await assert.rejects(publish(store, prefix, m, archive, 'none', privateKey), /length mismatch/);
  assert.equal(store.objects.has(prefix + '/web.json'), false);
}));
test('stale promotion cannot overwrite a newer release target', () => fixture(async ({ archive, m, store }) => {
  await publish(store, prefix, m, archive, 'none', privateKey);
  await assert.rejects(publish(store, prefix, { ...m, release_id: 'b'.repeat(40) }, archive, 'none', privateKey), /Channel changed/);
  assert.equal(decoded(store.objects.get(prefix + '/web.json')).release_id, m.release_id);
}));
test('replacement download rejects corrupted artifact and leaves no partial executable archive', () => fixture(async ({ dir, archive, m, store }) => {
  await publish(store, prefix, m, archive, 'none', privateKey);
  store.objects.set(prefix + '/artifacts/' + m.sha256 + '.tar.gz', Buffer.alloc(m.size, 1));
  const folder = path.join(dir, 'download');
  await assert.rejects(download(store, prefix, folder, publicKey), /checksum/);
  await assert.rejects(readFile(path.join(folder, 'release.tar.gz')), /ENOENT/);
  await assert.rejects(readFile(path.join(folder, 'release.json')), /ENOENT/);
}));
test('promotion preserves the previous manifest for an explicit rollback', () => fixture(async ({ archive, m, store }) => {
  await publish(store, prefix, m, archive, 'none', privateKey);
  await publish(store, prefix, { ...m, release_id: 'b'.repeat(40) }, archive, m.sha256, privateKey);
  assert.deepEqual(decoded(store.objects.get(prefix + '/history/' + m.sha256 + '.json')), m);
}));
test('cross-environment, wrong platform and invalid manifest inputs fail closed', () => fixture(async ({ m }) => {
  for (const change of [{ environment: 'development' }, { role: 'worker' }, { platform: 'win32-x64' }, { release_id: '../escape' }, { size: -1 }, { sha256: 'invalid' }])
    assert.throws(() => validateManifest({ ...m, ...change }));
}));

test('a compromised object-store writer cannot forge an intended release', () => fixture(async ({ dir, archive, m, store }) => {
  await publish(store, prefix, m, archive, 'none', privateKey);
  const key = prefix + '/web.json';
  const envelope = JSON.parse(store.objects.get(key));
  envelope.payload = Buffer.from(JSON.stringify({ ...m, release_id: 'f'.repeat(40) })).toString('base64');
  store.objects.set(key, Buffer.from(JSON.stringify(envelope)));
  await assert.rejects(download(store, prefix, path.join(dir, 'download'), publicKey), /signature/);
}));
