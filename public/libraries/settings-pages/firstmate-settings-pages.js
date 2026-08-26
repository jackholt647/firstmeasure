/* public/libraries/settings-pages/firstmate-settings-pages.js
 * Reusable settings page runtime.
 *
 * Settings pages should be registered here and mounted by id instead of being
 * hard-wired to one tab shell. The branch module store keeps every active mount
 * of the same page synchronized, including unsaved draft edits.
 */
(function(){
  const registry = new Map();
  const stores = new Map();
  let instanceCounter = 0;

  const noop = () => {};
  const clone = (value) => {
    if (value == null || typeof value !== 'object') return value;
    try {
      if (typeof structuredClone === 'function') return structuredClone(value);
    } catch (_) {}
    try { return JSON.parse(JSON.stringify(value)); } catch (_) { return Array.isArray(value) ? value.slice() : { ...value }; }
  };
  const escapeHtml = (value) => String(value ?? '').replace(/[&<>"']/g, (match) => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;'
  }[match]));
  const currentOrgId = () => String(window.__APP?.userOrgId || window.__APP?.orgId || '').trim();
  const currentBranchId = () => String(window.Portal?.branchModules?.currentBranchId?.() || window.__APP?.userBranchId || 'default').trim() || 'default';

  function registerPage(definition = {}){
    const id = String(definition.id || '').trim();
    if (!id) throw new Error('Settings page registration requires an id.');
    if (typeof definition.render !== 'function') throw new Error(`Settings page "${id}" requires a render function.`);
    registry.set(id, { ...definition, id });
    return registry.get(id);
  }

  function getPage(id){
    return registry.get(String(id || '').trim()) || null;
  }

  function listPages(){
    return Array.from(registry.values()).map((page) => ({
      id: page.id,
      title: page.title || page.id,
      subtitle: page.subtitle || page.description || '',
      icon: page.icon || '',
      wide: !!page.wide
    }));
  }

  function contextFor(root, page, options = {}){
    return {
      root,
      page,
      options,
      instanceId: `settings_page_${++instanceCounter}`,
      orgId: String(options.orgId || currentOrgId()).trim(),
      branchId: String(options.branchId || currentBranchId()).trim(),
      embedded: !!options.embedded,
      chrome: options.chrome || 'section',
      source: options.source || 'settings_pages',
      escapeHtml,
      clone,
      currentOrgId,
      currentBranchId,
      showToast: window.Portal?.ui?.showToast || noop,
      $: window.Portal?.util?.$ || ((selector, scope = document) => scope.querySelector(selector))
    };
  }

  function mount(root, pageId, options = {}){
    if (!root) throw new Error('Settings page mount requires a root element.');
    const page = getPage(pageId);
    if (!page) {
      root.innerHTML = `<div class="cs-note">Settings page "${escapeHtml(pageId)}" is unavailable.</div>`;
      return { destroy: noop };
    }
    root.__fmSettingsPageDestroy?.();
    const context = contextFor(root, page, options);
    root.dataset.settingsPageId = page.id;
    const handle = page.render(context) || {};
    const destroy = typeof handle.destroy === 'function' ? handle.destroy : noop;
    root.__fmSettingsPageDestroy = () => {
      try { destroy(); } catch (_) {}
      root.__fmSettingsPageDestroy = null;
    };
    return { ...handle, destroy: root.__fmSettingsPageDestroy, context };
  }

  function branchModuleStore(moduleId, options = {}){
    const id = String(moduleId || '').trim();
    if (!id) throw new Error('branchModuleStore requires a module id.');
    const normalize = typeof options.normalize === 'function' ? options.normalize : ((value) => value && typeof value === 'object' ? value : {});
    const key = `${String(options.orgId || currentOrgId()).trim()}::${String(options.branchId || currentBranchId()).trim() || 'default'}::${id}`;
    if (stores.has(key)) return stores.get(key);

    let loaded = false;
    let loadingPromise = null;
    let persisted = normalize({});
    let draft = clone(persisted);
    let draftDirty = false;
    const listeners = new Set();

    const snapshot = () => clone(draft);
    const notify = (meta = {}) => {
      const current = snapshot();
      listeners.forEach((listener) => {
        try { listener(current, meta); } catch (_) {}
      });
      window.dispatchEvent(new CustomEvent('fm:settings-pages:module-updated', {
        detail: { moduleId: id, orgId: options.orgId || currentOrgId(), branchId: options.branchId || currentBranchId(), settings: current, meta }
      }));
    };
    const load = async ({ force = false } = {}) => {
      if (loaded && !force) return snapshot();
      if (loadingPromise && !force) return loadingPromise;
      loadingPromise = (async () => {
        const orgId = String(options.orgId || currentOrgId()).trim();
        const branchId = String(options.branchId || currentBranchId()).trim() || 'default';
        try {
          if (!orgId || !window.PlatformAPI?.branchModules?.get) throw new Error('Platform API is unavailable.');
          const doc = await window.PlatformAPI.branchModules.get(orgId, branchId, id);
          persisted = normalize(doc?.data || doc || {});
        } catch (error) {
          if (Number(error?.status || 0) !== 404) throw error;
          persisted = normalize({});
        }
        loaded = true;
        if (!draftDirty) draft = clone(persisted);
        notify({ type: 'load', source: options.source || 'settings_pages' });
        return snapshot();
      })();
      try { return await loadingPromise; }
      finally { loadingPromise = null; }
    };
    const setDraft = (next, meta = {}) => {
      draft = normalize(next);
      draftDirty = true;
      notify({ type: 'draft', ...meta });
      return snapshot();
    };
    const patchDraft = (updater, meta = {}) => {
      const base = snapshot();
      const next = typeof updater === 'function' ? updater(base) : { ...base, ...(updater || {}) };
      return setDraft(next, meta);
    };
    const save = async (next = draft, meta = {}) => {
      const orgId = String(options.orgId || currentOrgId()).trim();
      const branchId = String(options.branchId || currentBranchId()).trim() || 'default';
      if (!orgId || !window.PlatformAPI?.branchModules?.save) throw new Error('Platform API is unavailable.');
      const normalized = normalize(next);
      await window.PlatformAPI.branchModules.save(orgId, branchId, id, normalized, {
        kind: options.kind || `branch_${id}`,
        source: meta.source || options.source || 'settings_pages'
      });
      persisted = clone(normalized);
      draft = clone(normalized);
      draftDirty = false;
      loaded = true;
      notify({ type: 'save', ...meta });
      if (options.updatedEvent) {
        window.dispatchEvent(new CustomEvent(options.updatedEvent, { detail: snapshot() }));
      }
      return snapshot();
    };
    const subscribe = (listener) => {
      if (typeof listener !== 'function') return noop;
      listeners.add(listener);
      return () => listeners.delete(listener);
    };

    const store = { key, moduleId: id, load, get: snapshot, setDraft, patchDraft, save, subscribe };
    stores.set(key, store);
    return store;
  }

  window.FirstMateSettingsPages = {
    registerPage,
    getPage,
    listPages,
    mount,
    branchModuleStore,
    escapeHtml,
    clone
  };
})();
