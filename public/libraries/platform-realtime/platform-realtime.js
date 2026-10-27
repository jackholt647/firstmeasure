/* libraries/platform-realtime/platform-realtime.js
 * Shared realtime client for the platform SSE hub (/v1/platform .../events/stream).
 *
 * One EventSource per organization, shared by every consumer on the page —
 * and the ONLY long-lived connection the portal holds. Platform events arrive
 * on it by topic; live state the server keeps per page (who is viewing, live
 * document editing) arrives on it as channels (watchChannel). Browsers allow
 * six HTTP/1.1 connections per site across all tabs, so a feature that opens
 * a stream of its own starves ordinary requests: do not create an
 * EventSource, WebSocket or streaming fetch anywhere else. See
 * docs/architecture/realtime.md.
 *
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
  // Owned project documents share their host's transports. Otherwise nested
  // panes exhaust HTTP/1 connection slots before their app assets can load.
  try {
    const name=root.name||'', host=root.parent;
    const owned=host!==root && (
      (name.startsWith('fm-project-window:') && host.FirstMateProjectWindows?.accepts(name.slice(18),root)) ||
      (name.startsWith('fm-project-pane:') && host.FirstMateProjectLayout?.accepts(name.slice(16),root))
    );
    if(owned && host.PlatformRealtime){
      const shared=host.PlatformRealtime, stops=new Set();
      const retain=stop=>{const release=()=>{stops.delete(release);stop();};stops.add(release);return release;};
      const forward=event=>root.dispatchEvent(new CustomEvent('fm:realtime:event',{detail:event.detail}));
      const activity=()=>shared.recordActivity?.();
      const activityEvents=['pointermove','pointerdown','keydown','touchstart','wheel'];
      host.addEventListener('fm:realtime:event',forward);
      activityEvents.forEach(event=>document.addEventListener(event,activity,{passive:true}));
      root.addEventListener('pagehide',()=>{
        stops.forEach(stop=>stop());host.removeEventListener('fm:realtime:event',forward);
        activityEvents.forEach(event=>document.removeEventListener(event,activity));
      },{once:true});
      const adapter={
        configure(){return adapter;},
        subscribe(...args){return retain(shared.subscribe(...args));},
        watchPresence(...args){return retain(shared.watchPresence(...args));},
        watchChannel(...args){return retain(shared.watchChannel(...args));},
        diagnostics:()=>shared.diagnostics(),
        recordActivity:activity,
        // The owning portal maintains account presence for this surface.
        startPresence(){}
      };
      root.PlatformRealtime=adapter;return;
    }
  } catch (_) { /* Standalone and foreign documents keep their own client. */ }
  const APP = root.__APP || {};

  const POLL_INTERVAL_MS = 1000;
  const SSE_RETRY_MS = 30_000;
  // With channels riding the stream (who is viewing, live editing), a dropped
  // stream is retried quickly: polling carries platform events, not channels.
  const CHANNEL_RETRY_MS = 3000;

  const state = {
    baseUrl: '',
    suspended: false,
    orgs: new Map() // orgId -> { source, retiring, watchKey, lastEventId, subscribers:Set, channels:Map, failures, pollTimer, mode }
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

  // The platform event stream, its poll fallback and presence all need
  // platform.expanded_access; without it the server refuses every request
  // (403 capability_denied), so the page opens nothing rather than retrying a
  // refusal every few seconds. Same check as Portal.platformExpandedAccess().
  // A page that does not say (no portal flag) keeps its stream.
  function streamAllowed(){
    if (typeof root.Portal?.platformExpandedAccess === 'function') return root.Portal.platformExpandedAccess() === true;
    return APP.platformExpandedAssets !== false;
  }

  function orgState(orgId){
    let entry = state.orgs.get(orgId);
    if (!entry) {
      entry = { source: null, retiring: null, watchKey: '', lastEventId: 0, subscribers: new Set(), channels: new Map(), failures: 0, pollTimer: null, mode: 'idle', reconnectTimer: null, watchTimer: null };
      state.orgs.set(orgId, entry);
    }
    return entry;
  }

  const wanted = (entry) => entry.subscribers.size > 0 || entry.channels.size > 0;
  const watchKeyOf = (entry) => [...entry.channels.keys()].sort().join(',');

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

  function channelEach(entry, name, run){
    const channel = entry.channels.get(name);
    if (!channel) return;
    for (const handlers of [...channel.handlers]) {
      try { run(handlers); } catch (error) { console.warn('[PlatformRealtime] channel subscriber error', error); }
    }
  }
  /** Every channel's listeners hear that the stream carrying them is gone. */
  function channelsDown(entry){
    for (const name of [...entry.channels.keys()]) channelEach(entry, name, (handlers) => handlers.onDown?.('stream_lost'));
  }

  function streamUrl(orgId, entry){
    const query = [];
    if (entry.lastEventId) query.push(`after=${entry.lastEventId}`);
    for (const name of [...entry.channels.keys()].sort()) query.push(`watch=${encodeURIComponent(name)}`);
    if (entry.channels.has('presence:online')) query.push(`activity_age_ms=${Math.min(604800000, Date.now() - lastActivity)}`);
    return `${baseUrl()}/organizations/${encodeURIComponent(orgId)}/events/stream${query.length ? `?${query.join('&')}` : ''}`;
  }

  /**
   * The one stream for an organization. It is opened when something first
   * needs it and replaced, new connection first and old one closed after,
   * whenever the set of watched channels changes.
   */
  function connect(orgId){
    const entry = orgState(orgId);
    if (state.suspended || !wanted(entry)) return;
    if (!streamAllowed()) { closeStream(entry); return; }
    const key = watchKeyOf(entry);
    if (entry.source && entry.watchKey === key) return;
    if (entry.mode === 'polling' && !entry.channels.size) return;
    if (typeof root.EventSource !== 'function') {
      if (entry.subscribers.size) startPolling(orgId);
      return;
    }
    let source;
    try {
      source = new EventSource(streamUrl(orgId, entry), { withCredentials: true });
    } catch (error) {
      if (entry.subscribers.size) startPolling(orgId);
      return;
    }
    if (entry.mode === 'polling') { clearTimeout(entry.pollTimer); clearTimeout(entry.reconnectTimer); }
    // The connection being replaced keeps delivering until this one is open.
    if (entry.retiring) entry.retiring.close();
    entry.retiring = entry.source;
    entry.source = source;
    entry.watchKey = key;
    entry.mode = 'sse';
    const live = () => entry.source === source || entry.retiring === source;
    source.addEventListener('open', () => {
      if (entry.source !== source) return;
      entry.failures = 0;
      if (entry.retiring) { entry.retiring.close(); entry.retiring = null; }
    });
    source.addEventListener('platform', (message) => {
      if (!live() || !entry.subscribers.size) return;
      entry.failures = 0;
      const id = Number(message.lastEventId || 0);
      let data = null;
      try { data = JSON.parse(message.data); } catch (e) { return; }
      if (id && id <= entry.lastEventId && data.topic !== 'sys.resync') return;
      if (Number.isFinite(id) && id > entry.lastEventId) entry.lastEventId = id;
      dispatch(orgId, data);
    });
    source.addEventListener('channel', (message) => {
      if (!live()) return;
      let frame = null;
      try { frame = JSON.parse(message.data); } catch (e) { return; }
      const name = cleanText(frame?.channel);
      if (!entry.channels.has(name)) return;
      if (frame.event === 'error') {
        // The server stopped or refused this one channel; ask again shortly.
        channelEach(entry, name, (handlers) => handlers.onDown?.(cleanText(frame.data?.code) || 'channel_ended'));
        clearTimeout(entry.watchTimer);
        entry.watchTimer = setTimeout(() => { if (entry.source === source) { entry.watchKey = '\u0000'; connect(orgId); } }, CHANNEL_RETRY_MS);
        return;
      }
      channelEach(entry, name, (handlers) => handlers.onEvent?.(frame.event, frame.data));
    });
    source.onerror = () => {
      source.close();
      if (entry.retiring === source) { entry.retiring = null; return; }
      if (entry.source !== source) return;
      if (entry.retiring) { entry.retiring.close(); entry.retiring = null; }
      entry.source = null;
      entry.watchKey = '';
      entry.failures += 1;
      channelsDown(entry);
      if (!wanted(entry)) { entry.mode = 'idle'; return; }
      // Keep receiving during an SSE outage instead of waiting through backoff.
      if (entry.subscribers.size) startPolling(orgId);
      else { entry.mode = 'idle'; clearTimeout(entry.reconnectTimer); entry.reconnectTimer = setTimeout(() => connect(orgId), CHANNEL_RETRY_MS); }
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
    if (entry.retiring) { entry.retiring.close(); entry.retiring = null; }
    entry.watchKey = '';
    const tick = async () => {
      if (!entry.subscribers.size) return;
      await pollOnce(orgId);
      if (entry.mode === 'polling' && entry.subscribers.size) entry.pollTimer = setTimeout(tick, document.hidden ? 10000 : POLL_INTERVAL_MS);
    };
    tick();
    clearTimeout(entry.reconnectTimer);
    if (typeof root.EventSource === 'function') entry.reconnectTimer = setTimeout(() => {
      if (!wanted(entry) || entry.mode !== 'polling') return;
      clearTimeout(entry.pollTimer); entry.mode = 'idle'; connect(orgId);
    }, entry.channels.size ? CHANNEL_RETRY_MS : SSE_RETRY_MS);
  }

  function closeStream(entry){
    if (entry.source) { entry.source.close(); entry.source = null; }
    if (entry.retiring) { entry.retiring.close(); entry.retiring = null; }
    entry.watchKey = '';
    clearTimeout(entry.pollTimer);
    clearTimeout(entry.reconnectTimer);
    clearTimeout(entry.watchTimer);
    entry.mode = 'idle';
  }

  function teardownIfIdle(orgId){
    const entry = state.orgs.get(orgId);
    if (!entry || wanted(entry)) return;
    closeStream(entry);
  }

  /** Several watches starting or stopping together become one change to the stream. */
  function syncWatch(orgId){
    const entry = orgState(orgId);
    clearTimeout(entry.watchTimer);
    entry.watchTimer = setTimeout(() => {
      if (!wanted(entry)) { teardownIfIdle(orgId); return; }
      connect(orgId);
    }, 20);
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

  /**
   * watchChannel(orgId, name, { onEvent(event, data), onDown(code) }) -> stop()
   * A channel is live state the server keeps for this page while it watches:
   * "presence:<scope>" (who is here), "collab:<documentId>" (live editing).
   * It rides the organization's one stream; nothing opens a connection of its
   * own. The server ends the channel when the page stops watching or leaves.
   */
  function watchChannel(orgId, name, handlers = {}){
    const id = cleanText(orgId);
    const channelName = cleanText(name);
    if (!id || !channelName) return () => {};
    const entry = orgState(id);
    let channel = entry.channels.get(channelName);
    if (!channel) { channel = { handlers: new Set() }; entry.channels.set(channelName, channel); }
    channel.handlers.add(handlers);
    syncWatch(id);
    let stopped = false;
    return () => {
      if (stopped) return;
      stopped = true;
      channel.handlers.delete(handlers);
      if (!channel.handlers.size && entry.channels.get(channelName) === channel) entry.channels.delete(channelName);
      syncWatch(id);
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
      channels: [...entry.channels.keys()].sort(),
      connections: (entry.source ? 1 : 0) + (entry.retiring ? 1 : 0),
      failures: entry.failures
    }));
  }

  // A page being put away (navigation, back-forward cache) lets go of its
  // stream, which is what removes it from every roster; it comes back with the page.
  root.addEventListener('pagehide', () => {
    state.suspended = true;
    for (const entry of state.orgs.values()) { closeStream(entry); channelsDown(entry); }
  });
  // Access granted later (capabilities loaded) opens what the page already wants.
  root.addEventListener('fm:capabilities:updated', () => {
    if (state.suspended) return;
    for (const orgId of state.orgs.keys()) connect(orgId);
  });
  root.addEventListener('pageshow', () => {
    if (!state.suspended) return;
    state.suspended = false;
    for (const orgId of state.orgs.keys()) connect(orgId);
  });

  // Account presence: this page counts as online while it watches. Closing
  // the page removes its session without affecting another tab of the same person.
  const onlineWatches = new Map();
  let lastActivity = Date.now();
  function watchOnline(orgId, onChange){
    let entry = onlineWatches.get(orgId);
    if (!entry) {
      entry = {listeners:new Set(), users:[], session:'', lastSent:0};
      onlineWatches.set(orgId, entry);
      entry.stop = watchChannel(orgId, 'presence:online', {
        onEvent(event, data){
          if (event === 'session') { entry.session = cleanText(data?.session_id); return; }
          if (event !== 'presence' || !Array.isArray(data)) return;
          entry.users = data; entry.listeners.forEach(listener => listener(data));
        },
        onDown(){ entry.session = ''; entry.users = []; entry.listeners.forEach(listener => listener([])); }
      });
      entry.activity = () => {
        if (!entry.session || Date.now()-entry.lastSent<10000) return;
        entry.lastSent=Date.now();
        const cookieName=(APP.platformSessionCookieName || 'fm_platform_session')+'_csrf';
        const csrf=document.cookie.split('; ').find(value=>value.startsWith(cookieName+'='))?.slice(cookieName.length+1);
        root.fetch(`${baseUrl()}/organizations/${encodeURIComponent(orgId)}/presence/activity`,{method:'POST',credentials:'include',headers:{'Content-Type':'application/json',...(csrf?{'x-platform-csrf':decodeURIComponent(csrf)}:{})},body:JSON.stringify({session_id:entry.session})}).catch(()=>{});
      };
    }
    entry.listeners.add(onChange);onChange(entry.users);
    return () => {entry.listeners.delete(onChange);if(!entry.listeners.size){entry.stop();onlineWatches.delete(orgId);}};
  }
  function recordActivity(){if(document.hidden)return;lastActivity=Date.now();onlineWatches.forEach(entry=>entry.activity());}
  for (const event of ['pointermove','pointerdown','keydown','touchstart','wheel']) document.addEventListener(event,recordActivity,{passive:true});
  let globalPresenceStop=null, globalPresenceOrg='';
  function startPresence(orgId){
    orgId=cleanText(orgId);if(orgId===globalPresenceOrg)return;
    globalPresenceStop?.();globalPresenceOrg=orgId;globalPresenceStop=orgId?watchOnline(orgId,()=>{}):null;
  }
  // Viewing presence: this page counts as looking at the scope only while it is visible.
  function createPresenceWatch(orgId, scope, onChange){
    if(scope==='online') return watchOnline(orgId,onChange);
    let stopChannel = null;
    let disposed = false;
    function stop(){ if (stopChannel) { stopChannel(); stopChannel = null; } onChange([]); }
    function sync(){
      if (disposed || document.hidden) { stop(); return; }
      if (stopChannel) return;
      stopChannel = watchChannel(orgId, `presence:${scope}`, {
        onEvent(event, data){ if (!disposed && !document.hidden && event === 'presence' && Array.isArray(data)) onChange(data); },
        onDown(){ if (!disposed) onChange([]); }
      });
    }
    document.addEventListener('visibilitychange', sync);
    sync();
    return () => {
      disposed = true; stop();
      document.removeEventListener('visibilitychange', sync);
    };
  }

  const presenceWatches=new Map();
  function watchPresence(orgId,scope,onChange){
    const key=JSON.stringify([orgId,scope]);let entry=presenceWatches.get(key);
    if(!entry){
      entry={listeners:new Set(),users:[]};presenceWatches.set(key,entry);
      entry.stop=createPresenceWatch(orgId,scope,users=>{entry.users=users;for(const listener of [...entry.listeners]){try{listener(users);}catch(error){console.warn('[PlatformRealtime] presence subscriber error',error);}}});
    }
    entry.listeners.add(onChange);onChange(entry.users);
    return ()=>{entry.listeners.delete(onChange);if(!entry.listeners.size && presenceWatches.get(key)===entry){presenceWatches.delete(key);entry.stop();}};
  }
  // dev.1m8.ai only: browser files written to the live layer reach this page and its project frames as soon
  // as they are saved (docs/architecture/live-layer.md). The code that applies them loads on first use.
  let liveStop=null, liveOrg='';
  function startLiveAssets(orgId){
    orgId=cleanText(orgId);if(root.location?.hostname!=='dev.1m8.ai'||orgId===liveOrg)return;
    liveStop?.();liveOrg=orgId;root.__fmLiveAssets=true;
    liveStop=orgId?watchChannel(orgId,'live-assets',{onEvent(event,data){
      import('/libraries/live-assets/live-assets.js').then(module=>module.receive(event,data)).catch(error=>console.warn('[PlatformRealtime] live assets',error));
    }}):null;
  }
  const api = { configure, subscribe, watchChannel, diagnostics, watchPresence, startPresence, recordActivity };
  root.PlatformRealtime = api;
  startPresence(APP.userOrgId);
  startLiveAssets(APP.userOrgId);
  root.addEventListener('fm:platform-session:updated',event=>{startPresence(event.detail?.orgId);startLiveAssets(event.detail?.orgId);});
})();
