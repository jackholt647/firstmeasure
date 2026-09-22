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
  const autosaveToastSuppressions = [];
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

  function markAutosaveToastSuppression(root){
    const now = Date.now();
    autosaveToastSuppressions.splice(0, autosaveToastSuppressions.length, ...autosaveToastSuppressions.filter((entry) => entry.expiresAt > now && entry.root?.isConnected));
    autosaveToastSuppressions.push({ root, expiresAt:now + 8000 });
  }

  function consumeAutosaveToast(title, message, ok = true){
    if (ok === false) return false;
    const now = Date.now();
    for (let index = autosaveToastSuppressions.length - 1; index >= 0; index -= 1) {
      const entry = autosaveToastSuppressions[index];
      if (entry.expiresAt <= now || !entry.root?.isConnected) {
        autosaveToastSuppressions.splice(index, 1);
        continue;
      }
      const copy = `${String(title || '')} ${String(message || '')}`;
      if (!/\b(?:sav(?:e|ed|ing)|updat(?:e|ed)|up to date|settings?)\b/i.test(copy)) return false;
      autosaveToastSuppressions.splice(index, 1);
      return true;
    }
    return false;
  }

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

  function ensureSubTabStyles(){
    if (document.getElementById('fm_settings_subtabs_css')) return;
    const style = document.createElement('style');
    style.id = 'fm_settings_subtabs_css';
    style.textContent = `
      .fm-settings-subtabs{display:flex;align-items:center;gap:4px;width:max-content;max-width:100%;margin:0 0 18px;padding:4px;border:1px solid #e4e7ec;border-radius:999px;background:#f5f7fa;overflow-x:auto;box-sizing:border-box}
      .fm-settings-subtab{display:inline-flex;align-items:center;justify-content:center;gap:7px;min-height:36px;margin:0;padding:8px 13px;border:0;border-radius:999px;background:transparent;color:#667085;box-shadow:none;font:850 11.5px/1 inherit;white-space:nowrap;cursor:pointer}
      .fm-settings-subtab.active{background:#fff;color:#101828;box-shadow:0 1px 4px rgba(16,24,40,.13)}
      .fm-settings-subtab-badge{display:inline-grid;place-items:center;min-width:19px;height:19px;padding:0 5px;border-radius:999px;background:#eaecf0;color:#475467;font-size:9px;font-weight:950}
    `;
    document.head.appendChild(style);
  }

  /*
   * Canonical nested navigation for Settings pages.
   *
   * New Settings UI must declare its page-level views with this helper instead
   * of inventing another tab header. The caller still owns routing and state;
   * this helper only guarantees the shared, accessible bubble-tab chrome.
   */
  function subTabs(options = {}){
    ensureSubTabStyles();
    const id = String(options.id || '').trim();
    const items = Array.isArray(options.items) ? options.items : [];
    const active = String(options.active || '').trim();
    if (!id) throw new Error('Settings subTabs requires an id.');
    if (!items.length) return '';
    const seen = new Set();
    const buttons = items.map((item = {}) => {
      const value = String(item.id || '').trim();
      const label = String(item.label || '').trim();
      if (!value || !label) throw new Error(`Settings subTabs "${id}" requires an id and label for every item.`);
      if (seen.has(value)) throw new Error(`Settings subTabs "${id}" contains duplicate item "${value}".`);
      seen.add(value);
      const selected = value === active;
      const icon = String(item.icon || '').trim();
      const badge = item.badge == null || item.badge === '' ? '' : `<span class="fm-settings-subtab-badge">${escapeHtml(item.badge)}</span>`;
      return `<button type="button" class="fm-settings-subtab ${selected ? 'active' : ''}" role="tab" aria-selected="${selected}" data-settings-subtab="${escapeHtml(id)}:${escapeHtml(value)}" data-settings-subtab-value="${escapeHtml(value)}">${icon ? `<i class="${escapeHtml(icon)}" aria-hidden="true"></i>` : ''}<span>${escapeHtml(label)}</span>${badge}</button>`;
    }).join('');
    return `<nav class="fm-settings-subtabs" role="tablist" aria-label="${escapeHtml(options.ariaLabel || 'Settings views')}" data-settings-subtabs="${escapeHtml(id)}">${buttons}</nav>`;
  }

  function bindSubTabs(root, id, onChange){
    if (!root || typeof onChange !== 'function') return noop;
    const key = String(id || '').trim();
    const selector = `[data-settings-subtab^="${key.replace(/["\\]/g, '\\$&')}:"]`;
    const listener = (event) => {
      const button = event.target.closest?.(selector);
      if (!button || !root.contains(button)) return;
      onChange(String(button.dataset.settingsSubtabValue || '').trim(), button, event);
    };
    root.addEventListener('click', listener);
    return () => root.removeEventListener('click', listener);
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
      root.innerHTML = `<div class="cs-note">${((v0) => globalThis.PlatformLanguage?.text("settings-pages","m_a446c433a4d6f0",`Settings page "${v0}" is unavailable.`,{v0}) ?? `Settings page "${v0}" is unavailable.`)(escapeHtml(pageId))}</div>`;
      return { destroy: noop };
    }
    root.__fmSettingsPageDestroy?.();
    const context = contextFor(root, page, options);
    root.dataset.settingsPageId = page.id;
    const handle = page.render(context) || {};
    const destroyAutosave = installAutosave(root, { source: `settings-page:${page.id}` });
    const destroy = typeof handle.destroy === 'function' ? handle.destroy : noop;
    root.__fmSettingsPageDestroy = () => {
      try { destroyAutosave(); } catch (_) {}
      try { destroy(); } catch (_) {}
      root.__fmSettingsPageDestroy = null;
    };
    return { ...handle, destroy: root.__fmSettingsPageDestroy, context };
  }

  /*
   * Settings-wide autosave adapter.
   *
   * A number of the older settings pages still expose a button-backed save
   * implementation. Keeping those implementations as the single persistence
   * path preserves their validation, conflict handling, API payloads and
   * success/error UI, while this adapter makes that path automatic. Newer
   * controls which already save on change simply have no matching save button
   * and continue to work as before.
   */
  function installAutosave(root, options = {}){
    if (!root?.addEventListener) return noop;
    if (root.parentElement?.closest?.('[data-settings-autosave-root="true"]')) return noop;
    root.__fmSettingsAutosaveDestroy?.();
    root.dataset.settingsAutosaveRoot = 'true';

    ensureAutosaveStyles();
    const timers = new Map();
    const managed = new Set();
    let statusTimer = null;
    let saveSequence = 0;
    const saveLabel = /^(?:save|apply)\b/i;
    const transactionalLabel = /\b(?:and add card|new version)\b/i;
    const nonSaveActionLabel = /^(?:add card|create)\b/i;
    const fieldSelector = 'input:not([type="button"]):not([type="submit"]):not([type="reset"]),select,textarea';

    const buttonLabel = (button) => String(button?.textContent || button?.getAttribute?.('aria-label') || '').replace(/\s+/g, ' ').trim();
    const statusHost = root.querySelector?.('.cs-layout') || root;
    const status = document.createElement('div');
    status.className = 'fm-settings-autosave-status';
    status.dataset.settingsAutosaveStatus = 'idle';
    status.setAttribute('role', 'status');
    status.setAttribute('aria-live', 'polite');
    statusHost.appendChild(status);
    const showStatus = (state, message) => {
      if (statusTimer) window.clearTimeout(statusTimer);
      status.dataset.settingsAutosaveStatus = state;
      status.textContent = message;
      root.dispatchEvent(new CustomEvent('fm:settings-autosave-status', {
        detail:{ state, message, source:options.source || 'settings' }
      }));
      if (state === 'saved') {
        statusTimer = window.setTimeout(() => {
          status.dataset.settingsAutosaveStatus = 'idle';
          status.textContent = '';
        }, 1800);
      }
    };
    const saveBarFor = (button) => button?.closest?.('[data-fb-savebar],.fb-savebar,[data-settings-savebar]');
    const unmanageButton = (button) => {
      if (!button?.dataset || button.dataset.settingsAutosaveTrigger !== 'true') return;
      delete button.dataset.settingsAutosaveTrigger;
      delete button.dataset.settingsAutosaveBusy;
      button.removeAttribute('aria-hidden');
      button.removeAttribute('tabindex');
      const saveBar = saveBarFor(button);
      if (saveBar && !saveBar.querySelector('[data-settings-autosave-trigger="true"]')) delete saveBar.dataset.settingsAutosaveBar;
      managed.delete(button);
    };
    const manageButton = (button) => {
      if (!(button instanceof HTMLButtonElement)) return;
      const label = buttonLabel(button);
      if (transactionalLabel.test(label) || nonSaveActionLabel.test(label) || button.closest('[data-settings-autosave="off"]')) {
        unmanageButton(button);
        return;
      }
      // Keep an already-managed button hidden while its own handler changes
      // the label to Saving/Saved. It becomes eligible again automatically if
      // a re-render later changes it back to a Save label.
      if (!saveLabel.test(label)) return;
      button.dataset.settingsAutosaveTrigger = 'true';
      button.setAttribute('aria-hidden', 'true');
      button.tabIndex = -1;
      const saveBar = saveBarFor(button);
      if (saveBar) saveBar.dataset.settingsAutosaveBar = 'true';
      managed.add(button);
    };
    const scan = (node = root) => {
      if (node instanceof HTMLButtonElement) manageButton(node);
      manageButton(node.parentElement?.closest?.('button'));
      node.querySelectorAll?.('button').forEach(manageButton);
    };

    const distance = (from, to) => {
      const fromPath = [];
      const toPath = [];
      for (let node = from; node && node !== root.parentNode; node = node.parentNode) fromPath.push(node);
      for (let node = to; node && node !== root.parentNode; node = node.parentNode) toPath.push(node);
      let i = fromPath.length - 1;
      let j = toPath.length - 1;
      while (i >= 0 && j >= 0 && fromPath[i] === toPath[j]) { i -= 1; j -= 1; }
      return i + j + 2;
    };
    const saveButtonFor = (target, fallbackScope = null) => {
      if (!target) return null;
      const pane = (root.contains(target) ? target.closest?.('[data-settings-pane],[data-settings-page-id]') : null) || fallbackScope || root;
      const candidates = Array.from(pane.querySelectorAll?.('button[data-settings-autosave-trigger="true"]') || [])
        .filter((button) => !button.disabled && button.dataset.settingsAutosaveBusy !== 'true');
      if (!candidates.length) return null;
      return candidates.sort((left, right) => distance(target, left) - distance(target, right))[0] || null;
    };
    const run = (button) => {
      if (!button?.isConnected || button.disabled || button.dataset.settingsAutosaveBusy === 'true') return;
      button.dataset.settingsAutosaveBusy = 'true';
      const sequence = ++saveSequence;
      showStatus('saving', 'Saving...');
      markAutosaveToastSuppression(root);
      button.click();
      // The underlying save handler owns its real busy state. This short guard
      // only prevents duplicate clicks from the same browser event burst.
      window.setTimeout(() => {
        if (button?.dataset) delete button.dataset.settingsAutosaveBusy;
      }, 250);
      window.setTimeout(() => {
        if (sequence === saveSequence) showStatus('saved', 'Saved');
      }, 900);
    };
    const stableButtonSelector = (button) => {
      if (!button) return '';
      if (button.id) return `#${CSS.escape(button.id)}`;
      const stableAttribute = Array.from(button.attributes || []).find((attribute) => (
        attribute.name.startsWith('data-')
        && /save/i.test(attribute.name)
        && !['data-settings-autosave-trigger', 'data-settings-autosave-busy', 'data-settings-autosave'].includes(attribute.name)
      ));
      if (!stableAttribute) return '';
      return stableAttribute.value
        ? `[${stableAttribute.name}="${CSS.escape(stableAttribute.value)}"]`
        : `[${stableAttribute.name}]`;
    };
    const schedule = (target, delay, fallbackScope = null) => {
      const button = saveButtonFor(target, fallbackScope);
      if (!button) return;
      const selector = stableButtonSelector(button);
      const key = selector || button;
      const prior = timers.get(key);
      if (prior) window.clearTimeout(prior);
      timers.set(key, window.setTimeout(() => {
        timers.delete(key);
        const current = button.isConnected
          ? button
          : (selector ? (fallbackScope?.querySelector?.(selector) || root.querySelector?.(selector)) : null);
        run(current);
      }, delay));
    };
    const onFieldEvent = (event) => {
      const field = event.target?.closest?.(fieldSelector);
      if (!field || field.disabled || field.readOnly) return;
      if (field.type === 'file' || field.type === 'search' || field.closest('[data-settings-autosave="off"]')) return;
      const fallbackScope = event.composedPath?.().find((node) => node?.matches?.('[data-settings-pane],[data-settings-page-id]')) || null;
      const immediate = event.type === 'change' || ['checkbox', 'radio', 'range', 'color'].includes(String(field.type || '').toLowerCase());
      schedule(field, immediate ? 0 : Number(options.inputDelay ?? 350), fallbackScope);
    };
    const onActionClick = (event) => {
      const button = event.target?.closest?.('button');
      if (!button || button.dataset.settingsAutosaveTrigger === 'true' || button.closest('[data-settings-autosave="off"]')) return;
      if (button.matches('[role="tab"],[data-settings-section],[data-settings-subtab],[data-settings-search-result]')) return;
      const label = buttonLabel(button);
      if (/\b(?:cancel|delete|archive|create|open|edit|copy|download|upload|invite|connect|register|buy|search|preview|publish|close|back|retry|history)\b/i.test(label)) return;
      const fallbackScope = event.composedPath?.().find((node) => node?.matches?.('[data-settings-pane],[data-settings-page-id]')) || null;
      schedule(button, 0, fallbackScope);
    };

    scan();
    const observer = new MutationObserver((records) => records.forEach((record) => record.addedNodes.forEach(scan)));
    observer.observe(root, { childList:true, subtree:true });
    root.addEventListener('input', onFieldEvent, true);
    root.addEventListener('change', onFieldEvent, true);
    // Capture clicks before legacy settings handlers can replace their DOM.
    root.addEventListener('click', onActionClick, true);

    const destroy = () => {
      observer.disconnect();
      root.removeEventListener('input', onFieldEvent, true);
      root.removeEventListener('change', onFieldEvent, true);
      root.removeEventListener('click', onActionClick, true);
      timers.forEach((timer) => window.clearTimeout(timer));
      timers.clear();
      if (statusTimer) window.clearTimeout(statusTimer);
      status.remove();
      managed.forEach((button) => {
        unmanageButton(button);
      });
      managed.clear();
      delete root.dataset.settingsAutosaveRoot;
      if (root.__fmSettingsAutosaveDestroy === destroy) root.__fmSettingsAutosaveDestroy = null;
    };
    root.__fmSettingsAutosaveDestroy = destroy;
    return destroy;
  }

  function ensureAutosaveStyles(){
    if (document.getElementById('fm_settings_autosave_css')) return;
    const style = document.createElement('style');
    style.id = 'fm_settings_autosave_css';
    style.textContent = `
      [data-settings-autosave-trigger="true"],[data-settings-autosave-bar="true"]{display:none!important}
      .fm-settings-autosave-status{grid-area:subtabs;align-self:center;justify-self:end;z-index:3;margin:0 22px 18px 0;min-height:13px;padding:0;background:none!important;border:0!important;border-radius:0;color:#24934f;font-family:inherit;font-size:9px;font-weight:800;line-height:1.35;letter-spacing:.01em;opacity:0;pointer-events:none;transition:opacity .18s ease}
      .fm-settings-autosave-status[data-settings-autosave-status="saving"],.fm-settings-autosave-status[data-settings-autosave-status="saved"]{opacity:.82;color:#24934f}
      [data-settings-autosave-root="true"]:not(.cs-layout){position:relative}
      [data-settings-autosave-root="true"]:not(:has(.cs-layout))>.fm-settings-autosave-status{position:absolute;top:8px;right:8px;margin:0}
      @media(max-width:1100px){.fm-settings-autosave-status{margin-right:16px}}
    `;
    document.head.appendChild(style);
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
    installAutosave,
    subTabs,
    bindSubTabs,
    branchModuleStore,
    consumeAutosaveToast,
    escapeHtml,
    clone
  };
})();
