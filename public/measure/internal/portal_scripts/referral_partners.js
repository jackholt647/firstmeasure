(function(){
  if (!window.Portal) return;
  const { escapeHtml } = window.Portal;

  const state = {
    loaded: false,
    loading: false,
    items: [],
    filtered: [],
    search: '',
    saveInFlight: false,
    attachInFlight: false,
    attachPartner: null,
    attachOrgs: [],
    attachSearch: '',
    attachSelectedOrgId: '',
    copyResetTimer: null,
  };

  function referralBase(){
    const configured = window.Portal.cfg && window.Portal.cfg.endpoints
      ? (window.Portal.cfg.endpoints.crm_referrals || (String(window.Portal.cfg.endpoints.crm || '').replace(/\/+$/, '') + '/referrals'))
      : '/v1/internal/crm/referrals';
    return String(configured || '/v1/internal/crm/referrals').replace(/\/+$/, '');
  }

  async function request(path, options){
    const res = await fetch(referralBase() + path, Object.assign({
      credentials: 'same-origin',
      headers: { 'Accept': 'application/json' }
    }, options || {}));
    const text = await res.text();
    let data = {};
    try { data = text ? JSON.parse(text) : {}; } catch (err) { data = { success: false, error: text || 'Request failed.' }; }
    if (!res.ok || data.success === false || data.ok === false) {
      throw new Error(data.message || data.error || ('Request failed (' + res.status + ')'));
    }
    return data;
  }

  async function api(action, extra, fileInput){
    const payload = extra || {};
    if (action === 'referral_partner_list') {
      return request('/partners');
    }
    if (action === 'referral_partner_get') {
      return request('/partners/' + encodeURIComponent(payload.id || payload.partner_id || ''));
    }
    if (action === 'referral_partner_save') {
      const saved = await request('/partners', {
        method: 'POST',
        headers: { 'Accept': 'application/json', 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      });
      if (fileInput && fileInput.files && fileInput.files[0] && saved.partner && saved.partner.id) {
        const form = new FormData();
        form.append('logo', fileInput.files[0]);
        return request('/partners/' + encodeURIComponent(saved.partner.id) + '/logo', { method: 'POST', body: form });
      }
      return saved;
    }
    if (action === 'referral_org_search') {
      const params = new URLSearchParams({ q: payload.query || '', limit: String(payload.limit || 120) });
      return request('/organizations/search?' + params.toString());
    }
    if (action === 'referral_manual_attach') {
      return request('/partners/' + encodeURIComponent(payload.partner_id || '') + '/attach-organization', {
        method: 'POST',
        headers: { 'Accept': 'application/json', 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      });
    }
    return window.Portal.apiPost(window.Portal.cfg.endpoints.server, Object.assign({ action }, payload));
  }

  function ensureStyles(){
    if (document.getElementById('referralPartnersStyles')) return;
    const style = document.createElement('style');
    style.id = 'referralPartnersStyles';
    style.textContent = `
      .refp-shell{padding:24px;display:flex;flex-direction:column;gap:18px}
      .refp-card{background:#fff;border:1px solid #e7e7e7;border-radius:16px;box-shadow:0 6px 20px rgba(0,0,0,.05)}
      .refp-header{display:flex;align-items:center;justify-content:space-between;gap:16px;padding:22px 24px;border-bottom:1px solid #eee}
      .refp-title{display:flex;flex-direction:column;gap:6px}
      .refp-title h2{margin:0;font-size:24px;font-weight:900}
      .refp-title p{margin:0;color:#667085;font-size:13px;font-weight:600}
      .refp-actions{display:flex;align-items:center;gap:10px;flex-wrap:wrap}
      .refp-search{min-width:280px;padding:12px 14px;border:1px solid #d0d5dd;border-radius:10px;font-size:14px}
      .refp-btn{display:inline-flex;align-items:center;justify-content:center;gap:8px;padding:11px 16px;border-radius:10px;border:1px solid #d0d5dd;background:#fff;font-size:13px;font-weight:800;cursor:pointer}
      .refp-btn.primary{background:var(--primary);border-color:var(--primary);color:#fff}
      .refp-btn.subtle{background:#f8fafc}
      .refp-table-wrap{overflow:auto}
      .refp-table{width:100%;border-collapse:collapse}
      .refp-table th,.refp-table td{padding:14px 16px;border-bottom:1px solid #eef2f6;text-align:left;vertical-align:middle}
      .refp-table th{font-size:11px;text-transform:uppercase;letter-spacing:.04em;color:#667085;background:#f8fafc}
      .refp-empty{padding:40px 24px;text-align:center;color:#667085;font-weight:700}
      .refp-partner{display:flex;align-items:center;gap:12px;min-width:250px}
      .refp-logo{width:48px;height:48px;border-radius:14px;background:#f1f5f9;border:1px solid #e2e8f0;display:flex;align-items:center;justify-content:center;overflow:hidden;font-size:16px;font-weight:900;color:#475467}
      .refp-logo img{width:100%;height:100%;object-fit:cover}
      .refp-name{font-weight:900;font-size:14px;color:#101828}
      .refp-meta{font-size:12px;color:#667085;font-weight:600;margin-top:4px}
      .refp-badge{display:inline-flex;align-items:center;padding:5px 9px;border-radius:999px;background:#eef2ff;color:#344054;font-size:11px;font-weight:800}
      .refp-code{font-family:Consolas,monospace;font-size:12px;font-weight:800;color:#111827}
      .refp-link{display:block;max-width:320px;font-size:12px;color:#667085;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;text-decoration:none}
      .refp-stats{display:grid;gap:4px}
      .refp-stats strong{font-size:16px}
      .refp-row-actions{display:flex;gap:8px;flex-wrap:wrap}
      .refp-modal-wrap{position:fixed;inset:0;background:rgba(15,23,42,.54);display:none;align-items:center;justify-content:center;z-index:5000;padding:20px}
      .refp-modal-wrap.open{display:flex}
      .refp-modal{width:min(860px,96vw);max-height:92vh;overflow:auto;background:#fff;border-radius:18px;box-shadow:0 24px 60px rgba(0,0,0,.25)}
      .refp-modal.sm{width:min(560px,96vw)}
      .refp-modal-head{display:flex;align-items:center;justify-content:space-between;gap:12px;padding:22px 24px;border-bottom:1px solid #eee}
      .refp-modal-head h3{margin:0;font-size:22px;font-weight:900}
      .refp-close{background:none;border:none;font-size:24px;cursor:pointer;color:#667085}
      .refp-modal-body{padding:22px 24px;display:grid;gap:16px}
      .refp-grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:14px}
      .refp-field{display:grid;gap:6px}
      .refp-field.full{grid-column:1/-1}
      .refp-field label{font-size:11px;font-weight:900;color:#667085;text-transform:uppercase;letter-spacing:.05em}
      .refp-field input,.refp-field select,.refp-field textarea{width:100%;box-sizing:border-box;padding:11px 12px;border:1px solid #d0d5dd;border-radius:10px;font-size:14px;background:#fff}
      .refp-field textarea{min-height:110px;resize:vertical}
      .refp-preview{display:flex;align-items:center;gap:12px;padding:12px;border:1px dashed #d0d5dd;border-radius:12px;background:#fafafa}
      .refp-preview img{width:64px;height:64px;border-radius:16px;object-fit:cover;border:1px solid #e5e7eb;background:#fff}
      .refp-modal-foot{display:flex;align-items:center;justify-content:space-between;gap:12px;padding:18px 24px;border-top:1px solid #eee}
      .refp-help{font-size:12px;color:#667085;font-weight:600}
      .refp-qr-box{display:grid;justify-items:center;gap:16px}
      .refp-qr-box img{width:280px;height:280px;max-width:100%;border-radius:18px;border:1px solid #e5e7eb;background:#fff;padding:12px}
      .refp-qr-link{font-size:12px;color:#667085;text-align:center;word-break:break-all}
      .refp-org-search-row{display:flex;gap:10px;align-items:center}
      .refp-org-search-row input{flex:1}
      .refp-org-results{display:grid;gap:8px;max-height:340px;overflow:auto}
      .refp-org-row{width:100%;text-align:left;border:1px solid #e5e7eb;background:#fff;border-radius:10px;padding:11px 12px;display:grid;gap:4px;cursor:pointer}
      .refp-org-row:hover,.refp-org-row.selected{border-color:var(--primary);background:#fff8f7}
      .refp-org-row.disabled{cursor:not-allowed;opacity:.62;background:#f8fafc}
      .refp-org-main{display:flex;justify-content:space-between;gap:12px;align-items:flex-start;font-weight:900;color:#101828}
      .refp-org-sub{font-size:12px;color:#667085;font-weight:600}
      .refp-org-pill{font-size:10px;text-transform:uppercase;font-weight:900;border-radius:999px;padding:4px 7px;background:#eef2ff;color:#344054;white-space:nowrap}
      .refp-org-pill.warn{background:#fff7ed;color:#c2410c}
      .refp-attach-target{padding:12px;border:1px solid #e5e7eb;border-radius:10px;background:#f8fafc;display:grid;gap:4px}
      @media (max-width: 860px){
        .refp-header{align-items:flex-start;flex-direction:column}
        .refp-actions{width:100%}
        .refp-search{min-width:0;width:100%}
        .refp-grid{grid-template-columns:1fr}
        .refp-modal-foot{flex-direction:column;align-items:stretch}
        .refp-org-search-row{flex-direction:column;align-items:stretch}
      }
    `;
    document.head.appendChild(style);
  }

  function root(){
    return document.getElementById('referralPartnersRoot');
  }

  function shellHtml(){
    return `
      <div class="refp-shell">
        <div class="refp-card">
          <div class="refp-header">
            <div class="refp-title">
              <h2>Referral Partners</h2>
              <p>Create partner links, upload logos, and hand out branded signup URLs with QR codes.</p>
            </div>
            <div class="refp-actions">
              <input id="refpSearch" class="refp-search" type="text" placeholder="Search partners, contacts, codes...">
              <button id="refpRefreshBtn" class="refp-btn subtle"><i class="fas fa-rotate"></i> Refresh</button>
              <button id="refpCreateBtn" class="refp-btn primary"><i class="fas fa-plus"></i> New Partner</button>
            </div>
          </div>
          <div class="refp-table-wrap">
            <table class="refp-table">
              <thead>
                <tr>
                  <th>Partner</th>
                  <th>Type</th>
                  <th>Primary Link</th>
                  <th>Promo</th>
                  <th>Views</th>
                  <th>Signups</th>
                  <th>Actions</th>
                </tr>
              </thead>
              <tbody id="refpTableBody"></tbody>
            </table>
          </div>
        </div>
      </div>
    `;
  }

  function partnerCardLogo(partner){
    const url = String((partner && partner.logo_url) || '');
    if (url) return `<img src="${escapeHtml(url)}" alt="${escapeHtml(partner.display_name || '')}">`;
    return escapeHtml(String(partner.display_name || '?').trim().charAt(0).toUpperCase() || '?');
  }

  function promoLabel(partner){
    const code = partner && partner.primary_code ? partner.primary_code : null;
    const offerId = String((code && code.new_org_offer_id) || '');
    if (offerId === 'referral_week_discount_v1') return '50% off for 7 days';
    if (offerId === 'referral_free_expedite_7_v1') return '7 free expedite uses';
    return 'No new-org offer';
  }

  function filterItems(){
    const q = String(state.search || '').trim().toLowerCase();
    state.filtered = !q ? [...state.items] : state.items.filter(item => {
      const code = item.primary_code || {};
      const hay = [
        item.display_name,
        item.company_name,
        item.contact_name,
        item.contact_email,
        item.contact_phone,
        item.type_label,
        code.code,
        item.signup_url
      ].join(' ').toLowerCase();
      return hay.includes(q);
    });
  }

  function renderRows(){
    const tbody = document.getElementById('refpTableBody');
    if (!tbody) return;
    filterItems();
    if (!state.filtered.length) {
      tbody.innerHTML = `<tr><td colspan="7" class="refp-empty">${state.loading ? 'Loading referral partners...' : 'No referral partners found yet.'}</td></tr>`;
      return;
    }
    tbody.innerHTML = state.filtered.map(item => {
      const code = item.primary_code || {};
      const stats = item.stats || {};
      return `
        <tr>
          <td>
            <div class="refp-partner">
              <div class="refp-logo">${partnerCardLogo(item)}</div>
              <div>
                <div class="refp-name">${escapeHtml(item.display_name || 'Referral Partner')}</div>
                <div class="refp-meta">${escapeHtml(item.contact_name || item.contact_email || item.contact_phone || 'No contact info yet')}</div>
              </div>
            </div>
          </td>
          <td><span class="refp-badge">${escapeHtml(item.type_label || '')}</span></td>
          <td>
            <div class="refp-code">${escapeHtml(code.code || 'No code')}</div>
            <a class="refp-link" href="${escapeHtml(item.signup_url || '#')}" target="_blank" rel="noopener">${escapeHtml(item.signup_url || '')}</a>
          </td>
          <td>${escapeHtml(promoLabel(item))}</td>
          <td><div class="refp-stats"><strong>${Number(stats.total_views || 0)}</strong><span class="refp-meta">views</span></div></td>
          <td><div class="refp-stats"><strong>${Number(stats.total_signups || 0)}</strong><span class="refp-meta">signups</span></div></td>
          <td>
            <div class="refp-row-actions">
              <button class="refp-btn" data-action="copy" data-id="${escapeHtml(item.id)}"><i class="fas fa-link"></i> Copy Link</button>
              <button class="refp-btn" data-action="qr" data-id="${escapeHtml(item.id)}"><i class="fas fa-qrcode"></i> QR</button>
              <button class="refp-btn" data-action="attach" data-id="${escapeHtml(item.id)}"><i class="fas fa-user-plus"></i> Pair Org</button>
              <button class="refp-btn" data-action="edit" data-id="${escapeHtml(item.id)}"><i class="fas fa-pen"></i> Edit</button>
            </div>
          </td>
        </tr>
      `;
    }).join('');
  }

  async function loadPartners(){
    state.loading = true;
    renderRows();
    try{
      const data = await api('referral_partner_list');
      state.items = Array.isArray(data.partners) ? data.partners : [];
    }catch(err){
      state.items = [];
    }
    state.loading = false;
    renderRows();
  }

  function ensureModals(){
    if (!document.getElementById('refpEditorWrap')) {
      const wrap = document.createElement('div');
      wrap.id = 'refpEditorWrap';
      wrap.className = 'refp-modal-wrap';
      wrap.innerHTML = `
        <div class="refp-modal">
          <div class="refp-modal-head">
            <h3 id="refpEditorTitle">New Referral Partner</h3>
            <button class="refp-close" type="button" data-close="refpEditorWrap">&times;</button>
          </div>
          <div class="refp-modal-body">
            <input type="hidden" id="refpId">
            <div class="refp-grid">
              <div class="refp-field">
                <label>Partner Type</label>
                <select id="refpType">
                  <option value="manufacturer_rep">Manufacturer / Rep</option>
                  <option value="customer_user">Customer / User</option>
                </select>
              </div>
              <div class="refp-field">
                <label>Status</label>
                <select id="refpStatus">
                  <option value="active">Active</option>
                  <option value="archived">Archived</option>
                  <option value="disabled">Disabled</option>
                </select>
              </div>
              <div class="refp-field">
                <label>Display Name</label>
                <input id="refpDisplayName" type="text" placeholder="GAF">
              </div>
              <div class="refp-field">
                <label>Company Name</label>
                <input id="refpCompanyName" type="text" placeholder="GAF Manufacturing">
              </div>
              <div class="refp-field">
                <label>Contact Name</label>
                <input id="refpContactName" type="text" placeholder="Bill Smith">
              </div>
              <div class="refp-field">
                <label>Contact Email</label>
                <input id="refpContactEmail" type="email" placeholder="bill@example.com">
              </div>
              <div class="refp-field">
                <label>Contact Phone</label>
                <input id="refpContactPhone" type="text" placeholder="(555) 555-5555">
              </div>
              <div class="refp-field">
                <label>Linked User Email</label>
                <input id="refpLinkedUserEmail" type="email" placeholder="Optional for customer/user referrers">
              </div>
              <div class="refp-field">
                <label>Signup Offer</label>
                <select id="refpNewOrgOfferId">
                  <option value="">No new-org offer</option>
                  <option value="referral_week_discount_v1">50% off for first 7 days</option>
                  <option value="referral_free_expedite_7_v1">7 free expedite uses</option>
                </select>
              </div>
              <div class="refp-field">
                <label>Logo Upload</label>
                <input id="refpLogoFile" type="file" accept="image/png,image/jpeg,image/webp,image/gif,image/svg+xml">
              </div>
              <div class="refp-field full">
                <label>Logo URL (optional)</label>
                <input id="refpLogoUrl" type="text" placeholder="https://... or leave blank if uploading">
              </div>
              <div class="refp-field full">
                <label>Notes</label>
                <textarea id="refpNotes" placeholder="Partner notes, channel notes, or internal details..."></textarea>
              </div>
              <div class="refp-field full">
                <label>Logo Preview</label>
                <div class="refp-preview">
                  <img id="refpLogoPreview" src="" alt="" style="display:none;">
                  <div id="refpLogoFallback" class="refp-logo">?</div>
                  <div class="refp-help">This logo appears on the public signup invitation page for this referral link.</div>
                </div>
              </div>
            </div>
          </div>
          <div class="refp-modal-foot">
            <div class="refp-help" id="refpSaveStatus">The primary signup link is generated automatically.</div>
            <div style="display:flex;gap:10px;flex-wrap:wrap;">
              <button class="refp-btn" type="button" data-close="refpEditorWrap">Cancel</button>
              <button class="refp-btn primary" type="button" id="refpSaveBtn"><i class="fas fa-floppy-disk"></i> Save Partner</button>
            </div>
          </div>
        </div>
      `;
      document.body.appendChild(wrap);
    }
    if (!document.getElementById('refpQrWrap')) {
      const wrap = document.createElement('div');
      wrap.id = 'refpQrWrap';
      wrap.className = 'refp-modal-wrap';
      wrap.innerHTML = `
        <div class="refp-modal sm">
          <div class="refp-modal-head">
            <h3 id="refpQrTitle">Referral QR Code</h3>
            <button class="refp-close" type="button" data-close="refpQrWrap">&times;</button>
          </div>
          <div class="refp-modal-body">
            <div class="refp-qr-box">
              <img id="refpQrImage" src="" alt="Referral QR code">
              <div class="refp-qr-link" id="refpQrLink"></div>
            </div>
          </div>
          <div class="refp-modal-foot">
            <div class="refp-help">Scan or download this QR code to share the referral signup page.</div>
            <div style="display:flex;gap:10px;flex-wrap:wrap;">
              <button class="refp-btn primary" type="button" id="refpQrDownloadBtn"><i class="fas fa-download"></i> Download QR</button>
            </div>
          </div>
        </div>
      `;
      document.body.appendChild(wrap);
    }
    if (!document.getElementById('refpAttachWrap')) {
      const wrap = document.createElement('div');
      wrap.id = 'refpAttachWrap';
      wrap.className = 'refp-modal-wrap';
      wrap.innerHTML = `
        <div class="refp-modal">
          <div class="refp-modal-head">
            <h3 id="refpAttachTitle">Pair Organization</h3>
            <button class="refp-close" type="button" data-close="refpAttachWrap">&times;</button>
          </div>
          <div class="refp-modal-body">
            <div class="refp-attach-target" id="refpAttachPartnerSummary"></div>
            <div class="refp-field">
              <label>Organization Search</label>
              <div class="refp-org-search-row">
                <input id="refpAttachSearch" type="text" placeholder="Search org name, email, phone, or org id">
                <button class="refp-btn subtle" type="button" id="refpAttachSearchBtn"><i class="fas fa-search"></i> Search</button>
              </div>
            </div>
            <div class="refp-org-results" id="refpAttachOrgResults"></div>
            <div class="refp-field full">
              <label>Internal Note</label>
              <textarea id="refpAttachNote" placeholder="Optional note explaining why this was manually paired"></textarea>
            </div>
          </div>
          <div class="refp-modal-foot">
            <div class="refp-help" id="refpAttachStatus">Choose an organization to start this referral offer and attribution.</div>
            <div style="display:flex;gap:10px;flex-wrap:wrap;">
              <button class="refp-btn" type="button" data-close="refpAttachWrap">Cancel</button>
              <button class="refp-btn primary" type="button" id="refpAttachSubmitBtn"><i class="fas fa-link"></i> Pair Organization</button>
            </div>
          </div>
        </div>
      `;
      document.body.appendChild(wrap);
    }
    document.querySelectorAll('[data-close]').forEach(btn => {
      if (btn.dataset.bound === '1') return;
      btn.dataset.bound = '1';
      btn.addEventListener('click', () => {
        const target = document.getElementById(btn.getAttribute('data-close'));
        if (target) target.classList.remove('open');
      });
    });
    ['refpEditorWrap', 'refpQrWrap', 'refpAttachWrap'].forEach(id => {
      const wrap = document.getElementById(id);
      if (!wrap || wrap.dataset.outsideBound === '1') return;
      wrap.dataset.outsideBound = '1';
      wrap.addEventListener('click', (event) => {
        if (event.target !== wrap) return;
        if (id === 'refpEditorWrap' && state.saveInFlight) return;
        if (id === 'refpAttachWrap' && state.attachInFlight) return;
        closeModal(id);
      });
    });
  }

  function openModal(id){
    const el = document.getElementById(id);
    if (el) el.classList.add('open');
  }

  function closeModal(id){
    const el = document.getElementById(id);
    if (el) el.classList.remove('open');
  }

  function showCopyState(btn, ok){
    if (!btn) return;
    if (state.copyResetTimer) {
      clearTimeout(state.copyResetTimer);
      state.copyResetTimer = null;
    }
    const originalHtml = btn.dataset.originalHtml || btn.innerHTML;
    btn.dataset.originalHtml = originalHtml;
    btn.innerHTML = ok
      ? '<i class="fas fa-check"></i> Copied'
      : '<i class="fas fa-triangle-exclamation"></i> Copy Failed';
    btn.disabled = true;
    state.copyResetTimer = setTimeout(() => {
      btn.innerHTML = btn.dataset.originalHtml || '<i class="fas fa-link"></i> Copy Link';
      btn.disabled = false;
      state.copyResetTimer = null;
    }, ok ? 1400 : 1800);
  }

  function updateLogoPreview(src, displayName){
    const img = document.getElementById('refpLogoPreview');
    const fallback = document.getElementById('refpLogoFallback');
    if (!img || !fallback) return;
    const trimmed = String(src || '').trim();
    if (trimmed) {
      img.src = trimmed;
      img.style.display = '';
      fallback.style.display = 'none';
    } else {
      img.src = '';
      img.style.display = 'none';
      fallback.style.display = '';
      fallback.textContent = String(displayName || '?').trim().charAt(0).toUpperCase() || '?';
    }
  }

  function syncOfferDefaultForType(){
    const type = document.getElementById('refpType');
    const offer = document.getElementById('refpNewOrgOfferId');
    if (!type || !offer) return;
    if (!offer.dataset.touched) {
      offer.value = type.value === 'manufacturer_rep' ? 'referral_week_discount_v1' : '';
    }
  }

  function setEditorBusy(isBusy, message){
    const wrap = document.getElementById('refpEditorWrap');
    const saveStatus = document.getElementById('refpSaveStatus');
    if (saveStatus && message) saveStatus.textContent = message;
    if (!wrap) return;
    wrap.querySelectorAll('input, select, textarea, button').forEach(el => {
      if (el.id === 'refpSaveBtn') return;
      if (el.hasAttribute('data-close') && !isBusy) {
        el.disabled = false;
        return;
      }
      if (el.id === 'refpQrDownloadBtn') return;
      if (el.id === 'refpSaveBtn') return;
      el.disabled = !!isBusy;
    });
    const saveBtn = document.getElementById('refpSaveBtn');
    if (saveBtn && isBusy) {
      saveBtn.disabled = true;
      saveBtn.dataset.loadingHtml = saveBtn.dataset.loadingHtml || saveBtn.innerHTML;
      saveBtn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Loading...';
      saveBtn.style.opacity = '0.72';
      saveBtn.style.cursor = 'wait';
    } else if (saveBtn && !state.saveInFlight) {
      saveBtn.disabled = false;
      saveBtn.innerHTML = saveBtn.dataset.loadingHtml || '<i class="fas fa-floppy-disk"></i> Save Partner';
      saveBtn.style.opacity = '';
      saveBtn.style.cursor = '';
    }
  }

  function populateEditorFromPartner(p, code, signupUrl){
    p = p || {};
    code = code || {};
    const saveStatus = document.getElementById('refpSaveStatus');
    document.getElementById('refpId').value = p.id || '';
    document.getElementById('refpType').value = p.type || 'manufacturer_rep';
    document.getElementById('refpStatus').value = p.status || 'active';
    document.getElementById('refpDisplayName').value = p.display_name || '';
    document.getElementById('refpCompanyName').value = p.company_name || '';
    document.getElementById('refpContactName').value = p.contact_name || '';
    document.getElementById('refpContactEmail').value = p.contact_email || '';
    document.getElementById('refpContactPhone').value = p.contact_phone || '';
    document.getElementById('refpLinkedUserEmail').value = p.linked_user_email || '';
    document.getElementById('refpNewOrgOfferId').value = code.new_org_offer_id || '';
    document.getElementById('refpLogoUrl').value = p.logo_path ? '' : (p.logo_url || '');
    document.getElementById('refpNotes').value = p.notes || '';
    updateLogoPreview(p.logo_url || '', p.display_name || '');
    if (saveStatus) saveStatus.textContent = signupUrl || 'The primary signup link is generated automatically.';
  }

  async function openEditor(id, item){
    ensureModals();
    const saveStatus = document.getElementById('refpSaveStatus');
    if (saveStatus) saveStatus.textContent = 'The primary signup link is generated automatically.';
    document.getElementById('refpEditorTitle').textContent = id ? 'Edit Referral Partner' : 'New Referral Partner';
    document.getElementById('refpId').value = '';
    document.getElementById('refpType').value = 'manufacturer_rep';
    document.getElementById('refpStatus').value = 'active';
    document.getElementById('refpDisplayName').value = '';
    document.getElementById('refpCompanyName').value = '';
    document.getElementById('refpContactName').value = '';
    document.getElementById('refpContactEmail').value = '';
    document.getElementById('refpContactPhone').value = '';
    document.getElementById('refpLinkedUserEmail').value = '';
    document.getElementById('refpNewOrgOfferId').value = 'referral_week_discount_v1';
    document.getElementById('refpNewOrgOfferId').dataset.touched = '';
    document.getElementById('refpLogoUrl').value = '';
    document.getElementById('refpLogoFile').value = '';
    document.getElementById('refpNotes').value = '';
    updateLogoPreview('', '');
    openModal('refpEditorWrap');
    if (id) {
      if (item) {
        populateEditorFromPartner(item, item.primary_code || {}, item.signup_url || '');
      } else {
        setEditorBusy(true, 'Loading referral partner...');
        try {
          const data = await api('referral_partner_get', { id });
          populateEditorFromPartner(data.partner || {}, data.primary_code || {}, data.signup_url || '');
        } catch (err) {
          if (saveStatus) saveStatus.textContent = 'Could not load referral partner.';
        } finally {
          setEditorBusy(false);
        }
        return;
      }
    } else {
      syncOfferDefaultForType();
    }
    setEditorBusy(false);
  }

  async function saveEditor(){
    if (state.saveInFlight) return;
    const fileInput = document.getElementById('refpLogoFile');
    const saveBtn = document.getElementById('refpSaveBtn');
    const cancelBtn = document.querySelector('#refpEditorWrap [data-close="refpEditorWrap"]');
    const saveStatus = document.getElementById('refpSaveStatus');
    const payload = {
      id: document.getElementById('refpId').value,
      type: document.getElementById('refpType').value,
      status: document.getElementById('refpStatus').value,
      display_name: document.getElementById('refpDisplayName').value,
      company_name: document.getElementById('refpCompanyName').value,
      contact_name: document.getElementById('refpContactName').value,
      contact_email: document.getElementById('refpContactEmail').value,
      contact_phone: document.getElementById('refpContactPhone').value,
      linked_user_email: document.getElementById('refpLinkedUserEmail').value,
      new_org_offer_id: document.getElementById('refpNewOrgOfferId').value,
      logo_url: document.getElementById('refpLogoUrl').value,
      notes: document.getElementById('refpNotes').value
    };
    state.saveInFlight = true;
    const originalSaveHtml = saveBtn ? saveBtn.innerHTML : '';
    const originalCancelDisabled = cancelBtn ? !!cancelBtn.disabled : false;
    try {
      if (saveBtn) {
        saveBtn.disabled = true;
        saveBtn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Saving...';
        saveBtn.style.opacity = '0.72';
        saveBtn.style.cursor = 'wait';
      }
      if (cancelBtn) cancelBtn.disabled = true;
      if (saveStatus) saveStatus.textContent = 'Saving referral partner...';
      const data = await api('referral_partner_save', payload, fileInput);
      if (!data.success) {
        if (saveStatus) saveStatus.textContent = data.error || 'Could not save referral partner.';
        return;
      }
      if (data.partner && data.partner.id) {
        document.getElementById('refpId').value = data.partner.id;
      }
      if (saveStatus) saveStatus.textContent = data.signup_url || 'Saved.';
      await loadPartners();
      closeModal('refpEditorWrap');
    } catch (err) {
      if (saveStatus) saveStatus.textContent = 'Could not save referral partner.';
    } finally {
      state.saveInFlight = false;
      if (saveBtn) {
        saveBtn.disabled = false;
        saveBtn.innerHTML = originalSaveHtml || '<i class="fas fa-floppy-disk"></i> Save Partner';
        saveBtn.style.opacity = '';
        saveBtn.style.cursor = '';
      }
      if (cancelBtn) cancelBtn.disabled = originalCancelDisabled;
    }
  }

  function dateText(value){
    if (!value) return '';
    const d = new Date(value);
    if (Number.isNaN(d.getTime())) return String(value);
    return d.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
  }

  function selectedAttachOrg(){
    return state.attachOrgs.find(org => String(org.id || '') === String(state.attachSelectedOrgId || '')) || null;
  }

  function renderAttachOrgs(){
    const host = document.getElementById('refpAttachOrgResults');
    const submit = document.getElementById('refpAttachSubmitBtn');
    if (!host) return;
    if (!state.attachOrgs.length) {
      host.innerHTML = `<div class="refp-empty">${state.attachSearch ? 'No organizations match that search.' : 'Search for an organization to pair.'}</div>`;
    } else {
      host.innerHTML = state.attachOrgs.map(org => {
        const selected = String(org.id || '') === String(state.attachSelectedOrgId || '');
        const hasEmail = !!String(org.email || '').trim();
        const disabled = !!org.has_referral || !hasEmail;
        const pill = org.has_referral
          ? `<span class="refp-org-pill warn">Already paired</span>`
          : !hasEmail
            ? `<span class="refp-org-pill warn">No email</span>`
          : `<span class="refp-org-pill">Available</span>`;
        const referralText = org.has_referral
          ? `<div class="refp-org-sub">Paired to ${escapeHtml(org.referral_partner_name || 'a referral partner')} ${escapeHtml(org.referral_code || '')}</div>`
          : '';
        return `
          <button class="refp-org-row ${selected ? 'selected' : ''} ${disabled ? 'disabled' : ''}" type="button" data-org-id="${escapeHtml(org.id || '')}" ${disabled ? 'disabled' : ''}>
            <div class="refp-org-main"><span>${escapeHtml(org.name || org.id || 'Organization')}</span>${pill}</div>
            <div class="refp-org-sub">${escapeHtml(org.email || 'No customer email')} ${org.phone ? '&bull; ' + escapeHtml(org.phone) : ''}</div>
            <div class="refp-org-sub">${escapeHtml(org.id || '')}${org.created_at ? ' &bull; Created ' + escapeHtml(dateText(org.created_at)) : ''}</div>
            ${referralText}
          </button>
        `;
      }).join('');
    }
    if (submit) submit.disabled = !selectedAttachOrg() || state.attachInFlight;
  }

  async function loadAttachOrgs(){
    const status = document.getElementById('refpAttachStatus');
    const search = document.getElementById('refpAttachSearch');
    state.attachSearch = search ? search.value || '' : state.attachSearch;
    state.attachSelectedOrgId = '';
    if (status) status.textContent = 'Searching organizations...';
    try {
      const data = await api('referral_org_search', { query: state.attachSearch, limit: 120 });
      state.attachOrgs = Array.isArray(data.organizations) ? data.organizations : [];
      if (status) status.textContent = 'Choose an organization to start this referral offer and attribution.';
    } catch (err) {
      state.attachOrgs = [];
      if (status) status.textContent = 'Could not search organizations.';
    }
    renderAttachOrgs();
  }

  function openAttach(item){
    ensureModals();
    state.attachPartner = item || null;
    state.attachOrgs = [];
    state.attachSelectedOrgId = '';
    state.attachSearch = '';
    const code = item && item.primary_code ? item.primary_code : {};
    const title = document.getElementById('refpAttachTitle');
    const summary = document.getElementById('refpAttachPartnerSummary');
    const search = document.getElementById('refpAttachSearch');
    const note = document.getElementById('refpAttachNote');
    const status = document.getElementById('refpAttachStatus');
    if (title) title.textContent = 'Pair Organization to ' + (item.display_name || 'Referral Partner');
    if (summary) {
      summary.innerHTML = `
        <div class="refp-name">${escapeHtml(item.display_name || 'Referral Partner')}</div>
        <div class="refp-org-sub">${escapeHtml(code.code || 'No code')} &bull; ${escapeHtml(promoLabel(item))}</div>
      `;
    }
    if (search) search.value = '';
    if (note) note.value = '';
    if (status) status.textContent = 'Search for an organization to pair with this referral partner.';
    renderAttachOrgs();
    openModal('refpAttachWrap');
    setTimeout(() => search && search.focus(), 50);
  }

  async function submitAttach(){
    if (state.attachInFlight) return;
    const partner = state.attachPartner || {};
    const org = selectedAttachOrg();
    const status = document.getElementById('refpAttachStatus');
    const submit = document.getElementById('refpAttachSubmitBtn');
    const note = document.getElementById('refpAttachNote');
    if (!partner.id || !org) {
      if (status) status.textContent = 'Choose an organization first.';
      return;
    }
    state.attachInFlight = true;
    const originalHtml = submit ? submit.innerHTML : '';
    if (submit) {
      submit.disabled = true;
      submit.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Pairing...';
    }
    if (status) status.textContent = 'Pairing organization and starting referral offer...';
    try {
      const data = await api('referral_manual_attach', {
        partner_id: partner.id,
        org_id: org.id,
        note: note ? note.value || '' : ''
      });
      if (!data.success) {
        if (status) status.textContent = data.error || 'Could not pair this organization.';
        return;
      }
      if (status) status.textContent = 'Organization paired. Refreshing referral partners...';
      await loadPartners();
      closeModal('refpAttachWrap');
    } catch (err) {
      if (status) status.textContent = 'Could not pair this organization.';
    } finally {
      state.attachInFlight = false;
      if (submit) {
        submit.innerHTML = originalHtml || '<i class="fas fa-link"></i> Pair Organization';
        submit.disabled = !selectedAttachOrg();
      }
    }
  }

  function qrImageUrl(link){
    return 'https://api.qrserver.com/v1/create-qr-code/?size=360x360&margin=12&data=' + encodeURIComponent(link);
  }

  async function downloadQr(link, filenameBase){
    const res = await fetch(qrImageUrl(link));
    const blob = await res.blob();
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = (filenameBase || 'referral_qr') + '.png';
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  function openQr(item){
    ensureModals();
    const link = String(item.signup_url || '');
    const title = document.getElementById('refpQrTitle');
    const img = document.getElementById('refpQrImage');
    const linkText = document.getElementById('refpQrLink');
    const downloadBtn = document.getElementById('refpQrDownloadBtn');
    title.textContent = (item.display_name || 'Referral Partner') + ' QR Code';
    img.src = qrImageUrl(link);
    linkText.textContent = link;
    downloadBtn.onclick = () => downloadQr(link, (item.display_name || 'referral_partner').toLowerCase().replace(/[^a-z0-9]+/g, '_'));
    openModal('refpQrWrap');
  }

  async function handleTableClick(event){
    const btn = event.target.closest('[data-action][data-id]');
    if (!btn) return;
    const item = state.items.find(entry => entry.id === btn.getAttribute('data-id'));
    if (!item) return;
    const action = btn.getAttribute('data-action');
    if (action === 'copy') {
      try {
        await navigator.clipboard.writeText(item.signup_url || '');
        showCopyState(btn, true);
      } catch (err) {
        showCopyState(btn, false);
      }
      return;
    }
    if (action === 'qr') {
      openQr(item);
      return;
    }
    if (action === 'attach') {
      openAttach(item);
      return;
    }
    if (action === 'edit') {
      openEditor(item.id, item);
    }
  }

  function bindShell(){
    const search = document.getElementById('refpSearch');
    const refreshBtn = document.getElementById('refpRefreshBtn');
    const createBtn = document.getElementById('refpCreateBtn');
    const tbody = document.getElementById('refpTableBody');
    if (search && !search.dataset.bound) {
      search.dataset.bound = '1';
      search.addEventListener('input', () => {
        state.search = search.value || '';
        renderRows();
      });
    }
    if (refreshBtn && !refreshBtn.dataset.bound) {
      refreshBtn.dataset.bound = '1';
      refreshBtn.addEventListener('click', () => loadPartners());
    }
    if (createBtn && !createBtn.dataset.bound) {
      createBtn.dataset.bound = '1';
      createBtn.addEventListener('click', () => openEditor(''));
    }
    if (tbody && !tbody.dataset.bound) {
      tbody.dataset.bound = '1';
      tbody.addEventListener('click', handleTableClick);
    }
  }

  function bindModalInputs(){
    ensureModals();
    const type = document.getElementById('refpType');
    const offer = document.getElementById('refpNewOrgOfferId');
    const saveBtn = document.getElementById('refpSaveBtn');
    const displayName = document.getElementById('refpDisplayName');
    const logoUrl = document.getElementById('refpLogoUrl');
    const logoFile = document.getElementById('refpLogoFile');
    const attachSearch = document.getElementById('refpAttachSearch');
    const attachSearchBtn = document.getElementById('refpAttachSearchBtn');
    const attachSubmitBtn = document.getElementById('refpAttachSubmitBtn');
    const attachResults = document.getElementById('refpAttachOrgResults');
    if (type && !type.dataset.bound) {
      type.dataset.bound = '1';
      type.addEventListener('change', syncOfferDefaultForType);
    }
    if (offer && !offer.dataset.bound) {
      offer.dataset.bound = '1';
      offer.addEventListener('change', () => { offer.dataset.touched = '1'; });
    }
    if (saveBtn && !saveBtn.dataset.bound) {
      saveBtn.dataset.bound = '1';
      saveBtn.addEventListener('click', saveEditor);
    }
    if (displayName && !displayName.dataset.bound) {
      displayName.dataset.bound = '1';
      displayName.addEventListener('input', () => updateLogoPreview(document.getElementById('refpLogoUrl').value, displayName.value));
    }
    if (logoUrl && !logoUrl.dataset.bound) {
      logoUrl.dataset.bound = '1';
      logoUrl.addEventListener('input', () => updateLogoPreview(logoUrl.value, document.getElementById('refpDisplayName').value));
    }
    if (logoFile && !logoFile.dataset.bound) {
      logoFile.dataset.bound = '1';
      logoFile.addEventListener('change', () => {
        const file = logoFile.files && logoFile.files[0];
        if (!file) return;
        const reader = new FileReader();
        reader.onload = () => updateLogoPreview(reader.result, document.getElementById('refpDisplayName').value);
        reader.readAsDataURL(file);
      });
    }
    if (attachSearch && !attachSearch.dataset.bound) {
      attachSearch.dataset.bound = '1';
      attachSearch.addEventListener('keydown', e => {
        if (e.key === 'Enter') {
          e.preventDefault();
          loadAttachOrgs();
        }
      });
      attachSearch.addEventListener('input', () => {
        clearTimeout(attachSearch._timer);
        attachSearch._timer = setTimeout(loadAttachOrgs, 250);
      });
    }
    if (attachSearchBtn && !attachSearchBtn.dataset.bound) {
      attachSearchBtn.dataset.bound = '1';
      attachSearchBtn.addEventListener('click', loadAttachOrgs);
    }
    if (attachSubmitBtn && !attachSubmitBtn.dataset.bound) {
      attachSubmitBtn.dataset.bound = '1';
      attachSubmitBtn.addEventListener('click', submitAttach);
    }
    if (attachResults && !attachResults.dataset.bound) {
      attachResults.dataset.bound = '1';
      attachResults.addEventListener('click', e => {
        const row = e.target.closest('[data-org-id]');
        if (!row || row.disabled) return;
        state.attachSelectedOrgId = row.getAttribute('data-org-id') || '';
        const status = document.getElementById('refpAttachStatus');
        const org = selectedAttachOrg();
        if (status && org) status.textContent = `Ready to pair ${org.name || org.id} to ${state.attachPartner?.display_name || 'this partner'}.`;
        renderAttachOrgs();
      });
    }
  }

  const ReferralPartnersTab = {
    init(){
      if (state.loaded) return;
      ensureStyles();
      ensureModals();
      bindModalInputs();
      const mount = root();
      if (!mount) return;
      mount.innerHTML = shellHtml();
      bindShell();
      state.loaded = true;
    },
    async onShow(){
      this.init();
      await loadPartners();
    }
  };

  window.ReferralPartnersTab = ReferralPartnersTab;
})();
