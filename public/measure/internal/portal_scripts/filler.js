/* portal_scripts/filler.js
 * Filler Projects plugin:
 * - Adds a "Filler Projects" tab to the portal
 * - Lets authorized users pick an address via Google Maps + search, drop/move pin, and submit as a filler project
 *
 * REQUIREMENT:
 * - Only users with perms.create_filler_projects === true can access
 *
 * SERVER:
 * - Uses the FirstMeasure API /projects/queue endpoint with is_filler=true
 */

(function(){
  const cfg = () => window.Portal?.cfg || window.PORTAL_CFG || {};
  const perms = () => (cfg().perms || {});

  const PERM_KEY = 'create_filler_projects'; // ✅ set this true for the user in their user JSON permissions

  const Plugin = {
    id: 'filler-projects',
    title: 'Filler Projects',
    iconClass: 'fas fa-map-marker-alt',

    state: {
      map: null,
      marker: null,
      geocoder: null,
      places: null,
      lastPlace: null,
      lastComponents: null,
      lastResolvedAddress: '',
      lat: null,
      lng: null,
      initialized: false,
      busy: false,
      lastStatus: '',
      polls: 0,
      mapClickListener: null,
      lastDebug: null
    },

    init(){
      if (!this.isAllowed()) return;

      this.injectCss();
      this.injectView();
      this.registerNav();

      // Hook into Portal.switchView to init map when tab opens (no index.php changes needed besides script include)
      this.patchPortalSwitchView();
    },

    isAllowed(){
      return !!perms()[PERM_KEY];
    },

    registerNav(){
      try {
        window.Portal?.registerPlugin?.({
          id: this.id,
          title: this.title,
          iconClass: this.iconClass
        });
      } catch(e) {}
    },

    injectCss(){
        if (document.getElementById('fillerProjectsStyle')) return;
        const style = document.createElement('style');
        style.id = 'fillerProjectsStyle';
        style.textContent = `
            /* Make the filler view consume the full available page height */
            #view-${this.id}{
            display:none;              /* portal toggles this to block */
            height: calc(100vh - 60px);/* roughly matches .main-content padding/header spacing */
            min-height: 720px;
            }

            /* Use flex column so the card can stretch */
            #view-${this.id} .fp-wrap{
            max-width: none;
            height: 100%;
            display:flex;
            flex-direction:column;
            }

            /* Keep header-bar normal, but don’t cap layout width */
            #view-${this.id} .header-bar{
            flex: 0 0 auto;
            margin-bottom: 18px;
            }

            /* Card stretches to fill remaining height */
            #view-${this.id} .fp-card{
            background:#fff;
            border:1px solid var(--border);
            border-radius:12px;
            padding:18px;
            box-shadow:0 2px 5px rgba(0,0,0,0.05);
            flex: 1 1 auto;
            min-height: 0; /* critical for children overflow sizing */
            display:flex;
            flex-direction:column;
            }

            /* Grid stretches to fill the card */
            #view-${this.id} .fp-grid{
            display:grid;
            grid-template-columns: 420px 1fr;
            gap:16px;
            align-items:stretch;
            flex: 1 1 auto;
            min-height: 0; /* critical so map can grow */
            }

            @media (max-width: 1100px){
            #view-${this.id}{
                height:auto;
                min-height: 0;
            }
            #view-${this.id} .fp-wrap{ height:auto; }
            #view-${this.id} .fp-card{ height:auto; }
            #view-${this.id} .fp-grid{
                grid-template-columns: 1fr;
                height:auto;
                min-height: 0;
            }
            }

            /* Left column: allow scrolling if needed instead of constraining the map */
            #view-${this.id} .fp-form{
            display:flex;
            flex-direction:column;
            min-height:0;
            overflow:auto;
            padding-right: 2px;
            }

            /* Right column: full-height container for the map */
            #view-${this.id} .fp-grid > div:last-child{
            display:flex;
            flex-direction:column;
            min-height:0;
            }

            /* Map takes ALL remaining width/height available */
            #view-${this.id} .fp-map{
            width:100%;
            height:100%;
            min-height: 520px;
            flex: 1 1 auto;
            border-radius:12px;
            border:1px solid #eee;
            overflow:hidden;
            background:#f1f3f4;
            }

            #view-${this.id} .fp-title{
            display:flex; align-items:center; gap:10px;
            font-weight:950; font-size:16px; color:#202124;
            margin:0 0 10px 0;
            }

            #view-${this.id} .fp-sub{
            color:#5f6368; font-size:12px; font-weight:700;
            margin:0 0 14px 0;
            line-height:1.4;
            }

            #view-${this.id} .fp-form .row{ margin-bottom:12px; }

            #view-${this.id} .fp-form label{
            display:block; font-size:11px; font-weight:900; color:#777;
            text-transform:uppercase; letter-spacing:.4px;
            margin-bottom:6px;
            }

            #view-${this.id} .fp-form input{
            width:100%;
            padding:12px 12px;
            border-radius:10px;
            border:1px solid #ccc;
            box-sizing:border-box;
            font-size:13px;
            font-weight:700;
            color:#202124;
            }

            #view-${this.id} .fp-form label.fp-check{
            display:flex;
            align-items:center;
            gap:10px;
            padding:2px 0 0;
            text-transform:none;
            letter-spacing:0;
            margin-bottom:12px;
            }

            #view-${this.id} .fp-check input{
            width:18px;
            height:18px;
            margin:0;
            padding:0;
            flex:0 0 auto;
            accent-color: var(--primary);
            }

            #view-${this.id} .fp-check-title{
            display:flex;
            align-items:center;
            font-size:12px;
            font-weight:800;
            color:#202124;
            line-height:1;
            min-height:18px;
            }

            #view-${this.id} .fp-actions{
            display:flex; gap:10px; flex-wrap:wrap; align-items:center;
            margin-top:6px;
            }

            #view-${this.id} .fp-btn{
            display:inline-flex; align-items:center; gap:8px;
            padding:12px 14px; border-radius:10px;
            border:1px solid var(--border);
            background:#fff; font-weight:900; cursor:pointer;
            user-select:none;
            }

            #view-${this.id} .fp-btn.primary{
            background: var(--primary);
            border-color: var(--primary);
            color:#fff;
            }

            #view-${this.id} .fp-btn.primary:disabled{
            background:#f1f3f4; border-color:#dadce0; color:#9aa0a6; cursor:not-allowed;
            }

            #view-${this.id} .fp-btn:disabled{
            opacity:.8; cursor:not-allowed;
            }

            #view-${this.id} .fp-hint{
            font-size:12px; color:#666; font-weight:800;
            background:#f8f9fa; border:1px solid #eee;
            padding:10px 12px; border-radius:10px;
            line-height:1.35;
            }

            #view-${this.id} .fp-kv{
            margin-top:10px;
            display:grid;
            grid-template-columns: 120px 1fr;
            gap:6px 10px;
            font-size:12px;
            color:#555;
            }

            #view-${this.id} .fp-kv .k{
            font-weight:900; color:#777;
            text-transform:uppercase; font-size:10px; letter-spacing:.4px;
            }

            #view-${this.id} .fp-kv .v{
            font-weight:800; color:#202124;
            overflow:hidden; text-overflow:ellipsis; white-space:nowrap;
            }

            #view-${this.id} .fp-status{
            margin-top:12px;
            font-size:12px;
            font-weight:900;
            color:#5f6368;
            }

            #view-${this.id} .fp-status.ok{ color:#137333; }
            #view-${this.id} .fp-status.bad{ color:#b0261e; }

            #view-${this.id} .fp-mini{
            font-size:11px; color:#777; font-weight:800; margin-top:10px;
            }

            #view-${this.id} .mono{
            font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", "Courier New", monospace;
            }

            #view-${this.id} .fp-debug{
            margin-top:14px;
            border:1px solid #e5e7eb;
            border-radius:10px;
            background:#fafbfc;
            overflow:hidden;
            }

            #view-${this.id} .fp-debug-head{
            display:flex;
            align-items:center;
            justify-content:space-between;
            gap:10px;
            padding:10px 12px;
            border-bottom:1px solid #e5e7eb;
            }

            #view-${this.id} .fp-debug-title{
            font-size:11px;
            font-weight:900;
            color:#555;
            text-transform:uppercase;
            letter-spacing:.4px;
            }

            #view-${this.id} .fp-debug-actions{
            display:flex;
            gap:8px;
            flex-wrap:wrap;
            }

            #view-${this.id} .fp-debug-btn{
            display:inline-flex;
            align-items:center;
            gap:6px;
            padding:6px 10px;
            border-radius:8px;
            border:1px solid #d7dbe0;
            background:#fff;
            color:#334155;
            font-size:11px;
            font-weight:800;
            cursor:pointer;
            }

            #view-${this.id} .fp-debug-btn:hover{
            border-color:#c3c9d1;
            background:#f8fafc;
            }

            #view-${this.id} .fp-debug-pre{
            margin:0;
            padding:12px;
            min-height:180px;
            max-height:320px;
            overflow:auto;
            white-space:pre-wrap;
            word-break:break-word;
            color:#0f172a;
            background:#fafbfc;
            font-size:11px;
            line-height:1.45;
            }
        `;
        document.head.appendChild(style);
    },


    injectView(){
      const host = document.getElementById('portalPluginViews');
      if (!host) return;
      if (document.getElementById(`view-${this.id}`)) return;

      const wrap = document.createElement('div');
      wrap.id = `view-${this.id}`;
      wrap.style.display = 'none';
      wrap.innerHTML = `
        <div class="fp-wrap">
          <div class="header-bar">
            <h1>Filler Projects</h1>
            <div style="display:flex; gap:10px; align-items:center;">
              <button class="btn-secondary" id="fpRefreshBtn"><i class="fas fa-sync"></i> Reset</button>
            </div>
          </div>

          <div class="fp-card">
            <div class="fp-title">
              <i class="fas fa-map-location-dot" style="color:var(--primary);"></i>
              Create a filler project from an address
            </div>
            <p class="fp-sub">
              Search for an address, then fine-tune the pin by <b>double-clicking</b> on the map or dragging the marker.
              When it’s right, submit as a filler project.
            </p>

            <div class="fp-grid">
              <div class="fp-form">
                <div class="row">
                  <label>Address search</label>
                  <input id="fpAddressInput" placeholder="Type an address…" autocomplete="off" />
                </div>

                <label class="fp-check" for="fpIncludeGutters">
                  <input id="fpIncludeGutters" type="checkbox" />
                  <span class="fp-check-title">Include gutters</span>
                </label>

                <div class="fp-actions">
                  <button class="fp-btn" id="fpCenterBtn" type="button">
                    <i class="fas fa-crosshairs"></i> Center on address
                  </button>
                  <button class="fp-btn primary" id="fpSubmitBtn" type="button" disabled>
                    <i class="fas fa-paper-plane"></i> Submit filler project
                  </button>
                </div>

                <div class="fp-mini">
                  Tip: you can also double-click anywhere on the map to drop the pin there.
                </div>

                <div class="fp-hint" style="margin-top:12px;">
                  <div><b>How it works:</b></div>
                  <div>1) Pick an address (search) or place the pin (double-click).</div>
                  <div>2) Submit → creates a project with <span class="mono">is_filler=true</span>.</div>
                </div>

                <div class="fp-kv">
                  <div class="k">Resolved</div><div class="v" id="fpResolvedAddr">—</div>
                  <div class="k">Lat/Lng</div><div class="v mono" id="fpLatLng">—</div>
                </div>

                <div class="fp-status" id="fpStatus">Waiting for Google Maps…</div>
                <div class="fp-debug">
                <div class="fp-debug-head">
                  <div class="fp-debug-title">Queue Debug</div>
                  <div class="fp-debug-actions">
                    <button class="fp-debug-btn" id="fpCopyDebugBtn" type="button">
                      <i class="fas fa-copy"></i> Copy
                    </button>
                    <button class="fp-debug-btn" id="fpClearDebugBtn" type="button">
                      <i class="fas fa-trash"></i> Clear
                    </button>
                  </div>
                </div>
                <pre class="fp-debug-pre mono" id="fpDebugLog">No filler submit debug yet.</pre>
                </div>
              </div>

              <div>
                <div id="fpMap" class="fp-map"></div>
              </div>
            </div>
          </div>
        </div>
      `;

      host.appendChild(wrap);

      // wire basic buttons
      document.getElementById('fpRefreshBtn')?.addEventListener('click', () => this.resetUi(true));
      document.getElementById('fpCenterBtn')?.addEventListener('click', () => this.centerFromInput());
      document.getElementById('fpSubmitBtn')?.addEventListener('click', () => this.submitFiller());
      document.getElementById('fpClearDebugBtn')?.addEventListener('click', () => this.clearDebug());
      document.getElementById('fpCopyDebugBtn')?.addEventListener('click', () => this.copyDebug());
    },

    patchPortalSwitchView(){
      if (!window.Portal || typeof Portal.switchView !== 'function') return;
      if (Portal.__fillerPatched) return;
      Portal.__fillerPatched = true;

      const original = Portal.switchView.bind(Portal);
      Portal.switchView = async (id, btn) => {
        const out = await original(id, btn);
        if (id === this.id) {
          this.onShow();
        }
        return out;
      };
    },

    onShow(){
      if (!this.isAllowed()) return;

      // If maps already loaded, init immediately; otherwise poll briefly.
      if (this.state.initialized) return;

      this.setStatus('Waiting for Google Maps…', null);

      const tryInit = () => {
        if (window.google && google.maps && google.maps.Map) {
          this.initMap();
          return true;
        }
        return false;
      };

      if (tryInit()) return;

      // poll up to ~8s
      const tick = () => {
        if (this.state.initialized) return;
        this.state.polls++;
        if (tryInit()) return;
        if (this.state.polls > 40) {
          this.setStatus('Google Maps failed to load (callback/policy).', false);
          return;
        }
        setTimeout(tick, 200);
      };
      setTimeout(tick, 200);
    },

    resetUi(reinitMap){
      this.state.lastPlace = null;
      this.state.lastComponents = null;
      this.state.lastResolvedAddress = '';
      this.state.lat = null;
      this.state.lng = null;
      this.state.busy = false;

      const inp = document.getElementById('fpAddressInput');
      if (inp) inp.value = '';

      this.updateKV();
      this.setSubmitEnabled(false);

      if (this.state.initialized && reinitMap) {
        // reset map to US-ish default
        const c = { lat: 39.5, lng: -98.35 };
        this.state.map.setCenter(c);
        this.state.map.setZoom(5);
        this.setMarker(c, true);
        this.reverseGeocode(c);
      }
      this.clearDebug();
      this.setStatus('Ready.', null);
    },

    initMap(){
      if (this.state.initialized) return;

      this.state.geocoder = new google.maps.Geocoder();

      const mapEl = document.getElementById('fpMap');
      const inputEl = document.getElementById('fpAddressInput');

      if (!mapEl || !inputEl) return;

      const start = { lat: 39.5, lng: -98.35 };

      const map = new google.maps.Map(mapEl, {
        center: start,
        zoom: 5,
        mapTypeId: 'satellite',
        disableDefaultUI: false,
        streetViewControl: false,
        fullscreenControl: true,
        gestureHandling: 'greedy'
      });

      this.state.map = map;

      // marker
      this.state.marker = new google.maps.Marker({
        position: start,
        map,
        draggable: true,
        title: 'Filler pin'
      });

      this.state.marker.addListener('dragend', () => {
        const p = this.state.marker.getPosition();
        if (!p) return;
        const loc = { lat: p.lat(), lng: p.lng() };
        this.state.lat = loc.lat;
        this.state.lng = loc.lng;
        this.updateKV();
        this.reverseGeocode(loc);
      });

      // double click to set pin
      map.addListener('dblclick', (e) => {
        if (!e || !e.latLng) return;
        const loc = { lat: e.latLng.lat(), lng: e.latLng.lng() };
        this.setMarker(loc, true);
        this.reverseGeocode(loc);
      });

      // Places autocomplete
      if (google.maps.places && google.maps.places.Autocomplete) {
        this.state.places = new google.maps.places.Autocomplete(inputEl, {
          fields: ['formatted_address','geometry','address_components','place_id'],
          types: ['address']
        });

        this.state.places.addListener('place_changed', () => {
          const place = this.state.places.getPlace();
          this.state.lastPlace = place || null;

          const geom = place && place.geometry;
          const loc = geom && geom.location ? { lat: geom.location.lat(), lng: geom.location.lng() } : null;

          this.state.lastComponents = Array.isArray(place?.address_components) ? place.address_components : null;
          this.state.lastResolvedAddress = String(place?.formatted_address || inputEl.value || '').trim();

          if (loc) {
            this.setMarker(loc, true);
            map.setCenter(loc);
            map.setZoom(20);
          }

          this.updateKV();
          this.setSubmitEnabled(!!(this.state.lat && this.state.lng && this.state.lastResolvedAddress));
          this.setStatus('Address selected. Adjust pin if needed, then submit.', null);
        });
      } else {
        this.setStatus('Google Places library missing (libraries=places).', false);
      }

      // Set default marker + reverse resolve
      this.setMarker(start, true);
      this.reverseGeocode(start);

      this.state.initialized = true;
      this.setStatus('Ready. Search or double-click to place the pin.', null);
    },

    setMarker(loc, pan){
      if (!this.state.map || !this.state.marker) return;
      this.state.marker.setPosition(loc);
      if (pan) this.state.map.panTo(loc);
      this.state.lat = loc.lat;
      this.state.lng = loc.lng;
      this.updateKV();
      this.setSubmitEnabled(!!(this.state.lat && this.state.lng && this.state.lastResolvedAddress));
    },

    async centerFromInput(){
      if (!this.state.geocoder) return;
      const inputEl = document.getElementById('fpAddressInput');
      const q = String(inputEl?.value || '').trim();
      if (!q) { this.setStatus('Type an address first.', false); return; }

      this.setStatus('Geocoding…', null);

      this.state.geocoder.geocode({ address: q }, (results, status) => {
        if (status !== 'OK' || !results || !results.length) {
          this.setStatus('Address not found.', false);
          return;
        }

        const r = results[0];
        const g = r.geometry && r.geometry.location;
        if (!g) { this.setStatus('No geometry for that address.', false); return; }

        const loc = { lat: g.lat(), lng: g.lng() };

        this.state.lastResolvedAddress = String(r.formatted_address || q).trim();
        this.state.lastComponents = Array.isArray(r.address_components) ? r.address_components : null;

        this.setMarker(loc, true);
        this.state.map.setCenter(loc);
        this.state.map.setZoom(20);

        this.setSubmitEnabled(true);
        this.setStatus('Centered. Adjust pin if needed, then submit.', null);
      });
    },

    reverseGeocode(loc){
      if (!this.state.geocoder) return;

      this.setStatus('Resolving address…', null);

      this.state.geocoder.geocode({ location: loc }, (results, status) => {
        if (status !== 'OK' || !results || !results.length) {
          // still allow submit if user typed something and we have coords
          this.setStatus('Pin set. Could not resolve address automatically.', null);
          this.setSubmitEnabled(!!(this.state.lat && this.state.lng && this.state.lastResolvedAddress));
          return;
        }

        const r = results[0];
        this.state.lastResolvedAddress = String(r.formatted_address || '').trim() || this.state.lastResolvedAddress;
        this.state.lastComponents = Array.isArray(r.address_components) ? r.address_components : this.state.lastComponents;

        // update input to reflect resolved address (nice UX)
        const inputEl = document.getElementById('fpAddressInput');
        if (inputEl && this.state.lastResolvedAddress) inputEl.value = this.state.lastResolvedAddress;

        this.updateKV();
        this.setSubmitEnabled(!!(this.state.lat && this.state.lng && this.state.lastResolvedAddress));
        this.setStatus('Pin set. Ready to submit.', null);
      });
    },

    updateKV(){
      const addrEl = document.getElementById('fpResolvedAddr');
      const llEl = document.getElementById('fpLatLng');

      if (addrEl) addrEl.textContent = this.state.lastResolvedAddress || '—';
      if (llEl) {
        if (this.state.lat && this.state.lng) llEl.textContent = `${this.state.lat.toFixed(6)}, ${this.state.lng.toFixed(6)}`;
        else llEl.textContent = '—';
      }
    },

    setSubmitEnabled(on){
      const btn = document.getElementById('fpSubmitBtn');
      if (btn) btn.disabled = !on || !!this.state.busy;
    },

    shouldIncludeGutters(){
      return !!document.getElementById('fpIncludeGutters')?.checked;
    },

    setStatus(msg, ok){
      const el = document.getElementById('fpStatus');
      if (!el) return;
      el.textContent = msg || '';
      el.classList.remove('ok','bad');
      if (ok === true) el.classList.add('ok');
      if (ok === false) el.classList.add('bad');
    },

    redactSecrets(value){
      let out = value;
      try {
        out = JSON.parse(JSON.stringify(value));
      } catch(e) {}
      const redact = (raw) => {
        const str = String(raw || '');
        if (!str) return '';
        if (str.length <= 8) return `[redacted:${str.length}]`;
        return `${str.slice(0, 4)}...${str.slice(-2)} [len=${str.length}]`;
      };
      if (out && typeof out === 'object') {
        if (Object.prototype.hasOwnProperty.call(out, 'google_api_key')) out.google_api_key = redact(out.google_api_key);
        if (Object.prototype.hasOwnProperty.call(out, 'gemini_api_key')) out.gemini_api_key = redact(out.gemini_api_key);
      }
      return out;
    },

    renderDebug(value){
      const el = document.getElementById('fpDebugLog');
      if (!el) return;
      if (!value) {
        el.textContent = 'No filler submit debug yet.';
        return;
      }
      try {
        el.textContent = JSON.stringify(value, null, 2);
      } catch(e) {
        el.textContent = String(value);
      }
    },

    setDebug(value){
      this.state.lastDebug = value || null;
      this.renderDebug(this.state.lastDebug);
      try { console.log('[FillerProjects] queue debug', this.state.lastDebug); } catch(e) {}
    },

    clearDebug(){
      this.state.lastDebug = null;
      this.renderDebug(null);
    },

    async copyDebug(){
      if (!this.state.lastDebug) {
        this.setStatus('No debug payload to copy yet.', false);
        return;
      }
      const text = JSON.stringify(this.state.lastDebug, null, 2);
      try {
        if (navigator.clipboard?.writeText) {
          await navigator.clipboard.writeText(text);
          this.setStatus('Copied filler debug payload.', true);
          return;
        }
      } catch(e) {}
      this.setStatus('Copy failed. Use the debug box below.', false);
    },

    buildAddressComponentsForServer(){
      // server expects JSON string in address_components
      // we'll pass a structured blob based on Google components
      const comps = this.state.lastComponents;
      if (!Array.isArray(comps)) return '{}';

      const out = {};
      for (const c of comps) {
        if (!c || typeof c !== 'object') continue;
        const types = Array.isArray(c.types) ? c.types : [];
        const long = String(c.long_name || '');
        const short = String(c.short_name || '');
        for (const t of types) {
          if (!t) continue;
          out[t] = { long, short };
        }
      }
      return JSON.stringify(out);
    },

    async submitFiller(){
      if (!this.isAllowed()) return;
      if (this.state.busy) return;

      const address = String(this.state.lastResolvedAddress || '').trim();
      const lat = this.state.lat;
      const lng = this.state.lng;

      if (!address || !lat || !lng) {
        this.setStatus('Pick an address and place the pin first.', false);
        return;
      }

      this.state.busy = true;
      const btn = document.getElementById('fpSubmitBtn');
      const oldHtml = btn ? btn.innerHTML : '';
      if (btn) {
        btn.disabled = true;
        btn.innerHTML = `<i class="fas fa-circle-notch fa-spin"></i> Submitting…`;
      }

      this.setStatus('Submitting filler project…', null);

      try {
        const payload = {
          address: address,
          lat,
          lng,
          is_custom_pin: true,
          is_filler: true,
          include_gutter_measurements: this.shouldIncludeGutters(),

          resident: {
            name: 'Filler',
            email: '',
            phone: ''
          },
          owner_ref: {
            name: (cfg().user?.name || 'Portal'),
            email: (cfg().user?.email || '')
          },
          issuer: {
            name: (cfg().user?.name || 'Portal'),
            email: (cfg().user?.email || '')
          },
          components: JSON.parse(this.buildAddressComponentsForServer() || '{}'),
          process_async: false
        };

        const queueUrl = new URL(`${cfg().endpoints.firstmeasure}/projects/queue`, window.location.origin);
        queueUrl.searchParams.set('debug', '1');
        queueUrl.searchParams.set('debug_source', 'internal_filler_projects');

        this.setDebug({
          stage: 'request_prepared',
          at: new Date().toISOString(),
          method: 'POST',
          url: queueUrl.toString(),
          api_base: cfg().endpoints?.firstmeasure || '',
          actor_email: cfg().user?.email || '',
          payload: this.redactSecrets(payload)
        });

        const response = await fetch(queueUrl.toString(), {
          method: 'POST',
          headers: {
            'Accept': 'application/json',
            'Content-Type': 'application/json'
          },
          body: JSON.stringify(payload)
        });

        const text = await response.text();
        let res = {};
        let parseError = null;
        try {
          res = text ? JSON.parse(text) : {};
        } catch (err) {
          parseError = err?.message || String(err);
        }

        this.setDebug({
          stage: 'response_received',
          at: new Date().toISOString(),
          method: 'POST',
          url: queueUrl.toString(),
          request_payload: this.redactSecrets(payload),
          response: {
            ok: response.ok,
            status: response.status,
            status_text: response.statusText,
            headers: {
              content_type: response.headers.get('content-type') || '',
              debug_trace: response.headers.get('x-firstmeasure-debug-trace') || '',
              debug_ms: response.headers.get('x-firstmeasure-debug-ms') || ''
            },
            parse_error: parseError,
            body_text: text,
            body_json: parseError ? null : res
          }
        });

        if (parseError) {
          throw new Error(`FirstMeasure returned invalid JSON (${response.status}).`);
        }
        if (!response.ok) {
          throw new Error(res.message || res.error || `Submit failed (${response.status}).`);
        }

        if (!res || !res.success || !res.folder) {
          this.setStatus((res && (res.error || res.message)) ? (res.error || res.message) : 'Submit failed.', false);
          return;
        }

        this.setStatus(`Created filler project ✅ (${res.folder})${this.shouldIncludeGutters() ? ' with gutters' : ''}`, true);

        // optionally: jump to project browser and refresh
        try {
          if (window.Projects?.fetchProjects) await Projects.fetchProjects();
        } catch(e) {}

      } catch(e) {
        console.error('[FillerProjects] unexpected submit error:', e);
        this.setDebug({
          ...(this.state.lastDebug || {}),
          final_error: e?.message || String(e),
          failed_at: new Date().toISOString()
        });
        this.setStatus(e?.message || 'Submit failed (network).', false);
      } finally {
        this.state.busy = false;
        if (btn) {
          btn.disabled = false;
          btn.innerHTML = oldHtml || `<i class="fas fa-paper-plane"></i> Submit filler project`;
        }
        this.setSubmitEnabled(!!(this.state.lat && this.state.lng && this.state.lastResolvedAddress));
      }
    }
  };

  // Boot once DOM is ready
  const boot = () => {
    if (!Plugin.isAllowed()) return; // invisible to non-authorized users
    Plugin.init();
  };

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();

  // Expose for debugging
  window.FillerProjects = Plugin;
})();
