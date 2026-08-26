(function(){
  if (!window.Portal) return;

  const cfg = () => window.Portal?.cfg || window.PORTAL_CFG || {};
  const esc = (value) => window.Portal.escapeHtml(value);

  const state = {
    initialized: false,
    loading: false,
    syncing: false,
    error: '',
    data: null,
    selectedExtensionKey: '',
    smsFilter: 'all',
    callFilter: 'all'
  };

  function ensureStyles(){
    if (document.getElementById('smsDebugStyles')) return;
    const style = document.createElement('style');
    style.id = 'smsDebugStyles';
    style.textContent = `
      .sms-debug-shell{display:grid;gap:16px}
      .sms-debug-hero{display:grid;grid-template-columns:repeat(auto-fit,minmax(180px,1fr));gap:12px}
      .sms-debug-metric{background:#fff;border:1px solid #e6eaf0;border-radius:14px;padding:14px 16px;box-shadow:0 10px 24px rgba(16,24,40,.04)}
      .sms-debug-metric-label{font-size:11px;font-weight:900;text-transform:uppercase;letter-spacing:.05em;color:#758194}
      .sms-debug-metric-value{margin-top:6px;font-size:24px;font-weight:900;color:#223040}
      .sms-debug-metric-meta{margin-top:4px;font-size:12px;color:#667487}
      .sms-debug-layout{display:grid;grid-template-columns:minmax(260px,320px) minmax(0,1fr);gap:16px;align-items:start}
      .sms-debug-card{background:#fff;border:1px solid #e6eaf0;border-radius:16px;overflow:hidden;box-shadow:0 10px 24px rgba(16,24,40,.04)}
      .sms-debug-card-head{display:flex;justify-content:space-between;align-items:center;gap:10px;padding:14px 16px;border-bottom:1px solid #eef2f6;background:#fbfcfe}
      .sms-debug-card-head h3{margin:0;font-size:12px;font-weight:900;text-transform:uppercase;letter-spacing:.05em;color:#5f6b7d}
      .sms-debug-card-head small{font-size:11px;color:#7a8595}
      .sms-debug-card-body{padding:14px 16px}
      .sms-debug-extension-list{display:grid;gap:10px}
      .sms-debug-extension-item{border:1px solid #e6eaf0;border-radius:14px;padding:12px 13px;background:#fff;cursor:pointer;display:grid;gap:8px;transition:.16s ease}
      .sms-debug-extension-item:hover{border-color:#cfd8e3;transform:translateY(-1px)}
      .sms-debug-extension-item.active{border-color:#d93025;box-shadow:0 0 0 3px rgba(217,48,37,.10)}
      .sms-debug-extension-title{display:flex;justify-content:space-between;align-items:flex-start;gap:10px}
      .sms-debug-extension-email{font-size:13px;font-weight:900;color:#223040;word-break:break-word}
      .sms-debug-extension-actors{font-size:11px;color:#6f7b8b}
      .sms-debug-extension-stats{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:8px}
      .sms-debug-extension-stat{background:#f7f9fc;border-radius:10px;padding:8px}
      .sms-debug-extension-stat .k{font-size:10px;font-weight:900;color:#7a8595;text-transform:uppercase}
      .sms-debug-extension-stat .v{margin-top:4px;font-size:13px;font-weight:800;color:#223040}
      .sms-debug-status{display:inline-flex;align-items:center;gap:6px;border-radius:999px;padding:4px 9px;font-size:10px;font-weight:900;text-transform:uppercase;letter-spacing:.04em}
      .sms-debug-status.ok{background:#e7f6ec;color:#157347}
      .sms-debug-status.error{background:#fce8e6;color:#b42318}
      .sms-debug-status.running{background:#e8f0fe;color:#0b57d0}
      .sms-debug-status.idle{background:#eef2f6;color:#667487}
      .sms-debug-detail-grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:12px}
      .sms-debug-detail-list{display:grid;gap:8px}
      .sms-debug-detail-row{display:flex;justify-content:space-between;gap:12px;padding:8px 0;border-bottom:1px solid #f0f3f7}
      .sms-debug-detail-row:last-child{border-bottom:none}
      .sms-debug-detail-row .k{font-size:11px;font-weight:900;color:#738095;text-transform:uppercase}
      .sms-debug-detail-row .v{font-size:12px;color:#223040;text-align:right;word-break:break-word}
      .sms-debug-toolbar{display:flex;justify-content:space-between;align-items:center;gap:12px;flex-wrap:wrap}
      .sms-debug-filter-group{display:flex;gap:6px;flex-wrap:wrap}
      .sms-debug-filter-btn{border:1px solid #d7dee9;background:#fff;border-radius:999px;padding:5px 10px;font-size:11px;font-weight:800;color:#445366;cursor:pointer}
      .sms-debug-filter-btn.active{background:#223040;border-color:#223040;color:#fff}
      .sms-debug-table-wrap{overflow:auto}
      .sms-debug-table{width:100%;border-collapse:collapse}
      .sms-debug-table th,.sms-debug-table td{padding:10px 8px;border-bottom:1px solid #eef2f6;vertical-align:top;text-align:left;font-size:12px}
      .sms-debug-table th{font-size:10px;font-weight:900;text-transform:uppercase;letter-spacing:.05em;color:#738095;background:#fbfcfe;position:sticky;top:0}
      .sms-debug-subject{font-weight:900;color:#223040}
      .sms-debug-snippet{margin-top:4px;color:#667487;line-height:1.45}
      .sms-debug-pill{display:inline-flex;align-items:center;border-radius:999px;padding:3px 8px;font-size:10px;font-weight:900;text-transform:uppercase;letter-spacing:.04em}
      .sms-debug-pill.matched{background:#e7f6ec;color:#157347}
      .sms-debug-pill.unmatched{background:#fff7ea;color:#9a5b00}
      .sms-debug-lead-tags{display:flex;flex-wrap:wrap;gap:6px}
      .sms-debug-lead-tag{display:inline-flex;align-items:center;gap:6px;border:1px solid #d7dee9;border-radius:999px;padding:4px 8px;background:#fff;font-size:11px;font-weight:800;color:#455468}
      .sms-debug-empty{padding:28px 14px;text-align:center;color:#7b8797;font-weight:700}
      .sms-debug-note{font-size:12px;color:#667487;line-height:1.55}
      .sms-debug-error{background:#fce8e6;color:#b42318;border:1px solid #f4c7c3;border-radius:12px;padding:12px 14px;font-size:13px;font-weight:700}
      @media (max-width: 1100px){
        .sms-debug-layout{grid-template-columns:1fr}
        .sms-debug-detail-grid{grid-template-columns:1fr}
      }
    `;
    document.head.appendChild(style);
  }

  function fmtTs(ts){
    const n = Number(ts || 0);
    if (!n) return 'Never';
    const d = new Date(n * 1000);
    return Number.isNaN(d.getTime()) ? 'Never' : d.toLocaleString();
  }

  function fmtAgo(ts){
    const n = Number(ts || 0);
    if (!n) return 'Never';
    const delta = Math.max(0, Math.floor(Date.now() / 1000) - n);
    if (delta < 60) return `${delta}s ago`;
    if (delta < 3600) return `${Math.floor(delta / 60)}m ago`;
    if (delta < 86400) return `${Math.floor(delta / 3600)}h ago`;
    return `${Math.floor(delta / 86400)}d ago`;
  }

  function extensionList(){
    return Array.isArray(state.data?.extensions) ? state.data.extensions : [];
  }

  function selectedDetail(){
    return state.data?.selected_extension || null;
  }

  function selectedSummary(){
    return selectedDetail()?.summary || null;
  }

  function selectedSmsRows(){
    const rows = Array.isArray(selectedDetail()?.inbox) ? selectedDetail().inbox : [];
    if (state.smsFilter === 'matched') return rows.filter(row => row.association_status === 'matched');
    if (state.smsFilter === 'unmatched') return rows.filter(row => row.association_status === 'unmatched');
    return rows;
  }

  function selectedCallRows(){
    const rows = Array.isArray(selectedDetail()?.call_log) ? selectedDetail().call_log : [];
    if (state.callFilter === 'matched') return rows.filter(row => row.association_status === 'matched');
    if (state.callFilter === 'unmatched') return rows.filter(row => row.association_status === 'unmatched');
    return rows;
  }

  function canRunSync(){
    return !!selectedSummary()?.extension_key;
  }

  function api(payload){
    return window.Portal.apiPost(cfg().endpoints?.server || window.Portal.internalLegacyEndpoint(), payload);
  }

  async function load(extensionKey){
    state.loading = true;
    state.error = '';
    render();
    try {
      const payload = { action: 'ringcentral_debug_snapshot', limit: 180 };
      const selected = String(extensionKey || state.selectedExtensionKey || '').trim();
      if (selected) payload.extension_key = selected;
      const data = await api(payload);
      if (!data || data.success === false) {
        throw new Error(data?.error || 'Could not load SMS debug snapshot.');
      }
      state.data = data.debug || null;
      const available = extensionList();
      if (selected) state.selectedExtensionKey = selected;
      else if (!state.selectedExtensionKey && available[0]?.extension_key) state.selectedExtensionKey = String(available[0].extension_key);
    } catch (err) {
      state.error = err?.message || 'Could not load SMS debug snapshot.';
    } finally {
      state.loading = false;
      render();
    }
  }

  async function runSync(){
    if (state.syncing || !canRunSync()) return;
    state.syncing = true;
    state.error = '';
    render();
    try {
      const data = await api({ action: 'ringcentral_background_sync' });
      if (!data || data.success === false) {
        throw new Error(data?.error || 'Could not run RingCentral sync.');
      }
      await load(state.selectedExtensionKey);
    } catch (err) {
      state.error = err?.message || 'Could not run RingCentral sync.';
    } finally {
      state.syncing = false;
      render();
    }
  }

  function bind(container){
    container.querySelectorAll('[data-sms-debug-extension]').forEach(btn => {
      if (btn.dataset.wired === 'true') return;
      btn.dataset.wired = 'true';
      btn.addEventListener('click', () => {
        state.selectedExtensionKey = btn.getAttribute('data-sms-debug-extension') || '';
        load(state.selectedExtensionKey);
      });
    });
    container.querySelectorAll('[data-sms-debug-sms-filter]').forEach(btn => {
      if (btn.dataset.wired === 'true') return;
      btn.dataset.wired = 'true';
      btn.addEventListener('click', () => {
        state.smsFilter = btn.getAttribute('data-sms-debug-sms-filter') || 'all';
        render();
      });
    });
    container.querySelectorAll('[data-sms-debug-call-filter]').forEach(btn => {
      if (btn.dataset.wired === 'true') return;
      btn.dataset.wired = 'true';
      btn.addEventListener('click', () => {
        state.callFilter = btn.getAttribute('data-sms-debug-call-filter') || 'all';
        render();
      });
    });
    const refreshBtn = container.querySelector('[data-sms-debug-refresh]');
    if (refreshBtn && refreshBtn.dataset.wired !== 'true') {
      refreshBtn.dataset.wired = 'true';
      refreshBtn.addEventListener('click', () => load(state.selectedExtensionKey));
    }
    const syncBtn = container.querySelector('[data-sms-debug-sync]');
    if (syncBtn && syncBtn.dataset.wired !== 'true') {
      syncBtn.dataset.wired = 'true';
      syncBtn.addEventListener('click', () => runSync());
    }
  }

  function statusBadge(status){
    const raw = String(status || '').trim().toLowerCase();
    const tone = raw === 'ok' ? 'ok' : raw === 'error' ? 'error' : raw === 'running' ? 'running' : 'idle';
    const label = raw ? raw : 'idle';
    return `<span class="sms-debug-status ${tone}">${esc(label)}</span>`;
  }

  function metric(label, value, meta){
    return `
      <div class="sms-debug-metric">
        <div class="sms-debug-metric-label">${esc(label)}</div>
        <div class="sms-debug-metric-value">${esc(String(value))}</div>
        <div class="sms-debug-metric-meta">${esc(meta)}</div>
      </div>
    `;
  }

  function renderExtensionList(){
    const rows = extensionList();
    if (!rows.length) {
      return `<div class="sms-debug-empty">No RingCentral extension cache exists yet. Run a sync first.</div>`;
    }
    return `
      <div class="sms-debug-extension-list">
        ${rows.map(row => `
          <button type="button" class="sms-debug-extension-item ${String(row.extension_key) === String(state.selectedExtensionKey) ? 'active' : ''}" data-sms-debug-extension="${esc(row.extension_key)}">
            <div class="sms-debug-extension-title">
              <div>
                <div class="sms-debug-extension-email">${esc(row.extension_email || row.extension_name || row.extension_number || 'Extension')}</div>
                <div class="sms-debug-extension-actors">${esc((row.actors || []).join(', ') || 'No linked CRM users')}</div>
              </div>
              ${statusBadge(row.last_sync_status)}
            </div>
            <div class="sms-debug-extension-stats">
              <div class="sms-debug-extension-stat"><div class="k">Matched SMS</div><div class="v">${esc(String(row.message_count || 0))}</div></div>
              <div class="sms-debug-extension-stat"><div class="k">Matched Calls</div><div class="v">${esc(String(row.call_count || 0))}</div></div>
              <div class="sms-debug-extension-stat"><div class="k">Unmatched</div><div class="v">${esc(String((row.unmatched_message_count || 0) + (row.unmatched_call_count || 0)))}</div></div>
              <div class="sms-debug-extension-stat"><div class="k">Last Sync</div><div class="v">${esc(fmtAgo(row.last_sync_at))}</div></div>
            </div>
          </button>
        `).join('')}
      </div>
    `;
  }

  function renderAssociatedLeads(detail){
    const leads = Array.isArray(detail?.associated_leads) ? detail.associated_leads : [];
    if (!leads.length) {
      return `<div class="sms-debug-empty">No leads have been associated with this RingCentral extension yet.</div>`;
    }
    return `
      <div class="sms-debug-table-wrap">
        <table class="sms-debug-table">
          <thead>
            <tr>
              <th>Company</th>
              <th>Lead</th>
              <th>Email</th>
              <th>Status</th>
              <th>Owner</th>
            </tr>
          </thead>
          <tbody>
            ${leads.map(lead => `
              <tr>
                <td><strong>${esc(lead.company || '-')}</strong></td>
                <td>${esc(lead.lead_name || '-')}</td>
                <td>${esc(lead.email || '-')}</td>
                <td>${esc(lead.status || '-')}</td>
                <td>${esc(lead.assigned_to_email || '-')}</td>
              </tr>
            `).join('')}
          </tbody>
        </table>
      </div>
    `;
  }

  function renderSmsTable(detail){
    const rows = selectedSmsRows();
    const totalAll = Array.isArray(detail?.inbox) ? detail.inbox.length : 0;
    const matchedCount = Array.isArray(detail?.messages) ? detail.messages.length : 0;
    const unmatchedCount = Array.isArray(detail?.unmatched_messages) ? detail.unmatched_messages.length : 0;
    return `
      <div class="sms-debug-toolbar">
        <div class="sms-debug-note">Cached SMS rows for this RingCentral extension. Matched rows are already linked to CRM leads; unmatched rows were pulled from RingCentral but do not yet map to a lead phone.</div>
        <div class="sms-debug-filter-group">
          <button type="button" class="sms-debug-filter-btn ${state.smsFilter === 'all' ? 'active' : ''}" data-sms-debug-sms-filter="all">All (${esc(String(totalAll))})</button>
          <button type="button" class="sms-debug-filter-btn ${state.smsFilter === 'matched' ? 'active' : ''}" data-sms-debug-sms-filter="matched">Matched (${esc(String(matchedCount))})</button>
          <button type="button" class="sms-debug-filter-btn ${state.smsFilter === 'unmatched' ? 'active' : ''}" data-sms-debug-sms-filter="unmatched">Unmatched (${esc(String(unmatchedCount))})</button>
        </div>
      </div>
      ${rows.length ? `
        <div class="sms-debug-table-wrap" style="margin-top:12px;">
          <table class="sms-debug-table">
            <thead>
              <tr>
                <th>When</th>
                <th>Status</th>
                <th>Body</th>
                <th>Phones</th>
                <th>Leads</th>
              </tr>
            </thead>
            <tbody>
              ${rows.map(row => `
                <tr>
                  <td>
                    <div><strong>${esc(fmtTs(row.happened_at))}</strong></div>
                    <div style="margin-top:4px;color:#738095;">${esc(fmtAgo(row.happened_at))}</div>
                  </td>
                  <td>
                    <span class="sms-debug-pill ${row.association_status === 'matched' ? 'matched' : 'unmatched'}">${esc(row.association_status || 'unknown')}</span>
                    <div style="margin-top:6px;color:#738095;">${esc((row.direction || '').toUpperCase() || '-')}</div>
                  </td>
                  <td>
                    <div class="sms-debug-subject">${esc(row.subject || 'SMS')}</div>
                    <div class="sms-debug-snippet">${esc(row.body_text || '')}</div>
                  </td>
                  <td>
                    <div>From: ${esc(row.from_phone || '-')}</div>
                    <div style="margin-top:4px;color:#738095;">To: ${esc((row.to_phones || []).join(', ') || '-')}</div>
                    <div style="margin-top:4px;color:#738095;">External: ${esc(row.external_phone || '-')}</div>
                  </td>
                  <td>
                    ${(row.lead_ids || []).length ? `
                      <div class="sms-debug-lead-tags">
                        ${(row.lead_ids || []).map(leadId => `<span class="sms-debug-lead-tag">${esc(leadId)}</span>`).join('')}
                      </div>
                    ` : '<span style="color:#9a5b00;font-weight:800;">No matched lead</span>'}
                  </td>
                </tr>
              `).join('')}
            </tbody>
          </table>
        </div>
      ` : '<div class="sms-debug-empty">No SMS rows in this view yet for the selected filter.</div>'}
    `;
  }

  function renderCallTable(detail){
    const rows = selectedCallRows();
    const totalAll = Array.isArray(detail?.call_log) ? detail.call_log.length : 0;
    const matchedCount = Array.isArray(detail?.calls) ? detail.calls.length : 0;
    const unmatchedCount = Array.isArray(detail?.unmatched_calls) ? detail.unmatched_calls.length : 0;
    return `
      <div class="sms-debug-toolbar">
        <div class="sms-debug-note">Cached RingCentral call log rows for this extension. Matched rows are already attached to leads; unmatched rows did not map to a lead phone number.</div>
        <div class="sms-debug-filter-group">
          <button type="button" class="sms-debug-filter-btn ${state.callFilter === 'all' ? 'active' : ''}" data-sms-debug-call-filter="all">All (${esc(String(totalAll))})</button>
          <button type="button" class="sms-debug-filter-btn ${state.callFilter === 'matched' ? 'active' : ''}" data-sms-debug-call-filter="matched">Matched (${esc(String(matchedCount))})</button>
          <button type="button" class="sms-debug-filter-btn ${state.callFilter === 'unmatched' ? 'active' : ''}" data-sms-debug-call-filter="unmatched">Unmatched (${esc(String(unmatchedCount))})</button>
        </div>
      </div>
      ${rows.length ? `
        <div class="sms-debug-table-wrap" style="margin-top:12px;">
          <table class="sms-debug-table">
            <thead>
              <tr>
                <th>When</th>
                <th>Status</th>
                <th>Summary</th>
                <th>Phones</th>
                <th>Leads</th>
              </tr>
            </thead>
            <tbody>
              ${rows.map(row => `
                <tr>
                  <td>
                    <div><strong>${esc(fmtTs(row.happened_at))}</strong></div>
                    <div style="margin-top:4px;color:#738095;">${esc(fmtAgo(row.happened_at))}</div>
                  </td>
                  <td>
                    <span class="sms-debug-pill ${row.association_status === 'matched' ? 'matched' : 'unmatched'}">${esc(row.association_status || 'unknown')}</span>
                    <div style="margin-top:6px;color:#738095;">${esc((row.direction || '').toUpperCase() || '-')}</div>
                  </td>
                  <td>
                    <div class="sms-debug-subject">${esc(row.action || 'Call')}</div>
                    <div class="sms-debug-snippet">${esc(`${row.result || '-'} • ${row.duration_seconds || 0}s`)}</div>
                  </td>
                  <td>
                    <div>From: ${esc(row.from_phone || '-')}</div>
                    <div style="margin-top:4px;color:#738095;">To: ${esc((row.to_phones || []).join(', ') || '-')}</div>
                    <div style="margin-top:4px;color:#738095;">External: ${esc(row.external_phone || '-')}</div>
                  </td>
                  <td>
                    ${(row.lead_ids || []).length ? `
                      <div class="sms-debug-lead-tags">
                        ${(row.lead_ids || []).map(leadId => `<span class="sms-debug-lead-tag">${esc(leadId)}</span>`).join('')}
                      </div>
                    ` : '<span style="color:#9a5b00;font-weight:800;">No matched lead</span>'}
                  </td>
                </tr>
              `).join('')}
            </tbody>
          </table>
        </div>
      ` : '<div class="sms-debug-empty">No RingCentral calls in this view yet for the selected filter.</div>'}
    `;
  }

  function renderSyncRuns(detail){
    const runs = Array.isArray(detail?.sync_runs) ? detail.sync_runs : [];
    if (!runs.length) {
      return `<div class="sms-debug-empty">No sync runs have been recorded for this extension yet.</div>`;
    }
    return `
      <div class="sms-debug-table-wrap">
        <table class="sms-debug-table">
          <thead>
            <tr>
              <th>Finished</th>
              <th>Status</th>
              <th>Mode</th>
              <th>Reason</th>
              <th>SMS Examined</th>
              <th>Calls Examined</th>
              <th>Assigned</th>
              <th>Unmatched</th>
            </tr>
          </thead>
          <tbody>
            ${runs.map(run => `
              <tr>
                <td>
                  <div><strong>${esc(fmtTs(run.finished_at || run.started_at))}</strong></div>
                  <div style="margin-top:4px;color:#738095;">Started ${esc(fmtTs(run.started_at))}</div>
                </td>
                <td>
                  ${statusBadge(run.status)}
                  ${run.error ? `<div style="margin-top:6px;color:#b42318;max-width:260px;">${esc(run.error)}</div>` : ''}
                </td>
                <td>${esc(run.mode || '-')}</td>
                <td>${esc(run.reason || '-')}</td>
                <td>${esc(String(run.examined_messages || 0))}</td>
                <td>${esc(String(run.examined_calls || 0))}</td>
                <td>${esc(String((run.assigned_activities || 0) + (run.assigned_calls || 0)))}</td>
                <td>${esc(String((run.unmatched_messages || 0) + (run.unmatched_calls || 0)))}</td>
              </tr>
            `).join('')}
          </tbody>
        </table>
      </div>
    `;
  }

  function renderDetail(){
    const detail = selectedDetail();
    const summary = selectedSummary();
    if (!detail || !summary) {
      return `<div class="sms-debug-card"><div class="sms-debug-empty">Select an extension to inspect its RingCentral cache, lead associations, unmatched rows, and sync history.</div></div>`;
    }
    return `
      <div class="sms-debug-card">
        <div class="sms-debug-card-head">
          <h3>${esc(summary.extension_email || summary.extension_name || summary.extension_number || 'RingCentral Extension')}</h3>
          ${statusBadge(summary.last_sync_status)}
        </div>
        <div class="sms-debug-card-body">
          <div class="sms-debug-detail-grid">
            <div class="sms-debug-detail-list">
              <div class="sms-debug-detail-row"><div class="k">Linked CRM users</div><div class="v">${esc((summary.actors || []).join(', ') || 'None')}</div></div>
              <div class="sms-debug-detail-row"><div class="k">Default SMS number</div><div class="v">${esc(summary.default_sms_number || '-')}</div></div>
              <div class="sms-debug-detail-row"><div class="k">Extension number</div><div class="v">${esc(summary.extension_number || '-')}</div></div>
              <div class="sms-debug-detail-row"><div class="k">Last sync started</div><div class="v">${esc(fmtTs(summary.last_sync_started_at))}</div></div>
              <div class="sms-debug-detail-row"><div class="k">Last sync finished</div><div class="v">${esc(fmtTs(summary.last_sync_at))}</div></div>
              <div class="sms-debug-detail-row"><div class="k">Last sync error</div><div class="v">${esc(summary.last_sync_error || '-')}</div></div>
            </div>
            <div class="sms-debug-detail-list">
              <div class="sms-debug-detail-row"><div class="k">Matched SMS</div><div class="v">${esc(String(summary.message_count || 0))}</div></div>
              <div class="sms-debug-detail-row"><div class="k">Matched Calls</div><div class="v">${esc(String(summary.call_count || 0))}</div></div>
              <div class="sms-debug-detail-row"><div class="k">Unmatched SMS</div><div class="v">${esc(String(summary.unmatched_message_count || 0))}</div></div>
              <div class="sms-debug-detail-row"><div class="k">Unmatched Calls</div><div class="v">${esc(String(summary.unmatched_call_count || 0))}</div></div>
              <div class="sms-debug-detail-row"><div class="k">Associated leads</div><div class="v">${esc(String(summary.lead_count || 0))}</div></div>
              <div class="sms-debug-detail-row"><div class="k">Sync runs saved</div><div class="v">${esc(String(summary.sync_run_count || 0))}</div></div>
            </div>
          </div>
        </div>
      </div>

      <div class="sms-debug-card" style="margin-top:16px;">
        <div class="sms-debug-card-head">
          <h3>Associated Leads</h3>
          <small>${esc(String((detail.associated_leads || []).length))} lead${(detail.associated_leads || []).length === 1 ? '' : 's'}</small>
        </div>
        <div class="sms-debug-card-body">${renderAssociatedLeads(detail)}</div>
      </div>

      <div class="sms-debug-card" style="margin-top:16px;">
        <div class="sms-debug-card-head">
          <h3>SMS Cache</h3>
          <small>Matched and unmatched text messages</small>
        </div>
        <div class="sms-debug-card-body">${renderSmsTable(detail)}</div>
      </div>

      <div class="sms-debug-card" style="margin-top:16px;">
        <div class="sms-debug-card-head">
          <h3>Call Cache</h3>
          <small>Matched and unmatched RingCentral calls</small>
        </div>
        <div class="sms-debug-card-body">${renderCallTable(detail)}</div>
      </div>

      <div class="sms-debug-card" style="margin-top:16px;">
        <div class="sms-debug-card-head">
          <h3>Sync Runs</h3>
          <small>Background pull results and timestamps</small>
        </div>
        <div class="sms-debug-card-body">${renderSyncRuns(detail)}</div>
      </div>
    `;
  }

  function render(){
    const host = document.getElementById('view-sms-debug');
    if (!host) return;
    ensureStyles();
    const extensions = extensionList();
    const summary = selectedSummary();
    host.innerHTML = `
      <div class="sms-debug-shell">
        <div class="header-bar">
          <h1>SMS Debug</h1>
          <div style="display:flex;gap:10px;flex-wrap:wrap;">
            <button class="btn-secondary" type="button" data-sms-debug-refresh ${state.loading ? 'disabled' : ''}><i class="fas fa-sync${state.loading ? ' fa-spin' : ''}"></i> ${state.loading ? 'Refreshing...' : 'Refresh Snapshot'}</button>
            <button class="btn-primary" type="button" data-sms-debug-sync ${state.syncing || !canRunSync() ? 'disabled' : ''}><i class="fas fa-cloud-arrow-down${state.syncing ? ' fa-spin' : ''}"></i> ${state.syncing ? 'Syncing...' : 'Run RingCentral Sync'}</button>
          </div>
        </div>

        <div class="sms-debug-note">This is a temporary internal debug surface for the RingCentral cache. It shows stored text/call state, lead associations, unmatched rows, and recorded sync results so we can validate the SMS/call pipeline without guessing.</div>

        ${state.error ? `<div class="sms-debug-error">${esc(state.error)}</div>` : ''}

        <div class="sms-debug-hero">
          ${metric('Extensions', extensions.length, 'Cached RingCentral extensions visible to you')}
          ${metric('Selected Extension', summary?.extension_email || summary?.extension_name || '-', summary ? `Last sync ${fmtAgo(summary.last_sync_at)}` : 'No extension selected')}
          ${metric('Matched SMS', summary?.message_count || 0, summary ? `${summary.unmatched_message_count || 0} unmatched texts` : 'No selected extension')}
          ${metric('Matched Calls', summary?.call_count || 0, summary ? `${summary.unmatched_call_count || 0} unmatched calls` : 'No selected extension')}
        </div>

        <div class="sms-debug-layout">
          <div class="sms-debug-card">
            <div class="sms-debug-card-head">
              <h3>Extensions</h3>
              <small>${esc(String(extensions.length))} available</small>
            </div>
            <div class="sms-debug-card-body">${renderExtensionList()}</div>
          </div>
          <div>${renderDetail()}</div>
        </div>
      </div>
    `;
    bind(host);
  }

  const SmsDebug = {
    init(){
      if (state.initialized) return;
      state.initialized = true;
      ensureStyles();
      render();
    },
    async onShow(){
      this.init();
      await load(state.selectedExtensionKey);
    }
  };

  window.SmsDebug = SmsDebug;
})();
