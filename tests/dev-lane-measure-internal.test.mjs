// The measure-internal dev lane (docs/architecture/dev-lanes.md): which paths it owns, the release
// manifest built from git blobs, which editor tests a change runs, and how a failure that canonical
// already has is told apart from a regression. A scratch repository stands in for the checkout.
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import assert from 'node:assert/strict';
import { LANE, ownsPath, manifest, mappedTests, runGates, laneCommit } from '../tools/dev-push/lanes/measure-internal/lane.mjs';

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

test('gates block a new failure and let one the live release already has through', async () => {
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
    const none = await runGates({ sha: head, base, cwd: s.repo, tests: 'none' });
    assert.deepEqual(none.ran, []);
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

test('the host script parses', () => {
  const r = spawnSync('bash', ['-n', hostScript], { encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
});
