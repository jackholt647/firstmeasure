/* libraries/session-replay/session-replay-loader.js
 * Loaded on every signed-in FirstMate page (platform-api.js adds it). It asks the
 * platform once whether session replay is on for this person's organization and
 * loads the recorder only when it is. See docs/architecture/session-replay.md.
 *
 * Console:
 *   FMReplay.status()        what is being recorded and what it costs
 *   FMReplay.overlay()       toggle the live diagnostics panel (remembered for this tab)
 *   FMReplay.viewer()        open this session in the replay viewer, following it live
 *   FMReplay.flush()         send what is buffered now
 *   FMReplay.stop()          stop recording this page
 *   FMReplay.track(name, d)  add a named marker to the replay
 */
(function () {
  'use strict';
  const root = window;
  if (root.FMReplay) return;
  let topLevel = true;
  try { topLevel = root.top === root; } catch (error) { topLevel = false; }
  // A same-origin frame is recorded as part of its parent page.
  if (!topLevel) return;
  if (document.documentElement && document.documentElement.hasAttribute('data-fmr-no-record')) return;

  const VERSION = '20261023-1';
  const SESSION_KEY = 'fmr.session';
  const OVERLAY_KEY = 'fmr.overlay';
  const IDLE_MS = 30 * 60 * 1000;
  const script = document.currentScript;
  const base = (script && script.src) || new URL('/libraries/session-replay/session-replay-loader.js', location.href).href;
  const asset = (name) => new URL(name + '?v=' + VERSION, base).href;
  const APP = root.__APP || {};
  const apiBase = String(APP.platformApiBase || (location.origin + '/v1/platform')).replace(/\/+$/, '');
  const state = { status: 'checking', reason: '', config: null, recorder: null };

  function store() { try { return root.sessionStorage; } catch (error) { return null; } }
  function read(key) { try { return JSON.parse((store() && store().getItem(key)) || 'null'); } catch (error) { return null; } }
  function write(key, value) { try { if (store()) store().setItem(key, JSON.stringify(value)); } catch (error) { /* private mode */ } }
  function randomId(length) {
    const bytes = new Uint8Array(length);
    root.crypto.getRandomValues(bytes);
    let out = '';
    for (let i = 0; i < length; i++) out += 'abcdefghijklmnopqrstuvwxyz0123456789'[bytes[i] % 36];
    return out;
  }

  // One session per tab, kept across page loads until 30 idle minutes pass or the
  // person or organization changes.
  function sessionId(fresh) {
    const owner = state.config ? state.config.org_id + '/' + state.config.user_id : '';
    const saved = fresh ? null : read(SESSION_KEY);
    if (saved && saved.id && saved.owner === owner && Date.now() - Number(saved.last || 0) < IDLE_MS) {
      write(SESSION_KEY, { id: saved.id, owner, last: Date.now() });
      return saved.id;
    }
    const id = randomId(20);
    write(SESSION_KEY, { id, owner, last: Date.now() });
    return id;
  }
  function touchSession(id) {
    const saved = read(SESSION_KEY);
    if (saved && saved.id === id) write(SESSION_KEY, Object.assign(saved, { last: Date.now() }));
  }

  function cookie(name) {
    const target = encodeURIComponent(name) + '=';
    const part = document.cookie.split(';').map((value) => value.trim()).find((value) => value.startsWith(target));
    return part ? part.slice(target.length) : '';
  }
  function csrf() {
    const name = state.config && state.config.csrf_cookie;
    if (!name) return '';
    try { return decodeURIComponent(cookie(name)); } catch (error) { return ''; }
  }

  // Chunks and blobs go up as one binary frame: a 4-byte big-endian length, that many bytes of JSON describing the
  // payload, then the gzip bytes as they are (no base64, no JSON escaping). Small requests stay JSON.
  const FRAME_TYPE = 'application/vnd.firstmate.replay-frame';
  const utf8 = new TextEncoder();
  function frame(header, bytes) {
    const head = utf8.encode(JSON.stringify(header));
    const out = new Uint8Array(4 + head.length + bytes.length);
    new DataView(out.buffer).setUint32(0, head.length);
    out.set(head, 4);
    out.set(bytes, 4 + head.length);
    return out;
  }

  async function post(path, body, keepalive) {
    const binary = body instanceof Uint8Array;
    const payload = binary ? body : JSON.stringify(body);
    const response = await fetch(apiBase + path, {
      method: 'POST',
      credentials: 'include',
      keepalive: !!keepalive && payload.length < 60000,
      headers: { 'Content-Type': binary ? FRAME_TYPE : 'application/json', Accept: 'application/json', 'X-Platform-CSRF': csrf() },
      body: payload
    });
    let data = null;
    try { data = await response.json(); } catch (error) { data = null; }
    return { ok: response.ok && !(data && data.ok === false), status: response.status, data };
  }

  function chunkFrame(item) {
    // A chunk the page is leaving before it was compressed goes up as its JSON text.
    const bytes = item.bytes || utf8.encode(item.json);
    const header = {
      session_id: item.session_id, page_id: item.page_id, seq: item.seq, page_started_at: item.page_started_at,
      t_start: item.t_start, t_end: item.t_end, events: item.events, raw_bytes: item.raw_bytes || bytes.length,
      encoding: item.bytes ? item.encoding : 'identity'
    };
    if (item.meta) header.meta = item.meta;
    if (item.paths && item.paths.length) header.paths = item.paths.slice(0, 50);
    return frame(header, bytes);
  }

  const transport = {
    sendChunk: (item) => post('/session-replay/chunks', chunkFrame(item)),
    missingBlobs: async (keys) => {
      const result = await post('/session-replay/blobs/missing', { keys });
      if (!result.ok) throw new Error('Session replay blob check failed (' + result.status + ').');
      return (result.data && result.data.missing) || keys;
    },
    sendBlob: (blob) => post('/session-replay/blobs', frame({ key: blob.key, raw_bytes: blob.raw_bytes, encoding: blob.encoding }, blob.bytes)),
    beacon: (item) => { post('/session-replay/chunks', chunkFrame(item), true).catch(() => {}); },
    beaconBlob: (blob) => {
      post('/session-replay/blobs', frame({ key: blob.key, raw_bytes: blob.raw_bytes, encoding: blob.encoding }, blob.bytes), true).catch(() => {});
    }
  };

  // Pages an administrator set not to record: a pattern over the path and hash, compared in lower case. Without `*`
  // it covers every path starting with it; with `*` the whole path must match. The server's pagePatternLike
  // (session-replay/storage.ts) matches the same way when filtering sessions by page.
  function pageAllowed(patterns) {
    const tests = (patterns || []).map((pattern) => {
      const lower = String(pattern).toLowerCase();
      if (lower.indexOf('*') < 0) return (path) => path.indexOf(lower) === 0;
      const re = new RegExp('^' + lower.split('*').map((part) => part.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('.*') + '$');
      return (path) => re.test(path);
    });
    return (path) => !tests.some((test) => test(String(path).toLowerCase()));
  }

  // When a platform administrator starts following this session live, the server says so on the page's platform
  // event stream and the recorder sends at once instead of at its next interval. Only a stream the page already
  // holds is used: the recorder never opens a connection of its own (docs/architecture/realtime.md).
  let listening = false;
  function listenForViewers() {
    const realtime = root.PlatformRealtime;
    const orgId = state.config && state.config.org_id;
    if (listening || !orgId || !realtime || typeof realtime.subscribe !== 'function' || typeof realtime.diagnostics !== 'function') return;
    let open = false;
    try { open = realtime.diagnostics().some((entry) => entry.orgId === orgId && entry.connections > 0); } catch (error) { open = false; }
    if (!open) return;
    listening = true;
    realtime.subscribe(orgId, 'session_replay.watch', (event) => {
      const recorder = state.recorder;
      const payload = (event && event.payload) || {};
      if (recorder && payload.session_id === recorder.sessionId) recorder.hurry(payload.interval_ms).catch(() => {});
    });
  }

  function viewerUrl(id, live) {
    return new URL('viewer.html', base).href + '#session=' + encodeURIComponent(id || '') + (live ? '&live=1' : '');
  }

  function loadScript(src) {
    return new Promise((resolve, reject) => {
      const element = document.createElement('script');
      element.src = src;
      element.async = true;
      element.onload = resolve;
      element.onerror = () => reject(new Error('Could not load ' + src));
      (document.head || document.documentElement).appendChild(element);
    });
  }

  function whenReady() {
    return document.readyState === 'loading'
      ? new Promise((resolve) => document.addEventListener('DOMContentLoaded', resolve, { once: true }))
      : Promise.resolve();
  }

  async function begin() {
    let config = null;
    try {
      const response = await fetch(apiBase + '/session-replay/config', { credentials: 'include', cache: 'no-store', headers: { Accept: 'application/json' } });
      config = response.ok ? await response.json() : null;
    } catch (error) {
      config = null;
    }
    if (!config || !config.enabled) {
      state.status = 'off';
      state.reason = config ? (config.reason || 'off') : 'unavailable';
      return;
    }
    state.config = config;
    state.status = 'loading';
    await loadScript(asset('session-replay-codec.js'));
    await loadScript(asset('session-replay-recorder.js'));
    await whenReady();
    const recorder = root.FMReplayRecorder.create({
      transport,
      sessionId: sessionId(false),
      chunkIntervalMs: config.chunk_interval_ms,
      pageAllowed: pageAllowed(config.exclude_pages),
      maskAllInputs: config.mask_all_inputs === true,
      newSessionId: () => sessionId(true),
      onUploaded: (item) => { touchSession(item.session_id); listenForViewers(); },
      onStop: (reason) => { state.status = 'stopped'; state.reason = reason; },
      onOverlay: (on) => write(OVERLAY_KEY, on),
      openViewer: (id) => root.open(viewerUrl(id, true), 'fm-session-replay-viewer')
    });
    state.recorder = recorder;
    state.status = 'recording';
    recorder.start();
    listenForViewers();
    if (read(OVERLAY_KEY) === true) recorder.overlay(true);
  }

  function explain() {
    if (state.status === 'off') {
      return state.reason === 'signed_out' ? 'Session replay is not recording: nobody is signed in on this page.'
        : state.reason === 'off' ? 'Session replay is off for this organization.'
        : 'Session replay could not reach the platform.';
    }
    if (state.status === 'checking' || state.status === 'loading') return 'Session replay is starting.';
    return 'Session replay stopped (' + state.reason + ').';
  }

  root.FMReplay = {
    version: VERSION,
    status() {
      if (!state.recorder) {
        const out = { recording: false, state: state.status, reason: state.reason, message: explain() };
        console.info('[session replay] ' + out.message);
        return out;
      }
      const stats = state.recorder.stats();
      console.table && console.table(stats);
      return stats;
    },
    overlay(on) {
      if (!state.recorder) { console.info('[session replay] ' + explain()); return false; }
      return state.recorder.overlay(on);
    },
    viewer(id) {
      const target = id || (state.recorder && state.recorder.sessionId) || '';
      return root.open(viewerUrl(target, !id), 'fm-session-replay-viewer');
    },
    viewerUrl: (id) => viewerUrl(id || (state.recorder && state.recorder.sessionId) || '', !id),
    flush() { return state.recorder ? state.recorder.flush() : Promise.resolve(); },
    stop() { if (state.recorder) state.recorder.stop('stopped_from_console'); return explain(); },
    track(name, data) { if (state.recorder) state.recorder.track(name, data); },
    get sessionId() { return state.recorder ? state.recorder.sessionId : ''; },
    get recorder() { return state.recorder; },
    help() {
      console.info('[session replay] FMReplay.status(), .overlay(), .viewer(), .flush(), .stop(), .track(name, data)');
    }
  };

  begin().catch((error) => {
    state.status = 'stopped';
    state.reason = 'load_failed';
    console.warn('[session replay]', error);
  });
})();
