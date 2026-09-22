/* FirstMate browser navigation
 *
 * This is the only application-level owner of window.history. Feature code
 * should use Portal.navigation (or the compatible Portal.routeState facade)
 * instead of calling pushState/replaceState or parsing location.search.
 */
(function(root){
  'use strict';

  const Portal = root.Portal = root.Portal || {};
  const handlers = new Map();
  const schemas = new Map();
  let applying = false;
  let applyPromise = null;
  let sequence = 0;

  const clean = (value) => String(value ?? '').trim();
  const object = (value) => value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  const currentHref = () => `${root.location.pathname || ''}${root.location.search || ''}${root.location.hash || ''}`;

  function normalizeTab(value){
    const tab = clean(value);
    return tab === 'dashboard' ? 'scheduling' : tab;
  }

  function read(urlLike = root.location.href){
    const url = urlLike instanceof URL ? urlLike : new URL(urlLike, root.location.href);
    const route = {};
    url.searchParams.forEach((value, key) => { route[key] = clean(value); });
    // Legacy Calls links always open the lists in the central Communications app.
    if (route.tab === 'calls') { route.tab = 'chat'; route.communicationsView = 'lists'; }
    route.tab = normalizeTab(route.tab);
    schemas.forEach((schema, key) => {
      if (!Object.prototype.hasOwnProperty.call(route, key)) return;
      if (typeof schema.normalize === 'function') route[key] = clean(schema.normalize(route[key], route));
      if (Array.isArray(schema.values) && !schema.values.includes(route[key])) route[key] = clean(schema.default);
    });
    return route;
  }

  function scopeIdentity(scope = {}){
    return JSON.stringify(Object.keys(object(scope)).sort().reduce((result, key) => {
      result[key] = scope[key];
      return result;
    }, {}));
  }

  function scopeMatches(scope = {}, route = {}){
    return Object.entries(object(scope)).every(([key, expected]) => {
      const actual = clean(route[key]);
      if (expected === true) return !!actual;
      if (expected === false || expected == null || expected === '') return !actual;
      if (Array.isArray(expected)) return expected.map(clean).includes(actual);
      return actual === clean(expected);
    });
  }

  function schemaInScope(schema = {}, route = {}){
    const scopes = Array.isArray(schema.scopes) ? schema.scopes : [];
    return !scopes.length || scopes.some((scope) => scopeMatches(scope, route));
  }

  function normalizedUrl(urlLike = root.location.href){
    const url = urlLike instanceof URL ? new URL(urlLike.href) : new URL(urlLike, root.location.href);
    if (url.searchParams.get('tab') === 'calls') {
      url.searchParams.set('tab', 'chat');
      url.searchParams.set('communicationsView', 'lists');
    }
    // Iterate because removing a parent can invalidate another registered child.
    for (let pass = 0; pass < 3; pass += 1) {
      const route = read(url);
      let changed = false;
      schemas.forEach((schema, key) => {
        if (!url.searchParams.has(key)) return;
        const value = clean(route[key]);
        if (!value || !schemaInScope(schema, route)) {
          url.searchParams.delete(key);
          changed = true;
          return;
        }
        if (url.searchParams.get(key) !== value) {
          url.searchParams.set(key, value);
          changed = true;
        }
      });
      if (!changed) break;
    }
    return url;
  }

  function changedKeys(before, after){
    return [...new Set([...Object.keys(before || {}), ...Object.keys(after || {})])]
      .filter((key) => clean(before?.[key]) !== clean(after?.[key]));
  }

  function urlFor(patch = {}){
    const url = new URL(root.location.href);
    Object.entries(object(patch)).forEach(([key, value]) => {
      const text = clean(value);
      if (text) url.searchParams.set(key, text);
      else url.searchParams.delete(key);
    });
    return normalizedUrl(url);
  }

  function routeScopeDepths(method, before, after, previousNavigation){
    const scopes = { ...object(previousNavigation.scopeDepths) };
    const routeKeys = new Set([
      ...Object.keys(object(before)),
      ...Object.keys(object(after)),
      ...Object.keys(scopes)
    ]);
    routeKeys.forEach((key) => {
      const previousValue = clean(before?.[key]);
      const nextValue = clean(after?.[key]);
      if (!nextValue) {
        delete scopes[key];
        return;
      }
      if (method !== 'pushState') {
        if (previousValue !== nextValue) delete scopes[key];
        return;
      }
      if (previousValue !== nextValue) {
        scopes[key] = 1;
        return;
      }
      const existingDepth = Number(scopes[key] || 0);
      if (existingDepth > 0) scopes[key] = existingDepth + 1;
    });
    return scopes;
  }

  function navigationState(method, keys, options = {}, before = {}, after = {}){
    const previous = object(root.history.state);
    const previousNavigation = object(previous.fmNavigation);
    const depth = method === 'pushState' ? Number(previousNavigation.depth || 0) + 1 : Number(previousNavigation.depth || 0);
    return {
      ...previous,
      fmRoute: true,
      fmNavigation: {
        version: 2,
        id: `fm_${Date.now().toString(36)}_${(++sequence).toString(36)}`,
        depth,
        source: clean(options.source || (method === 'pushState' ? 'navigation' : 'sync')),
        ownedKeys: Array.isArray(options.ownedKeys) ? options.ownedKeys.map(clean).filter(Boolean) : keys,
        scopeDepths: routeScopeDepths(method, before, after, previousNavigation),
        timestamp: Date.now()
      }
    };
  }

  function emit(route, detail = {}){
    const payload = { route, ...detail };
    root.dispatchEvent(new CustomEvent('fm:route-state:updated', { detail: payload }));
    return route;
  }

  function write(patch = {}, options = {}){
    const before = read();
    const url = urlFor(patch);
    const next = `${url.pathname}${url.search}${url.hash}`;
    if (next === currentHref()) return before;
    const after = read(url);
    const keys = changedKeys(before, after);
    const schemaHistory = keys.some((key) => schemas.get(key)?.history === 'push') ? 'push' : 'replace';
    const historyMode = clean(options.history || (options.push ? 'push' : schemaHistory)).toLowerCase();
    if (historyMode === 'none') return before;
    const method = historyMode === 'push' ? 'pushState' : 'replaceState';
    try {
      root.history[method](navigationState(method, keys, options, before, after), '', next);
    } catch (error) {
      console.warn('FirstMate navigation write failed', error);
    }
    return emit(after, { source: options.source || historyMode, history: historyMode, changedKeys: keys });
  }

  function reconcile(options = {}){
    const before = read();
    const url = normalizedUrl();
    const next = `${url.pathname}${url.search}${url.hash}`;
    if (next === currentHref()) return before;
    const after = read(url);
    const keys = changedKeys(before, after);
    try {
      root.history.replaceState(
        navigationState('replaceState', keys, { ...options, source:options.source || 'reconcile' }, before, after),
        '',
        next
      );
    } catch (error) {
      console.warn('FirstMate navigation reconciliation failed', error);
    }
    return emit(after, { source:options.source || 'reconcile', history:'replace', changedKeys:keys });
  }

  function push(patch = {}, options = {}){
    return write(patch, { ...options, history: 'push' });
  }

  function replace(patch = {}, options = {}){
    return write(patch, { ...options, history: 'replace' });
  }

  function navigate(patch = {}, options = {}){
    const route = push(patch, options);
    void applyCurrent({ source:options.source || 'navigate' });
    return route;
  }

  function clear(keys = [], options = {}){
    const patch = {};
    (Array.isArray(keys) ? keys : [keys]).forEach((key) => { if (clean(key)) patch[key] = null; });
    return write(patch, options);
  }

  function ownsAny(keys = []){
    const owned = new Set((root.history.state?.fmNavigation?.ownedKeys || []).map(clean));
    return (Array.isArray(keys) ? keys : [keys]).some((key) => owned.has(clean(key)));
  }

  function backOrClose(keys = [], fallbackPatch = {}, options = {}){
    const scopeDepths = object(root.history.state?.fmNavigation?.scopeDepths);
    const steps = Math.max(0, ...(Array.isArray(keys) ? keys : [keys]).map((key) => Number(scopeDepths[clean(key)] || 0)));
    if (steps > 0) {
      if (typeof root.history.go === 'function') root.history.go(-steps);
      else root.history.back();
      return { backed: true, steps, route: read() };
    }
    return { backed: false, route: replace(fallbackPatch, { ...options, source: options.source || 'close' }) };
  }

  function registerSchema(key, definition = {}){
    const routeKey = clean(key);
    if (!routeKey) throw new Error('A route schema requires a key.');
    const previous = schemas.get(routeKey) || {};
    const suppliedScopes = [
      ...(Array.isArray(definition.scopes) ? definition.scopes : []),
      ...(definition.scope ? [definition.scope] : [])
    ].map(object).filter((scope) => Object.keys(scope).length);
    const scopes = [...(Array.isArray(previous.scopes) ? previous.scopes : []), ...suppliedScopes]
      .filter((scope, index, list) => list.findIndex((candidate) => scopeIdentity(candidate) === scopeIdentity(scope)) === index);
    schemas.set(routeKey, { ...previous, ...definition, key:routeKey, scopes });
    return () => schemas.delete(routeKey);
  }

  function registerApp(definition = {}){
    const route = object(definition.route);
    const parent = clean(route.parent);
    const tab = clean(definition.portalTabId || definition.tabId || route.params?.tab?.default);
    const projectTab = clean(route.params?.projectTab?.default || (clean(definition.id).startsWith('project.') ? clean(definition.id).slice(8) : ''));
    Object.entries(object(route.params)).forEach(([key, schemaValue]) => {
      const schema = object(schemaValue);
      let scope = schema.scope || null;
      if (!scope && key === 'projectTab') scope = { project:true };
      else if (!scope && key !== 'tab' && key !== 'project') {
        if (parent === 'portal' && tab) scope = { tab };
        else if (parent === 'project' && projectTab) scope = { project:true, projectTab };
      }
      registerSchema(key, { ...schema, ...(scope ? { scope } : {}) });
    });
    return route;
  }

  function registerHandler(id, definition = {}){
    const handlerId = clean(id);
    if (!handlerId || typeof definition.apply !== 'function') throw new Error('A route handler requires an id and apply(route, context).');
    handlers.set(handlerId, { priority: Number(definition.priority || 1000), ...definition, id: handlerId });
    if (definition.immediate) Promise.resolve().then(() => applyCurrent({ source: 'register', only: handlerId }));
    return () => handlers.delete(handlerId);
  }

  async function applyCurrent(context = {}){
    if (applyPromise) {
      if (!context.force) return applyPromise;
      return applyPromise.then(() => applyCurrent({ ...context, force:false }));
    }
    const route = read();
    const ordered = [...handlers.values()]
      .filter((handler) => !context.only || handler.id === context.only)
      .sort((left, right) => left.priority - right.priority);
    applying = true;
    root.document?.documentElement?.classList?.add('fm-route-applying');
    emit(route, { source: context.source || 'apply', history: 'apply', applying: true });
    applyPromise = (async () => {
      for (const handler of ordered) {
        try {
          if (typeof handler.match === 'function' && !handler.match(route, context)) continue;
          await handler.apply(route, { ...context, applying: true, navigation: api });
        } catch (error) {
          console.warn(`FirstMate route handler failed: ${handler.id}`, error);
        }
      }
      return route;
    })().finally(() => {
      applying = false;
      applyPromise = null;
      root.document?.documentElement?.classList?.remove('fm-route-applying');
      emit(read(), { source: context.source || 'apply', history: 'apply', applying: false });
    });
    return applyPromise;
  }

  function routeValue(key, fallback = ''){
    return clean(read()[key] || fallback);
  }

  function bindTabs(rootElement, options = {}){
    const element = rootElement;
    const key = clean(options.key);
    const selector = options.selector || '[data-route-value]';
    if (!element || !key) return { destroy(){} };
    const history = options.history === 'replace' ? 'replace' : 'push';
    const apply = (route = read()) => {
      const value = clean(route[key] || options.defaultValue);
      element.querySelectorAll(selector).forEach((tab) => {
        const active = clean(tab.dataset.routeValue || tab.dataset[options.dataset || 'routeValue']) === value;
        tab.classList.toggle(options.activeClass || 'active', active);
        tab.setAttribute('aria-selected', active ? 'true' : 'false');
      });
      options.onApply?.(value, route);
    };
    const click = (event) => {
      const tab = event.target.closest(selector);
      if (!tab || !element.contains(tab)) return;
      const value = clean(tab.dataset.routeValue || tab.dataset[options.dataset || 'routeValue']);
      if (!value) return;
      write({ [key]: value }, { history, source: options.source || `tabs:${key}` });
      apply();
    };
    const routeListener = (event) => apply(event.detail?.route || event.detail || read());
    element.addEventListener('click', click);
    root.addEventListener('fm:route-state:updated', routeListener);
    apply();
    return { destroy(){ element.removeEventListener('click', click); root.removeEventListener('fm:route-state:updated', routeListener); } };
  }

  function createController(id, options = {}){
    const controllerId = clean(id);
    const keys = Array.isArray(options.keys) ? options.keys.map(clean).filter(Boolean) : [];
    Object.entries(object(options.params)).forEach(([key, schema]) => registerSchema(key, object(schema)));
    const unregister = typeof options.apply === 'function'
      ? registerHandler(controllerId, { priority:options.priority, immediate:options.immediate, match:options.match, apply:options.apply })
      : () => {};
    return {
      id:controllerId,
      read,
      value:routeValue,
      write:(patch, writeOptions = {}) => write(patch, { source:controllerId, ownedKeys:keys.length ? keys : Object.keys(object(patch)), ...writeOptions }),
      push:(patch, writeOptions = {}) => push(patch, { source:controllerId, ownedKeys:keys.length ? keys : Object.keys(object(patch)), ...writeOptions }),
      replace:(patch, writeOptions = {}) => replace(patch, { source:controllerId, ownedKeys:keys.length ? keys : Object.keys(object(patch)), ...writeOptions }),
      close:(fallback = {}, closeOptions = {}) => backOrClose(keys, fallback, { source:`${controllerId}:close`, ...closeOptions }),
      destroy:unregister
    };
  }

  const api = {
    read,
    get: read,
    urlFor,
    write,
    set: write,
    push,
    navigate,
    replace,
    reconcile,
    clear,
    backOrClose,
    ownsAny,
    registerSchema,
    registerApp,
    registerHandler,
    applyCurrent,
    createController,
    bindTabs,
    value: routeValue,
    get applying(){ return applying; }
  };

  Portal.navigation = api;
  // Mark the direct-load entry without changing its URL. Versioned scope
  // depths let a modal close jump over all nested entries created inside it.
  if (root.history.state?.fmNavigation?.version !== 2) {
    const initialRoute = read();
    try { root.history.replaceState(navigationState('replaceState', [], { source: 'initial' }, initialRoute, initialRoute), '', currentHref()); } catch (_) {}
  }
  if (!root.__FM_NAVIGATION_POPSTATE_BOUND) {
    root.__FM_NAVIGATION_POPSTATE_BOUND = true;
    root.addEventListener('popstate', () => applyCurrent({ source: 'popstate', force: true }));
  }
})(window);
