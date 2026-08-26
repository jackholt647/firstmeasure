(function(){
  if (!window.Portal) return;

  const cfg = () => window.Portal?.cfg || window.PORTAL_CFG || {};
  const esc = (value) => window.Portal.escapeHtml(String(value ?? ''));
  const toast = (message, type = 'info') => {
    if (window.Portal?.toast) window.Portal.toast(message, type);
    else if (window.showToast) window.showToast(message, type);
    else console.log('[Commissions]', type, message);
  };

  const state = {
    data: null,
    loading: false,
    managerView: 'overview',
    eventFilter: 'all',
    payrollPeriodKey: '',
    teamDrilldownEmail: ''
  };

  function api(data){
    return fetch(cfg().endpoints?.server || window.Portal.internalLegacyEndpoint(), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(data)
    }).then(async r => {
      const json = await r.json();
      if (!json?.success && json?.error) throw new Error(json.error);
      return json;
    });
  }

  function fmtMoney(cents){
    return '$' + ((Number(cents || 0) / 100).toFixed(2));
  }

  function fmtTs(ts){
    const n = Number(ts || 0);
    return n ? new Date(n * 1000).toLocaleString() : '-';
  }

  function fmtDay(ts){
    const n = Number(ts || 0);
    return n ? new Date(n * 1000).toLocaleDateString() : '-';
  }

  function eventTypeMeta(type){
    const key = String(type || '').toLowerCase();
    if (key === 'milestone') return { label: 'Milestone', tone: 'milestone' };
    if (key === 'bonus_offer') return { label: 'Bonus Offer', tone: 'bonus' };
    if (key === 'referral_signup') return { label: 'Referral Signup', tone: 'referral' };
    if (key === 'referral_bonus') return { label: 'Referral Bonus', tone: 'referral' };
    return { label: type || 'Event', tone: 'neutral' };
  }

  function breakdownValue(row, key, field){
    return Number(row?.[key]?.[field] || 0);
  }

  function ensureStyles(){
    if (document.getElementById('commissionsPluginStyles')) return;
    const style = document.createElement('style');
    style.id = 'commissionsPluginStyles';
    style.textContent = `
      .comm-shell{display:grid;gap:18px}
      .comm-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(210px,1fr));gap:14px}
      .comm-card{background:#fff;border:1px solid #e5e8ef;border-radius:18px;padding:18px;box-shadow:0 8px 24px rgba(15,23,42,.04)}
      .comm-k{font-size:11px;font-weight:900;letter-spacing:.05em;text-transform:uppercase;color:#7a8595}
      .comm-v{margin-top:8px;font-size:28px;font-weight:900;color:#d93025}
      .comm-sub{margin-top:6px;font-size:12px;color:#66707f;line-height:1.45}
      .comm-progress{margin-top:12px;height:10px;border-radius:999px;background:#eef2f6;overflow:hidden}
      .comm-progress > div{height:100%;background:linear-gradient(90deg,#d93025,#ef4444);border-radius:999px}
      .comm-section-head{display:flex;justify-content:space-between;align-items:center;gap:12px;flex-wrap:wrap;margin-bottom:12px}
      .comm-title{font-size:15px;font-weight:900;color:#223040}
      .comm-table-wrap{overflow:auto;border:1px solid #e7ebf2;border-radius:14px;background:#fff}
      .comm-table{width:100%;border-collapse:collapse;background:#fff}
      .comm-table th,.comm-table td{padding:11px 12px;border-bottom:1px solid #eef1f5;text-align:left;font-size:13px;vertical-align:middle}
      .comm-table th{background:#f8fafc;font-size:11px;font-weight:900;letter-spacing:.04em;text-transform:uppercase;color:#697586}
      .comm-table tbody tr:hover td{background:#fafcff}
      .comm-status{display:inline-flex;align-items:center;padding:4px 8px;border-radius:999px;font-size:10px;font-weight:900;letter-spacing:.04em;text-transform:uppercase}
      .comm-status.pending{background:#fff4e5;color:#a15c00}
      .comm-status.completed{background:#e8f7ed;color:#127a3d}
      .comm-inline-form{display:flex;gap:10px;flex-wrap:wrap;align-items:end}
      .comm-settings-input{width:100%;min-width:0;box-sizing:border-box;padding:10px 12px;border:1px solid #d6dde7;border-radius:12px;background:#fff;color:#223040;font:inherit;line-height:1.3;box-shadow:0 1px 2px rgba(16,24,40,.04)}
      .comm-settings-input:focus{outline:none;border-color:#d93025;box-shadow:0 0 0 4px rgba(217,48,37,.12)}
      .comm-empty{padding:26px;text-align:center;color:#8a93a0;font-style:italic}
      .comm-subtabs{display:flex;gap:8px;flex-wrap:wrap}
      .comm-subtab{border:1px solid #d9dee8;background:#fff;border-radius:999px;padding:8px 12px;font-size:12px;font-weight:800;color:#5e6775;cursor:pointer}
      .comm-subtab.active{background:#d93025;border-color:#d93025;color:#fff}
      .comm-chipbar{display:flex;gap:8px;flex-wrap:wrap}
      .comm-chip{border:1px solid #d9dee8;background:#fff;border-radius:999px;padding:6px 10px;font-size:11px;font-weight:800;color:#5e6775;cursor:pointer}
      .comm-chip.active{background:#223040;border-color:#223040;color:#fff}
      .comm-event-list{display:grid;gap:10px}
      .comm-event{border:1px solid #e7ebf2;border-radius:14px;background:#fbfcff;padding:14px}
      .comm-event-top{display:flex;justify-content:space-between;gap:12px;align-items:flex-start;flex-wrap:wrap}
      .comm-event-title{font-size:14px;font-weight:900;color:#223040}
      .comm-event-meta{font-size:12px;color:#66707f;line-height:1.45;margin-top:6px}
      .comm-badge{display:inline-flex;align-items:center;padding:4px 8px;border-radius:999px;font-size:10px;font-weight:900;letter-spacing:.04em;text-transform:uppercase}
      .comm-badge.milestone{background:#fee2e2;color:#b91c1c}
      .comm-badge.bonus{background:#eef2ff;color:#4338ca}
      .comm-badge.referral{background:#ecfdf3;color:#047857}
      .comm-badge.neutral{background:#f1f5f9;color:#475569}
      .comm-metric-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(160px,1fr));gap:12px}
      .comm-mini{background:#f8fafc;border:1px solid #e6ebf3;border-radius:14px;padding:14px}
      .comm-mini .label{font-size:10px;font-weight:900;text-transform:uppercase;letter-spacing:.05em;color:#748091}
      .comm-mini .value{margin-top:6px;font-size:20px;font-weight:900;color:#223040}
      .comm-toolbar{display:flex;gap:10px;flex-wrap:wrap;align-items:center}
      .comm-pill{display:inline-flex;align-items:center;padding:5px 8px;border-radius:999px;background:#f3f5f8;color:#5f6c7b;font-size:11px;font-weight:800}
      .comm-team-grid{display:grid;gap:12px}
      .comm-team-item{border:1px solid #e5e8ef;border-radius:16px;background:#fff;padding:16px}
      .comm-team-top{display:flex;justify-content:space-between;gap:12px;align-items:flex-start;flex-wrap:wrap}
      .comm-team-name{font-size:15px;font-weight:900;color:#223040}
      .comm-team-email{font-size:12px;color:#6b7280;margin-top:2px}
      .comm-team-actions{display:flex;gap:8px;flex-wrap:wrap}
      .comm-team-form{display:grid;grid-template-columns:repeat(3,minmax(120px,1fr)) auto;gap:10px;align-items:end;margin-top:14px}
      .comm-team-form label{display:grid;gap:6px;font-size:11px;font-weight:800;color:#617081}
      .comm-payroll-nav{display:flex;gap:10px;align-items:center;flex-wrap:wrap}
      .comm-report-note{font-size:12px;color:#66707f;line-height:1.45}
      @media (max-width: 860px){.comm-team-form{grid-template-columns:1fr 1fr}.comm-team-form .comm-save-cell{grid-column:1 / -1}}
      @media (max-width: 620px){.comm-team-form{grid-template-columns:1fr}}
    `;
    document.head.appendChild(style);
  }

  function ensureMarkup(){
    const host = document.getElementById('portalPluginViews');
    if (!host || document.getElementById('view-commissions')) return;
    const wrap = document.createElement('div');
    wrap.id = 'view-commissions';
    wrap.style.display = 'none';
    wrap.innerHTML = `
      <div class="comm-shell">
        <div class="header-bar">
          <h1>Commissions</h1>
          <div class="comm-toolbar">
            <button class="btn-secondary" id="commRefreshBtn"><i class="fas fa-sync"></i> Refresh</button>
            <button class="btn-secondary" id="commExportBtn"><i class="fas fa-download"></i> Export Report</button>
          </div>
        </div>
        <div id="commRoot"></div>
      </div>
    `;
    host.appendChild(wrap);
  }

  function renderLoading(){
    return '<div class="comm-card comm-empty"><i class="fas fa-spinner fa-spin"></i> Loading commissions...</div>';
  }

  function summaryCardsHtml(data){
    const summary = data.summary || {};
    const breakdown = summary.breakdown || {};
    const quota = Number(summary.quota || 0);
    const hits = Number(summary.current_hits || 0);
    const pct = quota > 0 ? Math.min(100, Math.round((hits / quota) * 100)) : 0;
    return `
      <div class="comm-grid">
        <div class="comm-card">
          <div class="comm-k">Milestone Progress</div>
          <div class="comm-v">${hits}/${quota || 0}</div>
          <div class="comm-sub">Quota for ${esc(data.current_month || '')}. Each milestone is a customer crossing $70 in real Stripe spend.</div>
          <div class="comm-progress"><div style="width:${pct}%;"></div></div>
        </div>
        <div class="comm-card">
          <div class="comm-k">Milestone Commission</div>
          <div class="comm-v">${fmtMoney(breakdownValue(breakdown, 'milestone', 'payout_cents'))}</div>
          <div class="comm-sub">${breakdownValue(breakdown, 'milestone', 'count')} customers qualified. Current payout per milestone: ${fmtMoney(summary.milestone_payout_cents)}</div>
        </div>
        <div class="comm-card">
          <div class="comm-k">Bonus + Referral</div>
          <div class="comm-v">${fmtMoney(
            breakdownValue(breakdown, 'bonus_offer', 'payout_cents') +
            breakdownValue(breakdown, 'referral_signup', 'payout_cents') +
            breakdownValue(breakdown, 'referral_bonus', 'payout_cents')
          )}</div>
          <div class="comm-sub">Bonus: ${fmtMoney(breakdownValue(breakdown, 'bonus_offer', 'payout_cents'))} | Referral Signup: ${fmtMoney(breakdownValue(breakdown, 'referral_signup', 'payout_cents'))} | Referral Bonus: ${fmtMoney(breakdownValue(breakdown, 'referral_bonus', 'payout_cents'))}</div>
        </div>
        <div class="comm-card">
          <div class="comm-k">Current Month Total</div>
          <div class="comm-v">${fmtMoney(summary.current_commission_cents)}</div>
          <div class="comm-sub">Next commission payday: ${esc(fmtDay(summary.next_commission_due_ts))}. Base pay this month: ${fmtMoney(summary.monthly_base_pay_cents)}</div>
        </div>
      </div>
    `;
  }

  function filteredEvents(events){
    const filter = state.eventFilter;
    if (!filter || filter === 'all') return events;
    return (events || []).filter(row => String(row.event_type || '').toLowerCase() === filter);
  }

  function eventsHtml(events){
    const rows = filteredEvents(events || []);
    if (!rows.length) return '<div class="comm-card comm-empty">No commission activity matches this filter yet.</div>';
    return `
      <div class="comm-event-list">
        ${rows.map(row => {
          const meta = eventTypeMeta(row.event_type);
          const secondary = row.secondary_user_email ? ` | Secondary: ${esc(row.secondary_user_email)}` : '';
          return `
            <div class="comm-event">
              <div class="comm-event-top">
                <div>
                  <div class="comm-event-title">${esc(row.org_name || row.org_id || 'Customer')}</div>
                  <div class="comm-event-meta">${esc(fmtTs(row.occurred_at))} | ${esc(row.user_email || '-')}${secondary}</div>
                </div>
                <div style="display:grid;gap:6px;justify-items:end;">
                  <span class="comm-badge ${esc(meta.tone)}">${esc(meta.label)}</span>
                  <strong>${esc(fmtMoney(row.payout_cents))}</strong>
                </div>
              </div>
              <div class="comm-event-meta">
                Source Amount: ${esc(fmtMoney(row.source_amount_cents))}${row.referrer_user_email ? ` | Referrer: ${esc(row.referrer_user_email)}` : ''}${row.referrer_org_id ? ` | Referrer Org: ${esc(row.referrer_org_id)}` : ''}
              </div>
            </div>
          `;
        }).join('')}
      </div>
    `;
  }

  function payrollTableHtml(rows, manager){
    if (!rows.length) return '<div class="comm-card comm-empty">No payroll records yet.</div>';
    return `
      <div class="comm-table-wrap">
        <table class="comm-table">
          <thead>
            <tr>
              ${manager ? '<th>Salesperson</th>' : ''}
              <th>Due</th>
              <th>Base Pay</th>
              <th>Commission</th>
              <th>Total</th>
              <th>Status</th>
              <th>Completed</th>
              ${manager ? '<th></th>' : ''}
            </tr>
          </thead>
          <tbody>
            ${rows.map(row => `
              <tr>
                ${manager ? `<td>${esc(commissionName(row.user_email))}<div style="font-size:12px;color:#6b7280;">${esc(row.user_email || '')}</div></td>` : ''}
                <td>${esc(fmtDay(row.due_date))}</td>
                <td>${esc(fmtMoney(row.base_pay_cents))}</td>
                <td>${esc(fmtMoney(row.commission_cents))}<div style="font-size:12px;color:#6b7280;">${Number(row.commission_count || 0)} items</div></td>
                <td><strong>${esc(fmtMoney(row.total_cents))}</strong></td>
                <td><span class="comm-status ${esc((row.status || 'pending').toLowerCase())}">${esc(row.status || 'pending')}</span></td>
                <td>${row.completed_at ? `${esc(fmtDay(row.completed_at))} by ${esc(row.completed_by_email || '-')}` : '-'}</td>
                ${manager ? `<td>${String(row.status || '').toLowerCase() === 'completed' ? '' : `<button class="btn-secondary" data-payroll-complete="${esc(row.id)}">Mark Completed</button>`}</td>` : ''}
              </tr>
            `).join('')}
          </tbody>
        </table>
      </div>
    `;
  }

  function payrollPeriods(rows){
    const map = new Map();
    (rows || []).forEach(row => {
      const key = String(row.period_key || '');
      if (!key) return;
      if (!map.has(key)) map.set(key, []);
      map.get(key).push(row);
    });
    return Array.from(map.entries()).map(([key, items]) => ({
      key,
      due_date: Math.min(...items.map(item => Number(item.due_date || 0)).filter(Boolean)),
      rows: items.sort((a, b) => String(a.user_email || '').localeCompare(String(b.user_email || '')))
    })).sort((a, b) => a.due_date - b.due_date);
  }

  function activePayrollPeriod(periods){
    if (!periods.length) return null;
    if (state.payrollPeriodKey) {
      const found = periods.find(period => period.key === state.payrollPeriodKey);
      if (found) return found;
    }
    const now = Date.now() / 1000;
    const current = periods.find(period => period.due_date >= now);
    const pick = current || periods[periods.length - 1];
    state.payrollPeriodKey = pick.key;
    return pick;
  }

  function commissionName(email){
    const team = state.data?.sales_users || [];
    const found = team.find(row => String(row.email || '') === String(email || ''));
    return found?.name || email || '-';
  }

  function teamSettingsHtml(users){
    if (!users.length) return '<div class="comm-card comm-empty">No sales users found.</div>';
    const rows = state.teamDrilldownEmail ? users.filter(row => row.email === state.teamDrilldownEmail) : users;
    return `
      <div class="comm-team-grid">
        ${rows.map(user => `
          <div class="comm-team-item">
            <div class="comm-team-top">
              <div>
                <div class="comm-team-name">${esc(user.name || user.email)}</div>
                <div class="comm-team-email">${esc(user.email || '')}</div>
              </div>
              <div class="comm-team-actions">
                <span class="comm-pill">Month Total ${esc(fmtMoney(user.current_commission_cents))}</span>
                <button class="btn-secondary" data-comm-drilldown="${esc(user.email)}">${state.teamDrilldownEmail === user.email ? 'Show All' : 'Drill In'}</button>
              </div>
            </div>
            <div class="comm-metric-grid" style="margin-top:14px;">
              <div class="comm-mini"><div class="label">Milestones</div><div class="value">${breakdownValue(user.breakdown, 'milestone', 'count')}</div></div>
              <div class="comm-mini"><div class="label">Bonus</div><div class="value">${fmtMoney(breakdownValue(user.breakdown, 'bonus_offer', 'payout_cents'))}</div></div>
              <div class="comm-mini"><div class="label">Referral</div><div class="value">${fmtMoney(breakdownValue(user.breakdown, 'referral_signup', 'payout_cents') + breakdownValue(user.breakdown, 'referral_bonus', 'payout_cents'))}</div></div>
            </div>
            <div class="comm-team-form">
              <label>Monthly Quota<input type="number" min="0" step="1" class="comm-settings-input" data-comm-quota="${esc(user.email)}" value="${Number(user.settings?.monthly_quota || 0)}"></label>
              <label>Base Pay / Check<input type="number" min="0" step="0.01" class="comm-settings-input" data-comm-basepay="${esc(user.email)}" value="${(Number(user.settings?.base_pay_cents || 0) / 100).toFixed(2)}"></label>
              <label>Milestone Payout<input type="number" min="0" step="0.01" class="comm-settings-input" data-comm-milestone-payout="${esc(user.email)}" value="${(Number(user.settings?.milestone_payout_cents || 0) / 100).toFixed(2)}"></label>
              <div class="comm-save-cell"><button class="btn-primary" data-comm-save="${esc(user.email)}">Save</button></div>
            </div>
          </div>
        `).join('')}
      </div>
    `;
  }

  function managerPayrollViewHtml(rows){
    const periods = payrollPeriods(rows || []);
    const active = activePayrollPeriod(periods);
    if (!active) return '<div class="comm-card comm-empty">No payroll records yet.</div>';
    const activeIndex = periods.findIndex(period => period.key === active.key);
    const baseTotal = active.rows.reduce((sum, row) => sum + Number(row.base_pay_cents || 0), 0);
    const commissionTotal = active.rows.reduce((sum, row) => sum + Number(row.commission_cents || 0), 0);
    const total = active.rows.reduce((sum, row) => sum + Number(row.total_cents || 0), 0);
    const pending = active.rows.filter(row => String(row.status || '').toLowerCase() !== 'completed').length;
    return `
      <div class="comm-section-head">
        <div>
          <div class="comm-title">Current Payroll</div>
          <div class="comm-sub">${esc(active.key)} | Due ${esc(fmtDay(active.due_date))}</div>
        </div>
        <div class="comm-payroll-nav">
          <button class="btn-secondary" ${activeIndex <= 0 ? 'disabled' : ''} data-comm-payroll-nav="prev"><i class="fas fa-chevron-left"></i> Previous</button>
          <button class="btn-secondary" ${activeIndex >= periods.length - 1 ? 'disabled' : ''} data-comm-payroll-nav="next">Next <i class="fas fa-chevron-right"></i></button>
        </div>
      </div>
      <div class="comm-grid">
        <div class="comm-card"><div class="comm-k">Base Pay</div><div class="comm-v">${fmtMoney(baseTotal)}</div></div>
        <div class="comm-card"><div class="comm-k">Commissions</div><div class="comm-v">${fmtMoney(commissionTotal)}</div></div>
        <div class="comm-card"><div class="comm-k">Total Payroll</div><div class="comm-v">${fmtMoney(total)}</div></div>
        <div class="comm-card"><div class="comm-k">Pending Payouts</div><div class="comm-v">${pending}</div></div>
      </div>
      ${payrollTableHtml(active.rows, true)}
    `;
  }

  function managerReportHtml(data){
    const rows = data.sales_users || [];
    if (!rows.length) return '<div class="comm-card comm-empty">No team report available yet.</div>';
    return `
      <div class="comm-card">
        <div class="comm-section-head">
          <div>
            <div class="comm-title">Monthly Team Report</div>
            <div class="comm-sub">Export the same report managers use for commission review and payroll prep.</div>
          </div>
          <button class="btn-primary" id="commExportReportBtn"><i class="fas fa-download"></i> Download CSV</button>
        </div>
        <div class="comm-report-note">The export includes current-month milestone, bonus, and referral payouts by SDR plus the current payroll schedule.</div>
      </div>
      <div class="comm-table-wrap">
        <table class="comm-table">
          <thead>
            <tr>
              <th>Salesperson</th>
              <th>Milestones</th>
              <th>Milestone $</th>
              <th>Bonus $</th>
              <th>Referral Signup $</th>
              <th>Referral Bonus $</th>
              <th>Total</th>
            </tr>
          </thead>
          <tbody>
            ${rows.map(row => `
              <tr>
                <td>${esc(row.name || row.email)}<div style="font-size:12px;color:#6b7280;">${esc(row.email || '')}</div></td>
                <td>${breakdownValue(row.breakdown, 'milestone', 'count')}</td>
                <td>${esc(fmtMoney(breakdownValue(row.breakdown, 'milestone', 'payout_cents')))}</td>
                <td>${esc(fmtMoney(breakdownValue(row.breakdown, 'bonus_offer', 'payout_cents')))}</td>
                <td>${esc(fmtMoney(breakdownValue(row.breakdown, 'referral_signup', 'payout_cents')))}</td>
                <td>${esc(fmtMoney(breakdownValue(row.breakdown, 'referral_bonus', 'payout_cents')))}</td>
                <td><strong>${esc(fmtMoney(row.current_commission_cents))}</strong></td>
              </tr>
            `).join('')}
          </tbody>
        </table>
      </div>
    `;
  }

  function personalViewHtml(data){
    return `
      <div class="comm-card">
        <div class="comm-section-head">
          <div>
            <div class="comm-title">Commission Activity</div>
            <div class="comm-sub">Milestone, bonus, and referral payouts attributed to you.</div>
          </div>
          <div class="comm-chipbar">
            ${['all','milestone','bonus_offer','referral_signup','referral_bonus'].map(key => {
              const label = key === 'all' ? 'All' : eventTypeMeta(key).label;
              return `<button class="comm-chip ${state.eventFilter === key ? 'active' : ''}" data-comm-event-filter="${esc(key)}">${esc(label)}</button>`;
            }).join('')}
          </div>
        </div>
        ${eventsHtml(data.events || [])}
      </div>
      <div class="comm-card">
        <div class="comm-section-head">
          <div>
            <div class="comm-title">Payroll History</div>
            <div class="comm-sub">Semi-monthly payroll rows including prior-month commissions on the first check.</div>
          </div>
        </div>
        ${payrollTableHtml(data.payroll || [], false)}
      </div>
    `;
  }

  function managerViewHtml(data){
    const tabs = `
      <div class="comm-subtabs" style="margin-bottom:14px;">
        <button class="comm-subtab ${state.managerView === 'overview' ? 'active' : ''}" data-comm-view="overview">Team Overview</button>
        <button class="comm-subtab ${state.managerView === 'payroll' ? 'active' : ''}" data-comm-view="payroll">Payroll</button>
        <button class="comm-subtab ${state.managerView === 'reports' ? 'active' : ''}" data-comm-view="reports">Reports</button>
      </div>
    `;
    let body = '';
    if (state.managerView === 'payroll') body = managerPayrollViewHtml(data.manager_payroll || []);
    else if (state.managerView === 'reports') body = managerReportHtml(data);
    else body = `
      <div class="comm-card">
        <div class="comm-section-head">
          <div>
            <div class="comm-title">Per-SDR Commission Settings</div>
            <div class="comm-sub">Managers can configure quota, base pay per check, and milestone payout per SDR.</div>
          </div>
        </div>
        ${teamSettingsHtml(data.sales_users || [])}
      </div>
      <div class="comm-card">
        <div class="comm-section-head">
          <div>
            <div class="comm-title">Recent Team Commission Activity</div>
            <div class="comm-sub">Latest milestone, bonus, and referral payouts across the team.</div>
          </div>
        </div>
        ${eventsHtml(data.manager_events || [])}
      </div>
    `;
    return `${tabs}${body}`;
  }

  function render(){
    const root = document.getElementById('commRoot');
    const exportBtn = document.getElementById('commExportBtn');
    if (!root) return;
    if (state.loading && !state.data) {
      if (exportBtn) exportBtn.style.display = 'none';
      root.innerHTML = renderLoading();
      return;
    }
    const data = state.data;
    if (!data) {
      if (exportBtn) exportBtn.style.display = 'none';
      root.innerHTML = '<div class="comm-card comm-empty">Could not load commissions.</div>';
      return;
    }
    if (data.success === false) {
      if (exportBtn) exportBtn.style.display = 'none';
      root.innerHTML = `<div class="comm-card comm-empty">${esc(data.error || 'Could not load commissions.')}</div>`;
      return;
    }
    if (exportBtn) exportBtn.style.display = data.can_manage ? '' : 'none';
    root.innerHTML = `
      ${summaryCardsHtml(data)}
      ${personalViewHtml(data)}
      ${data.can_manage ? managerViewHtml(data) : ''}
    `;
  }

  async function refresh(force = false){
    state.loading = true;
    if (!state.data) render();
    try {
      state.data = await api({ action: 'commission_dashboard', force: force ? 1 : 0 });
    } catch (err) {
      toast(err.message || 'Failed to load commissions.', 'error');
      if (!state.data) state.data = { success: false, error: err.message || 'Failed to load commissions.' };
    } finally {
      state.loading = false;
      render();
    }
  }

  async function saveUser(email){
    const quotaInput = document.querySelector(`[data-comm-quota="${CSS.escape(String(email))}"]`);
    const baseInput = document.querySelector(`[data-comm-basepay="${CSS.escape(String(email))}"]`);
    const payoutInput = document.querySelector(`[data-comm-milestone-payout="${CSS.escape(String(email))}"]`);
    if (!quotaInput || !baseInput || !payoutInput) return;
    try {
      state.data = await api({
        action: 'commission_save_user_settings',
        user_email: email,
        monthly_quota: Number(quotaInput.value || 0),
        base_pay: Number(baseInput.value || 0),
        milestone_payout: Number(payoutInput.value || 0)
      });
      toast('Commission settings saved.', 'success');
      render();
    } catch (err) {
      toast(err.message || 'Could not save commission settings.', 'error');
    }
  }

  async function markPayrollComplete(id){
    try {
      state.data = await api({ action: 'commission_mark_payroll_completed', payroll_id: id });
      toast('Payroll row marked completed.', 'success');
      render();
    } catch (err) {
      toast(err.message || 'Could not mark payroll completed.', 'error');
    }
  }

  async function exportReport(){
    try {
      const data = await api({ action: 'commission_export_report' });
      const blob = new Blob([String(data.csv || '')], { type: 'text/csv;charset=utf-8' });
      const url = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = url;
      link.download = data.filename || 'commissions.csv';
      document.body.appendChild(link);
      link.click();
      link.remove();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
      toast('Commission report downloaded.', 'success');
    } catch (err) {
      toast(err.message || 'Could not export report.', 'error');
    }
  }

  function bindEvents(){
    document.addEventListener('click', (e) => {
      if (e.target.closest('#commRefreshBtn')) {
        refresh(true);
        return;
      }
      if (e.target.closest('#commExportBtn') || e.target.closest('#commExportReportBtn')) {
        exportReport();
        return;
      }
      const saveBtn = e.target.closest('[data-comm-save]');
      if (saveBtn) {
        saveUser(saveBtn.getAttribute('data-comm-save'));
        return;
      }
      const filterBtn = e.target.closest('[data-comm-event-filter]');
      if (filterBtn) {
        state.eventFilter = filterBtn.getAttribute('data-comm-event-filter') || 'all';
        render();
        return;
      }
      const viewBtn = e.target.closest('[data-comm-view]');
      if (viewBtn) {
        state.managerView = viewBtn.getAttribute('data-comm-view') || 'overview';
        render();
        return;
      }
      const drillBtn = e.target.closest('[data-comm-drilldown]');
      if (drillBtn) {
        const email = drillBtn.getAttribute('data-comm-drilldown') || '';
        state.teamDrilldownEmail = state.teamDrilldownEmail === email ? '' : email;
        render();
        return;
      }
      const navBtn = e.target.closest('[data-comm-payroll-nav]');
      if (navBtn && state.data?.manager_payroll) {
        const periods = payrollPeriods(state.data.manager_payroll || []);
        const active = activePayrollPeriod(periods);
        const idx = periods.findIndex(period => period.key === active?.key);
        const nextIdx = navBtn.getAttribute('data-comm-payroll-nav') === 'next' ? idx + 1 : idx - 1;
        if (periods[nextIdx]) {
          state.payrollPeriodKey = periods[nextIdx].key;
          render();
        }
        return;
      }
      const completeBtn = e.target.closest('[data-payroll-complete]');
      if (completeBtn) {
        markPayrollComplete(completeBtn.getAttribute('data-payroll-complete'));
      }
    });
  }

  const Commissions = {
    init(){
      if (!(cfg().capabilities || {}).view_commissions) return;
      ensureStyles();
      ensureMarkup();
      bindEvents();
      Portal.registerPlugin({
        id: 'commissions',
        title: 'Commissions',
        iconClass: 'fas fa-dollar-sign'
      });
    },
    async onShow(){
      await refresh(false);
    }
  };

  const prevSwitch = Portal.switchView ? Portal.switchView.bind(Portal) : null;
  if (prevSwitch) {
    Portal.switchView = async function(id, btn){
      const result = await prevSwitch(id, btn);
      if (id === 'commissions') await Commissions.onShow();
      return result;
    };
  }

  Commissions.init();
  window.Commissions = Commissions;
})();
