// The live layer (docs/architecture/live-layer.md): what the droplet's sync sends, and what the web host's
// receiver serves, refuses and retires, with a scratch repository standing in for the checkout and the release.
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync, cpSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import assert from 'node:assert/strict';
import { desiredFiles, liveHash, reconcile } from '../tools/live-layer/live-sync.mjs';

const receiverScript = fileURLToPath(new URL('../tools/live-layer/fm-live-receive.py', import.meta.url));
const python = ['python3', 'python'].find((name) => spawnSync(name, ['--version'], { encoding: 'utf8' }).stdout?.startsWith('Python 3'));

function scratch() {
  const dir = mkdtempSync(path.join(tmpdir(), 'live-layer-'));
  const repo = path.join(dir, 'repo');
  const write = (rel, text) => { mkdirSync(path.dirname(path.join(repo, rel)), { recursive: true }); writeFileSync(path.join(repo, rel), text); };
  const git = (...args) => spawnSync('git', args, { cwd: repo, encoding: 'utf8' });
  mkdirSync(repo);
  git('init', '-q', '-b', 'canonical');
  git('config', 'user.email', 't@example.com'); git('config', 'user.name', 'T'); git('config', 'core.autocrlf', 'false');
  write('public/libraries/a/a.css', '.a{color:red}\n');
  write('public/libraries/b/b.js', 'export const b = 1;\n');
  write('public/portal/index.php', '<?php echo 1;\n');
  write('public/v1/server.ts', 'export {};\n');
  git('add', '-A'); git('commit', '-q', '-m', 'base');
  const release = path.join(dir, 'release');
  cpSync(path.join(repo, 'public'), release, { recursive: true });
  const live = path.join(dir, 'live');
  // The receiver as the sync talks to it, in-process for the test: one request per run, like a line over SSH.
  const receiver = {
    request(body) {
      const run = spawnSync(python, [receiverScript, 'serve'], { input: JSON.stringify({ ...body, id: 1 }) + '\n', encoding: 'utf8', env: { ...process.env, FM_LIVE_DIR: live, FM_RELEASE_PUBLIC: release } });
      return Promise.resolve(JSON.parse(run.stdout.trim().split('\n').at(-1)));
    }
  };
  const manifest = () => JSON.parse(readFileSync(path.join(live, 'manifest.json'), 'utf8'));
  return { dir, repo, release, live, write, receiver, manifest };
}

test('only changed browser files are sent; pages, server code and unchanged files wait or stay', async () => {
  const s = scratch();
  try {
    s.write('public/libraries/a/a.css', '.a{color:blue}\r\n');
    s.write('public/libraries/c/c.svg', '<svg/>');
    s.write('public/portal/index.php', '<?php echo 2;\n');
    s.write('public/v1/server.ts', 'export const x = 1;\n');
    const { files, rollout } = await desiredFiles(s.repo, 'canonical');
    assert.deepEqual(Object.keys(files).sort(), ['libraries/a/a.css', 'libraries/c/c.svg']);
    assert.equal(files['libraries/a/a.css'].sha, liveHash('x.css', Buffer.from('.a{color:blue}\n')), 'line endings are folded');
    assert.equal(files['libraries/a/a.css'].base, liveHash('x.css', Buffer.from('.a{color:red}\n')));
    assert.equal(files['libraries/c/c.svg'].base, null);
    assert.deepEqual(rollout, ['portal/index.php', 'v1/server.ts']);
  } finally { rmSync(s.dir, { recursive: true, force: true }); }
});

test('the receiver serves edits, refuses one the release changed, and retires files on release or revert', { skip: !python && 'needs Python 3' }, async () => {
  const s = scratch();
  const log = [];
  const memo = new Map();
  try {
    s.write('public/libraries/a/a.css', '.a{color:blue}\n');
    s.write('public/libraries/c/c.svg', '<svg/>');
    await reconcile(s.repo, 'canonical', s.receiver, memo, (line) => log.push(line));
    assert.deepEqual(Object.keys(s.manifest().files).sort(), ['libraries/a/a.css', 'libraries/c/c.svg']);
    assert.equal(readFileSync(path.join(s.live, 'public/libraries/a/a.css'), 'utf8'), '.a{color:blue}\n');
    const gen = s.manifest().gen;
    await reconcile(s.repo, 'canonical', s.receiver, memo, (line) => log.push(line));
    assert.equal(s.manifest().gen, gen, 'nothing changed, nothing written');

    // Someone else's release changed b.js after this checkout's base: an edit to it is refused, never served.
    writeFileSync(path.join(s.release, 'libraries/b/b.js'), 'export const b = 2;\n');
    s.write('public/libraries/b/b.js', 'export const b = 3;\n');
    const { results } = await reconcile(s.repo, 'canonical', s.receiver, memo, (line) => log.push(line));
    assert.equal(results.find((r) => r.path === 'libraries/b/b.js').error, 'dev-differs');
    assert.ok(!existsSync(path.join(s.live, 'public/libraries/b/b.js')));
    assert.ok(log.some((line) => line.startsWith('REFUSED  libraries/b/b.js')));

    // A rollout ships a.css: the check retires it as released; a change under c.svg retires it as a conflict.
    writeFileSync(path.join(s.release, 'libraries/a/a.css'), '.a{color:blue}\r\n');
    mkdirSync(path.join(s.release, 'libraries/c'), { recursive: true });
    writeFileSync(path.join(s.release, 'libraries/c/c.svg'), '<svg id="other"/>');
    const checked = await s.receiver.request({ op: 'check' });
    assert.deepEqual(checked.retired, { 'libraries/a/a.css': 'released', 'libraries/c/c.svg': 'conflict' });
    assert.deepEqual(s.manifest().files, {});
    assert.equal(s.manifest().retired['libraries/a/a.css'].reason, 'released');
    assert.ok(!existsSync(path.join(s.live, 'public/libraries/a/a.css')));

    // A file put back to its base leaves the layer.
    rmSync(path.join(s.release, 'libraries/c'), { recursive: true });
    await reconcile(s.repo, 'canonical', s.receiver, new Map(), () => {});
    assert.ok(s.manifest().files['libraries/c/c.svg']);
    rmSync(path.join(s.repo, 'public/libraries/c'), { recursive: true });
    await reconcile(s.repo, 'canonical', s.receiver, new Map(), () => {});
    assert.equal(s.manifest().files['libraries/c/c.svg'], undefined);
    assert.equal(s.manifest().retired['libraries/c/c.svg'].reason, 'reverted');
  } finally { rmSync(s.dir, { recursive: true, force: true }); }
});

test('the receiver writes only browser files inside the layer', { skip: !python && 'needs Python 3' }, async () => {
  const s = scratch();
  try {
    const put = (rel, text) => s.receiver.request({ op: 'batch', ops: [{ op: 'put', path: rel, sha: liveHash(rel, Buffer.from(text)), base: null, data: Buffer.from(text).toString('base64') }] }).then((r) => r.results[0]);
    for (const rel of ['portal/index.php', 'v1/dist/src/server.js', 'storage/x.png', '../etc/x.js', 'libraries/../../x.js', '/abs/x.js', 'libraries/.hidden.js', 'page.html']) {
      assert.equal((await put(rel, 'x')).error, 'not-a-browser-file', rel);
    }
    assert.equal((await s.receiver.request({ op: 'batch', ops: [{ op: 'put', path: 'libraries/z.js', sha: 'f'.repeat(40), base: null, data: 'eA==' }] })).results[0].error, 'bad-content');
    assert.equal((await put('libraries/z/z.js', 'x')).state, 'live');
  } finally { rmSync(s.dir, { recursive: true, force: true }); }
});
