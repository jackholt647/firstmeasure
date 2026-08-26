/* public/libraries/apps/money/project.js
 * Project modal Money tab.
 */
(function(){
  const rootWindow = window;
  const runtime = rootWindow.FirstMateEmbeddableApps;
  const Portal = rootWindow.Portal = rootWindow.Portal || {};
  const showToast = Portal?.ui?.showToast || rootWindow.showToast || (() => {});

  const state = {
    context: null,
    host: null,
    panelRoot: null,
    leftRoot: null,
    project: null,
    active: false,
    loading: false,
    saving: false,
    error: '',
    notice: '',
    summary: null,
    ledger: [],
    events: [],
    activeScheduleId: 'all',
    activeView: 'overview',
    action: null,
    lastLoadedAt: ''
  };

  function cleanText(...values){
    for (const value of values) {
      const text = String(value ?? '').trim();
      if (text) return text;
    }
    return '';
  }

  function escapeHtml(value){
    return String(value ?? '').replace(/[&<>"']/g, (match) => ({
      '&': '&amp;',
      '<': '&lt;',
      '>': '&gt;',
      '"': '&quot;',
      "'": '&#39;'
    }[match]));
  }

  function statusClass(value){
    return cleanText(value).toLowerCase().replace(/[^a-z0-9_-]/g, '_') || 'scheduled';
  }

  function titleText(value){
    return cleanText(value).replace(/_/g, ' ').replace(/\b\w/g, (char) => char.toUpperCase());
  }

  function cents(value){
    const number = Number(value);
    return Number.isFinite(number) ? Math.round(number) : 0;
  }

  function centsFromDollars(value){
    const number = Number(String(value ?? '').replace(/[^0-9.-]/g, ''));
    return Number.isFinite(number) ? Math.round(number * 100) : 0;
  }

  function money(value){
    const amount = cents(value) / 100;
    const hasCents = Math.abs(amount % 1) > 0.001;
    return new Intl.NumberFormat('en-US', {
      style: 'currency',
      currency: 'USD',
      minimumFractionDigits: hasCents ? 2 : 0,
      maximumFractionDigits: hasCents ? 2 : 0
    }).format(amount);
  }

  function shortDate(value){
    const text = cleanText(value);
    if (!text) return '';
    const date = new Date(text);
    if (Number.isNaN(date.getTime())) return text;
    return date.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
  }

  function dateTime(value){
    const text = cleanText(value);
    if (!text) return '';
    const date = new Date(text);
    if (Number.isNaN(date.getTime())) return text;
    return date.toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
  }

  function orgId(){
    return cleanText(state.context?.orgId, rootWindow.__APP?.orgId, rootWindow.__APP?.organizationId, rootWindow.__APP?.userOrgId);
  }

  function branchId(){
    return cleanText(state.context?.branchId, rootWindow.Portal?.branchModules?.currentBranchId?.(), rootWindow.__APP?.branchId, rootWindow.__APP?.userBranchId, 'default') || 'default';
  }

  function projectId(){
    return cleanText(state.project?.id, state.context?.projectId, state.context?.entityId);
  }

  function apiReady(){
    return !!(rootWindow.PaymentsAPI?.projects && orgId() && projectId());
  }

  function panelHtml(){
    return '<div class="mn-app" data-money-root><div class="mn-state"><i class="fas fa-circle-notch fa-spin"></i><span>Loading money...</span></div></div>';
  }

  function css(){
    return `
      .mn-app{height:100%;min-height:0;display:flex;flex-direction:column;background:#f7f8fb;color:#101828;font-family:Inter,system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif}
      .r-overlay.money-workspace #rProposalSection.visible{min-height:0}
      .r-overlay.money-workspace #rProposalList{min-height:0;gap:0}
      .mn-top{display:flex;align-items:center;justify-content:space-between;gap:12px;padding:14px 16px;border-bottom:1px solid rgba(15,23,42,.08);background:#fff}
      .mn-title{display:flex;align-items:center;gap:10px;min-width:0}.mn-title i{width:34px;height:34px;border-radius:8px;display:flex;align-items:center;justify-content:center;background:rgba(6,118,71,.10);color:#067647}.mn-title strong{display:block;font-size:14px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.mn-title span{display:block;font-size:11px;font-weight:800;color:#667085;margin-top:2px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
      .mn-actions{display:flex;align-items:center;gap:8px;flex-wrap:wrap;justify-content:flex-end}
      .mn-btn,.mn-icon-btn{border:1px solid rgba(15,23,42,.12);background:#fff;color:#344054;border-radius:8px;min-height:34px;font-size:12px;font-weight:900;display:inline-flex;align-items:center;justify-content:center;gap:7px;cursor:pointer;transition:.16s ease}
      .mn-btn{padding:8px 11px}.mn-icon-btn{width:34px;padding:0}.mn-btn:hover:not(:disabled),.mn-icon-btn:hover:not(:disabled){border-color:rgba(6,118,71,.3);color:#067647;box-shadow:0 6px 16px rgba(15,23,42,.08)}
      .mn-btn.primary{background:#067647;border-color:#067647;color:#fff;box-shadow:0 12px 24px rgba(6,118,71,.16)}.mn-btn.danger{background:#fff;border-color:#fecdca;color:#b42318}.mn-btn:disabled,.mn-icon-btn:disabled{opacity:.55;cursor:not-allowed}
      .mn-tabs{display:flex;align-items:center;gap:7px;overflow:auto;padding:10px 16px 0;background:#f7f8fb;scrollbar-width:none}.mn-tabs::-webkit-scrollbar{display:none}
      .mn-tab{border:1px solid transparent;background:transparent;color:#667085;min-height:32px;padding:6px 9px;border-radius:8px;font-size:11px;font-weight:950;display:inline-flex;align-items:center;gap:6px;white-space:nowrap;cursor:pointer}.mn-tab.active{background:#fff;border-color:rgba(15,23,42,.1);color:#101828;box-shadow:0 5px 14px rgba(15,23,42,.06)}
      .mn-body{flex:1;min-height:0;overflow:auto;padding:14px 16px;display:flex;flex-direction:column;gap:14px}
      .mn-band{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:10px}.mn-stat{background:#fff;border:1px solid rgba(15,23,42,.08);border-radius:8px;padding:11px;min-width:0}.mn-stat span{display:block;font-size:10px;text-transform:uppercase;font-weight:1000;color:#667085}.mn-stat strong{display:block;margin-top:5px;font-size:19px;line-height:1.1;color:#101828;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.mn-stat small{display:block;margin-top:4px;font-size:11px;font-weight:800;color:#667085}.mn-stat.good strong{color:#067647}.mn-stat.warn strong{color:#b54708}.mn-stat.bad strong{color:#b42318}
      .mn-layout{display:grid;grid-template-columns:minmax(0,1.1fr) minmax(320px,.9fr);gap:14px;align-items:start}.mn-stack{display:flex;flex-direction:column;gap:14px;min-width:0}
      .mn-section{background:#fff;border:1px solid rgba(15,23,42,.08);border-radius:8px;overflow:hidden;min-width:0}.mn-section-head{padding:12px 13px;border-bottom:1px solid rgba(15,23,42,.08);display:flex;align-items:center;justify-content:space-between;gap:10px}.mn-section-head h3{margin:0;font-size:13px}.mn-section-head span{font-size:11px;font-weight:900;color:#667085}.mn-section-body{padding:12px;display:flex;flex-direction:column;gap:10px}
      .mn-row{display:flex;align-items:center;justify-content:space-between;gap:10px}.mn-muted{color:#667085;font-size:12px;font-weight:800}.mn-empty,.mn-state{padding:18px;color:#667085;font-size:12px;font-weight:850;text-align:center}.mn-state{height:100%;display:flex;align-items:center;justify-content:center;gap:8px}.mn-alert{border:1px solid #fedf89;background:#fffaeb;color:#93370d;border-radius:8px;padding:9px 11px;font-size:12px;font-weight:850}.mn-alert.error{border-color:#fecdca;background:#fef3f2;color:#b42318}.mn-spin{animation:fa-spin 1s linear infinite}
      .mn-status{display:inline-flex;width:max-content;max-width:100%;align-items:center;gap:5px;border-radius:999px;padding:4px 7px;font-size:10px;font-weight:1000;text-transform:capitalize;background:#f2f4f7;color:#344054;white-space:nowrap}.mn-status.paid,.mn-status.settled{background:#ecfdf3;color:#067647}.mn-status.partially_paid,.mn-status.partially_refunded,.mn-status.authorized{background:#eff8ff;color:#175cd3}.mn-status.due,.mn-status.open,.mn-status.pending{background:#fffaeb;color:#93370d}.mn-status.overdue,.mn-status.failed,.mn-status.refunded{background:#fef3f2;color:#b42318}.mn-status.scheduled,.mn-status.draft{background:#eef4ff;color:#3538cd}.mn-status.cancelled,.mn-status.void{background:#f2f4f7;color:#475467}
      .mn-progress{height:8px;background:#eef2f6;border-radius:999px;overflow:hidden}.mn-progress span{display:block;height:100%;background:#067647;border-radius:999px;min-width:0}
      .mn-table-wrap{overflow:auto}.mn-table{width:100%;border-collapse:collapse;table-layout:auto;min-width:620px}.mn-table.compact{min-width:420px}.mn-table th,.mn-table td{padding:8px 9px;border-bottom:1px solid rgba(15,23,42,.06);font-size:12px;text-align:left;vertical-align:middle}.mn-table th{font-size:10px;text-transform:uppercase;color:#667085;white-space:nowrap}.mn-table tr:last-child td{border-bottom:0}.mn-table td:last-child{text-align:right}
      .mn-form{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:9px}.mn-form label{display:flex;flex-direction:column;gap:4px;font-size:10px;text-transform:uppercase;font-weight:1000;color:#667085}.mn-input,.mn-select{width:100%;border:1px solid rgba(15,23,42,.12);border-radius:8px;padding:8px 9px;font-size:12px;font-weight:800;background:#fff;color:#101828;outline:none;box-sizing:border-box}.mn-input:focus,.mn-select:focus{border-color:rgba(6,118,71,.36);box-shadow:0 0 0 4px rgba(6,118,71,.10)}.mn-form .wide{grid-column:1/-1}.mn-form-actions{grid-column:1/-1;display:flex;align-items:center;justify-content:flex-end;gap:8px;flex-wrap:wrap}
      .mn-action-panel{border:1px solid rgba(6,118,71,.18);background:#f6fef9;border-radius:8px;padding:12px;display:flex;flex-direction:column;gap:10px}.mn-action-head{display:flex;align-items:center;justify-content:space-between;gap:10px}.mn-action-head strong{font-size:13px}.mn-alloc-grid{display:grid;grid-template-columns:minmax(0,1fr) 120px;gap:8px;align-items:end}
      .mn-left{height:100%;min-height:0;display:flex;flex-direction:column;gap:10px;color:#101828}.mn-left-head{padding:0 0 8px;border-bottom:1px solid rgba(15,23,42,.08);display:flex;align-items:center;justify-content:space-between;gap:8px}.mn-left-head strong{font-size:15px}.mn-left-head small{display:block;font-size:10px;font-weight:900;color:#667085;margin-top:2px}
      .mn-left-tabs{display:flex;gap:6px;overflow:auto;padding-bottom:2px;scrollbar-width:none}.mn-left-tabs::-webkit-scrollbar{display:none}.mn-left-tab{border:1px solid rgba(15,23,42,.12);background:#fff;color:#344054;border-radius:8px;min-height:30px;padding:6px 8px;font-size:11px;font-weight:950;white-space:nowrap;cursor:pointer}.mn-left-tab.active{border-color:rgba(6,118,71,.3);background:rgba(6,118,71,.08);color:#067647}
      .mn-left-totals{display:grid;grid-template-columns:1fr;gap:8px}.mn-left-total{border:1px solid rgba(15,23,42,.08);border-radius:8px;background:#fff;padding:9px}.mn-left-total span{display:block;font-size:10px;text-transform:uppercase;font-weight:1000;color:#667085}.mn-left-total strong{display:block;margin-top:3px;font-size:16px}.mn-left-total small{display:block;margin-top:3px;color:#667085;font-size:11px;font-weight:800}
      .mn-schedule-list{display:flex;flex-direction:column;gap:8px;min-height:0;overflow:auto}.mn-due-card{border:1px solid rgba(15,23,42,.08);border-radius:8px;background:#fff;padding:10px;display:flex;flex-direction:column;gap:7px}.mn-due-line{display:flex;align-items:flex-start;justify-content:space-between;gap:8px}.mn-due-line strong{font-size:12px}.mn-due-line span{font-size:12px;font-weight:1000}.mn-due-meta{font-size:11px;color:#667085;font-weight:800;line-height:1.35}.mn-due-card.overdue{border-color:#fecdca}.mn-due-card.due{border-color:#fedf89}
      @media (max-width:1120px){.mn-band{grid-template-columns:repeat(2,minmax(0,1fr))}.mn-layout{grid-template-columns:1fr}}
      @media (max-width:720px){.mn-top{align-items:flex-start}.mn-actions{width:100%;justify-content:flex-start}.mn-band,.mn-form{grid-template-columns:1fr}.mn-alloc-grid{grid-template-columns:1fr}.mn-table{min-width:560px}}
    `;
  }

  function injectCSS(){
    if (document.getElementById('money-tab-css')) return;
    const style = document.createElement('style');
    style.id = 'money-tab-css';
    style.textContent = css();
    document.head.appendChild(style);
  }

  async function loadData(){
    if (!apiReady()) {
      state.summary = null;
      state.ledger = [];
      state.events = [];
      state.error = 'Payments API is not available for this project.';
      renderAll();
      return;
    }
    state.loading = true;
    state.error = '';
    renderAll();
    try {
      const [summaryResult, ledgerResult, eventsResult] = await Promise.all([
        rootWindow.PaymentsAPI.projects.summary(orgId(), projectId()),
        rootWindow.PaymentsAPI.ledger?.list ? rootWindow.PaymentsAPI.ledger.list(orgId(), { project_id: projectId() }).catch(() => ({ ledger: [] })) : Promise.resolve({ ledger: [] }),
        rootWindow.PaymentsAPI.events?.list ? rootWindow.PaymentsAPI.events.list(orgId(), { project_id: projectId() }).catch(() => ({ events: [] })) : Promise.resolve({ events: [] })
      ]);
      state.summary = summaryResult.summary || null;
      state.ledger = ledgerResult.ledger || [];
      state.events = eventsResult.events || [];
      state.lastLoadedAt = new Date().toISOString();
      const schedules = state.summary?.schedules || [];
      if (state.activeScheduleId !== 'all' && !schedules.some((schedule) => cleanText(schedule.id) === state.activeScheduleId)) state.activeScheduleId = 'all';
    } catch (error) {
      state.error = error?.message || 'Could not load money.';
      state.summary = null;
      state.ledger = [];
      state.events = [];
    } finally {
      state.loading = false;
      renderAll();
    }
  }

  function obligations(){
    return Array.isArray(state.summary?.obligations) ? state.summary.obligations : [];
  }

  function payments(){
    return Array.isArray(state.summary?.payments) ? state.summary.payments : [];
  }

  function payables(){
    return Array.isArray(state.summary?.payables) ? state.summary.payables : [];
  }

  function filteredObligations(){
    if (state.activeScheduleId === 'all') return obligations();
    return obligations().filter((item) => cleanText(item.schedule_id) === state.activeScheduleId);
  }

  function scopedTotals(){
    const rows = filteredObligations();
    const total = rows.reduce((sum, item) => sum + cents(item.amount_cents), 0);
    const paid = rows.reduce((sum, item) => sum + cents(item.allocated_cents), 0);
    return {
      total: total || cents(state.summary?.project_total_cents),
      paid: paid || cents(state.summary?.total_collected_cents),
      remaining: total ? Math.max(0, total - paid) : cents(state.summary?.total_remaining_cents)
    };
  }

  function nextDue(){
    return obligations()
      .filter((item) => !['paid', 'void'].includes(cleanText(item.status)))
      .sort((a, b) => {
        const ad = cleanText(a.due_at) ? new Date(a.due_at).getTime() : Number.MAX_SAFE_INTEGER;
        const bd = cleanText(b.due_at) ? new Date(b.due_at).getTime() : Number.MAX_SAFE_INTEGER;
        return ad - bd;
      })[0] || null;
  }

  function progressBar(paid, total){
    const pct = total > 0 ? Math.max(0, Math.min(100, Math.round((paid / total) * 100))) : 0;
    return `<div class="mn-progress" title="${pct}%"><span style="width:${pct}%"></span></div>`;
  }

  function scheduleTabs(){
    const schedules = state.summary?.schedules || [];
    if (schedules.length <= 1) return '';
    return `
      <div class="mn-left-tabs">
        <button type="button" class="mn-left-tab${state.activeScheduleId === 'all' ? ' active' : ''}" data-money-schedule="all">All</button>
        ${schedules.map((schedule, index) => `<button type="button" class="mn-left-tab${state.activeScheduleId === cleanText(schedule.id) ? ' active' : ''}" data-money-schedule="${escapeHtml(schedule.id)}">${escapeHtml(schedule.title || `Proposal ${index + 1}`)}</button>`).join('')}
      </div>
    `;
  }

  function renderLeft(){
    if (!state.leftRoot) return;
    const target = leftContentRoot();
    if (!target) return;
    if (state.loading && !state.summary) {
      target.innerHTML = '<div class="mn-left"><div class="mn-state"><i class="fas fa-circle-notch fa-spin"></i><span>Loading schedule...</span></div></div>';
      return;
    }
    if (state.error && !state.summary) {
      target.innerHTML = `<div class="mn-left"><div class="mn-alert error">${escapeHtml(state.error)}</div></div>`;
      return;
    }
    const totals = scopedTotals();
    const remaining = Math.max(0, totals.remaining);
    const next = nextDue();
    const rows = filteredObligations();
    target.innerHTML = `
      <div class="mn-left">
        <div class="mn-left-head">
          <div><strong>Money</strong><small>${escapeHtml(state.project?.title || state.project?.address || 'Project schedule')}</small></div>
          <span class="mn-status ${remaining > 0 ? 'open' : 'paid'}">${remaining > 0 ? 'open' : 'paid'}</span>
        </div>
        ${scheduleTabs()}
        <div class="mn-left-totals">
          <div class="mn-left-total"><span>Total</span><strong>${money(totals.total)}</strong>${progressBar(totals.paid, totals.total)}<small>${money(totals.paid)} collected</small></div>
          <div class="mn-left-total"><span>Remaining</span><strong>${money(remaining)}</strong><small>${next ? `Next: ${escapeHtml(next.label || 'Payment')} ${shortDate(next.due_at) ? `on ${escapeHtml(shortDate(next.due_at))}` : ''}` : 'No open scheduled payments'}</small></div>
        </div>
        <div class="mn-schedule-list">
          ${rows.map(renderDueCard).join('') || '<div class="mn-empty">Signed proposals will create a payment schedule here.</div>'}
        </div>
      </div>
    `;
    bindLeft();
  }

  function leftContentRoot(){
    if (!state.leftRoot) return null;
    state.leftRoot.classList.add('visible', 'mode-edit');
    const label = state.leftRoot.querySelector('#rProposalLabel');
    if (label) {
      label.textContent = 'Money';
      label.hidden = true;
    }
    let list = state.leftRoot.querySelector('#rProposalList');
    if (!list) {
      state.leftRoot.innerHTML = `
        <div class="r-step-shell" style="grid-template-rows:1fr"><div class="r-step-inner"><div class="r-step-body">
          <label id="rProposalLabel" hidden>Money</label>
          <div class="r-proposal-listing" id="rProposalList"></div>
        </div></div></div>
      `;
      list = state.leftRoot.querySelector('#rProposalList');
    }
    return list;
  }

  function renderDueCard(item){
    const amount = cents(item.amount_cents);
    const paid = cents(item.allocated_cents);
    const remaining = Math.max(0, amount - paid);
    const status = statusClass(item.status || 'scheduled');
    const due = shortDate(item.due_at) || 'Not due yet';
    return `
      <div class="mn-due-card ${status}">
        <div class="mn-due-line"><strong>${escapeHtml(item.label || 'Payment')}</strong><span>${money(amount)}</span></div>
        ${progressBar(paid, amount)}
        <div class="mn-due-line"><em class="mn-status ${status}">${escapeHtml(titleText(item.status || 'scheduled'))}</em><span>${money(paid)} paid</span></div>
        <div class="mn-due-meta">${escapeHtml(due)}${item.due_rule ? ` - ${escapeHtml(titleText(item.due_rule))}` : ''}${remaining ? ` - ${money(remaining)} remaining` : ''}</div>
      </div>
    `;
  }

  function renderMain(){
    if (!state.panelRoot) return;
    const root = state.panelRoot.querySelector('[data-money-root]') || state.panelRoot;
    if (state.loading && !state.summary) {
      root.innerHTML = '<div class="mn-state"><i class="fas fa-circle-notch fa-spin"></i><span>Loading money...</span></div>';
      return;
    }
    if (state.error && !state.summary) {
      root.innerHTML = `<div class="mn-state"><i class="fas fa-triangle-exclamation"></i><span>${escapeHtml(state.error)}</span></div>`;
      return;
    }
    const summary = state.summary || {};
    root.innerHTML = `
      <div class="mn-top">
        <div class="mn-title"><i class="fas fa-dollar-sign"></i><div><strong>Money</strong><span>${escapeHtml(state.project?.address || state.project?.title || 'Project profitability')}</span></div></div>
        <div class="mn-actions">
          <span class="mn-muted">${state.lastLoadedAt ? `Updated ${escapeHtml(dateTime(state.lastLoadedAt))}` : ''}</span>
          <button type="button" class="mn-btn" data-money-refresh><i class="fas fa-rotate${state.loading ? ' mn-spin' : ''}"></i> Refresh</button>
        </div>
      </div>
      <div class="mn-tabs">
        ${viewTab('overview', 'fa-chart-line', 'Overview')}
        ${viewTab('payments', 'fa-money-check-dollar', 'Payments In')}
        ${viewTab('expenses', 'fa-receipt', 'Expenses Out')}
        ${viewTab('ledger', 'fa-scale-balanced', 'Ledger')}
      </div>
      <div class="mn-body">
        ${state.error ? `<div class="mn-alert error">${escapeHtml(state.error)}</div>` : ''}
        ${state.notice ? `<div class="mn-alert">${escapeHtml(state.notice)}</div>` : ''}
        ${kpiBand(summary)}
        ${renderActionPanel()}
        ${activeViewHtml(summary)}
      </div>
    `;
    bindMain(root);
  }

  function viewTab(id, icon, label){
    return `<button type="button" class="mn-tab${state.activeView === id ? ' active' : ''}" data-money-view="${escapeHtml(id)}"><i class="fas ${escapeHtml(icon)}"></i>${escapeHtml(label)}</button>`;
  }

  function kpiBand(summary){
    return `
      <div class="mn-band">
        ${stat('Projected Revenue', summary.projected_revenue_cents, '', `${payments().filter((item) => cleanText(item.direction) === 'inbound').length} payments`)}
        ${stat('Collected', summary.total_collected_cents, 'good', `${money(summary.total_remaining_cents || 0)} remaining`)}
        ${stat('Projected Expenses', summary.projected_expenses_cents, 'warn', `${money(summary.expenses_to_date_cents || 0)} paid to date`)}
        ${stat('Projected Profit', summary.projected_profit_cents, cents(summary.projected_profit_cents) >= 0 ? 'good' : 'bad', `To date: ${money(summary.profit_to_date_cents || 0)}`)}
      </div>
    `;
  }

  function activeViewHtml(summary){
    if (state.activeView === 'payments') return paymentsView(summary);
    if (state.activeView === 'expenses') return expensesView(summary);
    if (state.activeView === 'ledger') return ledgerView();
    return overviewView(summary);
  }

  function overviewView(summary){
    return `
      <div class="mn-layout">
        <div class="mn-stack">
          ${scheduleSection()}
          ${paymentHistorySection(5)}
        </div>
        <div class="mn-stack">
          ${profitabilitySection(summary)}
          ${expenseBreakdownSection(summary)}
          ${activitySection(5)}
        </div>
      </div>
    `;
  }

  function paymentsView(){
    return `
      <div class="mn-layout">
        <div class="mn-stack">
          ${recordPaymentSection()}
          ${paymentHistorySection()}
        </div>
        <div class="mn-stack">
          ${scheduleSection()}
          ${activitySection(8, ['payment.created', 'payment.refunded', 'payment.reallocated', 'payment_intent.created'])}
        </div>
      </div>
    `;
  }

  function expensesView(summary){
    return `
      <div class="mn-layout">
        <div class="mn-stack">
          ${payableSection()}
          ${payablesTableSection()}
        </div>
        <div class="mn-stack">
          ${expenseBreakdownSection(summary)}
          ${activitySection(8, ['payment_payable.created', 'payment_disbursement.created'])}
        </div>
      </div>
    `;
  }

  function ledgerView(){
    return `
      <div class="mn-layout">
        <div class="mn-stack">${ledgerSection()}</div>
        <div class="mn-stack">${activitySection(20)}</div>
      </div>
    `;
  }

  function stat(label, value, cls = '', sub = ''){
    return `<div class="mn-stat ${escapeHtml(cls)}"><span>${escapeHtml(label)}</span><strong>${money(value || 0)}</strong>${sub ? `<small>${escapeHtml(sub)}</small>` : ''}</div>`;
  }

  function profitabilitySection(summary){
    return `
      <div class="mn-section">
        <div class="mn-section-head"><h3>Profitability</h3><span>Project-wide</span></div>
        <div class="mn-section-body">
          <div class="mn-band">
            ${stat('Revenue To Date', summary.revenue_to_date_cents, 'good')}
            ${stat('Expenses To Date', summary.expenses_to_date_cents, 'warn')}
            ${stat('Profit To Date', summary.profit_to_date_cents, cents(summary.profit_to_date_cents) >= 0 ? 'good' : 'bad')}
            ${stat('Remaining Revenue', summary.total_remaining_cents)}
          </div>
        </div>
      </div>
    `;
  }

  function expenseBreakdownSection(summary){
    return `
      <div class="mn-section">
        <div class="mn-section-head"><h3>Expense Breakdown</h3><span>${money(summary.expenses_to_date_cents || 0)} paid</span></div>
        <div class="mn-section-body">
          <div class="mn-band">
            ${stat('Materials Projected', summary.materials?.projected_cents)}
            ${stat('Materials Paid', summary.materials?.paid_cents, 'warn')}
            ${stat('Crew Projected', summary.labor?.projected_cents)}
            ${stat('Crew Paid', summary.labor?.paid_cents, 'warn')}
          </div>
          <div class="mn-empty">Crew payroll pricing will appear here when crew compensation is implemented.</div>
        </div>
      </div>
    `;
  }

  function scheduleSection(){
    const rows = obligations();
    return `
      <div class="mn-section">
        <div class="mn-section-head"><h3>Payment Schedule</h3><span>${rows.length} scheduled payments</span></div>
        <div class="mn-section-body">${obligationTable(rows)}</div>
      </div>
    `;
  }

  function recordPaymentSection(){
    return `
      <div class="mn-section">
        <div class="mn-section-head"><h3>Customer Payment</h3><span>Inbound</span></div>
        <div class="mn-section-body">
          <form class="mn-form" data-money-payment-form>
            <label><span>Amount</span><input class="mn-input" name="amount" type="number" min="0" step="0.01" required></label>
            <label><span>Method</span><select class="mn-select" name="method"><option value="manual">Manual</option><option value="check">Check</option><option value="cash">Cash</option><option value="card">Card</option><option value="ach">ACH</option></select></label>
            <label><span>Action</span><select class="mn-select" name="mode"><option value="settled">Record settled payment</option><option value="intent">Create payment request</option></select></label>
            <label><span>Received</span><input class="mn-input" name="received_at" type="date"></label>
            <label class="wide"><span>Notes</span><input class="mn-input" name="notes" type="text"></label>
            <div class="mn-form-actions"><button type="submit" class="mn-btn primary" ${state.saving ? 'disabled' : ''}><i class="fas fa-plus"></i> Save Payment</button></div>
          </form>
        </div>
      </div>
    `;
  }

  function paymentHistorySection(limit = 0){
    const rows = payments().filter((item) => cleanText(item.direction) === 'inbound');
    const shown = limit ? rows.slice(0, limit) : rows;
    return `
      <div class="mn-section">
        <div class="mn-section-head"><h3>Payment History</h3><span>${rows.length} customer payments</span></div>
        <div class="mn-section-body">${paymentTable(shown, rows.length > shown.length)}</div>
      </div>
    `;
  }

  function paymentTable(rows, truncated = false){
    if (!rows.length) return '<div class="mn-empty">Customer payments will appear here as they are recorded.</div>';
    return `
      <div class="mn-table-wrap">
        <table class="mn-table">
          <thead><tr><th>Date</th><th>Method</th><th>Status</th><th>Amount</th><th>Refunded</th><th></th></tr></thead>
          <tbody>${rows.map((payment) => {
            const id = cleanText(payment.id);
            const status = statusClass(payment.status || 'settled');
            return `
              <tr>
                <td>${escapeHtml(shortDate(payment.received_at || payment.settled_at || payment.created_at) || '-')}</td>
                <td>${escapeHtml(titleText(payment.method?.label || payment.method?.type || payment.kind || 'Payment'))}</td>
                <td><span class="mn-status ${status}">${escapeHtml(titleText(payment.status || 'settled'))}</span></td>
                <td>${money(payment.amount_cents)}</td>
                <td>${money(payment.refunded_cents || 0)}</td>
                <td>
                  <button type="button" class="mn-icon-btn" title="Refund payment" data-money-action="refund" data-payment-id="${escapeHtml(id)}"><i class="fas fa-rotate-left"></i></button>
                  <button type="button" class="mn-icon-btn" title="Reallocate payment" data-money-action="reallocate" data-payment-id="${escapeHtml(id)}"><i class="fas fa-diagram-project"></i></button>
                </td>
              </tr>
            `;
          }).join('')}</tbody>
        </table>
      </div>
      ${truncated ? '<button type="button" class="mn-btn" data-money-view="payments">View All Payments</button>' : ''}
    `;
  }

  function obligationTable(rows){
    if (!rows.length) return '<div class="mn-empty">Signed proposals will create payment schedule rows here.</div>';
    return `
      <div class="mn-table-wrap">
        <table class="mn-table">
          <thead><tr><th>Payment</th><th>Due</th><th>Status</th><th>Amount</th><th>Paid</th><th>Remaining</th></tr></thead>
          <tbody>${rows.map((item) => {
            const amount = cents(item.amount_cents);
            const paid = cents(item.allocated_cents);
            const status = statusClass(item.status || 'scheduled');
            return `
              <tr>
                <td>${escapeHtml(item.label || 'Payment')}</td>
                <td>${escapeHtml(shortDate(item.due_at) || titleText(item.due_rule || 'Not due yet'))}</td>
                <td><span class="mn-status ${status}">${escapeHtml(titleText(item.status || 'scheduled'))}</span></td>
                <td>${money(amount)}</td>
                <td>${money(paid)}</td>
                <td>${money(Math.max(0, amount - paid))}</td>
              </tr>
            `;
          }).join('')}</tbody>
        </table>
      </div>
    `;
  }

  function payableSection(){
    return `
      <div class="mn-section">
        <div class="mn-section-head"><h3>Add Payable</h3><span>Outbound</span></div>
        <div class="mn-section-body">
          <form class="mn-form" data-money-payable-form>
            <label><span>Amount</span><input class="mn-input" name="amount" type="number" min="0" step="0.01" required></label>
            <label><span>Kind</span><select class="mn-select" name="kind"><option value="crew">Crew placeholder</option><option value="material_order">Material order</option><option value="reimbursement">Reimbursement</option><option value="other">Other</option></select></label>
            <label><span>Due Date</span><input class="mn-input" name="due_at" type="date"></label>
            <label><span>Vendor / Crew</span><input class="mn-input" name="vendor" type="text"></label>
            <label class="wide"><span>Notes</span><input class="mn-input" name="notes" type="text"></label>
            <div class="mn-form-actions"><button type="submit" class="mn-btn primary" ${state.saving ? 'disabled' : ''}><i class="fas fa-receipt"></i> Add Payable</button></div>
          </form>
        </div>
      </div>
    `;
  }

  function payablesTableSection(){
    const rows = payables();
    return `
      <div class="mn-section">
        <div class="mn-section-head"><h3>Payables</h3><span>${rows.length} expense items</span></div>
        <div class="mn-section-body">${payablesTable(rows)}</div>
      </div>
    `;
  }

  function payablesTable(rows){
    if (!rows.length) return '<div class="mn-empty">Crew payments, reimbursements, and other project payables will appear here.</div>';
    return `
      <div class="mn-table-wrap">
        <table class="mn-table">
          <thead><tr><th>Kind</th><th>Due</th><th>Status</th><th>Amount</th><th>Paid</th><th></th></tr></thead>
          <tbody>${rows.map((payable) => {
            const amount = cents(payable.amount_cents);
            const paid = cents(payable.paid_cents);
            const open = Math.max(0, amount - paid);
            const status = statusClass(payable.status || 'open');
            return `
              <tr>
                <td>${escapeHtml(titleText(payable.kind || 'Payable'))}</td>
                <td>${escapeHtml(shortDate(payable.due_at) || '-')}</td>
                <td><span class="mn-status ${status}">${escapeHtml(titleText(payable.status || 'open'))}</span></td>
                <td>${money(amount)}</td>
                <td>${money(paid)}</td>
                <td>${open ? `<button type="button" class="mn-btn" data-money-action="pay-payable" data-payable-id="${escapeHtml(payable.id)}">Pay ${escapeHtml(money(open))}</button>` : ''}</td>
              </tr>
            `;
          }).join('')}</tbody>
        </table>
      </div>
    `;
  }

  function ledgerSection(){
    const rows = state.ledger || [];
    return `
      <div class="mn-section">
        <div class="mn-section-head"><h3>Ledger</h3><span>${rows.length} entries</span></div>
        <div class="mn-section-body">${ledgerTable(rows)}</div>
      </div>
    `;
  }

  function ledgerTable(rows){
    if (!rows.length) return '<div class="mn-empty">Ledger entries will appear after payments, refunds, or disbursements are recorded.</div>';
    return `
      <div class="mn-table-wrap">
        <table class="mn-table">
          <thead><tr><th>Date</th><th>Event</th><th>Account</th><th>Debit</th><th>Credit</th></tr></thead>
          <tbody>${rows.flatMap((entry) => {
            const lines = Array.isArray(entry.lines) ? entry.lines : [];
            if (!lines.length) {
              return [`<tr><td>${escapeHtml(dateTime(entry.created_at))}</td><td>${escapeHtml(titleText(entry.event_type || 'Ledger'))}</td><td>-</td><td>${money(0)}</td><td>${money(0)}</td></tr>`];
            }
            return lines.map((line, index) => `
              <tr>
                <td>${index === 0 ? escapeHtml(dateTime(entry.created_at)) : ''}</td>
                <td>${index === 0 ? escapeHtml(titleText(entry.event_type || 'Ledger')) : ''}</td>
                <td>${escapeHtml(titleText(line.account || 'Account'))}</td>
                <td>${money(line.debit_cents || 0)}</td>
                <td>${money(line.credit_cents || 0)}</td>
              </tr>
            `);
          }).join('')}</tbody>
        </table>
      </div>
    `;
  }

  function activitySection(limit = 10, eventTypes = null){
    let rows = state.events || [];
    if (eventTypes) rows = rows.filter((event) => eventTypes.includes(cleanText(event.event_type)));
    const shown = rows.slice(0, limit);
    return `
      <div class="mn-section">
        <div class="mn-section-head"><h3>Activity</h3><span>${rows.length} events</span></div>
        <div class="mn-section-body">${activityList(shown)}</div>
      </div>
    `;
  }

  function activityList(rows){
    if (!rows.length) return '<div class="mn-empty">Money activity will appear here.</div>';
    return rows.map((event) => {
      const payload = event.payload || {};
      const amount = cents(payload.amount_cents);
      return `
        <div class="mn-row">
          <div><strong>${escapeHtml(titleText(event.event_type || 'Activity'))}</strong><div class="mn-muted">${escapeHtml(dateTime(event.created_at))}</div></div>
          <span class="mn-status scheduled">${amount ? escapeHtml(money(amount)) : 'event'}</span>
        </div>
      `;
    }).join('');
  }

  function renderActionPanel(){
    if (!state.action) return '';
    if (state.action.type === 'refund') return refundPanel(state.action.paymentId);
    if (state.action.type === 'reallocate') return reallocatePanel(state.action.paymentId);
    if (state.action.type === 'pay-payable') return payablePaymentPanel(state.action.payableId);
    return '';
  }

  function findPayment(id){
    return payments().find((payment) => cleanText(payment.id) === cleanText(id));
  }

  function findPayable(id){
    return payables().find((payable) => cleanText(payable.id) === cleanText(id));
  }

  function refundPanel(paymentId){
    const payment = findPayment(paymentId) || {};
    const available = Math.max(0, cents(payment.amount_cents) - cents(payment.refunded_cents));
    return `
      <div class="mn-action-panel">
        <div class="mn-action-head"><strong>Refund ${escapeHtml(money(available))}</strong><button type="button" class="mn-icon-btn" title="Close" data-money-action-close><i class="fas fa-xmark"></i></button></div>
        <form class="mn-form" data-money-refund-form data-payment-id="${escapeHtml(paymentId)}">
          <label><span>Amount</span><input class="mn-input" name="amount" type="number" min="0" step="0.01" value="${escapeHtml((available / 100).toFixed(2))}" required></label>
          <label><span>Reason</span><input class="mn-input" name="reason" type="text" value="Customer refund"></label>
          <div class="mn-form-actions"><button type="submit" class="mn-btn danger" ${state.saving ? 'disabled' : ''}><i class="fas fa-rotate-left"></i> Record Refund</button></div>
        </form>
      </div>
    `;
  }

  function reallocatePanel(paymentId){
    const payment = findPayment(paymentId) || {};
    return `
      <div class="mn-action-panel">
        <div class="mn-action-head"><strong>Reallocate ${escapeHtml(money(payment.amount_cents || 0))}</strong><button type="button" class="mn-icon-btn" title="Close" data-money-action-close><i class="fas fa-xmark"></i></button></div>
        <form class="mn-form" data-money-reallocate-form data-payment-id="${escapeHtml(paymentId)}">
          <div class="wide mn-muted">Enter the dollar amount to apply to each scheduled payment. Blank rows are ignored.</div>
          ${obligations().map((item) => `
            <div class="wide mn-alloc-grid">
              <label><span>${escapeHtml(item.label || 'Payment')} - ${escapeHtml(money(item.amount_cents || 0))}</span><input class="mn-input" name="alloc:${escapeHtml(item.id)}" type="number" min="0" step="0.01" placeholder="0.00"></label>
              <span class="mn-status ${statusClass(item.status || 'scheduled')}">${escapeHtml(titleText(item.status || 'scheduled'))}</span>
            </div>
          `).join('')}
          <div class="mn-form-actions"><button type="submit" class="mn-btn primary" ${state.saving ? 'disabled' : ''}><i class="fas fa-diagram-project"></i> Save Allocation</button></div>
        </form>
      </div>
    `;
  }

  function payablePaymentPanel(payableId){
    const payable = findPayable(payableId) || {};
    const open = Math.max(0, cents(payable.amount_cents) - cents(payable.paid_cents));
    return `
      <div class="mn-action-panel">
        <div class="mn-action-head"><strong>Pay ${escapeHtml(titleText(payable.kind || 'Payable'))}</strong><button type="button" class="mn-icon-btn" title="Close" data-money-action-close><i class="fas fa-xmark"></i></button></div>
        <form class="mn-form" data-money-disbursement-form data-payable-id="${escapeHtml(payableId)}">
          <label><span>Amount</span><input class="mn-input" name="amount" type="number" min="0" step="0.01" value="${escapeHtml((open / 100).toFixed(2))}" required></label>
          <label><span>Method</span><select class="mn-select" name="method"><option value="manual">Manual</option><option value="check">Check</option><option value="cash">Cash</option><option value="ach">ACH</option><option value="card">Card</option></select></label>
          <label class="wide"><span>Notes</span><input class="mn-input" name="notes" type="text"></label>
          <div class="mn-form-actions"><button type="submit" class="mn-btn primary" ${state.saving ? 'disabled' : ''}><i class="fas fa-paper-plane"></i> Record Payment Out</button></div>
        </form>
      </div>
    `;
  }

  function bindLeft(){
    state.leftRoot?.querySelectorAll?.('[data-money-schedule]').forEach((button) => {
      button.addEventListener('click', () => {
        state.activeScheduleId = button.dataset.moneySchedule || 'all';
        renderLeft();
      });
    });
  }

  function bindMain(root){
    root.querySelector('[data-money-refresh]')?.addEventListener('click', () => loadData());
    root.querySelectorAll('[data-money-view]').forEach((button) => {
      button.addEventListener('click', () => {
        state.activeView = button.dataset.moneyView || 'overview';
        state.action = null;
        renderMain();
      });
    });
    root.querySelectorAll('[data-money-action]').forEach((button) => {
      button.addEventListener('click', () => {
        state.action = { type: button.dataset.moneyAction, paymentId: button.dataset.paymentId || '', payableId: button.dataset.payableId || '' };
        renderMain();
      });
    });
    root.querySelector('[data-money-action-close]')?.addEventListener('click', () => {
      state.action = null;
      renderMain();
    });
    root.querySelector('[data-money-payment-form]')?.addEventListener('submit', submitPayment);
    root.querySelector('[data-money-refund-form]')?.addEventListener('submit', submitRefund);
    root.querySelector('[data-money-reallocate-form]')?.addEventListener('submit', submitReallocate);
    root.querySelector('[data-money-payable-form]')?.addEventListener('submit', submitPayable);
    root.querySelector('[data-money-disbursement-form]')?.addEventListener('submit', submitDisbursement);
  }

  async function withSave(work, successMessage){
    state.saving = true;
    state.error = '';
    state.notice = '';
    renderMain();
    try {
      await work();
      state.notice = successMessage || 'Saved.';
      showToast(state.notice, 'success');
      state.action = null;
      await loadData();
    } catch (error) {
      state.error = error?.message || 'Could not save money changes.';
      showToast(state.error, 'error');
      renderMain();
    } finally {
      state.saving = false;
      renderMain();
    }
  }

  async function submitPayment(event){
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    const amount = centsFromDollars(data.get('amount'));
    if (amount <= 0) return;
    await withSave(async () => {
      const mode = cleanText(data.get('mode')) || 'settled';
      const method = cleanText(data.get('method')) || 'manual';
      const payload = {
        project_id: projectId(),
        branch_id: branchId(),
        amount_cents: amount,
        kind: 'customer_payment',
        method: { type: method, label: titleText(method) },
        notes: cleanText(data.get('notes')),
        received_at: cleanText(data.get('received_at')),
        allocate: true
      };
      if (mode === 'intent') {
        await rootWindow.PaymentsAPI.intents.create(orgId(), { ...payload, provider: 'manual' });
      } else {
        await rootWindow.PaymentsAPI.payments.create(orgId(), { ...payload, direction: 'inbound', status: 'settled' });
      }
    }, 'Payment saved.');
  }

  async function submitRefund(event){
    event.preventDefault();
    const form = event.currentTarget;
    const data = new FormData(form);
    const amount = centsFromDollars(data.get('amount'));
    if (amount <= 0) return;
    await withSave(async () => {
      await rootWindow.PaymentsAPI.payments.refund(orgId(), form.dataset.paymentId, {
        amount_cents: amount,
        reason: cleanText(data.get('reason')) || 'Customer refund'
      });
    }, 'Refund recorded.');
  }

  async function submitReallocate(event){
    event.preventDefault();
    const form = event.currentTarget;
    const data = new FormData(form);
    const allocations = [];
    for (const [key, value] of data.entries()) {
      if (!key.startsWith('alloc:')) continue;
      const amount = centsFromDollars(value);
      if (amount > 0) allocations.push({ obligation_id: key.slice(6), amount_cents: amount });
    }
    if (!allocations.length) return;
    await withSave(async () => {
      await rootWindow.PaymentsAPI.payments.reallocate(orgId(), form.dataset.paymentId, {
        allocation_mode: 'manual',
        allocations
      });
    }, 'Payment allocation updated.');
  }

  async function submitPayable(event){
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    const amount = centsFromDollars(data.get('amount'));
    if (amount <= 0) return;
    await withSave(async () => {
      const vendor = cleanText(data.get('vendor'));
      await rootWindow.PaymentsAPI.payables.create(orgId(), {
        project_id: projectId(),
        branch_id: branchId(),
        amount_cents: amount,
        kind: cleanText(data.get('kind')) || 'other',
        due_at: cleanText(data.get('due_at')),
        notes: cleanText(data.get('notes')),
        vendor_ref: vendor ? { name: vendor } : {}
      });
    }, 'Payable added.');
  }

  async function submitDisbursement(event){
    event.preventDefault();
    const form = event.currentTarget;
    const data = new FormData(form);
    const amount = centsFromDollars(data.get('amount'));
    if (amount <= 0) return;
    await withSave(async () => {
      const method = cleanText(data.get('method')) || 'manual';
      await rootWindow.PaymentsAPI.disbursements.create(orgId(), {
        project_id: projectId(),
        branch_id: branchId(),
        payable_ids: [form.dataset.payableId].filter(Boolean),
        amount_cents: amount,
        kind: 'disbursement',
        method: { type: method, label: titleText(method) },
        notes: cleanText(data.get('notes'))
      });
    }, 'Payment out recorded.');
  }

  function setWorkspaceChrome(active){
    const overlay = state.context?.overlayRoot || state.context?.roots?.overlay || document.getElementById('rOverlay');
    if (!overlay) return;
    const activeTab = state.host?.getActivePreviewTab?.() || state.context?.activeTab || '';
    const setLeftOverride = typeof state.host?.setLeftColumnOverride === 'function' ? state.host.setLeftColumnOverride : null;
    if (active) {
      overlay.classList.add('money-workspace');
      if (setLeftOverride) setLeftOverride(true, 'money');
      else {
        overlay.classList.add('left-override');
        overlay.dataset.leftOverrideTab = 'money';
      }
      return;
    }
    overlay.classList.remove('money-workspace');
    if (setLeftOverride && activeTab !== 'money') setLeftOverride(false, 'money');
    else if (!setLeftOverride && activeTab !== 'money') {
      overlay.classList.remove('left-override');
      delete overlay.dataset.leftOverrideTab;
    }
  }

  function renderAll(){
    if (!state.active) return;
    renderMain();
    renderLeft();
  }

  function mount(context = {}){
    injectCSS();
    const nextProject = context.project || context.activeProject || context.entity || null;
    state.context = context;
    state.host = context.host || context.projectWorkspace || state.host;
    state.project = nextProject;
    state.panelRoot = context.panelRoot || context.roots?.main || context.root || state.panelRoot;
    state.leftRoot = context.leftRoot || context.roots?.left || state.leftRoot;
    state.active = context.active !== false;
    if (state.panelRoot && !state.panelRoot.querySelector('[data-money-root]')) state.panelRoot.innerHTML = panelHtml();
    setWorkspaceChrome(state.active);
    if (state.active) loadData();
    return api;
  }

  function setActive(active, context = null){
    if (context) mount({ ...state.context, ...context, active });
    state.active = !!active;
    setWorkspaceChrome(state.active);
    if (state.active) loadData();
    else {
      state.leftRoot?.querySelector?.('#rProposalList .mn-left')?.remove();
      const activeTab = state.host?.getActivePreviewTab?.() || state.context?.activeTab || '';
      if (activeTab !== 'money') state.leftRoot?.classList?.remove('visible', 'mode-edit', 'mode-list', 'mode-send');
    }
  }

  function reset(){
    state.summary = null;
    state.ledger = [];
    state.events = [];
    state.error = '';
    state.notice = '';
    state.activeScheduleId = 'all';
    state.activeView = 'overview';
    state.action = null;
  }

  function unmount(){
    setWorkspaceChrome(false);
    state.leftRoot?.querySelector?.('#rProposalList .mn-left')?.remove();
    state.active = false;
  }

  const api = {
    mount,
    setActive,
    activate: (context) => setActive(true, context),
    deactivate: () => setActive(false),
    reset,
    unmount,
    refresh: loadData,
    context: () => ({ mounted: !!state.panelRoot, active: state.active, projectId: projectId(), view: state.activeView })
  };

  Portal.modules = Portal.modules || {};
  Portal.modules.moneyTab = api;
  Portal.MoneyTab = api;

  function moneyEnabled(context = {}){
    if (context.moneyEnabled === false) return false;
    const flags = rootWindow.Portal?.appFlags || rootWindow.PlatformAPI?.appFlags;
    if (flags?.current?.()) {
      if (flags.has?.('platform', 'money')) return true;
      const value = flags.value?.('platform', 'money', undefined);
      return value === true;
    }
    return false;
  }

  runtime?.registerApp?.({
    id: 'project.money',
    kind: 'project_modal_app',
    title: 'Money',
    label: 'Money',
    icon: 'fa-dollar-sign',
    order: 60,
    visible: true,
    surfaces: ['project_modal'],
    regions: ['main', 'left'],
    requiresContext: ['project'],
    enabled: moneyEnabled,
    panelHtml,
    mount: (context = {}) => mount(context)
  });
})();
