(function(){
  const w = window;
  const noop = () => {};
  const state = {
    initialized: false,
    initializing: null,
    enabled: false,
    client: null,
    bootstrap: null,
    context: {},
    queue: []
  };

  function cleanText(value){
    return String(value == null ? '' : value).trim();
  }

  function isObject(value){
    return !!value && typeof value === 'object' && !Array.isArray(value);
  }

  function normalizeMetadata(metadata){
    const output = {};
    if (isObject(state.context)) Object.assign(output, state.context);
    if (isObject(metadata)) Object.assign(output, metadata);
    return output;
  }

  function debug(stage, data = {}){
    const configuredBase = cleanText(w.__APP?.platformApiBase).replace(/\/+$/, '');
    const localBase = `${location.protocol}//${location.hostname || '127.0.0.1'}:3111/v1/platform`;
    const base = configuredBase || ((location.hostname === '127.0.0.1' || location.hostname === 'localhost') ? localBase : `${location.origin}/v1/platform`);
    fetch(`${base}/statsig/debug`, {
      method: 'POST',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({
        stage,
        data,
        href: location.href,
        ts: new Date().toISOString()
      })
    }).catch(noop);
  }

  function flattenDataset(dataset){
    const metadata = {};
    Object.entries(dataset || {}).forEach(([key, value]) => {
      if (!key.startsWith('fmTrack') || key === 'fmTrack') return;
      const normalized = key.slice('fmTrack'.length).replace(/^[A-Z]/, (letter) => letter.toLowerCase());
      if (normalized) metadata[normalized] = value;
    });
    return metadata;
  }

  async function loadStatsigModules(){
    // jsDelivr's generated +esm bundle currently maps web-vitals named exports
    // to a null default import inside @statsig/web-analytics. esm.sh preserves
    // those exports, which keeps Statsig autocapture/web-vitals from warning.
    const base = 'https://esm.sh/';
    const [clientModule, replayModule, analyticsModule] = await Promise.all([
      import(base + '@statsig/js-client@3.33.2'),
      import(base + '@statsig/session-replay@3.33.2'),
      import(base + '@statsig/web-analytics@3.33.2')
    ]);
    return {
      StatsigClient: clientModule.StatsigClient,
      StatsigSessionReplayPlugin: replayModule.StatsigSessionReplayPlugin,
      StatsigAutoCapturePlugin: analyticsModule.StatsigAutoCapturePlugin
    };
  }

  async function fetchBootstrap(){
    const configuredBase = cleanText(w.__APP?.platformApiBase).replace(/\/+$/, '');
    const localBase = `${location.protocol}//${location.hostname || '127.0.0.1'}:3111/v1/platform`;
    const base = configuredBase || ((location.hostname === '127.0.0.1' || location.hostname === 'localhost') ? localBase : `${location.origin}/v1/platform`);
    const response = await fetch(`${base}/statsig/bootstrap`, {
      credentials: 'include',
      headers: { Accept: 'application/json' }
    });
    if (!response.ok) throw new Error('Statsig bootstrap failed: ' + response.status);
    return await response.json();
  }

  function flushQueue(){
    const queued = state.queue.splice(0);
    queued.forEach((item) => track(item.eventName, item.metadata, item.value));
  }

  async function init(options = {}){
    if (state.initialized || state.initializing) return state.initializing || Promise.resolve(state);
    state.initializing = (async () => {
      const bootstrap = await fetchBootstrap().catch((error) => {
        console.warn('[FirstMateStatsig] bootstrap unavailable', error);
        debug('bootstrap_failed', { message: error?.message || String(error) });
        return null;
      });
      state.bootstrap = bootstrap;
      state.context = isObject(bootstrap?.context) ? { ...bootstrap.context } : {};
      state.enabled = !!(bootstrap?.enabled && bootstrap?.clientKey);
      debug('bootstrap_loaded', {
        enabled: state.enabled,
        configured: !!bootstrap?.configured,
        authenticated: !!bootstrap?.authenticated,
        environmentTier: bootstrap?.environmentTier || ''
      });
      if (!state.enabled) {
        state.initialized = true;
        flushQueue();
        return state;
      }

      let modules;
      try {
        modules = await loadStatsigModules();
        debug('modules_loaded', { keys: Object.keys(modules) });
      } catch (error) {
        debug('modules_failed', { message: error?.message || String(error) });
        throw error;
      }
      const { StatsigClient, StatsigSessionReplayPlugin, StatsigAutoCapturePlugin } = modules;

      const plugins = [
        new StatsigSessionReplayPlugin(),
        new StatsigAutoCapturePlugin()
      ];
      state.client = new StatsigClient(
        bootstrap.clientKey,
        bootstrap.user || { userID: 'anonymous' },
        {
          environment: { tier: bootstrap.environmentTier || 'development' },
          loggingEnabled: 'always',
          plugins
        }
      );
      try {
        const details = await state.client.initializeAsync();
        debug('initialized', {
          status: state.client.loadingStatus || '',
          details
        });
      } catch (error) {
        debug('initialize_failed', { message: error?.message || String(error) });
        throw error;
      }
      state.initialized = true;
      flushQueue();
      track('app_loaded', { source: options.source || 'platform' });
      flush();
      return state;
    })().finally(() => {
      state.initializing = null;
    });
    return state.initializing;
  }

  function track(eventName, metadata = {}, value){
    const name = cleanText(eventName);
    if (!name) return false;
    if (!state.initialized) {
      state.queue.push({ eventName: name, metadata, value });
      if (!state.initializing) init().catch(noop);
      return true;
    }
    if (!state.enabled || !state.client) return false;
    try {
      const merged = normalizeMetadata(metadata);
      if (value === undefined) {
        state.client.logEvent(name, null, merged);
      } else {
        state.client.logEvent(name, value, merged);
      }
      setTimeout(() => { flush(); }, 250);
      return true;
    } catch (error) {
      console.warn('[FirstMateStatsig] event failed', name, error);
      return false;
    }
  }

  function setContext(patch = {}){
    if (!isObject(patch)) return { ...state.context };
    state.context = { ...state.context, ...patch };
    return { ...state.context };
  }

  function featureSeen(feature, metadata = {}){
    const key = cleanText(feature);
    if (!key) return false;
    return track('feature_seen', { feature: key, ...metadata });
  }

  function featureUsed(feature, metadata = {}){
    const key = cleanText(feature);
    if (!key) return false;
    return track('feature_used', { feature: key, ...metadata });
  }

  function canUse(group, flag, options = {}){
    const normalizedGroup = cleanText(group);
    const normalizedFlag = cleanText(flag);
    const platformAllowed = !!w.PlatformAPI?.appFlags?.has?.(normalizedGroup, normalizedFlag);
    const feature = normalizedGroup && normalizedFlag ? `${normalizedGroup}.${normalizedFlag}` : cleanText(options.feature);
    if (platformAllowed && options.trackExposure !== false) {
      featureSeen(feature, { source: options.source || 'canUse' });
    }
    return platformAllowed;
  }

  function flush(){
    if (!state.client?.flush) return Promise.resolve();
    try {
      return Promise.resolve(state.client.flush());
    } catch {
      return Promise.resolve();
    }
  }

  document.addEventListener('click', (event) => {
    const target = event.target?.closest?.('[data-fm-track]');
    if (!target) return;
    const eventName = cleanText(target.getAttribute('data-fm-track'));
    if (!eventName) return;
    track(eventName, {
      source: 'data_attribute',
      element_id: cleanText(target.id),
      element_label: cleanText(target.getAttribute('aria-label') || target.textContent).slice(0, 120),
      ...flattenDataset(target.dataset)
    });
  }, true);

  w.addEventListener('fm:app-flags:updated', (event) => {
    const detail = event.detail || {};
    const enabled = isObject(detail.enabled) ? detail.enabled : {};
    const keys = Object.entries(enabled).flatMap(([group, flags]) => (
      Array.isArray(flags) ? flags.map((flag) => `${group}.${flag}`) : []
    ));
    setContext({
      enabled_app_flags: enabled,
      enabled_app_flag_keys: keys
    });
    track('app_flags_loaded', { enabled_app_flag_keys: keys });
  });

  w.addEventListener('pagehide', () => {
    flush();
  });

  w.FirstMateStatsig = {
    init,
    track,
    featureSeen,
    featureUsed,
    canUse,
    setContext,
    flush,
    state: () => ({
      initialized: state.initialized,
      enabled: state.enabled,
      configured: !!state.bootstrap?.configured,
      environmentTier: state.bootstrap?.environmentTier || '',
      context: { ...state.context }
    })
  };
})();
