// Offline in a real browser (docs/architecture/offline.md): the real service worker (public/portal/sw.js), engine
// and page API, served by a small local server that stands in for the portal page, the browser files of a
// release, the asset manifest and the /v1/ API. The server is "unreachable" when it drops every connection.
// The engine's rules are covered case by case, without a browser, in tests/offline-core.test.mjs.
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';

// The repository's browser tests use the server package's playwright-core with the local Chrome.
const { chromium } = createRequire(new URL('../public/v1/package.json', import.meta.url))('playwright-core');
const CHROME = process.env.CHROME_PATH || 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const real = (file) => readFileSync(new URL('../public/' + file, import.meta.url));
const sha = (bytes) => createHash('sha256').update(bytes).digest('hex');
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** TEST ONLY: a small contract, and switches the tests flip inside the worker. Real contracts live in platform-offline/contracts/. */
const TEST_CONTRACT = `
FMOffline.configure({
  limits: { readTimeoutMs: 700, readTimeoutAfterFailureMs: 250, budgetCheckBytes: 1024 * 1024 },
  estimate: async () => self.__testSpace || { quota: 1e12, usage: 0 }
});
self.addEventListener('message', (event) => {
  const message = event.data;
  if (!message || !message.test) return;
  if (message.test === 'space') self.__testSpace = message.value;
  if (message.test === 'break-plan') FMOffline.api.plan = () => () => { throw new Error('internal error in a handler'); };
  if (message.test === 'break-route') FMOffline.api.ignores = () => { throw new Error('internal error while routing'); };
});
FMOffline.contracts.add({
  id: 'test',
  reads: [{ id: 'actions', match: 'POST /v1/platform/portal-action', when: (ctx) => ctx.body.action === 'list_notes', key: (ctx) => ({ action: ctx.body.action, project: ctx.body.project_id }) }],
  prefetch: [(ctx) => ['/v1/projects/' + ctx.project, '/v1/projects/' + ctx.project + '/notes']],
  writes: [
    {
      id: 'notes.post', match: 'POST /v1/projects/:project/notes', kind: 'create',
      scope: (ctx) => 'project:' + ctx.params.project,
      label: (ctx) => ({ title: 'Note', detail: ctx.body.text }),
      records: (ctx) => [ctx.body.id],
      respond: (ctx) => ({ ok: true, note: { id: ctx.body.id, text: ctx.body.text, waiting: true } }),
      effects: (ctx) => [{
        match: 'GET /v1/projects/:project/notes', when: (m) => m.project === ctx.params.project,
        apply: (json) => Object.assign({}, json, { notes: json.notes.filter((note) => note.id !== ctx.body.id).concat([ctx.response.note]) })
      }]
    },
    {
      id: 'project.patch', match: 'PATCH /v1/projects/:project', kind: 'patch',
      scope: (ctx) => 'project:' + ctx.params.project, records: (ctx) => [ctx.params.project],
      respond: (ctx) => ({ ok: true, project: Object.assign({ id: ctx.params.project }, ctx.body) }),
      effects: (ctx) => [{ match: 'GET /v1/projects/:project', apply: (json) => Object.assign({}, json, { project: Object.assign({}, json.project, ctx.body) }) }],
      conflict: {
        current: (ctx) => '/v1/projects/' + ctx.params.project,
        pick: (json) => ({ doc: json.project, revision: json.project.revision }),
        fields: (ctx) => Object.keys(ctx.body),
        send: (ctx, merged, revision) => Object.assign({}, merged, { expected_revision: revision })
      }
    },
    { id: 'media.upload', match: 'POST /v1/platform/organizations/:org/media', kind: 'upload', scope: (ctx) => 'project:' + ctx.body.project_id, records: (ctx) => [ctx.body.id], respond: (ctx) => ({ ok: true, media: { id: ctx.body.id, waiting: true } }) },
    { id: 'broken', match: 'POST /v1/broken', kind: 'action', scope: () => { throw new Error('a contract bug'); }, respond: () => ({ ok: true }) }
  ]
});
`;

/** The portal, its release files, the manifest and the API, on a port of its own. */
async function site() {
  const s = {
    down: false,
    delay: 0,                                  // ms before an API answer
    release: 'r1',
    enabled: true,
    render: 'first render',
    user: { id: 'user_1', org: 'org_1' },      // who the session cookie belongs to; null = signed out
    files: { '/libraries/demo/app.js': "window.demo = 'app r1';", '/libraries/demo/style.css': 'body{color:#111}', '/libraries/demo/data.txt': 'data r1' },
    listed: null,                              // manifest hashes that differ from the bytes served (path -> text)
    live: new Set(),                           // paths served with X-FirstMate-Live: 1
    broken: new Set(),                         // paths answered 500
    log: [],
    api: () => null
  };
  const fixed = {
    '/portal/sw.js': real('portal/sw.js'),
    '/libraries/platform-offline/offline-core.js': real('libraries/platform-offline/offline-core.js'),
    '/libraries/platform-offline/platform-offline.js': real('libraries/platform-offline/platform-offline.js'),
    '/libraries/platform-offline/contracts/core.js': real('libraries/platform-offline/contracts/core.js'),
    '/libraries/platform-offline/contracts/index.js': Buffer.from("self.FM_OFFLINE_CONTRACTS = ['core.js', 'test.js'];"),
    '/libraries/platform-offline/contracts/test.js': Buffer.from(TEST_CONTRACT)
  };
  const type = (path) => (path.endsWith('.js') ? 'text/javascript' : path.endsWith('.css') ? 'text/css' : 'text/plain');
  const bytesOf = (path) => (path in s.files ? Buffer.from(s.files[path]) : fixed[path]);
  const manifest = () => {
    const files = {};
    for (const path of [...Object.keys(fixed).filter((item) => item !== '/portal/sw.js'), ...Object.keys(s.files)]) {
      const bytes = s.listed && path in s.listed ? Buffer.from(s.listed[path]) : bytesOf(path);
      files[path] = [sha(bytes), bytes.length];
    }
    return { enabled: s.enabled, release: s.release, generated_at: new Date().toISOString(), files, shells: ['/portal/'], external: [] };
  };
  const shell = () => `<!doctype html><html><head><meta charset="utf-8"><title>Portal</title>
<script>window.__APP = { userId: ${JSON.stringify(s.user.id)}, userOrgId: ${JSON.stringify(s.user.org)}, platformSessionCookieName: 'fm_platform_session' };</script>
<script src="/libraries/platform-offline/platform-offline.js?v=${Math.random().toString(36).slice(2)}"></script>
<script src="/libraries/demo/app.js?v=${Math.random().toString(36).slice(2)}"></script>
</head><body><div id="render">${s.render}</div></body></html>`;

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://localhost');
    const path = url.pathname;
    if (s.down) { req.socket.destroy(); return; }
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const raw = Buffer.concat(chunks);
    const entry = { method: req.method, path, query: url.search, headers: req.headers, raw, body: null };
    if (raw.length && /json/.test(req.headers['content-type'] || '')) { try { entry.body = JSON.parse(raw.toString()); } catch { entry.body = null; } }
    s.log.push(entry);
    const send = (status, headers, body) => { res.writeHead(status, { 'Cache-Control': 'no-store', ...headers }); res.end(body); };
    const json = (status, body, headers = {}) => send(status, { 'Content-Type': 'application/json', ...headers }, JSON.stringify(body));
    if (path === '/v1/platform/offline/assets') return json(200, manifest());
    if (path.startsWith('/v1/')) {
      if (s.delay) await sleep(s.delay);
      if (s.down) { req.socket.destroy(); return; }
      const answer = await s.api(entry);
      if (!answer) return json(404, { ok: false, error: 'not_found' });
      if (answer.bytes) return send(answer.status || 200, { 'Content-Type': answer.type || 'application/octet-stream' }, answer.bytes);
      return json(answer.status || 200, answer.json, answer.headers);
    }
    if (path === '/portal/' || path === '/portal/index.php') {
      if (!s.user) return send(302, { Location: '/portal/login.php' }, '');
      return send(200, { 'Content-Type': 'text/html; charset=utf-8', 'X-FirstMate-Release': s.release, 'X-FirstMate-Identity': `${encodeURIComponent(s.user.id)}/${encodeURIComponent(s.user.org)}`, 'Set-Cookie': 'fm_platform_session_csrf=csrf-token-1; Path=/' }, shell());
    }
    if (path === '/portal/logout.php') { s.user = null; return send(302, { Location: '/portal/login.php' }, ''); }
    if (path === '/portal/login.php') return send(200, { 'Content-Type': 'text/html' }, '<!doctype html><title>Sign in</title><p id="login">Sign in</p>');
    // A page inside the worker's scope that never says who is signed in.
    if (path === '/portal/plain.html') return send(200, { 'Content-Type': 'text/html' }, '<!doctype html><title>Plain</title><p>plain</p>');
    const bytes = bytesOf(path);
    if (!bytes) return send(404, { 'Content-Type': 'text/plain' }, 'not found');
    if (s.broken.has(path)) return send(500, { 'Content-Type': 'text/plain' }, 'broken');
    return send(200, { 'Content-Type': type(path), ...(s.live.has(path) ? { 'X-FirstMate-Live': '1' } : {}) }, bytes);
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  s.origin = `http://127.0.0.1:${server.address().port}`;
  s.close = () => new Promise((resolve) => { server.closeAllConnections(); server.close(resolve); });
  s.requests = (method, prefix, from = 0) => s.log.slice(from).filter((entry) => entry.method === method && entry.path.startsWith(prefix));
  return s;
}

/** One browser with its own profile, and one site. */
async function withBrowser(run) {
  const s = await site();
  const browser = await chromium.launch({ executablePath: CHROME, headless: true });
  const context = await browser.newContext();
  try { await run(s, context); } finally { await browser.close(); await s.close(); }
}

/** Opens the portal and waits until the worker knows who is signed in. */
async function openPortal(context, s, path = '/portal/') {
  const page = await context.newPage();
  await page.goto(s.origin + path);
  await page.evaluate(() => window.PlatformOffline.ready);
  await page.evaluate(() => {
    window.__events = [];
    for (const type of ['queued', 'synced', 'failed', 'conflict', 'discarded', 'code']) window.PlatformOffline.on(type, (detail) => window.__events.push({ type, detail }));
  });
  return page;
}
const check = (page) => page.evaluate(() => window.PlatformOffline.checkForUpdate());
const state = (page) => page.evaluate(() => window.PlatformOffline.state());
const events = (page, type) => page.evaluate((wanted) => window.__events.filter((event) => event.type === wanted).map((event) => event.detail), type);
const until = async (probe, message, ms = 8000) => { const end = Date.now() + ms; for (;;) { const value = await probe(); if (value) return value; if (Date.now() > end) assert.fail('timed out: ' + message); await sleep(50); } };

/** fetch from the page: what a library would see. */
function call(page, method, path, body, extra = {}) {
  return page.evaluate(async ([method, path, body, extra]) => {
    try {
      const init = { method, credentials: 'include', headers: Object.assign({}, extra.headers) };
      if (extra.form) { const form = new FormData(); for (const [name, value] of Object.entries(extra.form)) form.append(name, value && value.file ? new File([value.file], value.name, { type: value.type }) : value); init.body = form; }
      else if (body !== null && body !== undefined) { init.body = JSON.stringify(body); init.headers['Content-Type'] = 'application/json'; }
      const response = await fetch(path, init);
      const text = extra.size ? String((await response.arrayBuffer()).byteLength) : await response.text();
      let json = null;
      try { json = JSON.parse(text); } catch (_) { json = null; }
      const header = (name) => response.headers.get(name);
      return { status: response.status, text, json, offline: header('x-fm-offline'), queued: header('x-fm-offline-queued'), savedAt: header('x-fm-saved-at'), overlay: header('x-fm-offline-overlay'), type: header('content-type') };
    } catch (error) { return { error: String(error) }; }
  }, [method, path, body ?? null, extra]);
}

/** What is in the device's store and caches, read from a page. */
function device(page) {
  return page.evaluate(async () => {
    const database = await new Promise((resolve, reject) => { const request = indexedDB.open('fm-offline-v1'); request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error); });
    const all = (store) => new Promise((resolve, reject) => { const request = database.transaction(store).objectStore(store).getAll(); request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error); });
    const out = {
      stores: [...database.objectStoreNames].sort(),
      responses: (await all('responses')).map((row) => row.k),
      outbox: (await all('outbox')).map((row) => ({ id: row.id, user: row.user, state: row.state, write: row.write, records: row.records, key: row.key })),
      blobs: (await all('blobs')).map((row) => ({ entry: row.k[0], name: row.name, size: row.size })),
      media: (await all('media')).map((row) => row.k[2]),
      meta: Object.fromEntries((await all('meta')).map((row) => [row.k, row.v])),
      caches: {}
    };
    database.close();
    for (const name of await caches.keys()) out.caches[name] = (await (await caches.open(name)).keys()).map((request) => new URL(request.url).pathname).sort();
    out.registrations = (await navigator.serviceWorker.getRegistrations()).length;
    return out;
  });
}

// ---------------------------------------------------------------------------------------------------------------

test('a release\'s set downloads in the background, is checked, reuses unchanged files, resumes, and serves only when complete', async () => {
  await withBrowser(async (s, context) => {
    const page = await openPortal(context, s);
    await page.evaluate(() => { window.__sameDocument = true; });
    assert.deepEqual(await check(page), { release: 'r1', status: 'ready', progress: 1 });
    let d = await device(page);
    assert.deepEqual(d.stores, ['blobs', 'media', 'meta', 'outbox', 'responses']);
    assert.deepEqual(d.meta.sets, { active: 'r1', previous: null });
    assert.deepEqual(d.caches['fm-set-r1'], ['/.fm-shell/user_1/org_1/portal/', '/libraries/demo/app.js', '/libraries/demo/data.txt', '/libraries/demo/style.css', '/libraries/platform-offline/contracts/core.js', '/libraries/platform-offline/contracts/index.js', '/libraries/platform-offline/contracts/test.js', '/libraries/platform-offline/offline-core.js', '/libraries/platform-offline/platform-offline.js']);

    // Release r2 changes app.js and data.txt; data.txt cannot be downloaded yet.
    s.release = 'r2'; s.files['/libraries/demo/app.js'] = "window.demo = 'app r2';"; s.files['/libraries/demo/data.txt'] = 'data r2'; s.render = 'render r2';
    s.broken.add('/libraries/demo/data.txt');
    let mark = s.log.length;
    let code = await check(page);
    assert.deepEqual([code.release, code.status, code.next], ['r1', 'ready', 'r2'], 'the half-downloaded set is not active');
    assert.equal(s.requests('GET', '/libraries/demo/app.js', mark).length, 1, 'the changed file was downloaded');
    assert.equal(s.requests('GET', '/libraries/demo/style.css', mark).length, 0, 'the unchanged file was copied from the active set');
    assert.equal(s.requests('GET', '/libraries/platform-offline/', mark).length, 0);
    d = await device(page);
    assert.deepEqual(d.meta.sets, { active: 'r1', previous: null });
    assert.ok(d.caches['fm-set-r2'].includes('/libraries/demo/app.js') && !d.caches['fm-set-r2'].includes('/libraries/demo/data.txt'));
    // Without the server the device still runs r1, whole.
    s.down = true;
    const offline = await context.newPage();
    await offline.goto(s.origin + '/portal/');
    assert.equal(await offline.evaluate(() => window.demo), 'app r1');
    assert.equal(await offline.locator('#render').textContent(), 'first render');
    assert.equal((await call(offline, 'GET', '/libraries/demo/data.txt')).text, 'data r1');
    await offline.close();
    s.down = false;

    // The next check continues: only what is missing is downloaded.
    s.broken.clear();
    mark = s.log.length;
    code = await check(page);
    assert.deepEqual(code, { release: 'r2', status: 'ready', progress: 1 });
    assert.equal(s.requests('GET', '/libraries/demo/data.txt', mark).length, 1);
    assert.equal(s.requests('GET', '/libraries/demo/app.js', mark).length, 0, 'not downloaded twice');
    assert.equal(s.requests('GET', '/portal/', mark).length, 1, 'the shell is fetched last, with the person\'s session');
    d = await device(page);
    assert.deepEqual(d.meta.sets, { active: 'r2', previous: 'r1' });
    assert.ok(d.caches['fm-set-r2'].includes('/.fm-shell/user_1/org_1/portal/'));
    assert.ok((await events(page, 'code')).some((detail) => detail.status === 'downloading' && detail.next === 'r2'));

    // r3 lists a hash the served bytes do not have: tried twice, never active...
    s.release = 'r3'; s.listed = { '/libraries/demo/app.js': 'what the release built' };
    mark = s.log.length;
    code = await check(page);
    assert.deepEqual([code.release, code.next], ['r2', 'r3']);
    assert.equal(s.requests('GET', '/libraries/demo/app.js', mark).length, 2, 'a file whose bytes differ is retried once');
    // ...unless the dev live layer is serving it, which is accepted as served.
    s.live.add('/libraries/demo/app.js');
    assert.deepEqual(await check(page), { release: 'r3', status: 'ready', progress: 1 });
    d = await device(page);
    assert.deepEqual(d.meta.sets, { active: 'r3', previous: 'r2' });
    assert.deepEqual(Object.keys(d.caches).filter((name) => name.startsWith('fm-set-')).sort(), ['fm-set-r2', 'fm-set-r3'], 'only the active and the previous set are kept');
    // Three releases later the page is still the same document: nothing reloaded it.
    assert.equal(await page.evaluate(() => window.__sameDocument), true);
    assert.equal(await page.locator('#render').textContent(), 'first render');
  });
});

test('with a connection pages and files come from the network; without one, from the stored shell and the set', async () => {
  await withBrowser(async (s, context) => {
    const page = await openPortal(context, s);
    await check(page);

    // Online, a changed file is seen at once (the live layer case): no new release, new bytes.
    s.files['/libraries/demo/app.js'] = "window.demo = 'app live';"; s.live.add('/libraries/demo/app.js');
    const fresh = await call(page, 'GET', '/libraries/demo/app.js?v=anything');
    assert.deepEqual([fresh.text, fresh.offline], ["window.demo = 'app live';", null]);
    s.render = 'second render';
    await page.reload();
    assert.equal(await page.evaluate(() => window.demo), 'app live');
    assert.equal(await page.locator('#render').textContent(), 'second render');
    // A page rendered for one visit (?project=) is served but does not become the shell.
    s.render = 'project cover';
    await page.goto(s.origin + '/portal/?project=p1');
    assert.equal(await page.locator('#render').textContent(), 'project cover');
    await page.evaluate(() => window.PlatformOffline.ready);
    await sleep(200);

    // The server cannot be reached.
    s.down = true;
    const windowPage = await context.newPage();
    const response = await windowPage.goto(s.origin + '/portal/?projectWindow=tok1');
    assert.equal(response.status(), 200);
    assert.equal(response.headers()['x-fm-offline'], 'shell');
    assert.equal(await windowPage.locator('#render').textContent(), 'second render', 'the page as this person last received it');
    assert.equal(await windowPage.evaluate(() => location.search), '?projectWindow=tok1');
    assert.equal(await windowPage.evaluate(() => window.demo), 'app r1', 'its scripts come from the set, whatever their ?v=');
    assert.equal(await windowPage.evaluate(() => window.__APP.userId), 'user_1');
    const css = await call(windowPage, 'GET', '/libraries/demo/style.css?v=123');
    assert.deepEqual([css.status, css.text, css.offline, css.type], [200, 'body{color:#111}', 'set', 'text/css']);
    assert.equal((await windowPage.goto(s.origin + '/portal/index.php?tab=feed')).headers()['x-fm-offline'], 'shell');
    assert.equal(await windowPage.evaluate(() => window.PlatformOffline.ready.then((state) => state.controlled)), true);
    assert.ok((await call(windowPage, 'GET', '/portal/not-a-shell.php')).error, 'other pages are not answered by the worker');

    // The connection returns. A page that was served from the set keeps running from it...
    s.down = false;
    s.files['/libraries/demo/style.css'] = 'body{color:#999}';
    assert.equal((await call(windowPage, 'GET', '/libraries/demo/style.css')).offline, 'set');
    // ...and a new load comes from the network again.
    await windowPage.goto(s.origin + '/portal/?projectWindow=tok1');
    assert.equal(await windowPage.locator('#render').textContent(), 'project cover');
    assert.deepEqual([(await call(windowPage, 'GET', '/libraries/demo/style.css')).text, (await call(windowPage, 'GET', '/libraries/demo/style.css')).offline], ['body{color:#999}', null]);
  });
});

test('JSON reads are saved and answered from the device when the server fails or is slow; streams and denied routes are left alone', async () => {
  await withBrowser(async (s, context) => {
    let title = 'Oak St';
    s.api = (request) => {
      if (request.path === '/v1/projects/p1') return { json: { project: { id: 'p1', title } } };
      if (request.path === '/v1/platform/portal-action') return { json: { success: true, notes: [request.body.project_id + ' note'] } };
      if (request.path === '/v1/platform/auth/session' || request.path.endsWith('/events/poll')) return { json: { private: true } };
      return null;
    };
    const page = await openPortal(context, s);
    const online = await call(page, 'GET', '/v1/projects/p1?b=2&a=1');
    assert.deepEqual([online.json.project.title, online.offline], ['Oak St', null]);
    await call(page, 'POST', '/v1/platform/portal-action', { action: 'list_notes', project_id: 'p1' });
    await call(page, 'GET', '/v1/platform/auth/session');
    await call(page, 'GET', '/v1/platform/organizations/org_1/events/poll?after=3');
    await until(async () => (await device(page)).responses.length === 2, 'the reads are stored');
    assert.deepEqual((await device(page)).responses, [['user_1', 'org_1', 'GET /v1/projects/p1?a=1&b=2'], ['user_1', 'org_1', 'POST /v1/platform/portal-action actions {"action":"list_notes","project":"p1"}']]);

    // Slow: the saved answer after the wait, and the late answer replaces the saved copy.
    title = 'Oak Street'; s.delay = 1500;
    const started = Date.now();
    const slow = await call(page, 'GET', '/v1/projects/p1?a=1&b=2');
    assert.ok(Date.now() - started < 1400, 'did not wait for the slow answer');
    assert.deepEqual([slow.json.project.title, slow.offline], ['Oak St', 'saved']);
    assert.ok(!Number.isNaN(Date.parse(slow.savedAt)));
    await sleep(1100);
    s.delay = 0;

    // Unreachable.
    s.down = true;
    const saved = await call(page, 'GET', '/v1/projects/p1?a=1&b=2&_=99');
    assert.deepEqual([saved.status, saved.json.project.title, saved.offline], [200, 'Oak Street', 'saved']);
    const action = await call(page, 'POST', '/v1/platform/portal-action', { action: 'list_notes', project_id: 'p1' });
    assert.deepEqual([action.json.notes, action.offline], [['p1 note'], 'saved']);
    assert.ok((await call(page, 'GET', '/v1/platform/auth/session')).error, 'a denied route fails as it would without a worker');
    assert.ok((await call(page, 'GET', '/v1/platform/organizations/org_1/events/poll?after=3')).error);
    assert.ok((await call(page, 'GET', '/v1/projects/never-read')).error);
    const eventSource = await page.evaluate(() => new Promise((resolve) => { const source = new EventSource('/v1/platform/organizations/org_1/events/stream'); source.onerror = () => { source.close(); resolve('failed'); }; source.onopen = () => resolve('open'); }));
    assert.equal(eventSource, 'failed', 'the realtime stream is never answered from the device');
    assert.equal((await state(page)).online, false, 'the last request failed');
  });
});

test('a contract write that fails on the network is queued, shown in reads, survives a closed page, and is sent once by one tab', async () => {
  await withBrowser(async (s, context) => {
    let notes = [{ id: 'n0', text: 'on the server' }];
    s.api = async (request) => {
      if (request.method === 'GET' && request.path === '/v1/projects/p1/notes') return { json: { notes } };
      if (request.method === 'POST' && request.path === '/v1/projects/p1/notes') { await sleep(300); notes = [...notes, { id: request.body.id, text: request.body.text, number: notes.length }]; return { status: 201, json: { ok: true, note: notes.at(-1) } }; }
      if (request.method === 'POST' && request.path === '/v1/things') return { json: { ok: true } };
      return null;
    };
    let page = await openPortal(context, s);
    await check(page);
    await call(page, 'GET', '/v1/projects/p1/notes');

    s.down = true;
    const queued = await call(page, 'POST', '/v1/projects/p1/notes', { id: 'n1', text: 'Call the homeowner' });
    assert.equal(queued.status, 200);
    assert.match(queued.queued, /^fmo1-/);
    assert.deepEqual(queued.json, { ok: true, note: { id: 'n1', text: 'Call the homeowner', waiting: true } });
    await until(async () => (await state(page)).pending === 1, 'the page hears about the queued change');
    assert.equal(await page.evaluate(() => window.PlatformOffline.isPending('n1')), true);
    assert.equal(await page.evaluate(() => window.PlatformOffline.isPending('n0')), false);
    assert.deepEqual((await events(page, 'queued')).map((detail) => [detail.id, detail.write, detail.label.detail]), [[queued.queued, 'notes.post', 'Call the homeowner']]);
    const list = await call(page, 'GET', '/v1/projects/p1/notes');
    assert.deepEqual([list.json.notes.map((note) => note.id), list.offline], [['n0', 'n1'], 'saved']);
    const refused = await call(page, 'POST', '/v1/things', { a: 1 });
    assert.deepEqual([refused.status, refused.json], [503, { ok: false, error: 'offline_unavailable' }]);

    // Close everything and open the portal again, still without the server.
    await page.close();
    page = await openPortal(context, s);
    const second = await openPortal(context, s);
    assert.equal(await page.locator('#render').textContent(), 'first render');
    assert.equal((await state(page)).pending, 1);
    assert.deepEqual((await page.evaluate(() => window.PlatformOffline.pending({ record: 'n1' }))).map((entry) => [entry.id, entry.state, entry.scope]), [[queued.queued, 'waiting', 'project:p1']]);
    assert.deepEqual(await page.evaluate(() => window.PlatformOffline.pending({ scope: 'project:other' })), []);
    assert.deepEqual((await call(page, 'GET', '/v1/projects/p1/notes')).json.notes.map((note) => note.id), ['n0', 'n1']);

    // The server is back. Both tabs are asked to sync; the lock lets one of them send.
    s.down = false;
    const mark = s.log.length;
    const fresh = await call(page, 'GET', '/v1/projects/p1/notes');
    assert.deepEqual([fresh.json.notes.map((note) => note.id), fresh.offline, fresh.overlay], [['n0', 'n1'], null, '1'], 'a fresh read shows it too');
    await Promise.all([page.evaluate(() => window.PlatformOffline.syncNow()), second.evaluate(() => window.PlatformOffline.syncNow())]);
    await until(async () => (await state(page)).pending === 0 && (await state(second)).pending === 0, 'both tabs see the queue empty');
    const posts = s.requests('POST', '/v1/projects/p1/notes', mark);
    assert.equal(posts.length, 1, 'sent once');
    assert.equal(posts[0].headers['idempotency-key'], queued.queued);
    assert.equal(posts[0].headers['x-fm-offline-replay'], '1');
    assert.equal(posts[0].headers['x-fm-offline-user'], 'user_1');
    assert.equal(posts[0].headers['x-fm-offline-org'], 'org_1');
    assert.equal(posts[0].headers['x-platform-csrf'], 'csrf-token-1');
    assert.deepEqual(posts[0].body, { id: 'n1', text: 'Call the homeowner' });
    for (const tab of [page, second]) {
      const synced = await until(async () => { const list = await events(tab, 'synced'); return list.length ? list : null; }, 'each tab hears it synced');
      assert.deepEqual([synced[0].id, synced[0].status, synced[0].response.note.number], [queued.queued, 201, 1]);
      assert.equal(await tab.evaluate(() => window.PlatformOffline.isPending('n1')), false);
    }
    assert.ok((await state(page)).lastSyncAt > 0);
    assert.deepEqual((await device(page)).outbox, []);
    // The read it touched was read again, so the saved copy is the server's.
    assert.ok(s.requests('GET', '/v1/projects/p1/notes', mark).some((get) => get.headers['x-fm-offline-replay'] === '1'));
    s.down = true;
    assert.deepEqual((await call(page, 'GET', '/v1/projects/p1/notes')).json.notes.map((note) => note.number ?? null), [null, 1]);
  });
});

test('a patch that both sides changed waits as a conflict until PlatformOffline.resolve', async () => {
  await withBrowser(async (s, context) => {
    let project = { id: 'p1', revision: 1, title: 'A', phone: '1' };
    s.api = (request) => {
      if (request.path !== '/v1/projects/p1') return null;
      if (request.method === 'GET') return { json: { project } };
      const { expected_revision: expected, ...change } = request.body;
      if (expected !== project.revision) return { status: 409, json: { ok: false, error: 'revision_conflict' } };
      project = { ...project, ...change, revision: project.revision + 1 };
      return { json: { ok: true, project } };
    };
    const page = await openPortal(context, s);
    await call(page, 'GET', '/v1/projects/p1');
    s.down = true;
    const queued = await call(page, 'PATCH', '/v1/projects/p1', { title: 'Mine', phone: '2' });
    assert.equal(queued.json.project.title, 'Mine');
    assert.equal((await call(page, 'GET', '/v1/projects/p1')).json.project.title, 'Mine');
    project = { ...project, revision: 2, title: 'Theirs' };
    s.down = false;
    await page.evaluate(() => window.PlatformOffline.syncNow());
    await until(async () => (await state(page)).conflicts === 1, 'the conflict is reported');
    const [conflict] = await events(page, 'conflict');
    assert.equal(conflict.id, queued.queued);
    assert.deepEqual(conflict.fields, [{ path: 'title', base: 'A', mine: 'Mine', theirs: 'Theirs' }]);
    assert.equal(s.requests('PATCH', '/v1/projects/p1').length, 0);
    const [entry] = await page.evaluate(() => window.PlatformOffline.pending());
    assert.deepEqual([entry.state, entry.conflict.fields.length], ['conflict', 1]);
    await page.evaluate(([id]) => window.PlatformOffline.resolve(id, { title: 'mine' }), [queued.queued]);
    await until(async () => { const now = await state(page); return now.conflicts === 0 && now.pending === 0; }, 'the resolved change is sent');
    const [patch] = s.requests('PATCH', '/v1/projects/p1');
    assert.deepEqual(patch.body, { title: 'Mine', phone: '2', expected_revision: 2 });
    assert.deepEqual([project.title, project.phone, project.revision], ['Mine', '2', 3]);
  });
});

test('queued uploads keep their file and answer its URLs; media files are cached within a budget; low space refuses', async () => {
  await withBrowser(async (s, context) => {
    const big = Buffer.alloc(512 * 1024, 7);
    s.api = (request) => {
      const file = /\/media\/([^/]+)\/file$/.exec(request.path);
      if (file && request.method === 'GET') return request.query.includes('huge') ? { bytes: Buffer.alloc(9 * 1024 * 1024, 1), type: 'image/jpeg' } : request.query.includes('medium') ? { bytes: big, type: 'image/jpeg' } : { bytes: Buffer.from('thumb of ' + file[1]), type: 'image/png' };
      if (request.method === 'POST' && request.path === '/v1/platform/organizations/org_1/media') return { status: 201, json: { ok: true, media: { id: 'media_1' } } };
      return null;
    };
    const page = await openPortal(context, s);
    const upload = (id) => call(page, 'POST', '/v1/platform/organizations/org_1/media', null, { form: { id, project_id: 'p1', file: { file: 'photo-bytes', name: 'roof.jpg', type: 'image/jpeg' } } });

    // A queued upload.
    s.down = true;
    const queued = await upload('media_1');
    assert.deepEqual([queued.status, queued.json.media.waiting], [200, true]);
    assert.deepEqual((await device(page)).blobs, [{ entry: queued.queued, name: 'roof.jpg', size: 11 }]);
    for (const variant of ['?variant=thumb_320', '']) {
      const file = await call(page, 'GET', '/v1/platform/organizations/org_1/media/media_1/file' + variant);
      assert.deepEqual([file.status, file.text, file.type, file.offline], [200, 'photo-bytes', 'image/jpeg', 'queued']);
    }
    assert.equal(await page.evaluate(() => new Promise((resolve) => { const image = new Image(); image.onload = () => resolve('loaded'); image.onerror = () => resolve('requested'); image.src = '/v1/platform/organizations/org_1/media/media_1/file?variant=thumb_320'; })), 'requested', 'an <img> is answered too (these bytes are not a picture)');
    s.down = false;
    await page.evaluate(() => window.PlatformOffline.syncNow());
    await until(async () => (await state(page)).pending === 0, 'the upload is sent');
    const [post] = s.requests('POST', '/v1/platform/organizations/org_1/media');
    assert.match(post.headers['content-type'], /^multipart\/form-data; boundary=/);
    assert.ok(post.raw.includes('photo-bytes') && post.raw.includes('filename="roof.jpg"') && post.raw.includes('name="project_id"'));
    assert.equal(post.headers['idempotency-key'], queued.queued);
    assert.deepEqual((await device(page)).blobs, [], 'the file left the device once it was uploaded');

    // The media cache: a variant is fetched once, then served from the device.
    const thumb = '/v1/platform/organizations/org_1/media/m2/file?variant=thumb_320';
    const first = await call(page, 'GET', thumb);
    assert.deepEqual([first.text, first.offline], ['thumb of m2', null]);
    await until(async () => (await device(page)).media.length === 1, 'the thumbnail is cached');
    const mark = s.log.length;
    const again = await call(page, 'GET', thumb);
    assert.deepEqual([again.text, again.offline, again.type], ['thumb of m2', 'saved', 'image/png']);
    assert.equal(s.requests('GET', '/v1/platform/organizations/org_1/media/m2', mark).length, 0);
    assert.deepEqual((await device(page)).caches['fm-media-v1'], ['/.fm-media/user_1/org_1/v1/platform/organizations/org_1/media/m2/file']);
    // A variant over 8 MB is served but not kept.
    assert.equal((await call(page, 'GET', '/v1/platform/organizations/org_1/media/m3/file?variant=huge', null, { size: true })).text, String(9 * 1024 * 1024));
    await sleep(300);
    assert.equal((await device(page)).media.length, 1);
    // The budget: least recently used files go first.
    await page.evaluate(() => window.PlatformOffline.settings.set('mediaBudgetMb', 1));
    assert.equal(await page.evaluate(() => window.PlatformOffline.settings.get('mediaBudgetMb')), 1);
    for (const id of ['a', 'b', 'c', 'd', 'e']) { await call(page, 'GET', `/v1/platform/organizations/org_1/media/${id}/file?variant=medium`, null, { size: true }); await sleep(120); }
    await until(async () => { const kept = (await device(page)).media; return kept.length === 2 && kept.every((url) => /\/(d|e)\/file/.test(url)); }, 'the oldest files were evicted');
    s.down = true;
    assert.equal((await call(page, 'GET', '/v1/platform/organizations/org_1/media/e/file?variant=medium', null, { size: true })).text, String(512 * 1024));
    assert.ok((await call(page, 'GET', '/v1/platform/organizations/org_1/media/a/file?variant=medium')).error);
    const report = (await page.evaluate(() => window.PlatformOffline.ready.then(() => window.PlatformOffline.state()))).storage;
    assert.deepEqual(Object.keys(report).sort(), ['budgets', 'media', 'persisted', 'queued', 'quota', 'reads', 'usage']);

    // Too little free space: the write is refused, not queued.
    await page.evaluate(() => navigator.serviceWorker.controller.postMessage({ test: 'space', value: { quota: 100 * 1024 * 1024, usage: 95 * 1024 * 1024 } }));
    const full = await upload('media_9');
    assert.deepEqual([full.status, full.json], [507, { ok: false, error: 'offline_storage_full' }]);
    assert.deepEqual((await device(page)).outbox, []);
  });
});

test('identity: nothing before a page says who is signed in; sign-out removes shells and saved reads and keeps the queue for that person', async () => {
  await withBrowser(async (s, context) => {
    let posts = [];
    s.api = (request) => {
      if (request.method === 'GET' && request.path.startsWith('/v1/projects/')) return { json: { project: { id: 'p1' }, notes: [] } };
      if (request.method === 'POST' && request.path === '/v1/projects/p1/notes') { posts.push(request); return { json: { ok: true } }; }
      return null;
    };
    const page = await openPortal(context, s);
    await check(page);

    // A page in the worker's scope that never says who is signed in.
    const plain = await context.newPage();
    await plain.goto(s.origin + '/portal/plain.html');
    assert.equal(await plain.evaluate(() => !!navigator.serviceWorker.controller), true);
    assert.equal((await call(plain, 'GET', '/v1/projects/p1')).status, 200);
    s.down = true;
    assert.ok((await call(plain, 'GET', '/v1/projects/p1')).error, 'nothing was saved for it');
    assert.deepEqual((await call(plain, 'POST', '/v1/projects/p1/notes', { id: 'x', text: 'x' })).json, { ok: false, error: 'offline_unavailable' });
    assert.deepEqual([(await device(plain)).responses, (await device(plain)).outbox], [[], []]);
    s.down = false;

    // The signed-in person reads, queues a change, then signs out.
    await call(page, 'GET', '/v1/projects/p1');
    await call(page, 'GET', '/v1/projects/p1/notes');
    s.down = true;
    const queued = await call(page, 'POST', '/v1/projects/p1/notes', { id: 'n1', text: 'mine' });
    await until(async () => (await state(page)).pending === 1, 'queued');
    s.down = false;
    let d = await device(plain);
    assert.equal(d.responses.length, 2);
    assert.ok(d.caches['fm-set-r1'].includes('/.fm-shell/user_1/org_1/portal/'));
    s.delay = 0;
    posts = [];
    // Hold the queue so the sign-out happens with the change still waiting.
    s.down = true;
    await page.goto(s.origin + '/portal/logout.php').catch(() => null);          // the sign-out navigation; the server is away
    await until(async () => (await device(plain)).responses.length === 0, 'saved reads are removed at sign-out');
    d = await device(plain);
    assert.ok(!d.caches['fm-set-r1'].some((path) => path.startsWith('/.fm-shell/')), 'the shell is removed');
    assert.ok(d.caches['fm-set-r1'].includes('/libraries/demo/app.js'), 'the code set stays');
    assert.deepEqual(d.outbox.map((entry) => [entry.id, entry.user, entry.state]), [[queued.queued, 'user_1', 'waiting']], 'the queued change stays');
    assert.equal(d.meta.identity, undefined);
    // With nobody signed in on the device there is no page to show offline.
    const gone = await page.goto(s.origin + '/portal/');
    assert.equal(gone.status(), 503);
    assert.equal(gone.headers()['x-fm-offline'], 'connect-once');
    assert.match(await page.locator('h1').textContent(), /No connection/);

    // Someone else signs in on this device: the first person's change is not sent and not shown.
    s.down = false; s.user = { id: 'user_2', org: 'org_1' };
    await page.close();
    const other = await openPortal(context, s);
    assert.equal(await other.evaluate(() => window.__APP.userId), 'user_2');
    assert.equal((await state(other)).pending, 0);
    await other.evaluate(() => window.PlatformOffline.syncNow());
    await sleep(400);
    assert.equal(posts.length, 0, 'never replayed under another identity');
    assert.deepEqual((await call(other, 'GET', '/v1/projects/p1/notes')).json.notes, []);
    assert.equal((await device(other)).outbox.length, 1);

    // The first person signs in again: now it is sent.
    await other.evaluate(() => window.PlatformOffline.signedOut());
    s.user = { id: 'user_1', org: 'org_1' };
    await other.close();
    const back = await openPortal(context, s);
    assert.equal((await state(back)).pending, 1);
    await back.evaluate(() => window.PlatformOffline.syncNow());
    await until(async () => posts.length === 1, 'sent after the same person signed in');
    assert.equal(posts[0].headers['x-fm-offline-user'], 'user_1');
    assert.equal(posts[0].headers['idempotency-key'], queued.queued);
  });
});

test('the kill switch: enabled false removes the caches and the worker, from the worker and from the page', async () => {
  await withBrowser(async (s, context) => {
    s.api = (request) => (request.path === '/v1/projects/p1' ? { json: { project: { id: 'p1' } } } : null);
    const page = await openPortal(context, s);
    await check(page);
    await call(page, 'GET', '/v1/projects/p1');
    s.down = true;
    await call(page, 'POST', '/v1/projects/p1/notes', { id: 'n1', text: 'keep me' });
    s.down = false;
    let d = await device(page);
    assert.deepEqual([d.registrations, Object.keys(d.caches).includes('fm-set-r1'), d.responses.length, d.outbox.length], [1, true, 1, 1]);

    // The worker reads the manifest itself and removes itself.
    s.enabled = false;
    await page.evaluate(() => new Promise((resolve) => {
      navigator.serviceWorker.addEventListener('message', (event) => { if (event.data && event.data.re === 'kill') resolve(); });
      navigator.serviceWorker.controller.postMessage({ fm: 'offline', id: 'kill', type: 'check', wait: true });
    }));
    await until(async () => (await device(page)).registrations === 0, 'the worker unregistered');
    d = await device(page);
    assert.deepEqual(Object.keys(d.caches).filter((name) => name.startsWith('fm-')), []);
    assert.deepEqual(d.responses, []);
    assert.equal(d.outbox.length, 1, 'a queued change is never thrown away');
    assert.equal((await state(page)).code.status, 'disabled');
    // Pages stop registering it.
    await page.reload();
    assert.equal((await page.evaluate(() => window.PlatformOffline.ready)).controlled, false);
    assert.equal((await device(page)).registrations, 0);

    // Enabled again, then switched off while a page is open: the page's own check removes it.
    s.enabled = true;
    await page.reload();
    await page.evaluate(() => window.PlatformOffline.ready);
    assert.deepEqual(await check(page), { release: 'r1', status: 'ready', progress: 1 });
    s.enabled = false;
    assert.equal((await check(page)).status, 'disabled');
    d = await device(page);
    assert.deepEqual([d.registrations, Object.keys(d.caches).filter((name) => name.startsWith('fm-'))], [0, []]);
  });
});

test('safety: an internal error falls back to the network, the worker takes over at once, nothing reloads a page', async () => {
  const worker = real('portal/sw.js').toString();
  const engine = real('libraries/platform-offline/offline-core.js').toString();
  const pageApi = real('libraries/platform-offline/platform-offline.js').toString();
  assert.match(worker, /addEventListener\('install', \(\) => \{ self\.skipWaiting\(\); \}\)/);
  assert.match(worker, /addEventListener\('activate', \(event\) => \{ event\.waitUntil\(self\.clients\.claim\(\)\); \}\)/);
  assert.match(pageApi, /register\(WORKER_URL, \{ scope: SCOPE, updateViaCache: 'none' \}\)/);
  // No code path reloads or navigates a page. The one reload is the button a person presses on the worker's
  // "no connection" page.
  for (const [name, source] of [['offline-core.js', engine], ['platform-offline.js', pageApi]]) assert.ok(!/\.reload\(|location\.(href|assign|replace)\s*[=(]|\.navigate\(/.test(source), name);
  assert.deepEqual(worker.match(/[^\n]*\.reload\(|[^\n]*\.navigate\(/g).map((line) => /<button type="button" onclick="location\.reload\($/.test(line)), [true]);
  assert.ok(!/EventSource|WebSocket/.test(worker + engine + pageApi), 'no stream of its own');

  await withBrowser(async (s, context) => {
    let posts = 0;
    s.api = (request) => {
      if (request.method === 'POST') { posts++; return { json: { ok: true, from: 'server', body: request.body } }; }
      return { json: { ok: true, from: 'server' } };
    };
    const page = await openPortal(context, s);
    await check(page);
    // A contract whose function throws: the request reaches the server as if there were no contract.
    assert.deepEqual((await call(page, 'POST', '/v1/broken', { a: 1 })).json, { ok: true, from: 'server', body: { a: 1 } });
    // A handler that throws inside the worker: the request goes to the network, once.
    await page.evaluate(() => navigator.serviceWorker.controller.postMessage({ test: 'break-plan' }));
    await sleep(100);
    posts = 0;
    assert.equal((await call(page, 'GET', '/v1/projects/p1')).json.from, 'server');
    assert.deepEqual((await call(page, 'POST', '/v1/projects/p1/notes', { id: 'n1', text: 'x' })).json.body, { id: 'n1', text: 'x' });
    assert.equal(posts, 1);
    // An error while deciding what to do with a request: the browser handles it as if there were no worker.
    await page.evaluate(() => navigator.serviceWorker.controller.postMessage({ test: 'break-route' }));
    await sleep(100);
    assert.equal((await call(page, 'GET', '/v1/projects/p2')).json.from, 'server');
    assert.equal((await call(page, 'POST', '/v1/projects/p1/notes', { id: 'n2', text: 'y' })).json.from, 'server');
    assert.equal((await call(page, 'GET', '/libraries/demo/data.txt')).text, 'data r1');
  });
});
