#!/usr/bin/env node
// Private, content-addressed release delivery. No service restart, SQL or DNS.
import { createHash, createPublicKey, createPrivateKey, sign, verify } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { readFile, writeFile, stat, mkdir, open, rm } from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

export function validateManifest(m) {
  if (m?.schema !== 1 || m.environment !== 'production' || m.role !== 'web' || m.platform !== 'linux-x64'
      || !/^[a-f0-9]{40}$/.test(m.release_id) || !/^[a-f0-9]{64}$/.test(m.sha256)
      || !Number.isSafeInteger(m.size) || m.size <= 0 || m.size > 2_000_000_000) throw new Error('Invalid release manifest');
  return m;
}

export async function fileDigest(file) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(file)) hash.update(chunk);
  return hash.digest('hex');
}

export function encodeManifest(m, privateKey) {
  const payload = Buffer.from(JSON.stringify(validateManifest(m)));
  return Buffer.from(JSON.stringify({ payload: payload.toString('base64'), signature: sign(null, payload, privateKey).toString('base64') }));
}

export async function readManifest(store, key, publicKey) {
  const { Body } = await store.get(key);
  const chunks = []; let size = 0;
  for await (const chunk of Body) {
    size += chunk.length;
    if (size > 4096) { Body.destroy?.(); throw new Error('Oversized manifest'); }
    chunks.push(chunk);
  }
  const envelope = JSON.parse(Buffer.concat(chunks).toString('utf8'));
  const payload = Buffer.from(envelope.payload, 'base64');
  if (!publicKey || publicKey.asymmetricKeyType !== 'ed25519' || !verify(null, payload, publicKey, Buffer.from(envelope.signature, 'base64'))) throw new Error('Release manifest signature verification failed');
  return validateManifest(JSON.parse(payload.toString('utf8')));
}

async function verifyRemote(store, key, m, output) {
  const { Body, ContentLength } = await store.get(key);
  if (ContentLength !== undefined && ContentLength !== m.size) { Body.destroy?.(); throw new Error('Artifact length mismatch'); }
  const hash = createHash('sha256'); let size = 0;
  const file = output ? await open(output, 'wx', 0o600) : null;
  try {
    for await (const chunk of Body) {
      size += chunk.length;
      if (size > m.size) throw new Error('Artifact exceeds manifest length');
      hash.update(chunk);
      if (file) await file.writeFile(chunk);
    }
    if (size !== m.size || hash.digest('hex') !== m.sha256) throw new Error('Artifact checksum mismatch');
    if (file) await file.sync();
  } finally {
    Body.destroy?.();
    await file?.close();
  }
}

export async function publish(store, prefix, m, archive, expectedPrevious, privateKey) {
  validateManifest(m);
  if (!privateKey || privateKey.asymmetricKeyType !== 'ed25519') throw new Error('Ed25519 release signing key required');
  const publicKey = createPublicKey(privateKey);
  if ((await stat(archive)).size !== m.size || await fileDigest(archive) !== m.sha256) throw new Error('Local artifact mismatch');
  let previous = null;
  try { previous = await readManifest(store, prefix + '/web.json', publicKey); }
  catch (error) { if (error.name !== 'NoSuchKey') throw error; }
  if ((previous?.sha256 ?? 'none') !== expectedPrevious) throw new Error('Channel changed; review current target before promotion');
  const key = prefix + '/artifacts/' + m.sha256 + '.tar.gz';
  await store.put(key, createReadStream(archive), m.size);
  await verifyRemote(store, key, m);
  // Keep the prior channel target for explicit rollback. Publishers MUST share
  // the controller's flock; the expected-previous check is not a distributed CAS.
  if (previous) {
    const value = encodeManifest(previous, privateKey);
    await store.put(prefix + '/history/' + previous.sha256 + '.json', value, value.length);
  }
  const value = encodeManifest(m, privateKey);
  await store.put(prefix + '/web.json', value, value.length);
  const observed = await readManifest(store, prefix + '/web.json', publicKey);
  if (observed.sha256 !== m.sha256 || observed.release_id !== m.release_id) throw new Error('Channel readback mismatch');
  return observed;
}

export async function download(store, prefix, folder, publicKey) {
  const m = await readManifest(store, prefix + '/web.json', publicKey);
  await mkdir(folder, { recursive: true, mode: 0o700 });
  const output = path.join(folder, 'release.tar.gz');
  try { await verifyRemote(store, prefix + '/artifacts/' + m.sha256 + '.tar.gz', m, output); }
  catch (error) { await rm(output, { force: true }); throw error; }
  await writeFile(path.join(folder, 'release.json'), JSON.stringify(m), { flag: 'wx', mode: 0o600 });
  return m;
}

async function productionStore() {
  // The reviewed service environment supplies existing private Spaces access.
  // No credential is accepted in a command argument or sent to a URL in a manifest.
  if (process.env.FIRSTMEASURE_DATA_ENVIRONMENT !== 'production' || process.env.SPACES_PREFIX !== 'production') throw new Error('Production environment and storage prefix required');
  const endpoint = new URL(process.env.SPACES_ENDPOINT);
  if (endpoint.protocol !== 'https:' || !/^[a-z0-9-]+\.digitaloceanspaces\.com$/.test(endpoint.hostname)
      || endpoint.username || endpoint.password || endpoint.search || endpoint.hash || endpoint.port || endpoint.pathname !== '/') throw new Error('Expected verified DigitalOcean Spaces HTTPS endpoint');
  if (!process.env.SPACES_BUCKET || !process.env.SPACES_ACCESS_KEY_ID || !process.env.SPACES_SECRET_ACCESS_KEY) throw new Error('Missing private Spaces configuration');
  const require = createRequire(path.join(process.cwd(), 'package.json'));
  const { S3Client, GetObjectCommand, PutObjectCommand } = require('@aws-sdk/client-s3');
  const client = new S3Client({ endpoint: endpoint.href, region: process.env.SPACES_REGION,
    credentials: { accessKeyId: process.env.SPACES_ACCESS_KEY_ID, secretAccessKey: process.env.SPACES_SECRET_ACCESS_KEY },
    maxAttempts: 2, requestChecksumCalculation: 'WHEN_REQUIRED', responseChecksumValidation: 'WHEN_REQUIRED' });
  const Bucket = process.env.SPACES_BUCKET;
  const store = {
    get: Key => client.send(new GetObjectCommand({ Bucket, Key }), { abortSignal: AbortSignal.timeout(180000) }),
    put: (Key, Body, ContentLength) => client.send(new PutObjectCommand({ Bucket, Key, Body, ContentLength,
      ACL: 'private', CacheControl: 'no-store' }), { abortSignal: AbortSignal.timeout(180000) })
  };
  return { store, close: () => client.destroy(), prefix: 'production/_releases/v1' };
}

async function main() {
  const [command, ...args] = process.argv.slice(2);
  const allowed = { publish: 3, download: 1, 'require-target': 1 };
  if (!(command in allowed) || args.length !== allowed[command]) throw new Error('Usage: publish MANIFEST ARCHIVE PREVIOUS_SHA256|none; download EMPTY_DIRECTORY; require-target RELEASE_DIRECTORY');
  if (command === 'require-target' && process.env.FIRSTMEASURE_DATA_ENVIRONMENT === 'development') {
    console.log(JSON.stringify({ ok: true, environment: 'development', production_release_gate: 'not_applicable' }));
    return;
  }
  const { store, close, prefix } = await productionStore();
  try {
    const publicKey = createPublicKey(await readFile('/etc/firstmeasure/release-signing-public.pem'));
    if (command === 'publish') {
      // Enforce one publishing host/lock through the wrapper, before any write.
      if (process.env.FIRSTMEASURE_RELEASE_PUBLISH_LOCK !== 'held') throw new Error('Use publish-web-release.sh on the designated controller');
      const manifest = validateManifest(JSON.parse(await readFile(args[0], 'utf8')));
      const privateKey = createPrivateKey(await readFile('/etc/firstmeasure/release-signing-private.pem'));
      if (!createPublicKey(privateKey).equals(publicKey)) throw new Error('Publisher signing key differs from pinned public key');
      execFileSync('python3', [fileURLToPath(new URL('./release-artifact.py', import.meta.url)), 'verify',
        '--archive', path.resolve(args[1]), '--manifest', path.resolve(args[0])], { stdio: ['ignore', 'ignore', 'ignore'], timeout: 180000 });
      console.log(JSON.stringify(await publish(store, prefix, manifest, args[1], args[2], privateKey)));
    } else if (command === 'download') {
      console.log(JSON.stringify(await download(store, prefix, path.resolve(args[0]), publicKey)));
    } else {
      const target = path.resolve(args[0]);
      const local = validateManifest(JSON.parse(await readFile(path.join(target, '.release-artifact.json'), 'utf8')));
      const remote = await readManifest(store, prefix + '/web.json', publicKey);
      const releaseEnv = (await readFile(path.join(target, 'release.env'), 'utf8')).trim();
      if (local.sha256 !== remote.sha256 || local.release_id !== remote.release_id || releaseEnv !== 'RELEASE_ID=' + local.release_id) throw new Error('Web activation refused: replacement-node release channel differs from staged release');
      console.log(JSON.stringify({ ok: true, release_id: local.release_id, replacement_channel_matches: true }));
    }
  } finally { close(); }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main().catch(() => { console.error('Release delivery failed; no credential details logged. Check configuration, manifest and private artifact access.'); process.exitCode = 1; });
}
