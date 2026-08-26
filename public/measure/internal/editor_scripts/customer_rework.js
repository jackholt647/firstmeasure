/* customer_rework.js
 * Shows customer-requested report changes inside the Measure editor.
 */
(function(){
  let lastSig = '';
  let panelOpen = true;

  function esc(value){
    return String(value ?? '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  function fmtWhen(value){
    if (!value) return '';
    const t = Date.parse(String(value));
    if (!Number.isFinite(t)) return String(value);
    try { return new Date(t).toLocaleString(); } catch (e) { return String(value); }
  }

  function getRequests(manifest){
    if (!manifest || typeof manifest !== 'object') return [];
    const pools = [
      Array.isArray(manifest.report_change_requests) ? manifest.report_change_requests : [],
      manifest.latest_report_change_request ? [manifest.latest_report_change_request] : []
    ];
    const seen = new Set();
    const out = [];
    pools.flat().forEach((entry) => {
      if (!entry || typeof entry !== 'object') return;
      const id = String(entry.id || entry.request_id || `${entry.created_at || ''}|${entry.type || ''}|${entry.notes || ''}`);
      if (id && seen.has(id)) return;
      if (id) seen.add(id);
      out.push(entry);
    });
    return out.sort((a, b) => (Date.parse(String(b.created_at || b.requested_at || '')) || 0) - (Date.parse(String(a.created_at || a.requested_at || '')) || 0));
  }

  function labelFor(type){
    const key = String(type || '').toLowerCase();
    if (key === 'additional_structure') return 'Additional Structure';
    if (key === 'report_issue') return 'Reported Issue';
    if (key === 'change_correction') return 'Change / Correction';
    return key ? key.replace(/_/g, ' ') : 'Customer Request';
  }

  function iconFor(type){
    const key = String(type || '').toLowerCase();
    if (key === 'additional_structure') return 'fa-location-dot';
    if (key === 'report_issue') return 'fa-circle-exclamation';
    return 'fa-pen-to-square';
  }

  function getPins(requests){
    return requests
      .filter((request) => String(request.type || request.request_type || '').toLowerCase() === 'additional_structure')
      .flatMap((request) => Array.isArray(request.pins) ? request.pins : [])
      .map((pin) => ({
        lat: Number(pin && (pin.lat ?? pin.latitude)),
        lng: Number(pin && (pin.lng ?? pin.longitude))
      }))
      .filter((pin) => Number.isFinite(pin.lat) && Number.isFinite(pin.lng));
  }

  function getPhotos(request){
    return Array.isArray(request.photos)
      ? request.photos.filter((photo) => photo && (photo.data_url || photo.dataUrl || photo.url || photo.src))
      : [];
  }

  function ensureStyles(){
    if (document.getElementById('customerReworkEditorStyles')) return;
    const style = document.createElement('style');
    style.id = 'customerReworkEditorStyles';
    style.textContent = `
      .customer-rework-fab {
        position: fixed;
        left: 20px;
        bottom: 20px;
        z-index: 9000;
        display: flex;
        align-items: center;
        gap: 12px;
        padding: 14px 18px;
        border-radius: 16px;
        border: 1px solid rgba(123,31,162,0.25);
        background: rgba(255,255,255,0.98);
        color: #202124;
        font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
        cursor: pointer;
        user-select: none;
        box-shadow: 0 8px 32px rgba(0,0,0,0.15);
      }
      .customer-rework-fab:hover {
        transform: translateY(-2px);
        box-shadow: 0 12px 40px rgba(0,0,0,0.2);
      }
      .customer-rework-fab .icon {
        width: 40px;
        height: 40px;
        border-radius: 12px;
        display: flex;
        align-items: center;
        justify-content: center;
        background: rgba(123,31,162,0.12);
        color: #7b1fa2;
        font-size: 18px;
      }
      .customer-rework-fab .title {
        font-weight: 900;
        font-size: 14px;
        line-height: 1.2;
      }
      .customer-rework-fab .sub {
        font-size: 12px;
        color: #666;
        font-weight: 600;
      }
      .customer-rework-fab .badge {
        min-width: 24px;
        height: 24px;
        padding: 0 8px;
        border-radius: 999px;
        background: rgba(123,31,162,0.12);
        color: #7b1fa2;
        font-size: 12px;
        font-weight: 900;
        display: flex;
        align-items: center;
        justify-content: center;
      }
      .customer-rework-panel {
        position: fixed;
        left: 20px;
        bottom: 100px;
        z-index: 9001;
        width: min(600px, calc(100vw - 40px));
        max-height: min(70vh, 700px);
        overflow: auto;
        border: 1px solid #d7b7ff;
        border-radius: 14px;
        background: rgba(255,255,255,0.98);
        box-shadow: 0 18px 48px rgba(60,20,95,0.22);
        font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
        color: #202124;
        display: none;
      }
      .customer-rework-panel.show {
        display: block;
        animation: customerReworkSlideUp .2s ease;
      }
      @keyframes customerReworkSlideUp {
        from { opacity: 0; transform: translateY(20px); }
        to { opacity: 1; transform: translateY(0); }
      }
      .customer-rework-head {
        display: flex;
        align-items: center;
        gap: 10px;
        padding: 12px 14px;
        background: #fbf7ff;
        border-bottom: 1px solid #eadcff;
        color: #5e1681;
        font-weight: 950;
      }
      .customer-rework-head button {
        margin-left: auto;
        width: 28px;
        height: 28px;
        border: 1px solid #d7b7ff;
        border-radius: 8px;
        background: #fff;
        color: #5e1681;
        cursor: pointer;
      }
      .customer-rework-body { padding: 12px; display: grid; gap: 10px; }
      .customer-rework-card {
        border: 1px solid #eadcff;
        border-radius: 10px;
        background: #fff;
        padding: 10px;
        box-shadow: inset 3px 0 0 #7b1fa2;
      }
      .customer-rework-title {
        display: flex;
        align-items: center;
        gap: 7px;
        color: #5e1681;
        font-size: 13px;
        font-weight: 950;
      }
      .customer-rework-meta {
        margin-top: 3px;
        color: #5f6368;
        font-size: 11px;
        font-weight: 750;
      }
      .customer-rework-lead {
        margin-top: 8px;
        color: #202124;
        font-size: 12px;
        font-weight: 900;
      }
      .customer-rework-notes {
        margin-top: 8px;
        border: 1px solid #eadcff;
        border-radius: 8px;
        background: #f8f3ff;
        padding: 9px;
        color: #202124;
        font-size: 12px;
        font-weight: 700;
        line-height: 1.45;
        white-space: pre-wrap;
      }
      .customer-rework-pins {
        display: flex;
        flex-wrap: wrap;
        gap: 6px;
        margin-top: 9px;
      }
      .customer-rework-pin {
        display: inline-flex;
        align-items: center;
        gap: 6px;
        padding: 5px 8px;
        border: 1px solid #d7b7ff;
        border-radius: 999px;
        background: #f3e8ff;
        color: #5e1681;
        font-size: 10px;
        font-weight: 950;
      }
      .customer-rework-images {
        display: flex;
        gap: 8px;
        flex-wrap: wrap;
        margin-top: 9px;
      }
      .customer-rework-images a {
        width: 74px;
        height: 74px;
        border: 1px solid #d7b7ff;
        border-radius: 8px;
        overflow: hidden;
        background: #fff;
      }
      .customer-rework-images img {
        width: 100%;
        height: 100%;
        object-fit: cover;
        display: block;
      }
    `;
    document.head.appendChild(style);
  }

  function renderPanel(manifest){
    ensureStyles();
    const requests = getRequests(manifest);
    const existing = document.getElementById('customerReworkPanel');
    const existingFab = document.getElementById('customerReworkFab');
    if (!requests.length) {
      if (existing) existing.remove();
      if (existingFab) existingFab.remove();
      clearMapMarkers();
      lastSig = '';
      return;
    }

    const sig = JSON.stringify(requests.map((request) => ({
      id: request.id || request.request_id || '',
      type: request.type || request.request_type || '',
      created_at: request.created_at || request.requested_at || '',
      notes: request.notes || '',
      pins: request.pins || [],
      photos: (request.photos || []).map((photo) => photo && (photo.name || photo.url || photo.src || photo.data_url || photo.dataUrl || '')).slice(0, 8)
    })));
    if (sig === lastSig && existing && existingFab) {
      drawMapMarkers(requests);
      return;
    }
    lastSig = sig;

    const cards = requests.map((request) => {
      const type = String(request.type || request.request_type || '').toLowerCase();
      const pins = Array.isArray(request.pins) ? request.pins : [];
      const photos = getPhotos(request);
      const meta = [fmtWhen(request.created_at || request.requested_at), request.created_by_name || request.created_by_email || '', request.status ? String(request.status).replace(/_/g, ' ') : 'pending']
        .filter(Boolean)
        .join(' - ');
      const lead = type === 'additional_structure'
        ? 'Customer requested this additional structure be drawn.'
        : (type === 'report_issue' ? 'Customer reported an issue on the returned report.' : 'Customer requested this correction/change.');
      const pinHtml = pins.length
        ? `<div class="customer-rework-pins">${pins.map((pin, idx) => {
            const lat = Number(pin.lat ?? pin.latitude);
            const lng = Number(pin.lng ?? pin.longitude);
            if (!Number.isFinite(lat) || !Number.isFinite(lng)) return '';
            return `<span class="customer-rework-pin"><i class="fas fa-location-dot"></i> Requested structure ${idx + 1}: ${esc(lat.toFixed(6))}, ${esc(lng.toFixed(6))}</span>`;
          }).join('')}</div>`
        : '';
      const photoHtml = photos.length
        ? `<div class="customer-rework-images">${photos.map((photo, idx) => {
            const src = photo.data_url || photo.dataUrl || photo.url || photo.src || '';
            const name = photo.name || `Customer image ${idx + 1}`;
            return `<a href="${esc(src)}" target="_blank" rel="noopener"><img src="${esc(src)}" alt="${esc(name)}"></a>`;
          }).join('')}</div>`
        : '';
      return `<div class="customer-rework-card">
        <div class="customer-rework-title"><i class="fas ${esc(iconFor(type))}"></i> ${esc(labelFor(type))}</div>
        <div class="customer-rework-meta">${esc(meta)}</div>
        <div class="customer-rework-lead">${esc(lead)}</div>
        ${request.notes ? `<div class="customer-rework-notes">${esc(request.notes)}</div>` : ''}
        ${pinHtml}
        ${photoHtml}
      </div>`;
    }).join('');

    const fab = existingFab || document.createElement('div');
    fab.id = 'customerReworkFab';
    fab.className = 'customer-rework-fab';
    fab.innerHTML = `
      <div class="icon"><i class="fas fa-screwdriver-wrench"></i></div>
      <div class="txt">
        <div class="title">Customer Rework</div>
        <div class="sub">Tap to view request</div>
      </div>
      <span class="badge">${requests.length}</span>
    `;
    fab.onclick = () => {
      panelOpen = !panelOpen;
      const target = document.getElementById('customerReworkPanel');
      if (target) target.classList.toggle('show', panelOpen);
    };
    if (!existingFab) document.body.appendChild(fab);

    const panel = existing || document.createElement('div');
    panel.id = 'customerReworkPanel';
    panel.className = existing ? existing.className : 'customer-rework-panel';
    panel.classList.toggle('show', panelOpen);
    panel.innerHTML = `
      <div class="customer-rework-head">
        <i class="fas fa-screwdriver-wrench"></i>
        <span>Customer Rework</span>
        <button type="button" id="customerReworkCollapseBtn" title="Hide"><i class="fas fa-times"></i></button>
      </div>
      <div class="customer-rework-body">${cards}</div>
    `;
    if (!existing) document.body.appendChild(panel);
    const btn = document.getElementById('customerReworkCollapseBtn');
    if (btn) {
      btn.onclick = () => {
        panelOpen = false;
        panel.classList.remove('show');
      };
    }
    drawMapMarkers(requests);
  }

  function clearMapMarkers(){
    document.querySelectorAll('.customer-rework-map-marker').forEach((node) => node.remove());
  }

  function drawMapMarkers(){
    clearMapMarkers();
    if (typeof window.renderGeometry2D === 'function') window.renderGeometry2D();
  }

  window.firstMeasureRenderCustomerReworkPrompt = function(manifest){
    renderPanel(manifest || window.currentProjectManifest || null);
  };

  window.firstMeasureGetAdditionalStructureRequestPins = function(manifest){
    return getPins(getRequests(manifest || window.currentProjectManifest || null));
  };

  window.firstMeasureRefreshCustomerReworkMarkers = function(){
    clearMapMarkers();
    if (typeof window.renderGeometry2D === 'function') window.renderGeometry2D();
  };

  window.addEventListener('resize', () => {
    clearMapMarkers();
    if (window.currentProjectManifest && typeof window.renderGeometry2D === 'function') window.renderGeometry2D();
  });
})();
