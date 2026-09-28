/* public/libraries/apps/canvassing/app.js
 * Canvassing management tab for Platform.
 *
 * This is a manager surface for branch canvassing pins and settings. The mobile
 * canvasser app uses the same CanvassingAPI library and pin model.
 */
(function(){
  const Portal = window.Portal || {};
  const util = Portal.util || {};
  const $ = util.$ || ((sel, root=document) => root.querySelector(sel));
  const escapeHtml = util.escapeHtml || ((value) => String(value ?? ''));
  const APP = window.__APP || {};

  const state = {
    mounted: false,
    root: null,
    map: null,
    markerLayer: null,
    pins: [],
    settings: null,
    activeStatus: 'all'
  };

  function orgId(){ return String(APP.userOrgId || '').trim(); }
  function branchId(){ return String(window.Portal?.branchModules?.currentBranchId?.() || APP.userBranchId || APP.branchId || 'default').trim() || 'default'; }

  function toast(title, body, ok = true){
    if (window.Portal?.ui?.showToast) window.Portal.ui.showToast(title, body, ok);
  }

  function injectCss(){
    const css = `
      .canvassing-shell{height:100%;display:grid;grid-template-columns:minmax(320px,390px) 1fr;background:#f6f7f9;min-height:0}
      .canvassing-side{background:#fff;border-right:1px solid var(--border,#dadce0);display:flex;flex-direction:column;min-height:0}
      .canvassing-head{padding:18px 18px 12px;border-bottom:1px solid var(--border,#dadce0)}
      .canvassing-head h2{margin:0;font-size:20px;letter-spacing:0;font-weight:1000;color:#202124}
      .canvassing-head p{margin:6px 0 0;color:#6b7280;font-size:13px;font-weight:750;line-height:1.35}
      .canvassing-actions{display:flex;gap:8px;margin-top:14px}
      .canvassing-actions button,.canvassing-btn{border:1px solid var(--border,#dadce0);background:#fff;border-radius:8px;padding:9px 11px;font-weight:950;cursor:pointer;color:#202124}
      .canvassing-actions .primary,.canvassing-btn.primary{background:var(--primary,#d93025);border-color:var(--primary,#d93025);color:#fff}
      .canvassing-stats{display:grid;grid-template-columns:repeat(3,1fr);gap:8px;padding:12px 18px;border-bottom:1px solid var(--border,#dadce0)}
      .canvassing-stat{background:#f8fafc;border:1px solid #e5e7eb;border-radius:8px;padding:10px}
      .canvassing-stat .num{font-size:20px;font-weight:1000;color:#111827}
      .canvassing-stat .lbl{font-size:11px;font-weight:900;text-transform:uppercase;color:#6b7280;margin-top:2px}
      .canvassing-filter{display:flex;gap:8px;overflow:auto;padding:12px 18px;border-bottom:1px solid var(--border,#dadce0)}
      .canvassing-chip{white-space:nowrap;border:1px solid #d1d5db;background:#fff;border-radius:999px;padding:7px 10px;font-size:12px;font-weight:950;cursor:pointer}
      .canvassing-chip.active{background:#111827;color:#fff;border-color:#111827}
      .canvassing-list{overflow:auto;padding:10px 12px;display:flex;flex-direction:column;gap:8px;min-height:0}
      .canvassing-pin-row{border:1px solid #e5e7eb;background:#fff;border-radius:8px;padding:11px;cursor:pointer}
      .canvassing-pin-row:hover{border-color:#cbd5e1;background:#fbfdff}
      .canvassing-pin-row .top{display:flex;justify-content:space-between;gap:10px;align-items:start}
      .canvassing-pin-row .title{font-weight:1000;color:#111827;font-size:13px;line-height:1.2}
      .canvassing-pin-row .meta{font-size:12px;color:#6b7280;font-weight:750;margin-top:5px;line-height:1.35}
      .canvassing-status-dot{width:10px;height:10px;border-radius:50%;display:inline-block;margin-right:6px;box-shadow:0 0 0 2px #fff,0 0 0 3px rgba(0,0,0,.16)}
      .canvassing-map-wrap{position:relative;min-width:0;min-height:0}
      #canvassingMap{position:absolute;inset:0;background:#e5e7eb}
      .canvassing-panel{position:absolute;right:14px;top:14px;width:min(360px,calc(100% - 28px));background:#fff;border:1px solid rgba(0,0,0,.08);box-shadow:0 16px 40px rgba(0,0,0,.14);border-radius:8px;display:none;z-index:800}
      .canvassing-panel.open{display:block}
      .canvassing-panel .inner{padding:14px}
      .canvassing-panel h3{margin:0 0 10px;font-size:15px;font-weight:1000;color:#111827}
      .canvassing-field{display:flex;flex-direction:column;gap:6px;margin-bottom:10px}
      .canvassing-field label{font-size:11px;font-weight:950;text-transform:uppercase;color:#6b7280}
      .canvassing-field input,.canvassing-field textarea,.canvassing-field select{border:1px solid #d1d5db;border-radius:8px;padding:9px 10px;font:inherit;font-size:13px;background:#fff}
      .canvassing-field textarea{min-height:70px;resize:vertical}
      .canvassing-panel-actions{display:flex;gap:8px;margin-top:12px}
      .canvassing-panel-actions button{flex:1}
      .canvassing-settings{border-top:1px solid #e5e7eb;padding-top:12px;margin-top:12px}
      .canvassing-status-grid{display:grid;grid-template-columns:1fr auto;gap:8px;align-items:center}
      @media(max-width:900px){.canvassing-shell{grid-template-columns:1fr}.canvassing-side{height:45vh;border-right:0;border-bottom:1px solid var(--border,#dadce0)}.canvassing-map-wrap{height:55vh}}
      @media(max-width:820px){body:has(.mobile-topbar.has-tab-title) .canvassing-head h2,body:has(.mobile-topbar.has-tab-title) .canvassing-head p{display:none}.canvassing-head{padding-top:12px}}
    `;
    if (util.injectCSS) util.injectCSS('canvassing_tab', css);
    else {
      const style = document.createElement('style');
      style.textContent = css;
      document.head.appendChild(style);
    }
  }

  async function ensureLeaflet(){
    if (window.L) return;
    if (!document.querySelector('link[data-canvassing-leaflet]')) {
      const link = document.createElement('link');
      link.rel = 'stylesheet';
      link.href = 'https://unpkg.com/leaflet@1.9.4/dist/leaflet.css';
      link.dataset.canvassingLeaflet = '1';
      document.head.appendChild(link);
    }
    await new Promise((resolve, reject) => {
      const existing = document.querySelector('script[data-canvassing-leaflet]');
      if (existing) {
        existing.addEventListener('load', resolve, { once:true });
        existing.addEventListener('error', reject, { once:true });
        return;
      }
      const script = document.createElement('script');
      script.src = 'https://unpkg.com/leaflet@1.9.4/dist/leaflet.js';
      script.dataset.canvassingLeaflet = '1';
      script.onload = resolve;
      script.onerror = reject;
      document.head.appendChild(script);
    });
  }

  function statusById(id){
    return (state.settings?.statuses || []).find((status) => String(status.id) === String(id)) || {};
  }

  function statusLabel(id){
    const status = statusById(id);
    return status.label || String(id || '').replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
  }

  function statusColor(id){
    return statusById(id).color || '#2563eb';
  }

  function filteredPins(){
    return state.pins.filter((pin) => state.activeStatus === 'all' || pin.status_id === state.activeStatus);
  }

  function pinTitle(pin){
    return pin.title || pin.address || `${Number(pin.coordinates?.lat || 0).toFixed(5)}, ${Number(pin.coordinates?.lng || 0).toFixed(5)}`;
  }

  function renderStats(root){
    const total = state.pins.length;
    const leadCount = state.pins.filter((pin) => pin.platform_project_id).length;
    const today = new Date().toISOString().slice(0,10);
    const todayCount = state.pins.filter((pin) => String(pin.updated_at || '').slice(0,10) === today).length;
    $('.canvassing-stats', root).innerHTML = [
      ['Pins', total],
      ['Today', todayCount],
      ['Leads', leadCount]
    ].map(([label, num]) => `<div class="canvassing-stat"><div class="num">${num}</div><div class="lbl">${label}</div></div>`).join('');
  }

  function renderFilters(root){
    const statuses = state.settings?.statuses || [];
    const chips = [{ id:'all', label:(globalThis.PlatformLanguage?.text("canvassing","m_61df468d92e238","All") ?? "All") }, ...statuses.filter((status) => status.id !== 'deleted')];
    $('.canvassing-filter', root).innerHTML = chips.map((status) => `
      <button class="canvassing-chip ${state.activeStatus === status.id ? 'active' : ''}" data-status="${escapeHtml(status.id)}">
        ${status.id !== 'all' ? `<span class="canvassing-status-dot" style="background:${escapeHtml(status.color || statusColor(status.id))}"></span>` : ''}
        ${escapeHtml(status.label)}
      </button>
    `).join('');
    $('.canvassing-filter', root).querySelectorAll('[data-status]').forEach((button) => {
      button.addEventListener('click', () => {
        state.activeStatus = button.dataset.status || 'all';
        window.Portal?.navigation?.replace?.({ canvassingStatus:state.activeStatus === 'all' ? null : state.activeStatus }, { source:'canvassing-filter', ownedKeys:['canvassingStatus'] });
        render(root);
      });
    });
  }

  function renderList(root){
    const pins = filteredPins();
    $('.canvassing-list', root).innerHTML = pins.length ? pins.map((pin) => `
      <div class="canvassing-pin-row" data-pin-id="${escapeHtml(pin.id)}">
        <div class="top">
          <div>
            <div class="title">${escapeHtml(pinTitle(pin))}</div>
            <div class="meta"><span class="canvassing-status-dot" style="background:${escapeHtml(statusColor(pin.status_id))}"></span>${escapeHtml(statusLabel(pin.status_id))}</div>
          </div>
          <div class="meta">${escapeHtml(new Date(pin.updated_at || Date.now()).toLocaleDateString(globalThis.PlatformLanguage?.formatLocale?.()))}</div>
        </div>
        <div class="meta">${escapeHtml(pin.contact?.name || pin.contact?.phone || pin.notes || '')}</div>
      </div>
    `).join('') : `<div class="canvassing-pin-row"><div class="title">${(globalThis.PlatformLanguage?.htmlText("canvassing","m_1e41b6ab3f6265","No pins yet") ?? "No pins yet")}</div><div class="meta">${(globalThis.PlatformLanguage?.htmlText("canvassing","m_99c929975502fe","Click the map to create the first canvassing pin.") ?? "Click the map to create the first canvassing pin.")}</div></div>`;
    $('.canvassing-list', root).querySelectorAll('[data-pin-id]').forEach((row) => {
      row.addEventListener('click', () => openPinPanel(state.pins.find((pin) => pin.id === row.dataset.pinId)));
    });
  }

  function markerIcon(pin){
    const color = statusColor(pin.status_id);
    return window.L.divIcon({
      className: 'canvassing-marker',
      html: `<div style="width:18px;height:18px;border-radius:50%;background:${color};border:3px solid #fff;box-shadow:0 2px 8px rgba(0,0,0,.35)"></div>`,
      iconSize: [24,24],
      iconAnchor: [12,12]
    });
  }

  function renderMarkers(){
    if (!state.map || !state.markerLayer) return;
    state.markerLayer.clearLayers();
    filteredPins().forEach((pin) => {
      const lat = Number(pin.coordinates?.lat);
      const lng = Number(pin.coordinates?.lng);
      if (!Number.isFinite(lat) || !Number.isFinite(lng)) return;
      const marker = window.L.marker([lat, lng], { icon: markerIcon(pin) });
      marker.on('click', () => openPinPanel(pin));
      state.markerLayer.addLayer(marker);
    });
  }

  function render(root){
    renderStats(root);
    renderFilters(root);
    renderList(root);
    renderMarkers();
  }

  async function load(root){
    if (!orgId()) return;
    const result = await window.CanvassingAPI.pins.list(orgId(), branchId());
    state.pins = result.pins || [];
    state.settings = result.settings || (await window.CanvassingAPI.settings.get(orgId(), branchId())).settings;
    render(root);
  }

  function closePinPanel(options = {}){
    $('#canvassingPinPanel')?.classList.remove('open');
    if (!options.fromRoute && !window.Portal?.navigation?.applying) {
      window.Portal?.navigation?.backOrClose?.(['pin'], { pin:null }, { source:'canvassing-pin-close' });
    }
  }

  function openPinPanel(pin = null, coordinates = null, options = {}){
    const panel = $('#canvassingPinPanel');
    if (!panel) return;
    const statuses = (state.settings?.statuses || []).filter((status) => status.id !== 'deleted');
    const contact = pin?.contact || {};
    panel.dataset.pinId = pin?.id || '';
    panel.dataset.lat = coordinates?.lat ?? pin?.coordinates?.lat ?? '';
    panel.dataset.lng = coordinates?.lng ?? pin?.coordinates?.lng ?? '';
    panel.classList.add('open');
    if (!options.fromRoute && pin?.id) window.Portal?.navigation?.push?.({ tab:'canvassing', pin:pin.id }, { source:'canvassing-pin-open', ownedKeys:['pin'] });
    panel.innerHTML = `
      <div class="inner">
        <h3>${String(pin ? 'Canvassing Pin' : 'New Pin')}</h3>
        <div class="canvassing-field"><label>${(globalThis.PlatformLanguage?.htmlText("canvassing","m_1352cafa75b8da","Status") ?? "Status")}</label><select id="canvassingPinStatus">${String(statuses.map((status) => `<option value="${escapeHtml(status.id)}" ${String(pin?.status_id || state.settings?.default_status_id || 'new') === String(status.id) ? 'selected' : ''}>${escapeHtml(status.label)}</option>`).join(''))}</select></div>
        <div class="canvassing-field"><label>${(globalThis.PlatformLanguage?.htmlText("canvassing","m_53d803cdbe9ab1","Address") ?? "Address")}</label><input id="canvassingPinAddress" value="${String(escapeHtml(pin?.address || ''))}" placeholder="${(globalThis.PlatformLanguage?.htmlText("canvassing","m_5a1140e15aac38","Address or nearest property") ?? "Address or nearest property")}"></div>
        <div class="canvassing-field"><label>${(globalThis.PlatformLanguage?.htmlText("canvassing","m_46c8aea84388c3","Contact") ?? "Contact")}</label><input id="canvassingPinName" value="${String(escapeHtml(contact.name || ''))}" placeholder="${(globalThis.PlatformLanguage?.htmlText("canvassing","m_8cf345002184e5","Name") ?? "Name")}"></div>
        <div class="canvassing-field"><label>${(globalThis.PlatformLanguage?.htmlText("canvassing","m_ed04c65845180f","Phone") ?? "Phone")}</label><input id="canvassingPinPhone" value="${String(escapeHtml(contact.phone || ''))}" placeholder="${(globalThis.PlatformLanguage?.htmlText("canvassing","m_ed04c65845180f","Phone") ?? "Phone")}"></div>
        <div class="canvassing-field"><label>${(globalThis.PlatformLanguage?.htmlText("canvassing","m_de7d6168ae1ad6","Notes") ?? "Notes")}</label><textarea id="canvassingPinNotes" placeholder="${(globalThis.PlatformLanguage?.htmlText("canvassing","m_de7d6168ae1ad6","Notes") ?? "Notes")}">${String(escapeHtml(pin?.notes || ''))}</textarea></div>
        <div class="canvassing-panel-actions">
          <button class="canvassing-btn" id="canvassingClosePin">${(globalThis.PlatformLanguage?.htmlText("canvassing","m_3742924668fb10","Close") ?? "Close")}</button>
          <button class="canvassing-btn primary" id="canvassingSavePin">${(globalThis.PlatformLanguage?.htmlText("canvassing","m_5bab3e72de1ebf","Save") ?? "Save")}</button>
        </div>
        ${String(pin ? `<div class="canvassing-panel-actions"><button class="canvassing-btn primary" id="canvassingPromotePin">${(globalThis.PlatformLanguage?.htmlText("canvassing","m_c97dbb6c0270fb","Create Lead") ?? "Create Lead")}</button><button class="canvassing-btn" id="canvassingDeletePin">${(globalThis.PlatformLanguage?.htmlText("canvassing","m_4fc60207629a44","Delete") ?? "Delete")}</button></div>` : '')}
      </div>
    `;
    $('#canvassingClosePin').addEventListener('click', () => closePinPanel());
    $('#canvassingSavePin').addEventListener('click', () => savePanelPin());
    $('#canvassingPromotePin')?.addEventListener('click', () => promotePanelPin());
    $('#canvassingDeletePin')?.addEventListener('click', () => deletePanelPin());
  }

  function panelPinPayload(){
    const panel = $('#canvassingPinPanel');
    const pinId = panel?.dataset.pinId || '';
    return {
      ...(pinId ? { id: pinId } : {}),
      coordinates: {
        lat: Number(panel?.dataset.lat),
        lng: Number(panel?.dataset.lng)
      },
      status_id: $('#canvassingPinStatus')?.value || 'new',
      address: $('#canvassingPinAddress')?.value || '',
      contact: {
        name: $('#canvassingPinName')?.value || '',
        phone: $('#canvassingPinPhone')?.value || ''
      },
      notes: $('#canvassingPinNotes')?.value || ''
    };
  }

  async function savePanelPin(){
    const payload = panelPinPayload();
    if (!Number.isFinite(payload.coordinates.lat) || !Number.isFinite(payload.coordinates.lng)) {
      toast((globalThis.PlatformLanguage?.text("canvassing","m_c8563e08f09a81","Missing location") ?? "Missing location"), (globalThis.PlatformLanguage?.text("canvassing","m_4356dd392ba95a","A canvassing pin needs map coordinates.") ?? "A canvassing pin needs map coordinates."), false);
      return;
    }
    try {
      const result = payload.id
        ? await window.CanvassingAPI.pins.patch(orgId(), branchId(), payload.id, payload)
        : await window.CanvassingAPI.pins.create(orgId(), branchId(), payload);
      closePinPanel();
      await load(document.getElementById('tab_canvassing'));
      toast((globalThis.PlatformLanguage?.text("canvassing","m_ef132e8733d91b","Pin saved") ?? "Pin saved"), result.pin?.address || result.pin?.status_label || 'Canvassing pin updated.');
    } catch (error) {
      toast((globalThis.PlatformLanguage?.text("canvassing","m_8247bf44835dd1","Pin save failed") ?? "Pin save failed"), error.message, false);
    }
  }

  async function promotePanelPin(){
    const payload = panelPinPayload();
    if (!payload.id) return;
    try {
      await window.CanvassingAPI.pins.promote(orgId(), branchId(), payload.id, payload);
      closePinPanel();
      await load(document.getElementById('tab_canvassing'));
      toast((globalThis.PlatformLanguage?.text("canvassing","m_546e337a0ad168","Lead created") ?? "Lead created"), payload.address || 'The canvassing pin is now a Platform lead.');
    } catch (error) {
      toast((globalThis.PlatformLanguage?.text("canvassing","m_f0680f044b3c64","Lead creation failed") ?? "Lead creation failed"), error.message, false);
    }
  }

  async function deletePanelPin(){
    const pinId = $('#canvassingPinPanel')?.dataset.pinId || '';
    if (!pinId) return;
    try {
      await window.CanvassingAPI.pins.remove(orgId(), branchId(), pinId);
      closePinPanel();
      await load(document.getElementById('tab_canvassing'));
      toast((globalThis.PlatformLanguage?.text("canvassing","m_6d3a2ea4f71a36","Pin deleted") ?? "Pin deleted"), (globalThis.PlatformLanguage?.text("canvassing","m_927411b5fb78a2","The canvassing pin was removed.") ?? "The canvassing pin was removed."));
    } catch (error) {
      toast((globalThis.PlatformLanguage?.text("canvassing","m_cf2c70cfda409b","Delete failed") ?? "Delete failed"), error.message, false);
    }
  }

  async function initMap(root){
    await ensureLeaflet();
    if (state.map) {
      setTimeout(() => state.map.invalidateSize(), 80);
      return;
    }
    state.map = window.L.map('canvassingMap', { zoomControl: true }).setView([47.6062, -122.3321], 10);
    window.L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
      maxZoom: 19,
      attribution: '&copy; OpenStreetMap'
    }).addTo(state.map);
    state.markerLayer = window.L.layerGroup().addTo(state.map);
    state.map.on('click', async (event) => {
      const coordinates = { lat: event.latlng.lat, lng: event.latlng.lng };
      openPinPanel(null, coordinates);
      try {
        const geo = await window.CanvassingAPI.geocode.reverse(coordinates.lat, coordinates.lng);
        const address = geo?.result?.display_name || '';
        const input = $('#canvassingPinAddress');
        if (input && !input.value) input.value = address;
      } catch {}
    });
    setTimeout(() => state.map.invalidateSize(), 120);
    renderMarkers();
  }

  function mount(root){
    injectCss();
    state.root = root;
    state.activeStatus = window.Portal?.navigation?.read?.().canvassingStatus || 'all';
    root.innerHTML = `
      <div class="canvassing-shell">
        <section class="canvassing-side">
          <div class="canvassing-head">
            <h2>${(globalThis.PlatformLanguage?.htmlText("canvassing","m_88f66f0b968bb2","Canvassing") ?? "Canvassing")}</h2>
            <p>${(globalThis.PlatformLanguage?.htmlText("canvassing","m_4fbc4684a1260c","Manage branch canvassers, field pins, and promote promising doors into Platform leads.") ?? "Manage branch canvassers, field pins, and promote promising doors into Platform leads.")}</p>
            <div class="canvassing-actions">
              <button class="primary" id="canvassingRefresh"><i class="fas fa-rotate"></i>${(globalThis.PlatformLanguage?.htmlText("canvassing","m_4f524800833039"," Refresh") ?? " Refresh")}</button>
              <a class="canvassing-btn" href="/apps/canvassing/" target="_blank"><i class="fas fa-mobile-screen"></i>${(globalThis.PlatformLanguage?.htmlText("canvassing","m_d220fd8b0204c9"," App") ?? " App")}</a>
            </div>
          </div>
          <div class="canvassing-stats"></div>
          <div class="canvassing-filter"></div>
          <div class="canvassing-list"></div>
        </section>
        <section class="canvassing-map-wrap">
          <div id="canvassingMap"></div>
          <div class="canvassing-panel" id="canvassingPinPanel"></div>
        </section>
      </div>
    `;
    $('#canvassingRefresh', root).addEventListener('click', () => load(root).catch((error) => toast((globalThis.PlatformLanguage?.text("canvassing","m_0d3ee333048643","Refresh failed") ?? "Refresh failed"), error.message, false)));
    load(root).then(() => { initMap(root); restorePinRoute(); }).catch((error) => {
      root.querySelector('.canvassing-list').innerHTML = `<div class="canvassing-pin-row"><div class="title">${(globalThis.PlatformLanguage?.htmlText("canvassing","m_5998d9f05fec0a","Canvassing unavailable") ?? "Canvassing unavailable")}</div><div class="meta">${String(escapeHtml(error.message))}</div></div>`;
    });
  }

  function onShow(){
    if (state.map) setTimeout(() => state.map.invalidateSize(), 80);
  }

  function restorePinRoute(route = window.Portal?.navigation?.read?.() || {}){
    const nextStatus = route.canvassingStatus || 'all';
    if (nextStatus !== state.activeStatus) { state.activeStatus = nextStatus; if (state.root) render(state.root); }
    if (route.tab !== 'canvassing' || !route.pin) {
      if ($('#canvassingPinPanel')?.classList.contains('open')) closePinPanel({ fromRoute:true });
      return;
    }
    const pin = state.pins.find((item) => String(item.id) === String(route.pin));
    if (pin) openPinPanel(pin, null, { fromRoute:true });
  }
  window.Portal?.navigation?.registerHandler?.('canvassing-pin', { priority:450, apply:restorePinRoute });

  let tabRegistered = false;
  let syncTimer = null;
  let pendingSync = false;
  function appsReady(){
    return !!window.Portal?.apps?.registerPortalApp && !!window.Portal?.tabs?.renderTabs && !!document.getElementById('mainPanels');
  }

  function queueSync(delay = 0){
    if (syncTimer) clearTimeout(syncTimer);
    syncTimer = setTimeout(() => {
      syncTimer = null;
      syncCanvassingTab();
    }, delay);
  }

  function registerCanvassingTab(){
    if (tabRegistered) return;
    if (!appsReady()) {
      queueSync(100);
      return;
    }
    tabRegistered = true;
    window.Portal.apps.registerPortalApp({
      id: 'portal.canvassing',
      tabId: 'canvassing',
      title: (globalThis.PlatformLanguage?.text("canvassing","m_88f66f0b968bb2","Canvassing") ?? "Canvassing"),
      icon: 'fa-map-location-dot',
      order: 55,
      fullBleed: true,
      mount,
      onShow
    });
    window.Portal.tabs.renderTabs?.();
  }

  function unregisterCanvassingTab(){
    if (!tabRegistered || !window.Portal?.apps?.unregisterPortalApp) return;
    tabRegistered = false;
    window.Portal.apps.unregisterPortalApp('canvassing');
  }

  async function syncCanvassingTab(){
    if (pendingSync) return;
    if (!orgId() || !window.CanvassingAPI?.settings) {
      queueSync(150);
      return;
    }
    pendingSync = true;
    try {
      if (window.Portal?.appFlags?.load) await window.Portal.appFlags.load();
      if (window.Portal?.appFlags?.has && !window.Portal.appFlags.has('canvassing', 'app')) {
        unregisterCanvassingTab();
        return;
      }
      const result = await window.CanvassingAPI.settings.get(orgId(), branchId());
      if (result?.settings?.enabled === false) unregisterCanvassingTab();
      else registerCanvassingTab();
    } catch (error) {
      const status = Number(error?.status || 0);
      const code = String(error?.data?.error || error?.message || '').toLowerCase();
      if (status === 403 && (code.includes('app_flag_disabled') || code.includes('canvassing_disabled'))) {
        unregisterCanvassingTab();
      } else {
        registerCanvassingTab();
      }
    } finally {
      pendingSync = false;
    }
  }

  window.addEventListener('fm:canvassing:settings-changed', (event) => {
    if (event?.detail?.enabled === false) unregisterCanvassingTab();
    else queueSync();
  });

  window.addEventListener('fm:platform-session:updated', () => queueSync());
  window.addEventListener('fm:app-flags:updated', () => queueSync());
  window.addEventListener('fm:perms:updated', () => queueSync());
  document.addEventListener('DOMContentLoaded', () => queueSync());
  queueSync();
})();
