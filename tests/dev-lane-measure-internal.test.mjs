// The measure-internal dev lane (docs/architecture/dev-lanes.md): which paths it owns, the release
// manifest built from git blobs, the quick checks every ship runs, which editor tests a regression run
// picks and how a failure canonical already has is told apart, and the router's lane module. A scratch
// repository stands in for the checkout.
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import assert from 'node:assert/strict';
import lane, { LANE, ownsPath, manifest, mappedTests, runGates, laneCommit, quickChecks, buildTree, treeManifest } from '../tools/dev-push/lanes/measure-internal/lane.mjs';

const hostScript = fileURLToPath(new URL('../tools/dev-push/lanes/measure-internal/lane-host.sh', import.meta.url));

function scratch() {
  const repo = mkdtempSync(path.join(tmpdir(), 'lane-mi-'));
  const write = (rel, data) => { mkdirSync(path.dirname(path.join(repo, rel)), { recursive: true }); writeFileSync(path.join(repo, rel), data); };
  const git = (...args) => { const r = spawnSync('git', args, { cwd: repo, encoding: 'utf8' }); assert.equal(r.status, 0, r.stderr); return r.stdout.trim(); };
  git('init', '-q', '-b', 'lane');
  git('config', 'user.email', 't@example.com'); git('config', 'user.name', 'T'); git('config', 'core.autocrlf', 'false');
  const commit = (message) => { git('add', '-A'); git('commit', '-q', '-m', message); return git('rev-parse', 'HEAD'); };
  mkdirSync(path.join(repo, 'public/v1/node_modules'), { recursive: true });
  return { repo, write, git, commit, done: () => rmSync(repo, { recursive: true, force: true }) };
}

const passing = (name) => `const test=require('node:test');const fs=require('node:fs');test('${name}',()=>{fs.readFileSync('public/measure/internal/editor_scripts/${name}');});\n`;

test('the lane owns the editor and its dev tests, nothing else', () => {
  assert.ok(ownsPath('public/measure/internal/editor_scripts/wall_mode.js'));
  assert.ok(ownsPath('dev/wall-mode.test.cjs'));
  assert.ok(!ownsPath('public/measure/internals.js'));
  assert.ok(!ownsPath('public/v1/firstmeasure/api.ts'));
  assert.ok(!ownsPath('public/libraries/report-units.js'));
  assert.equal(LANE.deploys, 'public/measure/internal');
});

test('the manifest hashes the committed bytes, CRLF and binary included', () => {
  const s = scratch();
  try {
    const crlf = 'a\r\nb\r\n';
    const binary = Buffer.from([0xff, 0xd8, 0x0d, 0x0a, 0x00, 0x01]);
    s.write('public/measure/internal/old.js', crlf);
    s.write('public/measure/internal/rendered_assets/x.jpg', binary);
    s.write('public/measure/internal/index.php', '<?php echo 1;\n');
    s.write('dev/a.test.cjs', passing('old.js'));
    s.write('public/v1/api.ts', 'export {};\n');
    const sha = s.commit('base');
    const files = manifest(sha, s.repo);
    const hex = (data) => createHash('sha256').update(data).digest('hex');
    assert.deepEqual(Object.keys(files).sort(), ['index.php', 'old.js', 'rendered_assets/x.jpg']);
    assert.equal(files['old.js'], hex(crlf));
    assert.equal(files['rendered_assets/x.jpg'], hex(binary));
  } finally { s.done(); }
});

test('a change runs the tests it touches and the tests that name a changed file', () => {
  const s = scratch();
  try {
    s.write('public/measure/internal/editor_scripts/wall_mode.js', '1;\n');
    s.write('public/measure/internal/editor_scripts/maps.js', '1;\n');
    s.write('dev/wall-mode.test.cjs', passing('wall_mode.js'));
    s.write('dev/maps.test.cjs', passing('maps.js'));
    s.write('dev/helper.cjs', 'module.exports = 1;\n');
    s.write('dev/other.test.cjs', "require('./helper.cjs');\n");
    const base = s.commit('base');
    s.write('public/measure/internal/editor_scripts/wall_mode.js', '2;\n');
    const one = s.commit('wall');
    assert.deepEqual(mappedTests(base, one, s.repo), ['dev/wall-mode.test.cjs']);
    s.write('dev/helper.cjs', 'module.exports = 2;\n');
    s.write('dev/maps.test.cjs', passing('maps.js') + '// touched\n');
    const two = s.commit('helper');
    assert.deepEqual(mappedTests(one, two, s.repo), ['dev/maps.test.cjs', 'dev/other.test.cjs']);
    assert.deepEqual(mappedTests(null, two, s.repo), ['dev/maps.test.cjs', 'dev/other.test.cjs', 'dev/wall-mode.test.cjs']);
  } finally { s.done(); }
});

test('regression tests block a new failure and let one the live release already has through', async () => {
  const s = scratch();
  try {
    const failing = "require('node:test')('broken',()=>{throw new Error('no');});\n";
    s.write('public/measure/internal/editor_scripts/a.js', '1;\n');
    s.write('public/measure/internal/editor_scripts/b.js', '1;\n');
    s.write('dev/a.test.cjs', failing.replace('broken', 'a.js'));
    s.write('dev/b.test.cjs', passing('b.js'));
    s.write('public/v1/firstmeasure/api.ts', 'export const x = 1;\n');
    const base = s.commit('base');
    s.write('public/measure/internal/editor_scripts/a.js', '2;\n');
    s.write('public/measure/internal/editor_scripts/b.js', '2;\n');
    s.write('dev/b.test.cjs', "require('node:test')('b.js reads api.ts',()=>{require('node:fs').readFileSync('public/v1/firstmeasure/api.ts');throw new Error('regressed');});\n");
    const head = s.commit('change');
    const gates = await runGates({ sha: head, base, cwd: s.repo, log: () => {} });
    assert.deepEqual(gates.ran, ['dev/a.test.cjs', 'dev/b.test.cjs']);
    assert.deepEqual(gates.known, ['dev/a.test.cjs']);
    assert.deepEqual(gates.failed, ['dev/b.test.cjs']);
  } finally { s.done(); }
});

test('an editor commit from any branch lands on the lane tip with only lane paths taken', () => {
  const s = scratch();
  try {
    s.write('public/measure/internal/a.js', '1;\n');
    s.write('public/measure/internal/b.js', 'b1;\n');
    s.write('public/v1/api.ts', 'v1;\n');
    s.write('dev/a.test.cjs', 'a;\n');
    const fork = s.commit('fork');
    s.git('branch', 'canonical');
    s.write('public/measure/internal/b.js', 'b2;\n');
    const tip = s.commit('lane edits b');
    assert.equal(laneCommit(tip, tip, s.repo), null);
    s.write('public/measure/internal/a.js', '2;\n');
    const onLane = s.commit('lane edits a');
    assert.equal(laneCommit(onLane, tip, s.repo), onLane, 'a lane-only commit on the tip ships as is');

    s.git('checkout', '-q', 'canonical');
    s.write('public/measure/internal/a.js', '3;\n');
    s.write('dev/a.test.cjs', 'a2;\n');
    s.write('public/v1/api.ts', 'v2;\n');
    const canonical = s.commit('canonical edits a and api');
    const made = laneCommit(canonical, tip, s.repo);
    assert.equal(s.git('rev-parse', `${made}^`), tip);
    assert.equal(s.git('show', `${made}:public/measure/internal/a.js`), '3;');
    assert.equal(s.git('show', `${made}:public/measure/internal/b.js`), 'b2;', 'the lane keeps its own editor change');
    assert.equal(s.git('show', `${made}:dev/a.test.cjs`), 'a2;');
    assert.equal(s.git('show', `${made}:public/v1/api.ts`), 'v1;', 'platform paths stay as on the lane');
    assert.match(s.git('log', '-1', '--format=%B', made), /canonical edits a and api/);

    s.write('public/measure/internal/b.js', 'b3;\n');
    const clash = s.commit('canonical edits b too');
    assert.throws(() => laneCommit(clash, tip, s.repo), /conflicts with lane\/measure-internal in:\n {2}public\/measure\/internal\/b\.js/);
    assert.ok(fork);
  } finally { s.done(); }
});

test('every ship lints and syntax-checks the changed editor files, in about a second', async () => {
  const s = scratch();
  try {
    s.write('public/measure/internal/editor_scripts/a.js', 'window.a = 1;\n');
    s.write('public/measure/internal/editor_scripts/b.js', 'window.b = 1;\n');
    s.write('public/measure/internal/unused/old.js', 'this is retired and does not parse\n');
    const base = s.commit('base');
    s.write('public/measure/internal/editor_scripts/a.js', 'window.a = ;\n');
    const broken = s.commit('broken a');
    const checks = await quickChecks({ sha: broken, base, cwd: s.repo });
    assert.equal(checks.ok, false);
    assert.deepEqual(checks.failures.map((failure) => failure.id), ['node-check:public/measure/internal/editor_scripts/a.js']);
    assert.equal(checks.js, 1, 'only the changed file is checked; unused/ never');
    s.write('public/measure/internal/editor_scripts/a.js', 'window.a = 2;\n');
    const fixed = s.commit('fixed a');
    const gates = await lane.gates({ dir: s.repo, sha: fixed, baseSha: broken, changed: [], tests: [] });
    assert.equal(gates.ok, true);
    assert.deepEqual(Object.keys(gates.timings), ['checks'], 'no regression tests unless a submission asks');
  } finally { s.done(); }
});

test('the router module names the lane, its branch and what it owns', () => {
  assert.equal(lane.name, 'measure-internal');
  assert.equal(lane.branch, 'lane/measure-internal');
  assert.ok(lane.owns('public/measure/internal/editor.php'));
  assert.ok(!lane.owns('public/v1/firstmeasure/pdf_runtime.ts'));
  for (const key of ['gates', 'deploy', 'current']) assert.equal(typeof lane[key], 'function');
});

test('the release tree is the commit\'s editor plus links into the platform release', { skip: process.platform === 'win32' && 'symlinks need Linux (the router host)' }, () => {
  const s = scratch();
  try {
    s.write('public/measure/internal/editor.php', '<?php echo 1;\n');
    s.write('public/measure/sales/index.php', '<?php echo 2;\n');
    s.write('public/portal/index.php', '<?php echo 3;\n');
    s.write('public/v1/api.ts', 'export {};\n');
    const sha = s.commit('base');
    const out = path.join(s.repo, '..', `${path.basename(s.repo)}-tree`);
    try {
      buildTree(sha, s.repo, out);
      const tree = treeManifest(out);
      assert.deepEqual(Object.keys(tree.files), ['public/measure/internal/editor.php']);
      assert.deepEqual(tree.links, {
        'public/measure/sales': '/opt/firstmeasure/current/public/measure/sales',
        'public/portal': '/opt/firstmeasure/current/public/portal',
        'public/storage': '/opt/firstmeasure/current/public/storage',
        'public/v1': '/opt/firstmeasure/current/public/v1'
      });
    } finally { rmSync(out, { recursive: true, force: true }); }
  } finally { s.done(); }
});

test('the host script parses', () => {
  const r = spawnSync('bash', ['-n', hostScript], { encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
});
