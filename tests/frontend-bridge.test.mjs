// The frontend bridge (docs/architecture/frontend-bridge.md): which changed files it serves, how copies are
// rewritten for the extension, and the live channel and control endpoint, with a stand-in for the extension.
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn, spawnSync } from 'node:child_process';
import test from 'node:test';
import assert from 'node:assert/strict';
import { classify, kindOf, parseNameStatus, rewriteForExtension } from '../tools/frontend-bridge/bridge.mjs';

const root = fileURLToPath(new URL('..', import.meta.url));
const bridge = path.join(root, 'tools/frontend-bridge/bridge.mjs');
const EXTENSION_ORIGIN = 'chrome-extension://jfaopkielgkjkgomhmgdhldpogfdjohm';
const site = 'https://dev.1m8.ai';

test('only browser files under public/ are served; server and page files wait for a rollout', () => {
  assert.equal(classify('public/libraries/guided-experiences/guided-experiences.js'), 'browser');
  assert.equal(classify('public/fonts.css'), 'browser');
  assert.equal(classify('public/images/icon.png'), 'browser');
  assert.equal(classify('public/v1/guided-experiences/definitions/materials.ts'), 'server');
  assert.equal(classify('public/v1/public/app.js'), 'server');
  assert.equal(classify('public/portal/index.php'), 'page');
  assert.equal(classify('public/payments-setup-complete.html'), 'page');
  assert.equal(classify('docs/architecture/forms.md'), 'outside');
  assert.equal(kindOf('libraries/a/b.css'), 'css');
  assert.equal(kindOf('libraries/a/b.mjs'), 'js');
});

test('git name-status output is read with renames and copies', () => {
  assert.deepEqual(parseNameStatus('M\0public/a.js\0A\0public/b.css\0R100\0public/old.js\0public/new.js\0D\0public/gone.js\0'), [
    { status: 'M', path: 'public/a.js' }, { status: 'A', path: 'public/b.css' }, { status: 'R', path: 'public/new.js' }, { status: 'D', path: 'public/gone.js' }
  ]);
});

test('references a copy resolves against its own address become absolute on dev', () => {
  const css = rewriteForExtension('fonts.css', Buffer.from('a{src:url(fonts/M.ttf),url("/i/a.png"),url(data:x),url(https://x.test/a),url(#f)} @import "./b.css";'), site).toString();
  assert.equal(css, 'a{src:url(https://dev.1m8.ai/fonts/M.ttf),url("https://dev.1m8.ai/i/a.png"),url(data:x),url(https://x.test/a),url(#f)} @import "https://dev.1m8.ai/b.css";');
  const js = rewriteForExtension('libraries/viewer/gallery.js', Buffer.from('import {m} from "./viewer.js?v=1"; import("../x.js"); import(`./t/${n}.js`); import "/libraries/s.js"; new URL("w.js", import.meta.url); fetch("/v1/x"); api.import("./keep");'), site).toString();
  assert.equal(js, 'import {m} from "https://dev.1m8.ai/libraries/viewer/viewer.js?v=1"; import("https://dev.1m8.ai/libraries/x.js"); import(`https://dev.1m8.ai/libraries/viewer/t/${n}.js`); import "https://dev.1m8.ai/libraries/s.js"; new URL("w.js", "https://dev.1m8.ai/libraries/viewer/gallery.js"); fetch("/v1/x"); api.import("./keep");');
  const png = Buffer.from([137, 80, 78, 71]);
  assert.equal(rewriteForExtension('images/a.png', png, site), png);
});

test('serve copies overrides into the extension, talks only to the extension, and relays commands', async (t) => {
  const work = mkdtempSync(path.join(tmpdir(), 'fm-bridge-'));
  const checkout = path.join(work, 'checkout');
  const extension = path.join(work, 'extension');
  const port = 20000 + Math.floor(Math.random() * 20000);
  const git = (...args) => { const result = spawnSync('git', args, { cwd: checkout, encoding: 'utf8' }); assert.equal(result.status, 0, result.stderr); return result.stdout; };
  mkdirSync(path.join(checkout, 'public/libraries/bridge-test'), { recursive: true });
  mkdirSync(path.join(checkout, 'public/v1'), { recursive: true });
  mkdirSync(extension);
  writeFileSync(path.join(extension, 'manifest.json'), JSON.stringify({ name: 'FirstMate Dev Bridge' }));
  writeFileSync(path.join(checkout, 'public/libraries/bridge-test/app.js'), 'window.bridgeTest = 1;\n');
  writeFileSync(path.join(checkout, 'public/v1/server.ts'), 'export {};\n');
  git('init', '-q'); git('-c', 'user.email=t@t', '-c', 'user.name=t', 'add', '.'); git('-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', 'base');
  writeFileSync(path.join(checkout, 'public/libraries/bridge-test/app.js'), 'import("./more.js");\nwindow.bridgeTest = 2;\n');
  writeFileSync(path.join(checkout, 'public/v1/server.ts'), 'export const changed = true;\n');

  const server = spawn(process.execPath, [bridge, 'serve', '--root', checkout, '--port', String(port), '--extension', extension, '--base', 'HEAD'], { stdio: ['ignore', 'pipe', 'pipe'] });
  t.after(() => { server.kill(); rmSync(work, { recursive: true, force: true }); rmSync(path.join(tmpdir(), `firstmate-frontend-bridge-${port}.json`), { force: true }); });
  let output = '';
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`bridge did not start: ${output}`)), 30000);
    const read = (chunk) => { output += chunk; if (output.includes('FirstMate frontend bridge on')) { clearTimeout(timer); resolve(); } };
    server.stdout.on('data', read); server.stderr.on('data', read);
    server.on('exit', (code) => reject(new Error(`bridge exited ${code}: ${output}`)));
  });

  const overrides = path.join(extension, 'overrides');
  const [rev] = readdirSync(overrides);
  const copy = readFileSync(path.join(overrides, rev, 'libraries/bridge-test/app.js'), 'utf8');
  assert.match(copy, /import\("https:\/\/dev\.1m8\.ai\/libraries\/bridge-test\/more\.js"\)/);

  // A page (any other origin) cannot open the live channel.
  const refused = new WebSocket(`ws://127.0.0.1:${port}/ext`, { headers: { Origin: 'https://dev.1m8.ai' } });
  await new Promise((resolve) => { refused.onerror = resolve; refused.onclose = resolve; });

  const ws = new WebSocket(`ws://127.0.0.1:${port}/ext`, { headers: { Origin: EXTENSION_ORIGIN } });
  const messages = [];
  let waiter = null;
  ws.onmessage = (event) => { const message = JSON.parse(event.data); messages.push(message); waiter?.(); };
  const next = (type) => new Promise((resolve) => { const check = () => { const found = messages.find((message) => message.type === type); if (found) { messages.splice(messages.indexOf(found), 1); waiter = null; resolve(found); } }; waiter = check; check(); });
  await new Promise((resolve) => { ws.onopen = resolve; });
  ws.send(JSON.stringify({ type: 'hello', protocol: 1, version: 'test', tabs: [] }));
  const state = await next('state');
  assert.deepEqual(state.files.map((file) => [file.path, file.rev]), [['libraries/bridge-test/app.js', rev]]);
  assert.deepEqual(state.pending_deploy, [{ path: 'public/v1/server.ts', role: 'server' }]);

  const { token } = JSON.parse(readFileSync(path.join(tmpdir(), `firstmate-frontend-bridge-${port}.json`), 'utf8'));
  const call = (body, headers = {}) => fetch(`http://127.0.0.1:${port}/control`, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) });
  assert.equal((await call({ name: 'status' })).status, 403);
  assert.equal((await call({ name: 'status' }, { 'x-bridge-token': token, origin: 'https://dev.1m8.ai' })).status, 403);

  const answer = call({ name: 'eval', args: { code: '1 + 1' } }, { 'x-bridge-token': token });
  const command = await next('command');
  assert.equal(command.name, 'eval');
  assert.equal(command.args.code, '1 + 1');
  ws.send(JSON.stringify({ type: 'result', id: command.id, ok: true, value: 2 }));
  assert.deepEqual(await (await answer).json(), { ok: true, value: 2 });

  // Saving again moves the override to a new revision and drops the old copy.
  writeFileSync(path.join(checkout, 'public/libraries/bridge-test/app.js'), 'window.bridgeTest = 3;\n');
  const changed = await next('state');
  assert.notEqual(changed.files[0].rev, rev);
  assert.ok(!existsSync(path.join(overrides, rev)));
  ws.close();
});
