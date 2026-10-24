/* public/libraries/left-column-pins/left-column-pins.js
 * Pinnable app subviews and drag-to-pin for the left column.
 *
 * An app declares the views a person may pin on their own as `subviews` on its
 * manifest entry ({ id, label, icon, route, requires: { appFlags } }). A pinned
 * subview is a personal preference (`left_column_pins`, "<app id>:<subview id>")
 * and opens the app with the subview's route params. Whole apps keep their
 * organization placement (`app_placements`); dragging an app onto the left
 * column pins it exactly as the apps overlay's pin does (the shell's pinApp).
 * Docs: docs/architecture/app-experience.md ("Left-column pins").
 */
(function(root){
  'use strict';
  if (root.FirstMateLeftColumnPins) return;

  const PREFERENCE_KEY = 'left_column_pins';
  const PIN_LIMIT = 48;
  const KEY_PATTERN = /^[a-z0-9][a-z0-9._-]{1,119}:[a-z0-9][a-z0-9_-]{0,63}$/;
  const DRAG_THRESHOLD = 6;
  const hooks = {};
  const boundOverlays = new WeakSet();
  let saveChain = Promise.resolve();
  let expandedAppId = '';
  let lastPinsSignature = null;
  let arrivingKey = '';

  const clean = (value) => String(value ?? '').trim();
  const escapeHtml = (value) => String(value ?? '').replace(/[&<>"']/g, (c) => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' }[c]));
  const iconClass = (value) => /^fa-[a-z0-9-]+$/.test(clean(value)) ? clean(value) : 'fa-circle';
  const reducedMotion = () => !!root.matchMedia?.('(prefers-reduced-motion: reduce)')?.matches;
  const toast = (message) => root.PlatformUI?.showToast?.(message);
  const call = (name, ...args) => (typeof hooks[name] === 'function' ? hooks[name](...args) : undefined);

  function preferences(){
    return root.Portal?.currentUser?.identity?.preferences || {};
  }

  function normalizePins(value){
    const pins = Array.isArray(value) ? value.map((pin) => clean(pin).toLowerCase()).filter((pin) => KEY_PATTERN.test(pin)) : [];
    return [...new Set(pins)].slice(0, PIN_LIMIT);
  }

  function pinnedKeys(){
    return normalizePins(preferences()[PREFERENCE_KEY]);
  }

  function manifestFor(appId){
    const id = clean(appId).toLowerCase();
    if (!id) return null;
    return (root.FirstMateAppsManifest?.apps || []).find((app) => clean(app?.id).toLowerCase() === id)
      || root.FirstMateEmbeddableApps?.getApp?.(id)
      || null;
  }

  function requirementsMet(requires = {}){
    const flags = root.Portal?.appFlags || root.PlatformAPI?.appFlags;
    const appFlags = Array.isArray(requires?.appFlags) ? requires.appFlags : [];
    return appFlags.every((pair) => Array.isArray(pair) && flags?.value?.(clean(pair[0]), clean(pair[1]), false) === true);
  }

  // The subviews an app declares that are available to this organization now.
  function subviews(appId){
    const manifest = manifestFor(appId);
    const declared = Array.isArray(manifest?.subviews) ? manifest.subviews : [];
    const id = clean(manifest?.id).toLowerCase();
    const tabId = clean(manifest?.portalTabId, manifest?.tabId) || (id.startsWith('portal.') ? id.slice(7) : id);
    return declared.map((subview) => {
      const subviewId = clean(subview?.id).toLowerCase();
      const key = `${id}:${subviewId}`;
      if (!KEY_PATTERN.test(key) || !requirementsMet(subview.requires)) return null;
      const route = {};
      Object.entries(subview.route && typeof subview.route === 'object' ? subview.route : {}).forEach(([param, value]) => {
        if (clean(param) && clean(value)) route[clean(param)] = clean(value);
      });
      return { key, appId:id, id:subviewId, tabId, label:clean(subview.label) || subviewId, icon:iconClass(subview.icon), route };
    }).filter(Boolean);
  }

  function subviewByKey(key){
    const normalized = clean(key).toLowerCase();
    const appId = normalized.slice(0, normalized.lastIndexOf(':'));
    return subviews(appId).find((subview) => subview.key === normalized) || null;
  }

  function isPinned(key){
    return pinnedKeys().includes(clean(key).toLowerCase());
  }

  function pinnedSubviews(appId){
    const pins = new Set(pinnedKeys());
    return subviews(appId).filter((subview) => pins.has(subview.key));
  }

  function announce(message){
    let region = document.getElementById('fmLeftColumnPinsLive');
    if (!region) {
      region = document.createElement('div');
      region.id = 'fmLeftColumnPinsLive';
      region.setAttribute('aria-live', 'polite');
      region.className = 'fm-pin-live';
      document.body.appendChild(region);
    }
    region.textContent = '';
    root.setTimeout(() => { region.textContent = message; }, 30);
  }

  function emitPinsUpdated(){
    lastPinsSignature = JSON.stringify(pinnedKeys());
    root.dispatchEvent(new CustomEvent('fm:left-column-pins:updated', { detail:{ pins:pinnedKeys() } }));
  }

  function writeLocalPins(pins){
    const identity = root.Portal?.currentUser?.identity;
    if (!identity) return;
    identity.preferences = { ...(identity.preferences || {}), [PREFERENCE_KEY]: pins };
  }

  // Personal and saved to the person's preferences; the change shows at once
  // and is rolled back when the save fails.
  function setPinned(key, pinned){
    const normalized = clean(key).toLowerCase();
    if (!KEY_PATTERN.test(normalized)) return Promise.reject(new Error('Unknown view.'));
    const before = pinnedKeys();
    const next = pinned
      ? normalizePins([...before.filter((pin) => pin !== normalized), normalized])
      : before.filter((pin) => pin !== normalized);
    if (JSON.stringify(next) === JSON.stringify(before)) return Promise.resolve(next);
    writeLocalPins(next);
    emitPinsUpdated();
    const save = saveChain.catch(() => null).then(async () => {
      const api = root.PlatformAPI?.preferences;
      if (!api?.patch) return next;
      const result = await api.patch({ [PREFERENCE_KEY]: pinnedKeys() });
      const saved = normalizePins(result?.preferences?.[PREFERENCE_KEY] ?? pinnedKeys());
      if (JSON.stringify(saved) !== JSON.stringify(pinnedKeys())) {
        writeLocalPins(saved);
        emitPinsUpdated();
      }
      return saved;
    });
    saveChain = save.catch((error) => {
      const current = pinnedKeys();
      const reverted = pinned ? current.filter((pin) => pin !== normalized) : normalizePins([...current, normalized]);
      writeLocalPins(reverted);
      emitPinsUpdated();
      throw error;
    });
    return saveChain;
  }

  function routeMatches(subview, route = currentRoute()){
    if (clean(route.tab) !== subview.tabId) return false;
    const entries = Object.entries(subview.route);
    return entries.length > 0 && entries.every(([param, value]) => clean(route[param]) === value);
  }

  function currentRoute(){
    try {
      return root.Portal?.navigation?.read?.() || Object.fromEntries(new URLSearchParams(root.location.search || ''));
    } catch (_) {
      return {};
    }
  }

  function open(subviewOrKey){
    const subview = typeof subviewOrKey === 'string' ? subviewByKey(subviewOrKey) : subviewOrKey;
    if (!subview) return false;
    call('beforeOpen', subview);
    const patch = { tab:subview.tabId, ...subview.route };
    const options = { source:'left-column-subview', ownedKeys:Object.keys(patch) };
    if (root.Portal?.navigation?.navigate) root.Portal.navigation.navigate(patch, options);
    else root.Portal?.routeState?.push?.(patch, options);
    root.requestAnimationFrame?.(() => syncActive());
    return true;
  }

  // The parent app's link is the active one unless a pinned subview of it
  // matches the route exactly.
  function syncActive(){
    const route = currentRoute();
    const activeTabs = new Map();
    document.querySelectorAll('.fm-link-subview[data-subview-key]').forEach((link) => {
      const subview = subviewByKey(link.dataset.subviewKey);
      const active = !!subview && routeMatches(subview, route);
      link.classList.toggle('active', active);
      link.setAttribute('aria-current', active ? 'page' : 'false');
      const tabId = clean(link.dataset.subviewTab);
      activeTabs.set(tabId, activeTabs.get(tabId) || active);
    });
    activeTabs.forEach((subviewActive, tabId) => {
      if (clean(route.tab) !== tabId) return;
      document.querySelectorAll(`#sidebarMainLinks .fm-link[data-tab="${cssEscape(tabId)}"]`).forEach((link) => link.classList.toggle('active', !subviewActive));
    });
  }

  function cssEscape(value){
    return root.CSS?.escape ? root.CSS.escape(value) : clean(value).replace(/["\\]/g, '\\$&');
  }

  function sidebarLink(subview, options = {}){
    ensureStyles();
    const parentLabel = clean(options.parentLabel);
    const fullLabel = parentLabel ? ((v0, v1) => globalThis.PlatformLanguage?.text("left-column-pins","lcp_subview_full_label",`${v0}: ${v1}`,{v0,v1}) ?? `${v0}: ${v1}`)(parentLabel, subview.label) : subview.label;
    const item = document.createElement('div');
    item.className = `fm-link fm-link-subview${subview.key === arrivingKey ? ' fm-pin-arriving' : ''}`;
    item.dataset.subviewKey = subview.key;
    item.dataset.subviewTab = subview.tabId;
    item.setAttribute('role', 'link');
    item.setAttribute('tabindex', '0');
    item.setAttribute('aria-label', fullLabel);
    item.innerHTML = `
      ${options.showUnpin ? `<button type="button" class="fm-sidebar-app-pin is-pinned" data-sidebar-subview-pin="${escapeHtml(subview.key)}" aria-label="${escapeHtml(((v0) => globalThis.PlatformLanguage?.text("left-column-pins","lcp_unpin_from_left_column",`Unpin ${v0} from the left column`,{v0}) ?? `Unpin ${v0} from the left column`)(fullLabel))}" title="${escapeHtml(globalThis.PlatformLanguage?.text("left-column-pins","lcp_unpin_title","Unpin from the left column") ?? "Unpin from the left column")}"><i class="fas fa-thumbtack" aria-hidden="true"></i></button>` : ''}
      <div class="ic"><i class="fas ${escapeHtml(subview.icon)}"></i></div>
      <div class="tx">${escapeHtml(subview.label)}</div>`;
    item.addEventListener('click', () => open(subview));
    item.addEventListener('keydown', (event) => {
      if (event.target !== item || (event.key !== 'Enter' && event.key !== ' ')) return;
      event.preventDefault();
      open(subview);
    });
    item.querySelector('[data-sidebar-subview-pin]')?.addEventListener('click', async (event) => {
      event.preventDefault();
      event.stopPropagation();
      const button = event.currentTarget;
      button.disabled = true;
      try {
        await setPinned(subview.key, false);
        toast(((v0) => globalThis.PlatformLanguage?.text("left-column-pins","lcp_removed_toast",`${v0} removed from the left column.`,{v0}) ?? `${v0} removed from the left column.`)(fullLabel));
      } catch (error) {
        button.disabled = false;
        toast(error?.message || (globalThis.PlatformLanguage?.text("left-column-pins","lcp_save_failed","Could not update the left column.") ?? "Could not update the left column."));
      }
    });
    return item;
  }

  /* ---------- Apps overlay: subviews roll out of their app's tile ---------- */

  function overlayTileExtras(entry = {}){
    const appId = clean(entry.appId).toLowerCase();
    const list = entry.tabId ? subviews(appId) : [];
    if (!list.length) return { className:'', html:'' };
    ensureStyles();
    const pins = new Set(pinnedKeys());
    const listId = `fmSubviews_${appId.replace(/[^a-z0-9_-]/g, '_')}`;
    const appLabel = clean(entry.label) || appId;
    const rows = list.map((subview, index) => {
      const pinned = pins.has(subview.key);
      const pinLabel = pinned
        ? ((v0) => globalThis.PlatformLanguage?.text("left-column-pins","lcp_unpin_view",`Unpin ${v0} from the left column`,{v0}) ?? `Unpin ${v0} from the left column`)(subview.label)
        : ((v0) => globalThis.PlatformLanguage?.text("left-column-pins","lcp_pin_view",`Pin ${v0} to the left column`,{v0}) ?? `Pin ${v0} to the left column`)(subview.label);
      return `
        <div class="fm-advanced-subview" style="--i:${index}" data-pin-drag-subview="${escapeHtml(subview.key)}">
          <button type="button" class="fm-advanced-subview-pin${pinned ? ' is-pinned' : ''}" data-advanced-subview-pin="${escapeHtml(subview.key)}" aria-pressed="${pinned}" aria-label="${escapeHtml(pinLabel)}" title="${escapeHtml(pinLabel)}"><i class="fas fa-thumbtack" aria-hidden="true"></i></button>
          <button type="button" class="fm-advanced-subview-open" data-advanced-subview-open="${escapeHtml(subview.key)}"><i class="fas ${escapeHtml(subview.icon)}" aria-hidden="true"></i><span>${escapeHtml(subview.label)}</span></button>
        </div>`;
    }).join('');
    const expanded = expandedAppId === appId;
    const toggleLabel = ((v0) => globalThis.PlatformLanguage?.text("left-column-pins","lcp_show_views",`Views of ${v0}`,{v0}) ?? `Views of ${v0}`)(appLabel);
    return {
      className:` has-subviews${expanded ? ' is-expanded' : ''}`,
      html:`
        <button type="button" class="fm-advanced-app-subviews-toggle" data-advanced-subviews-toggle="${escapeHtml(appId)}" aria-expanded="${expanded}" aria-controls="${listId}" aria-label="${escapeHtml(toggleLabel)}" title="${escapeHtml(toggleLabel)}"><i class="fas fa-chevron-down" aria-hidden="true"></i></button>
        <div class="fm-advanced-app-subviews" id="${listId}" role="group" aria-label="${escapeHtml(toggleLabel)}"><div class="fm-advanced-app-subviews-card">${rows}</div></div>`
    };
  }

  function placeSubviewList(tile){
    const list = tile?.querySelector?.('.fm-advanced-app-subviews');
    if (!list) return;
    const rect = tile.getBoundingClientRect();
    const height = list.querySelector('.fm-advanced-app-subviews-card')?.scrollHeight || list.scrollHeight || 0;
    const viewport = root.innerHeight || document.documentElement.clientHeight || 0;
    tile.classList.toggle('subviews-above', rect.bottom + height + 18 > viewport && rect.top - height - 18 > 0);
  }

  function setTileExpanded(tile, expanded){
    if (!tile) return;
    tile.classList.toggle('is-expanded', expanded);
    tile.querySelector('[data-advanced-subviews-toggle]')?.setAttribute('aria-expanded', String(expanded));
    if (expanded) placeSubviewList(tile);
  }

  function bindOverlay(overlay, options = {}){
    if (!overlay) return;
    if (!boundOverlays.has(overlay)) {
      boundOverlays.add(overlay);
      expandedAppId = '';
      overlay.querySelectorAll('.fm-advanced-app-tile.is-expanded').forEach((tile) => setTileExpanded(tile, false));
    }
    const signal = options.signal;
    overlay.querySelectorAll('.fm-advanced-app-tile.has-subviews').forEach((tile) => {
      tile.addEventListener('pointerenter', () => placeSubviewList(tile), { signal });
      tile.addEventListener('focusin', () => placeSubviewList(tile), { signal });
      if (tile.classList.contains('is-expanded')) placeSubviewList(tile);
    });
    overlay.addEventListener('click', async (event) => {
      const toggle = event.target.closest?.('[data-advanced-subviews-toggle]');
      if (toggle && overlay.contains(toggle)) {
        event.stopPropagation();
        const tile = toggle.closest('.fm-advanced-app-tile');
        const expanded = !tile.classList.contains('is-expanded');
        overlay.querySelectorAll('.fm-advanced-app-tile.is-expanded').forEach((other) => { if (other !== tile) setTileExpanded(other, false); });
        setTileExpanded(tile, expanded);
        expandedAppId = expanded ? clean(toggle.dataset.advancedSubviewsToggle) : '';
        return;
      }
      const pin = event.target.closest?.('[data-advanced-subview-pin]');
      if (pin && overlay.contains(pin)) {
        event.stopPropagation();
        const key = pin.dataset.advancedSubviewPin;
        const subview = subviewByKey(key);
        const pinned = !pin.classList.contains('is-pinned');
        pin.disabled = true;
        setPinButton(pin, subview, pinned);
        try {
          await setPinned(key, pinned);
          toast(pinned
            ? ((v0) => globalThis.PlatformLanguage?.text("left-column-pins","lcp_pinned_toast",`${v0} pinned to the left column.`,{v0}) ?? `${v0} pinned to the left column.`)(subview?.label || '')
            : ((v0) => globalThis.PlatformLanguage?.text("left-column-pins","lcp_removed_toast",`${v0} removed from the left column.`,{v0}) ?? `${v0} removed from the left column.`)(subview?.label || ''));
          if (pinned) flashLanded(subview);
        } catch (error) {
          setPinButton(pin, subview, !pinned);
          toast(error?.message || (globalThis.PlatformLanguage?.text("left-column-pins","lcp_save_failed","Could not update the left column.") ?? "Could not update the left column."));
        } finally {
          pin.disabled = false;
        }
        return;
      }
      const openButton = event.target.closest?.('[data-advanced-subview-open]');
      if (openButton && overlay.contains(openButton)) {
        event.stopPropagation();
        call('closeOverlay');
        open(openButton.dataset.advancedSubviewOpen);
      }
    }, { signal });
    overlay.addEventListener('keydown', (event) => {
      if (event.key !== 'Escape') return;
      const tile = event.target.closest?.('.fm-advanced-app-tile.is-expanded');
      if (!tile) return;
      event.stopPropagation();
      setTileExpanded(tile, false);
      expandedAppId = '';
      tile.querySelector('[data-advanced-subviews-toggle]')?.focus();
    }, { signal, capture:true });
  }

  function setPinButton(button, subview, pinned){
    if (!button) return;
    const label = subview?.label || '';
    const text = pinned
      ? ((v0) => globalThis.PlatformLanguage?.text("left-column-pins","lcp_unpin_view",`Unpin ${v0} from the left column`,{v0}) ?? `Unpin ${v0} from the left column`)(label)
      : ((v0) => globalThis.PlatformLanguage?.text("left-column-pins","lcp_pin_view",`Pin ${v0} to the left column`,{v0}) ?? `Pin ${v0} to the left column`)(label);
    button.classList.toggle('is-pinned', pinned);
    button.setAttribute('aria-pressed', String(pinned));
    button.setAttribute('aria-label', text);
    button.setAttribute('title', text);
  }

  function landedElement(payload){
    if (!payload) return null;
    if (payload.type === 'subview') return document.querySelector(`#sidebarMainLinks .fm-link-subview[data-subview-key="${cssEscape(payload.key)}"]`);
    return payload.tabId ? document.querySelector(`#sidebarMainLinks .fm-link[data-tab="${cssEscape(payload.tabId)}"]`) : null;
  }

  function flashLanded(subview){
    root.requestAnimationFrame?.(() => pulse(landedElement(subview ? { type:'subview', key:subview.key } : null)));
  }

  /* ---------- Drag a tab button onto the left column to pin it ---------- */

  let drag = null;

  function sidebarElement(){
    return document.querySelector('.sidebar');
  }

  function sidebarDroppable(){
    const sidebar = sidebarElement();
    if (!sidebar) return false;
    const rect = sidebar.getBoundingClientRect();
    const style = root.getComputedStyle?.(sidebar);
    return rect.width > 24 && rect.right > 24 && rect.left < (root.innerWidth || 0) && style?.visibility !== 'hidden' && style?.display !== 'none';
  }

  function dragPayload(source){
    if (source.dataset.pinDragApp) {
      const appId = clean(source.dataset.pinDragApp).toLowerCase();
      const app = call('describeApp', appId);
      if (!app) return null;
      return { type:'app', appId, tabId:clean(app.tabId), label:clean(app.label) || appId, icon:iconClass(app.icon), pinned:app.pinned === true };
    }
    const key = clean(source.dataset.pinDragSubview || source.dataset.appSubview).toLowerCase();
    const subview = key ? subviewByKey(key) : null;
    if (!subview) return null;
    return { type:'subview', key:subview.key, appId:subview.appId, tabId:subview.tabId, label:subview.label, icon:subview.icon, pinned:isPinned(subview.key), subview };
  }

  function onPointerDown(event){
    if (drag || event.button !== 0 || event.pointerType === 'touch' || event.isPrimary === false) return;
    const source = event.target.closest?.('[data-pin-drag-app],[data-pin-drag-subview],[data-app-subview]');
    if (!source || event.target.closest('[data-advanced-app-pin],[data-advanced-subview-pin],[data-advanced-subviews-toggle],[data-sidebar-app-pin],[data-sidebar-subview-pin]')) return;
    if (source.closest('#sidebarMainLinks') || call('dragEnabled') !== true || !sidebarDroppable()) return;
    drag = { source, pointerId:event.pointerId, startX:event.clientX, startY:event.clientY, started:false, payload:null };
    root.addEventListener('pointermove', onPointerMove, true);
    root.addEventListener('pointerup', onPointerUp, true);
    root.addEventListener('pointercancel', cancelDrag, true);
  }

  function startDrag(event){
    const payload = dragPayload(drag.source);
    if (!payload) { stopListening(); drag = null; return false; }
    ensureStyles();
    drag.payload = payload;
    drag.started = true;
    drag.origin = drag.source.getBoundingClientRect();
    root.getSelection?.()?.removeAllRanges?.();
    const ghost = document.createElement('div');
    ghost.className = 'fm-pin-ghost';
    ghost.setAttribute('aria-hidden', 'true');
    ghost.innerHTML = `<i class="fas ${escapeHtml(payload.icon)}"></i><span>${escapeHtml(payload.label)}</span>`;
    document.body.appendChild(ghost);
    drag.ghost = ghost;
    drag.offsetX = 18;
    drag.offsetY = 18;
    moveGhost(event.clientX, event.clientY);
    document.body.classList.add('fm-pin-dragging');
    sidebarElement()?.classList.add('fm-pin-drop-ready');
    root.addEventListener('keydown', onDragKey, true);
    announce(((v0) => globalThis.PlatformLanguage?.text("left-column-pins","lcp_drag_started",`Dragging ${v0}. Drop it on the left column to pin it.`,{v0}) ?? `Dragging ${v0}. Drop it on the left column to pin it.`)(payload.label));
    return true;
  }

  function moveGhost(x, y){
    if (!drag?.ghost) return;
    drag.ghost.style.transform = `translate3d(${Math.round(x - drag.offsetX)}px, ${Math.round(y - drag.offsetY)}px, 0)`;
  }

  function overSidebar(x, y){
    const sidebar = sidebarElement();
    if (!sidebar) return false;
    const rect = sidebar.getBoundingClientRect();
    return x >= rect.left && x <= rect.right + 16 && y >= rect.top && y <= rect.bottom;
  }

  function landingAnchor(payload){
    const links = document.getElementById('sidebarMainLinks');
    if (!links) return { parent:null, before:null };
    if (payload.type === 'subview') {
      const parentLink = links.querySelector(`.fm-link[data-tab="${cssEscape(payload.tabId)}"]:not(.fm-link-subview)`);
      const siblings = [...links.querySelectorAll(`.fm-link-subview[data-subview-tab="${cssEscape(payload.tabId)}"]`)];
      const last = siblings.at(-1) || parentLink;
      if (last) return { parent:links, before:last.nextElementSibling };
    }
    const before = call('landingBefore', payload);
    return { parent:links, before:before instanceof Element && before.parentElement === links ? before : null };
  }

  function showSlot(){
    if (!drag || drag.slot || drag.existing) return;
    const existing = drag.payload.pinned ? landedElement(drag.payload) : null;
    if (existing) {
      drag.existing = existing;
      existing.classList.add('fm-pin-drop-target');
      return;
    }
    const { parent, before } = landingAnchor(drag.payload);
    if (!parent) return;
    const slot = document.createElement('div');
    slot.className = 'fm-pin-drop-slot';
    slot.setAttribute('aria-hidden', 'true');
    slot.innerHTML = `<span class="ic"><i class="fas ${escapeHtml(drag.payload.icon)}"></i></span><span class="tx">${escapeHtml(drag.payload.label)}</span>`;
    parent.insertBefore(slot, before);
    drag.slot = slot;
    root.requestAnimationFrame?.(() => slot.classList.add('is-open'));
    slot.scrollIntoView?.({ block:'nearest', behavior:reducedMotion() ? 'auto' : 'smooth' });
  }

  function hideSlot(){
    if (!drag) return;
    drag.existing?.classList.remove('fm-pin-drop-target');
    drag.existing = null;
    const slot = drag.slot;
    drag.slot = null;
    if (!slot) return;
    slot.classList.remove('is-open');
    root.setTimeout(() => slot.remove(), reducedMotion() ? 0 : 200);
  }

  function onPointerMove(event){
    if (!drag || event.pointerId !== drag.pointerId) return;
    if (!drag.started) {
      if (Math.hypot(event.clientX - drag.startX, event.clientY - drag.startY) < DRAG_THRESHOLD) return;
      if (!startDrag(event)) return;
    }
    event.preventDefault();
    moveGhost(event.clientX, event.clientY);
    const over = overSidebar(event.clientX, event.clientY);
    if (over !== drag.over) {
      drag.over = over;
      sidebarElement()?.classList.toggle('fm-pin-drop-over', over);
      drag.ghost.classList.toggle('is-over', over);
      if (over) showSlot(); else hideSlot();
    }
  }

  function stopListening(){
    root.removeEventListener('pointermove', onPointerMove, true);
    root.removeEventListener('pointerup', onPointerUp, true);
    root.removeEventListener('pointercancel', cancelDrag, true);
    root.removeEventListener('keydown', onDragKey, true);
  }

  function suppressNextClick(){
    const block = (event) => { event.preventDefault(); event.stopPropagation(); };
    root.addEventListener('click', block, { capture:true, once:true });
    root.setTimeout(() => root.removeEventListener('click', block, { capture:true }), 400);
  }

  function endDragChrome(){
    document.body.classList.remove('fm-pin-dragging');
    const sidebar = sidebarElement();
    sidebar?.classList.remove('fm-pin-drop-ready', 'fm-pin-drop-over');
  }

  // Moves the ghost onto a rectangle. It is removed afterwards unless `keep`.
  function flyGhost(ghost, rect, options = {}){
    if (!ghost) return Promise.resolve();
    const finish = () => { if (!options.keep) ghost.remove(); };
    if (!rect || reducedMotion()) { finish(); return Promise.resolve(); }
    const x = Math.round(rect.left);
    const y = Math.round(rect.top + Math.max(0, (rect.height - ghost.offsetHeight) / 2));
    const now = ghost.getBoundingClientRect();
    if (!options.fade && Math.abs(now.left - x) < 2 && Math.abs(now.top - y) < 2) { finish(); return Promise.resolve(); }
    return new Promise((resolve) => {
      ghost.classList.add('is-flying');
      if (options.fade) ghost.classList.add('is-fading');
      ghost.style.transform = `translate3d(${x}px, ${y}px, 0)`;
      root.setTimeout(() => { finish(); resolve(); }, 290);
    });
  }

  const nextFrame = () => new Promise((resolve) => (root.requestAnimationFrame ? root.requestAnimationFrame(() => resolve()) : root.setTimeout(resolve, 16)));

  function pulse(target){
    if (!target) return;
    target.classList.remove('fm-pin-landed');
    void target.offsetWidth;
    target.classList.add('fm-pin-landed');
    root.setTimeout(() => target.classList.remove('fm-pin-landed'), 900);
  }

  function cancelDrag(){
    if (!drag) return;
    const current = drag;
    stopListening();
    if (current.started) {
      suppressNextClick();
      hideSlot();
      endDragChrome();
      flyGhost(current.ghost, current.origin, { fade:true });
    }
    drag = null;
  }

  function onDragKey(event){
    if (event.key !== 'Escape' || !drag) return;
    event.preventDefault();
    event.stopPropagation();
    cancelDrag();
  }

  async function onPointerUp(event){
    if (!drag || event.pointerId !== drag.pointerId) return;
    const current = drag;
    stopListening();
    if (!current.started) { drag = null; return; }
    suppressNextClick();
    if (!current.over) { cancelDrag(); return; }
    const { payload, ghost } = current;
    const slot = current.slot;
    const landingRect = slot?.getBoundingClientRect?.() || current.existing?.getBoundingClientRect?.() || null;
    // The ghost parks on the landing slot while the pin saves, then settles
    // onto the real link once the left column has rendered it.
    const parked = flyGhost(ghost, landingRect, { keep:true });
    drag = null;
    endDragChrome();
    current.existing?.classList.remove('fm-pin-drop-target');
    try {
      if (!payload.pinned) {
        if (payload.type === 'subview') {
          arrivingKey = payload.key;
          slot?.remove();
          await setPinned(payload.key, true);
        } else {
          await call('pinApp', payload.appId);
        }
      }
      await parked;
      await nextFrame();
      slot?.remove();
      const target = landedElement(payload);
      if (target) await flyGhost(ghost, target.getBoundingClientRect(), { keep:true });
      ghost.remove();
      arrivingKey = '';
      target?.classList.remove('fm-pin-arriving');
      pulse(target);
      const message = payload.pinned
        ? ((v0) => globalThis.PlatformLanguage?.text("left-column-pins","lcp_already_pinned",`${v0} is already in the left column.`,{v0}) ?? `${v0} is already in the left column.`)(payload.label)
        : ((v0) => globalThis.PlatformLanguage?.text("left-column-pins","lcp_pinned_toast",`${v0} pinned to the left column.`,{v0}) ?? `${v0} pinned to the left column.`)(payload.label);
      announce(message);
      if (!payload.pinned) toast(message);
    } catch (error) {
      arrivingKey = '';
      slot?.remove();
      await parked;
      flyGhost(ghost, current.origin, { fade:true });
      toast(error?.message || (globalThis.PlatformLanguage?.text("left-column-pins","lcp_save_failed","Could not update the left column.") ?? "Could not update the left column."));
    }
  }

  /* ---------- Styles ---------- */

  function ensureStyles(){
    if (document.getElementById('fmLeftColumnPinsStyles')) return;
    const style = document.createElement('style');
    style.id = 'fmLeftColumnPinsStyles';
    style.textContent = `
      .fm-pin-live{position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0 0 0 0);white-space:nowrap}
      @keyframes fmPinLanded{0%{background:rgba(var(--primary-rgb,217,48,37),.16);transform:scale(.96)}60%{background:rgba(var(--primary-rgb,217,48,37),.1);transform:scale(1.02)}100%{background:transparent;transform:scale(1)}}
      .fm-link.fm-pin-landed{animation:fmPinLanded .8s cubic-bezier(.2,.9,.25,1) both}
      .fm-link.fm-pin-arriving{opacity:0}
      .fm-link.fm-pin-drop-target{background:rgba(var(--primary-rgb,217,48,37),.1);box-shadow:inset 0 0 0 1.5px rgba(var(--primary-rgb,217,48,37),.45)}
      /* The thin column widens while the apps overlay is open so each pin sits beside its icon. */
      @media(min-width:821px){
        .sidebar.sidebar-compact.sidebar-manual.sidebar-advanced-apps-open:not(.sidebar-hover-expanded):not(.sidebar-compact-edge-held):not(.sidebar-compact-expanded){width:calc(var(--sidebar-compact,48px) + var(--fm-pin-rail,30px))}
        .sidebar.sidebar-compact.sidebar-manual.sidebar-advanced-apps-open:not(.sidebar-hover-expanded):not(.sidebar-compact-edge-held):not(.sidebar-compact-expanded) #sidebarMainLinks .fm-link{padding-left:36px}
        .sidebar.sidebar-compact.sidebar-manual.sidebar-advanced-apps-open:not(.sidebar-hover-expanded):not(.sidebar-compact-edge-held):not(.sidebar-compact-expanded) #sidebarMainLinks .fm-sidebar-app-pin{left:3px}
        .sidebar.sidebar-compact.sidebar-manual.sidebar-advanced-apps-open:not(.sidebar-hover-expanded):not(.sidebar-compact-edge-held):not(.sidebar-compact-expanded) #sidebarMainLinks .fm-link .ic{transform:none}
      }
      /* Drop target and landing slot */
      #sidebarMainLinks{transition:box-shadow .18s ease,background-color .18s ease}
      .sidebar.fm-pin-drop-ready #sidebarMainLinks{border-radius:12px;box-shadow:inset 0 0 0 1.5px rgba(var(--primary-rgb,217,48,37),.22);background-color:rgba(var(--primary-rgb,217,48,37),.025)}
      .sidebar.fm-pin-drop-over #sidebarMainLinks{box-shadow:inset 0 0 0 2px rgba(var(--primary-rgb,217,48,37),.55);background-color:rgba(var(--primary-rgb,217,48,37),.06)}
      .fm-pin-drop-slot{display:flex;align-items:center;gap:10px;box-sizing:border-box;height:0;min-height:0;margin:-5px 0;padding:0 2px 0 8px;overflow:hidden;border-radius:10px;border:1.5px dashed transparent;color:var(--primary-readable,var(--primary,#d93025));font-size:13px;font-weight:950;white-space:nowrap;opacity:0;transition:height .2s cubic-bezier(.2,.9,.25,1),margin .2s cubic-bezier(.2,.9,.25,1),opacity .16s ease,border-color .16s ease}
      .fm-pin-drop-slot.is-open{height:32px;margin:0;opacity:1;border-color:rgba(var(--primary-rgb,217,48,37),.5);background:rgba(var(--primary-rgb,217,48,37),.07)}
      .fm-pin-drop-slot .ic{width:18px;flex:0 0 18px;text-align:center;font-size:14px}
      .fm-pin-drop-slot .tx{overflow:hidden;text-overflow:ellipsis;opacity:.8}
      body.fm-pin-dragging,body.fm-pin-dragging *{cursor:grabbing!important;user-select:none!important}
      .fm-pin-ghost{position:fixed;z-index:2147483300;left:0;top:0;display:inline-flex;align-items:center;gap:8px;max-width:220px;padding:8px 12px;border-radius:10px;background:#fff;color:#344054;font-size:12px;font-weight:900;white-space:nowrap;pointer-events:none;box-shadow:0 14px 32px rgba(15,23,42,.28),0 0 0 1px rgba(16,24,40,.08);transition:box-shadow .16s ease,color .16s ease;will-change:transform}
      .fm-pin-ghost i{color:var(--primary-readable,var(--primary,#d93025));font-size:14px}
      .fm-pin-ghost span{overflow:hidden;text-overflow:ellipsis}
      .fm-pin-ghost.is-over{box-shadow:0 18px 40px rgba(15,23,42,.32),0 0 0 2px rgba(var(--primary-rgb,217,48,37),.55)}
      .fm-pin-ghost.is-flying{transition:transform .28s cubic-bezier(.2,.9,.25,1),opacity .28s ease,box-shadow .2s ease}
      .fm-pin-ghost.is-fading{opacity:0}
      /* Apps overlay: an app's subviews roll out of its tile */
      .fm-advanced-app-tile.has-subviews{overflow:visible}
      .fm-advanced-app-tile.has-subviews:hover,.fm-advanced-app-tile.has-subviews:focus-within,.fm-advanced-app-tile.has-subviews.is-expanded{z-index:6}
      .fm-advanced-app-subviews-toggle{position:absolute;z-index:4;right:var(--fm-advanced-control-inset,7px);bottom:var(--fm-advanced-control-inset,7px);display:grid;place-items:center;width:var(--fm-advanced-control-size,24px);height:var(--fm-advanced-control-size,24px);padding:0;border:0;border-radius:var(--fm-advanced-control-radius,7px);background:transparent;color:#98a2b3;font-size:var(--fm-advanced-control-font,10px);cursor:pointer;transition:transform .22s cubic-bezier(.2,.9,.2,1),background .16s ease,color .16s ease}
      .fm-advanced-app-subviews-toggle:hover,.fm-advanced-app-subviews-toggle:focus-visible{background:#f2f4f7;color:#344054;outline:none}
      .fm-advanced-app-subviews{position:absolute;z-index:7;left:50%;top:calc(100% + 8px);width:max(190px,min(250px,var(--fm-advanced-tile-size,120px)));visibility:hidden;opacity:0;pointer-events:none;transform:translate(-50%,-8px) scale(.96);transform-origin:50% 0;transition:visibility 0s linear .2s,opacity .16s ease,transform .24s cubic-bezier(.2,.9,.2,1)}
      .fm-advanced-app-subviews:before{position:absolute;left:0;right:0;top:-10px;height:10px;content:""}
      .fm-advanced-app-tile.subviews-above .fm-advanced-app-subviews{top:auto;bottom:calc(100% + 8px);transform:translate(-50%,8px) scale(.96);transform-origin:50% 100%}
      .fm-advanced-app-tile.subviews-above .fm-advanced-app-subviews:before{top:auto;bottom:-10px}
      .fm-advanced-app-subviews-card{display:grid;gap:2px;padding:6px;border:1px solid #eaecf0;border-radius:12px;background:#fff;box-shadow:0 18px 38px rgba(0,0,0,.3)}
      .fm-advanced-subview{display:grid;grid-template-columns:28px minmax(0,1fr);align-items:center;gap:2px;border-radius:9px;opacity:0;transform:translateY(-4px);transition:opacity .16s ease,transform .22s cubic-bezier(.2,.9,.2,1),background .14s ease}
      .fm-advanced-subview:hover,.fm-advanced-subview:focus-within{background:#f2f4f7}
      .fm-advanced-subview-pin{display:grid;place-items:center;width:26px;height:26px;margin-left:2px;padding:0;border:0;border-radius:7px;background:transparent;color:#98a2b3;font-size:11px;cursor:pointer;transform:rotate(-12deg);transition:transform .18s cubic-bezier(.2,.9,.2,1),background .16s ease,color .16s ease,box-shadow .16s ease}
      .fm-advanced-subview-pin:hover,.fm-advanced-subview-pin:focus-visible{color:#344054;outline:none;transform:rotate(-12deg) scale(1.12)}
      .fm-advanced-subview-pin.is-pinned{background:#344054;color:#fff;box-shadow:0 3px 8px rgba(15,23,42,.22)}
      .fm-advanced-subview-pin.is-pinned:hover,.fm-advanced-subview-pin.is-pinned:focus-visible{background:var(--primary-readable,var(--primary,#d93025));color:#fff}
      .fm-advanced-subview-pin:disabled{opacity:.55;cursor:wait}
      .fm-advanced-subview-open{display:flex;align-items:center;gap:9px;min-width:0;padding:8px 8px 8px 4px;border:0;border-radius:8px;background:transparent;color:#344054;font:inherit;font-size:12px;font-weight:850;text-align:left;cursor:pointer}
      .fm-advanced-subview-open i{width:16px;flex:0 0 16px;color:#667085;text-align:center}
      .fm-advanced-subview-open span{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
      .fm-advanced-subview-open:hover,.fm-advanced-subview-open:focus-visible{color:#101828;outline:none}
      .fm-advanced-subview-open:focus-visible{box-shadow:inset 0 0 0 2px rgba(53,56,205,.42)}
      .fm-advanced-app-tile.is-expanded .fm-advanced-app-subviews-toggle{transform:rotate(180deg);color:#344054}
      .fm-advanced-app-tile.is-expanded .fm-advanced-app-subviews,
      .fm-advanced-app-tile.has-subviews:focus-within .fm-advanced-app-subviews{visibility:visible;opacity:1;pointer-events:auto;transform:translate(-50%,0) scale(1);transition-delay:0s}
      .fm-advanced-app-tile.is-expanded .fm-advanced-subview,
      .fm-advanced-app-tile.has-subviews:focus-within .fm-advanced-subview{opacity:1;transform:none;transition-delay:calc(var(--i,0) * 35ms + 40ms)}
      @media(hover:hover) and (pointer:fine){
        .fm-advanced-app-tile.has-subviews:hover .fm-advanced-app-subviews{visibility:visible;opacity:1;pointer-events:auto;transform:translate(-50%,0) scale(1);transition-delay:0s}
        .fm-advanced-app-tile.has-subviews:hover .fm-advanced-subview{opacity:1;transform:none;transition-delay:calc(var(--i,0) * 35ms + 40ms)}
        .fm-advanced-app-tile.has-subviews:hover .fm-advanced-app-subviews-toggle{transform:rotate(180deg);color:#344054}
      }
      @media(prefers-reduced-motion:reduce){
        .fm-link.fm-pin-landed{animation:none;background:rgba(var(--primary-rgb,217,48,37),.1)}
        .fm-pin-drop-slot,.fm-pin-ghost,.fm-pin-ghost.is-flying,.fm-advanced-app-subviews,.fm-advanced-subview,.fm-advanced-app-subviews-toggle,.fm-advanced-subview-pin,#sidebarMainLinks{transition:none!important}
      }
    `;
    document.head.appendChild(style);
  }

  function configure(next = {}){
    Object.assign(hooks, next);
    ensureStyles();
  }

  root.addEventListener('fm:route-state:updated', () => syncActive());
  root.addEventListener('fm:user-preferences:updated', () => {
    const signature = JSON.stringify(pinnedKeys());
    if (signature !== lastPinsSignature) emitPinsUpdated();
  });
  document.addEventListener('pointerdown', onPointerDown, true);

  root.FirstMateLeftColumnPins = {
    preferenceKey:PREFERENCE_KEY,
    configure,
    subviews,
    subviewByKey,
    pinnedKeys,
    pinnedSubviews,
    isPinned,
    setPinned,
    open,
    routeMatches,
    syncActive,
    sidebarLink,
    overlayTileExtras,
    bindOverlay,
    ensureStyles
  };
})(window);
