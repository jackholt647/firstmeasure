(function(){
  if (!window.Portal) return;
  const { escapeHtml } = window.Portal;

  const state = {
    loaded: false,
    loading: false,
    rows: [],
    search: '',
    status: 'all',
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

  function api(action, extra){
    const payload = extra || {};
    if (action === 'referral_reward_report') {
      return request('/rewards');
    }
    if (action === 'referral_reward_update_status') {
      return request('/rewards/' + encodeURIComponent(payload.reward_id || '') + '/status', {
        method: 'PATCH',
        headers: { 'Accept': 'application/json', 'Content-Type': 'application/json' },
        body: JSON.stringify({ status: payload.status || 'pending' })
      });
    }
    return window.Portal.apiPost(window.Portal.cfg.endpoints.server, Object.assign({ action }, payload));
  }

  function money(value){
    const n = Number(value || 0);
    return n.toLocaleString(undefined, { style: 'currency', currency: 'USD', maximumFractionDigits: 2 });
  }

  function dateText(value){
    if (!value) return '';
    const d = new Date(value);
    if (Number.isNaN(d.getTime())) return String(value);
    return d.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
  }

  function statusLabel(row){
    const reward = row.reward || null;
    if (reward && reward.status) return reward.status;
    return row.status || 'tracking';
  }

  function ensureStyles(){
    if (document.getElementById('referralRewardsStyles')) return;
    const style = document.createElement('style');
    style.id = 'referralRewardsStyles';
    style.textContent = `
      .refr-shell{padding:24px;display:flex;flex-direction:column;gap:18px}
      .refr-card{background:#fff;border:1px solid #e7e7e7;border-radius:8px;box-shadow:0 4px 14px rgba(0,0,0,.04)}
      .refr-header{display:flex;align-items:center;justify-content:space-between;gap:16px;padding:20px 22px;border-bottom:1px solid #eee}
      .refr-title h2{margin:0;font-size:24px;font-weight:900}
      .refr-title p{margin:5px 0 0;color:#667085;font-size:13px;font-weight:600}
      .refr-actions{display:flex;align-items:center;gap:10px;flex-wrap:wrap}
      .refr-input,.refr-select{padding:11px 12px;border:1px solid #d0d5dd;border-radius:8px;background:#fff;font-size:13px}
      .refr-input{min-width:300px}
      .refr-btn{display:inline-flex;align-items:center;justify-content:center;gap:8px;padding:10px 13px;border-radius:8px;border:1px solid #d0d5dd;background:#fff;font-size:12px;font-weight:800;cursor:pointer}
      .refr-btn.primary{background:var(--primary);border-color:var(--primary);color:#fff}
      .refr-stats{display:grid;grid-template-columns:repeat(auto-fit,minmax(170px,1fr));gap:12px;padding:16px 22px;border-bottom:1px solid #eee;background:#f8fafc}
      .refr-stat{background:#fff;border:1px solid #e5e7eb;border-radius:8px;padding:13px}
      .refr-stat .label{font-size:10px;text-transform:uppercase;font-weight:900;color:#667085}
      .refr-stat .value{font-size:22px;font-weight:900;margin-top:5px;color:#111827}
      .refr-table-wrap{overflow:auto}
      .refr-table{width:100%;border-collapse:collapse}
      .refr-table th,.refr-table td{padding:13px 14px;border-bottom:1px solid #eef2f6;text-align:left;vertical-align:top;font-size:13px}
      .refr-table th{font-size:10px;text-transform:uppercase;color:#667085;background:#f8fafc;letter-spacing:.03em}
      .refr-main{font-weight:900;color:#101828}
      .refr-sub{font-size:12px;color:#667085;margin-top:4px}
      .refr-badge{display:inline-flex;align-items:center;border-radius:999px;padding:5px 9px;font-size:11px;font-weight:900;text-transform:capitalize;background:#eef2ff;color:#344054}
      .refr-badge.tracking{background:#f2f4f7;color:#475467}
      .refr-badge.pending{background:#fff7ed;color:#c2410c}
      .refr-badge.approved{background:#ecfdf3;color:#027a48}
      .refr-badge.sent{background:#e0f2fe;color:#0369a1}
      .refr-badge.void{background:#fef2f2;color:#b42318}
      .refr-progress{min-width:150px}
      .refr-bar{height:8px;background:#e5e7eb;border-radius:999px;overflow:hidden;margin-top:7px}
      .refr-bar span{display:block;height:100%;background:var(--primary);border-radius:999px}
      .refr-empty{padding:36px;text-align:center;color:#667085;font-weight:700}
      .refr-status-select{padding:7px 9px;border-radius:8px;border:1px solid #d0d5dd;background:#fff;font-size:12px;font-weight:800}
      @media (max-width: 900px){
        .refr-header{align-items:flex-start;flex-direction:column}
        .refr-actions,.refr-input{width:100%;min-width:0}
      }
    `;
    document.head.appendChild(style);
  }

  function root(){
    return document.getElementById('referralRewardsRoot');
  }

  function shellHtml(){
    return `
      <div class="refr-shell">
        <div class="refr-card">
          <div class="refr-header">
            <div class="refr-title">
              <h2>Referral Rewards</h2>
              <p>Track referred signups against paid revenue and manage pending gift-card payouts.</p>
            </div>
            <div class="refr-actions">
              <input id="refrSearch" class="refr-input" type="text" placeholder="Search referrer, customer, org, code...">
              <select id="refrStatus" class="refr-select">
                <option value="all">All statuses</option>
                <option value="tracking">Tracking</option>
                <option value="pending">Pending payout</option>
                <option value="approved">Approved</option>
                <option value="sent">Sent</option>
                <option value="void">Void</option>
                <option value="no_policy">No policy</option>
              </select>
              <button id="refrRefresh" class="refr-btn primary"><i class="fas fa-rotate"></i> Refresh</button>
            </div>
          </div>
          <div id="refrStats" class="refr-stats"></div>
          <div class="refr-table-wrap">
            <table class="refr-table">
              <thead>
                <tr>
                  <th>Referrer</th>
                  <th>Referred Customer</th>
                  <th>Policy</th>
                  <th>Paid Revenue</th>
                  <th>Reward</th>
                  <th>Status</th>
                </tr>
              </thead>
              <tbody id="refrRows"></tbody>
            </table>
          </div>
        </div>
      </div>
    `;
  }

  function filteredRows(){
    const q = state.search.trim().toLowerCase();
    return state.rows.filter(row => {
      const st = statusLabel(row);
      if (state.status !== 'all' && st !== state.status && row.status !== state.status) return false;
      if (!q) return true;
      const hay = [
        row.partner_name,
        row.referrer_email,
        row.referred_org_name,
        row.referred_email,
        row.referral_code,
        row.policy_id,
        row.policy_label,
      ].join(' ').toLowerCase();
      return hay.includes(q);
    });
  }

  function renderStats(rows){
    const host = document.getElementById('refrStats');
    if (!host) return;
    const pending = rows.filter(r => statusLabel(r) === 'pending').length;
    const sent = rows.filter(r => statusLabel(r) === 'sent').length;
    const tracking = rows.filter(r => statusLabel(r) === 'tracking').length;
    const pendingAmount = rows.reduce((sum, r) => statusLabel(r) === 'pending' && r.reward ? sum + Number(r.reward.amount || 0) : sum, 0);
    host.innerHTML = `
      <div class="refr-stat"><div class="label">Tracked Signups</div><div class="value">${rows.length}</div></div>
      <div class="refr-stat"><div class="label">Still Tracking</div><div class="value">${tracking}</div></div>
      <div class="refr-stat"><div class="label">Pending Payouts</div><div class="value">${pending}</div></div>
      <div class="refr-stat"><div class="label">Pending Amount</div><div class="value">${money(pendingAmount)}</div></div>
      <div class="refr-stat"><div class="label">Sent</div><div class="value">${sent}</div></div>
    `;
  }

  function renderRows(){
    const tbody = document.getElementById('refrRows');
    if (!tbody) return;
    const rows = filteredRows();
    renderStats(state.rows);
    if (!rows.length) {
      tbody.innerHTML = `<tr><td colspan="6" class="refr-empty">${state.loading ? 'Loading referral rewards...' : 'No referral rewards match this view.'}</td></tr>`;
      return;
    }
    tbody.innerHTML = rows.map(row => {
      const reward = row.reward || null;
      const st = statusLabel(row);
      const progress = Number(row.progress_percent || 0);
      const rewardText = reward ? `${money(reward.amount)} ${String(reward.reward_type || '').replace(/_/g, ' ')}` : 'Not earned yet';
      const disabled = !reward ? 'disabled' : '';
      return `
        <tr>
          <td>
            <div class="refr-main">${escapeHtml(row.partner_name || 'Referral Partner')}</div>
            <div class="refr-sub">${escapeHtml(row.referrer_email || 'No linked user email')}</div>
            <div class="refr-sub">${escapeHtml(row.referral_code || '')}</div>
          </td>
          <td>
            <div class="refr-main">${escapeHtml(row.referred_org_name || row.referred_email || 'Referred signup')}</div>
            <div class="refr-sub">${escapeHtml(row.referred_email || '')}</div>
            <div class="refr-sub">${escapeHtml(dateText(row.signup_completed_at))}</div>
          </td>
          <td>
            <div class="refr-main">${escapeHtml(row.policy_label || 'No reward policy')}</div>
            <div class="refr-sub">${escapeHtml(row.policy_id || '')}</div>
          </td>
          <td>
            <div class="refr-progress">
              <div class="refr-main">${money(row.qualified_paid_revenue)} / ${money(row.threshold_paid_revenue)}</div>
              <div class="refr-bar"><span style="width:${Math.max(0, Math.min(100, progress))}%"></span></div>
              <div class="refr-sub">${progress}% qualified</div>
            </div>
          </td>
          <td>
            <div class="refr-main">${escapeHtml(rewardText)}</div>
            <div class="refr-sub">${reward ? escapeHtml(dateText(reward.created_at)) : ''}</div>
          </td>
          <td>
            <div style="display:grid;gap:8px;min-width:130px">
              <span class="refr-badge ${escapeHtml(st)}">${escapeHtml(st.replace(/_/g, ' '))}</span>
              <select class="refr-status-select" data-reward-id="${escapeHtml(reward ? reward.id : '')}" ${disabled}>
                ${['pending','approved','sent','void'].map(opt => `<option value="${opt}" ${reward && reward.status === opt ? 'selected' : ''}>${opt}</option>`).join('')}
              </select>
            </div>
          </td>
        </tr>
      `;
    }).join('');
  }

  async function loadRows(){
    state.loading = true;
    renderRows();
    try{
      const data = await api('referral_reward_report');
      state.rows = Array.isArray(data.rows) ? data.rows : [];
    }catch(err){
      state.rows = [];
    }
    state.loading = false;
    state.loaded = true;
    renderRows();
  }

  function bind(){
    const host = root();
    if (!host || host.dataset.bound === '1') return;
    host.dataset.bound = '1';
    host.addEventListener('input', e => {
      if (e.target && e.target.id === 'refrSearch') {
        state.search = e.target.value || '';
        renderRows();
      }
    });
    host.addEventListener('change', async e => {
      const target = e.target;
      if (!target) return;
      if (target.id === 'refrStatus') {
        state.status = target.value || 'all';
        renderRows();
        return;
      }
      if (target.classList.contains('refr-status-select')) {
        const rewardId = target.getAttribute('data-reward-id') || '';
        if (!rewardId) return;
        target.disabled = true;
        await api('referral_reward_update_status', { reward_id: rewardId, status: target.value }).catch(() => null);
        await loadRows();
      }
    });
    host.addEventListener('click', e => {
      const btn = e.target.closest('#refrRefresh');
      if (btn) loadRows();
    });
  }

  window.ReferralRewardsTab = {
    init(){
      ensureStyles();
      const el = root();
      if (el && !el.innerHTML.trim()) el.innerHTML = shellHtml();
      bind();
    },
    async onShow(){
      this.init();
      if (!state.loaded) await loadRows();
    }
  };
})();
