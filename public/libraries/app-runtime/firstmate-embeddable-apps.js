/* public/libraries/app-runtime/firstmate-embeddable-apps.js
 * Runtime for registering, discovering, mounting, and extending reusable
 * FirstMate embeddable apps.
 */
(function(){
  const root = window;
  const apps = new Map();
  const manifests = new Map();
  const extensions = new Map();
  const stores = new Map();
  const mounted = new WeakMap();
  const loadedBundles = new Set();
  let instanceCounter = 0;

  const noop = () => {};
  const cleanText = (value) => String(value ?? '').trim();
  const clone = (value) => {
    if (value == null || typeof value !== 'object') return value;
    try {
      if (typeof structuredClone === 'function') return structuredClone(value);
    } catch (_) {}
    try { return JSON.parse(JSON.stringify(value)); } catch (_) { return Array.isArray(value) ? value.slice() : { ...value }; }
  };
  const escapeHtml = (value) => cleanText(value).replace(/[&<>"']/g, (match) => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;'
  }[match]));

  function stableSort(items = []){
    return [...items].sort((a, b) => {
      const order = (Number(a.order) || 1000) - (Number(b.order) || 1000);
      if (order) return order;
      return cleanText(a.id).localeCompare(cleanText(b.id));
    });
  }

  function dispatch(name, detail = {}){
    try { root.dispatchEvent(new CustomEvent(name, { detail })); } catch (_) {}
  }

  function currentOrgId(){
    return cleanText(root.__APP?.userOrgId || root.__APP?.orgId);
  }

  function currentBranchId(){
    return cleanText(root.Portal?.branchModules?.currentBranchId?.() || root.__APP?.userBranchId || root.__APP?.branchId || 'default') || 'default';
  }

  function normalizeRoots(target){
    if (!target) return {};
    if (target.nodeType === 1) return { main: target };
    return {
      main: target.main || target.mainRoot || target.root || null,
      left: target.left || target.leftRoot || null,
      toolbar: target.toolbar || target.toolbarRoot || null,
      overlay: target.overlay || target.overlayRoot || null,
      status: target.status || target.statusRoot || null
    };
  }

  function contextKey(options = {}){
    const entityType = cleanText(options.entityType || (options.project || options.projectId ? 'project' : (options.customer || options.customerId ? 'customer' : 'standalone')));
    const entityId = cleanText(options.entityId || options.projectId || options.project?.id || options.customerId || options.customer?.id || options.id || 'default');
    return [
      cleanText(options.orgId || currentOrgId()),
      cleanText(options.branchId || currentBranchId()),
      entityType,
      entityId,
      cleanText(options.scope || options.storeScope || '')
    ].join('::');
  }

  function createStore(options = {}){
    const key = cleanText(options.key) || contextKey(options);
    if (stores.has(key)) return stores.get(key);
    const normalize = typeof options.normalize === 'function' ? options.normalize : ((value) => value && typeof value === 'object' ? value : {});
    let loaded = false;
    let loadingPromise = null;
    let persisted = normalize(options.initial || {});
    let draft = clone(persisted);
    let dirty = false;
    const listeners = new Set();

    const snapshot = () => clone(draft);
    const notify = (meta = {}) => {
      const current = snapshot();
      listeners.forEach((listener) => {
        try { listener(current, meta); } catch (error) { console.warn('Embeddable app store listener failed', error); }
      });
      dispatch('fm:embeddable-apps:context-updated', {
        key,
        appId: options.appId || '',
        entityType: options.entityType || '',
        entityId: options.entityId || options.projectId || options.customerId || '',
        value: current,
        meta
      });
    };

    const load = async ({ force = false } = {}) => {
      if (loaded && !force) return snapshot();
      if (loadingPromise && !force) return loadingPromise;
      loadingPromise = (async () => {
        if (typeof options.load === 'function') {
          persisted = normalize(await options.load({ force, store }));
        }
        loaded = true;
        if (!dirty) draft = clone(persisted);
        notify({ type: 'load', source: options.source || 'embeddable_apps' });
        return snapshot();
      })();
      try { return await loadingPromise; }
      finally { loadingPromise = null; }
    };

    const setDraft = (next, meta = {}) => {
      draft = normalize(next);
      dirty = true;
      notify({ type: 'draft', ...meta });
      return snapshot();
    };
    const patchDraft = (updater, meta = {}) => {
      const base = snapshot();
      const next = typeof updater === 'function' ? updater(base) : { ...base, ...(updater || {}) };
      return setDraft(next, meta);
    };
    const save = async (next = draft, meta = {}) => {
      const normalized = normalize(next);
      if (typeof options.save === 'function') await options.save(normalized, { ...meta, store });
      persisted = clone(normalized);
      draft = clone(normalized);
      dirty = false;
      loaded = true;
      notify({ type: 'save', ...meta });
      return snapshot();
    };
    const subscribe = (listener) => {
      if (typeof listener !== 'function') return noop;
      listeners.add(listener);
      return () => listeners.delete(listener);
    };

    const store = {
      key,
      load,
      get: snapshot,
      setDraft,
      patchDraft,
      patch: patchDraft,
      save,
      refresh: (meta = {}) => load({ force: true }).then((value) => { notify({ type: 'refresh', ...meta }); return value; }),
      subscribe
    };
    stores.set(key, store);
    return store;
  }

  function createContext(options = {}, app = null, target = null){
    const roots = { ...(options.roots || {}), ...normalizeRoots(target || options.target || options.root) };
    const entity = options.entity || options.project || options.customer || null;
    const entityType = cleanText(options.entityType || (options.project || options.projectId ? 'project' : (options.customer || options.customerId ? 'customer' : (entity ? 'entity' : 'standalone'))));
    const entityId = cleanText(options.entityId || options.projectId || options.project?.id || options.customerId || options.customer?.id || entity?.id || '');
    const host = options.host || createHostBridge(options);
    const project = options.project || (entityType === 'project' ? entity : null);
    const customer = options.customer || (entityType === 'customer' ? entity : null);
    const context = {
      ...options,
      app,
      appId: app?.id || options.appId || '',
      instanceId: options.instanceId || `embeddable_app_${++instanceCounter}`,
      surface: options.surface || 'embedded',
      source: options.source || 'embeddable_apps',
      chrome: options.chrome || 'embedded',
      active: options.active !== false,
      roots,
      root: options.root || roots.main || null,
      panelRoot: options.panelRoot || roots.main || null,
      mainRoot: options.mainRoot || roots.main || null,
      leftRoot: options.leftRoot || roots.left || null,
      toolbarRoot: options.toolbarRoot || roots.toolbar || null,
      overlayRoot: options.overlayRoot || roots.overlay || null,
      statusRoot: options.statusRoot || roots.status || null,
      previewRoot: options.previewRoot || options.panelRoot || roots.main || null,
      entity,
      entityType,
      entityId,
      project,
      activeProject: options.activeProject || project,
      projectId: cleanText(options.projectId || (entityType === 'project' ? entityId : '')),
      customer,
      customerId: cleanText(options.customerId || (entityType === 'customer' ? entityId : '')),
      orgId: cleanText(options.orgId || currentOrgId()),
      branchId: cleanText(options.branchId || currentBranchId()),
      route: options.route || {},
      params: options.params || {},
      activeTab: options.activeTab || options.route?.tab || '',
      model: options.model || options.projectModel || null,
      projectModel: options.projectModel || options.model || null,
      mode: options.mode || '',
      vertical: options.vertical || '',
      capabilities: options.capabilities || root.Portal?.capabilities || {},
      featureFlags: options.featureFlags || root.Portal?.appFlags?.current?.() || {},
      flags: options.flags || root.Portal?.appFlags || null,
      permissions: options.permissions || root.Portal?.permissions || {},
      host,
      projectWorkspace: options.projectWorkspace || host?.projectWorkspace || host,
      store: options.store || createStore({ ...options, appId: app?.id || options.appId || '' }),
      events: options.events || root,
      services: options.services || {},
      ui: options.ui || root.Portal?.ui || {},
      util: {
        clone,
        escapeHtml,
        cleanText,
        ...(root.Portal?.util || {}),
        ...(options.util || {})
      },
      extensions: []
    };
    context.extensions = getExtensionsFor(app?.id || options.appId || '', context);
    return context;
  }

  function createProjectContext(options = {}){
    const project = options.project || null;
    return createContext({
      ...options,
      entity: options.entity || project,
      entityType: 'project',
      entityId: options.entityId || options.projectId || project?.id || '',
      project,
      projectId: options.projectId || project?.id || ''
    });
  }

  function createHostBridge(options = {}){
    return {
      surface: options.surface || '',
      setActiveApp(appId, params){ options.onSetActiveApp?.(appId, params); },
      setRoute(routePatch){ options.onSetRoute?.(routePatch); root.Portal?.routeState?.set?.(routePatch); },
      close(reason){ options.onClose?.(reason); },
      requestSave(reason){ return options.onRequestSave?.(reason); },
      autosaveSoon(reason){ return options.onAutosaveSoon?.(reason); },
      showDefaultLeft(){ options.onShowDefaultLeft?.(); },
      hideDefaultLeft(){ options.onHideDefaultLeft?.(); },
      setLeftMode(mode){ options.onSetLeftMode?.(mode); },
      setToolbar(items){ options.onSetToolbar?.(items || []); },
      setTitle(title, subtitle){ options.onSetTitle?.(title, subtitle); },
      showToast(title, message, ok){ return (options.showToast || root.Portal?.ui?.showToast || noop)(title, message, ok); },
      openOverlay(definition){ return options.onOpenOverlay?.(definition); },
      closeOverlay(id){ return options.onCloseOverlay?.(id); }
    };
  }

  function normalizeDependencyList(value){
    return Array.isArray(value) ? value.map(cleanText).filter(Boolean) : [];
  }

  function normalizeBundleList(definition = {}){
    const bundles = Array.isArray(definition.bundles) ? definition.bundles : [];
    return [...(definition.bundle ? [definition.bundle] : []), ...bundles]
      .map(cleanText)
      .filter(Boolean);
  }

  function normalizeApp(definition = {}){
    const id = cleanText(definition.id);
    if (!id) throw new Error('Embeddable app registration requires an id.');
    return {
      ...definition,
      id,
      title: cleanText(definition.title || definition.label || id),
      label: cleanText(definition.label || definition.title || id),
      surfaces: Array.isArray(definition.surfaces) ? definition.surfaces : ['embedded'],
      regions: Array.isArray(definition.regions) ? definition.regions : ['main'],
      dependencies: normalizeDependencyList(definition.dependencies),
      optionalDependencies: normalizeDependencyList(definition.optionalDependencies),
      order: Number.isFinite(definition.order) ? definition.order : 1000
    };
  }

  function registerApp(definition = {}){
    const app = normalizeApp(definition);
    const previous = apps.get(app.id) || {};
    const manifest = manifests.get(app.id) || {};
    const merged = {
      ...previous,
      ...app,
      dependencies: app.dependencies.length ? app.dependencies : normalizeDependencyList(previous.dependencies || manifest.dependencies),
      optionalDependencies: app.optionalDependencies.length ? app.optionalDependencies : normalizeDependencyList(previous.optionalDependencies || manifest.optionalDependencies)
    };
    apps.set(app.id, merged);
    dispatch('fm:embeddable-apps:app-registered', { appId: app.id, app: merged });
    return merged;
  }

  function unregisterApp(id){
    const appId = cleanText(id);
    if (!appId || !apps.has(appId)) return false;
    apps.delete(appId);
    dispatch('fm:embeddable-apps:app-unregistered', { appId });
    return true;
  }

  function getApp(id){
    return apps.get(cleanText(id)) || null;
  }

  function registerManifest(manifest = {}){
    const id = cleanText(manifest.id);
    if (!id) throw new Error('Embeddable app manifest requires an id.');
    manifests.set(id, {
      ...manifest,
      id,
      bundles: normalizeBundleList(manifest),
      dependencies: normalizeDependencyList(manifest.dependencies),
      optionalDependencies: normalizeDependencyList(manifest.optionalDependencies)
    });
    return manifests.get(id);
  }

  function registerExtension(definition = {}){
    const id = cleanText(definition.id);
    if (!id) throw new Error('Embeddable app extension requires an id.');
    const extension = {
      ...definition,
      id,
      targets: Array.isArray(definition.targets) ? definition.targets.map(cleanText).filter(Boolean) : [],
      dependencies: Array.isArray(definition.dependencies) ? definition.dependencies.map(cleanText).filter(Boolean) : [],
      order: Number.isFinite(definition.order) ? definition.order : 1000,
      hooks: definition.hooks && typeof definition.hooks === 'object' ? definition.hooks : {}
    };
    extensions.set(id, extension);
    dispatch('fm:embeddable-apps:extension-registered', { extensionId: id, extension });
    return extension;
  }

  function contextAllowed(definition = {}, context = {}){
    if (!definition) return false;
    const surface = context.surface || '';
    if (Array.isArray(definition.surfaces) && definition.surfaces.length && surface && !definition.surfaces.includes(surface)) return false;
    const required = Array.isArray(definition.requiresContext) ? definition.requiresContext : [];
    const hasRequired = required.every((item) => {
      const key = cleanText(item);
      if (key === 'project') return !!(context.project || context.projectId || context.entityType === 'project');
      if (key === 'customer') return !!(context.customer || context.customerId || context.entityType === 'customer');
      if (key === 'org') return !!context.orgId;
      if (key === 'branch') return !!context.branchId;
      return !!context[key];
    });
    if (!hasRequired) return false;
    if (typeof definition.enabled === 'function' && !definition.enabled(context)) return false;
    if (definition.enabled === false) return false;
    return true;
  }

  function metadataFor(app, context){
    const visible = typeof app.visible === 'function' ? app.visible(context) : app.visible !== false;
    const disabled = typeof app.disabled === 'function' ? app.disabled(context) : !!app.disabled;
    const pending = typeof app.pending === 'function' ? app.pending(context) : !!app.pending;
    const badge = typeof app.badge === 'function' ? app.badge(context) : app.badge;
    return {
      id: app.id,
      title: app.title || app.label || app.id,
      label: app.label || app.title || app.id,
      icon: app.icon || '',
      order: app.order,
      enabled: contextAllowed(app, context),
      visible,
      disabled,
      pending,
      badge,
      regions: app.regions || ['main'],
      surfaces: app.surfaces || ['embedded'],
      app
    };
  }

  function listApps(filter = {}){
    const context = createContext(filter);
    return stableSort([...apps.values()]
      .map((app) => metadataFor(app, context))
      .filter((meta) => meta.enabled && meta.visible !== false));
  }

  function extensionDependenciesMet(extension){
    return (extension.dependencies || []).every((id) => extensions.has(id) || apps.has(id));
  }

  function getExtensionsFor(appId, context = {}){
    const id = cleanText(appId);
    return stableSort([...extensions.values()].filter((extension) => {
      if (extension.targets.length && !extension.targets.includes(id)) return false;
      if (!extensionDependenciesMet(extension)) return false;
      if (!contextAllowed(extension, context)) return false;
      return true;
    }));
  }

  function runHook(appId, hookName, payload, context = {}){
    return getExtensionsFor(appId, context).reduce((current, extension) => {
      const hook = extension.hooks?.[hookName];
      if (typeof hook !== 'function') return current;
      try {
        const next = hook(current, { ...context, extension });
        return next === undefined ? current : next;
      } catch (error) {
        console.warn(`Embeddable app extension hook failed: ${extension.id}.${hookName}`, error);
        dispatch('fm:embeddable-apps:extension-error', { appId, extensionId: extension.id, hookName, error });
        return current;
      }
    }, payload);
  }

  function scriptAlreadyPresent(src){
    if (!src) return false;
    try {
      const absolute = new URL(src, document.baseURI).href;
      return Array.from(document.querySelectorAll('script[src]')).some((script) => {
        try { return new URL(script.src, document.baseURI).href === absolute; }
        catch (_) { return script.src === src; }
      });
    } catch (_) {
      return !!document.querySelector(`script[src="${CSS.escape(src)}"]`);
    }
  }

  async function ensureBundle(src){
    const bundle = cleanText(src);
    if (!bundle || loadedBundles.has(bundle)) return true;
    if (scriptAlreadyPresent(bundle)) {
      loadedBundles.add(bundle);
      return true;
    }
    await new Promise((resolve, reject) => {
      const existing = document.querySelector(`script[data-embeddable-app-bundle="${CSS.escape(bundle)}"]`);
      if (existing) {
        existing.addEventListener('load', resolve, { once: true });
        existing.addEventListener('error', reject, { once: true });
        return;
      }
      const script = document.createElement('script');
      script.src = bundle;
      script.async = false;
      script.dataset.embeddableAppBundle = bundle;
      script.onload = resolve;
      script.onerror = reject;
      document.head.appendChild(script);
    });
    loadedBundles.add(bundle);
    return true;
  }

  async function ensureBundles(definition = {}){
    const bundles = normalizeBundleList(definition);
    for (const bundle of bundles) await ensureBundle(bundle);
    return true;
  }

  async function ensureAppReady(appId, seen = new Set()){
    const id = cleanText(appId);
    if (!id || seen.has(id)) return apps.get(id) || null;
    seen.add(id);
    const manifest = manifests.get(id);
    let app = apps.get(id) || null;
    const dependencies = [
      ...normalizeDependencyList(manifest?.dependencies),
      ...normalizeDependencyList(app?.dependencies)
    ].filter((dep, index, list) => list.indexOf(dep) === index);
    for (const dependencyId of dependencies) await ensureAppReady(dependencyId, seen);
    if (manifest && (!app || (!app.mount && !app.render))) {
      await ensureBundles(manifest);
      app = apps.get(id) || app;
    }
    return app;
  }

  async function mount(target, appId, options = {}){
    const id = cleanText(appId);
    const roots = normalizeRoots(target);
    const rootEl = roots.main || target;
    if (!rootEl) throw new Error(`Embeddable app "${id}" mount requires a root.`);
    const previous = mounted.get(rootEl);
    if (previous?.destroy) {
      try { previous.destroy(); } catch (error) { console.warn('Embeddable app destroy failed', error); }
    }
    const manifest = manifests.get(id);
    const app = await ensureAppReady(id) || apps.get(id);
    if (!app) {
      rootEl.innerHTML = `<div class="fm-app-unavailable">App "${escapeHtml(id)}" is unavailable.</div>`;
      const missing = { appId: id, destroy(){ rootEl.innerHTML = ''; } };
      mounted.set(rootEl, missing);
      return missing;
    }
    const context = createContext({ ...options, appId: id, roots: { ...roots, ...(options.roots || {}) } }, app, roots);
    const handle = (typeof app.mount === 'function'
      ? app.mount(context)
      : (typeof app.render === 'function' ? app.render(context) : null)) || {};
    const destroySource = typeof handle.destroy === 'function'
      ? handle.destroy
      : (typeof handle.unmount === 'function' ? handle.unmount : noop);
    const setActiveSource = typeof handle.setActive === 'function'
      ? handle.setActive
      : ((active) => {
        if (active && typeof handle.activate === 'function') return handle.activate(context);
        if (!active && typeof handle.deactivate === 'function') return handle.deactivate(context);
        return undefined;
      });
    const updateSource = typeof handle.update === 'function'
      ? handle.update
      : ((nextContext = {}) => {
        if (typeof handle.render === 'function') return handle.render({ ...context, ...nextContext });
        return undefined;
      });
    const beforeLeaveSource = typeof handle.beforeLeave === 'function' ? handle.beforeLeave : noop;
    const destroy = destroySource.bind(handle);
    const wrapped = {
      ...handle,
      appId: id,
      context,
      setActive: setActiveSource.bind(handle),
      update: updateSource.bind(handle),
      beforeLeave: beforeLeaveSource.bind(handle),
      destroy(){
        try { destroy(); }
        finally {
          if (mounted.get(rootEl) === wrapped) mounted.delete(rootEl);
          dispatch('fm:embeddable-apps:app-destroyed', { appId: id, context });
        }
      }
    };
    mounted.set(rootEl, wrapped);
    dispatch('fm:embeddable-apps:app-mounted', { appId: id, context });
    return wrapped;
  }

  function unmount(target){
    const roots = normalizeRoots(target);
    const rootEl = roots.main || target;
    const handle = rootEl ? mounted.get(rootEl) : null;
    if (handle?.destroy) handle.destroy();
  }

  function createAppInstance(context, lifecycle = {}){
    let destroyed = false;
    lifecycle.render?.(context);
    return {
      context,
      setActive(active){ if (!destroyed) lifecycle.setActive?.(active, context); },
      update(nextContext = {}) {
        if (destroyed) return;
        Object.assign(context, nextContext);
        lifecycle.update?.(context);
      },
      beforeLeave(nextAppId){ return destroyed ? undefined : lifecycle.beforeLeave?.(nextAppId, context); },
      destroy(){
        if (destroyed) return;
        destroyed = true;
        lifecycle.destroy?.(context);
      }
    };
  }

  function diagnostics(filter = {}){
    const context = createContext(filter);
    return {
      apps: stableSort([...apps.values()]).map((app) => metadataFor(app, context)),
      manifests: stableSort([...manifests.values()]),
      extensions: stableSort([...extensions.values()]).map((extension) => ({
        id: extension.id,
        targets: extension.targets,
        dependencies: extension.dependencies,
        enabled: contextAllowed(extension, context),
        missingDependencies: (extension.dependencies || []).filter((id) => !extensions.has(id) && !apps.has(id))
      })),
      stores: [...stores.keys()],
      loadedBundles: [...loadedBundles]
    };
  }

  root.FirstMateEmbeddableApps = {
    registerApp,
    unregisterApp,
    getApp,
    listApps,
    registerManifest,
    registerExtension,
    getExtensionsFor,
    runHook,
    mount,
    unmount,
    createContext,
    createProjectContext,
    createStore,
    createHostBridge,
    createAppInstance,
    diagnostics,
    escapeHtml,
    clone
  };
})();
