(function(){
  const state = {
    open: false,
    busy: false,
    project: null,
    map: null,
    markers: [],
    pins: [],
    onSubmitted: null
  };

  const cfg = () => window.Portal?.cfg || window.PORTAL_CFG || {};
  const esc = (value) => window.Portal?.escapeHtml
    ? window.Portal.escapeHtml(value)
    : String(value ?? "").replace(/[&<>"']/g, (char) => ({
        "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#039;"
      }[char]));

  function ensureStyle(){
    if (document.getElementById("structurePinModalStyle")) return;
    const style = document.createElement("style");
    style.id = "structurePinModalStyle";
    style.textContent = `
      .spm-overlay{position:fixed;inset:0;background:rgba(32,33,36,.55);z-index:10050;display:none;align-items:center;justify-content:center;padding:22px;}
      .spm-overlay.open{display:flex;}
      .spm-shell{width:min(1120px,96vw);height:min(760px,92vh);background:#fff;border-radius:12px;box-shadow:0 24px 70px rgba(0,0,0,.28);display:grid;grid-template-rows:auto 1fr auto;overflow:hidden;border:1px solid #dfe3ea;}
      .spm-head{display:flex;align-items:center;justify-content:space-between;gap:16px;padding:14px 16px;border-bottom:1px solid #edf0f4;background:#fbfcfe;}
      .spm-title{display:flex;align-items:center;gap:10px;min-width:0;}
      .spm-title h2{margin:0;font-size:16px;line-height:1.2;color:#202124;font-weight:950;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;}
      .spm-title small{display:block;margin-top:3px;color:#667085;font-weight:800;font-size:11px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:680px;}
      .spm-close{width:34px;height:34px;border-radius:8px;border:1px solid #dadce0;background:#fff;color:#3c4043;display:grid;place-items:center;cursor:pointer;}
      .spm-body{display:grid;grid-template-columns:minmax(0,1fr) 290px;min-height:0;}
      .spm-map{min-height:420px;background:#eef1f5;position:relative;}
      .spm-side{border-left:1px solid #edf0f4;background:#fff;display:grid;grid-template-rows:auto 1fr;min-height:0;}
      .spm-side-head{padding:14px;border-bottom:1px solid #edf0f4;}
      .spm-count{font-size:12px;font-weight:950;color:#202124;display:flex;align-items:center;justify-content:space-between;gap:8px;}
      .spm-status{margin-top:8px;font-size:12px;font-weight:800;color:#667085;line-height:1.35;min-height:18px;}
      .spm-status.error{color:#b3261e;}
      .spm-status.ok{color:#137333;}
      .spm-list{padding:10px 14px;overflow:auto;}
      .spm-pin-row{display:grid;grid-template-columns:28px 1fr 30px;align-items:center;gap:8px;padding:9px 0;border-bottom:1px solid #f0f2f5;}
      .spm-pin-num{width:24px;height:24px;border-radius:999px;background:#d93025;color:#fff;display:grid;place-items:center;font-size:11px;font-weight:950;}
      .spm-pin-coord{font-size:11px;color:#3c4043;font-weight:800;line-height:1.35;}
      .spm-pin-remove{width:28px;height:28px;border-radius:8px;border:1px solid #e0e3e7;background:#fff;color:#b3261e;cursor:pointer;display:grid;place-items:center;}
      .spm-empty{padding:18px 0;color:#8a94a6;font-size:12px;font-weight:800;}
      .spm-actions{display:flex;align-items:center;justify-content:space-between;gap:12px;padding:12px 16px;border-top:1px solid #edf0f4;background:#fbfcfe;}
      .spm-actions-left,.spm-actions-right{display:flex;align-items:center;gap:10px;flex-wrap:wrap;}
      .spm-btn{border:1px solid #dadce0;background:#fff;color:#3c4043;border-radius:8px;padding:9px 12px;font-size:12px;font-weight:950;cursor:pointer;display:inline-flex;align-items:center;gap:8px;min-height:36px;}
      .spm-btn.primary{border-color:#d93025;background:#d93025;color:#fff;}
      .spm-btn:disabled{opacity:.55;cursor:not-allowed;}
      .spm-map-loading{position:absolute;inset:0;display:grid;place-items:center;color:#667085;font-size:13px;font-weight:900;background:#eef1f5;}
      @media(max-width:860px){.spm-shell{height:94vh;}.spm-body{grid-template-columns:1fr;grid-template-rows:minmax(360px,1fr) 230px;}.spm-side{border-left:0;border-top:1px solid #edf0f4;}.spm-title small{max-width:70vw;}}
    `;
    document.head.appendChild(style);
  }

  function ensureModal(){
    ensureStyle();
    let overlay = document.getElementById("structurePinModal");
    if (overlay) return overlay;
    overlay = document.createElement("div");
    overlay.id = "structurePinModal";
    overlay.className = "spm-overlay";
    overlay.innerHTML = `
      <div class="spm-shell" role="dialog" aria-modal="true" aria-labelledby="spmTitle">
        <div class="spm-head">
          <div class="spm-title">
            <i class="fas fa-location-dot" style="color:#d93025;"></i>
            <div>
              <h2 id="spmTitle">Structure Pins</h2>
              <small id="spmAddress"></small>
            </div>
          </div>
          <button class="spm-close" type="button" data-spm-close title="Close"><i class="fas fa-xmark"></i></button>
        </div>
        <div class="spm-body">
          <div class="spm-map" id="spmMap"><div class="spm-map-loading"><i class="fas fa-circle-notch fa-spin"></i>&nbsp;Loading map</div></div>
          <aside class="spm-side">
            <div class="spm-side-head">
              <div class="spm-count"><span id="spmPinCount">0 pins</span><span id="spmProjectType"></span></div>
              <div class="spm-status" id="spmStatus"></div>
            </div>
            <div class="spm-list" id="spmPinList"></div>
          </aside>
        </div>
        <div class="spm-actions">
          <div class="spm-actions-left">
            <button class="spm-btn" type="button" data-spm-clear><i class="fas fa-eraser"></i> Clear</button>
          </div>
          <div class="spm-actions-right">
            <button class="spm-btn" type="button" data-spm-cancel>Cancel</button>
            <button class="spm-btn primary" type="button" data-spm-submit><i class="fas fa-check"></i> Submit Pins</button>
          </div>
        </div>
      </div>
    `;
    document.body.appendChild(overlay);
    overlay.querySelector("[data-spm-close]").onclick = close;
    overlay.querySelector("[data-spm-cancel]").onclick = close;
    overlay.querySelector("[data-spm-clear]").onclick = () => {
      if (state.busy) return;
      state.pins = [];
      renderPins();
      refreshMarkers();
    };
    overlay.querySelector("[data-spm-submit]").onclick = submitPins;
    overlay.addEventListener("click", (event) => {
      if (event.target === overlay && !state.busy) close();
    });
    return overlay;
  }

  function setStatus(message, tone){
    const el = document.getElementById("spmStatus");
    if (!el) return;
    el.textContent = message || "";
    el.classList.toggle("error", tone === "error");
    el.classList.toggle("ok", tone === "ok");
  }

  function setBusy(on, label){
    state.busy = !!on;
    const overlay = ensureModal();
    overlay.querySelectorAll("button").forEach((btn) => { btn.disabled = !!on; });
    const submit = overlay.querySelector("[data-spm-submit]");
    if (submit) {
      submit.disabled = !!on || state.pins.length < 1;
      submit.innerHTML = on
        ? `<i class="fas fa-circle-notch fa-spin"></i> ${esc(label || "Working")}`
        : `<i class="fas fa-check"></i> Submit Pins`;
    }
  }

  function fullProjectId(project){
    return String(project?.id || project?.folder || project?.manifest?.id || "").trim();
  }

  async function loadProject(seed){
    const id = fullProjectId(seed);
    if (!id || !window.Portal?.fmGet) return seed || {};
    const data = await window.Portal.fmGet(`projects/${encodeURIComponent(id)}`).catch(() => null);
    return data?.project?.manifest || data?.project || seed || {};
  }

  function normalizePins(raw){
    return (Array.isArray(raw) ? raw : [])
      .map((pin) => {
        const lat = Number(pin?.lat);
        const lng = Number(pin?.lng);
        return Number.isFinite(lat) && Number.isFinite(lng) ? { lat, lng } : null;
      })
      .filter(Boolean);
  }

  function validLatLng(lat, lng){
    return Number.isFinite(lat) && Number.isFinite(lng) && Math.abs(lat) <= 90 && Math.abs(lng) <= 180;
  }

  function waitForMaps(){
    if (window.google?.maps?.Map) return Promise.resolve();
    return new Promise((resolve, reject) => {
      const started = Date.now();
      const timer = setInterval(() => {
        if (window.google?.maps?.Map) {
          clearInterval(timer);
          resolve();
          return;
        }
        if (Date.now() - started > 10000) {
          clearInterval(timer);
          reject(new Error("Google Maps did not load."));
        }
      }, 100);
    });
  }

  async function resolveCenter(project){
    const pins = normalizePins(project?.pins);
    if (pins[0]) return pins[0];
    const lat = Number(project?.lat);
    const lng = Number(project?.lng);
    if (validLatLng(lat, lng)) return { lat, lng };
    const address = String(project?.address || "").trim();
    if (address && window.google?.maps?.Geocoder) {
      const geocoder = new google.maps.Geocoder();
      const result = await geocoder.geocode({ address }).catch(() => null);
      const loc = result?.results?.[0]?.geometry?.location;
      if (loc) return { lat: loc.lat(), lng: loc.lng() };
    }
    return { lat: 39.8283, lng: -98.5795 };
  }

  function renderPins(){
    const count = document.getElementById("spmPinCount");
    const list = document.getElementById("spmPinList");
    const submit = document.querySelector("#structurePinModal [data-spm-submit]");
    if (count) count.textContent = `${state.pins.length} pin${state.pins.length === 1 ? "" : "s"}`;
    if (submit) submit.disabled = state.busy || state.pins.length < 1;
    if (!list) return;
    if (!state.pins.length) {
      list.innerHTML = `<div class="spm-empty">No pins placed.</div>`;
      return;
    }
    list.innerHTML = state.pins.map((pin, index) => `
      <div class="spm-pin-row">
        <div class="spm-pin-num">${index + 1}</div>
        <div class="spm-pin-coord">${pin.lat.toFixed(6)}<br>${pin.lng.toFixed(6)}</div>
        <button class="spm-pin-remove" type="button" data-spm-remove="${index}" title="Remove pin"><i class="fas fa-trash"></i></button>
      </div>
    `).join("");
    list.querySelectorAll("[data-spm-remove]").forEach((btn) => {
      btn.onclick = () => {
        if (state.busy) return;
        state.pins.splice(Number(btn.dataset.spmRemove), 1);
        renderPins();
        refreshMarkers();
      };
    });
  }

  function svgText(value){
    return String(value ?? "").replace(/[&<>"']/g, (char) => ({
      "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&apos;"
    }[char]));
  }

  function markerIcon(index){
    const label = svgText(index + 1);
    const svg = `
      <svg xmlns="http://www.w3.org/2000/svg" width="44" height="54" viewBox="0 0 44 54">
        <path d="M22 52c-2.5-6.2-7.2-10.5-11.4-15.2C6.2 31.8 3 26.8 3 20.5 3 9.5 11.5 1 22 1s19 8.5 19 19.5c0 6.3-3.2 11.3-7.6 16.3C29.2 41.5 24.5 45.8 22 52Z" fill="#d93025" stroke="#ffffff" stroke-width="3"/>
        <circle cx="22" cy="20.5" r="13.5" fill="#d93025" stroke="#000000" stroke-opacity=".18" stroke-width="1"/>
        <text x="22" y="25" text-anchor="middle" font-family="Arial, Helvetica, sans-serif" font-size="14" font-weight="900" fill="#ffffff">${label}</text>
      </svg>
    `.trim();
    return {
      url: `data:image/svg+xml;charset=UTF-8,${encodeURIComponent(svg)}`,
      scaledSize: new google.maps.Size(44, 54),
      anchor: new google.maps.Point(22, 52)
    };
  }

  function syncMarkerPin(marker, index){
    const pos = marker?.getPosition?.();
    if (!pos) return;
    state.pins[index] = { lat: pos.lat(), lng: pos.lng() };
  }

  function refreshMarkers(){
    state.markers.forEach((marker) => marker.setMap(null));
    state.markers = [];
    if (!state.map || !window.google?.maps?.Marker) return;
    state.pins.forEach((pin, index) => {
      const marker = new google.maps.Marker({
        map: state.map,
        position: pin,
        draggable: true,
        optimized: false,
        clickable: true,
        cursor: "grab",
        icon: markerIcon(index),
        zIndex: 1000 + index
      });
      marker.addListener("drag", () => syncMarkerPin(marker, index));
      marker.addListener("dragend", () => {
        syncMarkerPin(marker, index);
        renderPins();
        setStatus("");
      });
      state.markers.push(marker);
    });
  }

  async function initMap(project){
    const mapEl = document.getElementById("spmMap");
    if (!mapEl) return;
    mapEl.innerHTML = `<div class="spm-map-loading"><i class="fas fa-circle-notch fa-spin"></i>&nbsp;Loading map</div>`;
    await waitForMaps();
    const center = await resolveCenter(project);
    mapEl.innerHTML = "";
    state.map = new google.maps.Map(mapEl, {
      center,
      zoom: 20,
      mapTypeId: "satellite",
      streetViewControl: false,
      fullscreenControl: false,
      mapTypeControl: false,
      rotateControl: false,
      tilt: 0,
      gestureHandling: "greedy"
    });
    state.map.addListener("click", (event) => {
      if (state.busy || !event.latLng) return;
      state.pins.push({ lat: event.latLng.lat(), lng: event.latLng.lng() });
      refreshMarkers();
      renderPins();
      setStatus("");
    });
    refreshMarkers();
    setTimeout(() => {
      if (!state.map || !window.google?.maps?.event) return;
      google.maps.event.trigger(state.map, "resize");
      state.map.setCenter(center);
    }, 80);
  }

  async function patchProject(projectId, patch){
    const base = String(cfg()?.endpoints?.firstmeasure || "").replace(/\/+$/, "");
    const response = await fetch(`${base}/projects/${encodeURIComponent(projectId)}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json", "Accept": "application/json" },
      body: JSON.stringify(patch || {})
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok || data?.ok === false || data?.success === false) {
      throw new Error(data?.message || data?.error || `Project update failed (${response.status}).`);
    }
    return data;
  }

  async function submitPins(){
    if (state.busy) return;
    const projectId = fullProjectId(state.project);
    if (!projectId) {
      setStatus("Project id is missing.", "error");
      return;
    }
    if (!state.pins.length) {
      setStatus("At least one pin is required.", "error");
      return;
    }
    const actor = window.Projects?.fmActor ? window.Projects.fmActor() : (cfg()?.user || {});
    const nowIso = new Date().toISOString();
    try {
      setBusy(true, "Saving");
      setStatus("Saving pins...");
      await patchProject(projectId, {
        pins: state.pins,
        is_custom_pin: true,
        status: "needs_structure_pins",
        structure_pin_mode: "employee_supplied",
        structure_pin_status: "generating",
        structure_pin_error: null,
        structure_pin_actor: actor,
        timestamps: { structure_pins_submitted_at: nowIso }
      });

      setBusy(true, "Starting");
      setStatus("Starting generation...");
      const result = await window.Portal.fmPost(`projects/${encodeURIComponent(projectId)}/process/imagery`, {
        process_async: true,
        actor
      });
      const resultManifest = result?.project?.manifest || result?.project || {};
      if (String(resultManifest.status || "").trim().toLowerCase() === "rejected") {
        setStatus(result?.message || resultManifest.rejection_message || "Project rejected.", "error");
        if (typeof state.onSubmitted === "function") await state.onSubmitted(result);
        setTimeout(close, 1200);
        return;
      }
      if (!result || result.ok === false || result.success === false) {
        throw new Error(result?.message || result?.error || "Imagery processing failed.");
      }
      setStatus("Generation started.", "ok");
      if (typeof state.onSubmitted === "function") await state.onSubmitted(result);
      setTimeout(close, 350);
    } catch (error) {
      await patchProject(projectId, {
        status: "needs_structure_pins",
        structure_pin_status: "failed",
        structure_pin_error: String(error?.message || error || "Pin processing failed."),
        timestamps: { structure_pins_failed_at: new Date().toISOString() }
      }).catch(() => null);
      setStatus(String(error?.message || error || "Pin processing failed."), "error");
    } finally {
      setBusy(false);
    }
  }

  function close(){
    const overlay = document.getElementById("structurePinModal");
    if (overlay) overlay.classList.remove("open");
    state.open = false;
  }

  async function open(options = {}){
    const overlay = ensureModal();
    state.open = true;
    state.busy = false;
    state.project = options.project || {};
    state.onSubmitted = options.onSubmitted || null;
    state.map = null;
    state.markers = [];
    state.pins = [];
    overlay.classList.add("open");
    setBusy(false);
    setStatus("");
    try {
      const project = await loadProject(options.project || {});
      state.project = project;
      const address = String(project?.address || fullProjectId(project) || "Project").trim();
      const title = document.getElementById("spmTitle");
      const addr = document.getElementById("spmAddress");
      const type = document.getElementById("spmProjectType");
      if (title) title.textContent = "Structure Pins";
      if (addr) addr.textContent = address;
      if (type) type.textContent = String(project?.project_type || "residential").toUpperCase();
      state.pins = normalizePins(project?.pins);
      renderPins();
      await initMap(project);
    } catch (error) {
      setStatus(String(error?.message || error || "Could not load pin modal."), "error");
    }
  }

  window.StructurePinModal = { open, close };
})();
