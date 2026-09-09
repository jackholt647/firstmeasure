import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';

const source = readFileSync(new URL('../../measure/internal/editor_scripts/scene_3d.js', import.meta.url), 'utf8');
const start = source.indexOf('async function ensureGoogleTileSurfaceLoaded(');
const end = source.indexOf('// =========================================================', start);

function setup(updated = true) {
  const captures: boolean[] = [], models: object[] = [];
  const state: Record<string, any> = { ready: false, loadToken: 0, manifestUrl: '/v1/firstmeasure/projects/test/google-3d/manifest.json' };
  let manifest = { anchor: { lat: 0, lon: 0 }, capture: {}, tiles: [{ file: 'roof.glb' }] };
  const context = vm.createContext({
    URL, console, Promise, googleTileState: state,
    GOOGLE_TILE_BACKGROUND_TILE_DELAY_MS: 0,
    window: { location: { href: 'http://localhost/' } },
    googleTileContentGroup: { add: (model: object) => models.push(model) },
    ensureGoogleTileSceneRoots() {}, update3DSurfaceButtons() {}, updateGoogleTileRootTransform() {},
    apply3DSurfaceVisibility() {}, clearGoogleTileSurface() { state.ready = false; },
    ensureGoogleTileLoaders: () => ({}), get3DTileManifestUrl: () => state.manifestUrl,
    getGoogleTileManifest: async () => manifest,
    requestProjectGoogleTileCapture: async (force: boolean) => {
      captures.push(force);
      if (updated) manifest = { ...manifest, capture: { selectionVersion: 2 } };
    },
    validateManifestForProject: () => true,
    isUsingDefault3DTileManifest: () => false,
    loadGltfScene: async () => ({ scene: { traverse() {} } }),
    scheduleGoogleTileAutoYOffsetSolve: () => null,
    waitForGoogleTileBackgroundSlot: async () => {}, yieldGoogleTileWorkToBrowser: async () => {}
  });
  vm.runInContext(source.slice(start, end), context);
  return { state, captures, models, load: (options: object) => context.ensureGoogleTileSurfaceLoaded(options) };
}

test('legacy capture background preload stays read-only and does not show broken geometry', async () => {
  const fixture = setup();
  assert.equal(await fixture.load({ background: true }), false);
  assert.deepEqual(fixture.captures, []);
  assert.equal(fixture.state.ready, false);
  assert.equal(fixture.models.length, 0);
  assert.match(fixture.state.error, /Select TILE/);
});

test('explicit TILE refreshes legacy capture without forced duplicate capture and loads corrected surface', async () => {
  const fixture = setup();
  await fixture.load({ background: true });
  assert.equal(await fixture.load({ allowGenerate: true }), true);
  assert.deepEqual(fixture.captures, [false]);
  assert.equal(fixture.state.ready, true);
  assert.equal(fixture.models.length, 1);
  assert.equal(await fixture.load({ allowGenerate: true }), true);
  assert.deepEqual(fixture.captures, [false]);
});

test('outdated backend is an actionable error instead of rendering old broken capture', async () => {
  const fixture = setup(false);
  await assert.rejects(fixture.load({ allowGenerate: true }), /service needs updating/);
  assert.equal(fixture.state.ready, false);
  assert.equal(fixture.models.length, 0);
});
