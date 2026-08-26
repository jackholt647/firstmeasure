(function(){
  if (!window.Portal) return;

  const cfg = () => window.Portal.cfg || window.PORTAL_CFG || {};
  const esc = (value) => window.Portal.escapeHtml(String(value ?? ''));
  const state = {
    targetEmail: 'mine',
    leaderboardRange: 'today',
    pipelineTab: 'hot',
    data: null,
    loading: false,
    loadedOnce: false,
    activeView: 'home',
    refreshTimer: null,
    lastLoadedAt: 0
  };
  const DASHBOARD_REFRESH_MS = 300000;
  const DASHBOARD_FOREGROUND_REFRESH_MS = 120000;

  function caps(){
    return cfg().capabilities || {};
  }

  function canManage(){
    return !!caps().view_all_callers_list_progress || !!caps().manage_sales_users;
  }

  function isDashboardVisible(){
    const view = document.getElementById('view-home');
    if (!view || document.hidden) return false;
    return getComputedStyle(view).display !== 'none';
  }

  function api(data){
    return fetch(cfg().endpoints?.server || window.Portal.internalLegacyEndpoint(), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(data || {})
    }).then(async (res) => {
      const raw = await res.text();
      try {
        return JSON.parse(raw);
      } catch (err) {
        const snippet = String(raw || '')
          .replace(/\s+/g, ' ')
          .trim()
          .slice(0, 800);
        throw new Error(`Dashboard API returned non-JSON. HTTP ${res.status}. Response: ${snippet || '(empty response)'}`);
      }
    });
  }

  function ensureStyles(){
    if (document.getElementById('crmDashboardStyles')) return;
    const style = document.createElement('style');
    style.id = 'crmDashboardStyles';
    style.textContent = `
      #view-home{height:100%;min-height:0;overflow:hidden}
      #dashboardRoot{height:100%;min-height:0;overflow:hidden}
      .crm-dashboard{display:grid;gap:20px;min-height:0;height:100%;box-sizing:border-box;overflow:hidden;color:#1a1f2e;align-content:start;padding:0 0 8px}
      .crm-dash-head-copy{display:grid;gap:2px}
      .crm-dash-head,.crm-pipeline-head{display:flex;justify-content:space-between;align-items:center;gap:14px;flex-wrap:wrap}
      .crm-dash-head h1,.crm-pipeline-head h1{margin:0;font-size:22px;line-height:1.05;color:#1a1f2e;font-weight:900;letter-spacing:-.02em}
      .crm-dash-sub{margin-top:4px;font-size:12px;color:#8b95a8;font-weight:600}
      .crm-dash-greeting{font-size:15px;color:#6b7588;font-weight:600}
      .crm-dash-actions{display:flex;gap:10px;align-items:center;flex-wrap:wrap}
      .crm-dash-select,.crm-dash-input,.crm-dash-btn{font:inherit}
      .crm-dash-select,.crm-dash-input{padding:8px 10px;border:1px solid #d4dae6;border-radius:10px;background:#fff;color:#1a1f2e;box-sizing:border-box;min-width:0;max-width:100%;font-size:13px}
      .crm-dash-btn{border:1px solid #d4dae6;border-radius:10px;background:#fff;color:#6b7588;padding:8px 11px;font-weight:800;cursor:pointer;font-size:12px}
      .crm-dash-btn.primary{background:#d93025;border-color:#d93025;color:#fff}
      .crm-dash-btn:hover{background:#f6f8fb;border-color:#cbd5e1;color:#1a1f2e}
      .crm-dash-btn.primary:hover{background:#b42318;border-color:#b42318;color:#fff}
      .crm-dash-btn.active{background:#1f2937;border-color:#1f2937;color:#fff}
      .crm-dash-btn:disabled{opacity:.55;cursor:default}
      .crm-dash-grid-3{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:16px}
      .crm-dash-grid-2{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:16px;margin-top:-6px}
      .crm-card{background:#fff;border:1px solid #d4dae6;border-radius:14px;overflow:hidden;min-height:0}
      .crm-card-head{display:flex;justify-content:space-between;align-items:center;gap:12px;padding:12px 16px;background:#f6f8fb;border-bottom:1px solid #edf0f5}
      .crm-card-head h2{margin:0;font-size:11px;font-weight:900;letter-spacing:.05em;text-transform:uppercase;color:#6b7588}
      .crm-card-head.meetings{background:#f6f8fb}
      .crm-card-head.unread{background:#f6f8fb}
      .crm-card-head.tasks{background:#f6f8fb}
      .crm-card-head.morning{background:#e8f0fe}
      .crm-card-head.afternoon{background:#fef3e0}
      .crm-card-head.other{background:#f6f8fb}
      .crm-card-head.morning h2{color:#1a6bd9}
      .crm-card-head.afternoon h2{color:#c4700a}
      .crm-card-head.other h2{color:#6b7588}
      .crm-card-count{padding:2px 8px;border-radius:999px;background:#edf0f5;color:#1a1f2e;font-size:13px;font-weight:900}
      .crm-card-count.alert{background:#fce8e6;color:#d93025}
      .crm-card-body{display:grid;gap:0;max-height:420px;overflow:auto;padding:0}
      .crm-list-row{display:flex;align-items:center;gap:12px;padding:10px 16px;cursor:pointer;background:#fff;border:none;border-radius:0;width:100%;text-align:left;appearance:none;-webkit-appearance:none;box-shadow:none;border-bottom:1px solid #edf0f5}
      .crm-list-row:last-child{border-bottom:none}
      .crm-list-row:hover{background:#f6f8fb}
      .crm-list-row.overdue{background:#fff}
      .crm-list-icon{width:30px;height:30px;border-radius:50%;display:flex;align-items:center;justify-content:center;flex:0 0 30px;font-size:12px;background:#f3e8ff;color:#7c3aed}
      .crm-list-icon.meeting{background:#e8f0fe;color:#1a6bd9}
      .crm-list-icon.warn{background:#fce8e6;color:#d93025}
      .crm-list-icon.msg{background:#e6f4ec;color:#1a8a4a}
      .crm-list-icon.email{background:#fef3e0;color:#c4700a}
      .crm-list-meta{min-width:0;flex:1}
      .crm-list-title{font-size:13px;font-weight:700;color:#252b3b;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
      .crm-list-title.strong{font-weight:800}
      .crm-list-sub{font-size:11px;color:#8b95a8;margin-top:1px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
      .crm-list-time{font-size:12px;font-weight:700;color:#1a6bd9;text-align:right;white-space:nowrap}
      .crm-list-time.hot{color:#1a8a4a}
      .crm-list-time.cold,.crm-list-time.overdue{color:#d93025}
      .crm-empty{padding:28px 16px;text-align:center;color:#98a2b3;font-size:13px;font-style:italic}
      .crm-divider{padding:8px 16px;background:#fce8e6;color:#d93025;font-size:10px;font-weight:900;text-transform:uppercase;letter-spacing:.05em}
      .crm-divider.soft{background:#f6f8fb;color:#6b7588;border-top:1px solid #d4dae6}
      .crm-leaderboard{background:#fff;border:1px solid #d4dae6;border-radius:14px;overflow:hidden;min-height:0}
      .crm-leaderboard-head,.crm-pipeline-shell-head{display:flex;justify-content:space-between;align-items:center;gap:12px;flex-wrap:wrap;padding:14px 20px;background:#f6f8fb;border-bottom:1px solid #edf0f5}
      .crm-leaderboard-head h2,.crm-pipeline-shell-head h2{margin:0;font-size:16px;color:#1a1f2e;font-weight:900;letter-spacing:-.02em}
      .crm-toggle-group{display:inline-flex;border:1px solid #d4dae6;border-radius:6px;overflow:hidden;background:#fff}
      .crm-toggle-group button{border:none;background:#fff;padding:7px 16px;font-size:12px;font-weight:700;color:#6b7588;cursor:pointer}
      .crm-toggle-group button.active{background:#1a1f2e;color:#fff}
      .crm-updated{font-size:10px;color:#8b95a8;font-weight:600}
      .crm-table-wrap{overflow:auto}
      .crm-leaderboard-table-wrap{max-height:442px;overflow:auto}
      .crm-leaderboard-table-wrap thead th{position:sticky;top:0;z-index:1}
      .crm-table{width:100%;border-collapse:collapse}
      .crm-table th,.crm-table td{padding:10px 14px;border-bottom:1px solid #edf0f5;text-align:left;font-size:13px}
      .crm-table th{font-size:10px;letter-spacing:.04em;text-transform:uppercase;color:#8b95a8;background:#fff;white-space:nowrap}
      .crm-table td.num,.crm-table th.num{text-align:right}
      .crm-table tr:hover td{background:#f6f8fb}
      .crm-table tr.me td{background:#fef8f0}
      .crm-rank{width:28px;height:28px;border-radius:50%;display:flex;align-items:center;justify-content:center;background:#f6f8fb;color:#8b95a8;font-size:12px;font-weight:900}
      .crm-rank.top{background:#fef3c7;color:#a16207}
      .crm-person{display:flex;align-items:center;gap:10px}
      .crm-avatar{width:34px;height:34px;border-radius:50%;display:flex;align-items:center;justify-content:center;background:#d93025;color:#fff;font-weight:900;font-size:12px}
      .crm-you{display:inline-flex;align-items:center;padding:1px 5px;border-radius:3px;background:#fce8e6;color:#d93025;font-size:10px;font-weight:800;text-transform:uppercase;margin-left:6px}
      .crm-money{color:#1a8a4a;font-weight:800}
      .crm-pipeline{background:#fff;border:1px solid #d4dae6;border-radius:14px;overflow:hidden;min-height:0}
      .crm-pipeline-row{display:flex;align-items:center;gap:12px;padding:10px 20px;cursor:pointer;width:100%;text-align:left;background:#fff;border:none;border-bottom:1px solid #edf0f5}
      .crm-pipeline-row:last-child{border-bottom:none}
      .crm-pipeline-row:hover{background:#f6f8fb}
      .crm-pipeline-company{min-width:0;flex:1;font-weight:700;color:#1a1f2e;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
      .crm-stage-pill{padding:2px 6px;border-radius:3px;background:#e8f0fe;color:#1a6bd9;font-size:10px;font-weight:800;letter-spacing:.04em;text-transform:uppercase}
      .crm-stage-pill.recv{background:#f3e8ff;color:#7c3aed}
      .crm-stage-pill.signup{background:#ecfdf3;color:#1a8a4a}
      .crm-task-form{display:grid;grid-template-columns:minmax(0,1fr) minmax(148px,.72fr);gap:8px;padding:10px 14px;border-bottom:1px solid #edf0f5;background:#fff;align-items:center}
      .crm-task-form > *{min-width:0;max-width:100%;box-sizing:border-box}
      .crm-task-form .crm-dash-input,.crm-task-form .crm-dash-select{width:100%;min-width:0;max-width:100%}
      .crm-task-form .crm-dash-btn.primary{white-space:nowrap;align-self:stretch;min-width:0;width:100%}
      .crm-task-form .task-title{grid-column:1}
      .crm-task-form .task-due{grid-column:2}
      .crm-task-form .assignee{grid-column:1}
      .crm-task-form .task-submit{grid-column:2}
      .crm-task-check{width:18px;height:18px;accent-color:#15803d;cursor:pointer}
      .crm-task-row.done .crm-list-title{text-decoration:line-through;color:#98a2b3}
      .crm-task-row .crm-dash-btn{padding:7px 10px;border-radius:10px;font-size:11px}
      .crm-dash-btn.refreshing{background:#d93025;border-color:#d93025;color:#fff;box-shadow:0 0 0 3px rgba(217,48,37,.16)}
      .crm-pipeline-shell{display:grid;gap:16px;min-height:0}
      .crm-pipeline-board{background:#fff;border:1px solid #d4dae6;border-radius:14px;overflow:hidden}
      .crm-loading{padding:42px 18px;text-align:center;color:#6b7280;font-weight:800}
      .crm-refresh-note{font-size:12px;color:#98a2b3;font-weight:700}
      .crm-refresh-note.live{min-width:92px;text-align:right;color:#667085}
      .crm-refresh-note.inline{min-width:0;text-align:left}
      .crm-leaderboard-sub{font-size:10px;color:#8b95a8;font-weight:600;margin-top:2px}
      .crm-followups-extra{display:grid;gap:16px;min-height:0}
      .crm-followups-grid{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:16px}
      .crm-followup-card .crm-card-body{max-height:280px}
      .crm-card-head-row{display:flex;align-items:center;gap:8px}
      .crm-loading-shell{display:grid;gap:20px;min-height:0}
      .crm-skeleton{position:relative;overflow:hidden;background:#edf0f5}
      .crm-skeleton::after{content:'';position:absolute;inset:0;transform:translateX(-100%);background:linear-gradient(90deg,transparent,rgba(255,255,255,.65),transparent);animation:crmDashShimmer 1.3s infinite}
      .crm-skeleton-line{height:12px;border-radius:999px}
      .crm-skeleton-line.sm{height:10px;width:34%}
      .crm-skeleton-line.md{width:58%}
      .crm-skeleton-line.lg{width:82%}
      .crm-skeleton-line.full{width:100%}
      .crm-skeleton-chip{height:24px;width:58px;border-radius:999px}
      .crm-skeleton-card-body{display:grid;gap:12px;padding:14px 16px}
      .crm-skeleton-row{display:grid;gap:8px}
      .crm-skeleton-header{display:flex;justify-content:space-between;align-items:center;gap:12px}
      .crm-skeleton-head-copy{display:grid;gap:8px}
      .crm-card-loading{display:inline-flex;align-items:center;gap:6px;font-size:11px;color:#8b95a8;font-weight:800}
      @keyframes crmDashShimmer{100%{transform:translateX(100%)}}
      @media (max-width: 1180px){.crm-dash-grid-3{grid-template-columns:1fr}.crm-dash-grid-2{grid-template-columns:1fr}.crm-followups-grid{grid-template-columns:1fr}}
      @media (max-width: 760px){.crm-task-form{grid-template-columns:1fr}.crm-task-form .task-title,.crm-task-form .task-due,.crm-task-form .assignee,.crm-task-form .task-submit{grid-column:1}.crm-task-form .crm-dash-btn.primary{width:100%}}
    `;
    document.head.appendChild(style);
  }

  function ensureMarkup(){
    const home = document.getElementById('dashboardRoot');
    const pipeline = document.getElementById('pipelineRoot');
    if (home && !home.innerHTML.trim()) home.innerHTML = '<div class="crm-loading">Loading dashboard...</div>';
    if (pipeline && !pipeline.innerHTML.trim()) pipeline.innerHTML = '<div class="crm-loading">Loading pipeline...</div>';
  }

  function ensureDefaultTarget(){
    if (canManage() && state.targetEmail === 'mine') state.targetEmail = '__all__';
  }

  function todayLabel(today){
    if (!today || !today.label) return '';
    return today.label;
  }

  function dashboardGreeting(){
    const hour = new Date().getHours();
    if (hour < 12) return 'Good morning';
    if (hour < 18) return 'Good afternoon';
    return 'Good evening';
  }

  function dashboardGreetingName(){
    const name = String(cfg().user?.name || '').trim();
    return name ? name.split(/\s+/)[0] : 'there';
  }

  function fmtTime(ts){
    const n = Number(ts || 0);
    if (!n) return '';
    return new Date(n * 1000).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  }

  function fmtDateTime(ts){
    const n = Number(ts || 0);
    if (!n) return '';
    return new Date(n * 1000).toLocaleString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
  }

  function daysLabel(days){
    const n = Number(days || 0);
    if (n <= 0) return 'Today';
    if (n === 1) return '1d ago';
    return `${n}d ago`;
  }

  function leadStagePillClass(stage){
    const raw = String(stage || '').toLowerCase();
    if (raw === 'info_received') return 'recv';
    if (raw === 'signed_up') return 'signup';
    return 'sent';
  }

  function getSalesUsers(){
    return Array.isArray(state.data?.sales_users) ? state.data.sales_users : [];
  }

  async function openLead(leadId){
    const id = String(leadId || '').trim();
    if (!id) return;
    const sourceView = state.activeView === 'pipeline' ? 'pipeline' : 'home';
    const sourceNavId = sourceView === 'pipeline' ? 'nav-pipeline' : 'nav-home';
    if (window.LeadWorkspace && typeof window.LeadWorkspace.openLead === 'function') {
      await window.LeadWorkspace.openLead(id, { sourceView, sourceNavId });
      return;
    }
    if (window.Leads && typeof window.Leads.queueOpenLead === 'function') {
      window.Leads.queueOpenLead(id, { sourceView, sourceNavId });
    }
    const btn = document.getElementById('nav-leads');
    await window.Portal.switchView('leads', btn);
    if ((!window.Leads || typeof window.Leads.queueOpenLead !== 'function') && window.Leads && typeof window.Leads.openLeadById === 'function') {
      await window.Leads.openLeadById(id, { sourceView, sourceNavId });
    }
  }

  function dashboardPayloadBody(){
    ensureDefaultTarget();
    return {
      action: 'lead_dashboard',
      target_email: state.targetEmail,
      leaderboard_range: state.leaderboardRange,
      viewer_timezone: Intl.DateTimeFormat().resolvedOptions().timeZone || ''
    };
  }

  async function loadDashboard(options = {}){
    const silent = !!options.silent && state.loadedOnce;
    const announce = !!options.announce;
    if (state.loading) return;
    state.loading = true;
    if (announce && window.showToast) window.showToast('Refreshing dashboard...');
    if (!silent) renderActiveView();
    try {
      const data = await api(dashboardPayloadBody());
      if (!data || !data.success) throw new Error(data?.error || 'Could not load the dashboard');
      state.data = data;
      state.loadedOnce = true;
      state.lastLoadedAt = Date.now();
      renderActiveView();
    } catch (err) {
      if (!state.loadedOnce) {
        const target = state.activeView === 'pipeline' ? document.getElementById('pipelineRoot') : document.getElementById('dashboardRoot');
        if (target) target.innerHTML = `<div class="crm-loading">${esc(err?.message || 'Could not load the dashboard.')}</div>`;
      } else if (window.showToast) {
        window.showToast(err?.message || 'Could not refresh the dashboard.');
      }
    } finally {
      state.loading = false;
      if (state.loadedOnce) renderActiveView();
    }
  }

  function renderCard(title, count, rows, options = {}){
    const icon = options.icon || 'fa-list';
    const countClass = options.countClass || '';
    const headClass = options.headClass ? ` ${options.headClass}` : '';
    const cardClass = options.cardClass ? ` ${options.cardClass}` : '';
    const loadingNote = options.loading ? `<span class="crm-card-loading"><i class="fas fa-spinner fa-spin"></i> Updating</span>` : '';
    const body = !rows.length
      ? `<div class="crm-empty">${esc(options.emptyText || 'Nothing scheduled here right now.')}</div>`
      : rows.join('');
    return `
      <section class="crm-card${cardClass}">
        <div class="crm-card-head${headClass}">
          <span class="crm-card-head-row">
            <h2><i class="fas ${icon}"></i> ${esc(title)}</h2>
            ${loadingNote}
          </span>
          <span class="crm-card-count ${countClass}">${Number(count || 0)}</span>
        </div>
        <div class="crm-card-body">${body}</div>
      </section>
    `;
  }

  function renderSkeletonRows(count){
    return Array.from({ length: count }).map(() => `
      <div class="crm-skeleton-row">
        <div class="crm-skeleton crm-skeleton-line lg"></div>
        <div class="crm-skeleton crm-skeleton-line md"></div>
      </div>
    `).join('');
  }

  function renderLoadingCard(title, options = {}){
    const icon = options.icon || 'fa-list';
    const headClass = options.headClass ? ` ${options.headClass}` : '';
    const rows = Number(options.rows || 3);
    return `
      <section class="crm-card${options.cardClass ? ` ${options.cardClass}` : ''}">
        <div class="crm-card-head${headClass}">
          <span class="crm-card-head-row">
            <h2><i class="fas ${icon}"></i> ${esc(title)}</h2>
            <span class="crm-card-loading"><i class="fas fa-spinner fa-spin"></i> Loading</span>
          </span>
          <span class="crm-skeleton crm-skeleton-chip"></span>
        </div>
        <div class="crm-skeleton-card-body">${renderSkeletonRows(rows)}</div>
      </section>
    `;
  }

  function renderDashboardLoading(){
    return `
      <div class="crm-loading-shell">
        <div class="crm-dash-head">
          <div class="crm-dash-head-copy">
            <h1>Dashboard</h1>
            <div class="crm-dash-sub">Loading today's activity...</div>
          </div>
          <div class="crm-dash-actions">
            <span class="crm-refresh-note live inline">Refreshing...</span>
            <button type="button" class="crm-dash-btn refreshing" disabled><i class="fas fa-spinner fa-spin"></i> Refreshing...</button>
          </div>
        </div>
        <section class="crm-leaderboard">
          <div class="crm-leaderboard-head">
            <div class="crm-skeleton-head-copy">
              <div class="crm-skeleton crm-skeleton-line md"></div>
              <div class="crm-skeleton crm-skeleton-line sm"></div>
            </div>
            <div class="crm-skeleton crm-skeleton-chip" style="width:116px;"></div>
          </div>
          <div class="crm-skeleton-card-body">${renderSkeletonRows(5)}</div>
        </section>
        <div class="crm-dash-grid-3">
          ${renderLoadingCard('Meetings', { icon: 'fa-calendar', headClass: 'meetings', rows: 3 })}
          ${renderLoadingCard('Unread', { icon: 'fa-envelope-open-text', headClass: 'unread', rows: 3 })}
          ${renderLoadingCard('Tasks', { icon: 'fa-list-check', headClass: 'tasks', rows: 3 })}
        </div>
        <div class="crm-followups-extra">
          <div class="crm-followups-grid">
            ${renderLoadingCard('Morning Follow-Ups', { icon: 'fa-sun', headClass: 'morning', cardClass: 'crm-followup-card', rows: 3 })}
            ${renderLoadingCard('Afternoon Follow-Ups', { icon: 'fa-cloud-sun', headClass: 'afternoon', cardClass: 'crm-followup-card', rows: 3 })}
            ${renderLoadingCard('Other Follow-Ups', { icon: 'fa-calendar-day', headClass: 'other', cardClass: 'crm-followup-card', rows: 3 })}
          </div>
        </div>
        <section class="crm-pipeline">
          <div class="crm-pipeline-shell-head">
            <div class="crm-skeleton-head-copy">
              <div class="crm-skeleton crm-skeleton-line md"></div>
            </div>
            <div class="crm-skeleton crm-skeleton-chip" style="width:140px;"></div>
          </div>
          <div class="crm-skeleton-card-body">${renderSkeletonRows(4)}</div>
        </section>
      </div>
    `;
  }

  function renderFollowupRows(items, dividerLabel){
    if (!Array.isArray(items) || !items.length) return [];
    const overdue = items.filter((item) => !!item.is_overdue);
    const today = items.filter((item) => !item.is_overdue);
    const rows = [];
    if (overdue.length) rows.push(`<div class="crm-divider"><i class="fas fa-triangle-exclamation"></i> Overdue (${overdue.length})</div>`);
    overdue.forEach((item) => rows.push(renderLeadRow(item, { type: 'followup', overdue: true })));
    if (today.length) rows.push(`<div class="crm-divider soft">${esc(dividerLabel)}</div>`);
    today.forEach((item) => rows.push(renderLeadRow(item, { type: 'followup' })));
    return rows;
  }

  function renderLeadRow(item, options = {}){
    const type = options.type || 'followup';
    const overdue = !!options.overdue;
    let icon = 'fa-phone';
    let iconClass = overdue ? 'crm-list-icon warn' : 'crm-list-icon';
    let sub = '';
    let time = '';
    if (type === 'meeting') {
      icon = item.calendar_meet_link ? 'fa-video' : 'fa-calendar';
      sub = [item.contact_name, item.title].filter(Boolean).join(' | ');
      time = fmtTime(item.due_at);
    } else if (type === 'unread') {
      icon = item.activity_type === 'sms' ? 'fa-comment' : 'fa-envelope';
      iconClass = item.activity_type === 'sms' ? 'crm-list-icon msg' : 'crm-list-icon';
      sub = [item.sender, item.preview].filter(Boolean).join(' | ');
      time = fmtDateTime(item.happened_at);
    } else {
      icon = item.provider === 'google_calendar' ? 'fa-calendar-day' : 'fa-phone';
      sub = [item.contact_name, item.title || item.body].filter(Boolean).join(' | ');
      time = overdue ? fmtDateTime(item.due_at) : (item.slot === 'morning' ? 'AM' : item.slot === 'afternoon' ? 'PM' : fmtTime(item.due_at) || 'Today');
    }
    return `
      <button type="button" class="crm-list-row ${overdue ? 'overdue' : ''}" data-open-lead="${esc(item.lead_id)}">
        <span class="${iconClass}"><i class="fas ${icon}"></i></span>
        <span class="crm-list-meta">
          <span class="crm-list-title">${esc(item.company || 'Lead')}</span>
          <span class="crm-list-sub">${esc(sub || 'Open lead')}</span>
        </span>
        <span class="crm-list-time ${overdue ? 'overdue' : ''}">${esc(time)}</span>
      </button>
    `;
  }

  function renderTaskRows(tasks){
    if (!Array.isArray(tasks) || !tasks.length) {
      return '<div class="crm-empty">No tasks yet for this view.</div>';
    }
    return tasks.map((task) => `
      <div class="crm-list-row crm-task-row ${task.status === 'done' ? 'done' : ''}" data-task-id="${esc(task.id)}">
        <input class="crm-task-check" type="checkbox" data-toggle-task="${esc(task.id)}" ${task.status === 'done' ? 'checked' : ''}>
        <span class="crm-list-meta">
          <span class="crm-list-title">${esc(task.title || 'Task')}</span>
          <span class="crm-list-sub">${esc(task.assigned_to_email || '')}${task.due_at ? ` | ${esc(fmtDateTime(task.due_at))}` : ''}</span>
        </span>
        <button type="button" class="crm-dash-btn" data-delete-task="${esc(task.id)}"><i class="fas fa-trash"></i></button>
      </div>
    `).join('');
  }

  function renderDashboard(){
    const root = document.getElementById('dashboardRoot');
    if (!root) return;
    if (!state.data) {
      root.innerHTML = renderDashboardLoading();
      return;
    }
    const cards = state.data.cards || {};
    const otherRows = renderFollowupRows(cards.other || [], 'Today | Other');
    ensureDefaultTarget();
    const targetOptions = canManage()
      ? [`<option value="mine"${state.targetEmail === 'mine' ? ' selected' : ''}>My Leads</option>`, `<option value="__all__"${state.targetEmail === '__all__' ? ' selected' : ''}>All SDRs</option>`]
          .concat(getSalesUsers().map((user) => `<option value="${esc(user.email)}"${state.targetEmail === user.email ? ' selected' : ''}>${esc(user.name || user.email)}</option>`))
          .join('')
      : '';
    root.innerHTML = `
      <div class="crm-dashboard">
        <div class="crm-dash-head">
          <div class="crm-dash-head-copy">
            <h1>Dashboard</h1>
            <div class="crm-dash-sub">${esc(todayLabel(state.data.today))}</div>
          </div>
          <div class="crm-dash-actions">
            <span class="crm-dash-greeting">${esc(dashboardGreeting())}, ${esc(dashboardGreetingName())}</span>
            ${state.loading ? `<span class="crm-refresh-note live">Refreshing...</span>` : ''}
            ${canManage() ? `<select class="crm-dash-select" id="dashboardTargetSelect">${targetOptions}</select>` : ''}
            <button type="button" class="crm-dash-btn ${state.loading ? 'refreshing' : ''}" id="dashboardRefreshBtn" ${state.loading ? 'disabled' : ''}><i class="fas ${state.loading ? 'fa-spinner fa-spin' : 'fa-rotate-right'}"></i> ${state.loading ? 'Refreshing...' : 'Refresh'}</button>
          </div>
        </div>

        ${renderLeaderboard()}

        <div class="crm-dash-grid-3">
          ${renderCard('Meetings', cards.meetings?.length || 0, (cards.meetings || []).map((item) => renderLeadRow(item, { type: 'meeting' })), { icon: 'fa-calendar', headClass: 'meetings', loading: state.loading })}
          ${renderCard('Unread', cards.unread?.length || 0, (cards.unread || []).map((item) => renderLeadRow(item, { type: 'unread' })), { icon: 'fa-envelope-open-text', headClass: 'unread', loading: state.loading, countClass: cards.unread?.length ? 'alert' : '', emptyText: 'No unread email or SMS right now.' })}
          <section class="crm-card">
            <div class="crm-card-head tasks">
              <span class="crm-card-head-row">
                <h2><i class="fas fa-list-check"></i> Tasks</h2>
                ${state.loading ? '<span class="crm-card-loading"><i class="fas fa-spinner fa-spin"></i> Updating</span>' : ''}
              </span>
              <span class="crm-card-count">${(state.data.tasks || []).length}</span>
            </div>
            <div class="crm-task-form">
              <input id="dashboardTaskTitle" class="crm-dash-input task-title" type="text" placeholder="Add a task...">
              <input id="dashboardTaskDue" class="crm-dash-input task-due" type="datetime-local">
              ${canManage() ? `<select id="dashboardTaskAssignee" class="crm-dash-select assignee">${[`<option value="${esc(state.data.task_assignee || cfg().user?.email || '')}">Assign to ${esc(state.data.task_assignee || cfg().user?.email || 'me')}</option>`].concat(getSalesUsers().map((user) => `<option value="${esc(user.email)}"${state.data.task_assignee === user.email ? ' selected' : ''}>${esc(user.name || user.email)}</option>`)).join('')}</select>` : ''}
              <button type="button" class="crm-dash-btn primary task-submit" id="dashboardAddTaskBtn">Add Task</button>
            </div>
            <div class="crm-card-body">${renderTaskRows(state.data.tasks || [])}</div>
          </section>
        </div>

        <div class="crm-followups-extra">
          <div class="crm-followups-grid">
            ${renderCard('Morning Follow-Ups', cards.morning?.length || 0, renderFollowupRows(cards.morning || [], 'Today | Morning'), { icon: 'fa-sun', headClass: 'morning', cardClass: 'crm-followup-card', loading: state.loading, emptyText: 'No morning follow-ups scheduled.' })}
            ${renderCard('Afternoon Follow-Ups', cards.afternoon?.length || 0, renderFollowupRows(cards.afternoon || [], 'Today | Afternoon'), { icon: 'fa-cloud-sun', headClass: 'afternoon', cardClass: 'crm-followup-card', loading: state.loading, emptyText: 'No afternoon follow-ups scheduled.' })}
            ${renderCard('Other Follow-Ups', cards.other?.length || 0, otherRows, { icon: 'fa-calendar-day', headClass: 'other', cardClass: 'crm-followup-card', loading: state.loading, emptyText: 'No date-specific follow-ups scheduled.' })}
          </div>
        </div>

        ${renderPipelineSection()}
      </div>
    `;
  }

  function renderLeaderboard(){
    const rows = Array.isArray(state.data?.leaderboard) ? state.data.leaderboard : [];
    const body = rows.length ? rows.map((row) => `
      <tr class="${row.is_me ? 'me' : ''}">
        <td><span class="crm-rank ${row.rank <= 3 ? 'top' : ''}">${row.rank}</span></td>
        <td>
          <div class="crm-person">
            <span class="crm-avatar">${esc((row.name || row.email || '?').split(/\s+/).slice(0,2).map((part) => part.charAt(0).toUpperCase()).join('').slice(0,2))}</span>
            <span>${esc(row.name || row.email || 'Rep')}${row.is_me ? '<span class="crm-you">You</span>' : ''}</span>
          </div>
        </td>
        <td class="num">${Number(row.info_sent || 0)}</td>
        <td class="num">${Number(row.info_received || 0)}</td>
        <td class="num">${Number(row.sign_ups || 0)}</td>
        <td class="num">${Number(row.funded_500_plus || 0)}</td>
        <td class="num crm-money">$${Number(row.funded_value || 0).toLocaleString()}</td>
      </tr>
    `).join('') : '<tr><td colspan="7" class="crm-empty">No leaderboard activity in this range yet.</td></tr>';
    return `
      <section class="crm-leaderboard">
        <div class="crm-leaderboard-head">
          <div>
            <h2><i class="fas fa-trophy" style="color:#a16207;margin-right:6px;"></i>Leaderboard</h2>
            <div class="crm-leaderboard-sub">Stage progress and funded value for the selected range.</div>
          </div>
          <div class="crm-toggle-group">
            <button type="button" class="${state.leaderboardRange === 'today' ? 'active' : ''}" data-leaderboard-range="today">Today</button>
            <button type="button" class="${state.leaderboardRange === 'week' ? 'active' : ''}" data-leaderboard-range="week">This Week</button>
          </div>
        </div>
        <div class="crm-table-wrap crm-leaderboard-table-wrap">
          <table class="crm-table">
            <thead>
              <tr>
                <th>#</th>
                <th>Name</th>
                <th class="num">Info Sent</th>
                <th class="num">Info Received</th>
                <th class="num">Sign-Ups</th>
                <th class="num">Funded $500+</th>
                <th class="num">Funded Value</th>
              </tr>
            </thead>
            <tbody>${body}</tbody>
          </table>
        </div>
      </section>
    `;
  }

  function renderPipelineSection(){
    const rows = ((state.data?.pipeline || {})[state.pipelineTab] || []).slice(0, 14);
    const body = rows.length
      ? rows.map((row) => `
          <button type="button" class="crm-pipeline-row" data-open-lead="${esc(row.lead_id)}">
            <span class="crm-pipeline-company">${esc(row.company || 'Lead')}</span>
            <span class="crm-stage-pill ${leadStagePillClass(row.stage)}">${esc(row.stage_label || row.stage || '')}</span>
            <span class="crm-list-time ${state.pipelineTab === 'hot' ? 'hot' : 'cold'}">${esc(daysLabel(row.days_since_touch))}</span>
          </button>
        `).join('')
      : '<div class="crm-empty">No leads in this pipeline view yet.</div>';
    const hotCount = ((state.data?.pipeline || {}).hot || []).length;
    const coldCount = ((state.data?.pipeline || {}).cold || []).length;
    return `
      <section class="crm-pipeline">
        <div class="crm-pipeline-shell-head">
          <h2><i class="fas fa-fire" style="color:#d97706;margin-right:6px;"></i>My Pipeline</h2>
          <div class="crm-dash-actions">
            <div class="crm-toggle-group">
              <button type="button" class="${state.pipelineTab === 'hot' ? 'active' : ''}" data-pipeline-tab="hot">Hot Leads (${hotCount})</button>
              <button type="button" class="${state.pipelineTab === 'cold' ? 'active' : ''}" data-pipeline-tab="cold">Going Cold (${coldCount})</button>
            </div>
            <button type="button" class="crm-dash-btn" id="dashboardOpenPipelineBtn">Open Full Pipeline</button>
          </div>
        </div>
        <div>${body}</div>
      </section>
    `;
  }

  function renderActiveView(){
    renderDashboard();
  }

  async function saveTask(){
    const titleEl = document.getElementById('dashboardTaskTitle');
    if (!titleEl) return;
    const title = String(titleEl.value || '').trim();
    if (!title) return;
    const due = document.getElementById('dashboardTaskDue')?.value || '';
    const assigned = document.getElementById('dashboardTaskAssignee')?.value || (state.data?.task_assignee || cfg().user?.email || '');
    const data = await api({
      action: 'lead_dashboard_task_save',
      title,
      due_at: due,
      assigned_to_email: assigned,
      target_email: state.targetEmail,
      leaderboard_range: state.leaderboardRange,
      viewer_timezone: Intl.DateTimeFormat().resolvedOptions().timeZone || ''
    });
    if (!data || !data.success) throw new Error(data?.error || 'Could not save the task');
    state.data = data;
    titleEl.value = '';
    const dueEl = document.getElementById('dashboardTaskDue');
    if (dueEl) dueEl.value = '';
    renderActiveView();
  }

  async function toggleTask(taskId, status){
    const data = await api({
      action: 'lead_dashboard_task_toggle',
      task_id: taskId,
      status,
      target_email: state.targetEmail,
      leaderboard_range: state.leaderboardRange,
      viewer_timezone: Intl.DateTimeFormat().resolvedOptions().timeZone || ''
    });
    if (!data || !data.success) throw new Error(data?.error || 'Could not update the task');
    state.data = data;
    renderActiveView();
  }

  async function deleteTask(taskId){
    const data = await api({
      action: 'lead_dashboard_task_delete',
      task_id: taskId,
      target_email: state.targetEmail,
      leaderboard_range: state.leaderboardRange,
      viewer_timezone: Intl.DateTimeFormat().resolvedOptions().timeZone || ''
    });
    if (!data || !data.success) throw new Error(data?.error || 'Could not delete the task');
    state.data = data;
    renderActiveView();
  }

  function bindEvents(){
    document.addEventListener('click', async (event) => {
      const openBtn = event.target.closest('[data-open-lead]');
      if (openBtn) {
        event.preventDefault();
        await openLead(openBtn.getAttribute('data-open-lead'));
        return;
      }
      const refreshBtn = event.target.closest('#dashboardRefreshBtn, #pipelineRefreshBtn');
      if (refreshBtn) {
        await loadDashboard({ announce: true });
        return;
      }
      const rangeBtn = event.target.closest('[data-leaderboard-range]');
      if (rangeBtn) {
        state.leaderboardRange = rangeBtn.getAttribute('data-leaderboard-range') === 'week' ? 'week' : 'today';
        await loadDashboard({ silent: true });
        return;
      }
      const pipelineBtn = event.target.closest('[data-pipeline-tab]');
      if (pipelineBtn) {
        state.pipelineTab = pipelineBtn.getAttribute('data-pipeline-tab') === 'cold' ? 'cold' : 'hot';
        renderActiveView();
        return;
      }
      const addTaskBtn = event.target.closest('#dashboardAddTaskBtn');
      if (addTaskBtn) {
        try { await saveTask(); } catch (err) { if (window.showToast) window.showToast(err?.message || 'Could not save the task.'); }
        return;
      }
      const toggleTaskBox = event.target.closest('[data-toggle-task]');
      if (toggleTaskBox) {
        try {
          await toggleTask(toggleTaskBox.getAttribute('data-toggle-task'), toggleTaskBox.checked ? 'done' : 'open');
        } catch (err) {
          toggleTaskBox.checked = !toggleTaskBox.checked;
          if (window.showToast) window.showToast(err?.message || 'Could not update the task.');
        }
        return;
      }
      const deleteTaskBtn = event.target.closest('[data-delete-task]');
      if (deleteTaskBtn) {
        try { await deleteTask(deleteTaskBtn.getAttribute('data-delete-task')); } catch (err) { if (window.showToast) window.showToast(err?.message || 'Could not delete the task.'); }
        return;
      }
      const openPipelineBtn = event.target.closest('#dashboardOpenPipelineBtn');
      if (openPipelineBtn) {
        await window.Portal.switchView('pipeline', document.getElementById('nav-pipeline'));
      }
    });

    document.addEventListener('change', async (event) => {
      const target = event.target;
      if (target && target.id === 'dashboardTargetSelect') {
        state.targetEmail = target.value || 'mine';
        await loadDashboard({ silent: true });
      }
    });

    document.addEventListener('keydown', async (event) => {
      if (event.key === 'Enter' && event.target && event.target.id === 'dashboardTaskTitle') {
        event.preventDefault();
        try { await saveTask(); } catch (err) { if (window.showToast) window.showToast(err?.message || 'Could not save the task.'); }
      }
    });

    document.addEventListener('visibilitychange', () => {
      if (isDashboardVisible() && Date.now() - state.lastLoadedAt > DASHBOARD_FOREGROUND_REFRESH_MS) {
        loadDashboard({ silent: true });
      }
    });
    window.addEventListener('focus', () => {
      if (isDashboardVisible() && Date.now() - state.lastLoadedAt > DASHBOARD_FOREGROUND_REFRESH_MS) loadDashboard({ silent: true });
    });
    window.addEventListener('firstmate-background-sync-complete', () => {
      if (isDashboardVisible() && Date.now() - state.lastLoadedAt > DASHBOARD_FOREGROUND_REFRESH_MS) loadDashboard({ silent: true });
    });
  }

  function startRefreshLoop(){
    if (state.refreshTimer) clearInterval(state.refreshTimer);
    state.refreshTimer = setInterval(() => {
      if (isDashboardVisible()) loadDashboard({ silent: true });
    }, DASHBOARD_REFRESH_MS);
  }

  const DashboardTab = {
    init(){
      ensureStyles();
      ensureMarkup();
      bindEvents();
      startRefreshLoop();
    },
    async onShow(){
      state.activeView = 'home';
      if (state.loadedOnce && Date.now() - state.lastLoadedAt < DASHBOARD_FOREGROUND_REFRESH_MS) {
        renderActiveView();
        return;
      }
      await loadDashboard({ silent: true });
    }
  };

  window.DashboardTab = DashboardTab;
})();
