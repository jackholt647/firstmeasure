// FM-500: fm-release activates a Node server release with its cluster primary's rolling replace (FM-389) when the
// running primary supports it, so a dev push never leaves nginx and the load balancer without a server; it restarts
// otherwise, and a restart systemd reports failed is left to readiness rather than failing the release at once.
// Runs the real tools/dev-push/host/fm-release.py against a fake host: releases under a temp root, fake systemctl,
// journalctl and /proc, and a local HTTP server standing in for Node's readiness.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

const HELPER = path.join(import.meta.dirname, '..', 'tools', 'dev-push', 'host', 'fm-release.py');
const A = 'a'.repeat(40);
const B = 'b'.repeat(40);
const SUPERVISOR = '// built server\nconst ROLLING_REPLACE = "v1-rolling-replace";\n';
const SERVICE = 'firstmeasure-development-web.service';

function release(releases, id, server) {
  const dir = path.join(releases, id);
  fs.mkdirSync(path.join(dir, 'public/v1/dist/src'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'public/v1/dist/src/server.js'), server);
  fs.writeFileSync(path.join(dir, 'release.env'), `RELEASE_ID=${id}\n`);
  fs.writeFileSync(path.join(dir, 'dev-push-release.json'), JSON.stringify({ release_id: id, router: true }));
}

// journal: what the primary logs after the Nth SIGHUP ('complete' or 'failed'); restartCode: what `systemctl restart` exits with.
async function fakeHost({ newServer = SUPERVISOR, journal = ['complete'], children = true, restartCode = 0 } = {}) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'fm500-release-'));
  const root = path.join(tmp, 'opt');
  const releases = path.join(root, 'releases');
  release(releases, A, SUPERVISOR);
  release(releases, B, newServer);
  fs.symlinkSync(path.join(releases, A), path.join(root, 'current'));
  const server = http.createServer((request, response) => {
    const id = path.basename(fs.realpathSync(path.join(root, 'current')));
    response.end(JSON.stringify({ ok: true, release_id: id, data_environment: 'development', outbound_safety: { ok: true, enforced: true } }));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const proc = path.join(tmp, 'proc');
  fs.mkdirSync(path.join(proc, '77/task/77'), { recursive: true });
  fs.symlinkSync(path.join(releases, A, 'public/v1'), path.join(proc, '77/cwd'));
  fs.writeFileSync(path.join(proc, '77/task/77/children'), children ? '78 79 ' : '');
  fs.writeFileSync(path.join(proc, '77/environ'), ['FIRSTMEASURE_DATA_ENVIRONMENT=development', `V1_PORT=${server.address().port}`, `RELEASE_ID=${A}`].join('\0'));
  const config = path.join(tmp, 'role.json');
  fs.writeFileSync(config, JSON.stringify({ role: 'web', releases_root: releases, services: [SERVICE], reload: ['php8.3-fpm.service'], readiness: 'http' }));
  const bin = path.join(tmp, 'bin');
  fs.mkdirSync(bin);
  const log = path.join(tmp, 'systemctl.log');
  fs.writeFileSync(log, '');
  fs.writeFileSync(path.join(bin, 'systemctl'), `#!/usr/bin/env bash
echo "$*" >> ${JSON.stringify(log)}
case "$1" in
  is-active) exit 0 ;;
  show) echo 77 ;;
  restart) exit ${restartCode} ;;
  kill|reload) exit 0 ;;
  *) exit 9 ;;
esac
`, { mode: 0o755 });
  // Each SIGHUP's outcome names the release `current` pointed at when the journal is read.
  fs.writeFileSync(path.join(bin, 'journalctl'), `#!/usr/bin/env bash
outcomes=(${journal.join(' ')})
n=0
while read -r line; do
  [[ "$line" == kill* ]] || continue
  outcome="\${outcomes[$n]:-complete}"; n=$((n+1))
done < ${JSON.stringify(log)}
(( n > 0 )) || exit 0
id="$(basename "$(readlink -f ${JSON.stringify(path.join(root, 'current'))})")"
if [[ "$outcome" == complete ]]; then echo "v1 HTTP cluster rolling replace complete: release=$id in 1234 ms."
else echo "v1 HTTP cluster rolling replace failed: the new worker exited before it was ready; the remaining workers keep release x."; fi
`, { mode: 0o755 });
  fs.writeFileSync(path.join(bin, 'lsattr'), '#!/usr/bin/env bash\necho "--------------e------- $2"\n', { mode: 0o755 });
  return {
    calls: () => fs.readFileSync(log, 'utf8').trim().split('\n').filter(line => line && !line.startsWith('show') && !line.startsWith('is-active')),
    current: () => path.basename(fs.realpathSync(path.join(root, 'current'))),
    run: (...args) => new Promise(done => {
      const child = spawn('python3', [HELPER, ...args], {
        env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, FM_RELEASE_ROOT: root, FM_RELEASE_CONFIG: config, FM_RELEASE_PROC: proc,
          FM_RELEASE_LOCK: path.join(tmp, 'fm-release.lock'), FM_RELEASE_AWAITING: path.join(tmp, 'awaiting-release'), FM_RELEASE_ROLLING_TIMEOUT: '20' }
      });
      let out = '';
      child.stdout.on('data', chunk => { out += chunk; });
      child.stderr.on('data', chunk => { out += chunk; });
      child.on('close', status => {
        server.close();
        let answer = {};
        try { answer = JSON.parse(out.trim().split('\n').at(-1)); } catch { /* reported below */ }
        done({ status, out, answer });
      });
    })
  };
}

const SIGHUP = `kill --kill-whom=main --signal=SIGHUP ${SERVICE}`;

test('a release with the running primary\'s server.js hands over by rolling replace, never restarting Node', async () => {
  const host = await fakeHost();
  const { status, out, answer } = await host.run('activate', 'platform', B, '--expect', A);
  assert.equal(status, 0, out);
  assert.deepEqual(answer.rolling, [SERVICE]);
  assert.equal(host.current(), B);
  assert.deepEqual(host.calls(), [SIGHUP, 'reload php8.3-fpm.service']);
});

test('a release that changes the primary (server.js) restarts as before', async () => {
  const host = await fakeHost({ newServer: `${SUPERVISOR}// changed\n` });
  const { status, out, answer } = await host.run('activate', 'platform', B, '--expect', A);
  assert.equal(status, 0, out);
  assert.deepEqual(answer.rolling, []);
  assert.deepEqual(host.calls(), [`restart ${SERVICE}`, 'reload php8.3-fpm.service']);
});

test('a process that is not a cluster primary restarts', async () => {
  const host = await fakeHost({ children: false });
  const { status, out } = await host.run('activate', 'platform', B, '--expect', A);
  assert.equal(status, 0, out);
  assert.deepEqual(host.calls(), [`restart ${SERVICE}`, 'reload php8.3-fpm.service']);
});

test('a failed rolling replace rolls back by rolling replace too', async () => {
  const host = await fakeHost({ journal: ['failed', 'complete'] });
  const { status, out, answer } = await host.run('activate', 'platform', B, '--expect', A);
  assert.equal(status, 1, out);
  assert.match(answer.error, /rolling replace failed/);
  assert.equal(answer.rolled_back, true, out);
  assert.equal(host.current(), A);
  assert.deepEqual(host.calls(), [SIGHUP, SIGHUP, 'reload php8.3-fpm.service']);
});

test('a restart systemd reports failed is judged by readiness, not failed at once', async () => {
  // The dev worker's start preflight sometimes hits a hung Spaces call: systemd retries it, and fm-release waits.
  const host = await fakeHost({ newServer: `${SUPERVISOR}// changed\n`, restartCode: 1 });
  const { status, out } = await host.run('activate', 'platform', B, '--expect', A);
  assert.equal(status, 0, out);
  assert.equal(host.current(), B);
});

test('rollback (the router putting a role back) hands over by rolling replace', async () => {
  const host = await fakeHost();
  const { status, out } = await host.run('rollback', 'platform', B);
  assert.equal(status, 0, out);
  assert.equal(host.current(), B);
  assert.deepEqual(host.calls(), [SIGHUP, 'reload php8.3-fpm.service']);
});
