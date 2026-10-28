// The dev web pool with nobody watching (docs/architecture/dev-lanes.md, "New web nodes"): the router promotes a
// member when the primary web node is gone, copies the live layer to every web node, brings a node that fell behind
// up to date, and does not adopt a destroyed node again. Hosts are stand-ins; each node's live receiver is the real
// fm-live-receive.py over its own scratch folders.
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import assert from 'node:assert/strict';
import { makeFleet } from '../tools/dev-push/router/fleet.mjs';
import { liveHash } from '../tools/live-layer/live-sync.mjs';

const receiverScript = fileURLToPath(new URL('../tools/live-layer/fm-live-receive.py', import.meta.url));
const python = ['python3', 'python'].find((name) => spawnSync(name, ['--version'], { encoding: 'utf8' }).stdout?.startsWith('Python 3'));
process.env.DEV_PUSH_PUBLIC_URL = 'http://127.0.0.1:9'; // nothing answers: the public sample sees no instances

function pool(nodes) {
  const dir = mkdtempSync(path.join(tmpdir(), 'dev-push-fleet-'));
  const stateDir = path.join(dir, 'state');
  mkdirSync(stateDir);
  const node = {};
  for (const name of nodes) {
    const release = path.join(dir, name, 'release');
    mkdirSync(path.join(release, 'libraries'), { recursive: true });
    writeFileSync(path.join(release, 'libraries', 'a.css'), '.a{color:red}\n');
    node[name] = { up: true, current: { platform: 'r1' }, release, live: path.join(dir, name, 'live') };
  }
  const inventory = {};
  const hosts = {
    get roles() { return Object.keys(inventory); },
    addRole(role, address) { inventory[role] = address; },
    removeRole(role) { delete inventory[role]; },
    addresses() { return { ...inventory }; },
    async status(role, lane = 'platform') {
      const host = node[String(inventory[role]).split('@').pop()];
      if (!host?.up) return { ok: false, error: 'ssh: connect timed out' };
      return { ok: true, lanes: { [lane]: { current: host.current[lane] || null } } };
    }
  };
  const caughtUp = [];
  const router = {
    stateDir, lanes: { platform: {} }, fleet: null, live: null,
    laneState: { platform: { state: 'idle', release: { name: 'r1', sha: 'r1' } } },
    async catchUp(lane, role) {
      const host = node[String(inventory[role]).split('@').pop()];
      caughtUp.push(role);
      host.current[lane] = router.laneState[lane].release.name;
      return { ok: true };
    },
    async saveStatus() {}
  };
  // A node's receiver as the router reaches it: one request per run, like a session over SSH.
  const receiver = (ip) => async (ops) => ops.map((op, index) => {
    const host = node[ip];
    if (!host.up) return { ok: false, error: 'no answer' };
    const run = spawnSync(python, [receiverScript, 'serve'], { input: JSON.stringify({ ...op, id: index + 1 }) + '\n', encoding: 'utf8', env: { ...process.env, FM_LIVE_DIR: host.live, FM_RELEASE_PUBLIC: host.release } });
    return JSON.parse(run.stdout.trim().split('\n').at(-1));
  });
  const save = async (name, source, rel, text, base) => (await receiver(name)([{ op: 'batch', source, ops: [{ op: 'put', path: rel, sha: liveHash(rel, Buffer.from(text)), base, data: Buffer.from(text).toString('base64') }] }]))[0].results[0];
  const served = (name, rel) => { const file = path.join(node[name].live, 'public', rel); return existsSync(file) ? readFileSync(file, 'utf8') : null; };
  const lines = [];
  const fleet = (state) => {
    if (state) writeFileSync(path.join(stateDir, 'fleet.json'), JSON.stringify(state));
    return makeFleet({ router, hosts, receiver, log: (line) => lines.push(line) });
  };
  return { dir, stateDir, node, hosts, router, caughtUp, fleet, save, served, lines, receiver, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

const red = liveHash('a.css', Buffer.from('.a{color:red}\n'));

test('the primary web node goes away: after three failed checks a healthy member is promoted', { skip: !python && 'needs Python 3' }, async () => {
  const p = pool(['a', 'b']);
  try {
    const fleet = p.fleet({ primary: 'root@a', adopted: { 'web-b': 'root@b' } });
    assert.equal((await p.save('a', 'pc:one', 'libraries/a.css', '.a{color:blue}\n', red)).ok, true);
    assert.equal(await fleet.check(), true);
    assert.equal(p.served('b', 'libraries/a.css'), '.a{color:blue}\n', 'the member serves the save too');

    p.node.a.up = false;
    assert.equal(await fleet.check(), false, 'a failing primary is checked again soon');
    assert.equal(await fleet.check(), false);
    assert.equal(p.hosts.addresses().web, 'root@a', 'not yet: two failures');
    assert.ok(p.hosts.down.has('web'), 'status publishing skips it meanwhile');
    await fleet.check();
    assert.equal(p.hosts.addresses().web, 'root@b', 'promoted');
    assert.equal(p.hosts.addresses()['web-a'], 'root@a', 'the old primary stays a member until it is dropped');
    assert.ok(p.hosts.down.has('web-a'));
    assert.ok(p.lines.some((line) => /promoted root@b/.test(line)));
    assert.equal(p.served('b', 'libraries/a.css'), '.a{color:blue}\n', 'the save survives the failover');
    const state = JSON.parse(readFileSync(path.join(p.stateDir, 'fleet.json'), 'utf8'));
    assert.equal(state.primary, 'root@b');
    assert.ok(state.unreachable['web-a']);
    assert.deepEqual(p.router.live.targets.map((item) => item.target), ['fmlive@b'], 'live-sync clients are pointed at the new primary only');
  } finally { p.cleanup(); }
});

test('with no other web node the primary stays, and the next registered node takes over', { skip: !python && 'needs Python 3' }, async () => {
  const p = pool(['a', 'c']);
  try {
    const fleet = p.fleet({ primary: 'root@a', adopted: {} });
    p.node.a.up = false;
    for (let i = 0; i < 4; i++) await fleet.check();
    assert.equal(p.hosts.addresses().web, 'root@a');
    assert.ok(p.router.fleet.problems.some((problem) => /no other web node answers/.test(problem)));
    p.node.c.current.platform = 'r0';
    writeFileSync(path.join(p.stateDir, 'registrations.jsonl'), JSON.stringify({ id: '7', public: 'c', private: null }) + '\n');
    await fleet.check();
    assert.ok(p.caughtUp.includes('pending-7'), 'the new node is brought to the current release first');
    assert.equal(p.node.c.current.platform, 'r1');
    for (let i = 0; i < 3 && p.hosts.addresses().web !== 'root@c'; i++) await fleet.check();
    assert.equal(p.hosts.addresses().web, 'root@c');
  } finally { p.cleanup(); }
});

test('the live layer is copied from the primary: missing saves, an orphan with no sync, stale and removed files', { skip: !python && 'needs Python 3' }, async () => {
  const p = pool(['a', 'b']);
  try {
    const fleet = p.fleet({ primary: 'root@a', adopted: { 'web-b': 'root@b' } });
    await p.save('a', 'pc:one', 'libraries/a.css', '.a{color:blue}\n', red);
    await p.save('a', 'droplet:two', 'libraries/new.js', 'export const n = 1;\n', null);
    await p.save('b', 'pc:one', 'libraries/old.js', 'export const old = 1;\n', null); // the primary no longer has it
    const manifest = path.join(p.node.b.live, 'manifest.json');
    const aged = JSON.parse(readFileSync(manifest, 'utf8'));
    aged.files['libraries/old.js'].at -= 120;
    writeFileSync(manifest, JSON.stringify(aged));
    await fleet.check();
    assert.equal(p.served('b', 'libraries/a.css'), '.a{color:blue}\n');
    assert.equal(p.served('b', 'libraries/new.js'), 'export const n = 1;\n');
    assert.equal(p.served('b', 'libraries/old.js'), null, 'what the primary removed is removed');
    const listed = (await p.receiver('b')([{ op: 'list' }]))[0].files;
    assert.equal(listed['libraries/new.js'].source, 'droplet:two', 'each file keeps its owner, so its sync can keep editing it');
    // A save that reached a member a moment before the primary is left alone.
    await p.save('b', 'pc:one', 'libraries/fresh.js', 'export const f = 1;\n', null);
    await fleet.check();
    assert.equal(p.served('b', 'libraries/fresh.js'), 'export const f = 1;\n');
  } finally { p.cleanup(); }
});

test('a member left out of a release is brought up to date; a destroyed node is dropped and never adopted again', { skip: !python && 'needs Python 3' }, async () => {
  const p = pool(['a', 'b', 'd']);
  try {
    writeFileSync(path.join(p.stateDir, 'registrations.jsonl'), JSON.stringify({ id: '9', public: 'd', private: null }) + '\n');
    const fleet = p.fleet({ primary: 'root@a', adopted: { 'web-b': 'root@b', 'web-9': 'root@d' } });
    p.node.b.current.platform = 'r0';
    await fleet.check();
    assert.ok(p.caughtUp.includes('web-b'));
    assert.equal(p.node.b.current.platform, 'r1');

    p.node.d.up = false;
    await fleet.check();
    assert.ok(p.hosts.down.has('web-9'));
    const state = JSON.parse(readFileSync(path.join(p.stateDir, 'fleet.json'), 'utf8'));
    state.unreachable['web-9'] -= 16 * 60_000;
    const again = p.fleet(state);
    await again.check();
    assert.equal(p.hosts.addresses()['web-9'], undefined, 'dropped');
    p.caughtUp.length = 0;
    await again.check();
    await again.check();
    assert.equal(p.caughtUp.includes('pending-9'), false, 'its old registration does not bring it back');
    assert.equal(p.hosts.addresses()['pending-9'], undefined);
  } finally { p.cleanup(); }
});
