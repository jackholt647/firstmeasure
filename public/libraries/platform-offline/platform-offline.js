/* public/libraries/platform-offline/platform-offline.js
 *
 * window.PlatformOffline: a page's side of offline (docs/architecture/offline.md, "Page API").
 *
 * Loaded first by the portal pages. It registers the service worker (top-level page only), tells it who is
 * signed in, keeps the offline state every frame can read, and, in the top-level page, sends queued changes
 * under the Web Lock `fm-offline-replay`. It never reloads the page. What people see of offline (the indicator,
 * the sync tray, conflicts, device settings) is offline-ui.js, which this file loads once the worker is in use.
 */
(function () {
  'use strict';
  if (window.PlatformOffline) return;

  const APP = window.__APP || {};
  const script = document.currentScript;
  const LIBRARY = script && script.src ? new URL('.', script.src).href : new URL('/libraries/platform-offline/', location.origin).href;
  const WORKER_URL = '/portal/sw.js';
  const SCOPE = '/portal/';
  const MANIFEST_URL = '/v1/platform/offline/assets';
  const LOCK = 'fm-offline-replay';
  const REPLAY_EVERY_MS = 20000;
  const CHECK_EVERY_MS = 30 * 60000;
  const PINS_EVERY_MS = 15 * 60000;
  const QUEUE_EVENTS = ['queued', 'synced', 'failed', 'conflict', 'discarded'];

  const supported = 'serviceWorker' in navigator && 'indexedDB' in window && window.isSecureContext !== false;
  const top = (() => { try { return window.top === window; } catch (_) { return false; } })();
  const identity = { user: String(APP.userId || ''), org: String(APP.userOrgId || '') };
  const sessionCookie = /^[A-Za-z0-9_-]{1,80}$/.test(String(APP.platformSessionCookieName || '')) ? String(APP.platformSessionCookieName) : 'fm_platform_session';

  /** The CSRF token as platform-api.js reads it: the readable cookie beside the session cookie. */
  function csrfToken() {
    const target = encodeURIComponent(sessionCookie + '_csrf') + '=';
    const part = document.cookie.split(';').map((item) => item.trim()).find((item) => item.startsWith(target));
    try { return part ? decodeURIComponent(part.slice(target.length)) : ''; } catch (_) { return ''; }
  }

  // ---------------------------------------------------------------------------------------------------------
  // The first load on a device
  // ---------------------------------------------------------------------------------------------------------

  // A page loaded before the worker controls it (the first visit on a device, or a hard reload) makes its first
  // reads where the worker cannot see them, so none of them is saved, and the portal would not start without a
  // connection until it had been opened a second time. Until the worker is in charge this notes which /v1/
  // requests the page makes. It changes nothing about them. The worker is then asked for the same reads again
  // (`warm`): it sends a GET that is not on the deny list and a POST a contract declares as a read, nothing else.
  const EARLY_LIMIT = 300;
  const EARLY_BODY_LIMIT = 65536;
  const early = [];
  let noting = supported && !!identity.user && !navigator.serviceWorker.controller;
  let stopNoting = () => { noting = false; };

  function note(method, target, body, contentType) {
    if (early.length >= EARLY_LIMIT) return;
    const url = new URL(String(target), location.href);
    if (url.origin !== location.origin || !url.pathname.startsWith('/v1/')) return;
    if (/\/(auth|payments|payment-browser|platform-billing)(\/|$)/.test(url.pathname)) return;      // never noted, never asked again
    const path = url.pathname + url.search;
    const verb = String(method || 'GET').toUpperCase();
    if (verb === 'GET') { early.push({ method: 'GET', url: path }); return; }
    if (verb !== 'POST') return;
    if (typeof body === 'string') { if (body.length <= EARLY_BODY_LIMIT) early.push({ method: 'POST', url: path, body, contentType: String(contentType || '') }); return; }
    const pairs = (typeof URLSearchParams !== 'undefined' && body instanceof URLSearchParams) || (typeof FormData !== 'undefined' && body instanceof FormData) ? [...body.entries()] : null;
    if (pairs && pairs.every((pair) => typeof pair[1] === 'string')) early.push({ method: 'POST', url: path, fields: pairs });
  }

  if (noting) {
    const pageFetch = window.fetch;
    const open = XMLHttpRequest.prototype.open, setHeader = XMLHttpRequest.prototype.setRequestHeader, send = XMLHttpRequest.prototype.send;
    const notes = new WeakMap();
    const fetchNoting = function (input, init) {
      if (noting) {
        try {
          const request = typeof Request !== 'undefined' && input instanceof Request ? input : null;
          const headers = new Headers((init && init.headers) || (request ? request.headers : undefined));
          // (A Request's own body cannot be read without using it up, so only a body given beside it is noted.)
          note((init && init.method) || (request ? request.method : 'GET'), request ? request.url : input, init ? init.body : undefined, headers.get('content-type'));
        } catch (_) { /* noting never gets in a request's way */ }
      }
      return pageFetch.apply(this, arguments);
    };
    const openNoting = function (method, url) { if (noting) { try { notes.set(this, { method, url, type: '' }); } catch (_) { /* as above */ } } return open.apply(this, arguments); };
    const headerNoting = function (name, value) { if (noting) { const kept = notes.get(this); if (kept && /^content-type$/i.test(String(name))) kept.type = String(value); } return setHeader.apply(this, arguments); };
    const sendNoting = function (body) { if (noting) { try { const kept = notes.get(this); if (kept) note(kept.method, kept.url, body, kept.type); } catch (_) { /* as above */ } } return send.apply(this, arguments); };
    window.fetch = fetchNoting;
    XMLHttpRequest.prototype.open = openNoting;
    XMLHttpRequest.prototype.setRequestHeader = headerNoting;
    XMLHttpRequest.prototype.send = sendNoting;
    // Afterwards the page has its own functions back, unless something else has wrapped them since (then these
    // stay in the chain and only pass the call on).
    stopNoting = () => {
      noting = false;
      if (window.fetch === fetchNoting) window.fetch = pageFetch;
      if (XMLHttpRequest.prototype.open === openNoting) XMLHttpRequest.prototype.open = open;
      if (XMLHttpRequest.prototype.setRequestHeader === headerNoting) XMLHttpRequest.prototype.setRequestHeader = setHeader;
      if (XMLHttpRequest.prototype.send === sendNoting) XMLHttpRequest.prototype.send = send;
    };
    setTimeout(() => { if (noting) { stopNoting(); early.length = 0; } }, 120000);     // a worker that never took charge
  }

  /** The worker is in charge and knows who is signed in: it asks for the noted reads again and saves them. */
  function warmEarlyReads() {
    if (!noting) return;
    stopNoting();
    const requests = early.splice(0);
    if (requests.length && navigator.onLine !== false) ask('warm', { requests }, 180000).catch(() => {});
  }

  // ---------------------------------------------------------------------------------------------------------
  // State and events
  // ---------------------------------------------------------------------------------------------------------

  const current = {
    supported, controlled: false, online: navigator.onLine !== false,
    pending: 0, shown: 0, failed: 0, conflicts: 0, syncing: false, blocked: null, lastSyncAt: null, savedPage: false,
    code: { release: null, status: 'none', progress: 0 },
    storage: null
  };
  let workerOnline = true;
  let records = new Set();
  let settings = { saveToCameraRoll: false, autoPinRecent: true, readsBudgetMb: 150, mediaBudgetMb: 300 };
  let engineVersion = '';
  let persisted = null;
  const handlers = new Map();

  function snapshot() { return JSON.parse(JSON.stringify(current)); }

  function emit(type, detail) {
    for (const handler of [...(handlers.get(type) || [])]) { try { handler(detail); } catch (error) { console.error('[offline] listener failed', error); } }
  }

  /** Merges what the worker or the engine reported; tells listeners when something changed. */
  function apply(detail) {
    if (!detail || typeof detail !== 'object') return;
    const before = JSON.stringify(current);
    if (typeof detail.online === 'boolean') workerOnline = detail.online;
    if (typeof detail.syncing === 'boolean') current.syncing = detail.syncing;
    if (typeof detail.savedPage === 'boolean') current.savedPage = detail.savedPage;
    if (detail.code) current.code = detail.code;
    if (detail.storage) current.storage = Object.assign({}, detail.storage, { persisted });
    const queue = detail.queue;
    if (queue && queue.user === identity.user && queue.org === identity.org) {
      Object.assign(current, { pending: queue.pending, shown: queue.shown == null ? queue.pending : queue.shown, failed: queue.failed, conflicts: queue.conflicts, blocked: queue.blocked || null, lastSyncAt: queue.lastSyncAt || null });
      records = new Set((queue.records || []).map(String));
    }
    current.online = navigator.onLine !== false && workerOnline;
    current.controlled = !!(supported && navigator.serviceWorker.controller);
    if (JSON.stringify(current) !== before) emit('state', snapshot());
  }

  let channel = null;
  try {
    if (window.BroadcastChannel) {
      channel = new BroadcastChannel('fm-offline');
      channel.onmessage = (event) => {
        const message = event.data;
        if (!message || message.fm !== 'offline' || !message.type) return;
        const detail = message.detail;
        if (message.type === 'state') { apply(detail); return; }
        if (message.type === 'code') { apply({ code: detail }); emit('code', detail); return; }
        if (message.type === 'settings') { settings = Object.assign({}, settings, detail); return; }
        if (message.type === 'sync-request') { if (top) replayNow({ resume: true, force: true }); return; }
        if (!QUEUE_EVENTS.includes(message.type) || !detail || detail.user !== identity.user || detail.org !== identity.org) return;
        if (message.type === 'queued') onQueued();
        emit(message.type, detail);
      };
    }
  } catch (_) { channel = null; }

  window.addEventListener('online', () => { apply({}); if (top) { replayNow({ force: true }); ask('refreshPins').catch(() => {}); } });
  window.addEventListener('offline', () => apply({}));

  // ---------------------------------------------------------------------------------------------------------
  // Talking to the worker
  // ---------------------------------------------------------------------------------------------------------

  let messageId = 0;
  const replies = new Map();
  if (supported) {
    navigator.serviceWorker.addEventListener('message', (event) => {
      const message = event.data;
      if (!message || message.fm !== 'offline' || message.re == null) return;
      const waiting = replies.get(message.re);
      if (!waiting) return;
      replies.delete(message.re);
      clearTimeout(waiting.timer);
      if (message.ok) waiting.resolve(message.result); else waiting.reject(new Error(message.error || 'The offline worker refused'));
    });
    navigator.serviceWorker.addEventListener('controllerchange', () => { apply({}); hello().catch(() => {}); });
  }

  /** The worker that controls this page; waits for it to take over the first time. */
  function controller() {
    if (!supported) return Promise.reject(new Error('Offline is not available in this browser'));
    if (navigator.serviceWorker.controller) return Promise.resolve(navigator.serviceWorker.controller);
    return new Promise((resolve) => {
      const onChange = () => { if (!navigator.serviceWorker.controller) return; navigator.serviceWorker.removeEventListener('controllerchange', onChange); resolve(navigator.serviceWorker.controller); };
      navigator.serviceWorker.addEventListener('controllerchange', onChange);
    });
  }

  async function ask(type, payload, timeoutMs) {
    const worker = await controller();
    return new Promise((resolve, reject) => {
      const id = ++messageId;
      const timer = setTimeout(() => { replies.delete(id); reject(new Error('The offline worker did not answer')); }, timeoutMs || 60000);
      replies.set(id, { resolve, reject, timer });
      worker.postMessage(Object.assign({ fm: 'offline', id, type }, payload || {}));
    });
  }

  /** The words of the worker's built-in "connect once" page, in the person's language when the catalog is loaded. */
  function copy() {
    const text = window.PlatformLanguage && window.PlatformLanguage.text;
    if (typeof text !== 'function') return null;
    return {
      title: text('platform-offline', 'connect_once_title', 'No connection'),
      body: text('platform-offline', 'connect_once_body', 'FirstMate is not saved on this device yet. Connect to the internet and open it once. After that it opens without a connection.'),
      retry: text('platform-offline', 'connect_once_retry', 'Try again')
    };
  }

  /** Tells the worker who is signed in. Nothing is saved or queued for this page before this. */
  async function hello() {
    const result = await ask('identity', { user: identity.user, org: identity.org, csrfCookie: sessionCookie + '_csrf', top, copy: copy() });
    engineVersion = result.engine || '';
    if (result.settings) settings = Object.assign({}, settings, result.settings);
    // `offline` names the set this page was opened from when the worker served it from the device.
    apply(Object.assign({}, result.state, { savedPage: !!result.offline }));
    return result;
  }

  /** What people see (offline-ui.js, `window.PlatformOfflineUI`), loaded once per frame when the worker is in use. */
  let ui = null;
  function loadUi() {
    if (!ui) { ui = runScript('offline-ui.js'); ui.catch((error) => { ui = null; console.warn('[offline] the offline UI could not be loaded', error); }); }
    return ui;
  }

  // ---------------------------------------------------------------------------------------------------------
  // The code set and the kill switch
  // ---------------------------------------------------------------------------------------------------------

  async function fetchManifest() {
    try {
      const response = await fetch(MANIFEST_URL, { cache: 'no-store', credentials: 'same-origin' });
      return response.ok ? await response.json() : null;
    } catch (_) { return null; }
  }

  /** `enabled: false`: remove the worker and its caches from here too, so the switch works when the worker cannot run. */
  async function disable(manifest) {
    try { if (navigator.serviceWorker.controller) await ask('check', { manifest, wait: true }, 5000); } catch (_) { /* the worker may be the problem */ }
    try { for (const registration of await navigator.serviceWorker.getRegistrations()) if (new URL(registration.scope).pathname === SCOPE) await registration.unregister(); } catch (_) { /* nothing registered */ }
    try { if (window.caches) for (const name of await caches.keys()) if (name.startsWith('fm-')) await caches.delete(name); } catch (_) { /* no cache storage */ }
    apply({ code: { release: null, status: 'disabled', progress: 0 } });
    emit('code', current.code);
  }

  /** Looks for a newer release. A new set downloads in the background and is used from the next load. */
  async function checkForUpdate() {
    if (!supported) return current.code;
    const manifest = await fetchManifest();
    if (manifest && manifest.enabled === false) { await disable(manifest); return current.code; }
    if (!navigator.serviceWorker.controller) return current.code;
    const code = await ask('check', { manifest, wait: true }, 15 * 60000);
    apply({ code });
    return code;
  }

  // ---------------------------------------------------------------------------------------------------------
  // Replay: the top-level page sends the queue, one tab at a time
  // ---------------------------------------------------------------------------------------------------------

  let engine = null;
  async function runScript(file) {
    // Always the server's current copy (the worker answers from the set when there is no connection).
    const response = await fetch(LIBRARY + file, { cache: 'no-cache', credentials: 'same-origin' });
    if (!response.ok) throw new Error('Offline engine file missing: ' + file);
    const element = document.createElement('script');
    element.textContent = (await response.text()) + '\n//# sourceURL=' + LIBRARY + file;
    document.head.appendChild(element);
    element.remove();
  }
  function loadEngine() {
    if (!engine) {
      engine = (async () => {
        await runScript('offline-core.js');
        window.FM_OFFLINE_CONTRACTS = [];
        await runScript('contracts/index.js');
        for (const file of window.FM_OFFLINE_CONTRACTS || []) { try { await runScript('contracts/' + file); } catch (error) { console.warn('[offline] contract not loaded:', file, error); } }
        window.FMOffline.configure({ identity: async () => (identity.user && identity.org ? identity : null), csrf: async () => csrfToken() });
        return window.FMOffline;
      })();
      engine.catch(() => { engine = null; });
    }
    return engine;
  }

  let replaying = null;
  /** One run: holds the lock until no entry is due, then lets go. Entries in backoff wait for a later run. */
  function replayNow(options) {
    if (!top || !supported || !identity.user) return Promise.resolve({ sent: 0 });
    const asked = !!(options && (options.force || options.resume));
    if (replaying && !asked) return replaying;
    const work = async () => {
      let FM = await loadEngine();
      if (engineVersion && FM.version !== engineVersion) { engine = null; FM = await loadEngine(); if (FM.version !== engineVersion) return { sent: 0 }; }
      return FM.replay.run(options);
    };
    const locked = () => (navigator.locks && navigator.locks.request
      ? navigator.locks.request(LOCK, { ifAvailable: true }, (lock) => (lock ? work() : { sent: 0, busy: true }))
      : work());
    // A sync the person asked for runs after the one already on its way, never instead of it.
    const run = (replaying ? replaying.then(locked) : Promise.resolve().then(locked)).catch(() => ({ sent: 0 })).finally(() => { if (replaying === run) replaying = null; });
    replaying = run;
    return run;
  }

  /**
   * The native app uploads queued files itself, also after the app is closed (native-uploads.js). The phone bridge
   * loads at the end of the page, so this waits for the page; an ordinary browser never loads the file.
   */
  function startNativeUploads() {
    const phone = window.PhoneFeatures;
    if (!top || !supported || !identity.user || !phone || !phone.ready || !phone.offlineUploads) return;
    Promise.resolve(phone.ready).then(() => (phone.offlineUploads.available() && !window.PlatformOfflineNativeUploads ? loadEngine().then(() => runScript('native-uploads.js')) : null))
      .catch((error) => console.warn('[offline] native uploads not started', error));
  }

  let askedToPersist = false;
  function onQueued() {
    // Ask the browser to keep the site's storage once something is waiting to be sent.
    if (!askedToPersist && navigator.storage && navigator.storage.persist) {
      askedToPersist = true;
      navigator.storage.persist().then((granted) => { persisted = !!granted; if (current.storage) apply({ storage: current.storage }); }).catch(() => {});
    }
    if (top && navigator.onLine !== false) replayNow();
  }

  // ---------------------------------------------------------------------------------------------------------
  // Start
  // ---------------------------------------------------------------------------------------------------------

  async function start() {
    if (!supported) return snapshot();
    try { if (navigator.storage && navigator.storage.persisted) persisted = await navigator.storage.persisted(); } catch (_) { persisted = null; }
    let manifest = null;
    if (top) {
      manifest = await fetchManifest();
      if (manifest && manifest.enabled === false) { await disable(manifest); return snapshot(); }
      // Registered only when the server offers offline; an unreachable server leaves an installed worker as it is.
      if (manifest && manifest.release) {
        try { await navigator.serviceWorker.register(WORKER_URL, { scope: SCOPE, updateViaCache: 'none' }); } catch (error) { console.warn('[offline] the service worker could not be registered', error); }
      }
      const registration = await navigator.serviceWorker.getRegistration(SCOPE).catch(() => null);
      if (!registration) return snapshot();
    } else if (!navigator.serviceWorker.controller && !(await navigator.serviceWorker.getRegistration(SCOPE).catch(() => null))) return snapshot();
    await controller();
    await hello();
    warmEarlyReads();
    loadUi().catch(() => {});
    if (top) {
      ask('check', { manifest }).then((code) => apply({ code })).catch(() => {});
      setInterval(() => { checkForUpdate().catch(() => {}); }, CHECK_EVERY_MS);
      setInterval(() => { if (navigator.onLine !== false) ask('refreshPins').catch(() => {}); }, PINS_EVERY_MS);
      setInterval(() => { if (current.pending > 0 && navigator.onLine !== false) replayNow(); }, REPLAY_EVERY_MS);
      if (current.pending > 0 && navigator.onLine !== false) replayNow();
      // On dev the platform stream reconnects when a release switches; look for the new set then.
      let lastCheck = Date.now();
      window.addEventListener('fm:live-assets', (event) => {
        if (!event.detail || event.detail.event !== 'hello' || Date.now() - lastCheck < 30000) return;
        lastCheck = Date.now();
        checkForUpdate().catch(() => {});
      });
      window.addEventListener('load', () => { const words = copy(); if (words) ask('identity', { user: identity.user, org: identity.org, csrfCookie: sessionCookie + '_csrf', top, copy: words }).catch(() => {}); }, { once: true });
      if (document.readyState === 'complete') startNativeUploads(); else window.addEventListener('load', startNativeUploads, { once: true });
    }
    return snapshot();
  }

  const ready = start().catch((error) => { console.warn('[offline] not started', error); return snapshot(); })
    .then((state) => { if (noting) { stopNoting(); early.length = 0; } return state; });      // offline is not in use on this page
  const afterChange = (result) => { if (top) replayNow(); else if (channel) channel.postMessage({ fm: 'offline', type: 'sync-request' }); return result; };

  window.PlatformOffline = {
    /** Resolves with state() once the worker knows who is signed in (at once where offline is not available). */
    ready,
    /** { supported, controlled, online, pending, shown, failed, conflicts, syncing, blocked, lastSyncAt, savedPage, code, storage } */
    state: snapshot,
    /** 'state' | 'queued' | 'synced' | 'failed' | 'conflict' | 'discarded' | 'code'. Returns a function that stops listening. */
    on(event, handler) {
      if (!handlers.has(event)) handlers.set(event, new Set());
      handlers.get(event).add(handler);
      return () => handlers.get(event).delete(handler);
    },
    /** Queue entries of the signed-in person, oldest first; `scope` and `record` narrow them. */
    pending: (filter) => ready.then(() => ask('pending', { scope: filter && filter.scope, record: filter && filter.record })),
    /** True while a change that names this record id is still on the device. */
    isPending: (recordId) => records.has(String(recordId)),
    retry: (id) => ask('retry', { entry: id }).then(afterChange),
    discard: (id) => ask('discard', { entry: id }),
    /** Settles a conflict: choices is { '<path>': 'mine' | 'theirs' } for every path the conflict lists. */
    resolve: (id, choices) => ask('resolve', { entry: id, choices }).then(afterChange),
    /** Sends what waits now, also what is in backoff, and lifts a sign-in pause. */
    syncNow() {
      if (top) return replayNow({ resume: true, force: true });
      if (channel) channel.postMessage({ fm: 'offline', type: 'sync-request' });
      return Promise.resolve({ sent: 0 });
    },
    checkForUpdate,
    /** Keeps a project on the device. options.auto marks it as recently opened (the ten newest are kept). */
    pinProject: (org, project, options) => ask('pin', { org, project, auto: !!(options && options.auto) }, 10 * 60000),
    unpinProject: (org, project) => ask('unpin', { org, project }),
    pinned: () => ask('pinned'),
    settings: {
      get: (name) => settings[name],
      set(name, value) { settings = Object.assign({}, settings, { [name]: value }); return ask('setting', { name, value }); }
    },
    /** Removes this person's shells and saved reads from the device. Their queued changes stay. */
    signedOut: (options) => ask('signedOut', { all: !!(options && options.all) }),
    /**
     * The same removal for someone who stays signed in (device settings): saved reads, media and shells go, queued
     * changes stay, and the page says again who it is so it keeps saving and queueing. Resolves with state().
     */
    async removeSaved() {
      await ask('signedOut');
      await hello();
      if (top && navigator.onLine !== false) checkForUpdate().catch(() => {});   // stores this person's shell again
      return snapshot();
    },
    /** Measures storage again (state().storage is otherwise measured when the page loads). Resolves with state(). */
    measure: () => ask('state').then((state) => { apply(state); return snapshot(); }),
    media: {
      /**
       * Keeps a file under a media URL on this device (the small copy of a queued photo), through the engine in the
       * top-level page; a frame asks its top-level page. `fixed: false`: only for when the server cannot be reached.
       * Resolves false where nothing could keep it.
       */
      put(url, blob, options) {
        // (A frame's file is another window's Blob, so it is told by what it can do.)
        if (!supported || !identity.user || !blob || typeof blob.size !== 'number' || typeof blob.slice !== 'function') return Promise.resolve(false);
        if (top) return ready.then(() => loadEngine()).then((FM) => FM.media.put(identity, String(url), blob, options));
        try { const upper = window.top.PlatformOffline; if (upper && upper !== window.PlatformOffline && upper.media) return upper.media.put(url, blob, options); } catch (_) { /* another origin above */ }
        return Promise.resolve(false);
      }
    },
    /** The engine in this page (top-level page only): what replays the queue here, and what native-uploads.js drives. */
    engine: () => (top && supported ? loadEngine() : Promise.reject(new Error('The offline engine runs in the top-level page'))),
    csrfCookie: sessionCookie + '_csrf'
  };
})();
