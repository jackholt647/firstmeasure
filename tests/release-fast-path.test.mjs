// Production run fast path (FM-388, DEPLOYMENT.md "Production run fast path"): a release whose Node side
// equals the running one is activated by switching `current` and reloading PHP-FPM, without restarting Node.
// deploy/digitalocean/release-node-fingerprint.py decides; switch-release-files.py does it on a host.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..');
const FINGERPRINT = path.join(root, 'deploy/digitalocean/release-node-fingerprint.py');
const SWITCH = path.join(root, 'deploy/digitalocean/switch-release-files.py');
const A = 'a'.repeat(40);
const B = 'b'.repeat(40);

const python = (...args) => spawnSync('python3', [FINGERPRINT, ...args], { encoding: 'utf8' });

function write(dir, files) {
  for (const [name, content] of Object.entries(files)) {
    const file = path.join(dir, name);
    if (content === null) { fs.rmSync(file, { force: true }); continue; }
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, content);
  }
}

const BASE = {
  'release.env': `RELEASE_ID=${A}\n`,
  '.release-artifact.json': `{"release_id":"${A}"}\n`,
  'public/v1/dist/src/server.js': '// server\n',
  'public/v1/node_modules/pg/package.json': '{"version":"8.0.0"}\n',
  'public/v1/package-lock.json': '{}\n',
  'public/v1/config-library/snapshot/flags.json': '{"a":1}\n',
  'public/v1/forms/solar.ts': 'const c = [path.resolve(MODULE_DIR, "../../measure/internal/editor.php")];\n',
  'public/measure/internal/editor.php': "<?php $GOOGLE_API_KEY = 'key-one'; ?>\n<script src=\"editor_scripts/wall_mode.js?v=1\"></script>\n",
  'public/measure/internal/editor_scripts/wall_mode.js': 'wall();\n',
  'public/measure/internal/editor_scripts/pdf.js': 'pdf();\n',
  'public/measure/internal/editor_scripts/vendor/earcut.js': 'earcut();\n',
  'public/measure/internal/backend_login.php': '<?php echo "login";\n',
  'public/portal/login.php': '<?php echo "portal";\n',
  'public/portal/scripts/core.js': 'core();\n',
  'public/portal/landing/variants/a/index.php': '<?php echo "landing";\n',
  'public/libraries/report-units.js': 'units();\n',
  'deploy/digitalocean/production-release-x.md': '# record\n'
};

function release(dir, id, changes = {}) {
  write(dir, { ...BASE, 'release.env': `RELEASE_ID=${id}\n`, '.release-artifact.json': `{"release_id":"${id}"}\n` });
  write(dir, changes);
  return dir;
}

function compare(changes) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'fm388-'));
  try {
    const old = release(path.join(tmp, 'old'), A);
    const next = release(path.join(tmp, 'new'), B, changes);
    const result = python('compare', old, next);
    assert.ok([0, 3].includes(result.status), result.stderr);
    const parsed = JSON.parse(result.stdout);
    assert.equal(result.status === 0, parsed.fast_path);
    return parsed;
  } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
}

test('editor, portal and record changes keep Node; release identity is ignored', () => {
  for (const changes of [
    { 'public/measure/internal/editor_scripts/wall_mode.js': 'wall(2);\n' },
    { 'public/measure/internal/editor_scripts/new_tool.js': 'tool();\n' },
    { 'public/portal/login.php': '<?php echo "portal 2";\n', 'public/portal/scripts/core.js': 'core(2);\n' },
    { 'deploy/digitalocean/production-release-y.md': '# record 2\n' },
    { 'public/measure/internal/editor.php': "<?php $GOOGLE_API_KEY = 'key-one'; ?>\n<script src=\"editor_scripts/wall_mode.js?v=2\"></script>\n" },
    {}
  ]) {
    const result = compare(changes);
    assert.equal(result.fast_path, true, JSON.stringify(changes));
    assert.deepEqual(result.changed_node, []);
    assert.equal(result.server.running, result.server.new);
  }
  const removed = compare({ 'public/portal/scripts/core.js': null });
  assert.equal(removed.fast_path, true);
  assert.deepEqual(removed.removed, ['public/portal/scripts/core.js']);
});

test('anything Node runs or reads needs the full procedure', () => {
  for (const [file, content] of [
    ['public/v1/dist/src/server.js', '// server 2\n'],
    ['public/v1/node_modules/pg/package.json', '{"version":"8.0.1"}\n'],
    ['public/v1/package-lock.json', '{"x":1}\n'],
    ['public/v1/config-library/snapshot/flags.json', '{"a":2}\n'],
    ['public/v1/new-module.js', 'x();\n'],
    ['public/measure/internal/editor_scripts/pdf.js', 'pdf(2);\n'],
    ['public/measure/internal/editor_scripts/vendor/earcut.js', 'earcut(2);\n'],
    ['public/portal/landing/variants/a/index.php', '<?php echo "landing 2";\n'],
    ['public/libraries/report-units.js', 'units(2);\n'],
    ['public/fonts/Montserrat-Bold.ttf', 'font\n'],
    ['public/measure/internal/editor.php', "<?php $GOOGLE_API_KEY = 'key-two'; ?>\n"]
  ]) {
    const result = compare({ [file]: content });
    assert.equal(result.fast_path, false, file);
    assert.deepEqual(result.changed_node, [file]);
  }
  const server = compare({ 'public/v1/dist/src/server.js': '// server 2\n' });
  assert.notEqual(server.server.running, server.server.new);
});

test('a new source file reading under measure/ or portal/ refuses the fast path until it is classified', () => {
  const result = compare({ 'public/v1/reports/editor.ts': 'readFile(path.join(publicRoot, "measure", "internal", "editor_scripts", "new.js"));\n',
    'public/measure/internal/editor_scripts/wall_mode.js': 'wall(2);\n' });
  assert.equal(result.fast_path, false);
  assert.deepEqual(result.unclassified_readers, ['public/v1/reports/editor.ts']);
});

test('archives give the same answer as release directories', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'fm388-'));
  try {
    const old = release(path.join(tmp, 'old'), A);
    const next = release(path.join(tmp, 'new'), B, { 'public/measure/internal/editor_scripts/wall_mode.js': 'wall(2);\n' });
    for (const [dir, out] of [[old, 'old.tar.gz'], [next, 'new.tar.gz']]) {
      assert.equal(spawnSync('tar', ['-czf', path.join(tmp, out), '-C', dir, '.'], { encoding: 'utf8' }).status, 0);
    }
    const fromDirs = JSON.parse(python('compare', old, next).stdout);
    const fromArchives = JSON.parse(python('compare', path.join(tmp, 'old.tar.gz'), path.join(tmp, 'new.tar.gz')).stdout);
    assert.equal(fromArchives.fast_path, true);
    // tar -C dir . names members ./x; the release archive names them x. Both read the same.
    assert.deepEqual(fromArchives.changed_static, fromDirs.changed_static);
    assert.equal(fromArchives.node.new, fromDirs.node.new);
  } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
});

// switch-release-files.py against a fake host: releases under a temp root, a fake systemctl, a fake /proc
// and a local HTTP server standing in for NGINX in front of `current`.
function fakeHost({ nodeDir = A, workerDir = null, serveWrong = false, restartOnReload = false } = {}) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'fm388-host-'));
  const app = path.join(tmp, 'opt');
  const changes = { 'public/measure/internal/editor_scripts/wall_mode.js': 'wall(2);\n', 'public/measure/internal/backend_login.php': '<?php echo "login 2";\n' };
  release(path.join(app, 'releases', A), A);
  release(path.join(app, 'releases', B), B, changes);
  fs.symlinkSync(path.join(app, 'releases', A), path.join(app, 'current'));
  fs.mkdirSync(path.join(tmp, 'proc', '4242'), { recursive: true });
  fs.symlinkSync(path.join(app, 'releases', nodeDir, 'public/v1'), path.join(tmp, 'proc', '4242', 'cwd'));
  if (workerDir) {
    // A cluster primary whose worker a rolling replace (FM-389) started in another release.
    fs.mkdirSync(path.join(tmp, 'proc', '4242', 'task', '4242'), { recursive: true });
    fs.writeFileSync(path.join(tmp, 'proc', '4242', 'task', '4242', 'children'), '4343 ');
    fs.mkdirSync(path.join(tmp, 'proc', '4343'), { recursive: true });
    fs.symlinkSync(path.join(app, 'releases', workerDir, 'public/v1'), path.join(tmp, 'proc', '4343', 'cwd'));
  }
  const log = path.join(tmp, 'systemctl.log');
  const systemctl = path.join(tmp, 'systemctl');
  fs.writeFileSync(systemctl, `#!/usr/bin/env bash
echo "$*" >> ${JSON.stringify(log)}
case "$1" in
  is-active) [[ "$3" == firstmeasure-legacy || "$3" == php8.3-fpm ]] ;;
  show) if ${restartOnReload ? 'grep -q "^reload" ' + JSON.stringify(log) : 'false'}; then echo 5151; else echo 4242; fi ;;
  reload) exit 0 ;;
  *) exit 9 ;;
esac
`, { mode: 0o755 });
  const server = http.createServer((request, response) => {
    const url = new URL(request.url, 'http://x');
    if (url.pathname === '/v1/health/ready') { response.end(JSON.stringify({ ok: true, release_id: A })); return; }
    if (url.pathname.endsWith('.php')) { response.end('php'); return; }
    const file = path.join(app, 'current', 'public', url.pathname);
    if (!fs.existsSync(file)) { response.statusCode = 404; response.end(); return; }
    response.end(serveWrong ? 'stale' : fs.readFileSync(file));
  });
  return new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve({
    tmp, app, log, server,
    current: () => path.basename(fs.realpathSync(path.join(app, 'current'))),
    run: (...args) => new Promise(done => {
      const child = spawn('python3', [SWITCH, ...args], { env: { ...process.env, FIRSTMEASURE_ROOT: app, FIRSTMEASURE_SYSTEMCTL: systemctl,
        FIRSTMEASURE_PROC: path.join(tmp, 'proc'), FIRSTMEASURE_LOCAL_HTTP: `http://127.0.0.1:${server.address().port}`, FIRSTMEASURE_NODE_HTTP: `http://127.0.0.1:${server.address().port}` } });
      let out = '';
      child.stdout.on('data', chunk => { out += chunk; });
      child.stderr.on('data', chunk => { out += chunk; });
      child.on('close', status => done({ status, out, lines: out.trim().split('\n').filter(line => line.startsWith('{')).map(line => JSON.parse(line)) }));
    }),
    close: () => { server.close(); fs.rmSync(tmp, { recursive: true, force: true }); }
  })));
}

const reloads = host => fs.readFileSync(host.log, 'utf8').split('\n').filter(line => line.startsWith('reload')).length;

test('switch: --check changes nothing; the switch moves current, reloads PHP-FPM and serves the new files', async () => {
  const host = await fakeHost();
  try {
    const check = await host.run('--check', B, A);
    assert.equal(check.status, 0, check.out);
    assert.equal(host.current(), A);
    assert.equal(reloads(host), 0);

    const done = await host.run(B, A);
    assert.equal(done.status, 0, done.out);
    assert.equal(host.current(), B);
    assert.equal(reloads(host), 1);
    const result = done.lines.at(-1);
    assert.equal(result.switched, B);
    assert.deepEqual(result.node_kept, { 'firstmeasure-legacy': '4242' });
    assert.deepEqual(result.served, { same: 1, not_served: 0 });

    // Rollback is the same switch back: Node still runs from A.
    const back = await host.run(A, B);
    assert.equal(back.status, 0, back.out);
    assert.equal(host.current(), A);
    assert.equal(reloads(host), 2);
  } finally { host.close(); }
});

test('switch: refuses when Node would differ from the release it started in', async () => {
  const host = await fakeHost();
  try {
    write(path.join(host.app, 'releases', B), { 'public/v1/dist/src/server.js': '// server 2\n' });
    const refused = await host.run(B, A);
    assert.equal(refused.status, 3, refused.out);
    assert.equal(host.current(), A);
    assert.equal(reloads(host), 0);
    assert.match(refused.out, /full procedure/);
  } finally { host.close(); }
});

test('switch: compares with the directory Node started in, not with current', async () => {
  // After an earlier fast path, current can be ahead of the release Node runs. Here Node started in B and
  // B's server differs from A's: switching current A -> B matches what Node runs, so no restart is needed.
  const host = await fakeHost({ nodeDir: B });
  try {
    write(path.join(host.app, 'releases', B), { 'public/v1/dist/src/server.js': '// server 2\n' });
    const done = await host.run(B, A);
    assert.equal(done.status, 0, done.out);
    assert.equal(host.current(), B);
    assert.equal(done.lines[0].started_in, B);
  } finally { host.close(); }
});

test('switch: compares with the release the cluster workers run, not the primary (FM-389 rolling replace)', async () => {
  // The primary started in A; a rolling replace moved its workers to B, whose server differs from A's.
  const replaced = await fakeHost({ nodeDir: A, workerDir: B });
  try {
    write(path.join(replaced.app, 'releases', B), { 'public/v1/dist/src/server.js': '// server 2\n' });
    const done = await replaced.run(B, A);
    assert.equal(done.status, 0, done.out);
    assert.equal(replaced.current(), B);
    assert.deepEqual(done.lines.filter(line => line.started_in).map(line => line.started_in), [B]);
  } finally { replaced.close(); }
  // The other way round: the workers still run A, so switching to B would serve code Node does not run.
  const stale = await fakeHost({ nodeDir: B, workerDir: A });
  try {
    write(path.join(stale.app, 'releases', B), { 'public/v1/dist/src/server.js': '// server 2\n' });
    const refused = await stale.run(B, A);
    assert.equal(refused.status, 3, refused.out);
    assert.equal(stale.current(), A);
  } finally { stale.close(); }
});

test('switch: a stale served file or a Node restart switches back', async () => {
  for (const options of [{ serveWrong: true }, { restartOnReload: true }]) {
    const host = await fakeHost(options);
    try {
      const failed = await host.run(B, A);
      assert.equal(failed.status, 1, failed.out);
      assert.equal(host.current(), A, JSON.stringify(options));
      assert.equal(reloads(host), 2, 'PHP-FPM reloaded after the switch and again after switching back');
      assert.equal(failed.lines.at(-1).rolled_back_to, A);
    } finally { host.close(); }
  }
});

test('switch: refuses when current is not the expected release', async () => {
  const host = await fakeHost();
  try {
    const wrong = await host.run(B, 'c'.repeat(40));
    assert.equal(wrong.status, 2, wrong.out);
    assert.equal(host.current(), A);
  } finally { host.close(); }
});
