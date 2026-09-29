/* libraries/platform-realtime/platform-realtime.js
 * Shared realtime client for the platform SSE hub (/v1/platform .../events/stream).
 *
 * One EventSource per organization, shared by every consumer on the page.
 * Consumers subscribe by topic prefix; on connection loss the client
 * reconnects with the last seen event id, and if events were dropped the
 * backend sends `sys.resync` so consumers can refetch their state. If SSE
 * keeps failing, the client silently falls back to cursor polling against
 * .../events/poll so the experience degrades to "slightly delayed", never
 * "broken".
 */
(function(){
  const root = window;
  if (root.PlatformRealtime) return;
  const APP = root.__APP || {};

  const POLL_INTERVAL_MS = 1000;
  const SSE_RETRY_MS = 30_000;

  const state = {
    baseUrl: '',
    orgs: new Map() // orgId -> { source, lastEventId, subscribers:Set, failures, pollTimer, mode }
  };

  function cleanText(value){
    return String(value ?? '').trim();
  }

  function defaultBaseUrl(){
    if (APP.platformApiBase) return cleanText(APP.platformApiBase).replace(/\/+$/, '');
    const host = cleanText(location.hostname).toLowerCase();
    if (host === '127.0.0.1' || host === 'localhost') return `${location.origin}/v1/platform`;
    return `${location.origin}/v1/platform`;
  }

  function baseUrl(){
    if (!state.baseUrl) state.baseUrl = defaultBaseUrl();
    return state.baseUrl;
  }

  function orgState(orgId){
    let entry = state.orgs.get(orgId);
    if (!entry) {
      entry = { source: null, lastEventId: 0, subscribers: new Set(), failures: 0, pollTimer: null, mode: 'idle', reconnectTimer: null };
      state.orgs.set(orgId, entry);
    }
    return entry;
  }

  function dispatch(orgId, event){
    const entry = state.orgs.get(orgId);
    if (!entry) return;
    for (const subscriber of [...entry.subscribers]) {
      try {
        if (event.topic === 'sys.resync') {
          subscriber.onResync?.();
        } else if (!subscriber.prefix || String(event.topic || '').startsWith(subscriber.prefix)) {
          subscriber.handler(event);
        }
      } catch (error) {
        console.warn('[PlatformRealtime] subscriber error', error);
      }
    }
    try {
      root.dispatchEvent(new CustomEvent('fm:realtime:event', { detail: { orgId, event } }));
    } catch (e) {}
  }

  function connect(orgId){
    const entry = orgState(orgId);
    if (entry.source || entry.mode === 'polling' || !entry.subscribers.size) return;
    if (typeof root.EventSource !== 'function') {
      startPolling(orgId);
      return;
    }
    const streamUrl = `${baseUrl()}/organizations/${encodeURIComponent(orgId)}/events/stream${entry.lastEventId ? `?after=${entry.lastEventId}` : ''}`;
    let source;
    try {
      source = new EventSource(streamUrl, { withCredentials: true });
    } catch (error) {
      startPolling(orgId);
      return;
    }
    entry.source = source;
    entry.mode = 'sse';
    source.addEventListener('platform', (message) => {
      if (entry.source !== source || !entry.subscribers.size) return;
      entry.failures = 0;
      const id = Number(message.lastEventId || 0);
      let data = null;
      try { data = JSON.parse(message.data); } catch (e) { return; }
      if (id && id <= entry.lastEventId && data.topic !== 'sys.resync') return;
      if (Number.isFinite(id) && id > entry.lastEventId) entry.lastEventId = id;
      dispatch(orgId, data);
    });
    source.onerror = () => {
      source.close();
      entry.source = null;
      entry.failures += 1;
      if (!entry.subscribers.size) return;
      // Keep receiving during an SSE outage instead of waiting through backoff.
      startPolling(orgId);
    };
  }

  async function pollOnce(orgId){
    const entry = orgState(orgId);
    try {
      const response = await fetch(
        `${baseUrl()}/organizations/${encodeURIComponent(orgId)}/events/poll?after=${entry.lastEventId}`,
        { credentials: 'include', cache: 'no-store', headers: { Accept: 'application/json' } }
      );
      if (!response.ok) return;
      const data = await response.json();
      if (entry.mode !== 'polling' || !entry.subscribers.size) return;
      entry.failures = 0;
      if (data?.resync) dispatch(orgId, { topic: 'sys.resync', payload: {}, ts: new Date().toISOString() });
      for (const event of (data?.events || [])) {
        if (event.seq && event.seq <= entry.lastEventId) continue;
        dispatch(orgId, event);
        if (Number.isFinite(Number(event.seq))) entry.lastEventId = Math.max(entry.lastEventId,Number(event.seq));
      }
      if (Number.isFinite(Number(data?.next))) entry.lastEventId = Math.max(entry.lastEventId, Number(data.next));
    } catch (error) {
      /* transient network errors are fine while polling */
    }
  }

  function startPolling(orgId){
    const entry = orgState(orgId);
    if (entry.mode === 'polling') return;
    entry.mode = 'polling';
    if (entry.source) { entry.source.close(); entry.source = null; }
    const tick = async () => {
      if (!entry.subscribers.size) return;
      await pollOnce(orgId);
      if (entry.mode === 'polling' && entry.subscribers.size) entry.pollTimer = setTimeout(tick, document.hidden ? 10000 : POLL_INTERVAL_MS);
    };
    tick();
    clearTimeout(entry.reconnectTimer);
    if (typeof root.EventSource === 'function') entry.reconnectTimer = setTimeout(() => {
      if (!entry.subscribers.size || entry.mode !== 'polling') return;
      clearTimeout(entry.pollTimer); entry.mode = 'idle'; connect(orgId);
    }, SSE_RETRY_MS);
  }

  function teardownIfIdle(orgId){
    const entry = state.orgs.get(orgId);
    if (!entry || entry.subscribers.size) return;
    if (entry.source) { entry.source.close(); entry.source = null; }
    clearTimeout(entry.pollTimer);
    clearTimeout(entry.reconnectTimer);
    entry.mode = 'idle';
  }

  /**
   * subscribe(orgId, topicPrefix, handler, { onResync }) -> unsubscribe()
   * topicPrefix '' receives everything. handler({ topic, payload, ts }).
   */
  function subscribe(orgId, topicPrefix, handler, options = {}){
    const id = cleanText(orgId);
    if (!id || typeof handler !== 'function') return () => {};
    const entry = orgState(id);
    const subscriber = { prefix: cleanText(topicPrefix), handler, onResync: options.onResync };
    entry.subscribers.add(subscriber);
    connect(id);
    return () => {
      entry.subscribers.delete(subscriber);
      teardownIfIdle(id);
    };
  }

  function configure(options = {}){
    if (options.baseUrl) state.baseUrl = cleanText(options.baseUrl).replace(/\/+$/, '');
    return api;
  }

  function diagnostics(){
    return [...state.orgs.entries()].map(([orgId, entry]) => ({
      orgId,
      mode: entry.mode,
      lastEventId: entry.lastEventId,
      subscribers: entry.subscribers.size,
      failures: entry.failures
    }));
  }

  // Each visible surface owns its connection; closing it immediately removes
  // that session without affecting another tab belonging to the same person.
  function watchPresence(orgId, scope, onChange){
    let source = null;
    let disposed = false;
    function stop(){ source?.close(); source = null; onChange([]); }
    function sync(){
      if (disposed || document.hidden) { stop(); return; }
      if (source || typeof root.EventSource !== 'function') return;
      source = new EventSource(`${baseUrl()}/organizations/${encodeURIComponent(orgId)}/presence/${encodeURIComponent(scope)}`, { withCredentials:true });
      const currentSource = source;
      source.addEventListener('presence', event => {
        if (disposed || currentSource !== source || document.hidden) return;
        try { const users = JSON.parse(event.data); if (Array.isArray(users)) onChange(users); } catch (_) {}
      });
      source.onerror = () => { if (!disposed && currentSource === source) onChange([]); };
    }
    document.addEventListener('visibilitychange', sync);
    root.addEventListener('pagehide', stop);
    root.addEventListener('pageshow', sync);
    sync();
    return () => {
      disposed = true; stop();
      document.removeEventListener('visibilitychange', sync);
      root.removeEventListener('pagehide', stop);
      root.removeEventListener('pageshow', sync);
    };
  }

  const api = { configure, subscribe, diagnostics, watchPresence };
  root.PlatformRealtime = api;
})();
