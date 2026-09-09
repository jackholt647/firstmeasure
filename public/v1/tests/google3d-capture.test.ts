import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { google3dFootprint, google3dBoxIntersectsFootprint, google3dBoxFootprintDistance } from '../firstmeasure/google3d_bounds.js';

const footprint = google3dFootprint(0, 0, { x: 6378137, y: 0, z: 0 });
const box = (height: number, east = 0, half = 5) => [6378137 + height, east, 0, half, 0, 0, 0, half, 0, 0, 0, half];

test('capture footprint keeps fine roof tiles above and below ellipsoid zero', () => {
  for (const height of [-400, 160, 1500, 4000]) {
    assert.equal(google3dBoxIntersectsFootprint(box(height), footprint, 80), true);
    assert.equal(google3dBoxFootprintDistance(box(height), footprint), 0);
  }
  // The former 3D-sphere test discarded this same valid roof tile.
  assert.equal(Math.hypot(160, 0, 0) <= 15 + 80, false);
});

test('footprint excludes distant properties and the opposite hemisphere', () => {
  assert.equal(google3dBoxIntersectsFootprint(box(160, 200), footprint, 80), false);
  assert.equal(google3dBoxIntersectsFootprint(box(-12756274), footprint, 80), false);
  assert.equal(google3dBoxIntersectsFootprint(box(160, 94), footprint, 80), true);
});

test('reported Texas latitude keeps a roof above the anchor, not only equatorial fixtures', () => {
  const lat = 33.12011905 * Math.PI / 180, lon = -96.5821758 * Math.PI / 180;
  const n = 6378137 / Math.sqrt(1 - 6.69437999014e-3 * Math.sin(lat) ** 2);
  const origin = { x: n * Math.cos(lat) * Math.cos(lon), y: n * Math.cos(lat) * Math.sin(lon), z: n * (1 - 6.69437999014e-3) * Math.sin(lat) };
  const target = google3dFootprint(33.12011905, -96.5821758, origin);
  const elevated = [origin.x + 160 * target.up.x, origin.y + 160 * target.up.y, origin.z + 160 * target.up.z, 5, 0, 0, 0, 5, 0, 0, 0, 5];
  assert.equal(google3dBoxIntersectsFootprint(elevated, target, 80), true);
  assert.ok(google3dBoxFootprintDistance(elevated, target) < 1e-8);
});

test('native capture replaces legacy coarse capture, stores detailed leaves, and reuses corrected capture', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'fm-tiles142-'));
  process.env.FIRSTMEASURE_STORAGE_ROOT = root;
  process.env.FIRSTMEASURE_DATA_BACKEND = 'sqlite';
  process.env.FIRSTMEASURE_ARTIFACT_STORAGE = 'filesystem';
  process.env.GOOGLE_MAP_TILES_API_KEY = 'test-only-key';
  const { ensureProjectGoogle3dCapture, readProjectGoogle3dManifest } = await import('../firstmeasure/google3d.js');
  const originalFetch = globalThis.fetch;
  const calls: string[] = [];
  let failExternal = false;
  let missDetail = false;
  globalThis.fetch = async (input) => {
    const pathname = new URL(String(input)).pathname;
    calls.push(pathname);
    if (pathname.endsWith('root.json')) return Response.json({ root: {
      boundingVolume: { box: box(160, 0, 150) }, content: { uri: '/coarse.glb' },
      children: [{ boundingVolume: { box: box(160, missDetail ? 1000 : 0, 30) }, content: { uri: '/detail.json' } }]
    } });
    if (pathname.endsWith('detail.json')) return failExternal ? new Response('', { status: 503 }) : Response.json({ root: {
      boundingVolume: { box: box(160) }, content: { uri: '/roof.glb' }, geometricError: 0
    } });
    if (pathname.endsWith('roof.glb')) return new Response('fixture-glb', { headers: { 'content-type': 'model/gltf-binary' } });
    throw new Error('Unexpected fetch: ' + pathname);
  };
  try {
    const projectId = 'tile-capture-regression';
    const captureDir = path.join(root, projectId, 'google_3d');
    await mkdir(captureDir, { recursive: true });
    await writeFile(path.join(captureDir, 'manifest.json'), JSON.stringify({ capture: { deepestLeafCount: 24 }, tiles: [] }));
    const input = { projectId, address: 'Synthetic roof', lat: 0, lon: 0, radiusMeters: 80 };
    const result = await ensureProjectGoogle3dCapture(input);
    assert.equal(result.capture.selectionVersion, 2);
    assert.equal(result.tiles.length, 1);
    assert.equal(result.tiles[0]?.sourcePath, '/roof.glb');
    assert.equal(calls.includes('/coarse.glb'), false);
    failExternal = false;
    missDetail = true;
    await assert.rejects(ensureProjectGoogle3dCapture({ ...input, projectId: 'empty-tiles' }), /could not be resolved/);
    await assert.rejects(readProjectGoogle3dManifest('empty-tiles'));
    assert.equal(calls.includes('/coarse.glb'), false);
    const count = calls.length;
    assert.deepEqual(await ensureProjectGoogle3dCapture(input), result);
    assert.equal(calls.length, count);
    failExternal = true;
    missDetail = false;
    await assert.rejects(ensureProjectGoogle3dCapture({ ...input, projectId: 'failed-tiles' }), /503/);
    await assert.rejects(readProjectGoogle3dManifest('failed-tiles'));
    assert.equal(calls.includes('/coarse.glb'), false);
  } finally {
    globalThis.fetch = originalFetch;
    await rm(root, { recursive: true, force: true });
  }
});
