/* public/libraries/platform-offline/offline-core.js
 *
 * The offline engine (docs/architecture/offline.md): the device's store, the contract registry, saved reads,
 * queued changes and their overlays, replay and the three-way merge.
 *
 * One classic script with no imports. The service worker loads it with importScripts; the top-level page loads
 * it to replay the queue. It attaches FMOffline to `self`. It never touches a page: no DOM and no reloads.
 *
 *   FMOffline.contracts   add(contract), deny(...patterns): what may be saved and queued
 *   FMOffline.api         plan(request, identity): how the worker answers one /v1/ request, or null to leave it alone
 *   FMOffline.reads       saved JSON answers, keyed [user, org, key]
 *   FMOffline.queue       the outbox: entries, their files, their effects on reads
 *   FMOffline.replay      run(): send what waits, in order per scope
 *   FMOffline.merge3      three-way merge for `patch` entries
 *   FMOffline.media       the media file cache (fm-media-v1)
 *   FMOffline.pins        projects kept on the device
 *   FMOffline.events      on(type, fn), emit(type, detail): local and BroadcastChannel('fm-offline')
 */
(function (root) {
  'use strict';

  const VERSION = '1';
  const DB_NAME = 'fm-offline-v1';
  const MEDIA_CACHE = 'fm-media-v1';
  const MB = 1024 * 1024;
  const ORIGIN = root.location && root.location.origin && root.location.origin !== 'null' ? root.location.origin : 'http://localhost';
  const KINDS = ['create', 'action', 'patch', 'upload', 'delete'];

  /** Tunable numbers; the doc states each. Tests shorten the waits. */
  const limits = {
    readTimeoutMs: 8000,
    readTimeoutAfterFailureMs: 1500,
    maxReadBytes: 20 * MB,
    maxMediaBytes: 8 * MB,
    maxFileBytes: 40 * MB,        // a file a contract declares (a report PDF)
    pinFiles: 40,                 // files a page may name for one kept project
    fileReserveBytes: 10 * MB,
    backoffMs: [2000, 5000, 15000, 60000],
    backoffMaxMs: 300000,
    inProgressRetryMs: 2000,
    serverErrorTries: 8,
    mergeRepeats: 3,
    scopesAtOnce: 3,
    rereadLimit: 25,
    namedIdMinLength: 8,          // a shorter id could be part of any text: never taken as naming a record
    prefetchAtOnce: 4,
    warmLimit: 300,               // reads of one first page load that are asked for again (reads.warm)
    autoPins: 10,
    touchMs: 3600000,
    budgetCheckBytes: MB
  };

  const SETTING_DEFAULTS = { saveToCameraRoll: false, autoPinRecent: true, readsBudgetMb: 150, mediaBudgetMb: 300 };

  /** What differs between the worker, the page and a test: set with FMOffline.configure. */
  const config = {
    fetch: (input, init) => root.fetch(input, init),
    now: () => Date.now(),
    identity: () => meta.get('identity', null),
    csrf: async () => '',
    estimate: async () => (root.navigator && root.navigator.storage && root.navigator.storage.estimate ? root.navigator.storage.estimate() : {}),
    online: () => !(root.navigator && root.navigator.onLine === false),
    // True for an entry something else will send (the native app's uploader): replay leaves it and its scope waits.
    external: () => false
  };
  function configure(options) {
    for (const [name, value] of Object.entries(options || {})) {
      if (name === 'limits') Object.assign(limits, value); else config[name] = value;
    }
  }

  // ---------------------------------------------------------------------------------------------------------
  // Store: IndexedDB `fm-offline-v1` (responses, outbox, blobs, media, meta); a Map where there is none.
  // ---------------------------------------------------------------------------------------------------------

  function idbBackend() {
    let opening = null;
    const open = () => opening || (opening = new Promise((resolve, reject) => {
      const request = root.indexedDB.open(DB_NAME, 1);
      request.onupgradeneeded = () => {
        const database = request.result;
        database.createObjectStore('responses', { keyPath: 'k' }).createIndex('lru', ['keep', 'usedAt', 'size']);
        database.createObjectStore('outbox', { keyPath: 'id' });
        database.createObjectStore('blobs', { keyPath: 'k' });
        database.createObjectStore('media', { keyPath: 'k' }).createIndex('lru', ['keep', 'usedAt', 'size']);
        database.createObjectStore('meta', { keyPath: 'k' });
      };
      request.onsuccess = () => {
        const database = request.result;
        database.onversionchange = () => { database.close(); opening = null; };
        database.onclose = () => { opening = null; };
        resolve(database);
      };
      request.onerror = () => { opening = null; reject(request.error || new Error('The offline store could not be opened')); };
    }));
    const run = (store, mode, work) => open().then((database) => new Promise((resolve, reject) => {
      const tx = database.transaction(store, mode);
      let result;
      tx.oncomplete = () => resolve(result);
      tx.onerror = () => reject(tx.error || new Error('The offline store refused a change'));
      tx.onabort = () => reject(tx.error || new Error('The offline store refused a change'));
      work(tx.objectStore(store), (value) => { result = value; });
    }));
    const range = (prefix) => (prefix && prefix.length ? root.IDBKeyRange.bound(prefix, prefix.concat([[]])) : undefined);
    return {
      get: (store, key) => run(store, 'readonly', (s, done) => { s.get(key).onsuccess = (e) => done(e.target.result); }),
      put: (store, value) => run(store, 'readwrite', (s) => { s.put(value); }),
      del: (store, key) => run(store, 'readwrite', (s) => { s.delete(key); }),
      list: (store, prefix) => run(store, 'readonly', (s, done) => { s.getAll(range(prefix)).onsuccess = (e) => done(e.target.result); }),
      keys: (store, prefix) => run(store, 'readonly', (s, done) => { s.getAllKeys(range(prefix)).onsuccess = (e) => done(e.target.result); }),
      delPrefix: (store, prefix) => run(store, 'readwrite', (s) => { const r = range(prefix); if (r) s.delete(r); else s.clear(); }),
      // Size and last use of every row without loading its body, rows that may be evicted first, oldest use first.
      sizes: (store) => run(store, 'readonly', (s, done) => {
        const rows = [];
        s.index('lru').openKeyCursor().onsuccess = (e) => {
          const cursor = e.target.result;
          if (!cursor) { done(rows); return; }
          rows.push({ key: cursor.primaryKey, keep: cursor.key[0], usedAt: cursor.key[1], size: cursor.key[2] });
          cursor.continue();
        };
      })
    };
  }

  function memoryBackend() {
    const stores = new Map();
    const of = (name) => { if (!stores.has(name)) stores.set(name, new Map()); return stores.get(name); };
    const id = (key) => JSON.stringify(key);
    const keyOf = (store, value) => (store === 'outbox' ? value.id : value.k);
    const starts = (key, prefix) => !prefix || !prefix.length || (Array.isArray(key) && prefix.every((part, i) => key[i] === part));
    const rows = (store, prefix) => [...of(store).values()].filter((row) => starts(row.key, prefix));
    return {
      get: async (store, key) => { const row = of(store).get(id(key)); return row ? copy(row.value) : undefined; },
      put: async (store, value) => { of(store).set(id(keyOf(store, value)), { key: keyOf(store, value), value: copy(value) }); },
      del: async (store, key) => { of(store).delete(id(key)); },
      list: async (store, prefix) => rows(store, prefix).map((row) => copy(row.value)),
      keys: async (store, prefix) => rows(store, prefix).map((row) => row.key),
      delPrefix: async (store, prefix) => { for (const row of rows(store, prefix)) of(store).delete(id(row.key)); },
      sizes: async (store) => rows(store).map((row) => ({ key: row.key, keep: row.value.keep, usedAt: row.value.usedAt, size: row.value.size }))
        .sort((a, b) => a.keep - b.keep || a.usedAt - b.usedAt)
    };
  }

  /** A deep copy that leaves files (Blob) as they are, as a structured clone into IndexedDB would. */
  function copy(value) {
    if (Array.isArray(value)) return value.map(copy);
    if (isObject(value)) { const out = {}; for (const key of Object.keys(value)) out[key] = copy(value[key]); return out; }
    return value;
  }

  let backend = null;
  const db = new Proxy({}, { get: (_, method) => (...args) => (backend || (backend = root.indexedDB ? idbBackend() : memoryBackend()))[method](...args) });

  const meta = {
    get: async (key, fallback) => { const row = await db.get('meta', key); return row ? row.v : fallback; },
    set: (key, value) => db.put('meta', { k: key, v: value }),
    del: (key) => db.del('meta', key)
  };

  // ---------------------------------------------------------------------------------------------------------
  // Events: every context (worker, pages, frames) hears them over BroadcastChannel('fm-offline').
  // ---------------------------------------------------------------------------------------------------------

  const listeners = new Map();
  let channel = null;
  try {
    if (root.BroadcastChannel) {
      channel = new root.BroadcastChannel('fm-offline');
      channel.onmessage = (event) => { const m = event.data; if (m && m.fm === 'offline' && m.type) deliver(m.type, m.detail, true); };
    }
  } catch (_) { channel = null; }

  function deliver(type, detail, remote) {
    if (remote && type === 'changed') queue.invalidate();
    for (const handler of [...(listeners.get(type) || [])]) { try { handler(detail, { remote }); } catch (_) { /* a listener never breaks the engine */ } }
  }

  const events = {
    on(type, handler) {
      if (!listeners.has(type)) listeners.set(type, new Set());
      listeners.get(type).add(handler);
      return () => listeners.get(type).delete(handler);
    },
    emit(type, detail) {
      deliver(type, detail, false);
      try { if (channel) channel.postMessage({ fm: 'offline', type, detail }); } catch (_) { /* a detail that cannot be cloned stays local */ }
    }
  };

  // ---------------------------------------------------------------------------------------------------------
  // Small helpers
  // ---------------------------------------------------------------------------------------------------------

  /** A plain object, from this context or another (a frame, a test): not an array, a file or a class instance. */
  function isObject(value) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
    const proto = Object.getPrototypeOf(value);
    return proto === null || Object.getPrototypeOf(proto) === null;
  }
  function ownerKey(identity) { return identity.user + '|' + identity.org; }
  function uuid() {
    if (root.crypto && root.crypto.randomUUID) return root.crypto.randomUUID();
    const bytes = new Uint8Array(16);
    if (root.crypto && root.crypto.getRandomValues) root.crypto.getRandomValues(bytes); else for (let i = 0; i < 16; i++) bytes[i] = Math.floor(Math.random() * 256);
    bytes[6] = (bytes[6] & 0x0f) | 0x40; bytes[8] = (bytes[8] & 0x3f) | 0x80;
    const hex = [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('');
    return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
  }
  const newId = () => 'fmo1-' + uuid();
  const decode = (text) => { try { return decodeURIComponent(text); } catch (_) { return text; } };

  /** JSON with object keys in order, so two equal values give one string. */
  function stable(value) {
    if (Array.isArray(value)) return '[' + value.map(stable).join(',') + ']';
    if (value && typeof value === 'object') return '{' + Object.keys(value).filter((key) => value[key] !== undefined).sort().map((key) => JSON.stringify(key) + ':' + stable(value[key])).join(',') + '}';
    return value === undefined ? 'null' : JSON.stringify(value);
  }
  function same(a, b) { return a === b || (a !== undefined && b !== undefined && stable(a) === stable(b)); }

  function jsonResponse(status, body, headers) {
    return new Response(JSON.stringify(body), { status, headers: Object.assign({ 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }, headers || {}) });
  }
  async function readJson(response) { try { return await response.clone().json(); } catch (_) { return null; } }
  function errorCode(body) {
    if (!body || typeof body !== 'object') return '';
    if (typeof body.error === 'string') return body.error;
    if (body.error && typeof body.error === 'object') return String(body.error.code || body.error.error || '');
    return String(body.code || '');
  }
  const isJson = (response) => /json/i.test(response.headers.get('content-type') || '');
  /** Marks a real network failure, so the worker hands it to the page instead of asking the network again. */
  function netError(error) { try { error.fmNetwork = true; } catch (_) { /* a frozen error */ } return error; }
  const wasAborted = (request, error) => !!(request && request.signal && request.signal.aborted) || !!(error && error.name === 'AbortError');

  /** A response body as a Blob, or null when it is larger than `max` bytes. Never holds more than `max` in memory. */
  async function bodyUpTo(response, max) {
    const type = response.headers.get('content-type') || '';
    if (!response.body || !response.body.getReader) { const whole = await response.blob(); return whole.size > max ? null : whole; }
    const reader = response.body.getReader();
    const chunks = [];
    let size = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > max) { try { await reader.cancel(); } catch (_) { /* already closed */ } return null; }
      chunks.push(value);
    }
    return new Blob(chunks, { type });
  }

  /** The promise's value, or null when `ms` pass first (the promise keeps going). */
  function race(promise, ms) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => resolve(null), ms);
      promise.then((value) => { clearTimeout(timer); resolve(value); }, (error) => { clearTimeout(timer); reject(error); });
    });
  }
  async function pool(items, size, work) {
    const pending = items.slice();
    await Promise.all(Array.from({ length: Math.min(size, pending.length) }, async () => { while (pending.length) await work(pending.shift()); }));
  }

  /** What the last request said about the connection. A failure shortens the waits; any answer restores them. */
  const net = {
    lastFailed: false,
    ok() { if (net.lastFailed) { net.lastFailed = false; events.emit('net', { online: true }); } },
    fail() { if (!net.lastFailed) { net.lastFailed = true; events.emit('net', { online: false }); } },
    online: () => !net.lastFailed && config.online()
  };

  // ---------------------------------------------------------------------------------------------------------
  // Route patterns: "[METHOD ]/v1/things/:id/*/**". `:name` and `*` are one segment, `**` is any number.
  // ---------------------------------------------------------------------------------------------------------

  function compile(pattern) {
    const text = String(pattern).trim();
    const space = text.indexOf(' ');
    const method = space > 0 ? text.slice(0, space).toUpperCase() : '';
    const path = space > 0 ? text.slice(space + 1).trim() : text;
    const names = [];
    let source = '';
    for (const segment of path.split('/').slice(1)) {
      if (segment === '**') source += '(?:/.*)?';
      else if (segment === '*') source += '/[^/]+';
      else if (segment.startsWith(':')) { names.push(segment.slice(1)); source += '/([^/]+)'; }
      else source += '/' + segment.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    }
    const regex = new RegExp('^' + source + '/?$');
    return {
      pattern: text,
      method,
      match(requestMethod, pathname) {
        if (method && method !== requestMethod) return null;
        const found = regex.exec(pathname);
        if (!found) return null;
        const params = {};
        names.forEach((name, index) => { params[name] = decode(found[index + 1]); });
        return params;
      }
    };
  }
  const compileAll = (patterns) => [].concat(patterns || []).map(compile);
  function matchAny(compiled, method, pathname) {
    for (const pattern of compiled) { const params = pattern.match(method, pathname); if (params) return params; }
    return null;
  }

  // ---------------------------------------------------------------------------------------------------------
  // Contracts
  // ---------------------------------------------------------------------------------------------------------

  const registry = { contracts: new Map(), extraDeny: [], deny: [], writes: [], reads: [], boot: [], prefetch: [], files: [] };

  function rebuildRegistry() {
    registry.deny = registry.extraDeny.slice(); registry.writes = []; registry.reads = []; registry.boot = []; registry.prefetch = [];
    for (const contract of registry.contracts.values()) {
      registry.deny.push(...compileAll(contract.deny));
      registry.boot.push(...compileAll(contract.boot));
      registry.files.push(...compileAll(contract.files));
      for (const write of contract.writes || []) registry.writes.push({ contract, write, patterns: compileAll(write.match) });
      for (const read of contract.reads || []) registry.reads.push({ contract, read, patterns: compileAll(read.match) });
      for (const item of contract.prefetch || []) registry.prefetch.push({ contract, item });
    }
  }

  const contracts = {
    add(contract) {
      if (!contract || !contract.id) throw new Error('An offline contract needs an id');
      for (const write of contract.writes || []) {
        if (!write.id || !write.match) throw new Error(`Offline contract ${contract.id}: a write needs an id and a match`);
        if (!KINDS.includes(write.kind)) throw new Error(`Offline contract ${contract.id}: ${write.id} needs a kind (${KINDS.join(', ')})`);
        if (typeof write.respond !== 'function') throw new Error(`Offline contract ${contract.id}: ${write.id} needs respond(ctx)`);
      }
      for (const read of contract.reads || []) if (!read.id || !read.match) throw new Error(`Offline contract ${contract.id}: a read needs an id and a match`);
      registry.contracts.set(contract.id, contract);
      rebuildRegistry();
      queue.invalidate();
      return contract;
    },
    /** Routes the worker never saves, answers or queues. A pattern without a method covers every method. */
    deny(...patterns) { registry.extraDeny.push(...compileAll(patterns.flat())); rebuildRegistry(); },
    denied: (method, pathname) => !!matchAny(registry.deny, method, pathname),
    boot: (method, pathname) => !!matchAny(registry.boot, method, pathname),
    writes(method, pathname) {
      const found = [];
      for (const item of registry.writes) { const params = matchAny(item.patterns, method, pathname); if (params) found.push({ contract: item.contract, write: item.write, params }); }
      return found;
    },
    reads(method, pathname) {
      const found = [];
      for (const item of registry.reads) { const params = matchAny(item.patterns, method, pathname); if (params) found.push({ contract: item.contract, read: item.read, params }); }
      return found;
    },
    write(contractId, writeId) {
      const contract = registry.contracts.get(contractId);
      const write = contract && (contract.writes || []).find((item) => item.id === writeId);
      return write ? { contract, write } : null;
    },
    prefetch: () => registry.prefetch.slice(),
    list: () => [...registry.contracts.keys()]
  };

  // ---------------------------------------------------------------------------------------------------------
  // Requests: bodies and the contract `ctx`
  // ---------------------------------------------------------------------------------------------------------

  /** A request body as the engine keeps it: { type: 'json'|'form'|'text'|'empty', ... }. Reads a clone. */
  async function readBody(request) {
    if (request.method === 'GET' || request.method === 'HEAD') return { type: 'empty' };
    const type = (request.headers.get('content-type') || '').toLowerCase();
    const clone = request.clone();
    if (type.includes('multipart/form-data') || type.includes('application/x-www-form-urlencoded')) {
      const form = await clone.formData();
      const fields = [];
      for (const [name, value] of form.entries()) {
        fields.push(typeof value === 'string' ? [name, value] : [name, { blob: value, name: value.name || 'file', type: value.type || 'application/octet-stream', size: value.size }]);
      }
      return { type: 'form', urlencoded: type.includes('urlencoded'), fields };
    }
    const text = await clone.text();
    if (!text) return { type: 'empty' };
    if (type.includes('json') || /^\s*[[{]/.test(text)) { try { return { type: 'json', text, value: JSON.parse(text) }; } catch (_) { /* not JSON after all */ } }
    return { type: 'text', text, contentType: type };
  }

  function ctxBody(parsed) {
    if (parsed.type === 'json') return parsed.value;
    if (parsed.type === 'text') return parsed.text;
    if (parsed.type !== 'form') return null;
    const out = {};
    for (const [name, value] of parsed.fields) out[name] = name in out ? [].concat(out[name], [value]) : value;
    return out;
  }

  /** A body a contract's prepare(ctx) returned, back in the engine's form. */
  function reparse(parsed, body) {
    if (parsed.type === 'form') {
      const fields = [];
      for (const [name, value] of Object.entries(body || {})) for (const item of [].concat(value)) fields.push([name, item && item.blob ? item : String(item)]);
      return { type: 'form', urlencoded: parsed.urlencoded, fields };
    }
    if (typeof body === 'string') return { type: 'text', text: body, contentType: parsed.contentType || 'text/plain' };
    return { type: 'json', text: JSON.stringify(body), value: body };
  }

  function plainHeaders(headers) {
    const out = {};
    headers.forEach((value, name) => { out[name.toLowerCase()] = value; });
    return out;
  }

  function queryOf(url) {
    const query = {};
    url.searchParams.forEach((value, name) => { query[name] = name in query ? [].concat(query[name], [value]) : value; });
    return query;
  }

  /** The contract ctx (see the doc): { method, url, params, query, body, headers, user, org, now, id, response, base, saved(url), find(pattern), queued(record) }. */
  function makeCtx(parts) {
    const url = new URL(parts.url, ORIGIN);
    return {
      method: parts.method,
      url: url.pathname + url.search,
      params: parts.params || {},
      query: queryOf(url),
      body: ctxBody(parts.parsed),
      headers: parts.headers || {},
      user: parts.identity.user,
      org: parts.identity.org,
      now: parts.now,
      id: parts.id || '',
      response: parts.response === undefined ? null : parts.response,
      // A queued `patch`: the record as it was when the change was made (what conflict.pick gave), else null.
      base: parts.base === undefined ? null : parts.base,
      saved: (target) => reads.peek(parts.identity, target, parts.before === undefined ? Infinity : parts.before),
      // Every saved GET of a route, as the person would see it: [{ url, query, params, json }]. For a record that
      // is only known from lists (a to-do), whatever their filters were.
      find: (pattern) => reads.find(parts.identity, pattern, parts.before === undefined ? Infinity : parts.before),
      // Earlier changes still on the device that name a record, oldest first: [{ id, contract, write, kind, scope, state }].
      // A change to a record made on this device takes the scope of the change that made it.
      queued: async (record) => (await queue.list(parts.identity))
        .filter((entry) => (parts.before === undefined || entry.seq < parts.before) && (entry.records || []).includes(String(record)))
        .map((entry) => ({ id: entry.id, contract: entry.contract, write: entry.write, kind: entry.kind, scope: entry.scope, state: entry.state }))
    };
  }

  // ---------------------------------------------------------------------------------------------------------
  // Saved reads
  // ---------------------------------------------------------------------------------------------------------

  /** Query parameters that only defeat caches; they are not part of what was asked. */
  const CACHE_BUSTERS = new Set(['_', '_t', '_ts', '_cb', 'cb', 'cachebust', 'cache_bust', 'nocache']);

  /**
   * A saved read's key: "METHOD path?query[ extra]". The origin is dropped (same origin only), cache-buster
   * parameters are removed and the rest are sorted by name; values of one name keep their order.
   */
  function readKey(method, url, extra) {
    const u = url instanceof URL ? url : new URL(url, ORIGIN);
    const pairs = [];
    u.searchParams.forEach((value, name) => { if (!CACHE_BUSTERS.has(name.toLowerCase())) pairs.push([name, value]); });
    pairs.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
    const query = pairs.map(([name, value]) => encodeURIComponent(name) + '=' + encodeURIComponent(value)).join('&');
    return method + ' ' + u.pathname + (query ? '?' + query : '') + (extra ? ' ' + extra : '');
  }

  /** What an effect's `when(m, read)` gets as `read`. */
  function readInfo(method, url, key, extra) {
    return Object.assign({ method, path: url.pathname, url: url.pathname + url.search, query: queryOf(url), body: null, key, boot: contracts.boot(method, url.pathname), req: null }, extra || {});
  }

  const reads = {
    key: readKey,
    written: 0,

    /** A JSON 200 from the server, and not one that announces itself as larger than a saved read may be. */
    savable: (response) => response.status === 200 && isJson(response) && !response.headers.get('x-fm-offline') && !(Number(response.headers.get('content-length')) > limits.maxReadBytes),

    /** Stores a JSON answer. `response` is consumed: pass a clone. */
    async store(identity, key, response, info) {
      const blob = await bodyUpTo(response, limits.maxReadBytes);
      if (!blob) return false;
      const body = await blob.text();
      const now = config.now();
      const keep = (info && info.boot) || (await pins.has(identity, 'reads', key)) ? 1 : 0;
      await db.put('responses', { k: [identity.user, identity.org, key], status: 200, type: response.headers.get('content-type') || 'application/json', body, size: blob.size, savedAt: now, usedAt: now, keep, req: (info && info.req) || null });
      reads.written += blob.size;
      if (reads.written >= limits.budgetCheckBytes) { reads.written = 0; await reads.enforce(); }
      return true;
    },

    row: (identity, key) => db.get('responses', [identity.user, identity.org, key]),

    /**
     * The saved answer as a response (with the queue's effects), or null. A read nothing was saved for is
     * answered from a queued change that seeds it: a record made on this device exists nowhere else yet.
     */
    async respond(identity, key, info) {
      const row = await reads.row(identity, key);
      const effects = await queue.effects(identity, info);
      if (!row) {
        const made = await seeded(effects);
        return made === undefined ? null : jsonResponse(200, made, { 'X-FM-Offline': 'queued' });
      }
      const now = config.now();
      if (now - row.usedAt > limits.touchMs) db.put('responses', Object.assign({}, row, { usedAt: now })).catch(() => {});
      let body = row.body;
      if (effects.length) { try { body = JSON.stringify(await applyEffects(effects, JSON.parse(row.body))); } catch (_) { body = row.body; } }
      return new Response(body, { status: row.status, headers: { 'Content-Type': row.type, 'Cache-Control': 'no-store', 'X-FM-Offline': 'saved', 'X-FM-Saved-At': new Date(row.savedAt).toISOString() } });
    },

    /**
     * A network answer with the queue's effects applied; the same response when nothing applies. A 404 for a
     * record whose create still waits on this device is answered from that change's seed.
     */
    async overlay(identity, info, response) {
      const missing = response.status === 404;
      if (!missing && (!response.ok || !isJson(response))) return response;
      const effects = await queue.effects(identity, info);
      if (!effects.length) return response;
      if (missing) {
        const made = await seeded(effects);
        return made === undefined ? response : jsonResponse(200, made, { 'X-FM-Offline': 'queued' });
      }
      let json;
      try { json = await applyEffects(effects, await response.clone().json()); } catch (_) { return response; }
      const headers = new Headers(response.headers);
      headers.delete('content-length'); headers.delete('content-encoding');
      headers.set('X-FM-Offline-Overlay', String(effects.length));
      return new Response(JSON.stringify(json), { status: response.status, statusText: response.statusText, headers });
    },

    /** ctx.saved(url): the saved JSON as the person would see it (earlier queued changes applied), or null. */
    async peek(identity, target, before) {
      const url = new URL(target, ORIGIN);
      const key = readKey('GET', url);
      const row = await reads.row(identity, key);
      try {
        const effects = await queue.effects(identity, readInfo('GET', url, key), before);
        if (!row) { const made = await seeded(effects); return made === undefined ? null : made; }
        return await applyEffects(effects, JSON.parse(row.body));
      } catch (_) { return null; }
    },

    /** Saved GET answers whose route matches `pattern`, with the queue's effects: [{ url, query, params, json }]. */
    async find(identity, pattern, before) {
      const compiled = compile(pattern);
      const out = [];
      for (const key of await db.keys('responses', [identity.user, identity.org])) {
        const name = String(key[2]);
        if (!name.startsWith('GET ')) continue;
        const url = new URL(name.slice(4), ORIGIN);
        const params = compiled.match('GET', url.pathname);
        if (!params) continue;
        const json = await reads.peek(identity, url.pathname + url.search, before);
        if (json) out.push({ url: url.pathname + url.search, query: queryOf(url), params, json });
      }
      return out;
    },

    /**
     * Asks again for the reads a page made before the worker could see them, and saves the answers. A page's first
     * load on a device runs before the worker is in charge, so without this nothing of that load is on the device
     * and the portal would not start without a connection until it had been opened a second time.
     * `requests` is [{ method, url, body, contentType, fields }] as the page noted them: a GET of a route that is not
     * denied, or a POST a contract declares as a read (body: its text; fields: a form's text fields). Anything
     * else, and anything already saved, is left alone. Resolves { asked, saved }.
     */
    async warm(identity, requests) {
      const seen = new Set();
      const jobs = [];
      const fresh = async (key) => { if (seen.has(key)) return false; seen.add(key); return !(await reads.row(identity, key)); };
      for (const item of [].concat(requests || []).slice(0, limits.warmLimit)) {
        let url;
        try { url = new URL(String(item && item.url), ORIGIN); } catch (_) { continue; }
        const method = String((item && item.method) || 'GET').toUpperCase();
        if (url.origin !== ORIGIN || !url.pathname.startsWith('/v1/') || contracts.denied(method, url.pathname)) continue;
        if (method === 'GET') {
          if (media.match(url.pathname)) continue;                  // pictures are kept when they are shown
          const key = readKey('GET', url);
          jobs.push(async () => {
            if (!(await fresh(key))) return false;
            const response = await config.fetch(url.href, { credentials: 'include', cache: 'no-store', headers: { accept: 'application/json', 'x-fm-offline-replay': '1' } });
            if (!reads.savable(response)) return false;
            await reads.store(identity, key, response, { boot: contracts.boot('GET', url.pathname) });
            return true;
          });
        } else if (method === 'POST' && (typeof item.body === 'string' || Array.isArray(item.fields))) {
          const declared = contracts.reads('POST', url.pathname);
          if (!declared.length) continue;                            // only a declared read is ever sent again
          jobs.push(async () => {
            const form = Array.isArray(item.fields);
            const text = form ? new URLSearchParams(item.fields.filter((pair) => Array.isArray(pair) && typeof pair[1] === 'string')).toString() : item.body;
            const contentType = form ? 'application/x-www-form-urlencoded' : String(item.contentType || 'application/json');
            const parsed = await readBody(new Request(url.href, { method: 'POST', headers: { 'content-type': contentType }, body: text }));
            for (const found of declared) {
              const readCtx = makeCtx({ method: 'POST', url: url.href, params: found.params, parsed, headers: {}, identity, now: config.now() });
              if (found.read.when && !(await found.read.when(readCtx))) continue;
              const key = readKey('POST', url, found.read.id + ' ' + stable(found.read.key ? await found.read.key(readCtx) : readCtx.body));
              if (!(await fresh(key))) return false;
              const headers = { accept: 'application/json', 'content-type': contentType, 'x-fm-offline-replay': '1' };
              const token = await config.csrf();
              if (token) headers['x-platform-csrf'] = token;
              const response = await config.fetch(url.href, { method: 'POST', credentials: 'include', cache: 'no-store', headers, body: text });
              if (!reads.savable(response)) return false;
              const strings = parsed.type === 'form' ? parsed.fields.filter(([, value]) => typeof value === 'string') : null;
              await reads.store(identity, key, response, { boot: contracts.boot('POST', url.pathname), req: { text: parsed.text == null ? null : parsed.text, contentType: parsed.type === 'json' ? 'application/json' : parsed.contentType || null, fields: strings } });
              return true;
            }
            return false;
          });
        }
      }
      let saved = 0;
      await pool(jobs, limits.prefetchAtOnce, async (job) => { try { if (await job()) saved++; } catch (_) { /* no answer: the next visit saves it */ } });
      return { asked: jobs.length, saved };
    },

    /** Reads a saved GET or declared POST read again and stores the answer. Used after a change synced. */
    async refresh(identity, key) {
      const space = key.indexOf(' ');
      const method = key.slice(0, space);
      const url = new URL(key.slice(space + 1).split(' ')[0], ORIGIN);          // "METHOD path?query[ extra]"
      const row = await reads.row(identity, key);
      const init = { method, credentials: 'include', cache: 'no-store', headers: { accept: 'application/json', 'x-fm-offline-replay': '1' } };
      if (method !== 'GET') {
        if (!row || !row.req) return false;
        const token = await config.csrf();
        if (token) init.headers['x-platform-csrf'] = token;
        if (row.req.fields) { init.body = new URLSearchParams(row.req.fields).toString(); init.headers['content-type'] = 'application/x-www-form-urlencoded'; }
        else if (row.req.text != null) { init.body = row.req.text; init.headers['content-type'] = row.req.contentType || 'application/json'; }
      }
      const response = await config.fetch(url.href, init);
      if (!reads.savable(response)) return false;
      return reads.store(identity, key, response, { boot: contracts.boot(method, url.pathname), req: row ? row.req : null });
    },

    /** Removes least recently used reads until the budget holds. Pinned and boot reads stay. */
    async enforce() {
      const budget = (await settings.get('readsBudgetMb')) * MB;
      return evict('responses', budget, (key) => db.del('responses', key));
    },

    removeFor: (user) => db.delPrefix('responses', [user])
  };

  async function evict(store, budget, remove) {
    const rows = await db.sizes(store);
    let total = rows.reduce((sum, row) => sum + row.size, 0);
    if (total <= budget) return 0;
    let removed = 0;
    for (const row of rows) {
      if (total <= budget * 0.9 || row.keep) break;
      await remove(row.key);
      total -= row.size;
      removed++;
    }
    return removed;
  }

  async function applyEffects(effects, json) {
    let value = json;
    for (const effect of effects) {
      if (typeof effect.apply !== 'function') continue;
      try { const next = await effect.apply(value); if (next !== undefined) value = next; } catch (_) { /* one contract's mistake never breaks a read */ }
    }
    return value;
  }

  /**
   * The answer of a read nothing was saved for, from the first queued change that seeds it (`seed` on an
   * effect), with the later changes applied; undefined when no change seeds it.
   */
  async function seeded(effects) {
    const at = effects.findIndex((effect) => effect.seed !== undefined);
    if (at < 0) return undefined;
    let value;
    try { value = typeof effects[at].seed === 'function' ? await effects[at].seed() : copy(effects[at].seed); } catch (_) { return undefined; }
    if (value === undefined || value === null) return undefined;
    return applyEffects(effects.slice(at + 1), value);
  }

  /**
   * Network first. The saved answer is used when the request fails, or has not answered within the wait and a
   * saved answer exists; the network answer still replaces the saved copy when it arrives.
   */
  async function networkFirst(request, send, identity, info, options) {
    const waitUntil = (options && options.waitUntil) || (() => {});
    // The copy to store is taken the moment the answer arrives, before the page starts reading it.
    const arrived = send().then((response) => { net.ok(); return { response, copy: reads.savable(response) ? response.clone() : null }; }, (error) => { if (!wasAborted(request, error)) net.fail(); throw error; });
    waitUntil(arrived.then((answer) => (answer.copy ? reads.store(identity, info.key, answer.copy, info) : null)).catch(() => {}));
    const network = arrived.then((answer) => answer.response);
    network.catch(() => {});
    let response;
    try { response = await race(network, net.lastFailed ? limits.readTimeoutAfterFailureMs : limits.readTimeoutMs); } catch (error) {
      if (wasAborted(request, error)) throw error;
      const saved = await reads.respond(identity, info.key, info).catch(() => null);
      if (saved) return saved;
      throw netError(error);
    }
    if (response) return reads.overlay(identity, info, response);
    const saved = await reads.respond(identity, info.key, info).catch(() => null);
    if (saved) return saved;
    try { response = await network; } catch (error) { throw netError(error); }
    return reads.overlay(identity, info, response);
  }

  // ---------------------------------------------------------------------------------------------------------
  // The queue (outbox)
  // ---------------------------------------------------------------------------------------------------------

  let lastSeq = 0;
  const queueCache = { all: null, derived: new Map() };

  const queue = {
    invalidate() { queueCache.all = null; },

    /** Every entry on the device, oldest first. */
    async all() {
      if (!queueCache.all) {
        queueCache.all = db.list('outbox').then((rows) => rows.sort((a, b) => a.seq - b.seq));
        queueCache.all.then((rows) => { const ids = new Set(rows.map((row) => row.id)); for (const id of queueCache.derived.keys()) if (!ids.has(id)) queueCache.derived.delete(id); }, () => { queueCache.all = null; });
      }
      return queueCache.all;
    },
    async list(identity) { return (await queue.all()).filter((entry) => entry.user === identity.user && entry.org === identity.org); },
    get: (id) => db.get('outbox', id),

    async save(entry) { await db.put('outbox', entry); queue.invalidate(); },

    async remove(id) {
      await db.del('outbox', id);
      await db.delPrefix('blobs', [id]);
      queueCache.derived.delete(id);
      queue.invalidate();
    },

    /** True while a new change of this scope must wait its turn behind queued ones. */
    async busy(identity, scope) {
      return (await queue.list(identity)).some((entry) => entry.scope === scope && (entry.state === 'waiting' || entry.state === 'delegated' || holds(entry)));
    },

    /**
     * True while a change of another scope that this one has to follow (`after`: it makes a record this one
     * names) is still on the device, in any state: sent, it is gone; failed, it waits for the person, and so
     * does this. `known` is the ids on the device where the caller already has them.
     */
    async follows(entry, known) {
      for (const id of entry.after || []) if (known ? known.has(id) : await queue.get(id)) return true;
      return false;
    },

    /** What a page may know about an entry. */
    public(entry) {
      return { id: entry.id, contract: entry.contract, write: entry.write, kind: entry.kind, scope: entry.scope, label: entry.label, records: entry.records, quiet: !!entry.quiet, state: entry.state, attempts: entry.attempts, error: entry.error, conflict: entry.conflict, createdAt: entry.createdAt, nextAt: entry.nextAt, user: entry.user, org: entry.org };
    },

    /** The entry's body as the engine parses a request body, files loaded from the blobs store. */
    async parsed(entry) {
      const body = entry.body || { type: 'empty' };
      if (body.type === 'json') return { type: 'json', text: body.text, value: JSON.parse(body.text) };
      if (body.type !== 'form') return body;
      const fields = [];
      for (const [name, value] of body.fields) {
        if (typeof value === 'string') { fields.push([name, value]); continue; }
        const row = await db.get('blobs', [entry.id, value.blob]);
        fields.push([name, { blob: row ? row.blob : new Blob([]), name: value.name, type: value.type, size: value.size }]);
      }
      return { type: 'form', urlencoded: body.urlencoded, fields };
    },

    /** The contract ctx an entry was queued with. */
    async ctx(entry) {
      return makeCtx({ method: entry.method, url: entry.url, params: entry.params, parsed: await queue.parsed(entry), headers: entry.headers, identity: { user: entry.user, org: entry.org }, now: entry.createdAt, id: entry.id, response: entry.response, base: entry.base ? entry.base.doc : null, before: entry.seq });
    },

    /** The entry's effects on reads, computed once: [{ patterns, when, apply }]. */
    effectsOf(entry) {
      if (!queueCache.derived.has(entry.id)) {
        queueCache.derived.set(entry.id, (async () => {
          const found = contracts.write(entry.contract, entry.write);
          if (!found || typeof found.write.effects !== 'function') return [];
          const list = await found.write.effects(await queue.ctx(entry));
          return (list || []).filter((effect) => effect && effect.match && (typeof effect.apply === 'function' || effect.seed !== undefined)).map((effect) => ({ patterns: compileAll(effect.match), when: effect.when, apply: effect.apply, seed: effect.seed }));
        })().catch(() => []));
      }
      return queueCache.derived.get(entry.id);
    },

    /** The effects that apply to one read, oldest change first. `before` limits them to earlier entries. */
    async effects(identity, info, before) {
      const entries = await queue.list(identity);
      if (!entries.length) return [];
      const out = [];
      for (const entry of entries) {
        if (before !== undefined && entry.seq >= before) break;
        for (const effect of await queue.effectsOf(entry)) {
          const params = matchAny(effect.patterns, info.method, info.path);
          if (!params) continue;
          try { if (effect.when && !(await effect.when(params, info))) continue; } catch (_) { continue; }
          out.push(effect);
        }
      }
      return out;
    },

    /** The stored file of a queued upload for a media id, or null. */
    async blob(identity, mediaId) {
      for (const entry of await queue.list(identity)) {
        const item = (entry.media || []).find((media) => String(media.id) === String(mediaId));
        if (item) return (await db.get('blobs', [entry.id, item.blob])) || null;
      }
      return null;
    },

    /** Ids of records with a change still on the device. */
    async records(identity) { return [...new Set((await queue.list(identity)).flatMap((entry) => entry.records || []).map(String))]; },

    /** Send again: a waiting entry now, a failed or parked one from the start. */
    async retry(id) {
      const entry = await queue.get(id);
      if (!entry) return null;
      // A refusal (4xx) is kept by the server under the entry's key; asking again needs a new one.
      if ((entry.state === 'failed' || entry.state === 'parked') && entry.error && entry.error.status >= 400 && entry.error.status < 500) entry.key = newId();
      if (entry.state === 'failed' || entry.state === 'parked') { entry.state = 'waiting'; entry.error = null; entry.serverErrors = 0; }
      entry.attempts = 0; entry.nextAt = 0;
      await queue.save(entry);
      await queue.changed({ user: entry.user, org: entry.org });
      return queue.public(entry);
    },

    async discard(id) {
      const entry = await queue.get(id);
      if (!entry) return false;
      await queue.remove(id);
      events.emit('discarded', queue.public(entry));
      await queue.changed({ user: entry.user, org: entry.org });
      return true;
    },

    /** Settles a conflict: `choices` is { '<path>': 'mine' | 'theirs' } for every path the conflict lists. */
    async resolve(id, choices) {
      const entry = await queue.get(id);
      if (!entry || entry.state !== 'conflict') throw new Error('That change is not waiting on a choice');
      const picked = Object.assign({}, entry.choices || {});
      for (const field of entry.conflict.fields) {
        const choice = choices && choices[field.path];
        if (choice !== 'mine' && choice !== 'theirs') throw new Error(`Choose "mine" or "theirs" for ${field.path}`);
        picked[field.path] = choice;
      }
      Object.assign(entry, { choices: picked, state: 'waiting', conflict: null, attempts: 0, nextAt: 0 });
      await queue.save(entry);
      await queue.changed({ user: entry.user, org: entry.org });
      return queue.public(entry);
    },

    /** Hands an upload to the native host; it stays in the queue as `delegated` until replay.report(id, answer). */
    async delegate(id, info) {
      const entry = await queue.get(id);
      if (!entry) return null;
      Object.assign(entry, { state: 'delegated', delegated: info || {} });
      await queue.save(entry);
      await queue.changed({ user: entry.user, org: entry.org });
      return queue.public(entry);
    },

    /** The same person is signed in again: lift the pause and send what was parked. */
    async resume(identity) {
      await meta.del('pause:' + ownerKey(identity));
      let changed = false;
      for (const entry of await queue.list(identity)) {
        if (entry.state !== 'parked') continue;
        Object.assign(entry, { state: 'waiting', error: null, attempts: 0, nextAt: 0, key: newId() });
        await db.put('outbox', entry);
        changed = true;
      }
      if (changed) queue.invalidate();
      await queue.changed(identity);
    },

    /** Tells every context the queue changed and what it now holds for this person. */
    async changed(identity, extra) {
      queue.invalidate();
      events.emit('changed', { user: identity.user, org: identity.org });
      await state.emit(identity, extra);
    }
  };

  /** A failed or parked `create` holds the rest of its scope: later entries need the record. */
  function holds(entry) { return entry.kind === 'create' && (entry.state === 'failed' || entry.state === 'parked'); }
  const PARKED_FOR_ANOTHER = 'Queued by another person';        // (what people read comes from the offline UI, by the entry's state)

  /** The records a change makes: a `create` and an `upload` make the records they name. */
  function makes(entry) { return entry.kind === 'create' || entry.kind === 'upload' ? (entry.records || []) : []; }

  /** Where a change names other records: its URL and the text of its body, never its files. */
  function namedIn(url, parsed) {
    const parts = [String(url)];
    if (parsed.type === 'json' || parsed.type === 'text') parts.push(String(parsed.text || ''));
    else if (parsed.type === 'form') for (const [, value] of parsed.fields) if (typeof value === 'string') parts.push(value);
    return parts.join('\n');
  }

  /**
   * Scopes are sent side by side, so order between them is by what a change names: the ids of the changes of
   * other scopes, still on the device, that make a record this change's URL or body names (a photo paired with a
   * project made on this device, a new contact linked to a project). It is sent after them. Every entry on the
   * device is older than a change being made now, so the order has no circle.
   */
  async function makersNamed(identity, scope, text) {
    const out = [];
    for (const entry of await queue.list(identity)) {
      if (entry.scope === scope) continue;
      if (makes(entry).some((id) => id.length >= limits.namedIdMinLength && text.includes(id))) out.push(entry.id);
    }
    return out;
  }

  function nextSeq() { lastSeq = Math.max(config.now() * 1000, lastSeq + 1); return lastSeq; }

  /** Headers kept with an entry: everything the app sent except what is set again when it is sent. */
  function storedHeaders(headers, parsed) {
    const out = {};
    for (const [name, value] of Object.entries(headers)) {
      if (['cookie', 'content-length', 'host', 'x-platform-csrf', 'idempotency-key', 'x-fm-offline-user', 'x-fm-offline-org'].includes(name)) continue;
      if (name === 'content-type' && parsed.type === 'form') continue;
      out[name] = value;
    }
    return out;
  }

  /** Stores the change. Answers the page with respond(ctx), or with the reason it could not be kept. */
  async function enqueue(identity, found, ctx, parsed, scope, after) {
    const { contract, write } = found;
    let entry = null;
    try {
      const files = parsed.type === 'form' ? parsed.fields.filter(([, value]) => typeof value !== 'string') : [];
      if (files.length && !(await storage.hasRoom(files.reduce((sum, [, file]) => sum + file.size, 0)))) return jsonResponse(507, { ok: false, error: 'offline_storage_full' }, { 'X-FM-Offline': 'storage-full' });
      ctx.response = await write.respond(ctx);
      const records = [].concat(write.records ? await write.records(ctx) : []).filter((id) => id != null).map(String);
      let body = { type: 'empty' };
      const blobs = [];
      if (parsed.type === 'json') body = { type: 'json', text: parsed.text };
      else if (parsed.type === 'text') body = { type: 'text', text: parsed.text, contentType: parsed.contentType };
      else if (parsed.type === 'form') {
        body = { type: 'form', urlencoded: parsed.urlencoded, fields: parsed.fields.map(([name, value]) => {
          if (typeof value === 'string') return [name, value];
          blobs.push({ k: [ctx.id, blobs.length], blob: value.blob, name: value.name, type: value.type, size: value.size, field: name });
          return [name, { blob: blobs.length - 1, name: value.name, type: value.type, size: value.size }];
        }) };
      }
      // Which media ids the stored files stand for, so their file URLs can be answered while they wait.
      let media = [];
      if (blobs.length) {
        const named = write.media ? await write.media(ctx) : (write.kind === 'upload' && records.length ? [{ id: records[0], field: blobs[0].field }] : []);
        media = [].concat(named || []).map((item) => ({ id: String(item.id), blob: Math.max(0, blobs.findIndex((blob) => blob.field === item.field)) }));
      }
      let base = null;
      if (write.kind === 'patch' && write.conflict) {
        const saved = await ctx.saved(await write.conflict.current(ctx));
        if (saved) { const picked = await write.conflict.pick(saved, ctx); if (picked && picked.doc) base = { doc: picked.doc, revision: picked.revision === undefined ? null : picked.revision }; }
      }
      entry = {
        id: ctx.id, key: ctx.id, keyBody: null, seq: nextSeq(), user: identity.user, org: identity.org,
        contract: contract.id, write: write.id, kind: write.kind, scope,
        method: ctx.method, url: ctx.url, params: ctx.params, headers: storedHeaders(ctx.headers, parsed), body,
        label: write.label ? await write.label(ctx) : null, records, response: ctx.response, media, base, after: after || [],
        // The second half of another change (a photo's place in the project's list, behind its upload): sent like
        // any other, but not counted or listed for people while a change that is not quiet waits.
        quiet: !!(typeof write.quiet === 'function' ? await write.quiet(ctx) : write.quiet),
        state: 'waiting', attempts: 0, serverErrors: 0, nextAt: 0, error: null, conflict: null, choices: null, createdAt: ctx.now
      };
      // Asked before the entry is stored, so `ctx.queued` names only what was on the device before it.
      const stale = await replacedBy(write, ctx);
      for (const blob of blobs) await db.put('blobs', blob);
      await db.put('outbox', entry);
      for (const id of stale) await queue.discard(id).catch(() => {});
    } catch (error) {
      if (entry) await db.delPrefix('blobs', [entry.id]).catch(() => {});
      const full = error && (error.name === 'QuotaExceededError' || /quota/i.test(String(error.message)));
      return full ? jsonResponse(507, { ok: false, error: 'offline_storage_full' }, { 'X-FM-Offline': 'storage-full' }) : jsonResponse(503, { ok: false, error: 'offline_unavailable' }, { 'X-FM-Offline': 'unavailable' });
    }
    queue.invalidate();
    events.emit('queued', queue.public(entry));
    await queue.changed(identity).catch(() => {});
    try { if (root.registration && root.registration.sync) root.registration.sync.register('fm-offline-replay').catch(() => {}); } catch (_) { /* no Background Sync here */ }
    return jsonResponse(200, ctx.response === undefined ? null : ctx.response, { 'X-FM-Offline-Queued': entry.id });
  }

  // ---------------------------------------------------------------------------------------------------------
  // The worker's answer to one /v1/ request
  // ---------------------------------------------------------------------------------------------------------

  /** A request that reaches the network untouched; without an answer the page gets `offline_unavailable`. */
  async function passThrough(request) {
    try { const response = await config.fetch(request); net.ok(); return response; } catch (error) {
      if (wasAborted(request, error)) throw error;
      net.fail();
      if (request.method === 'GET' || request.method === 'HEAD') throw netError(error);
      return jsonResponse(503, { ok: false, error: 'offline_unavailable' }, { 'X-FM-Offline': 'unavailable' });
    }
  }

  async function handleMutation(request, url, identity, candidates, options) {
    if (!identity) return passThrough(request);
    let chosen = null, ctx = null, parsed = null;
    try {
      parsed = await readBody(request);
      const parts = { method: request.method.toUpperCase(), url: url.href, parsed, headers: plainHeaders(request.headers), identity, now: config.now() };
      for (const found of candidates.writes) {
        const candidate = makeCtx(Object.assign({}, parts, { params: found.params, id: newId() }));
        if (!found.write.when || await found.write.when(candidate)) { chosen = { write: found }; ctx = candidate; break; }
      }
      if (!chosen) for (const found of candidates.reads) {
        const candidate = makeCtx(Object.assign({}, parts, { params: found.params }));
        if (!found.read.when || await found.read.when(candidate)) { chosen = { read: found }; ctx = candidate; break; }
      }
    } catch (_) { return passThrough(request); }
    if (!chosen) return passThrough(request);
    return chosen.read ? handlePostRead(request, url, identity, chosen.read, ctx, parsed, options) : handleWrite(request, url, identity, chosen.write, ctx, parsed);
  }

  async function handlePostRead(request, url, identity, found, ctx, parsed, options) {
    let info;
    try {
      const part = found.read.key ? await found.read.key(ctx) : ctx.body;
      const strings = parsed.type === 'form' ? parsed.fields.filter(([, value]) => typeof value === 'string') : null;
      info = readInfo('POST', url, readKey('POST', url, found.read.id + ' ' + stable(part)), { body: ctx.body, req: { text: parsed.text == null ? null : parsed.text, contentType: parsed.type === 'json' ? 'application/json' : parsed.contentType || null, fields: strings } });
    } catch (_) { return passThrough(request); }
    return networkFirst(request, () => config.fetch(request), identity, info, options);
  }

  async function handleWrite(request, url, identity, found, ctx, parsed) {
    const write = found.write;
    let scope, outgoing;
    try {
      let prepared = false;
      if (write.prepare) {
        const next = await write.prepare(ctx);
        if (next !== undefined && next !== null && !same(next, ctx.body)) { parsed = reparse(parsed, next); ctx.body = ctxBody(parsed); prepared = true; }
      }
      const given = request.headers.get('idempotency-key') || '';
      if (given.startsWith('fmo1-')) ctx.id = given;
      scope = String(write.scope ? await write.scope(ctx) : 'default');
      const headers = new Headers(request.headers);
      headers.set('Idempotency-Key', ctx.id);
      headers.set('X-FM-Offline-User', identity.user);
      headers.set('X-FM-Offline-Org', identity.org);
      if (prepared) {
        const sent = sendable(parsed);
        if (sent.contentType) headers.set('Content-Type', sent.contentType); else headers.delete('Content-Type');
        outgoing = () => new Request(request.url, { method: request.method, headers, body: sent.body, credentials: request.credentials, cache: 'no-store', signal: request.signal });
      } else outgoing = () => new Request(request, { headers });
    } catch (_) { return passThrough(request); }
    // Sent now unless the device is known to be offline, earlier changes of this scope still wait, or it names a
    // record that a change of another scope, still waiting here, makes.
    const after = await makersNamed(identity, scope, namedIn(ctx.url, parsed)).catch(() => []);
    if (config.online() && !after.length && !(await queue.busy(identity, scope))) {
      let response = null;
      try { response = await config.fetch(outgoing()); } catch (error) { if (wasAborted(request, error)) throw error; }
      if (response) {
        net.ok();
        if (response.status >= 200 && response.status < 300) await replaced(write, ctx);
        return response;
      }
      net.fail();
    }
    return enqueue(identity, found, ctx, parsed, scope, after);
  }

  /**
   * A change the server took, or that is now queued, may stand in for earlier ones still on the device
   * (`replaces(ctx)` on a write: the ids of those entries, from `ctx.queued(record)`): a save that carries the
   * whole record after the save the server refused, a delete after every change to what it deletes. They are
   * discarded, so a refused change the person has since corrected does not wait for them, and its effects no
   * longer show over the newer answer.
   */
  async function replacedBy(write, ctx) {
    if (typeof write.replaces !== 'function') return [];
    try { return [].concat((await write.replaces(ctx)) || []).filter((id) => id && id !== ctx.id).map(String); } catch (_) { return []; }
  }
  async function replaced(write, ctx) {
    for (const id of await replacedBy(write, ctx)) await queue.discard(id).catch(() => {});
  }

  /** A parsed body as fetch sends it. */
  function sendable(parsed) {
    if (parsed.type === 'json') return { body: parsed.text, contentType: 'application/json' };
    if (parsed.type === 'text') return { body: parsed.text, contentType: parsed.contentType || 'text/plain' };
    if (parsed.type !== 'form') return { body: undefined, contentType: '' };
    if (parsed.urlencoded) return { body: new URLSearchParams(parsed.fields.filter(([, value]) => typeof value === 'string')).toString(), contentType: 'application/x-www-form-urlencoded' };
    const form = new FormData();
    for (const [name, value] of parsed.fields) { if (typeof value === 'string') form.append(name, value); else form.append(name, value.blob, value.name); }
    return { body: form, contentType: '' };
  }

  const api = {
    /** True for a request the worker must leave alone: not answered, saved or queued. */
    ignores(request, url) {
      if (url.origin !== ORIGIN || !url.pathname.startsWith('/v1/')) return true;
      if (request.headers.get('x-fm-offline-replay')) return true;
      const method = request.method.toUpperCase();
      if (method === 'HEAD' || method === 'OPTIONS') return true;
      if (/text\/event-stream/i.test(request.headers.get('accept') || '')) return true;
      return contracts.denied(method, url.pathname);
    },

    /**
     * How to answer one same-origin /v1/ request: a function that resolves the response, or null when the worker
     * does not answer it. Decided without waiting, so the worker can call respondWith in the fetch event.
     */
    plan(request, identity, options) {
      const url = new URL(request.url);
      if (api.ignores(request, url)) return null;
      const method = request.method.toUpperCase();
      if (method === 'GET') {
        if (!identity) return null;
        const file = media.match(url.pathname);
        if (file) return () => media.handle(request, url, identity, file, options);
        if (request.headers.has('range')) return null;
        const info = readInfo('GET', url, readKey('GET', url));
        return () => networkFirst(request, () => config.fetch(request), identity, info, options);
      }
      const candidates = { writes: contracts.writes(method, url.pathname), reads: contracts.reads(method, url.pathname) };
      if (!candidates.writes.length && !candidates.reads.length) return () => passThrough(request);
      return () => handleMutation(request, url, identity, candidates, options);
    }
  };

  // ---------------------------------------------------------------------------------------------------------
  // Media files: queued uploads from the blobs store, variants from the cache fm-media-v1
  // ---------------------------------------------------------------------------------------------------------

  const MEDIA_PATH = /\/media\/([^/]+)\/file$/;
  const touched = new Map();

  const media = {
    /**
     * A file kept like a picture: a media file ({ id }), or a route a contract declares in `files` (a report PDF,
     * an order's picture: { id: '', declared: true }). Such an answer is not JSON, so it is not a saved read.
     */
    match(pathname) {
      const found = MEDIA_PATH.exec(pathname);
      if (found) return { id: decode(found[1]) };
      return matchAny(registry.files, 'GET', pathname) ? { id: '', declared: true } : null;
    },
    isThumb: (url) => /^thumb/i.test(url.searchParams.get('variant') || ''),
    urlKey: (url) => url.pathname + url.search,
    cacheKey: (identity, url) => `${ORIGIN}/.fm-media/${encodeURIComponent(identity.user)}/${encodeURIComponent(identity.org)}${url.pathname}${url.search}`,

    async handle(request, url, identity, file, options) {
      const waitUntil = (options && options.waitUntil) || (() => {});
      const queued = file.id ? await queue.blob(identity, file.id).catch(() => null) : null;
      if (queued) {
        // A grid of waiting photos shows the small copies made when they were queued, not twenty full-size files.
        const small = media.isThumb(url) && !request.headers.has('range') ? await media.cached(identity, url).catch(() => null) : null;
        return small || blobResponse(queued, request.headers.get('range'));
      }
      if (request.headers.has('range')) {
        // A part of a file (a PDF viewer, a video): the network's, or cut from the device's copy when it cannot be reached.
        try { return await config.fetch(request); } catch (error) {
          if (wasAborted(request, error)) throw error;
          const copy = await media.cached(identity, url).catch(() => null);
          if (!copy) throw netError(error);
          return blobResponse({ blob: await copy.blob(), type: copy.headers.get('content-type') || '' }, request.headers.get('range'), 'saved');
        }
      }
      // Only an answer the server marked immutable (a rendition, a markup thumbnail with its revision) is served
      // from the device first. A logo, an avatar or an original can change under the same URL: network first.
      const hit = await media.cached(identity, url).catch(() => null);
      if (hit && hit.headers.get('X-FM-Fixed') === '1') return hit;
      const network = config.fetch(request);
      let response;
      try { response = hit ? await race(network, net.lastFailed ? limits.readTimeoutAfterFailureMs : limits.readTimeoutMs) : await network; } catch (error) {
        if (wasAborted(request, error)) throw error;
        net.fail();
        if (hit) return hit;
        throw netError(error);
      }
      if (!response) {                                           // slow: the saved copy now, the newer one when it comes
        waitUntil(network.then((late) => { net.ok(); return late.status === 200 && late.type !== 'opaque' ? media.store(identity, url, late, {}) : null; }).catch(() => {}));
        return hit;
      }
      net.ok();
      // A file that announces itself as too large is not copied at all; one of unknown length is read only up to the limit.
      const limit = file.declared ? limits.maxFileBytes : limits.maxMediaBytes;
      const tooLarge = !media.isThumb(url) && Number(response.headers.get('content-length')) > limit;
      // An answer the device already has (the same ETag or date and length) is not written a second time.
      const same = hit && mediaTag(response) && hit.headers.get('X-FM-Tag') === mediaTag(response);
      if (response.status === 200 && response.type !== 'opaque' && !tooLarge && !same) waitUntil(media.store(identity, url, response.clone(), { limit }).catch(() => {}));
      return response;
    },

    async cached(identity, url) {
      if (!root.caches) return null;
      const cache = await root.caches.open(MEDIA_CACHE);
      const hit = await cache.match(media.cacheKey(identity, url));
      if (!hit) return null;
      const key = [identity.user, identity.org, media.urlKey(url)];
      const now = config.now();
      if (now - (touched.get(key.join(' ')) || 0) > limits.touchMs) {
        touched.set(key.join(' '), now);
        db.get('media', key).then((row) => (row ? db.put('media', Object.assign({}, row, { usedAt: now })) : null)).catch(() => {});
      }
      const headers = new Headers(hit.headers);
      headers.set('X-FM-Offline', 'saved');
      return new Response(hit.body, { status: 200, headers });
    },

    /** Keeps a file answer. Thumbnails always; other variants when they are 8 MB or smaller. `response` is consumed. */
    async store(identity, url, response, options) {
      if (!root.caches) return false;
      const thumb = media.isThumb(url);
      const blob = await bodyUpTo(response, thumb ? Infinity : (options && options.limit) || limits.maxMediaBytes);
      if (!blob) return false;
      const key = media.urlKey(url);
      const now = config.now();
      const cache = await root.caches.open(MEDIA_CACHE);
      const fixed = (options && options.fixed) || /immutable/i.test(response.headers.get('cache-control') || '');
      const headers = { 'Content-Type': response.headers.get('content-type') || blob.type || 'application/octet-stream', 'Cache-Control': fixed ? 'private, max-age=31536000, immutable' : 'private, no-cache' };
      if (fixed) headers['X-FM-Fixed'] = '1';
      if (mediaTag(response)) headers['X-FM-Tag'] = mediaTag(response);
      await cache.put(media.cacheKey(identity, url), new Response(blob, { status: 200, headers }));
      const keep = (options && options.keep) || (await pins.has(identity, 'media', key)) ? 1 : 0;
      await db.put('media', { k: [identity.user, identity.org, key], size: blob.size, usedAt: now, keep, thumb });
      media.written += blob.size;
      if (media.written >= limits.budgetCheckBytes) { media.written = 0; await media.enforce(); }
      return true;
    },
    written: 0,

    /**
     * Puts a file under a media URL, for example the small copy made when a photo is taken. It is served from the
     * device first, like a rendition; `options.fixed: false` keeps it only for when the server cannot be reached
     * (an original, which the server may replace).
     */
    put(identity, target, blob, options) {
      return media.store(identity, new URL(target, ORIGIN), new Response(blob, { headers: { 'Content-Type': blob.type || 'application/octet-stream' } }), { fixed: !(options && options.fixed === false) });
    },

    async remove(key) {
      if (root.caches) await (await root.caches.open(MEDIA_CACHE)).delete(`${ORIGIN}/.fm-media/${encodeURIComponent(key[0])}/${encodeURIComponent(key[1])}${key[2]}`);
      await db.del('media', key);
    },

    async enforce() {
      const budget = (await settings.get('mediaBudgetMb')) * MB;
      return evict('media', budget, media.remove);
    },

    async removeFor(user) {
      for (const key of await db.keys('media', [user])) await media.remove(key);
    }
  };

  /** What tells one answer of a file from the next: its ETag, else its date and length. '' when it says neither. */
  function mediaTag(response) {
    const etag = response.headers.get('etag');
    if (etag) return etag;
    const modified = response.headers.get('last-modified'), length = response.headers.get('content-length');
    return modified && length ? modified + ' ' + length : '';
  }

  function blobResponse(row, range, from) {
    const headers = { 'Content-Type': row.type || 'application/octet-stream', 'Cache-Control': 'no-store', 'X-FM-Offline': from || 'queued', 'Accept-Ranges': 'bytes' };
    const found = /^bytes=(\d*)-(\d*)$/.exec(range || '');
    if (!found || (!found[1] && !found[2])) return new Response(row.blob, { status: 200, headers });
    const size = row.blob.size;
    const start = found[1] ? Number(found[1]) : Math.max(0, size - Number(found[2]));
    const end = found[1] && found[2] ? Math.min(size - 1, Number(found[2])) : size - 1;
    if (start > end || start >= size) return new Response(null, { status: 416, headers: { 'Content-Range': `bytes */${size}` } });
    headers['Content-Range'] = `bytes ${start}-${end}/${size}`;
    return new Response(row.blob.slice(start, end + 1, row.type), { status: 206, headers });
  }

  // ---------------------------------------------------------------------------------------------------------
  // Pinned projects
  // ---------------------------------------------------------------------------------------------------------

  const pinCache = new Map();

  const pins = {
    /** { [project]: { at, auto, reads: [keys], media: [urlKeys], files: [urls a page named], refreshedAt } } for one person. */
    async load(identity) {
      const owner = ownerKey(identity);
      if (!pinCache.has(owner)) pinCache.set(owner, await meta.get('pins:' + owner, {}));
      return pinCache.get(owner);
    },
    async save(identity, value) { pinCache.set(ownerKey(identity), value); await meta.set('pins:' + ownerKey(identity), value); },
    forget() { pinCache.clear(); },
    async has(identity, kind, key) {
      const all = await pins.load(identity);
      for (const pin of Object.values(all)) if ((pin[kind] || []).includes(key)) return true;
      return false;
    },
    async list(identity) {
      return Object.entries(await pins.load(identity)).map(([project, pin]) => ({ org: identity.org, project, auto: !!pin.auto, at: pin.at, refreshedAt: pin.refreshedAt || null, reads: (pin.reads || []).length, media: (pin.media || []).length }));
    },

    /** Keeps a project on the device. `auto` pins are the ten most recently opened; older ones are let go. */
    async pin(identity, project, options) {
      const auto = !!(options && options.auto);
      if (auto && !(await settings.get('autoPinRecent'))) return null;
      const all = Object.assign({}, await pins.load(identity));
      const existing = all[project];
      all[project] = Object.assign({ reads: [], media: [] }, existing, { at: config.now(), auto: existing ? existing.auto && auto : auto });
      await pins.save(identity, all);
      if (auto) {
        const autos = Object.entries(all).filter(([, pin]) => pin.auto).sort((a, b) => b[1].at - a[1].at);
        for (const [old] of autos.slice(limits.autoPins)) await pins.unpin(identity, old);
      }
      await pins.prefetch(identity, project).catch(() => {});
      return (await pins.list(identity)).find((pin) => pin.project === String(project)) || null;
    },

    /**
     * Files that belong with a kept project and that only the page knows (an order's report PDFs: the order is
     * not named by the project's own reads). Each must be a media file or a route a contract declares in `files`.
     * They are downloaded now and again whenever the project is refreshed, and let go with it. Resolves the
     * number of files the project now names, or false when the project is not kept on this device.
     */
    async files(identity, project, urls) {
      const all = Object.assign({}, await pins.load(identity));
      const pin = all[project];
      if (!pin) return false;
      const wanted = [];
      for (const target of [].concat(urls || [])) {
        let url;
        try { url = new URL(String(target), ORIGIN); } catch (_) { continue; }
        if (url.origin !== ORIGIN || contracts.denied('GET', url.pathname) || !media.match(url.pathname)) continue;
        wanted.push(url.pathname + url.search);
      }
      const files = [...new Set([...(pin.files || []), ...wanted])].slice(-limits.pinFiles);
      const fresh = files.filter((file) => !(pin.media || []).includes(file));
      all[project] = Object.assign({}, pin, { files });
      await pins.save(identity, all);
      const kept = [];
      await pool(fresh, limits.prefetchAtOnce, async (file) => {
        try {
          const url = new URL(file, ORIGIN);
          const response = await config.fetch(url.href, { credentials: 'include', headers: { 'x-fm-offline-replay': '1' } });
          if (response.status === 200 && await media.store(identity, url, response, { keep: true, limit: media.match(url.pathname).declared ? limits.maxFileBytes : limits.maxMediaBytes })) kept.push(media.urlKey(url));
        } catch (_) { /* no answer: the next refresh fetches it */ }
      });
      if (kept.length) {
        const now = Object.assign({}, await pins.load(identity));
        if (now[project]) { now[project] = Object.assign({}, now[project], { media: [...new Set([...(now[project].media || []), ...kept])] }); await pins.save(identity, now); }
      }
      return files.length;
    },

    async unpin(identity, project) {
      const all = Object.assign({}, await pins.load(identity));
      const pin = all[project];
      if (!pin) return false;
      delete all[project];
      await pins.save(identity, all);
      for (const key of pin.reads || []) await setKeep('responses', [identity.user, identity.org, key], (await pins.has(identity, 'reads', key)) ? 1 : 0);
      for (const key of pin.media || []) await setKeep('media', [identity.user, identity.org, key], (await pins.has(identity, 'media', key)) ? 1 : 0);
      return true;
    },

    /** Downloads everything the contracts' `prefetch` entries name for the project. */
    async prefetch(identity, project) {
      const ctx = { org: identity.org, project: String(project), user: identity.user };
      const urls = new Set();
      const readKeys = new Set();
      const mediaKeys = new Set();
      // A declared POST read ({ url, body }): sent only when a contract declares it as a read, saved under that read's key.
      const fetchPost = async (target) => {
        const url = new URL(target.url, ORIGIN);
        if (url.origin !== ORIGIN || contracts.denied('POST', url.pathname)) return null;
        const text = JSON.stringify(target.body === undefined ? {} : target.body);
        const parsed = { type: 'json', text, value: JSON.parse(text) };
        for (const found of contracts.reads('POST', url.pathname)) {
          const readCtx = makeCtx({ method: 'POST', url: url.href, params: found.params, parsed, headers: {}, identity, now: config.now() });
          if (found.read.when && !(await found.read.when(readCtx))) continue;
          const key = readKey('POST', url, found.read.id + ' ' + stable(found.read.key ? await found.read.key(readCtx) : readCtx.body));
          const headers = { accept: 'application/json', 'content-type': 'application/json', 'x-fm-offline-replay': '1' };
          const token = await config.csrf();
          if (token) headers['x-platform-csrf'] = token;
          const response = await config.fetch(url.href, { method: 'POST', credentials: 'include', cache: 'no-store', headers, body: text });
          if (!reads.savable(response)) return null;
          readKeys.add(key);
          const json = await readJson(response);
          await reads.store(identity, key, response, { boot: true, req: { text, contentType: 'application/json', fields: null } });
          return json;
        }
        return null;
      };
      const fetchOne = async (target) => {
        if (target && typeof target === 'object') return fetchPost(target);
        const url = new URL(target, ORIGIN);
        if (url.origin !== ORIGIN || contracts.denied('GET', url.pathname)) return null;
        const response = await config.fetch(url.href, { credentials: 'include', headers: { accept: 'application/json', 'x-fm-offline-replay': '1' } });
        if (media.match(url.pathname)) {
          if (response.status === 200) { mediaKeys.add(media.urlKey(url)); await media.store(identity, url, response, { keep: true, limit: media.match(url.pathname).declared ? limits.maxFileBytes : limits.maxMediaBytes }); }
          return null;
        }
        if (!reads.savable(response)) return null;
        const key = readKey('GET', url);
        readKeys.add(key);
        const json = await readJson(response);
        await reads.store(identity, key, response, { boot: true });
        return json;
      };
      const each = [];
      for (const { item } of contracts.prefetch()) {
        try {
          if (typeof item === 'function') { for (const target of [].concat((await item(ctx)) || [])) urls.add(target); continue; }
          for (const target of [].concat((typeof item.url === 'function' ? await item.url(ctx) : item.url) || [])) each.push({ target, item });
        } catch (_) { /* one contract's mistake never stops the others */ }
      }
      for (const file of ((await pins.load(identity))[project] || {}).files || []) urls.add(file);      // what a page named (pins.files)
      let failed = 0;
      await pool(each, limits.prefetchAtOnce, async ({ target, item }) => {
        try { const json = await fetchOne(target); if (json && item.each) for (const next of [].concat((await item.each(json, ctx)) || [])) urls.add(next); } catch (_) { failed++; }
      });
      await pool([...urls], limits.prefetchAtOnce, async (target) => { try { await fetchOne(target); } catch (_) { failed++; } });
      const all = Object.assign({}, await pins.load(identity));
      if (all[project]) {
        // A read that could not be fetched this time stays pinned from the last time.
        // (A file a page named while this ran is the pin's too: it was fetched by pins.files, not here.)
        const named = (all[project].media || []).filter((key) => (all[project].files || []).includes(key));
        all[project] = Object.assign({}, all[project], { reads: [...new Set([...(failed ? all[project].reads || [] : []), ...readKeys])], media: [...new Set([...(failed ? all[project].media || [] : []), ...named, ...mediaKeys])], refreshedAt: failed ? all[project].refreshedAt || null : config.now() });
        await pins.save(identity, all);
      }
      return { reads: readKeys.size, media: mediaKeys.size, failed };
    },

    async refresh(identity) {
      for (const pin of await pins.list(identity)) await pins.prefetch(identity, pin.project).catch(() => {});
    },

    /** Sign-out: the list of pinned projects stays, what was downloaded for them does not. */
    async clearFor(user) {
      pins.forget();
      for (const row of await db.list('meta')) {
        if (typeof row.k !== 'string' || !row.k.startsWith('pins:' + user + '|')) continue;
        const value = {};
        for (const [project, pin] of Object.entries(row.v || {})) value[project] = Object.assign({}, pin, { reads: [], media: [], files: [], refreshedAt: null });
        await meta.set(row.k, value);
      }
    }
  };

  async function setKeep(store, key, keep) {
    const row = await db.get(store, key);
    if (row && row.keep !== keep) await db.put(store, Object.assign({}, row, { keep }));
  }

  // ---------------------------------------------------------------------------------------------------------
  // Three-way merge
  // ---------------------------------------------------------------------------------------------------------

  /**
   * merge3(base, mine, theirs) -> { value, conflicts: [{ path, base, mine, theirs }] }.
   * A value only one side changed takes that side. Objects merge by key, arrays whose items all have an `id`
   * merge by id. Anything else both sides changed differently is a conflict; `value` keeps mine there until
   * options.choose(path) answers 'mine' or 'theirs'. Paths look like "address.city" and "items.#12.qty".
   */
  function merge3(base, mine, theirs, options) {
    const conflicts = [];
    const value = mergeAt(base, mine, theirs, (options && options.path) || '', conflicts, (options && options.choose) || (() => null));
    return { value, conflicts };
  }

  const joinPath = (path, key) => (path ? path + '.' + key : String(key));
  const isIdArray = (value) => Array.isArray(value) && value.every((item) => isObject(item) && (typeof item.id === 'string' || typeof item.id === 'number'));

  function mergeAt(base, mine, theirs, path, conflicts, choose) {
    if (same(mine, theirs)) return mine;
    if (same(mine, base)) return theirs;
    if (same(theirs, base)) return mine;
    if (isObject(mine) && isObject(theirs)) {
      const from = isObject(base) ? base : {};
      const out = {};
      for (const key of new Set([...Object.keys(theirs), ...Object.keys(mine)])) {
        const value = mergeAt(from[key], mine[key], theirs[key], joinPath(path, key), conflicts, choose);
        if (value !== undefined) out[key] = value;
      }
      return out;
    }
    if (isIdArray(mine) && isIdArray(theirs) && (base == null || isIdArray(base))) return mergeById(base || [], mine, theirs, path, conflicts, choose);
    return decide(base, mine, theirs, path, conflicts, choose);
  }

  function decide(base, mine, theirs, path, conflicts, choose) {
    const choice = choose(path);
    if (choice === 'theirs') return theirs;
    if (choice !== 'mine') conflicts.push({ path, base, mine, theirs });
    return mine;
  }

  function mergeById(base, mine, theirs, path, conflicts, choose) {
    const byId = (list) => new Map(list.map((item) => [String(item.id), item]));
    const B = byId(base), M = byId(mine), T = byId(theirs);
    const items = new Map();
    for (const id of new Set([...T.keys(), ...M.keys()])) {
      const value = mergeAt(B.get(id), M.get(id), T.get(id), joinPath(path, '#' + id), conflicts, choose);
      if (value !== undefined) items.set(id, value);
    }
    const order = (list) => list.map((item) => String(item.id)).filter((id) => items.has(id));
    const mineOrder = order(mine), theirsOrder = order(theirs), baseOrder = order(base);
    const within = (ids, other) => ids.filter((id) => other.includes(id));
    const iMoved = !same(within(mineOrder, baseOrder), within(baseOrder, mineOrder));
    const theyMoved = !same(within(theirsOrder, baseOrder), within(baseOrder, theirsOrder));
    let lead = theirsOrder, other = mineOrder;
    if (iMoved && !theyMoved) { lead = mineOrder; other = theirsOrder; }
    else if (iMoved && theyMoved && !same(within(mineOrder, theirsOrder), within(theirsOrder, mineOrder))) {
      const picked = decide(within(baseOrder, baseOrder), mineOrder, theirsOrder, joinPath(path, '#order'), conflicts, choose);
      if (picked === mineOrder) { lead = mineOrder; other = theirsOrder; }
    }
    const result = lead.slice();
    other.forEach((id, index) => {
      if (result.includes(id)) return;
      let at = 0;
      for (let i = index - 1; i >= 0; i--) { const found = result.indexOf(other[i]); if (found >= 0) { at = found + 1; break; } }
      result.splice(at, 0, id);
    });
    return result.map((id) => items.get(id));
  }

  // ---------------------------------------------------------------------------------------------------------
  // Replay
  // ---------------------------------------------------------------------------------------------------------

  function backoff(tries) { return tries <= limits.backoffMs.length ? limits.backoffMs[Math.max(0, tries - 1)] : limits.backoffMaxMs; }

  const replay = {
    active: false,
    running: null,

    /**
     * Sends what waits for the signed-in person: oldest first within a scope, three scopes at a time. One run
     * ends when no entry is due; entries in backoff wait for a later run. Resolves { sent, blocked }.
     * options.resume lifts a sign-in pause first; options.force sends entries that wait in backoff now.
     */
    run(options) {
      const asked = !!(options && (options.force || options.resume));
      if (replay.running && !asked) return replay.running;
      // A run that was asked for (sync now, signed in again) is never answered by one already on its way.
      const run = (replay.running ? replay.running.catch(() => {}).then(() => runOnce(options || {})) : runOnce(options || {}))
        .finally(() => { if (replay.running === run) replay.running = null; });
      replay.running = run;
      return run;
    },

    /** The native host's answer for a delegated upload (a Response), or null when it got none. */
    async report(id, response) {
      const entry = await queue.get(id);
      if (!entry) return null;
      const run = { identity: { user: entry.user, org: entry.org }, stop: false, sent: 0, token: null, blocked: null };
      entry.state = 'waiting';
      const outcome = response ? await settle(run, entry, response, {}, {}) : await noAnswer(run, entry);
      if (outcome === 'again') await later(entry, 0);
      if (run.sent) await meta.set('lastSync:' + ownerKey(run.identity), config.now());
      await state.emit(run.identity);
      return outcome;
    }
  };

  async function runOnce(options) {
    const identity = options.identity || await config.identity();
    if (!identity || !identity.user) return { sent: 0, blocked: null };
    if (options.resume) await queue.resume(identity);
    const pause = await meta.get('pause:' + ownerKey(identity), null);
    if (pause) return { sent: 0, blocked: pause.reason };
    queue.invalidate();
    const entries = await queue.list(identity);
    const now = config.now();
    // The person asked, or the connection came back: what waits in backoff is due now.
    if (options.force) for (const entry of entries) if (entry.state === 'waiting' && entry.nextAt > now) { entry.nextAt = 0; await db.put('outbox', entry); }
    if (!entries.some((entry) => entry.state === 'waiting' && entry.nextAt <= now)) return { sent: 0, blocked: null };
    const run = { identity, stop: false, sent: 0, token: null, blocked: null, held: false };
    replay.active = true;
    await state.emit(identity).catch(() => {});
    try {
      // One pass sends every scope in its order. A change held behind another scope's (queue.follows) goes in a
      // further pass, as long as the pass before it sent something.
      for (let list = entries; ;) {
        const scopes = new Map();
        for (const entry of list) { if (!scopes.has(entry.scope)) scopes.set(entry.scope, []); scopes.get(entry.scope).push(entry); }
        const sentBefore = run.sent;
        run.held = false;
        await pool([...scopes.values()], limits.scopesAtOnce, (items) => runScope(run, items));
        if (!run.held || run.stop || run.sent === sentBefore) break;
        queue.invalidate();
        list = await queue.list(identity);
      }
    } finally {
      replay.active = false;
      if (run.sent) await meta.set('lastSync:' + ownerKey(identity), config.now()).catch(() => {});
      await queue.changed(identity).catch(() => {});
    }
    return { sent: run.sent, blocked: run.blocked };
  }

  async function runScope(run, list) {
    for (const entry of list) {
      if (run.stop) return;
      if (entry.state === 'delegated') return;                       // the host is uploading it; the scope keeps its order
      if (entry.state !== 'waiting') { if (holds(entry)) return; continue; }
      if (await queue.follows(entry)) { run.held = true; return; }   // names a record another scope's change still has to make
      if (config.external(queue.public(entry))) return;              // about to be handed to the host: never sent from here
      if (entry.nextAt > config.now()) return;
      const outcome = await sendEntry(run, entry).catch(() => 'later');
      if (outcome === 'done') continue;
      if (outcome === 'skip') { if (holds(entry)) return; continue; }
      return;
    }
  }

  async function csrfFor(run) {
    if (run.token == null) run.token = String((await config.csrf()) || '');
    return run.token;
  }

  async function sendEntry(run, entry) {
    const flags = { csrfRetried: false, merges: 0 };
    for (;;) {
      let plan, response;
      try { plan = await planSend(run, entry); } catch (_) { return noAnswer(run, entry); }
      if (plan.outcome) return plan.outcome;
      try {
        const headers = Object.assign({}, entry.headers, { 'idempotency-key': entry.key || entry.id, 'x-fm-offline-user': entry.user, 'x-fm-offline-org': entry.org, 'x-fm-offline-replay': '1' });
        if (plan.contentType) headers['content-type'] = plan.contentType; else if (plan.form) delete headers['content-type'];
        const token = await csrfFor(run);
        if (token) headers['x-platform-csrf'] = token;
        response = await config.fetch(new URL(entry.url, ORIGIN).href, { method: entry.method, headers, body: plan.body, credentials: 'include', cache: 'no-store' });
      } catch (_) { return noAnswer(run, entry); }
      const outcome = await settle(run, entry, response, plan, flags);
      if (outcome !== 'again') return outcome;
    }
  }

  /** What to send: the stored body, or for a `patch` with a conflict rule the three-way merge with the server's document. */
  async function planSend(run, entry) {
    const found = contracts.write(entry.contract, entry.write);
    const rule = found && found.write.conflict;
    if (entry.kind !== 'patch' || !rule) {
      const sent = sendable(await queue.parsed(entry));
      return { body: sent.body, contentType: sent.contentType, form: !sent.contentType };
    }
    const ctx = await queue.ctx(entry);
    const current = await config.fetch(new URL(await rule.current(ctx), ORIGIN).href, { method: 'GET', headers: { accept: 'application/json', 'x-fm-offline-replay': '1' }, credentials: 'include', cache: 'no-store' });
    net.ok();
    if (current.status === 401) { await pause(run, 'sign-in'); return { outcome: 'stop' }; }
    if (current.status >= 500) return { outcome: await serverError(entry, current.status, '') };
    if (!current.ok) return { outcome: await fail(entry, current.status, errorCode(await readJson(current)), 'The record could not be read') };
    const picked = await rule.pick(await current.json(), ctx);
    const theirs = (picked && picked.doc) || {};
    const revision = picked ? picked.revision : undefined;
    const fields = [].concat(rule.fields ? await rule.fields(ctx) : Object.keys(isObject(ctx.body) ? ctx.body : {}));
    const base = entry.base ? entry.base.doc : null;
    const mine = rule.mine ? await rule.mine(ctx, base) : Object.assign({}, base || {}, Object.fromEntries(fields.filter((field) => isObject(ctx.body) && field in ctx.body).map((field) => [field, ctx.body[field]])));
    const merged = {};
    const conflicts = [];
    for (const field of fields) {
      // Without the document as it was, the person's value is kept: they set it knowingly.
      const result = base ? merge3(base[field], mine[field], theirs[field], { path: field, choose: (path) => (entry.choices || {})[path] }) : { value: mine[field], conflicts: [] };
      conflicts.push(...result.conflicts);
      if (!same(result.value, theirs[field])) merged[field] = result.value === undefined ? null : result.value;
    }
    if (conflicts.length) {
      Object.assign(entry, { state: 'conflict', conflict: { revision: revision === undefined ? null : revision, fields: conflicts } });
      await queue.save(entry);
      events.emit('conflict', Object.assign(queue.public(entry), { fields: conflicts }));
      return { outcome: 'skip' };
    }
    if (!Object.keys(merged).length) return { outcome: await succeed(run, entry, 200, null) };   // the server already has it
    // `theirs` is the server's document as it is now, for a route that replaces the whole record.
    const text = JSON.stringify(await rule.send(ctx, merged, revision, theirs));
    // A body the server has not seen needs its own key: a key answers only for the body it was first sent with.
    if (entry.keyBody !== text) { Object.assign(entry, { key: newId(), keyBody: text }); await queue.save(entry); }
    return { body: text, contentType: 'application/json', merged: true };
  }

  /** Applies the answer table of the doc. Resolves 'done', 'skip' (failed, parked, conflict), 'later', 'stop' or 'again'. */
  async function settle(run, entry, response, plan, flags) {
    net.ok();
    const status = response.status;
    if (status >= 200 && status < 300) return succeed(run, entry, status, await readJson(response));
    const body = await readJson(response);
    const code = errorCode(body);
    if (status === 401 || (status === 403 && code === 'csrf_required')) {
      // A refusal kept under the key would be repeated for ever; the request did not run, so a new key is safe.
      if (response.headers.get('idempotency-replayed')) { entry.key = newId(); await queue.save(entry); }
      if (status === 403 && !flags.csrfRetried) { flags.csrfRetried = true; run.token = null; return 'again'; }
      await pause(run, 'sign-in');
      return 'stop';
    }
    if (status === 409 && code === 'offline_identity_mismatch') {
      Object.assign(entry, { state: 'parked', error: { status, code, message: PARKED_FOR_ANOTHER } });
      await queue.save(entry);
      events.emit('failed', queue.public(entry));
      return 'skip';
    }
    if (status === 409 && code === 'idempotency_in_progress') return later(entry, limits.inProgressRetryMs);
    if (status === 409 && plan.merged) {
      if (flags.merges < limits.mergeRepeats) { flags.merges++; return 'again'; }
      entry.attempts++;
      return later(entry, backoff(entry.attempts));
    }
    if (status >= 500) return serverError(entry, status, code);
    // A refusal that means the server already has this change (a create whose first answer was lost) is done.
    const found = contracts.write(entry.contract, entry.write);
    // A refusal that asks for the same change in another form (a publication action whose own key the server
    // will not take twice): the contract gives the body to send, once per attempt, under a new key.
    if (found && typeof found.write.resend === 'function' && !flags.resent) {
      let next;
      try { next = await found.write.resend(await queue.ctx(entry), { status, code, body }); } catch (_) { next = undefined; }
      if (next !== undefined && next !== null) {
        flags.resent = true;
        Object.assign(entry, { body: { type: 'json', text: JSON.stringify(next) }, key: newId() });
        await queue.save(entry);
        return 'again';
      }
    }
    if (found && typeof found.write.duplicate === 'function') {
      let done = false;
      try { done = !!(await found.write.duplicate(await queue.ctx(entry), { status, code, body })); } catch (_) { done = false; }
      if (done) return succeed(run, entry, 200, null);
    }
    // What the refusal means to the person, where the contract can say it better than the server's sentence
    // (`explain(ctx, answer)` on a write: a label, as FMOffline.label makes it). The tray shows it as the reason.
    let label = null;
    if (found && typeof found.write.explain === 'function') {
      try { label = (await found.write.explain(await queue.ctx(entry), { status, code, body })) || null; } catch (_) { label = null; }
    }
    return fail(entry, status, code, body && (body.message || (body.error && body.error.message)), label);
  }

  async function succeed(run, entry, status, answer) {
    const effects = await queue.effectsOf(entry);
    await queue.remove(entry.id);
    run.sent++;
    events.emit('synced', Object.assign(queue.public(entry), { state: 'synced', status, response: answer }));
    await reread(run.identity, effects).catch(() => {});
    return 'done';
  }

  /** Reads again every saved read the synced change touched, so the saved copy is the server's. */
  async function reread(identity, effects) {
    if (!effects.length) return;
    const due = [];
    for (const key of await db.keys('responses', [identity.user, identity.org])) {
      if (due.length >= limits.rereadLimit) break;
      const text = key[2];
      const space = text.indexOf(' ');
      const method = text.slice(0, space);
      const rest = text.slice(space + 1);
      const url = new URL(method === 'GET' ? rest : rest.split(' ')[0], ORIGIN);
      const info = readInfo(method, url, text);
      for (const effect of effects) {
        const params = matchAny(effect.patterns, method, url.pathname);
        if (!params) continue;
        if (method !== 'GET') { const row = await reads.row(identity, text); if (row && row.req && row.req.text) { try { info.body = JSON.parse(row.req.text); } catch (_) { info.body = row.req.text; } } }
        let applies = true;
        try { applies = !effect.when || !!(await effect.when(params, info)); } catch (_) { applies = false; }
        if (applies) { due.push(text); break; }
      }
    }
    await pool(due, limits.prefetchAtOnce, (key) => reads.refresh(identity, key).catch(() => false));
  }

  async function noAnswer(run, entry) {
    net.fail();
    run.stop = true;                                   // no connection: the other scopes would fail the same way
    entry.attempts++;
    return later(entry, backoff(entry.attempts));
  }

  async function later(entry, ms) {
    entry.nextAt = config.now() + ms;
    await queue.save(entry);
    return 'later';
  }

  async function serverError(entry, status, code) {
    entry.serverErrors = (entry.serverErrors || 0) + 1;
    if (entry.serverErrors >= limits.serverErrorTries) return fail(entry, status, code, 'The server could not take the change');
    return later(entry, backoff(entry.serverErrors));
  }

  async function fail(entry, status, code, message, label) {
    Object.assign(entry, { state: 'failed', error: Object.assign({ status, code: code || '', message: message ? String(message) : '' }, label && typeof label === 'object' ? { label } : {}) });
    await queue.save(entry);
    events.emit('failed', queue.public(entry));
    return 'skip';
  }

  async function pause(run, reason) {
    run.stop = true;
    run.blocked = reason;
    await meta.set('pause:' + ownerKey(run.identity), { reason, at: config.now() });
  }

  // ---------------------------------------------------------------------------------------------------------
  // State, storage, settings, identity
  // ---------------------------------------------------------------------------------------------------------

  const state = {
    /** The queue as one person sees it. */
    async queue(identity) {
      if (!identity || !identity.user) return { user: '', org: '', pending: 0, shown: 0, failed: 0, conflicts: 0, blocked: null, lastSyncAt: null, records: [] };
      const list = await queue.list(identity);
      const count = (...states) => list.filter((entry) => states.includes(entry.state)).length;
      const pauseRow = await meta.get('pause:' + ownerKey(identity), null);
      const pending = count('waiting', 'delegated');
      // `shown` is the number a person is told: quiet changes are left out unless only quiet ones wait.
      const loud = list.filter((entry) => (entry.state === 'waiting' || entry.state === 'delegated') && !entry.quiet).length;
      return {
        user: identity.user, org: identity.org,
        pending, shown: loud || pending, failed: count('failed', 'parked'), conflicts: count('conflict'),
        blocked: pauseRow ? pauseRow.reason : null,
        lastSyncAt: await meta.get('lastSync:' + ownerKey(identity), null),
        records: [...new Set(list.flatMap((entry) => entry.records || []))]
      };
    },
    async emit(identity, extra) {
      events.emit('state', Object.assign({ online: net.online(), syncing: replay.active, queue: await state.queue(identity) }, extra || {}));
    }
  };

  const storage = {
    /** True when the browser reports room for a file of `bytes` plus the reserve. */
    async hasRoom(bytes) {
      let estimate = {};
      try { estimate = (await config.estimate()) || {}; } catch (_) { estimate = {}; }
      if (typeof estimate.quota !== 'number' || typeof estimate.usage !== 'number') return true;
      return estimate.quota - estimate.usage >= bytes + limits.fileReserveBytes;
    },
    /** Bytes: what the browser allows and uses for the site, and what saved reads, media and queued changes take. */
    async report() {
      let estimate = {};
      try { estimate = (await config.estimate()) || {}; } catch (_) { estimate = {}; }
      const sum = (rows) => rows.reduce((total, row) => total + (row.size || 0), 0);
      const [readRows, mediaRows, blobRows, entries] = await Promise.all([db.sizes('responses'), db.sizes('media'), db.list('blobs'), queue.all()]);
      return {
        quota: typeof estimate.quota === 'number' ? estimate.quota : null,
        usage: typeof estimate.usage === 'number' ? estimate.usage : null,
        reads: sum(readRows), media: sum(mediaRows),
        queued: sum(blobRows) + entries.reduce((total, entry) => total + ((entry.body && entry.body.text) || '').length, 0),
        budgets: { reads: (await settings.get('readsBudgetMb')) * MB, media: (await settings.get('mediaBudgetMb')) * MB }
      };
    }
  };

  /** Settings of this device, for everyone who uses it. */
  const settings = {
    defaults: SETTING_DEFAULTS,
    async all() { return Object.assign({}, SETTING_DEFAULTS, await meta.get('settings', {})); },
    async get(name) { return (await settings.all())[name]; },
    async set(name, value) {
      const stored = Object.assign({}, await meta.get('settings', {}), { [name]: value });
      await meta.set('settings', stored);
      events.emit('settings', Object.assign({}, SETTING_DEFAULTS, stored));
      return value;
    }
  };

  const identity = {
    get: () => meta.get('identity', null),
    set: (value) => meta.set('identity', value),
    /** Everyone who has saved reads, media or kept projects on this device. */
    async users() {
      const users = new Set();
      for (const key of await db.keys('responses')) users.add(String(key[0]));
      for (const key of await db.keys('media')) users.add(String(key[0]));
      for (const row of await db.list('meta')) if (typeof row.k === 'string' && row.k.startsWith('pins:')) users.add(row.k.slice(5).split('|')[0]);
      users.delete('');
      return [...users];
    },
    /** Removes a person's saved reads, media and pinned downloads. Their queued changes stay. */
    async signOut(user) {
      if (!user) return;
      await reads.removeFor(user);
      await media.removeFor(user);
      await pins.clearFor(user);
      const current = await meta.get('identity', null);
      if (current && current.user === user) await meta.del('identity');
    }
  };

  root.FMOffline = {
    version: VERSION, origin: ORIGIN, limits, configure,
    // How a contract names a waiting change for people: the language key (platform-offline catalog), its English, and what it is about.
    label: (key, english, detail) => ({ key: String(key || ''), title: String(english || ''), detail: detail == null ? '' : String(detail) }),
    db, meta, events, net, contracts, api, reads, queue, replay, merge3, media, pins, state, storage, settings, identity,
    util: { compile, readKey, stable, same, newId, readBody, jsonResponse, race, pool, backoff }
  };
})(typeof self !== 'undefined' ? self : globalThis);
