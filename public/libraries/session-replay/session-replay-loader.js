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

  const VERSION = '20261022-1';
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

  async function post(path, body, keepalive) {
    const payload = JSON.stringify(body);
    const response = await fetch(apiBase + path, {
      method: 'POST',
      credentials: 'include',
      cache: 'no-store',
      keepalive: !!keepalive && payload.length < 60000,
      headers: { 'Content-Type': 'application/json', Accept: 'application/json', 'X-Platform-CSRF': csrf() },
      body: payload
    });
    let data = null;
    try { data = await response.json(); } catch (error) { data = null; }
    return { ok: response.ok && !(data && data.ok === false), status: response.status, data };
  }

  function chunkBody(item) {
    const body = {
      session_id: item.session_id, page_id: item.page_id, seq: item.seq, page_started_at: item.page_started_at,
      t_start: item.t_start, t_end: item.t_end, events: item.events, raw_bytes: item.raw_bytes || item.json.length,
      encoding: item.data ? item.encoding : 'json'
    };
    if (item.data) body.data = item.data; else body.json = item.json;
    if (item.meta) body.meta = item.meta;
    return body;
  }

  const transport = {
    sendChunk: (item) => post('/session-replay/chunks', chunkBody(item)),
    missingBlobs: async (keys) => {
      const result = await post('/session-replay/blobs/missing', { keys });
      if (!result.ok) throw new Error('Session replay blob check failed (' + result.status + ').');
      return (result.data && result.data.missing) || keys;
    },
    sendBlob: (blob) => post('/session-replay/blobs', blob),
    beacon: (item) => { post('/session-replay/chunks', chunkBody(item), true).catch(() => {}); }
  };

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
      maskAllInputs: config.mask_all_inputs === true,
      newSessionId: () => sessionId(true),
      onUploaded: (item) => touchSession(item.session_id),
      onStop: (reason) => { state.status = 'stopped'; state.reason = reason; },
      onOverlay: (on) => write(OVERLAY_KEY, on),
      openViewer: (id) => root.open(viewerUrl(id, true), 'fm-session-replay-viewer')
    });
    state.recorder = recorder;
    state.status = 'recording';
    recorder.start();
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
