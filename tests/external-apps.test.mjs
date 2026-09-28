import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import vm from 'node:vm';
import test from 'node:test';
import assert from 'node:assert/strict';

const root = fileURLToPath(new URL('..', import.meta.url));
const registry = path.join(root, 'external-apps/registry.php');
function php(code, args = []) {
  const result = spawnSync('php', ['-r', code, ...args], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr || result.error?.message);
  assert.equal(result.stderr, '');
  return result.stdout;
}

test('shipped registry does not discover GEO for full-platform organizations', () => {
  const discovered = JSON.parse(php('require $argv[1]; echo json_encode(array_keys(fm_external_packages()));', [registry]));
  assert.equal(discovered.includes('geo'), false);
});

test('directory discovery tolerates missing, invalid, disabled and moved packages; private files stay private', () => {
  const temp = mkdtempSync(path.join(tmpdir(), 'fm-external-'));
  try {
    const packageDir = path.join(temp, 'Moon Shot');
    mkdirSync(path.join(packageDir, 'frontend'), { recursive: true });
    writeFileSync(path.join(packageDir, 'frontend/app.js'), '// app');
    writeFileSync(path.join(packageDir, 'frontend/.env'), 'private');
    writeFileSync(path.join(packageDir, 'frontend/server.php'), '<?php');
    writeFileSync(path.join(packageDir, 'firstmate-app.json'), JSON.stringify({ version: 1, id: 'moon', title: 'Moon', entry: 'app.js' }));
    const config = path.join(temp, 'registry.json');
    const discover = () => JSON.parse(php('require $argv[1]; echo json_encode(array_keys(fm_external_packages($argv[2])));', [registry, config]));
    writeFileSync(config, JSON.stringify({ version: 1, apps: [{ id: 'missing', directory: 'absent' }, { id: 'moon', directory: 'Moon Shot' }] }));
    assert.deepEqual(discover(), ['moon']);
    const check = (file) => php('require $argv[1]; echo fm_external_file($argv[2], $argv[3]) === null ? "blocked" : "allowed";', [registry, path.join(packageDir, 'frontend'), file]);
    assert.equal(check('app.js'), 'allowed');
    for (const file of ['../firstmate-app.json', '.env', 'server.php', '..\\firstmate-app.json', '/app.js']) assert.equal(check(file), 'blocked');
    writeFileSync(config, JSON.stringify({ version: 1, apps: [{ id: 'moon', directory: packageDir, enabled: false }] }));
    assert.deepEqual(discover(), []);
    writeFileSync(config, '{bad');
    assert.deepEqual(discover(), []);
    writeFileSync(config, JSON.stringify({ version: 1, apps: [{ id: 'moon', directory: packageDir }] }));
    assert.deepEqual(discover(), ['moon']);
    rmSync(path.join(packageDir, 'frontend/app.js'));
    assert.deepEqual(discover(), []);
    rmSync(config);
    assert.deepEqual(discover(), []);
  } finally { rmSync(temp, { recursive: true, force: true }); }
});

test('missing or broken factories never register; healthy apps use the managed runtime and route', () => {
  const apps = new Map();
  const manifests = [];
  const window = {
    FirstMateAppsManifest: { apps: [] },
    FirstMateEmbeddableApps: {
      getApp: (id) => apps.get(id),
      registerManifest: (app) => manifests.push(app),
      registerApp: (app) => apps.set(app.id, app)
    }
  };
  vm.runInNewContext(readFileSync(path.join(root, 'public/libraries/app-runtime/firstmate-external-apps.js'), 'utf8'), { window, console: { warn() {} } });
  const loader = window.FirstMateExternalApps;
  const meta = { id: 'moon', title: 'Moon', icon: 'fa-globe', order: 90 };
  assert.equal(loader.register(meta), false);
  loader.define('moon', () => { throw new Error('broken dependency'); });
  assert.equal(loader.register(meta), false);
  assert.equal(apps.size, 0);
  loader.define('moon', ({ assetUrl }) => {
    assert.equal(assetUrl('a b.png'), '/external-apps/asset.php?app=moon&file=a%20b.png');
    return { mount() { throw new Error('mount failed'); } };
  });
  assert.equal(loader.register(meta), true);
  const app = apps.get('portal.external_moon');
  assert.equal(app.portalTabId, 'external_moon');
  assert.equal(app.route.params.tab.history, 'push');
  assert.equal(app.access.applicationsAny[0], 'management');
  const node = { textContent: '', replaceChildren() { this.textContent = ''; } };
  app.mount({ roots: { main: node } }).destroy();
  assert.equal(node.textContent, '');
  assert.equal(manifests.length, 1);
  assert.equal(window.FirstMateAppsManifest.apps.length, 1);
  assert.equal(loader.register(meta), false);
});
