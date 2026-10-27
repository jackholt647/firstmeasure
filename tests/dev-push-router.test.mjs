// The dev push router (docs/architecture/dev-lanes.md) against a scratch origin: submissions from two clones, merging,
// conflicts, gate bisection, lane ownership and live overlays. The lane module is a stand-in that deploys nowhere.
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import assert from 'node:assert/strict';
import { Router } from '../tools/dev-push/router/router.mjs';
import { LANES, parseManifest, laneOf } from '../tools/dev-push/lib/common.mjs';
import { testsFor } from '../tools/dev-push/lanes/platform/test-map.mjs';

const SUBMIT = fileURLToPath(new URL('../tools/dev-push/submit.mjs', import.meta.url));
const BRANCH = LANES.platform.branch;

function sh(cwd, ...args) {
  const run = spawnSync('git', args, { cwd, encoding: 'utf8' });
  if (run.status !== 0) throw new Error(`git ${args.join(' ')}: ${run.stderr}`);
  return run.stdout.trim();
}

function scratch() {
  const dir = mkdtempSync(path.join(tmpdir(), 'dev-push-'));
  const origin = path.join(dir, 'origin.git');
  spawnSync('git', ['init', '-q', '--bare', '-b', BRANCH, origin]);
  const seed = path.join(dir, 'seed');
  sh(dir, 'clone', '-q', origin, seed);
  for (const [k, v] of [['user.email', 't@example.com'], ['user.name', 'T'], ['core.autocrlf', 'false']]) sh(seed, 'config', k, v);
  sh(seed, 'checkout', '-q', '-b', BRANCH);
  mkdirSync(path.join(seed, 'public', 'v1'), { recursive: true });
  writeFileSync(path.join(seed, 'shared.txt'), 'one\ntwo\nthree\n');
  writeFileSync(path.join(seed, 'public', 'v1', 'server.ts'), 'export {};\n');
  sh(seed, 'add', '-A'); sh(seed, 'commit', '-q', '-m', 'base'); sh(seed, 'push', '-q', 'origin', BRANCH);
  const clone = (name) => {
    const target = path.join(dir, name);
    sh(dir, 'clone', '-q', '-b', BRANCH, origin, target);
    for (const [k, v] of [['user.email', `${name}@example.com`], ['user.name', name], ['core.autocrlf', 'false']]) sh(target, 'config', k, v);
    return {
      dir: target,
      edit(rel, text, message = `edit ${rel}`) {
        mkdirSync(path.dirname(path.join(target, rel)), { recursive: true });
        writeFileSync(path.join(target, rel), text);
        sh(target, 'add', '-A'); sh(target, 'commit', '-q', '-m', message);
      },
      submit(...args) {
        const run = spawnSync(process.execPath, [SUBMIT, ...args], { cwd: target, encoding: 'utf8', env: { ...process.env, DEV_PUSH_AGENT: name, DEV_PUSH_STATUS_FILE: path.join(dir, 'state', 'status.json'), CLAUDE_CODE_HOST_SESSION_ID: '', CLAUDE_CODE_SESSION_ID: '' } });
        return { code: run.status, out: run.stdout + run.stderr };
      }
    };
  };
  const deployed = [];
  // Stand-in lane: a tree fails the gate while it holds a file named bad-<id>.txt.
  const lane = {
    name: 'platform', branch: BRANCH, batchMax: 6, owns: (file) => laneOf(file) === 'platform',
    async gates({ dir: tree, only }) {
      const bad = spawnSync('git', ['ls-files', 'bad-*.txt'], { cwd: tree, encoding: 'utf8' }).stdout.split('\n').filter(Boolean).map((file) => `bad:${file}`);
      const failures = bad.filter((id) => !only || only.includes(id)).map((id) => ({ id, output: `${id} is in the tree` }));
      return { ok: failures.length === 0, failures };
    },
    async deploy({ sha, releaseId }) { deployed.push({ sha, releaseId }); return { ok: true, roles: { fake: { tree_sha256: 'x' } } }; }
  };
  const makeRouter = (extra = {}) => new Router({ repo: path.join(dir, 'router.git'), remote: origin, stateDir: path.join(dir, 'state'), lanes: { platform: lane }, quiet: true, ...extra });
  const originFile = (rel) => spawnSync('git', ['show', `${BRANCH}:${rel}`], { cwd: origin, encoding: 'utf8' }).stdout;
  const queueRefs = () => sh(origin, 'for-each-ref', '--format=%(refname)', 'refs/heads/queue/').split('\n').filter(Boolean);
  return { dir, origin, clone, deployed, makeRouter, originFile, queueRefs, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

const drain = async (router) => { await router.init(); while (await router.processLane('platform')) { /* until idle */ } };
const byRef = (router, ref) => Object.values(router.submissions).find((entry) => entry.ref.endsWith(ref));

test('two submissions from different clones land together; queue refs retire', async () => {
  const s = scratch();
  try {
    const a = s.clone('alice'), b = s.clone('bob');
    a.edit('a.txt', 'from alice\n'); b.edit('b.txt', 'from bob\n');
    assert.equal(a.submit('--slug', 'a-change').code, 0);
    assert.equal(b.submit('--slug', 'b-change').code, 0);
    const refs = s.queueRefs();
    assert.deepEqual(refs.sort(), ['refs/heads/queue/platform/alice-a-change', 'refs/heads/queue/platform/bob-b-change']);
    // The submission commit carries the manifest and has the work as its only parent, with the same tree.
    const tip = sh(s.origin, 'rev-parse', 'refs/heads/queue/platform/alice-a-change');
    const manifest = parseManifest(sh(s.origin, 'log', '-1', '--format=%B', tip));
    assert.equal(manifest.lane, 'platform'); assert.equal(manifest.agent, 'alice');
    assert.equal(sh(s.origin, 'rev-parse', `${tip}^{tree}`), sh(s.origin, 'rev-parse', `${tip}^^{tree}`));

    const router = s.makeRouter();
    await drain(router);
    assert.equal(s.deployed.length, 1, 'one release for the batch');
    assert.equal(s.originFile('a.txt'), 'from alice\n');
    assert.equal(s.originFile('b.txt'), 'from bob\n');
    assert.equal(sh(s.origin, 'rev-parse', BRANCH), s.deployed[0].sha, 'lane branch fast-forwarded to the release');
    assert.deepEqual(s.queueRefs(), []);
    assert.equal(byRef(router, 'alice-a-change').state, 'live');
    assert.equal(byRef(router, 'bob-b-change').release, s.deployed[0].releaseId);
    // Manifests never reach the lane branch.
    assert.doesNotMatch(sh(s.origin, 'log', '--format=%s', BRANCH), /^dev-push: /m);
    const status = JSON.parse(readFileSync(path.join(s.dir, 'state', 'status.json'), 'utf8'));
    assert.equal(status.lanes.platform.release.id, s.deployed[0].releaseId);
    // submit --wait style lookup reads the same document.
    const wait = a.submit('wait', 'queue/platform/alice-a-change');
    assert.equal(wait.code, 0, wait.out);
  } finally { s.cleanup(); }
});

test('a conflicting submission comes back rejected with the files; the other lands', async () => {
  const s = scratch();
  try {
    const a = s.clone('alice'), b = s.clone('bob');
    a.edit('shared.txt', 'one\nTWO by alice\nthree\n'); b.edit('shared.txt', 'one\nTWO by bob\nthree\n');
    a.submit('--slug', 'first'); b.submit('--slug', 'second');
    const router = s.makeRouter();
    await drain(router);
    assert.equal(byRef(router, 'alice-first').state, 'live');
    const rejected = byRef(router, 'bob-second');
    assert.equal(rejected.state, 'rejected');
    assert.equal(rejected.reason, 'conflict');
    assert.match(rejected.details, /shared\.txt/);
    assert.match(rejected.details, /git rebase origin\//);
    assert.equal(s.originFile('shared.txt'), 'one\nTWO by alice\nthree\n');
    assert.deepEqual(s.queueRefs(), []);
    const wait = b.submit('wait', 'queue/platform/bob-second');
    assert.equal(wait.code, 1);
    assert.match(wait.out, /rejected \(conflict\)/);
  } finally { s.cleanup(); }
});

test('a failing batch is bisected: only the bad submission is rejected', async () => {
  const s = scratch();
  try {
    const a = s.clone('alice'), b = s.clone('bob'), c = s.clone('carol');
    a.edit('a.txt', 'a\n'); b.edit('bad-b.txt', 'breaks the gate\n'); c.edit('c.txt', 'c\n');
    a.submit('--slug', 'a'); b.submit('--slug', 'b'); c.submit('--slug', 'c');
    const router = s.makeRouter();
    await drain(router);
    assert.equal(byRef(router, 'alice-a').state, 'live');
    assert.equal(byRef(router, 'carol-c').state, 'live');
    const bad = byRef(router, 'bob-b');
    assert.equal(bad.state, 'rejected'); assert.equal(bad.reason, 'gate-failed');
    assert.match(bad.details, /bad:bad-b\.txt/);
    assert.equal(s.originFile('bad-b.txt'), '');
    assert.equal(s.deployed.length, 1);
  } finally { s.cleanup(); }
});

test('a failure the lane tip already has does not reject a submission', async () => {
  const s = scratch();
  try {
    const seed = s.clone('seed2');
    seed.edit('bad-old.txt', 'already broken\n');
    sh(seed.dir, 'push', '-q', 'origin', BRANCH);
    const a = s.clone('alice');
    a.edit('a.txt', 'a\n');
    a.submit('--slug', 'a');
    const router = s.makeRouter();
    await drain(router);
    assert.equal(byRef(router, 'alice-a').state, 'live');
  } finally { s.cleanup(); }
});

const measureLaneBuilt = laneOf('public/measure/internal/x.js') === 'measure-internal';

test('lanes: submit refuses mixed lanes; the router rejects out-of-lane work', async () => {
  const s = scratch();
  const saved = process.env.DEV_PUSH_LANES;
  process.env.DEV_PUSH_LANES = 'platform,measure-internal'; // as once lanes/measure-internal/lane.mjs exists
  try {
    const a = s.clone('alice');
    a.edit('public/measure/internal/editor.js', 'x\n'); a.edit('public/v1/other.ts', 'y\n');
    const mixed = a.submit('--slug', 'mixed');
    assert.equal(mixed.code, 1); assert.match(mixed.out, /more than one lane/);
    const forced = a.submit('--slug', 'mixed', '--lane', 'platform');
    assert.equal(forced.code, 1); assert.match(forced.out, /does not own/);
    // Pushed by hand past submit: the router rejects it.
    sh(a.dir, 'push', '-q', 'origin', `HEAD:refs/heads/queue/platform/alice-by-hand`);
    const router = s.makeRouter();
    await drain(router);
    const entry = byRef(router, 'alice-by-hand');
    assert.equal(entry.state, 'rejected'); assert.equal(entry.reason, 'out-of-lane');
    assert.match(entry.details, /public\/measure\/internal\/editor\.js/);
  } finally { if (saved === undefined) delete process.env.DEV_PUSH_LANES; else process.env.DEV_PUSH_LANES = saved; s.cleanup(); }
});

test('live overlays are merged into the release and reported back', async () => {
  const s = scratch();
  try {
    const owner = s.clone('owner');
    owner.edit('public/libraries/x.css', '.x{}\n', 'live save');
    const overlaySha = sh(owner.dir, 'rev-parse', 'HEAD');
    sh(owner.dir, 'push', '-q', 'origin', `HEAD:refs/heads/live/owner`);
    const a = s.clone('alice');
    a.edit('a.txt', 'a\n'); a.submit('--slug', 'a');
    const told = [];
    const router = s.makeRouter({
      overlays: async (tip, r) => { await r.git(['fetch', '-q', 'origin', '+refs/heads/live/owner:refs/live/owner']); return told.length ? [] : [{ ref: 'live/owner', sha: overlaySha, owner: 'owner', parked: false, files: { 'libraries/x.css': 'h' } }]; },
      afterRelease: async ({ overlays }) => { told.push(...overlays); }
    });
    await drain(router);
    assert.equal(s.originFile('public/libraries/x.css'), '.x{}\n');
    assert.equal(s.originFile('a.txt'), 'a\n');
    assert.deepEqual(told.map((overlay) => overlay.ref), ['live/owner']);
    assert.deepEqual(router.releases[0].overlays, ['live/owner']);
  } finally { s.cleanup(); }
});

test('test map: areas, changed tests and requested tests', () => {
  const ids = testsFor(['public/v1/forms/runtime.ts', 'public/v1/tests/foo.test.ts', 'tests/live-layer.test.mjs', 'tools/dev-push/router/router.mjs'], ['tests/bar.test.ts']);
  assert.ok(ids.includes('v1:tests/forms-api.test.ts'));
  assert.ok(ids.includes('v1:tests/foo.test.ts'));
  assert.ok(ids.includes('root:tests/live-layer.test.mjs'));
  assert.ok(ids.includes('root:tests/dev-push-router.test.mjs'));
  assert.ok(ids.includes('any:tests/bar.test.ts'));
  assert.equal(laneOf('public/measure/internal/editor_scripts/a.js'), measureLaneBuilt ? 'measure-internal' : 'platform');
  assert.equal(laneOf('public/measure/sales/a.js'), 'platform');
});

test('a dev rollout record in the submission is refused', async () => {
  const s = scratch();
  try {
    const a = s.clone('alice');
    a.edit('a.txt', 'a\n'); a.edit('deploy/digitalocean/development-a-20261027.md', 'record\n');
    a.submit('--slug', 'with-record');
    const router = s.makeRouter();
    await drain(router);
    const entry = byRef(router, 'alice-with-record');
    assert.equal(entry.state, 'rejected'); assert.equal(entry.reason, 'policy');
    assert.equal(s.deployed.length, 0);
  } finally { s.cleanup(); }
});

test('a release whose lane push fails holds the lane until the push succeeds', async () => {
  const s = scratch();
  try {
    // The origin refuses updates of the lane branch while a flag file exists.
    const flag = path.join(s.dir, 'refuse');
    writeFileSync(flag, '1');
    writeFileSync(path.join(s.origin, 'hooks', 'pre-receive'), `#!/bin/sh\nwhile read old new ref; do if [ "$ref" = "refs/heads/${BRANCH}" ] && [ -f "${flag.replaceAll('\\', '/')}" ]; then echo refused >&2; exit 1; fi; done\nexit 0\n`, { mode: 0o755 });
    const a = s.clone('alice'), b = s.clone('bob');
    a.edit('a.txt', 'a\n'); a.submit('--slug', 'a');
    const router = s.makeRouter();
    await router.init();
    assert.equal(await router.processLane('platform'), true);
    assert.equal(s.deployed.length, 1, 'released');
    assert.equal(s.originFile('a.txt'), '', 'branch not advanced');
    b.edit('b.txt', 'b\n'); b.submit('--slug', 'b');
    assert.equal(await router.processLane('platform'), false, 'held while the push fails');
    assert.equal(s.deployed.length, 1);
    assert.equal(router.laneState.platform.state, 'paused');
    rmSync(flag);
    await drain(router);
    assert.equal(s.originFile('a.txt'), 'a\n');
    assert.equal(s.originFile('b.txt'), 'b\n');
    assert.equal(s.deployed.length, 2);
  } finally { s.cleanup(); }
});

test('a parked overlay that cannot merge is reported once, not retried in a loop', async () => {
  const s = scratch();
  try {
    const owner = s.clone('owner');
    owner.edit('shared.txt', 'one\nTWO live\nthree\n', 'live save');
    const overlaySha = sh(owner.dir, 'rev-parse', 'HEAD');
    sh(owner.dir, 'push', '-q', 'origin', 'HEAD:refs/heads/live/owner');
    const seed = s.clone('seed2');
    seed.edit('shared.txt', 'one\nTWO released\nthree\n');
    sh(seed.dir, 'push', '-q', 'origin', BRANCH);
    const problems = [];
    const router = s.makeRouter({
      overlays: async (tip, r) => { await r.git(['fetch', '-q', 'origin', '+refs/heads/live/owner:refs/live/owner']); return [{ ref: 'live/owner', sha: overlaySha, owner: 'owner', parked: true, files: { 'shared.txt': 'h' } }]; },
      overlayProblems: async (list) => { problems.push(...list); }
    });
    await router.init();
    assert.equal(await router.processLane('platform'), false);
    assert.equal(await router.processLane('platform'), false, 'second pass skips the known failure');
    assert.equal(problems.length, 1);
    assert.equal(s.deployed.length, 0);
    assert.match(router.laneState.platform.note, /need review/);
  } finally { s.cleanup(); }
});
