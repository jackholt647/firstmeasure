/* libraries/canvassing-app/canvassing-app.js
 * Reusable mobile canvassing UI.
 *
 * This library renders the shared canvassing experience: map, legend, pin sheet,
 * pin create/update/promote flows, and the manager/users screen. It does not own
 * authentication. Wrappers such as public/apps/canvassing/app.js authenticate
 * with PlatformAPI, then mount this renderer with an authenticated session.
 *
 * Required globals/dependencies:
 *   - Leaflet as window.L
 *   - window.CanvassingAPI, or pass canvassingApi
 *
 * Basic wrapper usage:
 *   const app = FirstMateCanvassingApp.mount({
 *     root: document.getElementById('app'),
 *     session,
 *     platformApi: window.PlatformAPI,
 *     canvassingApi: window.CanvassingAPI,
 *     branchId: 'default',
 *     onLogout: async () => { ... }
 *   });
 */
(function(){
  const rootWindow = window;

  function cleanText(value){ return String(value ?? '').trim(); }
  function escapeHtml(value){
    return cleanText(value)
      .replaceAll('&','&amp;')
      .replaceAll('<','&lt;')
      .replaceAll('>','&gt;')
      .replaceAll('"','&quot;')
      .replaceAll("'","&#039;");
  }
  function $(sel, root=document){ return root.querySelector(sel); }

  const DEFAULT_COORDS = [47.6062, -122.3321];

  function injectCss(){
    if (document.querySelector('style[data-firstmate-canvassing-app]')) return;
    const style = document.createElement('style');
    style.dataset.firstmateCanvassingApp = '1';
    style.textContent = `
      .fmc-app,.fmc-app *{box-sizing:border-box}
      .fmc-app{height:100%;min-height:0;overflow:hidden;font-family:Inter,system-ui,-apple-system,Segoe UI,Roboto,Arial,sans-serif;background:#f6f7f9;color:#111827}
      .fmc-app button,.fmc-app input,.fmc-app select,.fmc-app textarea{font:inherit;border-radius:8px}
      .fmc-app button{border:1px solid #d1d5db;background:#fff;padding:11px;font-weight:950;cursor:pointer}
      .fmc-app button.primary{background:var(--fmc-primary,#d93025);border-color:var(--fmc-primary,#d93025);color:#fff}
      .fmc-app button.ghost{background:#fff;color:#374151}
      .fmc-app button.icon{width:42px;height:42px;display:grid;place-items:center;padding:0;border-radius:10px}
      .fmc-app input,.fmc-app select,.fmc-app textarea{width:100%;border:1px solid #d1d5db;padding:10px;background:#fff}
      .fmc-app textarea{min-height:72px;resize:vertical}
      .fmc-app label{font-size:11px;text-transform:uppercase;font-weight:950;color:#6b7280;display:block;margin:9px 0 5px}
      .fmc-shell{height:100%;display:flex;flex-direction:column;min-height:0}
      .fmc-top{height:56px;display:flex;align-items:center;justify-content:space-between;padding:0 12px;background:#fff;border-bottom:1px solid #e5e7eb;z-index:20;gap:8px;flex-shrink:0}
      .fmc-brand{display:flex;align-items:center;gap:9px;font-weight:1000}
      .fmc-brand .mark{width:30px;height:30px;border-radius:8px;background:var(--fmc-primary,#d93025);color:#fff;display:grid;place-items:center}
      .fmc-tabs{display:flex;gap:6px}
      .fmc-tabs button{padding:8px 10px;border-radius:999px;font-size:13px}
      .fmc-tabs button.active{background:#111827;color:#fff;border-color:#111827}
      .fmc-content{flex:1;min-height:0}
      .fmc-map-view{position:relative;height:100%;min-height:0}
      .fmc-map{position:absolute;inset:0;background:#e5e7eb}
      .fmc-legend{position:absolute;left:10px;right:10px;bottom:10px;display:flex;gap:8px;overflow:auto;z-index:900;pointer-events:none}
      .fmc-chip{background:#fff;border:1px solid #e5e7eb;border-radius:999px;padding:7px 10px;font-size:12px;font-weight:900;box-shadow:0 4px 14px rgba(0,0,0,.12);white-space:nowrap}
      .fmc-dot{display:inline-block;width:9px;height:9px;border-radius:50%;margin-right:5px}
      .fmc-sheet{position:fixed;left:10px;right:10px;bottom:10px;background:#fff;border:1px solid rgba(0,0,0,.08);box-shadow:0 18px 50px rgba(0,0,0,.2);border-radius:10px;padding:12px;z-index:1000;display:none;max-height:calc(100vh - 76px);overflow:auto}
      .fmc-sheet.open{display:block}
      .fmc-row{display:flex;gap:8px}.fmc-row>*{flex:1}
      .fmc-manager{height:100%;overflow:auto;padding:14px;background:#f6f7f9}
      .fmc-panel{background:#fff;border:1px solid #e5e7eb;border-radius:10px;padding:14px;margin-bottom:12px}
      .fmc-panel h2{margin:0 0 8px;font-size:18px;font-weight:1000}
      .fmc-statgrid{display:grid;grid-template-columns:repeat(3,1fr);gap:8px}
      .fmc-stat{background:#f8fafc;border:1px solid #e5e7eb;border-radius:8px;padding:10px}
      .fmc-stat .num{font-weight:1000;font-size:22px}.fmc-stat .lbl{font-size:11px;text-transform:uppercase;color:#6b7280;font-weight:900}
      .fmc-user-row{display:flex;justify-content:space-between;gap:10px;align-items:center;border-top:1px solid #f1f5f9;padding:10px 0}
      .fmc-user-row:first-child{border-top:0}
      .fmc-muted{color:#6b7280;font-size:12px;font-weight:750}
      .fmc-error{padding:16px;font-weight:900;color:#991b1b}
      @media(max-width:680px){.fmc-tabs button span{display:none}.fmc-top{height:54px}.fmc-row{flex-direction:column}.fmc-statgrid{grid-template-columns:1fr 1fr}}
    `;
    document.head.appendChild(style);
  }

  function canManageFromSession(session){
    const user = session?.user || {};
    const roles = Array.isArray(user.roles) ? user.roles : [];
    const permissions = user.permissions || user.org_permissions?.items || {};
    return permissions['*'] === true
      || permissions.manage_company_users === true
      || ['owner','admin','super_admin','canvassing_manager'].includes(String(user.role || ''))
      || roles.includes('canvassing_manager')
      || roles.includes('canvassing_admin');
  }

  class CanvassingApp {
    constructor(options = {}) {
      this.root = options.root || document.getElementById('app');
      this.platformApi = options.platformApi || rootWindow.PlatformAPI;
      this.canvassingApi = options.canvassingApi || rootWindow.CanvassingAPI;
      this.session = options.session || null;
      this.explicitBranchId = cleanText(options.branchId);
      this.title = cleanText(options.title) || 'Canvassing';
      this.primaryColor = cleanText(options.primaryColor) || '#d93025';
      this.onLogout = typeof options.onLogout === 'function' ? options.onLogout : null;
      this.state = {
        view: 'map',
        map: null,
        markers: null,
        pins: [],
        settings: null,
        users: [],
        currentPin: null
      };
    }

    orgId(){
      return cleanText(this.session?.membership?.organization_id || this.session?.organization?.id);
    }

    branchId(){
      return cleanText(this.session?.membership?.branch_id || this.explicitBranchId || 'default') || 'default';
    }

    canManage(){
      return canManageFromSession(this.session);
    }

    async mount(){
      if (!this.root) throw new Error('CanvassingApp requires a root element.');
      if (!this.canvassingApi) throw new Error('CanvassingApp requires CanvassingAPI.');
      if (!rootWindow.L) throw new Error('CanvassingApp requires Leaflet.');
      injectCss();
      this.root.classList.add('fmc-app');
      this.root.style.setProperty('--fmc-primary', this.primaryColor);
      await this.loadData();
      this.state.view = 'map';
      this.renderShell();
      return this;
    }

    destroy(){
      if (this.state.map) {
        this.state.map.remove();
        this.state.map = null;
      }
      this.state.markers = null;
      if (this.root) {
        this.root.classList.remove('fmc-app');
        this.root.innerHTML = '';
      }
    }

    statusColor(id){
      return (this.state.settings?.statuses || []).find((s) => s.id === id)?.color || '#2563eb';
    }

    statusLabel(id){
      return (this.state.settings?.statuses || []).find((s) => s.id === id)?.label || String(id || '').replace(/_/g,' ');
    }

    markerIcon(pin){
      return rootWindow.L.divIcon({
        className:'fmc-pin',
        html:`<div style="width:20px;height:20px;border-radius:50%;background:${this.statusColor(pin.status_id)};border:3px solid white;box-shadow:0 2px 8px rgba(0,0,0,.4)"></div>`,
        iconSize:[24,24],
        iconAnchor:[12,12]
      });
    }

    async loadData(){
      const result = await this.canvassingApi.pins.list(this.orgId(), this.branchId());
      this.state.pins = result.pins || [];
      this.state.settings = result.settings || {};
    }

    renderShell(){
      const managerButton = this.canManage() ? `<button class="${this.state.view === 'manager' ? 'active' : ''}" data-fmc-tab="manager"><i class="fas fa-chart-simple"></i> <span>Manager</span></button>` : '';
      this.root.innerHTML = `
        <main class="fmc-shell">
          <header class="fmc-top">
            <div class="fmc-brand"><div class="mark"><i class="fas fa-map-location-dot"></i></div><div>${escapeHtml(this.title)}</div></div>
            <nav class="fmc-tabs">
              <button class="${this.state.view === 'map' ? 'active' : ''}" data-fmc-tab="map"><i class="fas fa-map"></i> <span>Map</span></button>
              ${managerButton}
              <button class="ghost" data-fmc-action="logout"><i class="fas fa-right-from-bracket"></i></button>
            </nav>
          </header>
          <section class="fmc-content" data-fmc-content></section>
        </main>
      `;
      this.root.querySelector('[data-fmc-tab="map"]').addEventListener('click', () => { this.state.view = 'map'; this.renderMain(); });
      this.root.querySelector('[data-fmc-tab="manager"]')?.addEventListener('click', () => { this.state.view = 'manager'; this.renderMain(); });
      this.root.querySelector('[data-fmc-action="logout"]')?.addEventListener('click', () => this.onLogout && this.onLogout());
      this.renderMain();
    }

    content(){
      return this.root.querySelector('[data-fmc-content]');
    }

    renderMain(){
      if (this.state.view === 'manager') this.renderManager();
      else this.renderMapView();
    }

    renderMapView(){
      const content = this.content();
      content.className = 'fmc-content fmc-map-view';
      content.innerHTML = `<div class="fmc-map" data-fmc-map></div><div class="fmc-legend" data-fmc-legend></div><div class="fmc-sheet" data-fmc-sheet></div>`;
      this.renderLegend();
      if (this.state.map) {
        this.state.map.remove();
        this.state.map = null;
        this.state.markers = null;
      }
      const mapEl = content.querySelector('[data-fmc-map]');
      this.state.map = rootWindow.L.map(mapEl).setView(DEFAULT_COORDS, 11);
      rootWindow.L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', { maxZoom:19, attribution:'&copy; OpenStreetMap' }).addTo(this.state.map);
      this.state.markers = rootWindow.L.layerGroup().addTo(this.state.map);
      this.state.map.on('click', async (event) => {
        const coords = { lat:event.latlng.lat, lng:event.latlng.lng };
        this.openSheet(null, coords);
        try {
          const geo = await this.canvassingApi.geocode.reverse(coords.lat, coords.lng);
          const address = this.root.querySelector('[data-fmc-field="address"]');
          if (address && !address.value) address.value = geo?.result?.display_name || '';
        } catch {}
      });
      this.renderMarkers();
      setTimeout(() => this.state.map?.invalidateSize(), 80);
    }

    renderLegend(){
      const el = this.root.querySelector('[data-fmc-legend]');
      if (!el) return;
      el.innerHTML = (this.state.settings?.statuses || []).filter((s) => s.id !== 'deleted').map((s) => `
        <div class="fmc-chip"><span class="fmc-dot" style="background:${escapeHtml(s.color)}"></span>${escapeHtml(s.label)}</div>
      `).join('');
    }

    renderMarkers(){
      if (!this.state.markers) return;
      this.state.markers.clearLayers();
      this.state.pins.forEach((pin) => {
        const lat = Number(pin.coordinates?.lat);
        const lng = Number(pin.coordinates?.lng);
        if (!Number.isFinite(lat) || !Number.isFinite(lng)) return;
        rootWindow.L.marker([lat,lng], { icon: this.markerIcon(pin) }).on('click', () => this.openSheet(pin)).addTo(this.state.markers);
      });
    }

    openSheet(pin = null, coords = null){
      this.state.currentPin = pin;
      const sheet = this.root.querySelector('[data-fmc-sheet]');
      const contact = pin?.contact || {};
      const statuses = (this.state.settings?.statuses || []).filter((s) => s.id !== 'deleted');
      sheet.classList.add('open');
      sheet.dataset.lat = coords?.lat ?? pin?.coordinates?.lat ?? '';
      sheet.dataset.lng = coords?.lng ?? pin?.coordinates?.lng ?? '';
      sheet.innerHTML = `
        <label>Status</label>
        <select data-fmc-field="status">${statuses.map((s) => `<option value="${escapeHtml(s.id)}" ${String(pin?.status_id || this.state.settings?.default_status_id || 'new') === String(s.id) ? 'selected' : ''}>${escapeHtml(s.label)}</option>`).join('')}</select>
        <label>Address</label><input data-fmc-field="address" value="${escapeHtml(pin?.address || '')}" placeholder="Address">
        <div class="fmc-row">
          <div><label>Name</label><input data-fmc-field="name" value="${escapeHtml(contact.name || '')}" placeholder="Name"></div>
          <div><label>Phone</label><input data-fmc-field="phone" value="${escapeHtml(contact.phone || '')}" placeholder="Phone"></div>
        </div>
        <label>Notes</label><textarea data-fmc-field="notes" placeholder="Notes">${escapeHtml(pin?.notes || '')}</textarea>
        <div class="fmc-row" style="margin-top:10px">
          <button data-fmc-action="close-sheet">Close</button>
          <button class="primary" data-fmc-action="save-pin">Save</button>
        </div>
        ${pin ? `<div class="fmc-row" style="margin-top:8px"><button class="primary" data-fmc-action="promote-pin">Create Lead</button></div>` : ''}
      `;
      sheet.querySelector('[data-fmc-action="close-sheet"]').addEventListener('click', () => sheet.classList.remove('open'));
      sheet.querySelector('[data-fmc-action="save-pin"]').addEventListener('click', () => this.saveSheet());
      sheet.querySelector('[data-fmc-action="promote-pin"]')?.addEventListener('click', () => this.promoteSheet());
    }

    sheetPayload(){
      const sheet = this.root.querySelector('[data-fmc-sheet]');
      return {
        ...(this.state.currentPin?.id ? { id: this.state.currentPin.id } : {}),
        coordinates: { lat: Number(sheet.dataset.lat), lng: Number(sheet.dataset.lng) },
        status_id: sheet.querySelector('[data-fmc-field="status"]').value,
        address: sheet.querySelector('[data-fmc-field="address"]').value,
        contact: {
          name: sheet.querySelector('[data-fmc-field="name"]').value,
          phone: sheet.querySelector('[data-fmc-field="phone"]').value
        },
        notes: sheet.querySelector('[data-fmc-field="notes"]').value
      };
    }

    async saveSheet(){
      const payload = this.sheetPayload();
      if (payload.id) await this.canvassingApi.pins.patch(this.orgId(), this.branchId(), payload.id, payload);
      else await this.canvassingApi.pins.create(this.orgId(), this.branchId(), payload);
      this.root.querySelector('[data-fmc-sheet]')?.classList.remove('open');
      await this.loadData();
      this.renderMapView();
    }

    async promoteSheet(){
      const payload = this.sheetPayload();
      if (!payload.id) return;
      await this.canvassingApi.pins.promote(this.orgId(), this.branchId(), payload.id, payload);
      this.root.querySelector('[data-fmc-sheet]')?.classList.remove('open');
      await this.loadData();
      this.renderMapView();
    }

    async renderManager(){
      const content = this.content();
      content.className = 'fmc-content fmc-manager';
      const total = this.state.pins.length;
      const leads = this.state.pins.filter((pin) => pin.platform_project_id).length;
      const today = new Date().toISOString().slice(0,10);
      const todayCount = this.state.pins.filter((pin) => String(pin.updated_at || '').slice(0,10) === today).length;
      content.innerHTML = `
        <section class="fmc-panel">
          <h2>Canvassing Manager</h2>
          <div class="fmc-muted">${escapeHtml(this.session?.organization?.name || '')}</div>
          <div class="fmc-statgrid" style="margin-top:12px">
            <div class="fmc-stat"><div class="num">${total}</div><div class="lbl">Pins</div></div>
            <div class="fmc-stat"><div class="num">${todayCount}</div><div class="lbl">Today</div></div>
            <div class="fmc-stat"><div class="num">${leads}</div><div class="lbl">Leads</div></div>
          </div>
        </section>
        <section class="fmc-panel">
          <h2>Add Canvasser</h2>
          <form data-fmc-form="add-user">
            <div class="fmc-row">
              <div><label>Name</label><input data-fmc-field="new-user-name" required></div>
              <div><label>Email</label><input data-fmc-field="new-user-email" type="email" required></div>
            </div>
            <div class="fmc-row">
              <div><label>Role</label><select data-fmc-field="new-user-role"><option value="canvasser">Canvasser</option><option value="canvassing_manager">Canvassing Manager</option></select></div>
              <div><label>Temporary Password</label><input data-fmc-field="new-user-password" placeholder="Optional"></div>
            </div>
            <button class="primary" type="submit" style="margin-top:10px;width:100%">Add User</button>
            <div class="fmc-muted" style="margin-top:8px">If no temporary password is entered, the user is stored as invited for now. Email delivery/accept-invite can be wired later.</div>
          </form>
        </section>
        <section class="fmc-panel">
          <h2>Canvassing Users</h2>
          <div data-fmc-users>Loading...</div>
        </section>
      `;
      content.querySelector('[data-fmc-form="add-user"]').addEventListener('submit', (event) => this.addUser(event));
      await this.loadUsers();
    }

    async loadUsers(){
      if (!this.canManage()) return;
      const result = await this.canvassingApi.users.list(this.orgId(), this.branchId());
      this.state.users = result.users || [];
      const list = this.root.querySelector('[data-fmc-users]');
      if (!list) return;
      list.innerHTML = this.state.users.map((user) => `
        <div class="fmc-user-row">
          <div>
            <div style="font-weight:1000">${escapeHtml(user.name || user.email)}</div>
            <div class="fmc-muted">${escapeHtml(user.email)} &middot; ${(user.roles || []).map(escapeHtml).join(', ')}</div>
          </div>
          <div class="fmc-muted">${escapeHtml(user.status || 'active')}</div>
        </div>
      `).join('') || '<div class="fmc-muted">No canvassing users yet.</div>';
    }

    async addUser(event){
      event.preventDefault();
      const content = this.content();
      await this.canvassingApi.users.create(this.orgId(), this.branchId(), {
        name: content.querySelector('[data-fmc-field="new-user-name"]').value,
        email: content.querySelector('[data-fmc-field="new-user-email"]').value,
        role: content.querySelector('[data-fmc-field="new-user-role"]').value,
        password: content.querySelector('[data-fmc-field="new-user-password"]').value
      });
      content.querySelector('[data-fmc-form="add-user"]').reset();
      await this.loadUsers();
    }
  }

  const api = {
    mount(options = {}) {
      const app = new CanvassingApp(options);
      return app.mount();
    },
    create(options = {}) {
      return new CanvassingApp(options);
    },
    canManageFromSession,
    escapeHtml
  };

  rootWindow.FirstMateCanvassingApp = api;
})();
