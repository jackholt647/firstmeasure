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

  const objectValue = (value) => value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  const arrayValue = (value) => Array.isArray(value) ? value : (value == null || value === '' ? [] : [value]);
  const uniqueText = (value) => [...new Set(arrayValue(value).map((item) => cleanText(item?.id || item)).filter(Boolean))];
  const mergeObjects = (...values) => values.reduce((result, value) => ({ ...result, ...objectValue(value) }), {});

  function normalizedDevice(value = {}){
    const explicit = objectValue(value);
    const width = Number(explicit.width || root.innerWidth || root.document?.documentElement?.clientWidth || 0) || 0;
    const mobile = explicit.mobile == null
      ? !!root.matchMedia?.('(max-width: 820px)')?.matches
      : explicit.mobile === true;
    const coarse = explicit.coarse == null
      ? !!root.matchMedia?.('(pointer: coarse)')?.matches
      : explicit.coarse === true;
    const standalone = explicit.standalone == null
      ? !!root.matchMedia?.('(display-mode: standalone)')?.matches
      : explicit.standalone === true;
    const type = cleanText(explicit.type || explicit.class || explicit.deviceClass) || (mobile ? 'mobile' : 'desktop');
    return {
      ...explicit,
      type,
      class: type,
      width,
      mobile,
      desktop: !mobile,
      coarse,
      standalone
    };
  }

  function normalizedApplicationAccess(value = {}){
    const source = objectValue(value);
    const entry = (input, fallback = false) => {
      if (typeof input === 'boolean') return { enabled: input, role_id: '', permissions: {} };
      const record = objectValue(input);
      return {
        ...record,
        enabled: record.enabled == null ? fallback : record.enabled === true,
        role_id: cleanText(record.role_id || record.role),
        permissions: objectValue(record.permissions || record.items)
      };
    };
    return {
      ...source,
      management: entry(source.management ?? source.main ?? source.portal, true),
      field: entry(source.field ?? source.crew ?? source.workforce, false)
    };
  }

  function canonicalApplicationId(value){
    const id = cleanText(value).toLowerCase();
    if (['main', 'portal'].includes(id)) return 'management';
    if (['crew', 'workforce'].includes(id)) return 'field';
    return id;
  }

  function entitlementContainers(value = {}){
    const source = objectValue(value);
    const tabs = objectValue(source.tabs);
    return [
      source,
      objectValue(source.apps),
      objectValue(source.items),
      objectValue(source.app_access),
      objectValue(source.app_entitlements),
      tabs,
      objectValue(source.portal),
      objectValue(source.project),
      objectValue(tabs.global),
      objectValue(tabs.portal),
      objectValue(tabs.project)
    ];
  }

  function entitlementFor(definition = {}, context = {}, access = {}){
    const source = context.entitlements;
    if (!source) return { found: false, key: '', value: null };
    const keys = uniqueText([
      access.entitlementKey,
      access.entitlement_key,
      access.appKey,
      access.app_key,
      definition.entitlementKey,
      definition.appKey,
      definition.id,
      definition.portalTabId,
      definition.tabId
    ]);
    for (const container of entitlementContainers(source)) {
      for (const key of keys) {
        if (Object.prototype.hasOwnProperty.call(container, key)) return { found: true, key, value: container[key] };
      }
    }
    const entries = Array.isArray(source)
      ? source
      : (Array.isArray(source?.entries) ? source.entries : (Array.isArray(source?.apps) ? source.apps : []));
    for (const entry of entries) {
      const id = cleanText(entry?.id || entry?.app_id || entry?.appId || entry?.key);
      if (id && keys.includes(id)) return { found: true, key: id, value: entry };
    }
    return { found: false, key: keys[0] || definition.id || '', value: null };
  }

  function permissionEnabled(permissions, key){
    const items = objectValue(permissions);
    return cleanText(key).split('|').map((item) => item.trim()).filter(Boolean).some((item) => (
      items[item] === true || (items[item] !== false && items['*'] === true)
    ));
  }

  function flagValue(context, requirement){
    if (typeof requirement === 'string') {
      const [group, flag] = requirement.includes('.') ? requirement.split('.', 2) : ['', requirement];
      requirement = { group, flag };
    }
    const rule = objectValue(requirement);
    const group = cleanText(rule.group);
    const flag = cleanText(rule.flag || rule.key);
    if (!flag) return true;
    const flags = context.flags || root.Portal?.appFlags || root.PlatformAPI?.appFlags;
    if (flags?.current?.()) {
      if (flags.has?.(group, flag)) return true;
      const value = flags.value?.(group, flag, undefined);
      if (value !== undefined) return value !== false && value !== 0 && value !== '0' && value !== 'false';
    }
    const featureFlags = objectValue(context.featureFlags);
    const value = group ? objectValue(featureFlags[group])[flag] : featureFlags[flag];
    if (value === undefined) return rule.default === true || rule.fallback === true;
    return value !== false && value !== 0 && value !== '0' && value !== 'false';
  }

  function resolvePresentation(definition = {}, context = {}, entitlement = null){
    const source = typeof definition.presentation === 'function'
      ? definition.presentation(context)
      : definition.presentation;
    const base = objectValue(source);
    const deviceType = context.device?.mobile ? 'mobile' : 'desktop';
    const deviceOverrides = objectValue(base.byDevice || base.devices);
    const resolved = mergeObjects(
      objectValue(base.default),
      base,
      objectValue(deviceOverrides[deviceType]),
      objectValue(base[deviceType])
    );
    delete resolved.default;
    delete resolved.byDevice;
    delete resolved.devices;
    const entitlementRecord = objectValue(entitlement);
    const entitlementPresentation = objectValue(entitlementRecord.presentation);
    const merged = mergeObjects(resolved, entitlementPresentation);
    const projectModal = mergeObjects(
      resolved.projectModal || resolved.project_modal,
      entitlementPresentation.projectModal || entitlementPresentation.project_modal
    );
    if (Object.keys(projectModal).length) merged.projectModal = projectModal;
    return merged;
  }

  function defaultHomeValue(definition = {}, presentation = {}, entitlement = null, context = {}){
    const entitlementRecord = objectValue(entitlement);
    let value = entitlementRecord.defaultHome ?? entitlementRecord.default_home ?? entitlementRecord.home;
    if (value == null) value = presentation.defaultHome ?? presentation.default_home;
    if (value == null) value = definition.defaultHome ?? definition.default_home;
    if (typeof value === 'function') value = value(context);
    if (typeof value === 'boolean') return value;
    const candidates = uniqueText(value);
    if (!candidates.length) {
      const defaults = uniqueText(presentation.defaultFor || presentation.default_for);
      if (!defaults.length) return false;
      return defaults.some((item) => {
        const appId = canonicalApplicationId(item);
        return context.applicationAccess?.[appId]?.enabled === true
          || context.device?.type === item
          || context.roleIds?.includes(item);
      });
    }
    return candidates.some((item) => {
      const appId = canonicalApplicationId(item);
      return context.applicationAccess?.[appId]?.enabled === true
        || context.device?.type === item
        || context.roleIds?.includes(item);
    });
  }

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
    const portalCurrentUser = objectValue(root.Portal?.currentUser);
    const currentUser = mergeObjects(portalCurrentUser, options.currentUser);
    const user = options.user || currentUser.user || currentUser;
    const accessProfile = options.accessProfile || options.access_profile || currentUser.accessProfile || currentUser.access_profile || user?.access_profile || {};
    const applicationAccess = normalizedApplicationAccess(
      options.applicationAccess
      ?? options.application_access
      ?? currentUser.applicationAccess
      ?? currentUser.application_access
      ?? user?.application_access
    );
    const permissions = options.permissions
      ?? currentUser.permissions
      ?? user?.permissions
      ?? user?.org_permissions?.items
      ?? root.Portal?.permissions
      ?? {};
    const roleIds = uniqueText([
      ...arrayValue(options.roleIds || options.role_ids),
      ...arrayValue(currentUser.roleIds || currentUser.role_ids),
      ...arrayValue(accessProfile.access_role_ids || accessProfile.role_ids),
      ...arrayValue(user?.roles || user?.role_ids),
      currentUser.role,
      user?.role,
      user?.org_permissions?.level
    ]);
    const entitlements = options.entitlements
      ?? options.appEntitlements
      ?? currentUser.entitlements
      ?? currentUser.appEntitlements
      ?? currentUser.app_entitlements
      ?? accessProfile.app_entitlements
      ?? accessProfile.entitlements
      ?? user?.entitlements
      ?? user?.app_entitlements
      ?? user?.app_access
      ?? {};
    const device = normalizedDevice(options.device || {});
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
      language: options.language || root.PlatformLanguage?.forApp?.(app?.package || app?.id?.split(".")[1] || "platform"),
      featureFlags: options.featureFlags || root.Portal?.appFlags?.current?.() || {},
      flags: options.flags || root.Portal?.appFlags || null,
      currentUser,
      user,
      accessProfile,
      actor: options.actor || currentUser.actor || user,
      userId: cleanText(options.userId || currentUser.id || currentUser.user_id || user?.id),
      roleIds,
      roles: roleIds,
      applicationAccess,
      entitlements,
      appEntitlements: entitlements,
      permissions,
      device,
      deviceClass: device.type,
      isMobile: device.mobile,
      isDesktop: device.desktop,
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
      setRoute(routePatch, routeOptions = {}){
        if (typeof options.onSetRoute === 'function') return options.onSetRoute(routePatch, routeOptions);
        return root.Portal?.navigation?.write?.(routePatch, routeOptions) || root.Portal?.routeState?.set?.(routePatch, routeOptions);
      },
      pushRoute(routePatch, routeOptions = {}){
        return root.Portal?.navigation?.push?.(routePatch, routeOptions) || root.Portal?.routeState?.set?.(routePatch, { ...routeOptions, push:true });
      },
      replaceRoute(routePatch, routeOptions = {}){
        return root.Portal?.navigation?.replace?.(routePatch, routeOptions) || root.Portal?.routeState?.set?.(routePatch, routeOptions);
      },
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
      ...manifest,
      ...previous,
      ...app,
      order: Number.isFinite(definition.order)
        ? app.order
        : (Number.isFinite(previous.order) ? previous.order : (Number.isFinite(manifest.order) ? manifest.order : app.order)),
      surfaces: Array.isArray(definition.surfaces)
        ? app.surfaces
        : (Array.isArray(previous.surfaces) ? previous.surfaces : (Array.isArray(manifest.surfaces) ? manifest.surfaces : app.surfaces)),
      regions: Array.isArray(definition.regions)
        ? app.regions
        : (Array.isArray(previous.regions) ? previous.regions : (Array.isArray(manifest.regions) ? manifest.regions : app.regions)),
      dependencies: app.dependencies.length ? app.dependencies : normalizeDependencyList(previous.dependencies || manifest.dependencies),
      optionalDependencies: app.optionalDependencies.length ? app.optionalDependencies : normalizeDependencyList(previous.optionalDependencies || manifest.optionalDependencies)
    };
    apps.set(app.id, merged);
    root.Portal?.navigation?.registerApp?.(merged);
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
      languageNamespaces: manifest.languageNamespaces || [manifest.package || id.split(".")[1] || "platform"],
      bundles: normalizeBundleList(manifest),
      dependencies: normalizeDependencyList(manifest.dependencies),
      optionalDependencies: normalizeDependencyList(manifest.optionalDependencies)
    });
    root.Portal?.navigation?.registerApp?.(manifest);
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

  let capabilityAppIndex = null;
  let capabilityAppIndexStamp = '';
  /**
   * Org-level capability gate for embeddable apps. Registry-driven: any
   * capability node whose runtime_app_id matches this app id gates it; apps
   * may also name a capability key explicitly via access.capability. Apps
   * with no matching capability node are unaffected.
   */
  function capabilityAllowsApp(definition = {}, access = {}){
    const capabilitiesApi = root.Portal?.capabilities || root.PlatformAPI?.capabilities;
    const state = capabilitiesApi?.current?.();
    // App bundles re-register their definitions and may drop the manifest's
    // access object, so the manifest registry is checked too — it keeps the
    // capability tag assigned at manifest load.
    const manifestAccess = objectValue(manifests.get(cleanText(definition.id))?.access);
    const explicit = cleanText(access.capability || access.capability_key || definition.capability || manifestAccess.capability);
    // Capability-gated apps fail closed during startup. Until the org's
    // capability state resolves, rendering or mounting one would briefly show
    // disabled products and may run lifecycle work that should never start.
    // Ungated shell apps remain available while capability state is loading.
    if (!state?.definitions_by_key) return !explicit;
    if (explicit) return state.effective_by_key?.[explicit] === true;
    const stamp = cleanText(state.loaded_at) + ':' + cleanText(state.org_id);
    if (!capabilityAppIndex || capabilityAppIndexStamp !== stamp) {
      capabilityAppIndex = {};
      (state.definitions || []).forEach((node) => {
        const runtimeId = cleanText(node?.runtime_app_id);
        if (runtimeId) capabilityAppIndex[runtimeId] = node.key;
      });
      capabilityAppIndexStamp = stamp;
    }
    const key = capabilityAppIndex[cleanText(definition.id)];
    if (!key) return true;
    return state.effective_by_key?.[key] === true;
  }

  function evaluateDefinition(definition = {}, context = {}){
    const reasons = [];
    const rawAccess = typeof definition.access === 'function' ? definition.access(context) : definition.access;
    if (rawAccess === false) reasons.push('access_policy');
    const access = objectValue(rawAccess);
    const entitlement = entitlementFor(definition, context, access);
    const entitlementValue = entitlement.value;
    const entitlementRecord = objectValue(entitlementValue);
    const entitlementState = cleanText(entitlementRecord.state || entitlementRecord.access || entitlementRecord.visibility).toLowerCase();

    const surface = cleanText(context.surface);
    if (Array.isArray(definition.surfaces) && definition.surfaces.length && surface && !definition.surfaces.includes(surface)) reasons.push('surface');

    const required = Array.isArray(definition.requiresContext) ? definition.requiresContext : [];
    const missingContext = required.filter((item) => {
      const key = cleanText(item);
      if (key === 'project') return !(context.project || context.projectId || context.entityType === 'project');
      if (key === 'customer') return !(context.customer || context.customerId || context.entityType === 'customer');
      if (key === 'org') return !context.orgId;
      if (key === 'branch') return !context.branchId;
      return !context[key];
    });
    if (missingContext.length) reasons.push(`context:${missingContext.join(',')}`);

    if (entitlement.found) {
      if (entitlementValue === false) reasons.push('entitlement');
      if (typeof entitlementValue === 'string' && ['deny', 'denied', 'hide', 'hidden', 'disabled', 'off', 'none'].includes(entitlementValue.toLowerCase())) reasons.push('entitlement');
      if (
        entitlementRecord.enabled === false
        || entitlementRecord.allowed === false
        || entitlementRecord.visible === false
        || entitlementRecord.injected === false
        || ['deny', 'denied', 'hide', 'hidden', 'disabled', 'off', 'none'].includes(entitlementState)
      ) reasons.push('entitlement');
    } else if (access.default === false || access.defaultVisible === false || access.default_visible === false || access.requireEntitlement === true || access.require_entitlement === true) {
      reasons.push('entitlement_missing');
    }

    const applicationsAny = uniqueText(access.applicationsAny || access.applications_any || access.applications || access.application);
    const applicationsAll = uniqueText(access.applicationsAll || access.applications_all);
    const applicationEnabled = (id) => context.applicationAccess?.[canonicalApplicationId(id)]?.enabled === true;
    if (applicationsAny.length && !applicationsAny.some(applicationEnabled)) reasons.push('application');
    if (applicationsAll.length && !applicationsAll.every(applicationEnabled)) reasons.push('application');

    const permissionsAny = uniqueText(access.permissionsAny || access.permissions_any);
    const permissionsAll = uniqueText(access.permissionsAll || access.permissions_all || access.permissions || access.permission);
    const hasPermission = (key) => permissionEnabled(context.permissions, key)
      || Object.values(objectValue(context.applicationAccess)).some((entry) => entry?.enabled === true && permissionEnabled(entry.permissions, key));
    if (permissionsAny.length && !permissionsAny.some(hasPermission)) reasons.push('permission');
    if (permissionsAll.length && !permissionsAll.every(hasPermission)) reasons.push('permission');

    const rolesAny = uniqueText(access.rolesAny || access.roles_any || access.roles || access.role);
    const rolesAll = uniqueText(access.rolesAll || access.roles_all);
    if (rolesAny.length && !rolesAny.some((id) => context.roleIds?.includes(id))) reasons.push('role');
    if (rolesAll.length && !rolesAll.every((id) => context.roleIds?.includes(id))) reasons.push('role');

    const devices = uniqueText(access.devices || access.device);
    if (devices.length && !devices.includes(context.device?.type)) reasons.push('device');

    const featureFlags = arrayValue(access.featureFlags || access.feature_flags || access.flags);
    const featureFlagsAny = arrayValue(access.featureFlagsAny || access.feature_flags_any || access.flagsAny);
    if (featureFlags.length && !featureFlags.every((rule) => flagValue(context, rule))) reasons.push('feature_flag');
    if (featureFlagsAny.length && !featureFlagsAny.some((rule) => flagValue(context, rule))) reasons.push('feature_flag');

    if (!capabilityAllowsApp(definition, access)) reasons.push('capability');

    if (typeof access.when === 'function' && !access.when(context)) reasons.push('access_condition');
    if (typeof definition.enabled === 'function' && !definition.enabled(context)) reasons.push('enabled');
    if (definition.enabled === false) reasons.push('enabled');

    const presentation = resolvePresentation(definition, context, entitlementValue);
    const definitionParams = typeof definition.params === 'function' ? definition.params(context) : definition.params;
    const params = mergeObjects(definitionParams, presentation.params, entitlementRecord.params);
    const definitionLayout = objectValue(definition.layout);
    const presentationLayout = objectValue(presentation.layout);
    const entitlementLayout = objectValue(entitlementRecord.layout);
    const layout = mergeObjects(definitionLayout, presentationLayout, entitlementLayout);
    const projectModalPresentation = presentation.projectModal || presentation.project_modal;
    const entitlementProjectModal = entitlementRecord.projectModal || entitlementRecord.project_modal;
    const projectModalLayout = mergeObjects(
      definitionLayout.projectModal || definitionLayout.project_modal,
      presentationLayout.projectModal || presentationLayout.project_modal,
      entitlementLayout.projectModal || entitlementLayout.project_modal,
      projectModalPresentation,
      entitlementProjectModal
    );
    if (Object.keys(projectModalLayout).length) {
      layout.projectModal = projectModalLayout;
    }
    const defaultHome = defaultHomeValue(definition, presentation, entitlementValue, context);
    return {
      allowed: reasons.length === 0,
      reasons: [...new Set(reasons)],
      access,
      entitlementKey: entitlement.key,
      entitlement: entitlementValue,
      presentation,
      params,
      layout,
      defaultHome
    };
  }

  function contextAllowed(definition = {}, context = {}){
    return evaluateDefinition(definition, context).allowed;
  }

  function metadataFor(app, context){
    const policy = evaluateDefinition(app, context);
    const resolvedParams = mergeObjects(context.params, policy.params);
    const resolvedLayout = mergeObjects(context.layout, policy.layout);
    const resolvedPresentation = mergeObjects(context.presentation, policy.presentation);
    const policyContext = { ...context, params: resolvedParams, layout: resolvedLayout, presentation: resolvedPresentation, entitlement: policy.entitlement };
    const visible = typeof app.visible === 'function' ? app.visible(policyContext) : app.visible !== false;
    const disabled = typeof app.disabled === 'function' ? app.disabled(context) : !!app.disabled;
    const pending = typeof app.pending === 'function' ? app.pending(context) : !!app.pending;
    const badge = typeof app.badge === 'function' ? app.badge(context) : app.badge;
    return {
      id: app.id,
      title: app.title || app.label || app.id,
      label: app.label || app.title || app.id,
      icon: app.icon || '',
      order: app.order,
      enabled: policy.allowed,
      eligible: policy.allowed,
      visible,
      disabled,
      pending,
      badge,
      reasons: policy.reasons,
      access: policy.access,
      entitlementKey: policy.entitlementKey,
      entitlement: policy.entitlement,
      params: resolvedParams,
      layout: resolvedLayout,
      presentation: resolvedPresentation,
      defaultHome: policy.defaultHome,
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
    const namespaces = bundles.map(bundle => String(bundle).match(/\/libraries\/apps\/([^/]+)/)?.[1]).filter(Boolean);
    await root.PlatformLanguage?.ensure?.(namespaces);
    for (const bundle of bundles) await ensureBundle(bundle);
    return true;
  }

  async function ensureAppReady(appId, seen = new Set()){
    const id = cleanText(appId);
    if (!id || seen.has(id)) return apps.get(id) || null;
    seen.add(id);
    const manifest = manifests.get(id);
    await root.PlatformLanguage?.ensure?.(manifest?.languageNamespaces || [manifest?.package || id.split(".")[1] || "platform"]);
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
      rootEl.innerHTML = `<div class="fm-app-unavailable">${((v0) => globalThis.PlatformLanguage?.htmlText("app-runtime","m_51b27800c625b8",`App "${v0}" is unavailable.`,{v0}) ?? `App "${v0}" is unavailable.`)(escapeHtml(id))}</div>`;
      const missing = { appId: id, destroy(){ rootEl.innerHTML = ''; } };
      mounted.set(rootEl, missing);
      return missing;
    }
    const context = createContext({ ...options, appId: id, roots: { ...roots, ...(options.roots || {}) } }, app, roots);
    const policy = evaluateDefinition(app, context);
    context.params = mergeObjects(context.params, policy.params);
    context.layout = mergeObjects(context.layout, policy.layout);
    context.presentation = mergeObjects(context.presentation, policy.presentation);
    context.entitlement = policy.entitlement;
    context.entitlementKey = policy.entitlementKey;
    context.defaultHome = policy.defaultHome;
    context.accessDecision = policy;
    if (!policy.allowed) {
      rootEl.innerHTML = '';
      const denied = {
        appId: id,
        denied: true,
        reasons: policy.reasons,
        context,
        setActive: noop,
        update: noop,
        beforeLeave: noop,
        destroy(){ if (mounted.get(rootEl) === denied) mounted.delete(rootEl); }
      };
      mounted.set(rootEl, denied);
      dispatch('fm:embeddable-apps:app-denied', { appId: id, context, reasons: policy.reasons });
      return denied;
    }
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

  function evaluateAccess(appOrId, options = {}){
    const app = typeof appOrId === 'string' ? apps.get(cleanText(appOrId)) : appOrId;
    if (!app) return { allowed: false, reasons: ['missing_app'], params: {}, layout: {}, presentation: {}, defaultHome: false };
    const context = createContext(options, app);
    return evaluateDefinition(app, context);
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
    evaluateAccess,
    diagnostics,
    escapeHtml,
    clone
  };

  const mobileQuery = root.matchMedia?.('(max-width: 820px)');
  const notifyDeviceChange = () => {
    const device = normalizedDevice();
    dispatch('fm:device:updated', { device });
    dispatch('fm:app-entitlements:updated', { source: 'device', device });
  };
  mobileQuery?.addEventListener?.('change', notifyDeviceChange);
  if (!mobileQuery?.addEventListener) mobileQuery?.addListener?.(notifyDeviceChange);
})();
