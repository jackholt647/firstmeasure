// The live layer (docs/architecture/live-layer.md): what the droplet's sync sends, and what the web host's
// receiver serves, refuses and retires, with a scratch repository standing in for the checkout and the release.
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync, cpSync, utimesSync } from 'node:fs';
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
  // A save as a sync sends it, straight to the receiver; a file the next release has.
  const put = (source, rel, text, base, extra = {}) => receiver.request({ op: 'batch', source, ops: [{ op: 'put', path: rel, sha: liveHash(rel, Buffer.from(text)), base, data: Buffer.from(text).toString('base64'), ...extra }] }).then((r) => r.results[0]);
  const releaseFile = (rel, text) => { mkdirSync(path.dirname(path.join(release, rel)), { recursive: true }); writeFileSync(path.join(release, rel), text); };
  return { dir, repo, release, live, write, receiver, manifest, put, releaseFile };
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

    // A rollout ships a.css: the check retires it as released; a change under c.svg parks it.
    writeFileSync(path.join(s.release, 'libraries/a/a.css'), '.a{color:blue}\r\n');
    mkdirSync(path.join(s.release, 'libraries/c'), { recursive: true });
    writeFileSync(path.join(s.release, 'libraries/c/c.svg'), '<svg id="other"/>');
    const checked = await s.receiver.request({ op: 'check' });
    assert.deepEqual(checked.retired, { 'libraries/a/a.css': 'released', 'libraries/c/c.svg': 'parked' });
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

test('two checkouts share the layer: each keeps its own files and cannot overwrite each other', { skip: !python && 'needs Python 3' }, async () => {
  const one = scratch();
  try {
    const log = [];
    const other = path.join(one.dir, 'other');
    spawnSync('git', ['clone', '-q', one.repo, other]);
    spawnSync('git', ['branch', '-q', 'canonical', 'origin/canonical'], { cwd: other });
    one.write('public/libraries/a/a.css', '.a{color:blue}\n');
    await reconcile(one.repo, 'canonical', one.receiver, new Map(), () => {}, 'pc');
    mkdirSync(path.join(other, 'public/libraries/c'), { recursive: true });
    writeFileSync(path.join(other, 'public/libraries/c/c.svg'), '<svg/>');
    writeFileSync(path.join(other, 'public/libraries/a/a.css'), '.a{color:green}\n');
    const { results } = await reconcile(other, 'canonical', one.receiver, new Map(), (line) => log.push(line), 'droplet');
    assert.equal(results.find((r) => r.path === 'libraries/a/a.css').error, 'owned-by-other');
    assert.ok(log.some((line) => line.includes('pc has its own copy live')));
    const files = one.manifest().files;
    assert.deepEqual(Object.keys(files).sort(), ['libraries/a/a.css', 'libraries/c/c.svg']);
    assert.equal(files['libraries/a/a.css'].source, 'pc');
    assert.equal(files['libraries/c/c.svg'].source, 'droplet');
    assert.equal(readFileSync(path.join(one.live, 'public/libraries/a/a.css'), 'utf8'), '.a{color:blue}\n');
    // The pc's next pass leaves the droplet's file alone; a forced remove takes the pc's out.
    await reconcile(one.repo, 'canonical', one.receiver, new Map(), () => {}, 'pc');
    assert.ok(one.manifest().files['libraries/c/c.svg']);
    assert.equal((await one.receiver.request({ op: 'batch', source: 'droplet', ops: [{ op: 'remove', path: 'libraries/a/a.css' }] })).results[0].error, 'owned-by-other');
    assert.equal((await one.receiver.request({ op: 'batch', source: 'droplet', ops: [{ op: 'remove', path: 'libraries/a/a.css', force: true }] })).results[0].state, 'removed');
    await reconcile(other, 'canonical', one.receiver, new Map(), () => {}, 'droplet');
    assert.equal(one.manifest().files['libraries/a/a.css'].source, 'droplet');
  } finally { rmSync(one.dir, { recursive: true, force: true }); }
});

test('a script edit that only touches its injected CSS swaps that <style> in place; anything else reloads', async () => {
  const { swapInlineStyle } = await import('../public/libraries/live-assets/live-assets.js');
  const source = (css, extra = '') => `const COLOR = '#667085';\nconst STYLES = \`\n  .tray{border:1px solid ${'${COLOR}'};padding:12px}\n  .title{color:${css}}\n\`;\nfunction draw(){ return 1${extra}; }\n`;
  const run = async (before, after) => {
    const realFetch = globalThis.fetch;
    globalThis.fetch = async (_url, { cache }) => ({ ok: true, text: async () => (cache === 'force-cache' ? before : after) });
    const style = { textContent: `\n  .tray{border:1px solid #667085;padding:12px}\n  .title{color:#101828}\n`, ownerDocument: { defaultView: { MutationObserver: class { observe() {} } } } };
    const win = { document: { querySelectorAll: () => [style] } };
    try { return { swapped: await swapInlineStyle(win, 'libraries/apps/x/app.js', new Set(['https://dev.1m8.ai/libraries/apps/x/app.js?v=1'])), css: style.textContent }; }
    finally { globalThis.fetch = realFetch; }
  };
  const css = await run(source('#101828'), source('#2563eb'));
  assert.equal(css.swapped, true);
  assert.equal(css.css, `\n  .tray{border:1px solid #667085;padding:12px}\n  .title{color:#2563eb}\n`, 'the page keeps its own ${COLOR} value');
  assert.equal((await run(source('#101828'), source('#101828', ' + 1'))).swapped, false, 'logic changed');
  assert.equal((await run(source('#101828'), source('#2563eb', ' + 1'))).swapped, false, 'CSS and logic changed');
  assert.equal((await run(source('#101828'), source('#101828').replace('${COLOR}', '${OTHER}'))).swapped, false, 'a ${...} changed');
  assert.equal((await run(source('#101828'), source('#101828'))).swapped, false, 'nothing changed');
});

test('an open page reloads onto a new platform release at the first quiet moment, never while someone types', async () => {
  const { createReleaseWatch } = await import('../public/libraries/live-assets/live-assets.js');
  let clock = 0;
  const intervals = [];
  const listeners = {};
  const doc = { visibilityState: 'visible', activeElement: null, querySelectorAll: () => [], addEventListener: (type, fn) => { listeners[type] = fn; }, removeEventListener: () => {} };
  const win = {
    document: doc, location: { pathname: '/portal/' },
    addEventListener: (type, fn) => { listeners[type] = fn; },
    setInterval: (fn) => intervals.push(fn), clearInterval: () => intervals.splice(0)
  };
  let reloads = 0;
  const watch = createReleaseWatch(win, { quietMs: 4000, now: () => clock, reload: () => { reloads += 1; }, say: () => {} });
  clock = 10000;
  assert.equal(watch.note('r1'), false, "the first release is the page's own");
  assert.equal(watch.note('r1'), false);
  assert.equal(reloads, 0);

  listeners.keydown();
  doc.activeElement = { tagName: 'TEXTAREA' };
  assert.equal(watch.note('r2'), false, 'typing: wait');
  clock += 60000;
  assert.equal(watch.check(), false, 'still in the field');
  doc.activeElement = { tagName: 'INPUT', type: 'checkbox' };
  doc.visibilityState = 'hidden';
  assert.equal(watch.check(), false, 'hidden (the app is in the background): wait for it to come back');
  doc.visibilityState = 'visible';
  listeners.pointerdown();
  assert.equal(watch.check(), false, 'just touched');
  clock += 4000;
  assert.equal(watch.check(), true);
  assert.equal(reloads, 1);

  const other = createReleaseWatch(win, { now: () => clock, reload: () => { reloads += 1; }, say: () => {} });
  other.note('r2');
  doc.activeElement = { tagName: 'DIV', isContentEditable: true };
  other.note('r3');
  assert.equal(other.state().waiting, 'r3');
  other.note('r2');
  assert.equal(other.state().waiting, '', "a reconnect that reports the page's own release again cancels the wait");
  doc.activeElement = null;
  clock += 10000;
  assert.equal(other.check(), undefined);
  assert.equal(reloads, 1);
});

const hash = (rel, text) => liveHash(rel, Buffer.from(text));

test('every accepted save is journaled by content; old unreferenced journal bytes are pruned', { skip: !python && 'needs Python 3' }, async () => {
  const s = scratch();
  try {
    writeFileSync(path.join(s.dir, 'release.env'), 'RELEASE_ID=r1\nRELEASE_COMMIT=c0ffee\n');
    s.write('public/libraries/a/a.css', '.a{color:blue}\n');
    await reconcile(s.repo, 'canonical', s.receiver, new Map(), () => {});
    const sha = hash('a.css', '.a{color:blue}\n');
    assert.equal(readFileSync(path.join(s.live, 'journal', sha), 'utf8'), '.a{color:blue}\n');
    const entry = s.manifest().files['libraries/a/a.css'];
    assert.equal(entry.release, 'c0ffee', 'the release the save was accepted on');
    const head = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: s.repo, encoding: 'utf8' }).stdout.trim();
    assert.equal(entry.commit, head, "the sender's base commit");
    assert.deepEqual(s.manifest().history['libraries/a/a.css'].map((item) => item.sha), [sha]);

    const old = Date.now() / 1000 - 15 * 86400;
    const stale = path.join(s.live, 'journal', 'f'.repeat(40));
    writeFileSync(stale, 'gone');
    utimesSync(stale, old, old);
    utimesSync(path.join(s.live, 'journal', sha), old, old);
    await s.receiver.request({ op: 'check' });
    assert.ok(!existsSync(stale), 'old and unreferenced');
    assert.ok(existsSync(path.join(s.live, 'journal', sha)), 'old but still live');
  } finally { rmSync(s.dir, { recursive: true, force: true }); }
});

test('a release that changes a live file parks it: not served, bytes kept, until merged or cleared', { skip: !python && 'needs Python 3' }, async () => {
  const s = scratch();
  try {
    const rel = 'libraries/b/b.js';
    const base = hash(rel, 'export const b = 1;\n');
    assert.equal((await s.put('pc', rel, 'export const b = 3;\n', base, { commit: 'abc' })).state, 'live');
    s.releaseFile(rel, 'export const b = 2;\n');
    assert.deepEqual((await s.receiver.request({ op: 'check' })).retired, { [rel]: 'parked' });
    const m = s.manifest();
    assert.equal(m.files[rel], undefined);
    assert.ok(!existsSync(path.join(s.live, 'public', rel)), 'the page falls back to the release');
    assert.equal(m.retired[rel].reason, 'parked', 'pages are told it left (sha null)');
    const sha = hash(rel, 'export const b = 3;\n');
    assert.deepEqual({ ...m.parked[rel], at: 0, release: '' }, { sha, base, source: 'pc', at: 0, release: '', commit: 'abc', reason: 'conflict', parked_gen: m.gen });
    const blob = await s.receiver.request({ op: 'blob', sha });
    assert.equal(Buffer.from(blob.data, 'base64').toString(), 'export const b = 3;\n');
    assert.equal((await s.receiver.request({ op: 'blob', sha: 'e'.repeat(40) })).error, 'no-blob');
    assert.deepEqual(Object.keys((await s.receiver.request({ op: 'list' })).parked), [rel]);

    // The owner's next stale save is refused and changes nothing; another sync cannot remove the parked save.
    assert.equal((await s.put('pc', rel, 'export const b = 4;\n', base)).error, 'dev-differs');
    assert.equal(s.manifest().parked[rel].sha, sha);
    assert.equal((await s.receiver.request({ op: 'batch', source: 'droplet', ops: [{ op: 'remove', path: rel }] })).results[0].error, 'owned-by-other');
    assert.equal((await s.receiver.request({ op: 'unpark', path: 'libraries/x.js' })).error, 'not-parked');
    assert.equal((await s.receiver.request({ op: 'unpark', path: rel })).state, 'unparked');
    assert.deepEqual(s.manifest().parked, {});
    assert.equal(s.manifest().retired[rel].reason, 'reverted');
  } finally { rmSync(s.dir, { recursive: true, force: true }); }
});

test("another sync's stale save never retires or parks the owner's live file", { skip: !python && 'needs Python 3' }, async () => {
  const s = scratch();
  try {
    const rel = 'libraries/a/a.css';
    const base = hash(rel, '.a{color:red}\n');
    await s.put('pc', rel, '.a{color:blue}\n', base);
    s.releaseFile(rel, '.a{color:pink}\n');
    const gen = s.manifest().gen;
    assert.equal((await s.put('droplet', rel, '.a{color:green}\n', base)).error, 'dev-differs');
    assert.equal((await s.put('droplet', rel, '.a{color:pink}\n', base)).state, 'released');
    assert.equal(s.manifest().gen, gen, 'nothing written');
    assert.equal(s.manifest().files[rel].source, 'pc');
    assert.equal(readFileSync(path.join(s.live, 'public', rel), 'utf8'), '.a{color:blue}\n');
    // The check parks the owner's file; its bytes are not lost.
    await s.receiver.request({ op: 'check' });
    assert.equal(s.manifest().parked[rel].source, 'pc');
  } finally { rmSync(s.dir, { recursive: true, force: true }); }
});

test('the router exports, bakes and reports merged saves; the owner keeps editing on top of the release', { skip: !python && 'needs Python 3' }, async () => {
  const s = scratch();
  try {
    writeFileSync(path.join(s.dir, 'release.env'), 'RELEASE_ID=r1\n');
    const rel = 'libraries/a/a.css', parkedRel = 'libraries/b/b.js';
    const base = hash(rel, '.a{color:red}\n');
    const v1 = '.a{color:blue}\n', v2 = '.a{color:navy}\n', v3 = '.a{color:teal}\n';
    await s.put('pc', rel, v1, base);
    await s.put('pc', parkedRel, 'export const b = 3;\n', hash(parkedRel, 'export const b = 1;\n'));
    s.releaseFile(parkedRel, 'export const b = 2;\n');
    await s.receiver.request({ op: 'check' });

    const exported = await s.receiver.request({ op: 'export' });
    assert.equal(exported.release, 'r1');
    assert.deepEqual(Object.keys(exported.files), [rel]);
    assert.deepEqual(Object.keys(exported.parked), [parkedRel]);
    for (const entry of [exported.files[rel], exported.parked[parkedRel]]) {
      for (const key of ['sha', 'base', 'source', 'at', 'release']) assert.ok(key in entry, key);
      assert.ok((await s.receiver.request({ op: 'blob', sha: entry.sha })).ok);
    }

    // The owner saves again while the router bakes v1 and the parked b.js into release r2.
    await s.put('pc', rel, v2, base);
    s.releaseFile(rel, v1);
    s.releaseFile(parkedRel, 'export const b = 3;\n');
    writeFileSync(path.join(s.dir, 'release.env'), 'RELEASE_ID=r2\n');
    const merged = await s.receiver.request({ op: 'merged', release: 'r2', files: { [rel]: exported.files[rel].sha, [parkedRel]: exported.parked[parkedRel].sha, 'libraries/none.js': 'a'.repeat(40) } });
    assert.equal(merged.results[rel].state, 'continues');
    assert.equal(merged.results[parkedRel].state, 'unparked');
    assert.equal(merged.results['libraries/none.js'].ok, false);
    let m = s.manifest();
    assert.deepEqual(m.parked, {});
    assert.equal(m.retired[parkedRel].reason, 'released');
    assert.equal(m.files[rel].sha, hash(rel, v2), 'the newer save stays live');
    assert.equal(m.files[rel].base, hash(rel, v1), 'on top of the release');
    assert.equal((await s.receiver.request({ op: 'check' })).retired[rel], undefined);

    // A save still based on the old base continues: the release's copy is this sync's own earlier save.
    assert.equal((await s.put('pc', rel, v3, base)).state, 'live');
    m = s.manifest();
    assert.equal(m.files[rel].base, hash(rel, v1));
    assert.equal(m.files[rel].release, 'r2');
    assert.equal((await s.put('droplet', 'libraries/d.css', '.d{}\n', hash(rel, '.x{}\n'))).error, 'dev-differs');

    // Without a merged report, a check after a release that has an earlier save of the owner's also continues.
    s.releaseFile(rel, v2);
    assert.equal((await s.receiver.request({ op: 'check' })).retired[rel], undefined);
    assert.equal(s.manifest().files[rel].base, hash(rel, v2));

    // The router bakes v3 next; its merged report retires it as released.
    s.releaseFile(rel, v3);
    assert.equal((await s.receiver.request({ op: 'merged', release: 'r3', files: { [rel]: hash(rel, v3) } })).results[rel].state, 'released');
    assert.equal(s.manifest().files[rel], undefined);
    assert.equal(s.manifest().retired[rel].reason, 'released');
    assert.ok(!existsSync(path.join(s.live, 'public', rel)));
  } finally { rmSync(s.dir, { recursive: true, force: true }); }
});

test("a continuation is only for the sync's own earlier save", { skip: !python && 'needs Python 3' }, async () => {
  const s = scratch();
  try {
    const rel = 'libraries/a/a.css';
    const base = hash(rel, '.a{color:red}\n');
    await s.put('pc', rel, '.a{color:blue}\n', base);
    s.releaseFile(rel, '.a{color:blue}\n');
    await s.receiver.request({ op: 'check' });
    assert.equal(s.manifest().files[rel], undefined, 'released');
    assert.equal((await s.put('droplet', rel, '.a{color:green}\n', base)).error, 'dev-differs');
    const accepted = await s.put('pc', rel, '.a{color:green}\n', base);
    assert.equal(accepted.state, 'live');
    assert.equal(s.manifest().files[rel].base, hash(rel, '.a{color:blue}\n'));
  } finally { rmSync(s.dir, { recursive: true, force: true }); }
});
