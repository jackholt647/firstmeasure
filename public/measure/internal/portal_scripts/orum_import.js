(function(){
  if (!window.Portal) return;

  const cfg = () => window.Portal.cfg || window.PORTAL_CFG || {};
  const esc = (s) => window.Portal.escapeHtml(String(s ?? ''));

  const state = {
    previewToken: '',
    preview: null,
    history: [],
    loadingHistory: false,
    previewing: false,
    confirming: false
  };

  function canManage(){
    const perms = cfg().perms || {};
    const role = String(cfg().user?.role || '').toLowerCase();
    return !!(perms.manage_users || perms.manage_sales_users || perms.create_users || role === 'admin' || role === 'system_admin' || role === 'sales_manager');
  }

  function modal(){
    return document.getElementById('leadOrumImportModal');
  }

  function el(id){
    return document.getElementById(id);
  }

  function toast(message){
    const node = el('leadsToast');
    if (!node || !message) return;
    node.textContent = message;
    node.classList.add('visible');
    clearTimeout(toast._timer);
    toast._timer = setTimeout(() => node.classList.remove('visible'), 3200);
  }

  function setStatus(message, tone){
    const node = el('leadOrumImportStatus');
    if (!node) return;
    const colors = {
      neutral: '#66707f',
      error: '#b42318',
      success: '#137333',
      warn: '#8a4b00'
    };
    node.style.color = colors[tone || 'neutral'] || colors.neutral;
    node.textContent = message || '';
  }

  async function fetchHistory(){
    if (!canManage()) return;
    state.loadingHistory = true;
    render();
    try {
      const data = await fetch(cfg().endpoints?.server || window.Portal.internalLegacyEndpoint(), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'lead_orum_import_history' })
      }).then(r => r.json());
      state.history = Array.isArray(data.history) ? data.history : [];
    } catch (_) {
      state.history = [];
    } finally {
      state.loadingHistory = false;
      render();
    }
  }

  function renderAffectedLists(lists){
    const rows = Array.isArray(lists) ? lists : [];
    if (!rows.length) return '<div style="color:#888; font-size:12px;">No matched lists yet.</div>';
    return `
      <div style="display:grid; gap:8px;">
        ${rows.map((row) => `
          <div style="display:flex; justify-content:space-between; gap:12px; align-items:center; padding:10px 12px; border:1px solid #e6e9ef; border-radius:12px; background:#fafcff;">
            <div style="min-width:0;">
              <div style="font-size:12px; font-weight:900; color:#223040;">${esc(row.name || 'List')}</div>
              <div style="font-size:11px; color:#6b7583; margin-top:3px;">${esc(row.assigned_to_email || 'Unassigned')}</div>
            </div>
            <div style="text-align:right; white-space:nowrap;">
              <div style="font-size:11px; color:#6b7583;">Called / Total</div>
              <div style="font-size:13px; font-weight:900; color:#223040;">${Number(row.called_count || 0)} / ${Number(row.lead_count || 0)}</div>
            </div>
          </div>
        `).join('')}
      </div>
    `;
  }

  function renderUnmatched(rows){
    const list = Array.isArray(rows) ? rows : [];
    if (!list.length) return '<div style="color:#137333; font-size:12px; font-weight:800;">All rows matched existing leads.</div>';
    return `
      <div style="display:grid; gap:8px; max-height:180px; overflow:auto; padding-right:4px;">
        ${list.slice(0, 80).map((row) => `
          <div style="border:1px solid #f1d1a3; background:#fff9ef; border-radius:12px; padding:10px 12px;">
            <div style="font-size:12px; font-weight:900; color:#8a4b00;">${esc(row.company || 'Unknown company')}</div>
            <div style="font-size:11px; color:#7a6140; margin-top:4px;">${esc(row.phone || '-')} | ${esc(row.email || '-')}</div>
            <div style="font-size:11px; color:#7a6140; margin-top:3px;">${esc(row.disposition || row.called_at || 'No extra details')}</div>
          </div>
        `).join('')}
      </div>
    `;
  }

  function renderHistory(){
    const host = el('leadOrumImportHistory');
    if (!host) return;
    if (state.loadingHistory) {
      host.innerHTML = '<div style="color:#777; font-size:12px;">Loading recent imports...</div>';
      return;
    }
    if (!state.history.length) {
      host.innerHTML = '<div style="color:#999; font-size:12px;">No Orum imports yet.</div>';
      return;
    }
    host.innerHTML = `
      <div style="display:grid; gap:8px; max-height:180px; overflow:auto; padding-right:4px;">
        ${state.history.map((row) => {
          const meta = row.metadata || {};
          const affected = Array.isArray((meta.confirmed_result || meta).affected_lists) ? (meta.confirmed_result || meta).affected_lists : [];
          return `
            <div style="border:1px solid #e6e9ef; background:#fff; border-radius:12px; padding:10px 12px;">
              <div style="display:flex; justify-content:space-between; gap:12px; align-items:flex-start;">
                <div style="min-width:0;">
                  <div style="font-size:12px; font-weight:900; color:#223040;">${esc(row.filename || 'orum-import.csv')}</div>
                  <div style="font-size:11px; color:#6b7583; margin-top:4px;">${new Date(Number(row.created_at || 0) * 1000).toLocaleString()} | ${esc(row.status || 'previewed')}</div>
                </div>
                <div style="text-align:right; white-space:nowrap;">
                  <div style="font-size:11px; color:#6b7583;">Matched / Rows</div>
                  <div style="font-size:13px; font-weight:900; color:#223040;">${Number(row.matched_rows || 0)} / ${Number(row.total_rows || 0)}</div>
                </div>
              </div>
              <div style="font-size:11px; color:#6b7583; margin-top:8px;">Unmatched: ${Number(row.unmatched_rows || 0)} | New calls: ${Number(row.created_records || 0)}</div>
              ${affected.length ? `<div style="font-size:11px; color:#6b7583; margin-top:6px;">Affected lists: ${affected.map(item => esc(item.name || 'List')).join(', ')}</div>` : ''}
            </div>
          `;
        }).join('')}
      </div>
    `;
  }

  function renderPreview(){
    const host = el('leadOrumImportPreview');
    if (!host) return;
    if (!state.preview) {
      host.innerHTML = '<div style="color:#66707f; font-size:12px;">Upload a daily Orum CSV and click Preview to review matches before import.</div>';
      return;
    }
    host.innerHTML = `
      <div style="display:grid; grid-template-columns:repeat(3, minmax(0, 1fr)); gap:10px;">
        <div style="border:1px solid #e6e9ef; border-radius:12px; padding:12px; background:#fff;">
          <div style="font-size:11px; font-weight:900; color:#6b7583; text-transform:uppercase;">Rows</div>
          <div style="font-size:22px; font-weight:900; color:#223040; margin-top:4px;">${Number(state.preview.rows || 0).toLocaleString()}</div>
        </div>
        <div style="border:1px solid #d9ecd7; border-radius:12px; padding:12px; background:#f4fbf3;">
          <div style="font-size:11px; font-weight:900; color:#4b6b49; text-transform:uppercase;">Matched</div>
          <div style="font-size:22px; font-weight:900; color:#137333; margin-top:4px;">${Number(state.preview.matched || 0).toLocaleString()}</div>
        </div>
        <div style="border:1px solid #f1d1a3; border-radius:12px; padding:12px; background:#fff9ef;">
          <div style="font-size:11px; font-weight:900; color:#8a4b00; text-transform:uppercase;">Unmatched</div>
          <div style="font-size:22px; font-weight:900; color:#b54708; margin-top:4px;">${Number(state.preview.unmatched_count || 0).toLocaleString()}</div>
        </div>
      </div>
      <div style="margin-top:14px;">
        <div style="font-size:12px; font-weight:900; color:#223040; margin-bottom:8px;">Affected list progress</div>
        ${renderAffectedLists(state.preview.affected_lists)}
      </div>
      <div style="margin-top:14px;">
        <div style="font-size:12px; font-weight:900; color:#223040; margin-bottom:8px;">Unmatched rows for review</div>
        ${renderUnmatched(state.preview.unmatched)}
      </div>
    `;
  }

  function render(){
    renderPreview();
    renderHistory();
    const previewBtn = el('leadOrumPreviewBtn');
    const confirmBtn = el('leadOrumImportConfirmBtn');
    if (previewBtn) {
      previewBtn.disabled = !!state.previewing || !!state.confirming;
      previewBtn.innerHTML = state.previewing ? '<i class="fas fa-spinner fa-spin"></i> Previewing...' : '<i class="fas fa-search"></i> Preview CSV';
    }
    if (confirmBtn) {
      confirmBtn.disabled = !state.previewToken || !!state.previewing || !!state.confirming;
      confirmBtn.innerHTML = state.confirming ? '<i class="fas fa-spinner fa-spin"></i> Importing...' : '<i class="fas fa-file-import"></i> Confirm Import';
    }
  }

  async function previewImport(){
    const fileInput = el('leadOrumImportFile');
    const file = fileInput?.files?.[0];
    if (!file) {
      setStatus('Choose a CSV file first.', 'error');
      return;
    }
    state.previewing = true;
    state.previewToken = '';
    state.preview = null;
    setStatus('Parsing CSV and checking matches...', 'neutral');
    render();
    try {
      const form = new FormData();
      form.append('action', 'lead_preview_orum_csv');
      form.append('csv_file', file);
      const data = await fetch(cfg().endpoints?.server || window.Portal.internalLegacyEndpoint(), { method: 'POST', body: form }).then(r => r.json());
      if (!data.success) {
        setStatus(data.error || 'Could not preview Orum CSV.', 'error');
        return;
      }
      state.previewToken = String(data.preview_token || '');
      state.preview = data;
      state.history = Array.isArray(data.history) ? data.history : state.history;
      setStatus(`Preview ready: ${Number(data.matched || 0).toLocaleString()} matched, ${Number(data.unmatched_count || 0).toLocaleString()} unmatched.`, data.unmatched_count ? 'warn' : 'success');
    } catch (err) {
      setStatus(err?.message || 'Could not preview Orum CSV.', 'error');
    } finally {
      state.previewing = false;
      render();
    }
  }

  async function confirmImport(){
    if (!state.previewToken) {
      setStatus('Preview the CSV before importing it.', 'error');
      return;
    }
    state.confirming = true;
    setStatus('Importing Orum call history...', 'neutral');
    render();
    try {
      const data = await fetch(cfg().endpoints?.server || window.Portal.internalLegacyEndpoint(), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'lead_confirm_orum_import', preview_token: state.previewToken })
      }).then(r => r.json());
      if (!data.success) {
        setStatus(data.error || 'Import failed.', 'error');
        return;
      }
      state.previewToken = '';
      state.preview = null;
      state.history = Array.isArray(data.history) ? data.history : state.history;
      const message = `Imported ${Number(data.matched || 0).toLocaleString()} matched rows from ${Number(data.rows || 0).toLocaleString()} rows. ${Number(data.unmatched_count || 0).toLocaleString()} unmatched.`;
      setStatus(message, Number(data.unmatched_count || 0) ? 'warn' : 'success');
      render();
      toast(message);
      Portal.closeModal('leadOrumImportModal');
      el('leadsRefreshBtn')?.click();
    } catch (err) {
      setStatus(err?.message || 'Import failed.', 'error');
    } finally {
      state.confirming = false;
      render();
    }
  }

  function resetModalState(){
    state.previewToken = '';
    state.preview = null;
    state.previewing = false;
    state.confirming = false;
    if (el('leadOrumImportFile')) el('leadOrumImportFile').value = '';
    setStatus('', 'neutral');
    render();
  }

  function rebuildModal(){
    const node = modal();
    if (!node) return;
    node.innerHTML = `
      <div class="modal-card" style="width:min(860px,96vw);max-height:88vh;overflow:auto;">
        <div class="modal-header">
          <h2>Import Orum Call Activity</h2>
          <button id="leadOrumImportCloseBtn" style="border:none;background:none;cursor:pointer;"><i class="fas fa-times"></i></button>
        </div>
        <div class="modal-body" style="padding:18px;display:grid;gap:16px;">
          <div style="font-size:13px;color:#66707f;">Upload the end-of-day Orum CSV, review matched and unmatched rows, then confirm the import.</div>
          <div style="display:grid; grid-template-columns:minmax(0, 1.2fr) minmax(320px, .8fr); gap:16px; align-items:start;">
            <div style="display:grid; gap:12px;">
              <input id="leadOrumImportFile" type="file" accept=".csv,text/csv">
              <div id="leadOrumImportStatus" style="font-size:12px;color:#66707f; min-height:18px;"></div>
              <div id="leadOrumImportPreview" style="display:grid; gap:12px;"></div>
            </div>
            <div style="border:1px solid #e6e9ef; border-radius:14px; padding:14px; background:#fafcff; min-height:220px;">
              <div style="font-size:12px; font-weight:900; letter-spacing:.04em; text-transform:uppercase; color:#6b7583;">Recent imports</div>
              <div id="leadOrumImportHistory" style="margin-top:12px;"></div>
            </div>
          </div>
          <div class="lead-actions-row" style="justify-content:flex-end;">
            <button class="btn-secondary" id="leadOrumImportCancelBtn">Cancel</button>
            <button class="btn-secondary" id="leadOrumPreviewBtn"><i class="fas fa-search"></i> Preview CSV</button>
            <button class="btn-primary" id="leadOrumImportConfirmBtn" disabled><i class="fas fa-file-import"></i> Confirm Import</button>
          </div>
        </div>
      </div>
    `;
    el('leadOrumImportCloseBtn')?.addEventListener('click', () => Portal.closeModal('leadOrumImportModal'));
    el('leadOrumImportCancelBtn')?.addEventListener('click', () => Portal.closeModal('leadOrumImportModal'));
    el('leadOrumPreviewBtn')?.addEventListener('click', previewImport);
    el('leadOrumImportConfirmBtn')?.addEventListener('click', confirmImport);
    node.addEventListener('click', (e) => {
      if (e.target === node) Portal.closeModal('leadOrumImportModal');
    });
    render();
  }

  function patchOpenButton(){
    const btn = el('leadsImportOrumBtn');
    if (!btn) return;
    const clone = btn.cloneNode(true);
    btn.replaceWith(clone);
    clone.style.display = canManage() ? '' : 'none';
    clone.addEventListener('click', async () => {
      if (!canManage()) return;
      resetModalState();
      Portal.openModal('leadOrumImportModal');
      await fetchHistory();
    });
  }

  function init(){
    if (!el('view-leads')) return;
    rebuildModal();
    patchOpenButton();
  }

  document.addEventListener('DOMContentLoaded', init);
  window.addEventListener('load', init);
  init();
  window.OrumImportUi = { init, refreshHistory: fetchHistory };
})();
