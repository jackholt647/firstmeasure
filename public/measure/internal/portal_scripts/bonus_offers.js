/* portal_scripts/bonus_offers.js
 * Internal bonus offer rollouts.
 */
(function(){
  if (!window.Portal) return;

  const esc = (value) => window.Portal.escapeHtml(String(value ?? ''));
  const money = new Intl.NumberFormat(undefined, { style:'currency', currency:'USD', maximumFractionDigits:0 });
  const fmt = new Intl.NumberFormat();
  const state = {
    loaded: false,
    loading: false,
    customers: [],
    rollouts: [],
    selected: new Set(),
    search: '',
    flagFilter: 'all',
    activityFilter: 'active',
    statusFilter: 'all',
    hideTests: true,
    page: 0,
    pageSize: 100,
    sortKey: 'monthly',
    sortDir: 'desc',
    lastSelectedIndex: null,
    dragSelecting: false,
    dragSelectValue: true,
    dragAnchorIndex: null,
    suppressNextClick: false,
    activeRolloutId: '',
    rolloutSearch: ''
  };

  function canAccess(){
    const cfg = window.Portal.cfg || window.PORTAL_CFG || {};
    const perms = cfg.perms || {};
    const user = cfg.user || {};
    return !!(user.is_admin || perms.manage_users || perms.manage_company_settings || perms.manage_sales_users);
  }

  function base(){
    const cfg = window.Portal.cfg || window.PORTAL_CFG || {};
    const endpoints = cfg.endpoints || {};
    const internal = endpoints.internal || endpoints.v1_internal;
    if (internal) return String(internal).replace(/\/+$/, '') + '/bonus-offers';
    const firstMeasure = String(endpoints.firstmeasure || '').replace(/\/+$/, '');
    if (firstMeasure) return firstMeasure.replace(/\/firstmeasure$/,'/internal') + '/bonus-offers';
    return `${location.origin}/v1/internal/bonus-offers`;
  }

  async function request(path = '', options = {}){
    const res = await fetch(base() + path, Object.assign({
      credentials:'same-origin',
      headers:{ 'Accept':'application/json' }
    }, options));
    const text = await res.text();
    let data = {};
    try { data = text ? JSON.parse(text) : {}; } catch { data = { success:false, error:text || 'Request failed.' }; }
    if (!res.ok || data.success === false || data.ok === false) throw new Error(data.message || data.error || `Request failed (${res.status})`);
    return data;
  }

  function ensureStyles(){
    if (document.getElementById('bonusOfferStyles')) return;
    const style = document.createElement('style');
    style.id = 'bonusOfferStyles';
    style.textContent = `
      #view-bonus-offers{min-width:0;overflow:hidden;display:flex;flex-direction:column;height:calc(100vh - 8px);box-sizing:border-box}
      #view-bonus-offers > .header-bar{margin-bottom:8px}
      .bo-shell{display:grid;grid-template-rows:auto minmax(0,1fr) minmax(118px,0.34fr);gap:8px;color:#172033;min-height:0;overflow:hidden;flex:1}
      .bo-actions{display:flex;gap:8px;align-items:center;flex-wrap:wrap}
      .bo-btn{display:inline-flex;align-items:center;justify-content:center;gap:7px;border:1px solid #d7dce5;background:#fff;color:#344054;border-radius:8px;padding:8px 10px;font-size:12px;font-weight:900;cursor:pointer;white-space:nowrap}
      .bo-btn.primary{background:#d93025;border-color:#d93025;color:#fff}
      .bo-btn:disabled{opacity:.55;cursor:default}
      .bo-card{background:#fff;border:1px solid #e3e7ef;border-radius:12px;box-shadow:0 4px 16px rgba(15,23,42,.04);min-width:0;min-height:0}
      .bo-pad{padding:10px}
      .bo-grid{display:grid;grid-template-columns:320px minmax(0,1fr);gap:8px;align-items:stretch;min-height:0;overflow:hidden}
      .bo-grid > .bo-card:first-child{overflow:auto}
      .bo-customer-card{display:flex;flex-direction:column;min-height:0;overflow:hidden}
      .bo-fields{display:grid;gap:7px}
      .bo-field{display:grid;gap:4px}
      .bo-field label{font-size:10px;font-weight:900;color:#667085;text-transform:uppercase;letter-spacing:.05em}
      .bo-field input,.bo-field select{box-sizing:border-box;width:100%;padding:8px 9px;border:1px solid #d0d5dd;border-radius:8px;background:#fff;font:inherit;font-size:13px}
      .bo-tier-row{display:grid;grid-template-columns:1fr 74px 74px;gap:6px;align-items:end}
      .bo-muted{font-size:12px;color:#667085;font-weight:700}
      .bo-stats{display:grid;grid-template-columns:repeat(5,minmax(120px,1fr));gap:8px}
      .bo-stat{background:#fff;border:1px solid #e3e7ef;border-radius:10px;padding:8px 10px}
      .bo-stat span{display:block;font-size:10px;font-weight:900;color:#667085;text-transform:uppercase;letter-spacing:.04em}
      .bo-stat strong{display:block;margin-top:3px;font-size:18px;font-weight:1000;color:#101828}
      .bo-toolbar{display:flex;gap:8px;align-items:end;flex-wrap:wrap;padding:8px 10px;border-bottom:1px solid #edf2f7}
      .bo-toolbar .bo-field{min-width:150px}
      .bo-table-wrap{overflow-x:auto;overflow-y:scroll;overscroll-behavior:contain;min-height:0;flex:1 1 auto}
      .bo-table{width:100%;border-collapse:collapse;background:#fff}
      .bo-table th{position:sticky;top:0;z-index:2;background:#f8fafc;padding:7px 9px;text-align:left;font-size:10px;font-weight:900;color:#667085;text-transform:uppercase;letter-spacing:.04em;border-bottom:1px solid #e5e7eb;white-space:nowrap;cursor:pointer}
      .bo-table td{padding:7px 9px;border-bottom:1px solid #edf2f7;font-size:12px;vertical-align:middle}
      .bo-table tbody tr:hover td{background:#fafafa}
      .bo-table tbody tr.selected td{background:#fff7f5}
      .bo-table tbody tr.drag-over td{background:#fff1ed}
      .bo-table.selecting,.bo-table.selecting *{user-select:none}
      .bo-select-cell{width:32px;cursor:cell}
      .bo-check{width:16px;height:16px}
      .bo-org-name{font-weight:1000;color:#101828}
      .bo-pill{display:inline-flex;align-items:center;border-radius:999px;padding:3px 7px;font-size:10px;font-weight:900;background:#f2f4f7;color:#344054;white-space:nowrap}
      .bo-pill.on{background:#dcfce7;color:#166534}
      .bo-pill.off{background:#fee2e2;color:#991b1b}
      .bo-pill.claimed{background:#eef2ff;color:#3730a3}
      .bo-pill.viewed{background:#fff7ed;color:#9a3412}
      .bo-pill.active{background:#dcfce7;color:#166534}
      .bo-pill.inactive{background:#fef3c7;color:#92400e}
      .bo-pill.available,.bo-pill.scheduled{background:#ecfeff;color:#155e75}
      .bo-pill.expired,.bo-pill.cancelled{background:#f2f4f7;color:#667085}
      .bo-rollout-section{display:flex;flex-direction:column;min-height:0;overflow:hidden}
      .bo-rollout-section-head{display:flex;align-items:center;justify-content:space-between;gap:10px;margin-bottom:6px}
      .bo-rollouts{display:grid;grid-template-columns:repeat(auto-fit,minmax(290px,1fr));gap:8px;overflow:auto;min-height:0;align-content:start}
      .bo-rollout{display:grid;gap:5px;border:1px solid #e5e7eb;border-radius:10px;padding:8px;background:#fff;cursor:pointer}
      .bo-rollout:hover{border-color:#c8d0dd;background:#fbfcff}
      .bo-rollout-head{display:flex;align-items:flex-start;justify-content:space-between;gap:8px}
      .bo-rollout-name{font-size:13px;font-weight:1000;color:#101828;line-height:1.2}
      .bo-rollout-meta{display:flex;gap:6px;flex-wrap:wrap}
      .bo-rollout-actions{display:flex;gap:8px;flex-wrap:wrap}
      .bo-empty{padding:22px;text-align:center;color:#667085;font-size:13px;font-weight:800}
      .bo-nested-option{display:flex;align-items:center;gap:8px;margin-left:22px;font-size:12px;font-weight:800;color:#344054}
      .bo-nested-option.disabled{opacity:.55}
      .bo-customer-row{cursor:pointer}
      .bo-modal{position:fixed;inset:0;z-index:12000;background:rgba(15,23,42,.52);display:none;align-items:center;justify-content:center;padding:18px}
      .bo-modal.active{display:flex}
      .bo-modal-card{width:min(980px,100%);max-height:90vh;background:#fff;border-radius:12px;box-shadow:0 24px 70px rgba(15,23,42,.34);display:flex;flex-direction:column;overflow:hidden}
      .bo-modal-head{display:flex;align-items:flex-start;justify-content:space-between;gap:12px;padding:14px 16px;border-bottom:1px solid #edf2f7;background:#fbfcff}
      .bo-modal-title{font-size:18px;font-weight:1000;color:#101828;line-height:1.2}
      .bo-modal-sub{margin-top:3px;font-size:12px;font-weight:800;color:#667085}
      .bo-modal-close{width:34px;height:34px;border-radius:9px;border:1px solid #d7dce5;background:#fff;color:#344054;font-size:20px;font-weight:900;cursor:pointer}
      .bo-modal-body{padding:14px 16px;overflow:auto;display:grid;gap:12px}
      .bo-modal-toolbar{display:flex;align-items:end;gap:8px;flex-wrap:wrap}
      .bo-rollout-table-wrap{max-height:52vh;overflow:auto;border:1px solid #edf2f7;border-radius:10px}
      .bo-detail-grid{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:8px}
      .bo-detail-stat{border:1px solid #e3e7ef;border-radius:10px;padding:10px;background:#fff}
      .bo-detail-stat span{display:block;font-size:10px;font-weight:900;color:#667085;text-transform:uppercase;letter-spacing:.04em}
      .bo-detail-stat strong{display:block;margin-top:5px;font-size:16px;font-weight:1000;color:#101828;line-height:1.1}
      .bo-history-list{display:grid;gap:10px}
      .bo-history-card{border:1px solid #e3e7ef;border-radius:11px;background:#fff;padding:11px;display:grid;gap:10px}
      .bo-history-top{display:flex;align-items:flex-start;justify-content:space-between;gap:10px}
      .bo-history-title{font-size:14px;font-weight:1000;color:#101828;line-height:1.2}
      .bo-timeline{display:grid;grid-template-columns:repeat(5,minmax(0,1fr));gap:7px}
      .bo-timebox{border:1px solid #edf2f7;border-radius:9px;background:#fbfcff;padding:8px}
      .bo-timebox span{display:block;font-size:9px;font-weight:900;color:#667085;text-transform:uppercase;letter-spacing:.04em}
      .bo-timebox strong{display:block;margin-top:4px;font-size:11px;font-weight:900;color:#101828;line-height:1.25}
      .bo-mini-table{width:100%;border-collapse:collapse}
      .bo-mini-table th,.bo-mini-table td{padding:6px 7px;border-bottom:1px solid #edf2f7;text-align:left;font-size:11px}
      .bo-mini-table th{font-size:9px;text-transform:uppercase;color:#667085;letter-spacing:.04em;background:#fbfcff}
      .bo-pager{display:flex;align-items:center;justify-content:space-between;gap:10px;padding:7px 10px;border-top:1px solid #edf2f7;background:#fbfcff}
      .bo-pager-actions{display:flex;gap:7px;align-items:center}
      @media(max-width:1050px){#view-bonus-offers{height:auto;overflow:visible}.bo-shell{height:auto;overflow:visible}.bo-grid,.bo-stats{grid-template-columns:1fr}.bo-table-wrap{max-height:none;overflow:auto}.bo-rollouts{max-height:260px}}
      @media(max-width:760px){.bo-modal{align-items:flex-end;padding:0}.bo-modal-card{width:100%;max-height:92vh;border-radius:16px 16px 0 0}.bo-detail-grid,.bo-timeline{grid-template-columns:1fr}.bo-modal-body{padding:12px}.bo-history-top{display:grid}}
    `;
    document.head.appendChild(style);
  }

  function ensureMarkup(){
    const host = document.getElementById('portalPluginViews');
    if (!host || document.getElementById('view-bonus-offers')) return;
    const view = document.createElement('div');
    view.id = 'view-bonus-offers';
    view.style.display = 'none';
    view.innerHTML = `
      <div class="header-bar">
        <h1>Bonus Offer</h1>
        <div class="bo-actions">
          <button class="bo-btn" id="boRefresh"><i class="fas fa-sync"></i> Refresh</button>
        </div>
      </div>
      <div class="bo-shell">
        <div class="bo-stats" id="boStats"></div>
        <div class="bo-grid">
          <div class="bo-card bo-pad">
            <div class="bo-fields">
              <div>
                <h3 style="margin:0 0 4px;">Launch Rollout</h3>
                <div class="bo-muted">Selected organizations receive frozen offer values. The portal flag still gates visibility.</div>
              </div>
              <div class="bo-field">
                <label>Offer name</label>
                <input id="boOfferName" value="Credit usage bonus offer">
              </div>
              <div class="bo-field">
                <label>Starts at</label>
                <input id="boStartsAt" type="datetime-local">
              </div>
              <div class="bo-field">
                <label>Visible after first view, hours</label>
                <input id="boWindowHours" type="number" min="1" step="1" value="24">
              </div>
              <div class="bo-field">
                <label>Base months for first option</label>
                <input id="boBaseMonths" type="number" min="0.1" step="0.1" value="2">
              </div>
              <div class="bo-fields" id="boTierEditor"></div>
              <label style="display:flex;align-items:center;gap:8px;font-size:12px;font-weight:800;color:#344054;">
                <input id="boCancelExisting" type="checkbox" checked> Cancel existing unclaimed bonus offers for selected orgs
              </label>
              <label class="bo-nested-option" id="boCancelUnviewedOnlyWrap">
                <input id="boCancelUnviewedOnly" type="checkbox"> Only cancel existing offers that have not been viewed yet
              </label>
              <button class="bo-btn primary" id="boLaunch"><i class="fas fa-rocket"></i> Launch to Selected</button>
              <div class="bo-muted" id="boLaunchStatus"></div>
            </div>
          </div>
          <div class="bo-card bo-customer-card">
            <div class="bo-toolbar">
              <div class="bo-field" style="min-width:260px;">
                <label>Search</label>
                <input id="boSearch" placeholder="Company, org id, salesperson">
              </div>
              <div class="bo-field">
                <label>Feature flag</label>
                <select id="boFlagFilter">
                  <option value="all">All</option>
                  <option value="on">Flag on</option>
                  <option value="off">Flag off</option>
                </select>
              </div>
              <div class="bo-field">
                <label>Activity</label>
                <select id="boActivityFilter">
                  <option value="active">Active only</option>
                  <option value="all">All</option>
                  <option value="inactive">Inactive only</option>
                </select>
              </div>
              <div class="bo-field">
                <label>Offer status</label>
                <select id="boStatusFilter">
                  <option value="all">All</option>
                  <option value="none">No offer</option>
                  <option value="scheduled">Scheduled</option>
                  <option value="available">Available</option>
                  <option value="viewed">Viewed</option>
                  <option value="claimed">Claimed</option>
                  <option value="expired">Expired</option>
                  <option value="cancelled">Cancelled</option>
                </select>
              </div>
              <label style="display:flex;align-items:center;gap:7px;font-size:12px;font-weight:800;color:#344054;margin-bottom:9px;">
                <input id="boHideTests" type="checkbox" checked> Hide tests
              </label>
              <div class="bo-field">
                <label>Rows</label>
                <select id="boPageSize">
                  <option value="100">100</option>
                  <option value="250">250</option>
                  <option value="500">500</option>
                  <option value="all">All</option>
                </select>
              </div>
              <button class="bo-btn" id="boSelectFiltered"><i class="fas fa-check-square"></i> Select Filtered</button>
              <button class="bo-btn" id="boClearSelection"><i class="fas fa-times"></i> Clear</button>
            </div>
            <div class="bo-table-wrap">
              <table class="bo-table">
                <thead>
                  <tr>
                    <th data-sort="selected">&nbsp;</th>
                    <th data-sort="name">Customer</th>
                    <th data-sort="flag">Flag</th>
                    <th data-sort="activity">Activity</th>
                    <th data-sort="weekly">Reports / Wk</th>
                    <th data-sort="monthly">Monthly Usage</th>
                    <th data-sort="tier1">Option 1</th>
                    <th data-sort="tier2">Option 2</th>
                    <th data-sort="tier3">Option 3</th>
                    <th data-sort="history">History</th>
                    <th data-sort="status">Latest</th>
                    <th data-sort="viewed">Viewed</th>
                    <th data-sort="paid">Paid</th>
                  </tr>
                </thead>
                <tbody id="boCustomerRows"><tr><td colspan="13" class="bo-empty">Loading...</td></tr></tbody>
              </table>
            </div>
            <div class="bo-pager">
              <div class="bo-muted" id="boPagerText"></div>
              <div class="bo-pager-actions">
                <button class="bo-btn" data-page-step="-1"><i class="fas fa-chevron-left"></i></button>
                <button class="bo-btn" data-page-step="1"><i class="fas fa-chevron-right"></i></button>
              </div>
            </div>
          </div>
        </div>
        <div class="bo-card bo-pad bo-rollout-section">
          <div class="bo-rollout-section-head">
            <h3 style="margin:0;">Rollout History</h3>
            <span class="bo-muted">Cancel unviewed leaves already-viewed offers alone.</span>
          </div>
          <div class="bo-rollouts" id="boRollouts"></div>
        </div>
      </div>
    `;
    host.appendChild(view);

    if (!document.getElementById('boCustomerModal')) {
      const modal = document.createElement('div');
      modal.id = 'boCustomerModal';
      modal.className = 'bo-modal';
      modal.innerHTML = `
        <div class="bo-modal-card">
          <div class="bo-modal-head">
            <div>
              <div class="bo-modal-title" id="boCustomerModalTitle">Customer</div>
              <div class="bo-modal-sub" id="boCustomerModalSub"></div>
            </div>
            <button class="bo-modal-close" id="boCustomerModalClose" type="button">&times;</button>
          </div>
          <div class="bo-modal-body" id="boCustomerModalBody"></div>
        </div>
      `;
      document.body.appendChild(modal);
    }
    if (!document.getElementById('boRolloutModal')) {
      const modal = document.createElement('div');
      modal.id = 'boRolloutModal';
      modal.className = 'bo-modal';
      modal.innerHTML = `
        <div class="bo-modal-card">
          <div class="bo-modal-head">
            <div>
              <div class="bo-modal-title" id="boRolloutModalTitle">Rollout</div>
              <div class="bo-modal-sub" id="boRolloutModalSub"></div>
            </div>
            <button class="bo-modal-close" id="boRolloutModalClose" type="button">&times;</button>
          </div>
          <div class="bo-modal-body" id="boRolloutModalBody"></div>
        </div>
      `;
      document.body.appendChild(modal);
    }
  }

  function defaultTierSpecs(){
    return [
      { label:'2-month load', multiplier:1, match_percent:25 },
      { label:'4-month load', multiplier:2, match_percent:50 },
      { label:'8-month load', multiplier:4, match_percent:50 }
    ];
  }

  function renderTierEditor(){
    const host = document.getElementById('boTierEditor');
    if (!host) return;
    host.innerHTML = defaultTierSpecs().map((tier, index) => `
      <div class="bo-tier-row" data-tier-index="${index}">
        <div class="bo-field">
          <label>Option ${index + 1} label</label>
          <input data-tier-label value="${esc(tier.label)}">
        </div>
        <div class="bo-field">
          <label>Multiple</label>
          <input data-tier-multiplier type="number" min="0.1" step="0.1" value="${esc(tier.multiplier)}">
        </div>
        <div class="bo-field">
          <label>Bonus %</label>
          <input data-tier-match type="number" min="0" step="1" value="${esc(tier.match_percent)}">
        </div>
      </div>
    `).join('');
  }

  function tierAt(org, index){
    return org?.bonus_offer_preview?.tiers?.[index] || null;
  }

  function reportsPerWeek(org){
    if (isInactive(org)) return Number(org?.last_active_rolling7 ?? org?.lastActiveRolling7 ?? org?.rolling7 ?? 0) || 0;
    return Number(org?.rolling7 ?? org?.reports_last_7_days ?? org?.orders_last_7_days ?? org?.last7Orders ?? 0) || 0;
  }

  function avgReportsPerDay(org){
    if (isInactive(org)) return Number(org?.last_active_avg_orders_day ?? org?.lastActiveAvgOrdersDay ?? org?.avgOrdersDay ?? 0) || 0;
    return Number(org?.avgOrdersDay ?? org?.avg_reports_day ?? org?.reports_per_day_7d ?? 0) || 0;
  }

  function isInactive(org){
    return !!org?.inactive;
  }

  function daysSinceLastOrder(org){
    const value = Number(org?.days_since_last_order);
    return Number.isFinite(value) ? value : null;
  }

  function activityText(org){
    if (!isInactive(org)) return 'Active';
    const days = daysSinceLastOrder(org);
    if (days === null) return 'Never ordered';
    return `Inactive ${Math.round(days)}d`;
  }

  function activitySubtext(org){
    if (!isInactive(org)) return 'current';
    return daysSinceLastOrder(org) === null ? 'no order history' : 'last active window';
  }

  function latestStatus(org){
    return org?.bonus_offer_history?.[0]?.status || 'none';
  }

  function dateValue(value){
    const text = String(value || '').trim();
    if (!text) return 0;
    const parsed = Date.parse(text);
    return Number.isFinite(parsed) ? parsed : 0;
  }

  function formatDateTime(value){
    const ts = dateValue(value);
    if (!ts) return 'Not yet';
    return new Date(ts).toLocaleString([], { month:'short', day:'numeric', year:'numeric', hour:'numeric', minute:'2-digit' });
  }

  function latestViewedText(org){
    const latest = org?.bonus_offer_history?.[0] || null;
    if (!latest) return 'No offer';
    if (latest.viewed_at) return formatDateTime(latest.viewed_at);
    if (latest.status === 'scheduled') return 'Not started';
    return 'Not viewed';
  }

  function filteredCustomers(){
    const q = state.search.trim().toLowerCase();
    let rows = state.customers.filter((org) => {
      if (state.hideTests && org.is_test) return false;
      if (state.flagFilter === 'on' && !org.bonus_flag_enabled) return false;
      if (state.flagFilter === 'off' && org.bonus_flag_enabled) return false;
      if (state.activityFilter === 'active' && isInactive(org)) return false;
      if (state.activityFilter === 'inactive' && !isInactive(org)) return false;
      const status = latestStatus(org);
      if (state.statusFilter !== 'all' && status !== state.statusFilter) return false;
      if (!q) return true;
      return `${org.name || ''} ${org.id || ''} ${org.assigned_sales_name || ''} ${org.assigned_sales_email || ''}`.toLowerCase().includes(q);
    });
    rows = rows.sort((a, b) => {
      const av = sortValue(a, state.sortKey);
      const bv = sortValue(b, state.sortKey);
      const result = typeof av === 'number' && typeof bv === 'number'
        ? av - bv
        : String(av ?? '').localeCompare(String(bv ?? ''), undefined, { sensitivity:'base' });
      return state.sortDir === 'asc' ? result : -result;
    });
    return rows;
  }

  function pruneSelectedForActivityFilter(){
    if (state.activityFilter !== 'active') return;
    for (const org of state.customers) {
      if (isInactive(org)) state.selected.delete(org.id);
    }
  }

  function currentPageCustomers(){
    const rows = filteredCustomers();
    if (state.pageSize === 'all') return rows;
    const maxPage = Math.max(0, Math.ceil(rows.length / state.pageSize) - 1);
    if (state.page > maxPage) state.page = maxPage;
    const start = state.page * state.pageSize;
    return rows.slice(start, start + state.pageSize);
  }

  function sortValue(org, key){
    if (key === 'selected') return state.selected.has(org.id) ? 1 : 0;
    if (key === 'name') return org.name || '';
    if (key === 'flag') return org.bonus_flag_enabled ? 1 : 0;
    if (key === 'activity') return isInactive(org) ? (daysSinceLastOrder(org) || 99999) : 0;
    if (key === 'weekly') return reportsPerWeek(org);
    if (key === 'monthly') return Number(org.bonus_offer_preview?.basis?.monthly_credit_usage_estimate || 0);
    if (key === 'tier1') return Number(tierAt(org, 0)?.customer_pays || 0);
    if (key === 'tier2') return Number(tierAt(org, 1)?.customer_pays || 0);
    if (key === 'tier3') return Number(tierAt(org, 2)?.customer_pays || 0);
    if (key === 'history') return Number(org.bonus_offer_history?.length || 0);
    if (key === 'status') return latestStatus(org);
    if (key === 'viewed') return dateValue(org?.bonus_offer_history?.[0]?.viewed_at);
    if (key === 'paid') return Number(org.bonus_offer_total_paid || 0);
    return org.name || '';
  }

  function renderStats(){
    const host = document.getElementById('boStats');
    if (!host) return;
    const visible = filteredCustomers();
    const selectedRows = state.customers.filter((org) => state.selected.has(org.id));
    const flagOn = visible.filter((org) => org.bonus_flag_enabled).length;
    const inactive = visible.filter((org) => isInactive(org)).length;
    const claimed = visible.reduce((sum, org) => sum + Number(org.bonus_offer_claim_count || 0), 0);
    host.innerHTML = [
      ['Visible Customers', fmt.format(visible.length)],
      ['Selected', fmt.format(selectedRows.length)],
      ['Flag Enabled', fmt.format(flagOn)],
      ['Inactive', fmt.format(inactive)],
      ['Selected Max Bonus', money.format(selectedRows.reduce((sum, org) => sum + Number(tierAt(org, 2)?.bonus_dollars || 0), 0))]
    ].map(([label, value]) => `<div class="bo-stat"><span>${esc(label)}</span><strong>${esc(value)}</strong></div>`).join('');
  }

  function renderCustomers(){
    const tbody = document.getElementById('boCustomerRows');
    if (!tbody) return;
    const allRows = filteredCustomers();
    const rows = currentPageCustomers();
    if (!allRows.length) {
      tbody.innerHTML = '<tr><td colspan="13" class="bo-empty">No customers match the current filters.</td></tr>';
      renderStats();
      renderPager(allRows.length);
      return;
    }
    tbody.innerHTML = rows.map((org, index) => {
      const history = Array.isArray(org.bonus_offer_history) ? org.bonus_offer_history : [];
      const latest = history[0] || null;
      const t1 = tierAt(org, 0);
      const t2 = tierAt(org, 1);
      const t3 = tierAt(org, 2);
      return `
        <tr class="bo-customer-row ${state.selected.has(org.id) ? 'selected' : ''}" data-org-id="${esc(org.id)}" data-row-index="${esc(index)}" title="Open bonus offer history">
          <td class="bo-select-cell"><input class="bo-check" type="checkbox" data-select-org="${esc(org.id)}" ${state.selected.has(org.id) ? 'checked' : ''}></td>
          <td><div class="bo-org-name">${esc(org.name || org.id)}</div><div class="bo-muted">${esc(org.id || '')}</div></td>
          <td><span class="bo-pill ${org.bonus_flag_enabled ? 'on' : 'off'}">${org.bonus_flag_enabled ? 'On' : 'Off'}</span></td>
          <td><span class="bo-pill ${isInactive(org) ? 'inactive' : 'active'}">${esc(activityText(org))}</span><div class="bo-muted">${esc(activitySubtext(org))}</div></td>
          <td>${fmt.format(reportsPerWeek(org))}<div class="bo-muted">${fmt.format(avgReportsPerDay(org))}/day</div></td>
          <td>${money.format(Number(org.bonus_offer_preview?.basis?.monthly_credit_usage_estimate || 0))}<div class="bo-muted">${esc(org.bonus_offer_preview?.basis?.window || '')}</div></td>
          <td>${t1 ? `${money.format(Number(t1.customer_pays || 0))}<div class="bo-muted">+${money.format(Number(t1.bonus_dollars || 0))}</div>` : '<span class="bo-muted">No usage</span>'}</td>
          <td>${t2 ? `${money.format(Number(t2.customer_pays || 0))}<div class="bo-muted">+${money.format(Number(t2.bonus_dollars || 0))}</div>` : '<span class="bo-muted">No usage</span>'}</td>
          <td>${t3 ? `${money.format(Number(t3.customer_pays || 0))}<div class="bo-muted">+${money.format(Number(t3.bonus_dollars || 0))}</div>` : '<span class="bo-muted">No usage</span>'}</td>
          <td>${fmt.format(history.length)}<div class="bo-muted">${esc(org.bonus_offer_claim_count || 0)} claimed</div></td>
          <td><span class="bo-pill ${esc(latest?.status || 'none')}">${esc(latest?.status || 'none')}</span><div class="bo-muted">${esc(latest?.label || '')}</div></td>
          <td>${esc(latestViewedText(org))}</td>
          <td>${money.format(Number(org.bonus_offer_total_paid || 0))}<div class="bo-muted">bonus ${money.format(Number(org.bonus_offer_total_bonus || 0))}</div></td>
        </tr>
      `;
    }).join('');
    renderStats();
    renderPager(allRows.length);
  }

  function renderPager(totalRows = filteredCustomers().length){
    const text = document.getElementById('boPagerText');
    const prev = document.querySelector('[data-page-step="-1"]');
    const next = document.querySelector('[data-page-step="1"]');
    const all = state.pageSize === 'all';
    const totalPages = all ? 1 : Math.max(1, Math.ceil(totalRows / state.pageSize));
    if (state.page >= totalPages) state.page = totalPages - 1;
    const start = totalRows ? (all ? 1 : state.page * state.pageSize + 1) : 0;
    const end = all ? totalRows : Math.min(totalRows, (state.page + 1) * state.pageSize);
    if (text) text.textContent = `${fmt.format(start)}-${fmt.format(end)} of ${fmt.format(totalRows)} customers`;
    if (prev) prev.disabled = all || state.page <= 0;
    if (next) next.disabled = all || state.page >= totalPages - 1;
  }

  function rolloutSummary(rollout){
    const counts = rollout?.status_counts || {};
    const summary = rollout?.status_summary || {};
    const notViewedFallback = Number(counts.not_viewed || 0) + Number(counts.scheduled || 0) + Number(counts.available || 0) + Number(counts.assigned || 0);
    return {
      not_viewed: Number(summary.not_viewed ?? rollout?.not_viewed_count ?? notViewedFallback) || 0,
      viewed: Number(summary.viewed ?? rollout?.viewed_count ?? counts.viewed ?? 0) || 0,
      claimed: Number(summary.claimed ?? rollout?.claimed_count ?? counts.claimed ?? 0) || 0,
      expired: Number(summary.expired ?? rollout?.expired_count ?? counts.expired ?? 0) || 0,
      cancelled: Number(summary.cancelled ?? counts.cancelled ?? 0) || 0
    };
  }

  function renderRollouts(){
    const host = document.getElementById('boRollouts');
    if (!host) return;
    if (!state.rollouts.length) {
      host.innerHTML = '<div class="bo-empty">No rollouts have been launched yet.</div>';
      return;
    }
    host.innerHTML = state.rollouts.map((rollout) => {
      const summary = rolloutSummary(rollout);
      const unclaimed = summary.not_viewed + summary.viewed;
      const canCancel = !['cancelled','archived'].includes(String(rollout.status || '').toLowerCase());
      const pills = [
        ['Not viewed', summary.not_viewed, 'available'],
        ['Viewed', summary.viewed, 'viewed'],
        ['Claimed', summary.claimed, 'claimed'],
        ['Expired', summary.expired, 'expired'],
        ['Cancelled', summary.cancelled, 'cancelled']
      ].filter(([, value], index) => index < 4 || value > 0);
      return `
        <div class="bo-rollout" data-rollout-id="${esc(rollout.id)}" title="Open rollout details">
          <div class="bo-rollout-head">
            <div>
              <div class="bo-rollout-name">${esc(rollout.name || rollout.id)}</div>
              <div class="bo-muted">${esc(rollout.starts_at || '')} | ${fmt.format(rollout.assignment_count || 0)} orgs | ${fmt.format(rollout.window_hours || 0)}h window</div>
              <div class="bo-muted">Paid ${money.format(Number(rollout.total_paid_dollars || 0))} | bonus ${money.format(Number(rollout.total_bonus_dollars || 0))}</div>
            </div>
            <span class="bo-pill ${esc(rollout.status || '')}">${esc(rollout.status || '')}</span>
          </div>
          <div class="bo-rollout-meta">
            ${pills.map(([label, value, klass]) => `<span class="bo-pill ${esc(klass)}">${esc(label)} ${fmt.format(value)}</span>`).join('')}
          </div>
          ${canCancel ? `
            <div class="bo-rollout-actions">
              <button class="bo-btn" data-cancel-rollout="${esc(rollout.id)}" data-cancel-mode="unviewed" ${summary.not_viewed ? '' : 'disabled'}><i class="fas fa-eye-slash"></i> Cancel unviewed</button>
              <button class="bo-btn" data-cancel-rollout="${esc(rollout.id)}" data-cancel-mode="unclaimed" ${unclaimed ? '' : 'disabled'}><i class="fas fa-ban"></i> Cancel unclaimed</button>
            </div>
          ` : ''}
        </div>
      `;
    }).join('');
  }

  function customerById(orgId){
    return state.customers.find((org) => String(org.id || '') === String(orgId || '')) || null;
  }

  function rolloutById(rolloutId){
    return state.rollouts.find((rollout) => String(rollout.id || '') === String(rolloutId || '')) || null;
  }

  function detailStat(label, value){
    return `<div class="bo-detail-stat"><span>${esc(label)}</span><strong>${esc(value)}</strong></div>`;
  }

  function timeBox(label, value){
    return `<div class="bo-timebox"><span>${esc(label)}</span><strong>${esc(formatDateTime(value))}</strong></div>`;
  }

  function renderOfferTiers(offer){
    const tiers = Array.isArray(offer?.tiers) ? offer.tiers : [];
    if (!tiers.length) return '<div class="bo-muted">No tier details stored for this offer.</div>';
    return `
      <table class="bo-mini-table">
        <thead><tr><th>Option</th><th>Pay</th><th>Bonus</th><th>Total</th><th>Match</th></tr></thead>
        <tbody>
          ${tiers.map((tier) => `
            <tr>
              <td>${esc(tier.label || tier.id || '')}</td>
              <td>${money.format(Number(tier.customer_pays || 0))}</td>
              <td>${money.format(Number(tier.bonus_dollars || 0))}</td>
              <td>${money.format(Number(tier.total_account_value || 0))}</td>
              <td>${esc(Math.round(Number(tier.match_percent || 0)))}%</td>
            </tr>
          `).join('')}
        </tbody>
      </table>
    `;
  }

  function renderOfferHistoryCard(offer, index){
    const basis = offer?.basis || {};
    return `
      <div class="bo-history-card">
        <div class="bo-history-top">
          <div>
            <div class="bo-history-title">${esc(offer.label || `Offer ${index + 1}`)}</div>
            <div class="bo-muted">${esc(offer.id || '')}${offer.rollout_id ? ` | rollout ${esc(offer.rollout_id)}` : ''}</div>
          </div>
          <span class="bo-pill ${esc(offer.status || 'none')}">${esc(offer.status || 'none')}</span>
        </div>
        <div class="bo-timeline">
          ${timeBox('Created', offer.created_at)}
          ${timeBox('Starts', offer.starts_at)}
          ${timeBox('Viewed', offer.viewed_at)}
          ${timeBox('Expires', offer.expires_at)}
          ${timeBox('Claimed', offer.claimed_at)}
        </div>
        <div class="bo-detail-grid">
          ${detailStat('Paid', money.format(Number(offer.paid_dollars || 0)))}
          ${detailStat('Bonus', money.format(Number(offer.bonus_dollars || 0)))}
          ${detailStat('Total Credited', money.format(Number(offer.total_credited || 0)))}
          ${detailStat('Selected Tier', offer.selected_tier_id || 'None')}
        </div>
        <div class="bo-detail-grid">
          ${detailStat('Monthly Usage', money.format(Number(basis.monthly_credit_usage_estimate || 0)))}
          ${detailStat('Usage Window', basis.window || 'Unknown')}
          ${detailStat('Rounded Base', money.format(Number(basis.rounded_base_customer_pays || 0)))}
          ${detailStat('View Window', `${Number(offer.window_hours || 0) || 0}h`)}
        </div>
        ${renderOfferTiers(offer)}
      </div>
    `;
  }

  function rolloutAssignmentOffer(assignment){
    const org = customerById(assignment?.org_id);
    const history = Array.isArray(org?.bonus_offer_history) ? org.bonus_offer_history : [];
    return history.find((offer) => String(offer.id || '') === String(assignment?.instance_id || ''))
      || history.find((offer) => String(offer.rollout_id || '') === String(assignment?.rollout_id || state.activeRolloutId || ''))
      || null;
  }

  function rolloutAssignmentTiers(assignment, offer){
    if (Array.isArray(offer?.tiers) && offer.tiers.length) return offer.tiers;
    return Array.isArray(assignment?.tiers) ? assignment.tiers : [];
  }

  function rolloutOptionCell(tiers, index){
    const tier = tiers[index];
    if (!tier) return '<span class="bo-muted">No usage</span>';
    return `${money.format(Number(tier.customer_pays || 0))}<div class="bo-muted">+${money.format(Number(tier.bonus_dollars || 0))}</div>`;
  }

  function rolloutAssignmentRows(rollout){
    const query = state.rolloutSearch.trim().toLowerCase();
    return (Array.isArray(rollout?.assignments) ? rollout.assignments : []).map((assignment) => {
      const row = assignment || {};
      const org = customerById(row.org_id);
      const offer = rolloutAssignmentOffer(row);
      const status = offer?.status || row.status || 'assigned';
      return { assignment: row, org, offer, status };
    }).filter(({ assignment, org, offer, status }) => {
      if (!query) return true;
      return `${assignment.org_id || ''} ${assignment.org_name || ''} ${org?.name || ''} ${status || ''} ${offer?.label || ''}`.toLowerCase().includes(query);
    });
  }

  function renderRolloutDetailBody(){
    const rollout = rolloutById(state.activeRolloutId);
    const body = document.getElementById('boRolloutModalBody');
    const title = document.getElementById('boRolloutModalTitle');
    const sub = document.getElementById('boRolloutModalSub');
    if (!rollout || !body) return;
    const rows = rolloutAssignmentRows(rollout);
    const summary = rolloutSummary(rollout);
    if (title) title.textContent = rollout.name || rollout.id || 'Rollout';
    if (sub) sub.textContent = `${rollout.starts_at || ''} | ${fmt.format(rollout.assignment_count || rows.length)} orgs | ${fmt.format(rollout.window_hours || 0)}h window`;
    body.innerHTML = `
      <div class="bo-detail-grid">
        ${detailStat('Not Viewed', fmt.format(summary.not_viewed))}
        ${detailStat('Viewed', fmt.format(summary.viewed))}
        ${detailStat('Claimed', fmt.format(summary.claimed))}
        ${detailStat('Expired', fmt.format(summary.expired))}
        ${detailStat('Paid', money.format(Number(rollout.total_paid_dollars || 0)))}
        ${detailStat('Bonus', money.format(Number(rollout.total_bonus_dollars || 0)))}
        ${detailStat('Status', rollout.status || 'Unknown')}
        ${detailStat('Assignments', fmt.format(rollout.assignment_count || rows.length))}
      </div>
      <div class="bo-modal-toolbar">
        <div class="bo-field" style="min-width:260px;">
          <label>Search</label>
          <input id="boRolloutSearch" placeholder="Company, org id, status" value="${esc(state.rolloutSearch)}">
        </div>
        <div class="bo-muted">${fmt.format(rows.length)} matching customers</div>
      </div>
      <div class="bo-rollout-table-wrap">
        <table class="bo-mini-table">
          <thead>
            <tr>
              <th>Customer</th>
              <th>Status</th>
              <th>Viewed</th>
              <th>Paid</th>
              <th>Option 1</th>
              <th>Option 2</th>
              <th>Option 3</th>
              <th>Monthly Usage</th>
            </tr>
          </thead>
          <tbody>
            ${rows.length ? rows.map(({ assignment, org, offer, status }) => {
              const tiers = rolloutAssignmentTiers(assignment, offer);
              const basis = offer?.basis || assignment.basis || {};
              return `
                <tr data-rollout-org-id="${esc(assignment.org_id || '')}">
                  <td><div class="bo-org-name">${esc(org?.name || assignment.org_name || assignment.org_id || '')}</div><div class="bo-muted">${esc(assignment.org_id || '')}</div></td>
                  <td><span class="bo-pill ${esc(status)}">${esc(status)}</span></td>
                  <td>${esc(formatDateTime(offer?.viewed_at || assignment.viewed_at))}</td>
                  <td>${money.format(Number(offer?.paid_dollars || assignment.paid_dollars || 0))}<div class="bo-muted">bonus ${money.format(Number(offer?.bonus_dollars || assignment.bonus_dollars || 0))}</div></td>
                  <td>${rolloutOptionCell(tiers, 0)}</td>
                  <td>${rolloutOptionCell(tiers, 1)}</td>
                  <td>${rolloutOptionCell(tiers, 2)}</td>
                  <td>${money.format(Number(basis.monthly_credit_usage_estimate || 0))}<div class="bo-muted">${esc(basis.window || '')}</div></td>
                </tr>
              `;
            }).join('') : '<tr><td colspan="8" class="bo-empty">No customers match this rollout search.</td></tr>'}
          </tbody>
        </table>
      </div>
    `;
    document.getElementById('boRolloutSearch')?.addEventListener('input', (event) => {
      state.rolloutSearch = event.target.value || '';
      renderRolloutDetailBody();
      document.getElementById('boRolloutSearch')?.focus();
    });
  }

  function openRolloutDetail(rolloutId){
    const rollout = rolloutById(rolloutId);
    if (!rollout) return;
    state.activeRolloutId = rolloutId;
    state.rolloutSearch = '';
    renderRolloutDetailBody();
    document.getElementById('boRolloutModal')?.classList.add('active');
  }

  function closeRolloutDetail(){
    document.getElementById('boRolloutModal')?.classList.remove('active');
    state.activeRolloutId = '';
    state.rolloutSearch = '';
  }

  function openCustomerDetail(orgId){
    const org = customerById(orgId);
    if (!org) return;
    const modal = document.getElementById('boCustomerModal');
    const title = document.getElementById('boCustomerModalTitle');
    const sub = document.getElementById('boCustomerModalSub');
    const body = document.getElementById('boCustomerModalBody');
    const history = Array.isArray(org.bonus_offer_history) ? org.bonus_offer_history : [];
    const latest = history[0] || null;
    if (title) title.textContent = org.name || org.id || 'Customer';
    if (sub) sub.textContent = `${org.id || ''} | ${activityText(org)} | Bonus flag ${org.bonus_flag_enabled ? 'on' : 'off'} | Latest viewed: ${latestViewedText(org)}`;
    if (body) {
      body.innerHTML = `
        <div class="bo-detail-grid">
          ${detailStat('Feature Flag', org.bonus_flag_enabled ? 'On' : 'Off')}
          ${detailStat('Activity', activityText(org))}
          ${detailStat('Latest Status', latest?.status || 'No offer')}
          ${detailStat('Latest Viewed', latestViewedText(org))}
          ${detailStat('History Count', fmt.format(history.length))}
          ${detailStat('Total Paid', money.format(Number(org.bonus_offer_total_paid || 0)))}
          ${detailStat('Total Bonus', money.format(Number(org.bonus_offer_total_bonus || 0)))}
          ${detailStat('Claims', fmt.format(Number(org.bonus_offer_claim_count || 0)))}
          ${detailStat('Monthly Usage', money.format(Number(org.bonus_offer_preview?.basis?.monthly_credit_usage_estimate || 0)))}
        </div>
        <div class="bo-history-list">
          ${history.length ? history.map(renderOfferHistoryCard).join('') : '<div class="bo-empty">No bonus offer history for this customer yet.</div>'}
        </div>
      `;
    }
    modal?.classList.add('active');
  }

  function closeCustomerDetail(){
    document.getElementById('boCustomerModal')?.classList.remove('active');
  }

  function renderAll(){
    renderCustomers();
    renderRollouts();
  }

  function syncLayoutHeight(){
    const view = document.getElementById('view-bonus-offers');
    if (!view || view.style.display === 'none') return;
    const top = Math.max(0, view.getBoundingClientRect().top);
    view.style.height = `${Math.max(560, window.innerHeight - top - 8)}px`;
  }

  function syncSelectionDom(){
    document.querySelectorAll('#boCustomerRows tr[data-org-id]').forEach((row) => {
      const orgId = row.getAttribute('data-org-id');
      const selected = state.selected.has(orgId);
      row.classList.toggle('selected', selected);
      const checkbox = row.querySelector('[data-select-org]');
      if (checkbox) checkbox.checked = selected;
    });
    renderStats();
  }

  function visibleCustomerIndex(orgId){
    return currentPageCustomers().findIndex((org) => String(org.id || '') === String(orgId || ''));
  }

  function setRangeSelection(fromIndex, toIndex, selected){
    const rows = currentPageCustomers();
    const start = Math.max(0, Math.min(Number(fromIndex), Number(toIndex)));
    const end = Math.min(rows.length - 1, Math.max(Number(fromIndex), Number(toIndex)));
    if (!Number.isFinite(start) || !Number.isFinite(end) || start < 0 || end < 0) return;
    for (let index = start; index <= end; index += 1) {
      const id = rows[index]?.id;
      if (!id) continue;
      if (selected) state.selected.add(id);
      else state.selected.delete(id);
    }
  }

  function selectCustomerAt(orgId, options = {}){
    const index = visibleCustomerIndex(orgId);
    if (index < 0) return;
    const selected = options.force ?? !state.selected.has(orgId);
    if (options.range && state.lastSelectedIndex !== null) setRangeSelection(state.lastSelectedIndex, index, selected);
    else if (selected) state.selected.add(orgId);
    else state.selected.delete(orgId);
    state.lastSelectedIndex = index;
    renderCustomers();
  }

  function beginDragSelect(target, event){
    if (event.shiftKey) return;
    const row = target.closest?.('tr[data-org-id]');
    if (!row) return;
    const orgId = row.getAttribute('data-org-id');
    const index = visibleCustomerIndex(orgId);
    if (index < 0) return;
    event.preventDefault();
    state.suppressNextClick = true;
    state.dragSelecting = true;
    state.dragSelectValue = !state.selected.has(orgId);
    state.dragAnchorIndex = index;
    state.lastSelectedIndex = index;
    setRangeSelection(index, index, state.dragSelectValue);
    document.querySelector('.bo-table')?.classList.add('selecting');
    syncSelectionDom();
  }

  function continueDragSelect(target){
    if (!state.dragSelecting) return;
    const row = target.closest?.('tr[data-org-id]');
    if (!row) return;
    const orgId = row.getAttribute('data-org-id');
    const index = visibleCustomerIndex(orgId);
    if (index < 0 || state.dragAnchorIndex === null) return;
    setRangeSelection(state.dragAnchorIndex, index, state.dragSelectValue);
    state.lastSelectedIndex = index;
    syncSelectionDom();
  }

  function endDragSelect(){
    if (!state.dragSelecting) return;
    state.dragSelecting = false;
    state.dragAnchorIndex = null;
    document.querySelector('.bo-table')?.classList.remove('selecting');
    renderStats();
  }

  async function load(){
    state.loading = true;
    const tbody = document.getElementById('boCustomerRows');
    if (tbody) tbody.innerHTML = '<tr><td colspan="13" class="bo-empty"><i class="fas fa-spinner fa-spin"></i> Loading bonus offer customers...</td></tr>';
    try {
      const data = await request('');
      state.customers = Array.isArray(data.customers) ? data.customers : [];
      state.rollouts = Array.isArray(data.rollouts) ? data.rollouts : [];
      const valid = new Set(state.customers.map((org) => org.id));
      for (const id of [...state.selected]) if (!valid.has(id)) state.selected.delete(id);
      state.loaded = true;
      renderAll();
    } catch (error) {
      if (tbody) tbody.innerHTML = `<tr><td colspan="13" class="bo-empty">${esc(error.message || 'Could not load bonus offers.')}</td></tr>`;
    } finally {
      state.loading = false;
    }
  }

  function collectLaunchPayload(){
    const baseMonths = Number(document.getElementById('boBaseMonths')?.value || 2) || 2;
    const tiers = Array.from(document.querySelectorAll('#boTierEditor [data-tier-index]')).map((row, index) => {
      const multiplier = Number(row.querySelector('[data-tier-multiplier]')?.value || (index === 0 ? 1 : index === 1 ? 2 : 4)) || 1;
      const months = Math.round(baseMonths * multiplier * 10) / 10;
      return {
        id: `tier_${index + 1}`,
        label: row.querySelector('[data-tier-label]')?.value || `${months}-month load`,
        multiplier,
        months,
        match_percent: Number(row.querySelector('[data-tier-match]')?.value || (index === 0 ? 25 : 50)) || 0
      };
    });
    const startsInput = document.getElementById('boStartsAt')?.value || '';
    const startsAt = startsInput ? new Date(startsInput).toISOString() : '';
    const selectedOrgIds = state.customers
      .filter((org) => state.selected.has(org.id))
      .filter((org) => state.activityFilter !== 'active' || !isInactive(org))
      .map((org) => org.id);
    return {
      actor: window.Portal.internalActor ? window.Portal.internalActor() : {},
      org_ids: selectedOrgIds,
      label: document.getElementById('boOfferName')?.value || 'Credit usage bonus offer',
      starts_at: startsAt,
      window_hours: Number(document.getElementById('boWindowHours')?.value || 24) || 24,
      base_months: baseMonths,
      cancel_existing: !!document.getElementById('boCancelExisting')?.checked,
      cancel_existing_scope: document.getElementById('boCancelUnviewedOnly')?.checked ? 'unviewed' : 'unclaimed',
      cancel_unviewed_only: !!document.getElementById('boCancelUnviewedOnly')?.checked,
      tiers
    };
  }

  async function launch(){
    const status = document.getElementById('boLaunchStatus');
    const payload = collectLaunchPayload();
    if (!payload.org_ids.length) {
      if (status) status.textContent = 'Select at least one organization first.';
      return;
    }
    if (!confirm(`Launch this bonus offer to ${payload.org_ids.length} organization(s)?`)) return;
    if (status) status.textContent = 'Launching...';
    try {
      const data = await request('/rollouts', {
        method:'POST',
        headers:{ 'Accept':'application/json', 'Content-Type':'application/json' },
        body: JSON.stringify(payload)
      });
      const skipped = Array.isArray(data.skipped) ? data.skipped.length : 0;
      if (status) status.textContent = `Launched ${data.assignments?.length || 0} assignments${skipped ? `, skipped ${skipped}` : ''}.`;
      state.selected.clear();
      await load();
    } catch (error) {
      if (status) status.textContent = error.message || 'Launch failed.';
    }
  }

  async function cancelRollout(id, mode = 'unclaimed'){
    const scope = mode === 'unviewed' ? 'unviewed' : 'unclaimed';
    const label = scope === 'unviewed' ? 'offers that have not been viewed' : 'unclaimed offers';
    if (!id || !confirm(`Cancel ${label} from this rollout?`)) return;
    await request(`/rollouts/${encodeURIComponent(id)}/cancel`, {
      method:'POST',
      headers:{ 'Accept':'application/json', 'Content-Type':'application/json' },
      body: JSON.stringify({ actor: window.Portal.internalActor ? window.Portal.internalActor() : {}, cancel_scope: scope })
    });
    await load();
  }

  function syncCancelExistingOptions(){
    const main = document.getElementById('boCancelExisting');
    const nested = document.getElementById('boCancelUnviewedOnly');
    const wrap = document.getElementById('boCancelUnviewedOnlyWrap');
    const enabled = !!main?.checked;
    if (nested) nested.disabled = !enabled;
    wrap?.classList.toggle('disabled', !enabled);
  }

  function wire(){
    renderTierEditor();
    document.getElementById('boRefresh')?.addEventListener('click', load);
    document.getElementById('boLaunch')?.addEventListener('click', launch);
    document.getElementById('boCancelExisting')?.addEventListener('change', syncCancelExistingOptions);
    syncCancelExistingOptions();
    document.getElementById('boSearch')?.addEventListener('input', (e) => { state.search = e.target.value || ''; state.page = 0; renderCustomers(); });
    document.getElementById('boFlagFilter')?.addEventListener('change', (e) => { state.flagFilter = e.target.value || 'all'; state.page = 0; renderCustomers(); });
    document.getElementById('boActivityFilter')?.addEventListener('change', (e) => { state.activityFilter = e.target.value || 'active'; pruneSelectedForActivityFilter(); state.page = 0; renderCustomers(); });
    document.getElementById('boStatusFilter')?.addEventListener('change', (e) => { state.statusFilter = e.target.value || 'all'; state.page = 0; renderCustomers(); });
    document.getElementById('boHideTests')?.addEventListener('change', (e) => { state.hideTests = !!e.target.checked; state.page = 0; renderCustomers(); });
    document.getElementById('boPageSize')?.addEventListener('change', (e) => {
      const value = e.target.value || '100';
      state.pageSize = value === 'all' ? 'all' : Math.max(1, Number(value) || 100);
      state.page = 0;
      renderCustomers();
      syncLayoutHeight();
    });
    document.getElementById('boSelectFiltered')?.addEventListener('click', () => {
      state.selected = new Set(filteredCustomers().map((org) => org.id));
      renderCustomers();
    });
    document.getElementById('boClearSelection')?.addEventListener('click', () => { state.selected.clear(); renderCustomers(); });
    document.getElementById('boCustomerModalClose')?.addEventListener('click', closeCustomerDetail);
    document.getElementById('boRolloutModalClose')?.addEventListener('click', closeRolloutDetail);
    document.getElementById('boCustomerModal')?.addEventListener('mousedown', (e) => { e.currentTarget.__downBackdrop = e.target === e.currentTarget; });
    document.getElementById('boCustomerModal')?.addEventListener('mouseup', (e) => {
      if (e.currentTarget.__downBackdrop && e.target === e.currentTarget) closeCustomerDetail();
      e.currentTarget.__downBackdrop = false;
    });
    document.getElementById('boRolloutModal')?.addEventListener('mousedown', (e) => { e.currentTarget.__downBackdrop = e.target === e.currentTarget; });
    document.getElementById('boRolloutModal')?.addEventListener('mouseup', (e) => {
      if (e.currentTarget.__downBackdrop && e.target === e.currentTarget) closeRolloutDetail();
      e.currentTarget.__downBackdrop = false;
    });
    document.getElementById('view-bonus-offers')?.addEventListener('click', (e) => {
      const target = e.target;
      if (state.suppressNextClick) {
        state.suppressNextClick = false;
        e.preventDefault();
        return;
      }
      const checkbox = target.closest?.('[data-select-org]');
      if (checkbox) {
        e.preventDefault();
        selectCustomerAt(checkbox.getAttribute('data-select-org'), { range: e.shiftKey });
        return;
      }
      const cancel = target.closest?.('[data-cancel-rollout]');
      if (cancel) {
        cancelRollout(cancel.getAttribute('data-cancel-rollout'), cancel.getAttribute('data-cancel-mode'));
        return;
      }
      const rollout = target.closest?.('[data-rollout-id]');
      if (rollout) {
        openRolloutDetail(rollout.getAttribute('data-rollout-id'));
        return;
      }
      const pageStep = target.closest?.('[data-page-step]');
      if (pageStep) {
        state.page = Math.max(0, state.page + Number(pageStep.getAttribute('data-page-step') || 0));
        renderCustomers();
        return;
      }
      const sort = target.closest?.('th[data-sort]');
      if (sort) {
        const key = sort.getAttribute('data-sort');
        if (state.sortKey === key) state.sortDir = state.sortDir === 'asc' ? 'desc' : 'asc';
        else { state.sortKey = key; state.sortDir = 'desc'; }
        state.page = 0;
        renderCustomers();
        return;
      }
      if (target.closest?.('input,button,a,select,label')) return;
      const row = target.closest?.('tr[data-org-id]');
      if (row) openCustomerDetail(row.getAttribute('data-org-id'));
    });
    document.getElementById('view-bonus-offers')?.addEventListener('mousedown', (e) => {
      const target = e.target;
      if (!target.closest?.('.bo-select-cell')) return;
      if (target.closest?.('[data-select-org]')) return;
      beginDragSelect(target, e);
    });
    document.getElementById('view-bonus-offers')?.addEventListener('mouseover', (e) => {
      if (!state.dragSelecting) return;
      continueDragSelect(e.target);
    });
    document.addEventListener('mouseup', endDragSelect);
  }

  const BonusOffers = {
    init(){
      if (!canAccess()) return;
      ensureStyles();
      ensureMarkup();
      window.Portal.registerPlugin({ id:'bonus-offers', title:'Bonus Offer', iconClass:'fas fa-gift' });
      wire();
      window.BonusOffers = this;
    },
    async onShow(){
      const view = document.getElementById('view-bonus-offers');
      if (view) view.style.display = 'flex';
      syncLayoutHeight();
      if (!state.loaded && !state.loading) await load();
      else renderAll();
      syncLayoutHeight();
    },
    reload: load
  };

  const origSwitch = window.Portal.switchView ? window.Portal.switchView.bind(window.Portal) : null;
  if (origSwitch) {
    window.Portal.switchView = async function(id, btn){
      await origSwitch(id, btn);
      if (id === 'bonus-offers') await BonusOffers.onShow();
    };
  }

  window.addEventListener('resize', syncLayoutHeight);

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', () => BonusOffers.init());
  else BonusOffers.init();
})();
