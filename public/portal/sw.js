/* public/portal/sw.js
 *
 * The portal's service worker, scope /portal/ (docs/architecture/offline.md). The one place that sees every
 * request a portal page makes, so the one place offline behaviour is added:
 *
 *   code     one consistent set of browser files per release (cache fm-set-<release>) and the person's shells
 *   reads    JSON answers saved and served when the server cannot be reached     (the engine, offline-core.js)
 *   writes   changes a contract describes are queued and shown until they are sent (the engine)
 *
 * With a connection every request still reaches the network. Any internal error falls back to a plain
 * network fetch. Nothing here reloads a page.
 */
'use strict';

const LIBRARY = '/libraries/platform-offline/';
const MANIFEST_URL = '/v1/platform/offline/assets';
const SET_PREFIX = 'fm-set-';
const EXTERNAL_CACHE = 'fm-ext-v1';
const SHELL_PREFIX = '/.fm-shell/';
const DEFAULT_SHELLS = ['/portal/'];
// Query parameters index.php renders differently for; such an answer is one visit's page, not the shell.
const RENDER_PARAMS = ['project', 'projectTab', 'photoScope', 'onboarding', 'paid', 'tutorial'];
const NAVIGATION_WAIT_MS = 8000;
const NAVIGATION_WAIT_AFTER_FAILURE_MS = 3500;
const DOWNLOADS_AT_ONCE = 6;

let FM = null;
try { importScripts(LIBRARY + 'offline-core.js'); FM = self.FMOffline || null; } catch (_) { FM = null; }
if (FM) {
  try { importScripts(LIBRARY + 'contracts/index.js'); } catch (_) { /* no list: nothing is queued, reads are still saved */ }
  for (const file of self.FM_OFFLINE_CONTRACTS || []) {
    try { importScripts(LIBRARY + 'contracts/' + file); } catch (error) { console.warn('[offline] contract not loaded:', file, error); }
  }
}

// A new worker takes over at once; pages keep running and are never reloaded.
self.addEventListener('install', () => { self.skipWaiting(); });
self.addEventListener('activate', (event) => { event.waitUntil(self.clients.claim()); });

// Without the engine the worker is inert: no fetch handler, every request is the browser's.
if (FM) start();

function start() {
  const S = {
    loaded: false,
    killed: false,
    identity: null,                           // the person last seen signed in on this device
    clients: {},                              // client id -> { user, org, offline: release | null }
    sets: { active: null, previous: null },
    manifests: {},                            // release -> { release, files: { path: sha }, shells, external }
    files: {},                                // release -> Set of paths
    code: { release: null, status: 'none', progress: 0 },
    copy: null,
    arriving: null                            // { who, at }: the identity of a page that is being created
  };

  const boot = (async () => {
    const [identity, clients, sets, copy] = await Promise.all([FM.meta.get('identity', null), FM.meta.get('clients', {}), FM.meta.get('sets', null), FM.meta.get('copy', null)]);
    S.identity = identity;
    S.clients = clients || {};
    S.sets = sets || { active: null, previous: null };
    S.copy = copy;
    for (const release of new Set([S.sets.active, S.sets.previous, ...Object.values(S.clients).map((client) => client.offline)])) if (release) await loadManifest(release);
    if (S.sets.active) S.code = { release: S.sets.active, status: 'ready', progress: 1 };
  })().catch(() => {}).then(() => { S.loaded = true; });

  FM.configure({
    identity: async () => { await boot; return S.identity; },
    // Background Sync runs without a page: the worker reads the readable CSRF cookie itself (Cookie Store API).
    csrf: async () => {
      const name = S.identity && S.identity.csrfCookie;
      if (!name || !self.cookieStore) return '';
      try { const cookie = await self.cookieStore.get(name); return cookie ? decodeURIComponent(cookie.value) : ''; } catch (_) { return ''; }
    }
  });
  FM.events.on('net', () => FM.events.emit('state', { online: FM.net.online() }));

  const setName = (release) => SET_PREFIX + release;
  const saveClients = () => FM.meta.set('clients', S.clients).catch(() => {});
  const ARRIVING_MS = 30000;
  function identityOf(clientId) {
    const client = clientId && S.clients[clientId];
    if (client && client.user) return { user: client.user, org: client.org };
    // A browser that does not name the page a navigation creates: that page's first requests take the identity
    // its navigation answered with.
    if (clientId && !client && S.arriving && Date.now() - S.arriving.at < ARRIVING_MS) {
      S.clients[clientId] = { user: S.arriving.who.user, org: S.arriving.who.org };
      saveClients();
      return S.arriving.who;
    }
    return null;
  }
  /**
   * Whose page a navigation is, known from its answer (X-FirstMate-Identity, or the stored shell's owner), so
   * the page's first requests are already saved and answered as theirs. The page's own identity message
   * follows and says the same.
   */
  function noteClient(clientId, who) {
    if (!who || !who.user || !who.org) return;
    if (!clientId) { S.arriving = { who: { user: who.user, org: who.org }, at: Date.now() }; return; }
    S.clients[clientId] = Object.assign({}, S.clients[clientId], { user: who.user, org: who.org });
    saveClients();
  }

  async function loadManifest(release) {
    if (!S.manifests[release]) {
      const stored = await FM.meta.get('set:' + release, null);
      if (stored) { S.manifests[release] = stored; S.files[release] = new Set(Object.keys(stored.files)); }
    }
    return S.manifests[release] || null;
  }

  // -------------------------------------------------------------------------------------------------------
  // fetch
  // -------------------------------------------------------------------------------------------------------

  self.addEventListener('fetch', (event) => {
    if (S.killed) return;
    let handler = null;
    try { handler = route(event); } catch (_) { handler = null; }
    if (!handler) return;
    // An internal error never costs the page its request: it goes to the network as if there were no worker.
    event.respondWith(Promise.resolve().then(handler).catch((error) => {
      if (error && (error.fmNetwork || error.name === 'AbortError')) throw error;
      return fetch(event.request);
    }));
  });

  /** A real network failure with nothing saved: the page gets the failure, not a second attempt. */
  function networkFailure(error) { try { error.fmNetwork = true; } catch (_) { /* a frozen error */ } return error; }

  function route(event) {
    const request = event.request;
    const url = new URL(request.url);
    if (url.origin !== self.location.origin) return request.method === 'GET' ? externalHandler(event, url) : null;
    if (request.mode === 'navigate') return navigationHandler(event, url);
    if (url.pathname.startsWith('/v1/')) {
      if (FM.api.ignores(request, url)) return null;
      const options = { waitUntil: (promise) => { try { event.waitUntil(promise); } catch (_) { /* the event already ended */ } } };
      if (S.loaded) return FM.api.plan(request, identityOf(event.clientId), options);
      return async () => { await boot; const plan = FM.api.plan(request, identityOf(event.clientId), options); return plan ? plan() : fetch(request); };
    }
    if (request.method !== 'GET') return null;
    if (S.loaded) return fileHandler(event, url);
    return async () => { await boot; const handler = fileHandler(event, url); return handler ? handler() : fetch(request); };
  }

  // --- pages ---

  /** '/portal/' for /portal/ and /portal/index.php (any query), by the shells the manifest lists. */
  function shellFor(pathname) {
    const path = pathname.replace(/index\.php$/, '');
    const shells = (S.sets.active && S.manifests[S.sets.active] && S.manifests[S.sets.active].shells) || DEFAULT_SHELLS;
    return shells.includes(path) ? path : null;
  }
  const shellKey = (who, shell) => `${SHELL_PREFIX}${encodeURIComponent(who.user)}/${encodeURIComponent(who.org)}${shell}`;

  function navigationHandler(event, url) {
    if (/\/logout\.php$/.test(url.pathname)) {
      // Sign-out is this navigation. The person's shells and saved reads leave the device; the request goes on.
      event.waitUntil(boot.then(() => signOut(identityOf(event.clientId) || S.identity)).catch(() => {}));
      return null;
    }
    if (!S.loaded) return async () => { await boot; const handler = navigationHandler(event, url); return handler ? handler() : fetch(event.request); };
    const shell = shellFor(url.pathname);
    if (!shell) return null;
    return async () => {
      // A frame of a page that runs from the set gets the same set, so one window never mixes two releases.
      const parent = event.request.destination === 'iframe' ? await offlineParent(event.request) : null;
      if (parent) {
        const stored = await storedShell(shell, [parent]);
        if (stored) { markOffline(event.resultingClientId, stored.release); return stored.response; }
      }
      const network = fetch(event.request).then((response) => { FM.net.ok(); return response; }, (error) => { FM.net.fail(); throw error; });
      network.catch(() => {});
      let response = null;
      let failure = null;
      try { response = await FM.util.race(network, FM.net.lastFailed ? NAVIGATION_WAIT_AFTER_FAILURE_MS : NAVIGATION_WAIT_MS); } catch (error) { failure = error; }
      if (response) {
        if (response.status === 200) noteClient(event.resultingClientId, parseIdentity(response.headers.get('x-firstmate-identity')));
        if (response.status === 200 && S.sets.active && !RENDER_PARAMS.some((name) => url.searchParams.has(name))) {
          const copy = response.clone();
          event.waitUntil(caches.open(setName(S.sets.active)).then((cache) => keepShell(cache, S.sets.active, shell, copy)).catch(() => {}));
        }
        return response;
      }
      const stored = await storedShell(shell, [S.sets.active, S.sets.previous]);
      if (stored) { markOffline(event.resultingClientId, stored.release); return stored.response; }
      if (!failure) { try { return await network; } catch (_) { /* slow, then gone */ } }
      return connectOncePage();
    };
  }

  /** The stored page of the person signed in on this device, from the first of `releases` that has it. */
  async function storedShell(shell, releases) {
    if (!S.identity) return null;
    for (const release of releases) {
      if (!release || !(await caches.has(setName(release)))) continue;
      const hit = await (await caches.open(setName(release))).match(shellKey(S.identity, shell));
      if (!hit) continue;
      const headers = new Headers(hit.headers);
      headers.set('X-FM-Offline', 'shell');
      headers.set('Cache-Control', 'no-store');
      return { release, response: new Response(hit.body, { status: 200, headers }) };
    }
    return null;
  }

  function markOffline(clientId, release) {
    noteClient(clientId, S.identity);        // a stored shell is only ever served to its owner
    if (!clientId) return;
    S.clients[clientId] = Object.assign({}, S.clients[clientId], { offline: release });
    saveClients();
  }

  /** The release of the offline-mode page that is opening this frame, or null. */
  async function offlineParent(request) {
    const offline = Object.entries(S.clients).filter(([, client]) => client.offline);
    if (!offline.length) return null;
    if (!request.referrer) return offline[0][1].offline;
    const windows = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    const parent = windows.find((client) => client.url === request.referrer && S.clients[client.id] && S.clients[client.id].offline);
    return parent ? S.clients[parent.id].offline : null;
  }

  /**
   * Stores a portal page as a shell when it is a 200 HTML page for `release` that says whose it is
   * (X-FirstMate-Identity). `response` is consumed. A login redirect or an error page never qualifies.
   */
  async function keepShell(cache, release, shell, response) {
    if (response.status !== 200 || !/html/i.test(response.headers.get('content-type') || '')) return false;
    const who = parseIdentity(response.headers.get('x-firstmate-identity'));
    if (!who) return false;
    const served = response.headers.get('x-firstmate-release') || '';
    if (served && served !== release) return false;
    const body = await response.arrayBuffer();
    await cache.put(shellKey(who, shell), new Response(body, { status: 200, headers: { 'Content-Type': response.headers.get('content-type'), 'X-FirstMate-Release': release, 'X-FM-Stored-At': new Date().toISOString() } }));
    return true;
  }

  function parseIdentity(header) {
    const parts = String(header || '').split('/');
    if (parts.length !== 2) return null;
    try { const user = decodeURIComponent(parts[0]); const org = decodeURIComponent(parts[1]); return user && org ? { user, org } : null; } catch (_) { return null; }
  }

  /** Shown for a portal page when there is no connection and nothing of this person is on the device yet. */
  function connectOncePage() {
    const escape = (text) => String(text).replace(/[&<>"]/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[char]));
    const copy = Object.assign({ title: 'No connection', body: 'FirstMate is not saved on this device yet. Connect to the internet and open it once. After that it opens without a connection.', retry: 'Try again' }, S.copy || {});
    const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${escape(copy.title)}</title>
<style>body{margin:0;min-height:100vh;display:grid;place-items:center;font:16px/1.5 system-ui,-apple-system,Segoe UI,Roboto,sans-serif;background:#f7f8fa;color:#1f2937}main{max-width:26rem;padding:2rem;text-align:center}h1{font-size:1.25rem;margin:0 0 .5rem}p{margin:0 0 1.25rem;color:#4b5563}button{font:inherit;padding:.6rem 1.2rem;border:0;border-radius:.5rem;background:#d93025;color:#fff;cursor:pointer}</style></head>
<body><main><h1>${escape(copy.title)}</h1><p>${escape(copy.body)}</p><button type="button" onclick="location.reload()">${escape(copy.retry)}</button></main></body></html>`;
    return new Response(html, { status: 503, headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', 'X-FM-Offline': 'connect-once' } });
  }

  // --- files of the set ---

  function fileHandler(event, url) {
    const client = S.clients[event.clientId];
    const offline = client && client.offline;
    const path = url.pathname;
    if (offline && S.files[offline] && S.files[offline].has(path)) {
      // A page served from the set runs from that set for its lifetime, without waiting for the network.
      return async () => (await fromSet(offline, path)) || fetch(event.request);
    }
    const releases = [S.sets.active, S.sets.previous].filter((release) => release && S.files[release] && S.files[release].has(path));
    if (!releases.length) return null;
    return async () => {
      try { const response = await fetch(event.request); FM.net.ok(); return response; } catch (error) {
        FM.net.fail();
        for (const release of releases) { const hit = await fromSet(release, path); if (hit) return hit; }
        throw networkFailure(error);
      }
    };
  }

  /** A set entry by path alone: the same file is requested under several `?v=` values. */
  async function fromSet(release, path) {
    if (!(await caches.has(setName(release)))) return null;
    const hit = await (await caches.open(setName(release))).match(path);
    if (!hit) return null;
    const headers = new Headers(hit.headers);
    headers.set('X-FM-Offline', 'set');
    return new Response(hit.body, { status: 200, headers });
  }

  // --- listed external files (fonts, icon CSS): cache, refreshed in the background ---

  function externalHandler(event, url) {
    if (!S.loaded || !S.sets.active) return null;
    const listed = (S.manifests[S.sets.active] && S.manifests[S.sets.active].external) || [];
    const href = url.href;
    if (!listed.some((entry) => (entry.endsWith('*') ? href.startsWith(entry.slice(0, -1)) : entry === href))) return null;
    return async () => {
      const cache = await caches.open(EXTERNAL_CACHE);
      const hit = await cache.match(href);
      const refresh = fetch(event.request).then(async (response) => { if (response.ok || response.type === 'opaque') await cache.put(href, response.clone()); return response; });
      if (!hit) { try { return await refresh; } catch (error) { throw networkFailure(error); } }
      event.waitUntil(refresh.catch(() => {}));
      return hit;
    };
  }

  // -------------------------------------------------------------------------------------------------------
  // Sets: one release's files, downloaded whole, then made active
  // -------------------------------------------------------------------------------------------------------

  // One check at a time, in the order they were asked: a later manifest is never answered by an earlier check.
  let checking = Promise.resolve();
  function checkForUpdate(given) {
    checking = checking.then(() => runCheck(given)).catch(() => S.code);
    return checking;
  }

  async function runCheck(given) {
    await boot;
    if (S.killed) return S.code;
    let manifest = given && typeof given === 'object' ? given : null;
    if (!manifest) {
      let response;
      try { response = await fetch(MANIFEST_URL, { cache: 'no-store', credentials: 'same-origin' }); } catch (_) { FM.net.fail(); return S.code; }
      FM.net.ok();
      if (!response.ok) return S.code;
      manifest = await response.json();
    }
    if (manifest.enabled === false) { await kill(); return S.code; }
    if (!manifest.release || !manifest.files || typeof manifest.files !== 'object') return S.code;
    const files = {};
    for (const [path, value] of Object.entries(manifest.files)) files[path] = String(Array.isArray(value) ? value[0] : value);
    const wanted = { release: String(manifest.release), files, shells: Array.isArray(manifest.shells) && manifest.shells.length ? manifest.shells : DEFAULT_SHELLS, external: Array.isArray(manifest.external) ? manifest.external : [] };
    if (wanted.release === S.sets.active) {
      // The active set: make sure the person signed in now has their shells, and the listed external files.
      const cache = await caches.open(setName(wanted.release));
      for (const shell of wanted.shells) if (S.identity && !(await cache.match(shellKey(S.identity, shell)))) await fetchShell(cache, wanted.release, shell).catch(() => false);
      await keepExternal(wanted.external).catch(() => {});
      setCode({ release: wanted.release, status: 'ready', progress: 1 });
      return S.code;
    }
    await buildSet(wanted);
    return S.code;
  }

  /** Downloads `wanted` into its own cache and makes it the active set only when every file and shell is stored. */
  async function buildSet(wanted) {
    const release = wanted.release;
    const before = S.sets.active;
    const cache = await caches.open(setName(release));
    const from = before && (await caches.has(setName(before))) ? await caches.open(setName(before)) : null;
    const paths = Object.keys(wanted.files);
    const resting = () => ({ release: before, status: before ? 'ready' : 'none' });
    let done = 0;
    let failed = 0;
    let misses = 0;                          // network failures in a row: the connection is gone, stop asking
    let shown = 0;
    setCode(Object.assign(resting(), { status: 'downloading', next: release, progress: 0 }));
    await FM.util.pool(paths, DOWNLOADS_AT_ONCE, async (path) => {
      if (misses >= 3) { failed++; return; }
      let stored = false;
      try { stored = await storeFile(cache, from, path, wanted.files[path]); misses = 0; } catch (_) { misses++; }
      if (stored) done++; else failed++;
      const progress = paths.length ? done / paths.length : 1;
      if (progress - shown >= 0.05) { shown = progress; setCode(Object.assign(resting(), { status: 'downloading', next: release, progress })); }
    });
    // An incomplete set stays as it is, never serves, and is continued at the next check.
    if (failed) { setCode(Object.assign(resting(), { next: release, progress: paths.length ? done / paths.length : 0 })); return false; }
    for (const shell of wanted.shells) {
      if (!(await fetchShell(cache, release, shell).catch(() => false))) { setCode(Object.assign(resting(), { next: release, progress: 1 })); return false; }
    }
    await FM.meta.set('set:' + release, wanted);
    S.manifests[release] = wanted;
    S.files[release] = new Set(paths);
    S.sets = { active: release, previous: before };
    await FM.meta.set('sets', S.sets);
    await pruneSets();
    setCode({ release, status: 'ready', progress: 1 });
    await keepExternal(wanted.external).catch(() => {});
    return true;
  }

  /** One file of a set: already there, copied from the active set when its bytes are the same, or downloaded and checked. */
  async function storeFile(cache, from, path, sha) {
    const have = await cache.match(path);
    if (have && have.headers.get('x-fm-sha') === sha) return true;
    if (from) {
      const old = await from.match(path);
      if (old && old.headers.get('x-fm-sha') === sha) { await cache.put(path, old); return true; }
    }
    for (let attempt = 0; attempt < 2; attempt++) {
      const response = await fetch(path, { cache: 'no-store', credentials: 'same-origin' });
      if (!response.ok) return false;
      const body = await response.arrayBuffer();
      const actual = await sha256(body);
      // The dev live layer serves a newer copy than the release lists; it is accepted as served.
      const live = response.headers.get('x-firstmate-live') === '1';
      if (actual !== sha && !live) continue;
      await cache.put(path, new Response(body, { status: 200, headers: { 'Content-Type': response.headers.get('content-type') || 'application/octet-stream', 'X-FM-Sha': actual } }));
      return true;
    }
    return false;
  }

  async function sha256(buffer) {
    const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', buffer));
    let hex = '';
    for (const byte of digest) hex += byte.toString(16).padStart(2, '0');
    return hex;
  }

  /** Fetches a shell with the person's session and stores it; false when it is not their page for this release. */
  async function fetchShell(cache, release, shell) {
    const response = await fetch(shell, { cache: 'no-store', credentials: 'include' });
    return keepShell(cache, release, shell, response);
  }

  async function keepExternal(urls) {
    const cache = await caches.open(EXTERNAL_CACHE);
    await FM.util.pool(urls.filter((url) => !url.endsWith('*')), 4, async (url) => {
      if (await cache.match(url)) return;
      let response = null;
      try { response = await fetch(url, { mode: 'cors', credentials: 'omit' }); } catch (_) { try { response = await fetch(url, { mode: 'no-cors', credentials: 'omit' }); } catch (__) { response = null; } }
      if (response && (response.ok || response.type === 'opaque')) await cache.put(url, response);
    });
  }

  /** Deletes sets other than the active one, the previous one and any a page still runs from. */
  async function pruneSets() {
    await sweepClients().catch(() => {});
    const keep = new Set([S.sets.active, S.sets.previous, ...Object.values(S.clients).map((client) => client.offline)].filter(Boolean).map(setName));
    for (const name of await caches.keys()) {
      if (!name.startsWith(SET_PREFIX) || keep.has(name)) continue;
      await caches.delete(name);
      const release = name.slice(SET_PREFIX.length);
      delete S.manifests[release];
      delete S.files[release];
      await FM.meta.del('set:' + release);
    }
  }

  function setCode(next) {
    S.code = Object.assign({ release: null, status: 'none', progress: 0 }, next);
    FM.events.emit('code', S.code);
  }

  /** The kill switch (`enabled: false`): caches and saved reads go, the worker unregisters. Queued changes stay. */
  async function kill() {
    S.killed = true;
    for (const name of await caches.keys()) if (name.startsWith('fm-')) await caches.delete(name);
    await FM.db.delPrefix('responses').catch(() => {});
    await FM.db.delPrefix('media').catch(() => {});
    for (const release of Object.keys(S.manifests)) await FM.meta.del('set:' + release).catch(() => {});
    await FM.meta.del('sets').catch(() => {});
    S.sets = { active: null, previous: null };
    S.manifests = {};
    S.files = {};
    setCode({ release: null, status: 'disabled', progress: 0 });
    await self.registration.unregister();
  }

  // -------------------------------------------------------------------------------------------------------
  // Identity and sign-out
  // -------------------------------------------------------------------------------------------------------

  /** Removes a person's shells and saved reads from the device. Their queued changes stay. */
  async function signOut(who) {
    const user = who && who.user;
    if (!user) return false;
    await FM.identity.signOut(user);
    const prefix = SHELL_PREFIX + encodeURIComponent(user) + '/';
    for (const name of await caches.keys()) {
      if (!name.startsWith(SET_PREFIX)) continue;
      const cache = await caches.open(name);
      for (const request of await cache.keys()) if (new URL(request.url).pathname.startsWith(prefix)) await cache.delete(request);
    }
    if (S.identity && S.identity.user === user) S.identity = null;
    for (const [id, client] of Object.entries(S.clients)) if (client.user === user) delete S.clients[id];
    await saveClients();
    FM.events.emit('state', { signedOut: user });
    return true;
  }

  /** Forgets pages that are gone. */
  async function sweepClients() {
    const open = new Set((await self.clients.matchAll({ type: 'window', includeUncontrolled: true })).map((client) => client.id));
    let changed = false;
    for (const id of Object.keys(S.clients)) if (!open.has(id)) { delete S.clients[id]; changed = true; }
    if (changed) await saveClients();
  }

  async function fullState(who) {
    return { online: FM.net.online(), syncing: FM.replay.active, queue: await FM.state.queue(who), code: S.code, storage: await FM.storage.report().catch(() => null) };
  }

  // -------------------------------------------------------------------------------------------------------
  // Messages from pages: { fm: 'offline', id, type, ... } -> { fm: 'offline', re: id, ok, result | error }
  // -------------------------------------------------------------------------------------------------------

  self.addEventListener('message', (event) => {
    const message = event.data;
    if (!message || message.fm !== 'offline' || !message.type) return;
    const source = event.source;
    const reply = (payload) => { try { if (source && message.id != null) source.postMessage(Object.assign({ fm: 'offline', re: message.id }, payload)); } catch (_) { /* the page is gone */ } };
    event.waitUntil(boot.then(() => onMessage(message, source, event)).then((result) => reply({ ok: true, result }), (error) => reply({ ok: false, error: String((error && error.message) || error) })));
  });

  async function onMessage(message, source, event) {
    const clientId = source && source.id;
    const who = () => {
      const identity = identityOf(clientId);
      if (!identity) throw new Error('This page has not said who is signed in');
      return identity;
    };
    switch (message.type) {
      case 'identity': {
        const user = String(message.user || '');
        const org = String(message.org || '');
        if (!user || !org || !clientId) return { engine: FM.version, state: await fullState(null), settings: await FM.settings.all(), offline: null };
        S.clients[clientId] = Object.assign({}, S.clients[clientId], { user, org });
        S.identity = { user, org, csrfCookie: String(message.csrfCookie || '') };
        if (message.copy && typeof message.copy === 'object') { S.copy = message.copy; await FM.meta.set('copy', S.copy); }
        await FM.identity.set(S.identity);
        await saveClients();
        await sweepClients();
        // A page of this person just loaded, so they are signed in: lift a sign-in pause and send what was parked.
        await FM.queue.resume({ user, org });
        return { engine: FM.version, state: await fullState({ user, org }), settings: await FM.settings.all(), offline: S.clients[clientId].offline || null };
      }
      case 'state': return fullState(identityOf(clientId));
      case 'check': {
        const check = checkForUpdate(message.manifest);
        if (message.wait) return check;
        event.waitUntil(check);
        return S.code;
      }
      case 'pending': {
        const entries = (await FM.queue.list(who())).map(FM.queue.public);
        return entries.filter((entry) => (!message.scope || entry.scope === message.scope) && (!message.record || (entry.records || []).includes(String(message.record))));
      }
      case 'retry': return FM.queue.retry(String(message.entry));
      case 'discard': return FM.queue.discard(String(message.entry));
      case 'resolve': return FM.queue.resolve(String(message.entry), message.choices || {});
      case 'pin': return FM.pins.pin({ user: who().user, org: String(message.org || who().org) }, String(message.project), { auto: !!message.auto });
      case 'unpin': return FM.pins.unpin({ user: who().user, org: String(message.org || who().org) }, String(message.project));
      case 'pinned': return FM.pins.list(who());
      case 'refreshPins': return FM.pins.refresh(who());
      case 'settings': return FM.settings.all();
      case 'setting': return FM.settings.set(String(message.name), message.value);
      case 'signedOut': return signOut(identityOf(clientId) || S.identity);
      default: throw new Error('Unknown offline message: ' + message.type);
    }
  }

  // Background Sync (where the browser has it): send the queue without a page, under the same lock a page uses.
  self.addEventListener('sync', (event) => {
    // Without the Cookie Store API the worker cannot read the CSRF token; a page sends the queue instead.
    if (event.tag !== 'fm-offline-replay' || !self.cookieStore) return;
    const run = async () => {
      await boot;
      const result = await FM.replay.run();
      const left = S.identity ? (await FM.queue.list(S.identity)).filter((entry) => entry.state === 'waiting').length : 0;
      if (left && !result.blocked) throw new Error('Changes still wait');     // the browser tries the sync again later
    };
    event.waitUntil(self.navigator.locks ? self.navigator.locks.request('fm-offline-replay', { ifAvailable: true }, (lock) => (lock ? run() : null)) : run());
  });
}
