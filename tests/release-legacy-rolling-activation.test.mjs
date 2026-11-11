// FM-389: activate-release.sh activates compatibility (firstmeasure-legacy) with the cluster
// primary's rolling replace when the running primary supports it, and restarts otherwise.
// Runs the real script against a fake host: releases under a temp root, fake systemctl,
// journalctl and /proc, and a local HTTP server standing in for Node's readiness.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

const SCRIPT = path.join(import.meta.dirname, '..', 'deploy', 'digitalocean', 'activate-release.sh');
const A = 'a'.repeat(40);
const B = 'b'.repeat(40);
const SUPERVISOR = '// built server\nconst ROLLING_REPLACE = "v1-rolling-replace";\n';

function release(app, id, server) {
  const dir = path.join(app, 'releases', id);
  fs.mkdirSync(path.join(dir, 'public/v1/dist/src'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'deploy/digitalocean'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'public/v1/dist/src/server.js'), server);
  fs.writeFileSync(path.join(dir, 'release.env'), `RELEASE_ID=${id}\n`);
  fs.writeFileSync(path.join(dir, 'deploy/digitalocean/verify-node.sh'), 'echo verified "$1"\n');
}

// journal: what the primary logs after the Nth SIGHUP ('complete' or 'failed'); children: whether it is a cluster.
async function fakeHost({ newServer = SUPERVISOR, journal = ['complete'], children = true } = {}) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'fm389-activate-'));
  const app = path.join(tmp, 'opt');
  release(app, A, SUPERVISOR);
  release(app, B, newServer);
  fs.symlinkSync(path.join(app, 'releases', A), path.join(app, 'current'));
  fs.mkdirSync(path.join(tmp, 'proc/77/task/77'), { recursive: true });
  fs.symlinkSync(path.join(app, 'releases', A, 'public/v1'), path.join(tmp, 'proc/77/cwd'));
  fs.writeFileSync(path.join(tmp, 'proc/77/task/77/children'), children ? '78 79 ' : '');
  const log = path.join(tmp, 'systemctl.log');
  fs.writeFileSync(log, '');
  fs.writeFileSync(path.join(tmp, 'systemctl'), `#!/usr/bin/env bash
echo "$*" >> ${JSON.stringify(log)}
case "$1" in
  is-active) exit 0 ;;
  show) echo 77 ;;
  kill|reload|restart) exit 0 ;;
  *) exit 9 ;;
esac
`, { mode: 0o755 });
  // Each SIGHUP's outcome names the release `current` pointed at when it was sent.
  fs.writeFileSync(path.join(tmp, 'journalctl'), `#!/usr/bin/env bash
outcomes=(${journal.join(' ')})
n=0
while read -r line; do
  [[ "$line" == kill* ]] || continue
  outcome="\${outcomes[$n]:-complete}"; n=$((n+1))
done < ${JSON.stringify(log)}
(( n > 0 )) || exit 0
id="$(basename "$(readlink -f ${JSON.stringify(path.join(app, 'current'))})")"
if [[ "$outcome" == complete ]]; then echo "v1 HTTP cluster rolling replace complete: release=$id in 1234 ms."
else echo "v1 HTTP cluster rolling replace failed: the new worker exited before it was ready; the remaining workers keep release x."; fi
`, { mode: 0o755 });
  const server = http.createServer((request, response) => {
    const id = path.basename(fs.realpathSync(path.join(app, 'current')));
    response.end(JSON.stringify({ ok: true, release_id: id }));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  return {
    app,
    calls: () => fs.readFileSync(log, 'utf8').trim().split('\n').filter(line => !line.startsWith('show') && !line.startsWith('is-active')),
    current: () => path.basename(fs.realpathSync(path.join(app, 'current'))),
    run: (service = 'firstmeasure-legacy.service', extra = {}) => new Promise(done => {
      const source = fs.readFileSync(SCRIPT, 'utf8').replaceAll('/opt/firstmeasure', app);
      fs.writeFileSync(path.join(tmp, 'activate-release.sh'), source);
      const child = spawn('bash', [path.join(tmp, 'activate-release.sh'), B, service], {
        env: { ...process.env, FIRSTMEASURE_SYSTEMCTL: path.join(tmp, 'systemctl'), FIRSTMEASURE_JOURNALCTL: path.join(tmp, 'journalctl'),
          FIRSTMEASURE_PROC: path.join(tmp, 'proc'), FIRSTMEASURE_NODE_HTTP: `http://127.0.0.1:${server.address().port}`, FIRSTMEASURE_ROLLING_TIMEOUT: '20', ...extra }
      });
      let out = '';
      child.stdout.on('data', chunk => { out += chunk; });
      child.stderr.on('data', chunk => { out += chunk; });
      child.on('close', status => done({ status, out }));
    }),
    close: () => { server.close(); fs.rmSync(tmp, { recursive: true, force: true }); }
  };
}

const HUP = 'kill --kill-whom=main --signal=SIGHUP firstmeasure-legacy.service';

test('legacy: a primary with the same supervisor code replaces its workers instead of restarting', { skip: process.platform === 'win32', timeout: 30000 }, async () => {
  const host = await fakeHost();
  try {
    const result = await host.run();
    assert.equal(result.status, 0, result.out);
    assert.match(result.out, /Activated b+ for firstmeasure-legacy.service \(rolling replace\)/);
    assert.equal(host.current(), B);
    assert.deepEqual(host.calls(), [HUP, 'reload php8.3-fpm.service']);
  } finally { host.close(); }
});

test('legacy: restarts when the primary lacks rolling replace, its code changed, it is not a cluster, or it is turned off', { skip: process.platform === 'win32', timeout: 60000 }, async () => {
  const cases = [
    [{ newServer: SUPERVISOR + '// changed primary\n' }, {}],
    [{ children: false }, {}],
    [{}, { FIRSTMEASURE_LEGACY_ACTIVATION: 'restart' }]
  ];
  for (const [options, extra] of cases) {
    const host = await fakeHost(options);
    try {
      const result = await host.run('firstmeasure-legacy.service', extra);
      assert.equal(result.status, 0, result.out);
      assert.match(result.out, /\(restart\)/);
      assert.deepEqual(host.calls(), ['restart firstmeasure-legacy.service', 'restart php8.3-fpm.service'], JSON.stringify(options));
    } finally { host.close(); }
  }
  // The first release with FM-389: the running primary's server.js does not have it yet.
  const host = await fakeHost();
  try {
    fs.writeFileSync(path.join(host.app, 'releases', A, 'public/v1/dist/src/server.js'), '// older primary\n');
    const result = await host.run();
    assert.equal(result.status, 0, result.out);
    assert.deepEqual(host.calls(), ['restart firstmeasure-legacy.service', 'restart php8.3-fpm.service']);
  } finally { host.close(); }
});

test('legacy: a failed rolling replace switches current back and replaces the workers back, without a restart', { skip: process.platform === 'win32', timeout: 30000 }, async () => {
  const host = await fakeHost({ journal: ['failed', 'complete'] });
  try {
    const result = await host.run();
    assert.equal(result.status, 1, result.out);
    assert.match(result.out, /rolling replace failed/);
    assert.equal(host.current(), A);
    assert.deepEqual(host.calls(), [HUP, HUP, 'reload php8.3-fpm.service']);
  } finally { host.close(); }
});
