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
    selectedMailboxKey: '',
    inboxFilter: 'all'
  };

  function ensureStyles(){
    if (document.getElementById('emailDebugStyles')) return;
    const style = document.createElement('style');
    style.id = 'emailDebugStyles';
    style.textContent = `
      .email-debug-shell{display:grid;gap:16px}
      .email-debug-hero{display:grid;grid-template-columns:repeat(auto-fit,minmax(180px,1fr));gap:12px}
      .email-debug-metric{background:#fff;border:1px solid #e6eaf0;border-radius:14px;padding:14px 16px;box-shadow:0 10px 24px rgba(16,24,40,.04)}
      .email-debug-metric-label{font-size:11px;font-weight:900;text-transform:uppercase;letter-spacing:.05em;color:#758194}
      .email-debug-metric-value{margin-top:6px;font-size:24px;font-weight:900;color:#223040}
      .email-debug-metric-meta{margin-top:4px;font-size:12px;color:#667487}
      .email-debug-layout{display:grid;grid-template-columns:minmax(260px,320px) minmax(0,1fr);gap:16px;align-items:start}
      .email-debug-card{background:#fff;border:1px solid #e6eaf0;border-radius:16px;overflow:hidden;box-shadow:0 10px 24px rgba(16,24,40,.04)}
      .email-debug-card-head{display:flex;justify-content:space-between;align-items:center;gap:10px;padding:14px 16px;border-bottom:1px solid #eef2f6;background:#fbfcfe}
      .email-debug-card-head h3{margin:0;font-size:12px;font-weight:900;text-transform:uppercase;letter-spacing:.05em;color:#5f6b7d}
      .email-debug-card-head small{font-size:11px;color:#7a8595}
      .email-debug-card-body{padding:14px 16px}
      .email-debug-mailbox-list{display:grid;gap:10px}
      .email-debug-mailbox-item{border:1px solid #e6eaf0;border-radius:14px;padding:12px 13px;background:#fff;cursor:pointer;display:grid;gap:8px;transition:.16s ease}
      .email-debug-mailbox-item:hover{border-color:#cfd8e3;transform:translateY(-1px)}
      .email-debug-mailbox-item.active{border-color:#d93025;box-shadow:0 0 0 3px rgba(217,48,37,.10)}
      .email-debug-mailbox-title{display:flex;justify-content:space-between;align-items:flex-start;gap:10px}
      .email-debug-mailbox-email{font-size:13px;font-weight:900;color:#223040;word-break:break-word}
      .email-debug-mailbox-actors{font-size:11px;color:#6f7b8b}
      .email-debug-mailbox-stats{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:8px}
      .email-debug-mailbox-stat{background:#f7f9fc;border-radius:10px;padding:8px}
      .email-debug-mailbox-stat .k{font-size:10px;font-weight:900;color:#7a8595;text-transform:uppercase}
      .email-debug-mailbox-stat .v{margin-top:4px;font-size:13px;font-weight:800;color:#223040}
      .email-debug-status{display:inline-flex;align-items:center;gap:6px;border-radius:999px;padding:4px 9px;font-size:10px;font-weight:900;text-transform:uppercase;letter-spacing:.04em}
      .email-debug-status.ok{background:#e7f6ec;color:#157347}
      .email-debug-status.error{background:#fce8e6;color:#b42318}
      .email-debug-status.running{background:#e8f0fe;color:#0b57d0}
      .email-debug-status.idle{background:#eef2f6;color:#667487}
      .email-debug-detail-grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:12px}
      .email-debug-detail-list{display:grid;gap:8px}
      .email-debug-detail-row{display:flex;justify-content:space-between;gap:12px;padding:8px 0;border-bottom:1px solid #f0f3f7}
      .email-debug-detail-row:last-child{border-bottom:none}
      .email-debug-detail-row .k{font-size:11px;font-weight:900;color:#738095;text-transform:uppercase}
      .email-debug-detail-row .v{font-size:12px;color:#223040;text-align:right;word-break:break-word}
      .email-debug-chip-row{display:flex;flex-wrap:wrap;gap:8px}
      .email-debug-chip{display:inline-flex;align-items:center;gap:6px;border:1px solid #d7dee9;border-radius:999px;padding:5px 10px;background:#fff;font-size:11px;font-weight:800;color:#455468}
      .email-debug-chip.warn{border-color:#f0d6a8;background:#fff7ea;color:#9a5b00}
      .email-debug-chip.success{border-color:#b7dfc6;background:#f0faf3;color:#157347}
      .email-debug-toolbar{display:flex;justify-content:space-between;align-items:center;gap:12px;flex-wrap:wrap}
      .email-debug-filter-group{display:flex;gap:6px;flex-wrap:wrap}
      .email-debug-filter-btn{border:1px solid #d7dee9;background:#fff;border-radius:999px;padding:5px 10px;font-size:11px;font-weight:800;color:#445366;cursor:pointer}
      .email-debug-filter-btn.active{background:#223040;border-color:#223040;color:#fff}
      .email-debug-table-wrap{overflow:auto}
      .email-debug-table{width:100%;border-collapse:collapse}
      .email-debug-table th,.email-debug-table td{padding:10px 8px;border-bottom:1px solid #eef2f6;vertical-align:top;text-align:left;font-size:12px}
      .email-debug-table th{font-size:10px;font-weight:900;text-transform:uppercase;letter-spacing:.05em;color:#738095;background:#fbfcfe;position:sticky;top:0}
      .email-debug-subject{font-weight:900;color:#223040}
      .email-debug-snippet{margin-top:4px;color:#667487;line-height:1.45}
      .email-debug-pill{display:inline-flex;align-items:center;border-radius:999px;padding:3px 8px;font-size:10px;font-weight:900;text-transform:uppercase;letter-spacing:.04em}
      .email-debug-pill.matched{background:#e7f6ec;color:#157347}
      .email-debug-pill.unmatched{background:#fff7ea;color:#9a5b00}
      .email-debug-lead-tags{display:flex;flex-wrap:wrap;gap:6px}
      .email-debug-lead-tag{display:inline-flex;align-items:center;gap:6px;border:1px solid #d7dee9;border-radius:999px;padding:4px 8px;background:#fff;font-size:11px;font-weight:800;color:#455468}
      .email-debug-empty{padding:28px 14px;text-align:center;color:#7b8797;font-weight:700}
      .email-debug-note{font-size:12px;color:#667487;line-height:1.55}
      .email-debug-error{background:#fce8e6;color:#b42318;border:1px solid #f4c7c3;border-radius:12px;padding:12px 14px;font-size:13px;font-weight:700}
      @media (max-width: 1100px){
        .email-debug-layout{grid-template-columns:1fr}
        .email-debug-detail-grid{grid-template-columns:1fr}
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

  function mailboxList(){
    return Array.isArray(state.data?.mailboxes) ? state.data.mailboxes : [];
  }

  function selectedDetail(){
    return state.data?.selected_mailbox || null;
  }

  function selectedSummary(){
    return selectedDetail()?.summary || null;
  }

  function selectedInbox(){
    const detail = selectedDetail();
    if (!detail) return [];
    const rows = Array.isArray(detail.inbox) ? detail.inbox : [];
    if (state.inboxFilter === 'matched') return rows.filter(row => row.association_status === 'matched');
    if (state.inboxFilter === 'unmatched') return rows.filter(row => row.association_status === 'unmatched');
    return rows;
  }

  function canRunSync(){
    const viewerMailbox = String(state.data?.viewer?.current_mailbox_email || '').trim().toLowerCase();
    const mailboxEmail = String(selectedSummary()?.mailbox_email || '').trim().toLowerCase();
    return viewerMailbox !== '' && mailboxEmail !== '' && viewerMailbox === mailboxEmail;
  }

  function api(payload){
    return window.Portal.apiPost(cfg().endpoints?.server || window.Portal.internalLegacyEndpoint(), payload);
  }

  async function load(mailboxKey){
    state.loading = true;
    state.error = '';
    render();
    try {
      const payload = { action: 'gmail_debug_snapshot', limit: 160 };
      const selected = String(mailboxKey || state.selectedMailboxKey || '').trim();
      if (selected) payload.mailbox_key = selected;
      const data = await api(payload);
      if (!data || data.success === false) {
        throw new Error(data?.error || 'Could not load email debug snapshot.');
      }
      state.data = data.debug || null;
      const available = mailboxList();
      if (selected) {
        state.selectedMailboxKey = selected;
      } else if (!state.selectedMailboxKey && available[0]?.mailbox_key) {
        state.selectedMailboxKey = String(available[0].mailbox_key);
      }
    } catch (err) {
      state.error = err?.message || 'Could not load email debug snapshot.';
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
      const data = await api({ action: 'gmail_background_sync' });
      if (!data || data.success === false) {
        throw new Error(data?.error || 'Could not run Gmail sync.');
      }
      await load(state.selectedMailboxKey);
    } catch (err) {
      state.error = err?.message || 'Could not run Gmail sync.';
    } finally {
      state.syncing = false;
      render();
    }
  }

  function bind(container){
    container.querySelectorAll('[data-email-debug-mailbox]').forEach(btn => {
      if (btn.dataset.wired === 'true') return;
      btn.dataset.wired = 'true';
      btn.addEventListener('click', () => {
        state.selectedMailboxKey = btn.getAttribute('data-email-debug-mailbox') || '';
        load(state.selectedMailboxKey);
      });
    });
    container.querySelectorAll('[data-email-debug-filter]').forEach(btn => {
      if (btn.dataset.wired === 'true') return;
      btn.dataset.wired = 'true';
      btn.addEventListener('click', () => {
        state.inboxFilter = btn.getAttribute('data-email-debug-filter') || 'all';
        render();
      });
    });
    const refreshBtn = container.querySelector('[data-email-debug-refresh]');
    if (refreshBtn && refreshBtn.dataset.wired !== 'true') {
      refreshBtn.dataset.wired = 'true';
      refreshBtn.addEventListener('click', () => load(state.selectedMailboxKey));
    }
    const syncBtn = container.querySelector('[data-email-debug-sync]');
    if (syncBtn && syncBtn.dataset.wired !== 'true') {
      syncBtn.dataset.wired = 'true';
      syncBtn.addEventListener('click', () => runSync());
    }
  }

  function statusBadge(status){
    const raw = String(status || '').trim().toLowerCase();
    const tone = raw === 'ok' ? 'ok' : raw === 'error' ? 'error' : raw === 'running' ? 'running' : 'idle';
    const label = raw ? raw : 'idle';
    return `<span class="email-debug-status ${tone}">${esc(label)}</span>`;
  }

  function metric(label, value, meta){
    return `
      <div class="email-debug-metric">
        <div class="email-debug-metric-label">${esc(label)}</div>
        <div class="email-debug-metric-value">${esc(String(value))}</div>
        <div class="email-debug-metric-meta">${esc(meta)}</div>
      </div>
    `;
  }

  function renderMailboxList(){
    const rows = mailboxList();
    if (!rows.length) {
      return `<div class="email-debug-empty">No mailbox cache exists yet. Connect Gmail and let the CRM run a sync first.</div>`;
    }
    return `
      <div class="email-debug-mailbox-list">
        ${rows.map(row => `
          <button type="button" class="email-debug-mailbox-item ${String(row.mailbox_key) === String(state.selectedMailboxKey) ? 'active' : ''}" data-email-debug-mailbox="${esc(row.mailbox_key)}">
            <div class="email-debug-mailbox-title">
              <div>
                <div class="email-debug-mailbox-email">${esc(row.mailbox_email || '')}</div>
                <div class="email-debug-mailbox-actors">${esc((row.actors || []).join(', ') || 'No linked CRM users')}</div>
              </div>
              ${statusBadge(row.last_sync_status)}
            </div>
            <div class="email-debug-mailbox-stats">
              <div class="email-debug-mailbox-stat"><div class="k">Matched</div><div class="v">${esc(String(row.message_count || 0))}</div></div>
              <div class="email-debug-mailbox-stat"><div class="k">Unmatched</div><div class="v">${esc(String(row.unmatched_count || 0))}</div></div>
              <div class="email-debug-mailbox-stat"><div class="k">Leads</div><div class="v">${esc(String(row.lead_count || 0))}</div></div>
              <div class="email-debug-mailbox-stat"><div class="k">Last Sync</div><div class="v">${esc(fmtAgo(row.last_sync_at))}</div></div>
            </div>
          </button>
        `).join('')}
      </div>
    `;
  }

  function renderAssociatedLeads(detail){
    const leads = Array.isArray(detail?.associated_leads) ? detail.associated_leads : [];
    if (!leads.length) {
      return `<div class="email-debug-empty">No leads have been associated with this mailbox yet.</div>`;
    }
    return `
      <div class="email-debug-table-wrap">
        <table class="email-debug-table">
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

  function renderInbox(detail){
    const inbox = selectedInbox();
    const totalAll = Array.isArray(detail?.inbox) ? detail.inbox.length : 0;
    const matchedCount = Array.isArray(detail?.matched_messages) ? detail.matched_messages.length : 0;
    const unmatchedCount = Array.isArray(detail?.unmatched_messages) ? detail.unmatched_messages.length : 0;
    return `
      <div class="email-debug-toolbar">
        <div class="email-debug-note">Combined cached inbox view for this mailbox. Matched rows are already linked to CRM leads; unmatched rows were pulled from Gmail but have not been paired to a lead yet.</div>
        <div class="email-debug-filter-group">
          <button type="button" class="email-debug-filter-btn ${state.inboxFilter === 'all' ? 'active' : ''}" data-email-debug-filter="all">All (${esc(String(totalAll))})</button>
          <button type="button" class="email-debug-filter-btn ${state.inboxFilter === 'matched' ? 'active' : ''}" data-email-debug-filter="matched">Matched (${esc(String(matchedCount))})</button>
          <button type="button" class="email-debug-filter-btn ${state.inboxFilter === 'unmatched' ? 'active' : ''}" data-email-debug-filter="unmatched">Unmatched (${esc(String(unmatchedCount))})</button>
        </div>
      </div>
      ${inbox.length ? `
        <div class="email-debug-table-wrap" style="margin-top:12px;">
          <table class="email-debug-table">
            <thead>
              <tr>
                <th>When</th>
                <th>Status</th>
                <th>Subject / Preview</th>
                <th>Participants</th>
                <th>Leads</th>
              </tr>
            </thead>
            <tbody>
              ${inbox.map(row => `
                <tr>
                  <td>
                    <div><strong>${esc(fmtTs(row.happened_at))}</strong></div>
                    <div style="margin-top:4px;color:#738095;">${esc(fmtAgo(row.happened_at))}</div>
                  </td>
                  <td>
                    <span class="email-debug-pill ${row.association_status === 'matched' ? 'matched' : 'unmatched'}">${esc(row.association_status || 'unknown')}</span>
                    <div style="margin-top:6px;color:#738095;">${esc((row.direction || '').toUpperCase() || '-')}</div>
                  </td>
                  <td>
                    <div class="email-debug-subject">${esc(row.subject || 'Gmail message')}</div>
                    <div class="email-debug-snippet">${esc(row.snippet || row.body_text || '')}</div>
                  </td>
                  <td>
                    <div>${esc((row.from_email || row.from || '-') || '-')}</div>
                    <div style="margin-top:4px;color:#738095;">To: ${esc((row.to_emails || []).join(', ') || row.to || '-')}</div>
                  </td>
                  <td>
                    ${(row.lead_summaries || []).length ? `
                      <div class="email-debug-lead-tags">
                        ${(row.lead_summaries || []).map(lead => `<span class="email-debug-lead-tag">${esc(lead.company || lead.email || lead.id || 'Lead')}</span>`).join('')}
                      </div>
                    ` : '<span style="color:#9a5b00;font-weight:800;">No matched lead</span>'}
                  </td>
                </tr>
              `).join('')}
            </tbody>
          </table>
        </div>
      ` : '<div class="email-debug-empty">No emails in this view yet for the selected filter.</div>'}
    `;
  }

  function renderSyncRuns(detail){
    const runs = Array.isArray(detail?.sync_runs) ? detail.sync_runs : [];
    if (!runs.length) {
      return `<div class="email-debug-empty">No sync runs have been recorded for this mailbox yet.</div>`;
    }
    return `
      <div class="email-debug-table-wrap">
        <table class="email-debug-table">
          <thead>
            <tr>
              <th>Finished</th>
              <th>Status</th>
              <th>Mode</th>
              <th>Reason</th>
              <th>Examined</th>
              <th>Matched</th>
              <th>Unmatched</th>
              <th>Assigned</th>
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
                <td>${esc(String(run.examined_message_ids || 0))}</td>
                <td>${esc(String(run.stored_messages || 0))}</td>
                <td>${esc(String(run.unmatched_messages || 0))}</td>
                <td>${esc(String(run.assigned_activities || 0))}</td>
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
      return `<div class="email-debug-card"><div class="email-debug-empty">Select a mailbox to inspect its Gmail cache, lead associations, unmatched emails, and sync history.</div></div>`;
    }
    return `
      <div class="email-debug-card">
        <div class="email-debug-card-head">
          <h3>${esc(summary.mailbox_email || 'Mailbox')}</h3>
          ${statusBadge(summary.last_sync_status)}
        </div>
        <div class="email-debug-card-body">
          <div class="email-debug-detail-grid">
            <div class="email-debug-detail-list">
              <div class="email-debug-detail-row"><div class="k">Linked CRM users</div><div class="v">${esc((summary.actors || []).join(', ') || 'None')}</div></div>
              <div class="email-debug-detail-row"><div class="k">History ID</div><div class="v">${esc(summary.history_id || '-')}</div></div>
              <div class="email-debug-detail-row"><div class="k">Last sync started</div><div class="v">${esc(fmtTs(summary.last_sync_started_at))}</div></div>
              <div class="email-debug-detail-row"><div class="k">Last sync finished</div><div class="v">${esc(fmtTs(summary.last_sync_at))}</div></div>
              <div class="email-debug-detail-row"><div class="k">Last sync reason</div><div class="v">${esc(summary.last_sync_reason || '-')}</div></div>
              <div class="email-debug-detail-row"><div class="k">Last sync error</div><div class="v">${esc(summary.last_sync_error || '-')}</div></div>
            </div>
            <div class="email-debug-detail-list">
              <div class="email-debug-detail-row"><div class="k">Matched messages</div><div class="v">${esc(String(summary.message_count || 0))}</div></div>
              <div class="email-debug-detail-row"><div class="k">Unmatched messages</div><div class="v">${esc(String(summary.unmatched_count || 0))}</div></div>
              <div class="email-debug-detail-row"><div class="k">Threads</div><div class="v">${esc(String(summary.thread_count || 0))}</div></div>
              <div class="email-debug-detail-row"><div class="k">Associated leads</div><div class="v">${esc(String(summary.lead_count || 0))}</div></div>
              <div class="email-debug-detail-row"><div class="k">Sync runs saved</div><div class="v">${esc(String(summary.sync_run_count || 0))}</div></div>
              <div class="email-debug-detail-row"><div class="k">First sync</div><div class="v">${esc(fmtTs(summary.first_sync_at))}</div></div>
            </div>
          </div>
        </div>
      </div>

      <div class="email-debug-card" style="margin-top:16px;">
        <div class="email-debug-card-head">
          <h3>Associated Leads</h3>
          <small>${esc(String((detail.associated_leads || []).length))} lead${(detail.associated_leads || []).length === 1 ? '' : 's'}</small>
        </div>
        <div class="email-debug-card-body">${renderAssociatedLeads(detail)}</div>
      </div>

      <div class="email-debug-card" style="margin-top:16px;">
        <div class="email-debug-card-head">
          <h3>Inbox Cache</h3>
          <small>Matched and unmatched cached messages</small>
        </div>
        <div class="email-debug-card-body">${renderInbox(detail)}</div>
      </div>

      <div class="email-debug-card" style="margin-top:16px;">
        <div class="email-debug-card-head">
          <h3>Sync Runs</h3>
          <small>Background pull results and timestamps</small>
        </div>
        <div class="email-debug-card-body">${renderSyncRuns(detail)}</div>
      </div>
    `;
  }

  function render(){
    const host = document.getElementById('view-email-debug');
    if (!host) return;
    ensureStyles();
    const mailboxes = mailboxList();
    const summary = selectedSummary();
    host.innerHTML = `
      <div class="email-debug-shell">
        <div class="header-bar">
          <h1>Email Debug</h1>
          <div style="display:flex;gap:10px;flex-wrap:wrap;">
            <button class="btn-secondary" type="button" data-email-debug-refresh ${state.loading ? 'disabled' : ''}><i class="fas fa-sync${state.loading ? ' fa-spin' : ''}"></i> ${state.loading ? 'Refreshing...' : 'Refresh Snapshot'}</button>
            <button class="btn-primary" type="button" data-email-debug-sync ${state.syncing || !canRunSync() ? 'disabled' : ''} title="${canRunSync() ? 'Run a Gmail sync for your connected mailbox' : 'Select your own connected mailbox to run a sync'}"><i class="fas fa-cloud-arrow-down${state.syncing ? ' fa-spin' : ''}"></i> ${state.syncing ? 'Syncing...' : 'Run My Gmail Sync'}</button>
          </div>
        </div>

        <div class="email-debug-note">This is a temporary internal debug surface for the Gmail cache. It shows stored mailbox state, matched leads, unmatched emails, and recorded sync results so we can verify Gmail behavior without guessing.</div>

        ${state.error ? `<div class="email-debug-error">${esc(state.error)}</div>` : ''}

        <div class="email-debug-hero">
          ${metric('Mailboxes', mailboxes.length, state.data?.viewer?.can_view_all ? 'Viewing all cached mailboxes' : 'Viewing your accessible mailbox cache')}
          ${metric('Selected Inbox', summary?.mailbox_email || '-', summary ? `Last sync ${fmtAgo(summary.last_sync_at)}` : 'No mailbox selected')}
          ${metric('Matched Emails', summary?.message_count || 0, summary ? `${summary.thread_count || 0} threads cached` : 'No selected mailbox')}
          ${metric('Unmatched Emails', summary?.unmatched_count || 0, summary ? `${summary.sync_run_count || 0} sync runs recorded` : 'No selected mailbox')}
        </div>

        <div class="email-debug-layout">
          <div class="email-debug-card">
            <div class="email-debug-card-head">
              <h3>Mailboxes</h3>
              <small>${esc(String(mailboxes.length))} available</small>
            </div>
            <div class="email-debug-card-body">${renderMailboxList()}</div>
          </div>
          <div>${renderDetail()}</div>
        </div>
      </div>
    `;
    bind(host);
  }

  const EmailDebug = {
    init(){
      if (state.initialized) return;
      state.initialized = true;
      ensureStyles();
      render();
    },
    async onShow(){
      this.init();
      await load(state.selectedMailboxKey);
    }
  };

  window.EmailDebug = EmailDebug;
})();
