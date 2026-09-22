/* public/libraries/apps/money/project.js
 * Project modal Money tab.
 */
(function(){
  const rootWindow = window;
  const runtime = rootWindow.FirstMateEmbeddableApps;
  const Portal = rootWindow.Portal = rootWindow.Portal || {};
  const rawShowToast = Portal?.ui?.showToast || rootWindow.showToast || (() => {});
  const MONEY_TERM_DEFAULTS = Object.freeze({
    workspace:'Money', overview:'Overview', invoices:'Invoices', recurring:'Recurring', expense_lists:'Expense Lists', receipts:'Receipts', commissions:'Commissions', reports:'Reports',
    ledger:'Ledger', payments:'Payments', expenses:'Expenses', activity:'Activity', transaction:'Transaction', transactions:'Transactions', receipt:'Receipt',
    money_in:'Money In', money_out:'Money Out', balance:'Balance', revenue:'Revenue', collected:'Collected', remaining:'Remaining', cost_forecast:'Cost Forecast', forecast_profit:'Forecast Profit', profit_to_date:'Profit To Date', payment_schedule:'Payment Schedule',
    collected_payment:'Collected Payment', collected_payments:'Collected Payments', scheduled_payment:'Scheduled Payment', scheduled_payments:'Scheduled Payments', add_collected_payment:'Add Collected Payment', save_collected_payment:'Save Collected Payment', take_collected_payment:'Take a Collected Payment',
    expense:'Expense', add_expense:'Add Expense', expense_list:'Expense List', recipient:'Recipient', invoice:'Invoice', invoice_history:'Invoice History', generate_invoice:'Generate Invoice', invoice_items:'Invoice Items', invoice_total:'Invoice Total',
    recurring_agreements:'Recurring Agreements', recurring_totals:'Recurring Totals', project_expenses:'Project Expenses', projected:'Projected', tracked_actual:'Tracked Actual', variance:'Variance', current_forecast:'Current Forecast',
    commission_payment:'Commission Payment', commission_payments:'Commission Payments', commission_recipient:'Commission Recipient', commission_recipients:'Commission Recipients', upcoming:'Upcoming', accrued:'Accrued', timing:'Timing'
  });

  function showToast(title, bodyOrStatus = '', okValue){
    const statusOnly = ['success', 'error'].includes(cleanText(bodyOrStatus).toLowerCase()) && okValue == null;
    const ok = statusOnly ? cleanText(bodyOrStatus).toLowerCase() === 'success' : !(okValue === false || cleanText(okValue).toLowerCase() === 'error');
    return rawShowToast(title, statusOnly ? '' : bodyOrStatus, ok);
  }

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
    events: [],
    invoices: [],
    invoiceSettings: { sales_tax_enabled:true, default_sales_tax_percent:0 },
    moneyTerms: { ...MONEY_TERM_DEFAULTS },
    reports: null,
    reportTemplates: [],
    reportGenerating: false,
    orgUsers: null,
    activeScheduleId: 'all',
    activeView: 'overview',
    ledgerFilters: { payments:true, expenses:true, activity:false },
    ledgerSort: { key:'date', direction:'desc' },
    ledgerDetailKey: '',
    action: null,
    paymentIntakeHandle: null,
    paymentIntakeConfig: null,
    autopay: null,
    autopayBusy: false,
    autopayError: '',
    autopayEnrollOpen: false,
    commissionHandle: null,
    receiptBrowserHandle: null,
    receiptReview: null,
    receiptBatch: null,
    actualEditKey: '',
    lastLoadedAt: '',
    loadSequence: 0,
    receiptOperationSequence: 0,
    receiptUploadToken: 0,
    receiptUploadInFlight: false,
    mutationToken: 0
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
    return new Intl.NumberFormat((globalThis.PlatformLanguage?.formatLocale?.("en-US") || "en-US"), {
      style: 'currency',
      currency: 'USD',
      minimumFractionDigits: hasCents ? 2 : 0,
      maximumFractionDigits: hasCents ? 2 : 0
    }).format(amount);
  }

  function shortDate(value){
    const text = cleanText(value);
    if (!text) return '';
    const dateOnly = text.match(/^(\d{4})-(\d{2})-(\d{2})$/);
    const date = dateOnly ? new Date(Number(dateOnly[1]), Number(dateOnly[2]) - 1, Number(dateOnly[3])) : new Date(text);
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

  function term(key, fallback = ''){
    return cleanText(state.moneyTerms?.[key], fallback, MONEY_TERM_DEFAULTS[key], titleText(key));
  }

  function canManageMoney(){
    const permissions = [
      state.context?.permissions,
      state.context?.user?.effective_permissions,
      state.context?.user?.permissions,
      Portal?.currentUser?.permissions,
      Portal?.permissions,
      rootWindow.__APP?.permissions
    ].find((candidate) => candidate && typeof candidate === 'object' && Object.keys(candidate).length);
    if (!permissions) return false;
    return permissions['*'] === true || permissions.manage_projects === true;
  }

  function canManageCommissions(){
    const permissions = [
      state.context?.permissions,
      state.context?.user?.effective_permissions,
      state.context?.user?.permissions,
      Portal?.currentUser?.permissions,
      Portal?.permissions,
      rootWindow.__APP?.permissions
    ].find((candidate) => candidate && typeof candidate === 'object' && Object.keys(candidate).length);
    return !!permissions && (permissions['*'] === true || permissions.manage_payroll === true || permissions.manage_company_settings === true);
  }

  function moneyMutationBusy(){
    return state.saving || state.receiptUploadInFlight;
  }

  function primaryContact(project = state.project){
    const contacts = Array.isArray(project?.contacts) ? project.contacts : [];
    return contacts.find((entry) => entry?.primary === true)
      || contacts.find((entry) => ['primary', 'customer'].includes(cleanText(entry?.role).toLowerCase()))
      || contacts.find((entry) => cleanText(entry?.name, entry?.email, entry?.phone))
      || null;
  }

  function customerEmail(project = state.project){
    const contacts = Array.isArray(project?.contacts) ? project.contacts : [];
    const primary = primaryContact(project);
    const customer = project?.customer && typeof project.customer === 'object' ? project.customer : {};
    const contactWithEmail = contacts.find((entry) => cleanText(entry?.email));
    return cleanText(
      primary?.email,
      customer?.email,
      project?.customer_email,
      project?.customerEmail,
      project?.primary_contact_email,
      project?.resident_email,
      project?.residentEmail,
      contactWithEmail?.email
    ).toLowerCase();
  }

  function apiReady(){
    return !!(rootWindow.PaymentsAPI?.projects && orgId() && projectId());
  }

  function panelHtml(){
    return `<div class="mn-app" data-money-root><div class="mn-state"><i class="fas fa-circle-notch fa-spin"></i><span>${(globalThis.PlatformLanguage?.text("money","m_487adb3f2ba511","Loading money...") ?? "Loading money...")}</span></div></div>`;
  }

  function css(){
    return `
      .mn-app{height:100%;min-height:0;display:flex;flex-direction:column;background:#f7f8fb;color:#101828;font-family:Inter,system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;position:relative}
      .r-overlay.money-workspace #rProposalSection.visible{min-height:0}
      .r-overlay.money-workspace #rProposalList{min-height:0;gap:0;flex:1 1 auto;height:100%;overflow:hidden}
      .r-overlay.money-workspace #rProposalSection .r-step-shell,.r-overlay.money-workspace #rProposalSection .r-step-inner,.r-overlay.money-workspace #rProposalSection .r-step-body{min-height:0;height:100%}
      .r-overlay.money-workspace #rProposalSection .r-step-body{display:flex;flex-direction:column;flex:1 1 auto}
      .mn-top{display:flex;align-items:center;justify-content:space-between;gap:12px;padding:14px 16px;border-bottom:1px solid rgba(15,23,42,.08);background:#fff}
      .mn-title{display:flex;align-items:center;gap:10px;min-width:0}.mn-title i{width:34px;height:34px;border-radius:8px;display:flex;align-items:center;justify-content:center;background:rgba(6,118,71,.10);color:#067647}.mn-title strong{display:block;font-size:14px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.mn-title span{display:block;font-size:11px;font-weight:800;color:#667085;margin-top:2px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
      .mn-actions{display:flex;align-items:center;gap:8px;flex-wrap:wrap;justify-content:flex-end}
      .mn-btn,.mn-icon-btn{border:1px solid rgba(15,23,42,.12);background:#fff;color:#344054;border-radius:8px;min-height:34px;font-size:12px;font-weight:900;display:inline-flex;align-items:center;justify-content:center;gap:7px;cursor:pointer;transition:.16s ease}
      .mn-btn{padding:8px 11px}.mn-icon-btn{width:34px;padding:0}.mn-btn:hover:not(:disabled),.mn-icon-btn:hover:not(:disabled){border-color:rgba(6,118,71,.3);color:#067647;box-shadow:0 6px 16px rgba(15,23,42,.08)}
      .mn-btn.primary{background:#067647;border-color:#067647;color:#fff;box-shadow:0 12px 24px rgba(6,118,71,.16)}.mn-btn.primary:hover:not(:disabled){background:#05603a;border-color:#05603a;color:#fff}.mn-btn.danger,.mn-icon-btn.danger{background:#fff;border-color:#fecdca;color:#b42318}.mn-btn:disabled,.mn-icon-btn:disabled{opacity:.55;cursor:not-allowed}
      .mn-btn.primary.mn-primary-action{background:var(--primary,#d93025);border-color:var(--primary,#d93025);color:var(--on-primary,#fff);box-shadow:0 12px 24px rgba(var(--primary-rgb,217,48,37),.18)}.mn-btn.primary.mn-primary-action:hover:not(:disabled){background:var(--primary-dark,var(--primary,#d93025));border-color:var(--primary-dark,var(--primary,#d93025));color:var(--on-primary,#fff)}
      .mn-tabs{display:flex;align-items:center;gap:7px;overflow:auto;padding:10px 16px 0;background:#f7f8fb;scrollbar-width:none}.mn-tabs::-webkit-scrollbar{display:none}
      .mn-tab{border:1px solid transparent;background:transparent;color:#667085;min-height:32px;padding:6px 9px;border-radius:8px;font-size:11px;font-weight:950;display:inline-flex;align-items:center;gap:6px;white-space:nowrap;cursor:pointer}.mn-tab.active{background:#fff;border-color:rgba(15,23,42,.1);color:#101828;box-shadow:0 5px 14px rgba(15,23,42,.06)}
      .mn-tab-label-compact{display:none}
      .mn-body{flex:1;min-height:0;overflow:auto;padding:14px 16px;display:flex;flex-direction:column;gap:14px}
      .mn-band{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:10px}.mn-stat{background:#fff;border:1px solid rgba(15,23,42,.08);border-radius:8px;padding:11px;min-width:0}.mn-stat span{display:block;font-size:10px;text-transform:uppercase;font-weight:1000;color:#667085}.mn-stat strong{display:block;margin-top:5px;font-size:19px;line-height:1.1;color:#101828;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.mn-stat small{display:block;margin-top:4px;font-size:11px;font-weight:800;color:#667085}.mn-stat.good strong{color:#067647}.mn-stat.warn strong{color:#b54708}.mn-stat.bad strong{color:#b42318}
      .mn-layout{display:grid;grid-template-columns:minmax(0,1.1fr) minmax(320px,.9fr);gap:14px;align-items:start}.mn-stack{display:flex;flex-direction:column;gap:14px;min-width:0}
      .mn-overview-layout{grid-template-columns:minmax(0,1.45fr) minmax(260px,.55fr)}
      .mn-entry-stack{position:sticky;top:0}.mn-compact-entry .mn-section-body{padding:10px}.mn-compact-entry .mn-form{gap:7px}.mn-compact-entry .mn-form-actions .mn-btn{width:100%}
      .mn-section{background:#fff;border:1px solid rgba(15,23,42,.08);border-radius:8px;overflow:hidden;min-width:0}.mn-section-head{padding:12px 13px;border-bottom:1px solid rgba(15,23,42,.08);display:flex;align-items:center;justify-content:space-between;gap:10px}.mn-section-head h3{margin:0;font-size:13px}.mn-section-head span{font-size:11px;font-weight:900;color:#667085}.mn-section-body{padding:12px;display:flex;flex-direction:column;gap:10px}
      .mn-ledger-head{padding:11px 12px;border-bottom:1px solid rgba(15,23,42,.08);display:flex;align-items:center;justify-content:space-between;gap:12px;flex-wrap:wrap}.mn-ledger-head h3{margin:0;font-size:13px}.mn-ledger-head>div:first-child>span{display:block;margin-top:2px;color:#667085;font-size:10px;font-weight:850}.mn-ledger-filters{display:flex;align-items:center;gap:5px;flex-wrap:wrap}.mn-ledger-filter{border:1px solid #d0d5dd;background:#fff;color:#667085;border-radius:999px;padding:5px 8px;font-size:10px;font-weight:950;display:inline-flex;align-items:center;gap:5px;cursor:pointer}.mn-ledger-filter.active{border-color:rgba(6,118,71,.28);background:#ecfdf3;color:#067647}.mn-ledger-scroll{max-height:max(440px,calc(100vh - 250px));overflow:auto}.mn-ledger-table{min-width:790px}.mn-ledger-table thead{position:sticky;top:0;background:#fff;z-index:2}.mn-ledger-table th:nth-child(5),.mn-ledger-table th:nth-child(6),.mn-ledger-table th:nth-child(7),.mn-ledger-table td:nth-child(5),.mn-ledger-table td:nth-child(6),.mn-ledger-table td:nth-child(7){text-align:right}.mn-ledger-item{border:0;background:transparent;padding:0;display:flex;align-items:center;gap:8px;text-align:left;color:#101828;cursor:pointer;min-width:0}.mn-ledger-item:disabled{cursor:default}.mn-ledger-item>i{width:26px;height:26px;border-radius:7px;background:#f2f4f7;color:#475467;display:grid;place-items:center;font-size:9px;flex:0 0 auto}.mn-ledger-item span{min-width:0}.mn-ledger-item strong,.mn-ledger-item small{display:block;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.mn-ledger-item strong{font-size:11px}.mn-ledger-item small{margin-top:2px;color:#667085;font-size:9px;font-weight:800}.mn-ledger-row:not(.activity) .mn-ledger-item:hover strong{color:#067647;text-decoration:underline}.mn-ledger-row.activity{background:#fafafa}.mn-ledger-row.activity .mn-ledger-item>i{background:#eef4ff;color:#3538cd}.mn-ledger-receipt{text-align:center!important}.mn-ledger-receipt .mn-icon-btn{width:29px;min-height:29px;color:#6941c6}.mn-no-receipt{color:#c4c9d1}.mn-ledger-money,.mn-ledger-balance{font-weight:950;white-space:nowrap}.mn-ledger-money.in{color:#067647}.mn-ledger-money.out{color:#b42318}.mn-ledger-detail-row td{padding:0!important;background:#f8fafc}.mn-ledger-detail{padding:11px 13px 12px 47px;border-bottom:1px solid #e4e7ec}.mn-ledger-facts{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:8px}.mn-ledger-facts div{min-width:0}.mn-ledger-facts span,.mn-ledger-facts strong{display:block}.mn-ledger-facts span{font-size:8px;text-transform:uppercase;color:#667085;font-weight:1000}.mn-ledger-facts strong{margin-top:2px;font-size:10px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.mn-ledger-detail p{margin:9px 0 0;font-size:10px;color:#475467}.mn-ledger-receipts{display:flex;gap:6px;flex-wrap:wrap;margin-top:9px}
      .mn-ledger-sort{border:0;background:transparent;color:inherit;padding:0;display:inline-flex;align-items:center;gap:5px;font:inherit;text-transform:inherit;cursor:pointer}.mn-ledger-sort:hover,.mn-ledger-sort.active{color:#067647}.mn-ledger-sort i{font-size:8px;color:#98a2b3}.mn-ledger-sort.active i{color:#067647}.mn-ledger-sort.end{margin-left:auto}
      .mn-ledger-table th:nth-child(7){padding-right:0}.mn-ledger-table th:last-child{width:0;padding:0}.mn-ledger-table td:last-child{width:1%;padding-left:4px;padding-right:4px}
      .mn-row{display:flex;align-items:center;justify-content:space-between;gap:10px}.mn-muted{color:#667085;font-size:12px;font-weight:800}.mn-empty,.mn-state{padding:18px;color:#667085;font-size:12px;font-weight:850;text-align:center}.mn-state{height:100%;display:flex;align-items:center;justify-content:center;gap:8px}.mn-alert{border:1px solid #fedf89;background:#fffaeb;color:#93370d;border-radius:8px;padding:9px 11px;font-size:12px;font-weight:850}.mn-alert.error{border-color:#fecdca;background:#fef3f2;color:#b42318}.mn-spin{animation:fa-spin 1s linear infinite}
      .mn-history-list{display:flex;flex-direction:column}.mn-history-row{display:grid;grid-template-columns:30px minmax(0,1fr) auto;gap:9px;align-items:center;padding:10px 11px;border-bottom:1px solid rgba(15,23,42,.07)}.mn-history-row:last-child{border-bottom:0}.mn-history-icon{width:30px;height:30px;border-radius:8px;display:grid;place-items:center;background:#eef4ff;color:#3538cd;font-size:11px}.mn-history-icon.good{background:#ecfdf3;color:#067647}.mn-history-icon.bad{background:#fef3f2;color:#b42318}.mn-history-icon.warn{background:#fffaeb;color:#b54708}.mn-history-copy{min-width:0}.mn-history-copy strong{display:block;font-size:11px;color:#101828;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.mn-history-copy small{display:block;margin-top:2px;color:#667085;font-size:9px;font-weight:800;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.mn-history-side{display:flex;align-items:center;justify-content:flex-end;gap:6px;white-space:nowrap}.mn-history-amount{font-size:12px;font-weight:1000;color:#101828}.mn-history-amount.good{color:#067647}.mn-history-amount.bad{color:#b42318}.mn-history-side .mn-icon-btn{width:28px;min-height:28px;font-size:10px}.mn-history-footer{padding:9px 11px;display:flex;justify-content:flex-end;border-top:1px solid rgba(15,23,42,.07)}
      .mn-status{display:inline-flex;width:max-content;max-width:100%;align-items:center;gap:5px;border-radius:999px;padding:4px 7px;font-size:10px;font-weight:1000;text-transform:capitalize;background:#f2f4f7;color:#344054;white-space:nowrap}.mn-status.paid,.mn-status.settled{background:#ecfdf3;color:#067647}.mn-status.partially_paid,.mn-status.partially_refunded,.mn-status.authorized{background:#eff8ff;color:#175cd3}.mn-status.due,.mn-status.open,.mn-status.pending{background:#fffaeb;color:#93370d}.mn-status.overdue,.mn-status.failed,.mn-status.refunded{background:#fef3f2;color:#b42318}.mn-status.scheduled,.mn-status.draft{background:#eef4ff;color:#3538cd}.mn-status.cancelled,.mn-status.void{background:#f2f4f7;color:#475467}
      .mn-table-wrap{overflow:auto}.mn-table{width:100%;border-collapse:collapse;table-layout:auto;min-width:620px}.mn-table.compact{min-width:420px}.mn-table th,.mn-table td{padding:8px 9px;border-bottom:1px solid rgba(15,23,42,.06);font-size:12px;text-align:left;vertical-align:middle}.mn-table th{font-size:10px;text-transform:uppercase;color:#667085;white-space:nowrap}.mn-table tr:last-child td{border-bottom:0}.mn-table td:last-child{text-align:right}
      .mn-ledger-scroll{overflow-x:hidden}.mn-ledger-table{width:100%;min-width:0;table-layout:fixed}.mn-ledger-table th:nth-child(1){width:70px}.mn-ledger-table th:nth-child(2),.mn-ledger-table td:nth-child(2){width:32%;max-width:300px;overflow:hidden}.mn-ledger-table th:nth-child(3){width:82px}.mn-ledger-table th:nth-child(4){width:54px}.mn-ledger-table th:nth-child(5),.mn-ledger-table th:nth-child(6){width:72px}.mn-ledger-table th:nth-child(7){width:84px}.mn-ledger-table th:nth-child(8){width:32px}.mn-ledger-item{width:100%;max-width:100%;overflow:hidden}
      .mn-invoice-history{display:flex;flex-direction:column;gap:6px}.mn-invoice-history-card{border:1px solid rgba(15,23,42,.09);border-radius:8px;padding:8px;background:#fff;display:flex;flex-direction:column;gap:7px}.mn-invoice-history-top,.mn-invoice-history-bottom{display:flex;align-items:center;justify-content:space-between;gap:8px;min-width:0}.mn-invoice-history-copy{display:flex;align-items:baseline;gap:6px;min-width:0}.mn-invoice-history-copy strong{font-size:11px;white-space:nowrap}.mn-invoice-history-copy span{color:#667085;font-size:9px;font-weight:800;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.mn-invoice-history-amount{font-size:12px;white-space:nowrap}.mn-invoice-history-meta{display:flex;align-items:center;gap:5px;min-width:0;color:#667085;font-size:9px;font-weight:850;white-space:nowrap;overflow:hidden}.mn-invoice-history-meta>span:not(.mn-status){overflow:hidden;text-overflow:ellipsis}.mn-invoice-history-bottom .mn-actions{gap:5px;flex-wrap:nowrap}.mn-invoice-history-bottom .mn-btn{min-height:30px;padding:5px 7px;font-size:10px}.mn-invoice-history-bottom .mn-icon-btn{width:30px;min-height:30px}.mn-invoice-generate-actions{grid-column:1/-1;display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:8px}.mn-invoice-generate-actions .mn-btn{min-height:40px}.mn-invoice-date-row{grid-column:1/-1;display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:9px;align-items:end}
      .mn-invoice-items{grid-column:1/-1;border:1px solid #e4e7ec;border-radius:9px;overflow:hidden}.mn-invoice-items-head{display:flex;align-items:center;justify-content:space-between;gap:10px;padding:9px 10px;background:#f9fafb;border-bottom:1px solid #e4e7ec}.mn-invoice-items-head strong{font-size:11px}.mn-invoice-item-picker{padding:8px;border-bottom:1px solid #e4e7ec;background:#fff}.mn-invoice-picker-list{display:flex;flex-direction:column;gap:5px;max-height:170px;overflow:auto}.mn-invoice-picker-choice{display:flex;align-items:center;justify-content:space-between;gap:10px;width:100%;border:1px solid #e4e7ec;border-radius:7px;background:#fff;padding:8px;text-align:left;cursor:pointer}.mn-invoice-picker-choice:hover{border-color:rgba(6,118,71,.3);background:#f6fef9}.mn-invoice-picker-choice strong{display:block;font-size:11px}.mn-invoice-picker-choice span{display:block;color:#667085;font-size:10px;font-weight:800}.mn-invoice-lines{display:flex;flex-direction:column}.mn-invoice-line{display:grid;grid-template-columns:minmax(0,1fr) 130px 32px;gap:7px;align-items:end;padding:8px 9px;border-bottom:1px solid #f0f2f5}.mn-invoice-line:last-child{border-bottom:0}.mn-invoice-line .mn-input[readonly]{background:#f9fafb;color:#475467}.mn-invoice-line-remove{width:32px;height:34px;border:0;background:transparent;color:#b42318;cursor:pointer;border-radius:7px}.mn-invoice-line-remove:hover{background:#fef3f2}.mn-invoice-empty{padding:16px;text-align:center;color:#667085;font-size:11px;font-weight:800}.mn-invoice-total-box{grid-column:1/-1;margin-left:auto;width:min(300px,100%);display:flex;flex-direction:column;gap:5px}.mn-invoice-total-row{display:flex;justify-content:space-between;gap:15px;font-size:12px;font-weight:850;color:#475467}.mn-invoice-total-row.grand{border-top:1px solid #d0d5dd;padding-top:8px;margin-top:3px;font-size:16px;color:#101828}.mn-invoice-tax-row{grid-column:1/-1;display:grid;grid-template-columns:minmax(0,1fr) 130px;gap:9px;align-items:end;border:1px solid #e4e7ec;border-radius:9px;padding:9px 10px}.mn-invoice-tax-toggle{display:flex!important;flex-direction:row!important;align-items:center;justify-content:space-between;gap:10px;text-transform:none!important;font-size:12px!important;color:#344054!important}.mn-invoice-tax-toggle .mn-switch-control{min-height:22px}
      .mn-layout.mn-invoice-layout{grid-template-columns:minmax(0,1fr) minmax(260px,330px)}.mn-invoice-layout .mn-invoice-generate-column{grid-column:1;grid-row:1}.mn-invoice-layout .mn-invoice-history-column{grid-column:2;grid-row:1}
      .mn-form{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:9px}.mn-form label{display:flex;flex-direction:column;gap:4px;font-size:10px;text-transform:uppercase;font-weight:1000;color:#667085}.mn-form label.mn-check{flex-direction:row;align-items:center;text-transform:none;font-size:12px;color:#344054}.mn-form label.mn-check input{width:auto}.mn-switch-field{justify-content:flex-end}.mn-switch-control{min-height:34px;display:flex;align-items:center}.mn-switch-control input{position:absolute;width:1px;height:1px;opacity:0}.mn-switch-track{width:40px;height:22px;padding:2px;border-radius:999px;background:#d0d5dd;box-sizing:border-box;cursor:pointer;transition:background .16s ease}.mn-switch-track span{display:block;width:18px;height:18px;border-radius:50%;background:#fff;box-shadow:0 1px 3px rgba(16,24,40,.3);transition:transform .16s ease}.mn-switch-control input:checked+.mn-switch-track{background:#067647}.mn-switch-control input:checked+.mn-switch-track span{transform:translateX(18px)}.mn-switch-control input:focus-visible+.mn-switch-track{box-shadow:0 0 0 4px rgba(6,118,71,.14)}.mn-input,.mn-select{width:100%;border:1px solid rgba(15,23,42,.12);border-radius:8px;padding:8px 9px;font-size:12px;font-weight:800;background:#fff;color:#101828;outline:none;box-sizing:border-box}.mn-input:focus,.mn-select:focus{border-color:rgba(6,118,71,.36);box-shadow:0 0 0 4px rgba(6,118,71,.10)}.mn-form .wide{grid-column:1/-1}.mn-form-actions{grid-column:1/-1;display:flex;align-items:center;justify-content:flex-end;gap:8px;flex-wrap:wrap}
      .mn-action-panel{border:1px solid rgba(6,118,71,.18);background:#f6fef9;border-radius:8px;padding:12px;display:flex;flex-direction:column;gap:10px}.mn-action-head{display:flex;align-items:center;justify-content:space-between;gap:10px}.mn-action-head strong{font-size:13px}.mn-alloc-grid{display:grid;grid-template-columns:minmax(0,1fr) 120px;gap:8px;align-items:end}
      .mn-expense-totals{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:8px}.mn-expense-list{display:flex;flex-direction:column;gap:9px}.mn-expense-group{border:1px solid rgba(15,23,42,.09);border-radius:8px;overflow:hidden;background:#fff}.mn-expense-group.shared{border-color:rgba(124,58,237,.25)}.mn-expense-group-head{display:flex;align-items:flex-start;justify-content:space-between;gap:12px;padding:10px 11px;background:#f9fafb;border-bottom:1px solid rgba(15,23,42,.07)}.mn-expense-group-head>div{min-width:0}.mn-expense-group-head strong{font-size:12px}.mn-expense-group-head span{display:block;margin-top:2px;font-size:10px;color:#667085;font-weight:800}.mn-expense-group>summary.mn-expense-group-head{display:grid;grid-template-columns:18px minmax(0,1fr) auto;align-items:center;border-bottom:0;cursor:pointer;list-style:none;user-select:none}.mn-expense-group>summary.mn-expense-group-head::-webkit-details-marker{display:none}.mn-expense-group>summary.mn-expense-group-head:hover{background:#f4f6f8}.mn-expense-group>summary.mn-expense-group-head:focus-visible{outline:2px solid rgba(6,118,71,.42);outline-offset:-2px}.mn-expense-group[open]>summary.mn-expense-group-head{border-bottom:1px solid rgba(15,23,42,.07)}.mn-expense-group-chevron{width:7px;height:7px;border-right:2px solid #667085;border-bottom:2px solid #667085;transform:rotate(-45deg);transition:transform .16s ease}.mn-expense-group[open] .mn-expense-group-chevron{transform:rotate(45deg)}.mn-expense-group-amount{text-align:right;white-space:nowrap}.mn-expense-group-amount strong{display:block;font-size:16px;color:#101828}.mn-expense-group-amount small{display:block;margin-top:2px;color:#667085;font-size:10px;font-weight:850}.mn-expense-target{display:grid;grid-template-columns:minmax(0,1fr) auto auto;align-items:center;gap:10px;padding:8px 11px;border-bottom:1px solid #f0f2f5}.mn-expense-target:last-child{border-bottom:0}.mn-expense-target-name{display:flex;align-items:center;gap:8px;min-width:0}.mn-expense-dot{width:8px;height:8px;border-radius:999px;flex:0 0 auto;background:var(--expense-color,#64748b)}.mn-expense-target-name div{min-width:0}.mn-expense-target-name strong{display:block;font-size:11px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.mn-expense-target-name span{display:block;font-size:9px;color:#667085;font-weight:750;margin-top:1px}.mn-expense-target-amount{text-align:right}.mn-expense-target-amount strong{display:block;font-size:11px}.mn-expense-target-amount small{display:block;font-size:9px;color:#667085}.mn-link-btn{border:0;background:transparent;color:#175cd3;font-size:10px;font-weight:950;cursor:pointer;padding:4px}.mn-receipt-chips{display:flex;gap:5px;flex-wrap:wrap;padding:7px 11px;background:#faf8ff;border-top:1px solid rgba(124,58,237,.09)}.mn-receipt-chip{display:inline-flex;align-items:center;gap:5px;border:1px solid rgba(124,58,237,.16);background:#fff;color:#6941c6;border-radius:999px;padding:4px 7px;font-size:9px;font-weight:900;text-decoration:none}.mn-labor-mini{margin-top:4px;color:#667085;font-size:9px;font-weight:750}.mn-receipt-browser{height:max(560px,calc(100vh - 230px));min-height:0;border:1px solid rgba(15,23,42,.08);border-radius:8px;background:#fff;overflow:hidden}.mn-receipt-browser .pf-wrap{padding:12px}
      .mn-modal-shade{position:absolute;inset:0;z-index:80;background:rgba(16,24,40,.48);backdrop-filter:blur(3px);display:flex;align-items:center;justify-content:center;padding:18px}.mn-receipt-modal{width:min(980px,100%);max-height:min(760px,calc(100% - 12px));overflow:auto;background:#fff;border-radius:12px;box-shadow:0 30px 90px rgba(15,23,42,.28);display:flex;flex-direction:column}.mn-receipt-modal-head{display:flex;align-items:center;justify-content:space-between;gap:10px;padding:13px 15px;border-bottom:1px solid #eaecf0;position:sticky;top:0;background:#fff;z-index:2}.mn-receipt-modal-head strong{font-size:14px}.mn-invoice-email-modal{width:min(520px,100%);max-height:min(640px,calc(100% - 12px));overflow:auto;background:#fff;border-radius:12px;box-shadow:0 30px 90px rgba(15,23,42,.28)}.mn-invoice-email-modal .mn-form{padding:15px}.mn-invoice-email-modal .mn-form-actions{padding-top:3px}.mn-receipt-modal-body{display:grid;grid-template-columns:minmax(0,.9fr) minmax(300px,1.1fr);min-height:360px}.mn-receipt-review{min-width:0;padding:14px;border-right:1px solid #eaecf0;display:flex;flex-direction:column;gap:11px}.mn-receipt-targets{min-width:0;padding:14px;display:flex;flex-direction:column;gap:8px}.mn-receipt-target-choice{min-width:0;display:grid;grid-template-columns:auto minmax(0,1fr) auto;align-items:center;gap:9px;border:1px solid #eaecf0;border-radius:8px;padding:9px;cursor:pointer;overflow:hidden}.mn-receipt-target-choice:has(input:checked){border-color:rgba(6,118,71,.32);background:#f6fef9}.mn-receipt-target-choice>span{min-width:0;display:flex;flex-direction:column;gap:2px}.mn-receipt-target-choice>span>strong,.mn-receipt-target-choice>span>span{display:block;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.mn-receipt-target-choice strong{font-size:11px}.mn-receipt-target-choice span{font-size:10px;color:#667085;font-weight:800}.mn-receipt-target-choice>strong:last-child{white-space:nowrap}.mn-receipt-loading{min-height:360px;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:12px;color:#475467;font-weight:900}.mn-receipt-loading i{font-size:28px;color:#067647}.mn-file-summary{border:1px solid #eaecf0;background:#f9fafb;border-radius:8px;padding:10px;display:flex;align-items:center;gap:9px}.mn-file-summary i{font-size:20px;color:#b54708}.mn-file-summary div{min-width:0}.mn-file-summary strong,.mn-file-summary span{display:block;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.mn-file-summary strong{font-size:11px}.mn-file-summary span{font-size:9px;color:#667085;margin-top:2px}.mn-receipt-modal-foot{display:flex;align-items:center;justify-content:space-between;gap:10px;padding:12px 15px;border-top:1px solid #eaecf0;position:sticky;bottom:0;background:#fff}.mn-receipt-lines{border-top:1px solid #eaecf0;padding-top:8px}.mn-receipt-lines summary{font-size:10px;font-weight:950;cursor:pointer;color:#475467}.mn-receipt-lines div{display:flex;justify-content:space-between;gap:8px;padding-top:5px;font-size:10px;color:#667085}
      .mn-receipt-batch-modal{width:min(860px,100%);max-height:min(760px,calc(100% - 12px));overflow:auto;background:#fff;border-radius:12px;box-shadow:0 30px 90px rgba(15,23,42,.28)}.mn-receipt-batch-summary{display:flex;align-items:center;gap:8px;padding:11px 15px;background:#f8fafc;border-bottom:1px solid #eaecf0;color:#475467;font-size:11px;font-weight:900}.mn-receipt-batch-list{display:grid;gap:9px;padding:14px}.mn-receipt-batch-item{display:grid;grid-template-columns:auto minmax(0,1fr) auto;align-items:center;gap:11px;border:1px solid #e4e7ec;border-radius:10px;padding:11px;background:#fff}.mn-receipt-batch-icon{width:36px;height:36px;border-radius:9px;display:grid;place-items:center;background:#f2f4f7;color:#667085}.mn-receipt-batch-item.ready .mn-receipt-batch-icon{background:#ecfdf3;color:#067647}.mn-receipt-batch-item.error .mn-receipt-batch-icon{background:#fef3f2;color:#b42318}.mn-receipt-batch-copy{min-width:0}.mn-receipt-batch-copy strong,.mn-receipt-batch-copy span{display:block;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.mn-receipt-batch-copy strong{font-size:11px}.mn-receipt-batch-copy span{margin-top:3px;color:#667085;font-size:9px;font-weight:850}.mn-receipt-batch-match{margin-top:5px;color:#067647!important}.mn-receipt-batch-item .mn-btn{white-space:nowrap}
      .mn-left{height:100%;min-height:0;display:flex;flex-direction:column;gap:10px;color:#101828}.mn-left-head{padding:0 0 8px;border-bottom:1px solid rgba(15,23,42,.08);display:flex;align-items:center;justify-content:space-between;gap:8px}.mn-left-head strong{font-size:15px}.mn-left-head small{display:block;font-size:10px;font-weight:900;color:#667085;margin-top:2px}
      .mn-left-tabs{display:flex;gap:5px;overflow:auto;padding:8px 9px;border-bottom:1px solid rgba(15,23,42,.07);scrollbar-width:none}.mn-left-tabs::-webkit-scrollbar{display:none}.mn-left-tab{border:1px solid rgba(15,23,42,.12);background:#fff;color:#344054;border-radius:7px;min-height:27px;padding:4px 7px;font-size:10px;font-weight:950;white-space:nowrap;cursor:pointer}.mn-left-tab.active{border-color:rgba(6,118,71,.3);background:rgba(6,118,71,.08);color:#067647}
      .mn-left-totals{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:6px}.mn-left-total{min-width:0;border:1px solid rgba(15,23,42,.08);border-radius:8px;background:#fff;padding:8px}.mn-left-total span{display:block;font-size:9px;text-transform:uppercase;font-weight:1000;color:#667085;white-space:nowrap}.mn-left-total strong{display:block;margin-top:3px;font-size:14px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.mn-left-total.taken strong{color:#067647}.mn-left-total.remaining strong{color:#b54708}
      .mn-left-summary{position:relative;border:1px solid rgba(15,23,42,.08);border-radius:9px;background:#fff;padding:9px}.mn-left-summary-head{display:flex;align-items:center;justify-content:space-between;gap:8px;margin-bottom:7px}.mn-left-summary-head strong{font-size:11px}.mn-left-summary-head span{color:#667085;font-size:9px;font-weight:850}.mn-left-metrics{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:6px}.mn-left-metric{position:relative;min-width:0;border:1px solid rgba(15,23,42,.07);border-radius:7px;background:#f8fafc;padding:7px;outline:0}.mn-left-metric:hover,.mn-left-metric:focus-visible{border-color:rgba(6,118,71,.28);background:#fff;box-shadow:0 4px 12px rgba(15,23,42,.07);z-index:12}.mn-left-metric::after{content:attr(data-mn-tip);position:absolute;z-index:20;top:calc(100% + 6px);left:0;width:210px;max-width:calc(200% + 6px);padding:7px 8px;border-radius:7px;background:#101828;color:#fff;font-size:9px;font-weight:750;line-height:1.4;box-shadow:0 10px 24px rgba(15,23,42,.22);opacity:0;visibility:hidden;transform:translateY(-3px);transition:.14s ease;pointer-events:none}.mn-left-metric:nth-child(even)::after{left:auto;right:0}.mn-left-metric:hover::after,.mn-left-metric:focus-visible::after{opacity:1;visibility:visible;transform:translateY(0)}.mn-left-metric-label{display:flex;align-items:center;justify-content:space-between;gap:4px;color:#667085;font-size:8px;text-transform:uppercase;font-weight:1000;letter-spacing:.02em;white-space:nowrap}.mn-left-metric-label i{font-size:8px;color:#98a2b3}.mn-left-metric strong{display:block;margin-top:3px;font-size:13px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.mn-left-metric small{display:block;margin-top:2px;color:#667085;font-size:8px;font-weight:800;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.mn-left-metric.good strong{color:#067647}.mn-left-metric.warn strong{color:#b54708}.mn-left-metric.bad strong{color:#b42318}
      .mn-left-schedule{margin-top:4px;min-height:0;display:flex;flex:1;flex-direction:column;border:1px solid rgba(15,23,42,.08);border-radius:9px;background:#fff;overflow:hidden}.mn-left-schedule-head{padding:10px 11px;display:flex;align-items:center;justify-content:space-between;gap:8px;border-bottom:1px solid rgba(15,23,42,.07)}.mn-left-schedule-head strong{font-size:12px}.mn-left-schedule-head span{font-size:9px;font-weight:900;color:#667085}.mn-schedule-list{min-height:0;overflow:auto}.mn-due-card{padding:9px 10px;display:flex;flex-direction:column;gap:5px;border-bottom:1px solid rgba(15,23,42,.07)}.mn-due-card:last-child{border-bottom:0}.mn-due-line{display:flex;align-items:flex-start;justify-content:space-between;gap:8px}.mn-due-line strong{font-size:11px}.mn-due-line>span{font-size:11px;font-weight:1000}.mn-due-details{display:flex;align-items:center;gap:6px;min-width:0;color:#667085;font-size:9px;font-weight:850;line-height:1.3;flex-wrap:wrap}.mn-due-details .mn-status{padding:3px 6px;font-size:9px}.mn-due-details span:not(.mn-status){white-space:nowrap}.mn-due-details span+span:not(.mn-status)::before{content:'·';margin-right:6px;color:#98a2b3}
      .mn-left-footer{position:sticky;bottom:0;z-index:2;margin-top:auto;padding-top:8px;border-top:1px solid rgba(15,23,42,.08);background:#fff}.mn-left-footer .mn-btn{width:100%}
      .mn-autopay{border-top:1px solid rgba(15,23,42,.07);background:#fafcff}.mn-autopay .mn-due-line strong i{margin-right:5px;color:#175cd3;font-size:10px}.mn-autopay-actions{display:flex;align-items:center;gap:6px;flex-wrap:wrap}.mn-autopay-actions .mn-btn{min-height:26px;padding:4px 8px;font-size:10px}.mn-autopay-form{display:flex;flex-direction:column;gap:6px}.mn-autopay-form .mn-select,.mn-autopay-form .mn-input{padding:6px 8px;font-size:11px}.mn-autopay-fail{color:#b42318;font-size:9px;font-weight:850}
      .mn-payment-intake-view{background:#fff;border:1px solid rgba(15,23,42,.08);border-radius:8px;overflow:hidden}.mn-payment-intake-head{padding:12px 13px;border-bottom:1px solid rgba(15,23,42,.08);display:flex;align-items:center;justify-content:space-between;gap:10px}.mn-payment-intake-head h3{margin:0;font-size:13px}.mn-payment-intake-body{padding:14px}.mn-payment-intake-mount{min-height:360px}
      @media (max-width:1120px){.mn-band,.mn-expense-totals{grid-template-columns:repeat(2,minmax(0,1fr))}.mn-layout,.mn-layout.mn-invoice-layout{grid-template-columns:1fr}.mn-invoice-layout .mn-invoice-generate-column{grid-column:1;grid-row:1}.mn-invoice-layout .mn-invoice-history-column{grid-column:1;grid-row:2}}
      .mn-mobile-receipt-upload{display:none}
      @media (max-width:720px){.mn-top{display:none}.mn-actions{display:none}.mn-tabs{display:grid;grid-template-columns:repeat(var(--mn-tab-count,6),minmax(0,1fr));gap:0;overflow:hidden;margin:0;padding:0;background:#fff;border-top:0;border-bottom:1px solid rgba(15,23,42,.08)}.mn-tab{min-width:0;min-height:42px;padding:5px 3px;justify-content:center;gap:0;border:0;border-radius:0;font-size:11px;overflow:hidden}.mn-tab+.mn-tab{border-left:1px solid rgba(15,23,42,.10)}.mn-tab.active{border:0;box-shadow:inset 0 -2px #067647;background:#fff;color:#067647}.mn-tab i{font-size:15px;flex:0 0 auto}.mn-tab-label{display:none}.mn-mobile-ledger{min-height:100%}.mn-body:has(.mn-mobile-ledger),.mn-body:has(.mn-mobile-expenses){padding:0}.mn-mobile-ledger .mn-section{min-height:100%;border:0;border-radius:0}.mn-mobile-payments{display:flex;flex-direction:column;gap:14px}.mn-mobile-payments .mn-payment-intake-view{border:0;border-radius:0}.mn-mobile-payments .mn-payment-intake-body{padding:0}.mn-mobile-expenses{display:flex;flex-direction:column;gap:14px}.mn-mobile-expenses .mn-section{border-right:0;border-left:0;border-radius:0}.mn-mobile-expenses .mn-section-body{padding:0;gap:0}.mn-mobile-expenses .mn-expense-totals{grid-template-columns:repeat(4,minmax(0,1fr));gap:0;border-bottom:1px solid rgba(15,23,42,.08)}.mn-mobile-expenses .mn-stat{padding:8px 5px;border:0;border-radius:0;display:flex;flex-direction:column;align-items:center;text-align:center}.mn-mobile-expenses .mn-stat+.mn-stat{border-left:1px solid rgba(15,23,42,.08)}.mn-mobile-expenses .mn-stat span{font-size:8px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.mn-mobile-expenses .mn-stat strong{margin-top:3px;font-size:13px}.mn-mobile-expenses .mn-stat small{display:none}.mn-mobile-expenses .mn-expense-list{gap:0}.mn-mobile-expenses .mn-expense-group{border-right:0;border-left:0;border-radius:0}.mn-mobile-expenses .mn-expense-group+.mn-expense-group{border-top:0}.mn-mobile-expenses .mn-compact-entry{border-top:1px solid rgba(15,23,42,.08)}.mn-mobile-expenses .mn-compact-entry .mn-section-body{padding:10px 12px}.mn-mobile-expenses .mn-compact-entry .mn-form{grid-template-columns:repeat(2,minmax(0,1fr));gap:8px}.mn-mobile-expenses .mn-compact-entry .mn-form-actions{justify-content:flex-end}.mn-mobile-expenses .mn-compact-entry .mn-form-actions .mn-btn{width:auto;min-width:132px}.mn-mobile-receipt-upload{display:flex;margin-bottom:0;width:100%}.mn-mobile-receipt-upload .mn-btn{width:100%}.mn-band,.mn-form,.mn-invoice-date-row,.mn-invoice-tax-row{grid-template-columns:1fr}.mn-invoice-line{grid-template-columns:minmax(0,1fr) 105px 32px}.mn-alloc-grid,.mn-receipt-modal-body{grid-template-columns:1fr}.mn-receipt-review{border-right:0;border-bottom:1px solid #eaecf0}.mn-table{min-width:560px}}
      @media (max-width:370px){.mn-tab-label{display:none}.mn-tab{gap:0}}
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
      state.events = [];
      state.invoices = [];
      state.invoiceSettings = { sales_tax_enabled:true, default_sales_tax_percent:0 };
      state.moneyTerms = { ...MONEY_TERM_DEFAULTS };
      state.error = 'Payments API is not available for this project.';
      renderAll();
      return;
    }
    const sequence = ++state.loadSequence;
    const requestedProjectId = projectId();
    const requestedOrgId = orgId();
    state.loading = true;
    state.error = '';
    renderAll();
    try {
      const [summaryResult, eventsResult, invoiceResult, terminologyResult, autopayResult] = await Promise.all([
        rootWindow.PaymentsAPI.projects.summary(requestedOrgId, requestedProjectId),
        rootWindow.PaymentsAPI.events?.list ? rootWindow.PaymentsAPI.events.list(requestedOrgId, { project_id: requestedProjectId }).catch(() => ({ events: [] })) : Promise.resolve({ events: [] }),
        rootWindow.PaymentsAPI.invoices?.list ? rootWindow.PaymentsAPI.invoices.list(requestedOrgId, requestedProjectId).catch(() => ({ invoices: [] })) : Promise.resolve({ invoices: [] }),
        rootWindow.PlatformScheduling?.loadBranchConfig ? rootWindow.PlatformScheduling.loadBranchConfig(requestedOrgId, branchId()).catch(() => null) : Promise.resolve(null),
        rootWindow.PaymentsAPI.autopay?.get ? rootWindow.PaymentsAPI.autopay.get(requestedOrgId, requestedProjectId).catch(() => ({ autopay: null })) : Promise.resolve({ autopay: null })
      ]);
      if (sequence !== state.loadSequence || requestedProjectId !== projectId() || requestedOrgId !== orgId()) return;
      state.summary = summaryResult.summary || null;
      state.events = eventsResult.events || [];
      state.invoices = invoiceResult.invoices || [];
      state.invoiceSettings = {
        sales_tax_enabled: invoiceResult.settings?.sales_tax_enabled !== false,
        default_sales_tax_percent: Math.min(100, Math.max(0, Number(invoiceResult.settings?.default_sales_tax_percent || 0)))
      };
      state.moneyTerms = { ...MONEY_TERM_DEFAULTS, ...(terminologyResult?.mappings?.labels?.money || {}) };
      state.autopay = autopayResult?.autopay || null;
      // Provider + saved-method availability drives the autopay affordance.
      await refreshPaymentIntakeConfig().catch(() => null);
      state.lastLoadedAt = new Date().toISOString();
      const schedules = state.summary?.schedules || [];
      if (state.activeScheduleId !== 'all' && !schedules.some((schedule) => cleanText(schedule.id) === state.activeScheduleId)) state.activeScheduleId = 'all';
    } catch (error) {
      if (sequence !== state.loadSequence) return;
      state.error = error?.message || 'Could not load money.';
      state.summary = null;
      state.events = [];
      state.invoices = [];
      state.invoiceSettings = { sales_tax_enabled:true, default_sales_tax_percent:0 };
      state.moneyTerms = { ...MONEY_TERM_DEFAULTS };
    } finally {
      if (sequence !== state.loadSequence) return;
      state.loading = false;
      applyMoneyRoute();
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

  function scheduleTabs(){
    const schedules = state.summary?.schedules || [];
    if (schedules.length <= 1) return '';
    return `
      <div class="mn-left-tabs">
        <button type="button" class="mn-left-tab${String(state.activeScheduleId === 'all' ? ' active' : '')}" data-money-schedule="all">${(globalThis.PlatformLanguage?.text("money","m_61df468d92e238","All") ?? "All")}</button>
        ${String(schedules.map((schedule, index) => `<button type="button" class="mn-left-tab${state.activeScheduleId === cleanText(schedule.id) ? ' active' : ''}" data-money-schedule="${escapeHtml(schedule.id)}">${escapeHtml(schedule.title || `Proposal ${index + 1}`)}</button>`).join(''))}
      </div>
    `;
  }

  function leftMetric(label, value, detail, tip, tone = ''){
    const aria = `${label}: ${money(value)}. ${tip}`;
    return `<div class="mn-left-metric ${escapeHtml(tone)}" tabindex="0" aria-label="${escapeHtml(aria)}" data-mn-tip="${escapeHtml(tip)}"><span class="mn-left-metric-label">${escapeHtml(label)}<i class="fas fa-circle-info" aria-hidden="true"></i></span><strong>${money(value)}</strong><small>${escapeHtml(detail)}</small></div>`;
  }

  function renderLeft(){
    if (!state.leftRoot) return;
    const target = leftContentRoot();
    if (!target) return;
    target.querySelector?.('.mt-left')?.remove();
    target.querySelector?.('.r-schedule-left-shell')?.remove();
    if (state.loading && !state.summary) {
      target.innerHTML = `<div class="mn-left"><div class="mn-state"><i class="fas fa-circle-notch fa-spin"></i><span>${(globalThis.PlatformLanguage?.text("money","m_97d47c86b27c23","Loading schedule...") ?? "Loading schedule...")}</span></div></div>`;
      return;
    }
    if (state.error && !state.summary) {
      target.innerHTML = `<div class="mn-left"><div class="mn-alert error">${escapeHtml(state.error)}</div></div>`;
      return;
    }
    const summary = state.summary || {};
    const revenue = cents(summary.projected_revenue_cents ?? summary.project_total_cents);
    const collected = cents(summary.total_collected_cents);
    const remaining = Math.max(0, cents(summary.total_remaining_cents ?? revenue - collected));
    const costForecast = cents(summary.forecast_expenses_cents ?? summary.projected_expenses_cents);
    const actualCosts = cents(summary.actual_expenses_cents ?? summary.expenses_to_date_cents);
    const forecastProfit = cents(summary.forecast_profit_cents ?? summary.projected_profit_cents ?? revenue - costForecast);
    const profitToDate = cents(summary.profit_to_date_cents ?? collected - actualCosts);
    const margin = revenue > 0 ? Math.round((forecastProfit / revenue) * 100) : 0;
    const paymentCount = payments().filter((payment) => cleanText(payment.direction) === 'inbound').length;
    const rows = filteredObligations();
    target.innerHTML = `
      <div class="mn-left">
        <div class="mn-left-head">
          <div><strong>${String(escapeHtml(term('workspace')))}</strong><small>${String(escapeHtml(state.project?.title || state.project?.address || 'Project schedule'))}</small></div>
          <span class="mn-status ${String(remaining > 0 ? 'open' : 'paid')}">${String(remaining > 0 ? 'open' : 'paid')}</span>
        </div>
        <div class="mn-left-summary">
          <div class="mn-left-summary-head"><strong>${(globalThis.PlatformLanguage?.text("money","m_40aed9764f210b","Project Financials") ?? "Project Financials")}</strong><span>${(globalThis.PlatformLanguage?.text("money","m_df79547397005c","Hover for details") ?? "Hover for details")}</span></div>
          <div class="mn-left-metrics">
            ${String(leftMetric(term('revenue'), revenue, 'Scheduled project total', 'Total customer revenue currently scheduled from signed proposals and project payment obligations.'))}
            ${String(leftMetric(term('collected'), collected, `${paymentCount} ${paymentCount === 1 ? term('collected_payment').toLowerCase() : term('collected_payments').toLowerCase()} received`, 'Customer payments received for this project, before subtracting project expenses.', 'good'))}
            ${String(leftMetric(term('remaining'), remaining, 'Open customer balance', 'Scheduled customer revenue that has not yet been collected.', remaining > 0 ? 'warn' : 'good'))}
            ${String(leftMetric(term('cost_forecast'), costForecast, `${money(actualCosts)} actual`, 'Expected project cost using tracked actual expenses where known plus remaining projected costs.', 'warn'))}
            ${String(leftMetric(term('forecast_profit'), forecastProfit, `${margin}% projected margin`, 'Projected revenue minus the current cost forecast. This changes as revenue or expected costs change.', forecastProfit >= 0 ? 'good' : 'bad'))}
            ${String(leftMetric(term('profit_to_date'), profitToDate, `${term('collected')} less actual costs`, 'Payments collected so far minus expenses already recorded for the project.', profitToDate >= 0 ? 'good' : 'bad'))}
          </div>
        </div>
        <div class="mn-left-schedule">
          <div class="mn-left-schedule-head"><strong>${String(escapeHtml(term('payment_schedule')))}</strong><span>${String(rows.length)} ${String(escapeHtml(rows.length === 1 ? term('scheduled_payment').toLowerCase() : term('scheduled_payments').toLowerCase()))}</span></div>
          ${String(scheduleTabs())}
          <div class="mn-schedule-list">${String(rows.map(renderDueCard).join('') || '<div class="mn-empty">Signed proposals will create a payment schedule here.</div>')}</div>
          ${String(renderAutopaySection())}
        </div>
        ${String(canManageMoney() ? `<div class="mn-left-footer">
          <button type="button" class="mn-btn primary" data-money-take-payment ${moneyMutationBusy() ? 'disabled' : ''}><i class="fas fa-money-check-dollar"></i> Take a payment</button>
        </div>` : '')}
      </div>
    `;
    bindLeft();
  }

  function leftContentRoot(){
    if (!state.leftRoot) return null;
    state.leftRoot.classList.add('visible', 'mode-edit');
    const label = state.leftRoot.querySelector('#rProposalLabel');
    if (label) {
      label.textContent = (globalThis.PlatformLanguage?.text("money","m_05cb9dd7e5a780","Money") ?? "Money");
      label.hidden = true;
    }
    let list = state.leftRoot.querySelector('#rProposalList');
    if (!list) {
      state.leftRoot.innerHTML = `
        <div class="r-step-shell" style="grid-template-rows:1fr"><div class="r-step-inner"><div class="r-step-body">
          <label id="rProposalLabel" hidden>${(globalThis.PlatformLanguage?.text("money","m_05cb9dd7e5a780","Money") ?? "Money")}</label>
          <div class="r-proposal-listing" id="rProposalList"></div>
        </div></div></div>
      `;
      list = state.leftRoot.querySelector('#rProposalList');
    }
    return list;
  }

  function autopaySavedMethods(){
    const methods = state.paymentIntakeConfig?.config?.saved_methods;
    return Array.isArray(methods) ? methods : [];
  }

  function autopayNextDueLabel(){
    const open = obligations().find((item) => {
      const remaining = cents(item.amount_cents) - cents(item.allocated_cents);
      return remaining > 0 && !['void', 'paid'].includes(cleanText(item.status));
    });
    return open ? cleanText(open.label, 'Next payment') : '';
  }

  // Autopay affordance inside the payment-schedule panel (additive — the
  // schedule cards above render exactly as before). Only appears when the org
  // resolves a payment provider and the customer has saved methods (or an
  // enrollment already exists).
  function renderAutopaySection(){
    if (!canManageMoney()) return '';
    const providerReady = !!state.paymentIntakeConfig?.config?.provider;
    const autopay = state.autopay;
    const methods = autopaySavedMethods();
    if (!providerReady || (!autopay && !methods.length)) return '';
    const busy = state.autopayBusy ? 'disabled' : '';
    const failNote = state.autopayError ? `<div class="mn-autopay-fail">${escapeHtml(state.autopayError)}</div>` : '';
    if (!autopay) {
      if (!state.autopayEnrollOpen) {
        return `
          <div class="mn-due-card mn-autopay" data-money-autopay>
            <div class="mn-due-line"><strong><i class="fas fa-arrows-rotate"></i>${(globalThis.PlatformLanguage?.text("money","m_adb80fcef9bf78","Autopay") ?? "Autopay")}</strong><span class="mn-status">${(globalThis.PlatformLanguage?.text("money","m_273e689aeb0785","Off") ?? "Off")}</span></div>
            <div class="mn-due-details"><span>${(globalThis.PlatformLanguage?.text("money","m_3c7a4daf369414","Charge a saved payment method when payments come due.") ?? "Charge a saved payment method when payments come due.")}</span></div>
            <div class="mn-autopay-actions"><button type="button" class="mn-btn" data-money-autopay-open ${String(busy)}><i class="fas fa-circle-plus"></i>${(globalThis.PlatformLanguage?.text("money","m_f3b19bf3748e6b"," Set up autopay") ?? " Set up autopay")}</button></div>
            ${String(failNote)}
          </div>`;
      }
      return `
        <div class="mn-due-card mn-autopay" data-money-autopay>
          <div class="mn-due-line"><strong><i class="fas fa-arrows-rotate"></i>${(globalThis.PlatformLanguage?.text("money","m_adb80fcef9bf78","Autopay") ?? "Autopay")}</strong><span class="mn-status">${(globalThis.PlatformLanguage?.text("money","m_b06faf127e1505","Setup") ?? "Setup")}</span></div>
          <div class="mn-autopay-form">
            <select class="mn-select" data-money-autopay-method aria-label="${(globalThis.PlatformLanguage?.text("money","m_03749d6c9f558b","Saved payment method") ?? "Saved payment method")}">
              ${String(methods.map((method) => `<option value="${escapeHtml(method.id)}">${escapeHtml(cleanText(method.label, `${method.brand || 'Card'} ending in ${method.last4 || '????'}`))}</option>`).join(''))}
            </select>
            <input class="mn-input" type="text" inputmode="decimal" placeholder="${(globalThis.PlatformLanguage?.text("money","m_142ec283dfa33b","Max charge (optional, $)") ?? "Max charge (optional, $)")}" data-money-autopay-max aria-label="${(globalThis.PlatformLanguage?.text("money","m_2403460d906098","Maximum autopay amount") ?? "Maximum autopay amount")}">
            <div class="mn-autopay-actions">
              <button type="button" class="mn-btn primary" data-money-autopay-enroll ${String(busy)}><i class="fas fa-check"></i>${(globalThis.PlatformLanguage?.text("money","m_f3a69b458730ed"," Enroll") ?? " Enroll")}</button>
              <button type="button" class="mn-btn" data-money-autopay-cancel ${String(busy)}>${(globalThis.PlatformLanguage?.text("money","m_cbef679b21abb4","Cancel") ?? "Cancel")}</button>
            </div>
            ${String(failNote)}
          </div>
        </div>`;
    }
    const paused = cleanText(autopay.status) === 'paused';
    const failures = Array.isArray(autopay.failures) ? autopay.failures : [];
    const lastFailure = failures.length ? failures[failures.length - 1] : null;
    const nextDue = autopayNextDueLabel();
    return `
      <div class="mn-due-card mn-autopay" data-money-autopay>
        <div class="mn-due-line"><strong><i class="fas fa-arrows-rotate"></i>${(globalThis.PlatformLanguage?.text("money","m_adb80fcef9bf78","Autopay") ?? "Autopay")}</strong><span class="mn-status ${String(paused ? 'failed' : 'paid')}" data-money-autopay-status>${String(paused ? 'Paused' : 'Active')}</span></div>
        <div class="mn-due-details">
          <span>${String(escapeHtml(cleanText(autopay.method_label, 'Saved payment method')))}</span>
          ${String(autopay.max_amount_cents ? `<span>Max ${money(autopay.max_amount_cents)}</span>` : '')}
          ${String(!paused && nextDue ? `<span>Next: ${escapeHtml(nextDue)}</span>` : '')}
          ${String(!paused && !nextDue ? '<span>Nothing currently due</span>' : '')}
        </div>
        ${String(paused && lastFailure ? `<div class="mn-autopay-fail" data-money-autopay-failure><i class="fas fa-triangle-exclamation"></i> ${escapeHtml(cleanText(lastFailure.message, titleText(cleanText(lastFailure.decline_category, 'Charge failed'))))}</div>` : '')}
        <div class="mn-autopay-actions">
          ${String(paused
            ? `<button type="button" class="mn-btn primary" data-money-autopay-resume ${busy}><i class="fas fa-play"></i> Resume</button>`
            : `<button type="button" class="mn-btn" data-money-autopay-pause ${busy}><i class="fas fa-pause"></i> Pause</button>`)}
          <button type="button" class="mn-btn" data-money-autopay-remove ${String(busy)}><i class="fas fa-xmark"></i>${(globalThis.PlatformLanguage?.text("money","m_6ce872e51d499d"," Turn off") ?? " Turn off")}</button>
        </div>
        ${String(failNote)}
      </div>`;
  }

  async function autopayMutate(work){
    if (!canManageMoney() || state.autopayBusy) return;
    state.autopayBusy = true;
    state.autopayError = '';
    renderLeft();
    try {
      const result = await work();
      state.autopay = result && Object.prototype.hasOwnProperty.call(result, 'autopay') ? result.autopay : null;
      state.autopayEnrollOpen = false;
    } catch (error) {
      state.autopayError = error?.message || 'Autopay change failed.';
    } finally {
      state.autopayBusy = false;
      renderLeft();
    }
  }

  function renderDueCard(item){
    const amount = cents(item.amount_cents);
    const paid = cents(item.allocated_cents);
    const remaining = Math.max(0, amount - paid);
    const status = statusClass(item.status || 'scheduled');
    const due = shortDate(item.due_at) || 'Not due yet';
    return `
      <div class="mn-due-card ${String(status)}">
        <div class="mn-due-line"><strong>${String(escapeHtml(item.label || 'Payment'))}</strong><span>${String(money(amount))}</span></div>
        <div class="mn-due-details"><span class="mn-status ${String(status)}">${String(escapeHtml(titleText(item.status || 'scheduled')))}</span><span>${String(escapeHtml(due))}${String(item.due_rule ? ` · ${escapeHtml(titleText(item.due_rule))}` : '')}</span><span>${((v7) => globalThis.PlatformLanguage?.text("money","m_b1614d98ab492a",`${v7} taken`,{v7}) ?? `${v7} taken`)(money(paid))}</span>${String(remaining ? `<span>${money(remaining)} remaining</span>` : '')}</div>
      </div>
    `;
  }

  function renderMain(){
    if (!state.panelRoot) return;
    state.commissionHandle?.destroy?.();
    state.commissionHandle = null;
    state.receiptBrowserHandle?.destroy?.();
    state.receiptBrowserHandle = null;
    const root = state.panelRoot.querySelector('[data-money-root]') || state.panelRoot;
    if (state.loading && !state.summary) {
      root.innerHTML = `<div class="mn-state"><i class="fas fa-circle-notch fa-spin"></i><span>${(globalThis.PlatformLanguage?.text("money","m_487adb3f2ba511","Loading money...") ?? "Loading money...")}</span></div>`;
      return;
    }
    if (state.error && !state.summary) {
      root.innerHTML = `<div class="mn-state"><i class="fas fa-triangle-exclamation"></i><span>${escapeHtml(state.error)}</span></div>`;
      return;
    }
    const summary = state.summary || {};
    const tabs = visibleMoneyTabs();
    root.innerHTML = `
      <div class="mn-top">
        <div class="mn-title"><i class="fas fa-dollar-sign"></i><div><strong>${String(escapeHtml(term('workspace')))}</strong><span>${String(escapeHtml(state.project?.address || state.project?.title || 'Project profitability'))}</span></div></div>
        <div class="mn-actions">
          <span class="mn-muted">${String(state.lastLoadedAt ? `Updated ${escapeHtml(dateTime(state.lastLoadedAt))}` : '')}</span>
          ${String(canManageMoney() ? `<button type="button" class="mn-btn primary mn-primary-action" data-money-upload-receipt ${moneyMutationBusy() || state.receiptUploadInFlight ? 'disabled' : ''}><i class="fas fa-file-arrow-up"></i> Upload receipts</button><input type="file" data-money-receipt-input multiple accept="image/*,.pdf,.doc,.docx,.dot,.odt,.rtf,.pages,.xls,.xlsx,.csv,.tsv,.iif,.ppt,.pptx,.txt,.md,.json,.xml,.html,.htm,.eml,.mht,.tif,.tiff,.avif,.bmp,.heic,.heif" hidden>` : '<span class="mn-muted">Read only</span>')}
          <button type="button" class="mn-btn" data-money-refresh><i class="fas fa-rotate${String(state.loading ? ' mn-spin' : '')}"></i>${(globalThis.PlatformLanguage?.text("money","m_4f524800833039"," Refresh") ?? " Refresh")}</button>
        </div>
      </div>
      <div class="mn-tabs" style="--mn-tab-count:${String(tabs.length)}">
        ${String(tabs.map((tab) => viewTab(tab.id, tab.icon, tab.label)).join(''))}
      </div>
      <div class="mn-body">
        ${String(state.error ? `<div class="mn-alert error">${escapeHtml(state.error)}</div>` : '')}
        ${String(state.activeView === 'invoices' ? '' : renderActionPanel())}
        ${String(activeViewHtml(summary))}
      </div>
      ${String(renderReceiptReview(summary))}
      ${String(renderReceiptBatch(summary))}
    `;
    bindMain(root);
    mountCommissions(root);
    mountReceiptsBrowser(root);
  }

  function viewTab(id, icon, label){
    const compactLabels = { overview:'Ovr', ledger:'Led', payments:'Pay', invoices:'Inv', recurring:'Rec', expenses:'Costs', receipts:'Rcpt', commissions:'Comm', reports:'Rpt' };
    const compactLabel = compactLabels[id] || label;
    return `<button type="button" class="mn-tab${state.activeView === id ? ' active' : ''}" data-money-view="${escapeHtml(id)}" aria-label="${escapeHtml(label)}"><i class="fas ${escapeHtml(icon)}"></i><span class="mn-tab-label mn-tab-label-full">${escapeHtml(label)}</span><span class="mn-tab-label mn-tab-label-compact">${escapeHtml(compactLabel)}</span></button>`;
  }

  function activeViewHtml(summary){
    if (state.activeView === 'ledger' && isMobileMoneyLayout()) return mobileLedgerView();
    if (state.activeView === 'payments' && isMobileMoneyLayout()) return mobilePaymentsView();
    if (state.activeView === 'take_payment') return canManageMoney() ? paymentIntakeView() : overviewView(summary);
    if (state.activeView === 'invoices') return invoicesView();
    if (state.activeView === 'recurring') return recurringView(summary);
    if (state.activeView === 'expenses') return isMobileMoneyLayout() ? mobileExpensesView(summary) : expensesView(summary);
    if (state.activeView === 'receipts') return receiptsView();
    if (state.activeView === 'reports') return reportsView();
    if (state.activeView === 'commissions' && canManageCommissions()) return '<div class="mn-commission-mount" data-money-commissions></div>';
    return overviewView(summary);
  }

  function isMobileMoneyLayout(){
    return !!rootWindow.matchMedia?.('(max-width: 720px)')?.matches;
  }

  function visibleMoneyTabs(){
    const tabs = isMobileMoneyLayout()
      ? [
          { id:'ledger', icon:'fa-book-open', label:term('ledger') },
          { id:'payments', icon:'fa-money-check-dollar', label:term('payments') },
          { id:'invoices', icon:'fa-file-invoice-dollar', label:term('invoices') },
          { id:'recurring', icon:'fa-repeat', label:term('recurring') },
          { id:'expenses', icon:'fa-list-check', label:term('expense_lists') },
          { id:'receipts', icon:'fa-file-invoice', label:term('receipts') }
        ]
      : [
          { id:'overview', icon:'fa-chart-line', label:term('overview') },
          { id:'invoices', icon:'fa-file-invoice-dollar', label:term('invoices') },
          { id:'recurring', icon:'fa-repeat', label:term('recurring') },
          { id:'expenses', icon:'fa-list-check', label:term('expense_lists') },
          { id:'receipts', icon:'fa-file-invoice', label:term('receipts') }
        ];
    tabs.push({ id:'reports', icon:'fa-chart-column', label:term('reports') });
    if (canManageCommissions()) tabs.push({ id:'commissions', icon:'fa-percent', label:term('commissions') });
    return tabs;
  }

  function allowedMoneyViews(){
    return visibleMoneyTabs().map((tab) => tab.id).concat(isMobileMoneyLayout() ? [] : ['take_payment']);
  }

  function normalizeMoneyView(view){
    const requested = cleanText(view);
    if (isMobileMoneyLayout() && (requested === 'overview' || requested === 'take_payment')) return requested === 'take_payment' ? 'payments' : 'ledger';
    return allowedMoneyViews().includes(requested) ? requested : (isMobileMoneyLayout() ? 'ledger' : 'overview');
  }

  function mountCommissions(root){
    const mount = root.querySelector('[data-money-commissions]');
    if (!mount || !canManageCommissions() || !rootWindow.FirstMateProjectCommissions?.mount) return;
    state.commissionHandle = rootWindow.FirstMateProjectCommissions.mount({
      ...state.context,
      panelRoot:mount,
      roots:{ ...(state.context?.roots || {}), main:mount },
      project:state.project,
      projectId:projectId(),
      orgId:orgId(),
      branchId:branchId(),
      moneyTerms:{ ...state.moneyTerms },
      active:true
    });
  }

  function invoices(){
    return Array.isArray(state.invoices) ? state.invoices : [];
  }

  function paymentIntakeView(options = {}){
    const showBack = options.showBack !== false;
    const mobile = options.mobile === true;
    return `
      <div class="mn-payment-intake-view${mobile ? ' mn-mobile-payment-intake-view' : ''}">
        ${mobile ? '' : `<div class="mn-payment-intake-head">
          ${String(showBack ? '<button type="button" class="mn-btn" data-money-payment-back><i class="fas fa-arrow-left"></i> Back</button>' : '<span></span>')}
          <h3>${String(escapeHtml(term('take_collected_payment')))}</h3>
          <span class="mn-muted">${(globalThis.PlatformLanguage?.text("money","m_aef1346207debc","Phone payment") ?? "Phone payment")}</span>
        </div>`}
        <div class="mn-payment-intake-body">
          <div class="mn-payment-intake-mount" data-money-payment-intake></div>
        </div>
      </div>
    `;
  }

  function overviewView(summary){
    return `
      <div class="mn-layout mn-overview-layout">
        <div class="mn-stack">
          ${ledgerSection()}
        </div>
        <div class="mn-stack mn-entry-stack">
          ${recordPaymentSection()}
          ${canManageMoney() ? payableSection(true) : ''}
        </div>
      </div>
    `;
  }

  function mobileLedgerView(){
    return `<div class="mn-mobile-ledger">${ledgerSection()}</div>`;
  }

  function mobilePaymentsView(){
    if (!canManageMoney()) return `<div class="mn-mobile-payments">${paymentHistorySection()}</div>`;
    return `<div class="mn-mobile-payments">${paymentIntakeView({ showBack:false, mobile:true })}${recordPaymentSection()}${paymentHistorySection()}</div>`;
  }

  function paymentsView(){
    return `
      <div class="mn-layout">
        <div class="mn-stack">
          ${recordPaymentSection()}
          ${paymentHistorySection()}
        </div>
        <div class="mn-stack">
          ${activitySection(8, ['payment.created', 'payment.refunded', 'payment.reallocated', 'payment_intent.created'])}
        </div>
      </div>
    `;
  }

  function expensesView(summary){
    return `
      <div class="mn-layout">
        <div class="mn-stack">
          ${expenseBreakdownSection(summary, true)}
        </div>
        <div class="mn-stack">
          ${canManageMoney() ? payableSection(true) : ''}
        </div>
      </div>
    `;
  }

  function mobileExpensesView(summary){
    return `<div class="mn-mobile-expenses">${expenseBreakdownSection(summary, true)}${canManageMoney() ? payableSection(true) : ''}</div>`;
  }

  function stat(label, value, cls = '', sub = ''){
    return `<div class="mn-stat ${escapeHtml(cls)}"><span>${escapeHtml(label)}</span><strong>${money(value || 0)}</strong>${sub ? `<small>${escapeHtml(sub)}</small>` : ''}</div>`;
  }

  function expenseData(summary = state.summary || {}){
    return summary?.expense_summary || { targets:[], groups:[], receipts:[], totals:{} };
  }

  function receiptsView(){
    const upload = canManageMoney()
      ? `<div class="mn-mobile-receipt-upload"><button type="button" class="mn-btn primary mn-primary-action" data-money-upload-receipt ${String(moneyMutationBusy() || state.receiptUploadInFlight ? 'disabled' : '')}><i class="fas fa-file-arrow-up"></i>${(globalThis.PlatformLanguage?.text("money","m_e643dfd59898b5"," Upload receipts") ?? " Upload receipts")}</button></div>`
      : '';
    return `${upload}<div class="mn-receipt-browser" data-money-receipts-browser></div>`;
  }

  function mountReceiptsBrowser(root){
    const mount = root.querySelector('[data-money-receipts-browser]');
    if (!mount) return;
    if (!rootWindow.Portal?.ReceiptsBrowser?.mount) {
      mount.innerHTML = `<div class="mn-state"><i class="fas fa-triangle-exclamation"></i><span>${(globalThis.PlatformLanguage?.text("money","m_9f8e92dd90df91","Receipt browser unavailable. Refresh the portal to load its UI bundle.") ?? "Receipt browser unavailable. Refresh the portal to load its UI bundle.")}</span></div>`;
      return;
    }
    const route = rootWindow.Portal?.navigation?.read?.() || {};
    state.receiptBrowserHandle = rootWindow.Portal.ReceiptsBrowser.mount(mount, {
      scope:'project', orgId:orgId(), project:state.project, receipts:expenseData().receipts || [],
      terminology:{ ...state.moneyTerms },
      initialReceiptId:route.moneyView === 'receipts' ? route.receipt : '',
      onReview:(receipt) => {
        state.receiptOperationSequence += 1;
        state.receiptReview = { phase:'ready', receipt };
        renderMain();
      }
    });
  }

  function reportsView(){
    const docsApi = rootWindow.DocumentsAPI;
    if (!docsApi) return `<div class="mn-empty">${(globalThis.PlatformLanguage?.text("money","m_fb46ed011f94f3","Reports are unavailable — refresh the portal to load the documents bundle.") ?? "Reports are unavailable — refresh the portal to load the documents bundle.")}</div>`;
    const rows = Array.isArray(state.reports) ? state.reports : null;
    const templates = Array.isArray(state.reportTemplates) ? state.reportTemplates : [];
    const generate = canManageMoney()
      ? `<form class="mn-form mn-report-generate" data-money-report-form style="display:flex;flex-wrap:wrap;gap:8px;align-items:flex-end">
          <label><span>${(globalThis.PlatformLanguage?.text("money","m_587d96db750df7","Template") ?? "Template")}</span><select class="mn-select" name="template_id">${String(templates.length
            ? templates.map((template) => `<option value="${escapeHtml(template.id)}">${escapeHtml(template.name || template.id)}</option>`).join('')
            : '<option value="">Job Cost Report</option>')}</select></label>
          <label><span>${(globalThis.PlatformLanguage?.text("money","m_6d6214f837afac","From ") ?? "From ")}<span class="mn-muted">${(globalThis.PlatformLanguage?.text("money","m_82710819dd8da8","(optional)") ?? "(optional)")}</span></span><input class="mn-input" name="period_from" type="date"></label>
          <label><span>${(globalThis.PlatformLanguage?.text("money","m_b4676a62a86092","Through ") ?? "Through ")}<span class="mn-muted">${(globalThis.PlatformLanguage?.text("money","m_82710819dd8da8","(optional)") ?? "(optional)")}</span></span><input class="mn-input" name="period_to" type="date"></label>
          <button type="submit" class="mn-btn primary mn-primary-action" ${String(moneyMutationBusy() || state.reportGenerating ? 'disabled' : '')}><i class="fas fa-file-circle-plus"></i> ${String(state.reportGenerating ? 'Generating…' : 'Generate')}</button>
        </form>`
      : '';
    const table = rows === null
      ? `<div class="mn-state"><i class="fas fa-rotate mn-spin"></i><span>${(globalThis.PlatformLanguage?.text("money","m_50160beeaa8190","Loading reports…") ?? "Loading reports…")}</span></div>`
      : (rows.length ? `
        <div class="mn-table-wrap">
          <table class="mn-table">
            <thead><tr><th>${(globalThis.PlatformLanguage?.text("money","m_c47c2ce6bb05c0","Report") ?? "Report")}</th><th>${(globalThis.PlatformLanguage?.text("money","m_866a03fce1595b","Generated") ?? "Generated")}</th><th></th></tr></thead>
            <tbody>${String(rows.map((report) => `
              <tr>
                <td>${escapeHtml(report.title || 'Job Cost Report')}</td>
                <td>${escapeHtml(dateTime(report.created_at) || '-')}</td>
                <td>
                  <a class="mn-icon-btn" title="Download PDF" aria-label="Download PDF" href="${escapeHtml(docsApi.documents.pdfUrl(orgId(), cleanText(report.id)))}" target="_blank" rel="noopener"><i class="fas fa-file-pdf"></i></a>
                </td>
              </tr>
            `).join(''))}</tbody>
          </table>
        </div>
      ` : `<div class="mn-empty">${(globalThis.PlatformLanguage?.text("money","m_77cbacbb9a3d98","Generated reports will appear here. Reports snapshot this project's financials — metrics, expense breakdown, and payment history — as a downloadable PDF.") ?? "Generated reports will appear here. Reports snapshot this project's financials — metrics, expense breakdown, and payment history — as a downloadable PDF.")}</div>`);
    return `
      <div class="mn-section">
        <div class="mn-section-head"><h3>${escapeHtml(term('reports'))}</h3>${generate}</div>
        <div class="mn-section-body">${table}</div>
      </div>
    `;
  }

  async function loadOrgUsers(){
    if (state.orgUsers !== null) return;
    state.orgUsers = [];
    try {
      const result = await rootWindow.PlatformAPI?.users?.list?.(orgId());
      state.orgUsers = (result?.users || [])
        .filter((user) => user.disabled !== true)
        .map((user) => ({ id:cleanText(user.id), name:cleanText(user.name || user.email || user.id) }))
        .filter((user) => user.id)
        .sort((a, b) => a.name.localeCompare(b.name));
    } catch {
      state.orgUsers = [];
    }
    if (state.receiptReview) renderMain();
  }

  async function loadReports(){
    const docsApi = rootWindow.DocumentsAPI;
    if (!docsApi) return;
    try {
      const [result, templatesResult] = await Promise.all([
        docsApi.documents.listForProject(orgId(), projectId(), { document_type:'report' }),
        docsApi.templates.list(orgId(), { document_type:'report' }).catch(() => null)
      ]);
      state.reports = (result?.documents || result?.items || [])
        .filter((doc) => cleanText(doc.document_type) === 'report')
        .sort((a, b) => cleanText(b.created_at).localeCompare(cleanText(a.created_at)));
      state.reportTemplates = (templatesResult?.templates || templatesResult?.items || [])
        .filter((template) => cleanText(template.document_type) === 'report');
    } catch {
      state.reports = [];
    }
    if (state.activeView === 'reports') renderMain();
  }

  async function generateMoneyReport(options = {}){
    const docsApi = rootWindow.DocumentsAPI;
    if (!docsApi || state.reportGenerating) return;
    state.reportGenerating = true;
    renderMain();
    try {
      const templateId = cleanText(options.template_id);
      const templateName = cleanText((state.reportTemplates || []).find((template) => cleanText(template.id) === templateId)?.name) || 'Job Cost Report';
      const periodFrom = cleanText(options.period_from);
      const periodTo = cleanText(options.period_to);
      const periodLabel = periodFrom || periodTo ? ` (${periodFrom || 'start'} – ${periodTo || 'today'})` : '';
      const title = `${templateName}${periodLabel} — ${new Date().toLocaleDateString(globalThis.PlatformLanguage?.formatLocale?.())}`;
      const created = await docsApi.documents.createForProject(orgId(), projectId(), {
        document_type:'report',
        ...(templateId ? { template_id:templateId } : {}),
        title,
        params:{
          report_title:`${templateName}${periodLabel}`,
          ...(periodFrom ? { period_from:periodFrom } : {}),
          ...(periodTo ? { period_to:periodTo } : {})
        }
      });
      const documentId = cleanText(created?.document?.id);
      if (documentId) await docsApi.documents.issue(orgId(), documentId, {});
      showToast((globalThis.PlatformLanguage?.text("money","m_29988dc6646b5b","Report generated.") ?? "Report generated."), (globalThis.PlatformLanguage?.text("money","m_b4e54589824dc5","success") ?? "success"));
      if (documentId) rootWindow.open?.(docsApi.documents.pdfUrl(orgId(), documentId), '_blank', 'noopener');
    } catch (error) {
      showToast(cleanText(error?.message) || 'Report generation failed.', (globalThis.PlatformLanguage?.text("money","m_7e784f9b5540ab","error") ?? "error"));
    }
    state.reportGenerating = false;
    state.reports = null;
    renderMain();
    void loadReports();
  }

  function invoicesView(){
    const invoiceable = obligations().filter((item) => cleanText(item.source?.type) === 'proposal' && cleanText(item.status).toLowerCase() !== 'void' && cents(item.amount_cents) > 0);
    const today = new Date().toISOString().slice(0, 10);
    const rows = invoices();
    const taxSettings = state.invoiceSettings || {};
    const taxEnabled = taxSettings.sales_tax_enabled !== false;
    const defaultTaxPercent = Math.min(100, Math.max(0, Number(taxSettings.default_sales_tax_percent || 0)));
    return `
      <div class="mn-layout mn-invoice-layout">
        <div class="mn-stack mn-invoice-history-column">
          <div class="mn-section">
            <div class="mn-section-head"><h3>${String(escapeHtml(term('invoice_history')))}</h3><span>${((v1) => globalThis.PlatformLanguage?.text("money","m_22a76475e5f569",`${v1} generated`,{v1}) ?? `${v1} generated`)(rows.length)}</span></div>
            <div class="mn-section-body">${String(rows.length ? `
              <div class="mn-invoice-history">
                ${rows.map((invoice) => {
                  const id = cleanText(invoice.id);
                  const status = statusClass(invoice.status || 'draft');
                  const descriptions = (invoice.line_items || []).map((item) => item.description).filter(Boolean);
                  const description = `${descriptions.slice(0, 2).join(', ')}${descriptions.length > 2 ? ` +${descriptions.length - 2}` : ''}` || 'Project invoice';
                  return `<div class="mn-invoice-history-card"><div class="mn-invoice-history-top"><div class="mn-invoice-history-copy"><strong>${escapeHtml(invoice.invoice_number || 'Invoice')}</strong><span>${escapeHtml(description)}</span></div><strong class="mn-invoice-history-amount">${money(invoice.balance_due_cents ?? invoice.total_cents)}</strong></div><div class="mn-invoice-history-bottom"><div class="mn-invoice-history-meta"><span class="mn-status ${status}">${escapeHtml(titleText(invoice.status || 'draft'))}</span><span>${escapeHtml(shortDate(invoice.issue_date) || '-')} · Due ${escapeHtml(shortDate(invoice.due_date) || '-')}${invoice.render_paid_in_full === true ? ' · Paid-in-full PDF' : ''}</span></div><div class="mn-actions"><a class="mn-icon-btn" title="Download PDF" aria-label="Download invoice PDF" href="${escapeHtml(rootWindow.PaymentsAPI.invoices.pdfUrl(orgId(), id))}"><i class="fas fa-download"></i></a>${canManageMoney() ? `<button type="button" class="mn-icon-btn" title="Email invoice" aria-label="Email invoice" data-money-invoice-email-existing="${escapeHtml(id)}" ${moneyMutationBusy() ? 'disabled' : ''}><i class="fas fa-envelope"></i></button>${!['paid','due','overdue'].includes(status) ? `<button type="button" class="mn-btn primary" data-money-invoice-due="${escapeHtml(id)}" ${moneyMutationBusy() ? 'disabled' : ''}>Mark Due</button>` : ''}` : ''}</div></div></div>`;
                }).join('')}
              </div>
            ` : '<div class="mn-empty">Generated invoices and receipts will appear here for later download or sending.</div>')}</div>
          </div>
        </div>
        <div class="mn-stack mn-invoice-generate-column">
          ${String(canManageMoney() ? `<div class="mn-section"><div class="mn-section-head"><h3>${escapeHtml(term('generate_invoice'))}</h3></div><div class="mn-section-body">
            <form class="mn-form" data-money-invoice-form>
              <div class="mn-invoice-items">
                <div class="mn-invoice-items-head"><strong>${escapeHtml(term('invoice_items'))}</strong><button type="button" class="mn-btn" data-money-invoice-picker-toggle><i class="fas fa-plus"></i> Add ${escapeHtml(term('invoice'))} Item</button></div>
                <div class="mn-invoice-item-picker" data-money-invoice-picker hidden><div class="mn-invoice-picker-list">
                  <button type="button" class="mn-invoice-picker-choice" data-money-invoice-add-manual><span><strong>Custom Item</strong><span>Enter your own title and amount</span></span><i class="fas fa-plus"></i></button>
                  ${invoiceable.map((item) => { const paid = cleanText(item.status).toLowerCase() === 'paid'; const displayCents = paid ? cents(item.amount_cents) : Math.max(0, cents(item.amount_cents) - cents(item.allocated_cents)); return `<button type="button" class="mn-invoice-picker-choice" data-money-invoice-add-payment="${escapeHtml(item.id)}"><span><strong>${escapeHtml(item.label || 'Payment')}</strong><span>${escapeHtml(money(displayCents))}${paid ? ' · Paid' : ''}</span></span><i class="fas fa-plus"></i></button>`; }).join('')}
                </div></div>
                <div class="mn-invoice-lines" data-money-invoice-lines><div class="mn-invoice-empty" data-money-invoice-empty>Add a scheduled payment or custom item.</div></div>
              </div>
              <div class="mn-invoice-date-row">
                <label><span>Issue Date</span><input class="mn-input" type="date" name="issue_date" value="${today}" required></label>
                <label><span>Due Date</span><input class="mn-input" type="date" name="due_date" value="${today}" required></label>
                <label class="mn-switch-field"><span>Render PDF as Paid in Full</span><span class="mn-switch-control"><input type="checkbox" name="render_paid_in_full" data-money-invoice-paid-toggle role="switch" aria-label="Render PDF as paid in full"><span class="mn-switch-track" aria-hidden="true"><span></span></span></span></label>
              </div>
              ${taxEnabled ? `<div class="mn-invoice-tax-row"><label class="mn-invoice-tax-toggle"><span>Enable Tax</span><span class="mn-switch-control"><input type="checkbox" name="tax_enabled" data-money-invoice-tax-toggle role="switch" aria-label="Enable sales tax" checked><span class="mn-switch-track" aria-hidden="true"><span></span></span></span></label><label><span>Tax Percentage</span><input class="mn-input" type="number" name="tax_percent" data-money-invoice-tax-percent min="0" max="100" step="0.01" value="${escapeHtml(String(defaultTaxPercent))}"></label></div>` : ''}
              <div class="mn-invoice-total-box"><div class="mn-invoice-total-row"><span>Subtotal</span><span data-money-invoice-subtotal>${money(0)}</span></div>${taxEnabled ? `<div class="mn-invoice-total-row" data-money-invoice-tax-row-total><span>Tax</span><span data-money-invoice-tax-total>${money(0)}</span></div>` : ''}<div class="mn-invoice-total-row grand"><span>${escapeHtml(term('invoice_total'))}</span><span data-money-invoice-total>${money(0)}</span></div></div>
              <label class="wide"><span>Invoice Note</span><textarea class="mn-input" name="notes" rows="2" placeholder="Optional customer-facing note"></textarea></label>
              <div class="mn-invoice-generate-actions"><button type="submit" class="mn-btn" data-money-invoice-submit ${moneyMutationBusy() ? 'disabled' : ''} disabled><i class="fas fa-download"></i> Generate & Download</button><button type="button" class="mn-btn primary" data-money-invoice-submit data-money-invoice-email-review ${moneyMutationBusy() ? 'disabled' : ''} disabled><i class="fas fa-paper-plane"></i> Generate an Email</button></div>
            </form>
          </div></div>` : '')}
        </div>
      </div>
    `;
  }

  function recurringView(summary){
    const recurring = summary.recurring || {};
    const series = Array.isArray(recurring.series) ? recurring.series : [];
    const formatFrequency = (item) => {
      const rule = item.recurrence || {};
      const interval = Math.max(1, Number(rule.interval || 1));
      return `Every ${interval === 1 ? '' : `${interval} `}${titleText(rule.frequency || 'monthly')}${rule.end_at ? ` · ends ${shortDate(rule.end_at)}` : ' · ongoing'}`;
    };
    return `<div class="mn-layout"><div class="mn-stack"><div class="mn-section"><div class="mn-section-head"><h3>${String(escapeHtml(term('recurring_agreements')))}</h3><span>${((v1) => globalThis.PlatformLanguage?.text("money","m_727a211f807e9a",`${v1} active or historical series`,{v1}) ?? `${v1} active or historical series`)(series.length)}</span></div><div class="mn-section-body">${String(series.length ? `<div class="mn-expense-list">${series.map((item) => `<div class="mn-expense-group"><div class="mn-expense-group-head"><div><strong>${escapeHtml(item.title || 'Recurring service')}</strong><span>${escapeHtml(formatFrequency(item))}</span></div><div class="mn-expense-group-amount"><strong>${item.total_contract_value_cents == null ? 'Ongoing' : money(item.total_contract_value_cents)}</strong><small>${item.total_contract_value_cents == null ? 'No fixed contract total' : 'Contract value'}</small></div></div><div class="mn-expense-target"><div class="mn-expense-target-name"><div><strong>Service history</strong><span>${Number(item.past_instances || 0)} past · ${Number(item.total_instances || 0)} generated</span></div></div><div class="mn-expense-target-amount"><strong>${item.next_occurrence?.starts_at ? escapeHtml(shortDate(item.next_occurrence.starts_at)) : '—'}</strong><small>Next visit</small></div></div><div class="mn-expense-target"><div class="mn-expense-target-name"><div><strong>${escapeHtml(term('revenue'))} and profit</strong><span>${money(item.revenue_to_date_cents || 0)} ${escapeHtml(term('collected').toLowerCase())} · ${money(item.expenses_to_date_cents || 0)} ${escapeHtml(term('expenses').toLowerCase())}</span></div></div><div class="mn-expense-target-amount"><strong>${money(item.profit_to_date_cents || 0)}</strong><small>${escapeHtml(term('profit_to_date'))}</small></div></div></div>`).join('')}</div>` : '<div class="mn-empty">Create a recurring item in the Schedule tab to track its visits, billing, and profitability here.</div>')}</div></div></div><div class="mn-stack"><div class="mn-section"><div class="mn-section-head"><h3>${String(escapeHtml(term('recurring_totals')))}</h3><span>${(globalThis.PlatformLanguage?.text("money","m_b804dd3a14e87e","Across this project") ?? "Across this project")}</span></div><div class="mn-section-body"><div class="mn-left-totals"><div class="mn-left-total"><span>${(globalThis.PlatformLanguage?.text("money","m_e233e7a3044656","Past service instances") ?? "Past service instances")}</span><strong>${String(Number(recurring.past_instances || 0))}</strong></div><div class="mn-left-total"><span>${(globalThis.PlatformLanguage?.text("money","m_c62098961ec71c","Billed to date") ?? "Billed to date")}</span><strong>${String(money(recurring.billed_to_date_cents || 0))}</strong></div><div class="mn-left-total"><span>${String(escapeHtml(term('profit_to_date')))}</span><strong>${String(money(recurring.profit_to_date_cents || 0))}</strong></div></div></div></div>${String(scheduleSection())}</div></div>`;
  }

  function expenseBreakdownSection(summary, expanded = false){
    const expenses = expenseData(summary);
    const totals = expenses.totals || {};
    const accruedCommissions = cents(expenses.by_resource?.commission?.actual_cents || 0);
    const targetOrder = new Map((Array.isArray(expenses.targets) ? expenses.targets : []).map((target, index) => [cleanText(target?.target_key), index]));
    const groups = (Array.isArray(expenses.groups) ? [...expenses.groups] : []).sort((a, b) => {
      const displayOrder = (group) => {
        const positions = (Array.isArray(group?.targets) ? group.targets : [])
          .map((target) => targetOrder.get(cleanText(target?.target_key)))
          .filter((position) => Number.isInteger(position));
        return positions.length ? Math.min(...positions) : Number.MAX_SAFE_INTEGER;
      };
      return displayOrder(a) - displayOrder(b) || cleanText(a?.title).localeCompare(cleanText(b?.title));
    });
    return `
      <div class="mn-section">
        <div class="mn-section-head"><h3>${escapeHtml(term('project_expenses'))}</h3><span>${groups.length} ${escapeHtml(groups.length === 1 ? term('expense_list').toLowerCase() : term('expense_lists').toLowerCase())}</span></div>
        <div class="mn-section-body">
          <div class="mn-expense-totals">
            ${stat(term('current_forecast'), totals.current_cents || 0, 'warn', 'Actual where known')}
            ${stat(term('projected'), totals.projected_cents || 0)}
            ${stat(term('variance'), totals.variance_cents || 0, cents(totals.variance_cents) > 0 ? 'bad' : cents(totals.variance_cents) < 0 ? 'good' : '')}
            ${stat(term('tracked_actual'), totals.actual_cents || 0, 'good', `${totals.receipt_count || 0} ${totals.receipt_count === 1 ? term('receipt').toLowerCase() : term('receipts').toLowerCase()} plus overrides${accruedCommissions ? ` and ${term('accrued').toLowerCase()} ${term('commissions').toLowerCase()}` : ''}`)}
          </div>
          <div class="mn-expense-list">${groups.map((group) => expenseGroupHtml(group, expanded)).join('') || `<div class="mn-empty">${(globalThis.PlatformLanguage?.text("money","m_18c605540e3202","Scope material, labor, and equipment lists will appear here as projected expense buckets.") ?? "Scope material, labor, and equipment lists will appear here as projected expense buckets.")}</div>`}</div>
        </div>
      </div>
    `;
  }

  function expenseGroupHtml(group, expanded){
    const targets = Array.isArray(group?.targets) ? group.targets : [];
    const receipts = Array.isArray(group?.receipts) ? group.receipts : [];
    const hasActual = group?.actual_cents != null;
    const variance = hasActual ? cents(group.variance_cents) : null;
    const itemCount = targets.length;
    const groupStatus = group?.grouped
      ? 'Linked by shared receipts; actual cost is kept at group level'
      : hasActual ? titleText(group?.actual_source || 'actual') : 'Using projection until an actual is recorded';
    return `<details class="mn-expense-group${String(group?.grouped ? ' shared' : '')}">
      <summary class="mn-expense-group-head"><span class="mn-expense-group-chevron" aria-hidden="true"></span><div><strong>${String(escapeHtml(group?.title || 'Expense'))}</strong><span>${((v2,v3,v4) => globalThis.PlatformLanguage?.text("money","m_28e2f772a8ffa2",`${v2} line item${v3} · ${v4}`,{v2,v3,v4}) ?? `${v2} line item${v3} · ${v4}`)(itemCount,itemCount === 1 ? '' : 's',escapeHtml(groupStatus))}</span></div><div class="mn-expense-group-amount"><strong>${String(money(group?.current_cents || 0))}</strong><small>${String(hasActual ? `${variance >= 0 ? '+' : '−'}${money(Math.abs(variance))} vs projected` : `${money(group?.projected_cents || 0)} projected`)}</small></div></summary>
      <div class="mn-expense-target-list">${String(targets.map((target) => expenseTargetHtml(target, group, expanded)).join(''))}</div>
      ${String(receipts.length ? `<div class="mn-receipt-chips">${receipts.map((receipt) => `<button type="button" class="mn-receipt-chip" data-money-review-receipt="${escapeHtml(receipt.id)}"><i class="fas fa-receipt"></i>${escapeHtml(receipt.title || receipt.file?.file_name || 'Receipt')} · ${money(receipt.total_cents || receipt.effective?.total_cents || 0)}</button>`).join('')}</div>` : '')}
    </details>`;
  }

  function expenseTargetHtml(target, group, expanded){
    const labor = target?.resource_type === 'labor' ? target?.details : null;
    const laborParts = labor ? [
      labor.salary_cents ? `Salary ${money(labor.salary_cents)}` : '',
      labor.hourly_cents ? `Hourly ${money(labor.hourly_cents)}` : '',
      labor.piece_rate_cents ? `Piece rate ${money(labor.piece_rate_cents)}` : ''
    ].filter(Boolean).join(' · ') : '';
    const manualActual = target?.actual_override_cents;
    const systemActual = target?.system_managed && target?.actual_cents != null ? cents(target.actual_cents) : null;
    const actualRevision = Number(target?.override?.revision || 0);
    const canSetActual = canManageMoney() && target?.actual_override_enabled !== false && !(Array.isArray(group?.receipts) && group.receipts.length);
    return `<div class="mn-expense-target" style="--expense-color:${escapeHtml(target?.color || '#64748b')}">
      <div class="mn-expense-target-name"><span class="mn-expense-dot"></span><div><strong>${escapeHtml(target?.title || (globalThis.PlatformLanguage?.text("money","m_156b21085740d5","Expense list") ?? "Expense list"))}</strong><span>${escapeHtml(titleText(target?.resource_type || 'other'))}${expanded && laborParts ? `<span class="mn-labor-mini">${escapeHtml(laborParts)}</span>` : ''}</span></div></div>
      <div class="mn-expense-target-amount"><strong>${systemActual != null ? money(systemActual) : manualActual != null ? money(manualActual) : money(target?.projected_cents || 0)}</strong><small>${systemActual != null ? 'Accrued from commission ledger' : manualActual != null ? `Projected ${money(target?.projected_cents || 0)}` : 'Projected'}</small></div>
      ${canSetActual ? `<button type="button" class="mn-link-btn" data-money-set-actual="${escapeHtml(target?.target_key)}" data-current-actual="${manualActual == null ? '' : escapeHtml(manualActual)}" data-projected="${escapeHtml(target?.projected_cents || 0)}" data-actual-revision="${escapeHtml(actualRevision || '')}" ${moneyMutationBusy() ? 'disabled' : ''}>${manualActual == null ? 'Set actual' : 'Edit actual'}</button>` : '<span></span>'}
    </div>`;
  }

  function supplementalExpenseSection(){
    return `<div class="mn-section"><div class="mn-section-head"><h3>${((v0) => globalThis.PlatformLanguage?.text("money","m_7b9bdb8255fdf3",`Add Supplemental ${v0}`,{v0}) ?? `Add Supplemental ${v0}`)(escapeHtml(term('expense')))}</h3><span>${((v1) => globalThis.PlatformLanguage?.text("money","m_1be940b3426940",`New ${v1}`,{v1}) ?? `New ${v1}`)(escapeHtml(term('expense_list').toLowerCase()))}</span></div><div class="mn-section-body"><form class="mn-form" data-money-supplemental-form>
      <label class="wide"><span>${(globalThis.PlatformLanguage?.text("money","m_29dbd3d8b69f55","Title") ?? "Title")}</span><input class="mn-input" name="title" type="text" placeholder="${(globalThis.PlatformLanguage?.text("money","m_e4e83228287ec6","Additional chimney flashing") ?? "Additional chimney flashing")}" required></label>
      <label><span>${(globalThis.PlatformLanguage?.text("money","m_2b8c3448fa87a1","Amount") ?? "Amount")}</span><input class="mn-input" name="amount" type="number" min="0" step="0.01" required></label>
      <label><span>${(globalThis.PlatformLanguage?.text("money","m_c478c1907a4d4f","Category") ?? "Category")}</span><select class="mn-select" name="resource_type"><option value="other">${(globalThis.PlatformLanguage?.text("money","m_4a04382820d2e1","Other") ?? "Other")}</option><option value="material">${(globalThis.PlatformLanguage?.text("money","m_691187e28aba8e","Materials") ?? "Materials")}</option><option value="labor">${(globalThis.PlatformLanguage?.text("money","m_7acfa5ed3b7739","Labor") ?? "Labor")}</option><option value="equipment">${(globalThis.PlatformLanguage?.text("money","m_2813f320a63b94","Equipment") ?? "Equipment")}</option></select></label>
      <label class="wide"><span>${(globalThis.PlatformLanguage?.text("money","m_de7d6168ae1ad6","Notes") ?? "Notes")}</span><input class="mn-input" name="notes" type="text"></label>
      <div class="mn-form-actions"><button type="submit" class="mn-btn primary" ${String(moneyMutationBusy() ? 'disabled' : '')}><i class="fas fa-plus"></i>${(globalThis.PlatformLanguage?.text("money","m_0c5877b97d1665"," Add Expense") ?? " Add Expense")}</button></div>
    </form></div></div>`;
  }

  function renderReceiptReview(summary){
    const review = state.receiptReview;
    if (!review) return '';
    if (review.phase === 'uploading') return `<div class="mn-modal-shade"><div class="mn-receipt-modal"><div class="mn-receipt-modal-head"><strong>${(globalThis.PlatformLanguage?.text("money","m_c1767dcd832c57","Reading purchase document") ?? "Reading purchase document")}</strong><button type="button" class="mn-icon-btn" data-money-receipt-close aria-label="${(globalThis.PlatformLanguage?.text("money","m_3742924668fb10","Close") ?? "Close")}"><i class="fas fa-xmark"></i></button></div><div class="mn-receipt-loading"><i class="fas fa-circle-notch fa-spin"></i><div>${(globalThis.PlatformLanguage?.text("money","m_86fdd8b69b4833","Pulling totals and purchase details…") ?? "Pulling totals and purchase details…")}</div><span class="mn-muted">${String(escapeHtml(review.fileName || 'Receipt'))}</span></div></div></div>`;
    if (review.phase === 'error') return `<div class="mn-modal-shade"><div class="mn-receipt-modal"><div class="mn-receipt-modal-head"><strong>${(globalThis.PlatformLanguage?.text("money","m_c9b0194ff9817b","Receipt upload needs attention") ?? "Receipt upload needs attention")}</strong><button type="button" class="mn-icon-btn" data-money-receipt-close aria-label="${(globalThis.PlatformLanguage?.text("money","m_3742924668fb10","Close") ?? "Close")}"><i class="fas fa-xmark"></i></button></div><div class="mn-receipt-loading"><i class="fas fa-triangle-exclamation"></i><div>${String(escapeHtml(review.error || 'Could not process this file.'))}</div><button type="button" class="mn-btn" data-money-receipt-close>${(globalThis.PlatformLanguage?.text("money","m_3742924668fb10","Close") ?? "Close")}</button></div></div></div>`;
    const receipt = review.receipt || {};
    const expenses = expenseData(summary);
    const targets = Array.isArray(expenses.targets) ? expenses.targets.filter((target) => target?.receipt_attribution_enabled !== false) : [];
    const selected = new Set((Array.isArray(receipt.attributed_target_keys) && receipt.attributed_target_keys.length ? receipt.attributed_target_keys : receipt.suggested_target_keys) || []);
    const lines = Array.isArray(receipt.extraction?.line_items) ? receipt.extraction.line_items : [];
    const warnings = Array.isArray(receipt.extraction?.warnings) ? receipt.extraction.warnings : [];
    const readOnly = !canManageMoney();
    const reviewDisabled = readOnly || moneyMutationBusy() ? 'disabled' : '';
    return `<div class="mn-modal-shade"><form class="mn-receipt-modal" data-money-receipt-apply data-receipt-id="${String(escapeHtml(receipt.id))}" role="dialog" aria-modal="true" aria-labelledby="mn-receipt-review-title"><div class="mn-receipt-modal-head"><strong id="mn-receipt-review-title">${(globalThis.PlatformLanguage?.text("money","m_2df085d0598fd3","Review Receipt") ?? "Review Receipt")}</strong><button type="button" class="mn-icon-btn" data-money-receipt-close aria-label="${(globalThis.PlatformLanguage?.text("money","m_3742924668fb10","Close") ?? "Close")}" ${String(state.saving ? 'disabled' : '')}><i class="fas fa-xmark"></i></button></div>
      <div class="mn-receipt-modal-body"><div class="mn-receipt-review">
        <div class="mn-file-summary"><i class="fas fa-file-invoice-dollar"></i><div><strong>${String(escapeHtml(receipt.file?.file_name || receipt.title || 'Receipt'))}</strong><span>${String(escapeHtml(receipt.file?.content_type || ''))}${String(receipt.file?.size_bytes ? ` · ${Math.max(1, Math.round(receipt.file.size_bytes / 1024)).toLocaleString(globalThis.PlatformLanguage?.formatLocale?.())} KB` : '')}</span></div></div>
        ${String(receipt.duplicate_of_receipt_id ? `<label class="mn-alert"><input type="checkbox" name="confirm_duplicate" value="yes" ${reviewDisabled}> This file matches an existing receipt. Confirm it represents a separate expense before applying.</label>` : '')}
        ${String(warnings.length ? `<div class="mn-alert">${escapeHtml(warnings.join(' '))}</div>` : '')}
        <div class="mn-form">
          <label class="wide"><span>${(globalThis.PlatformLanguage?.text("money","m_9403c7637d4905","Total") ?? "Total")}</span><input class="mn-input" name="total" type="number" min="0" step="0.01" value="${String(escapeHtml(receipt.total_cents ? (receipt.total_cents / 100).toFixed(2) : ''))}" required ${String(reviewDisabled)}></label>
          <label><span>${(globalThis.PlatformLanguage?.text("money","m_f3cb225c1c3e0a","Purchase Date") ?? "Purchase Date")}</span><input class="mn-input" name="purchase_date" type="date" value="${String(escapeHtml(receipt.purchase_date || ''))}" ${String(reviewDisabled)}></label>
          <label><span>${(globalThis.PlatformLanguage?.text("money","m_2d11bf79588d5e","Purchase Time") ?? "Purchase Time")}</span><input class="mn-input" name="purchase_time" type="time" step="1" value="${String(escapeHtml(receipt.purchase_time || ''))}" ${String(reviewDisabled)}></label>
        </div>
        ${String(lines.length ? `<details class="mn-receipt-lines"><summary>${lines.length} extracted line item${lines.length === 1 ? '' : 's'}</summary>${lines.slice(0, 30).map((line) => `<div><span>${escapeHtml(line.description || 'Line item')}</span><strong>${money(line.total_cents || 0)}</strong></div>`).join('')}</details>` : '')}
        <div class="mn-form">
          <label class="wide"><span>${(globalThis.PlatformLanguage?.text("money","m_8b8d7106c3c872","Reimburse to ") ?? "Reimburse to ")}<span class="mn-muted">${(globalThis.PlatformLanguage?.text("money","m_f8442478204f05","(optional — paid out of pocket)") ?? "(optional — paid out of pocket)")}</span></span>
            <select class="mn-select" name="reimburse_user" data-money-reimburse-select ${String(reviewDisabled)}>
              <option value="">${(globalThis.PlatformLanguage?.text("money","m_79d4145b0d2889","No reimbursement") ?? "No reimbursement")}</option>
              ${String((state.orgUsers || []).map((user) => `<option value="${escapeHtml(user.id)}" ${cleanText(receipt.reimbursement?.payee_ref?.id) === user.id ? 'selected' : ''}>${escapeHtml(user.name)}</option>`).join(''))}
              <option value="__other__">${(globalThis.PlatformLanguage?.text("money","m_b0d2b8a6eddf50","Other person…") ?? "Other person…")}</option>
            </select></label>
          <label class="wide" data-money-reimburse-other hidden><span>${(globalThis.PlatformLanguage?.text("money","m_5875991c412359","Person to pay back") ?? "Person to pay back")}</span><input class="mn-input" name="reimburse_other_name" type="text" placeholder="${(globalThis.PlatformLanguage?.text("money","m_8cf345002184e5","Name") ?? "Name")}" ${String(reviewDisabled)}></label>
        </div>
        <a class="mn-btn" href="${String(escapeHtml(rootWindow.PaymentsAPI?.receipts?.fileUrl?.(orgId(), receipt.id) || receipt.file_url || '#'))}" target="_blank" rel="noopener"><i class="fas fa-download"></i>${(globalThis.PlatformLanguage?.text("money","m_fec4097d4bf7d9"," Open original") ?? " Open original")}</a>
      </div><div class="mn-receipt-targets"><div><strong>${(globalThis.PlatformLanguage?.text("money","m_ac45932ae7d8ca","Apply to expense lists") ?? "Apply to expense lists")}</strong><div class="mn-muted">${(globalThis.PlatformLanguage?.text("money","m_7c5a9332b209ab","Suggested from the total. Select every list covered by this document.") ?? "Suggested from the total. Select every list covered by this document.")}</div></div>
        ${String(targets.map((target) => `<label class="mn-receipt-target-choice"><input type="checkbox" name="target_key" value="${escapeHtml(target.target_key)}" ${selected.has(target.target_key) ? 'checked' : ''} ${reviewDisabled}><span><strong>${escapeHtml(target.title || 'Expense list')}</strong><span>${escapeHtml(titleText(target.resource_type || 'other'))}</span></span><strong>${money(target.projected_cents || 0)}</strong></label>`).join('') || '<div class="mn-empty">No project expense lists are available yet.</div>')}
      </div></div><div class="mn-receipt-modal-foot"><span class="mn-muted">${(globalThis.PlatformLanguage?.text("money","m_9e8539f43f5810","The original file and extraction record remain in the project library.") ?? "The original file and extraction record remain in the project library.")}</span><div class="mn-actions"><button type="button" class="mn-btn" data-money-receipt-close ${String(state.saving ? 'disabled' : '')}>${(globalThis.PlatformLanguage?.text("money","m_3742924668fb10","Close") ?? "Close")}</button>${String(canManageMoney() ? `<button type="submit" class="mn-btn primary" ${moneyMutationBusy() || !targets.length ? 'disabled' : ''}><i class="fas fa-check"></i> Apply Receipt</button>` : '')}</div></div>
    </form></div>`;
  }

  function renderReceiptBatch(summary){
    const batch = state.receiptBatch;
    if (!batch || !Array.isArray(batch.items)) return '';
    const targets = Array.isArray(expenseData(summary).targets) ? expenseData(summary).targets : [];
    const ready = batch.items.filter((item) => item.status === 'ready').length;
    const failed = batch.items.filter((item) => item.status === 'error').length;
    const working = batch.items.length - ready - failed;
    const rows = batch.items.map((item) => {
      const receipt = item.receipt || {};
      const suggested = new Set(receipt.suggested_target_keys || []);
      const matches = targets.filter((target) => suggested.has(target.target_key)).map((target) => target.title || (globalThis.PlatformLanguage?.text("money","m_156b21085740d5","Expense list") ?? "Expense list"));
      const status = item.status || 'queued';
      const icon = status === 'ready' ? 'fa-check' : status === 'error' ? 'fa-triangle-exclamation' : status === 'uploading' ? 'fa-circle-notch fa-spin' : 'fa-clock';
      const title = cleanText(receipt.title, receipt.extraction?.vendor_name, item.file_name, 'Receipt');
      const detail = status === 'ready'
        ? `${receipt.total_cents ? money(receipt.total_cents) : 'Total needs review'}${receipt.purchase_date ? ` · ${shortDate(receipt.purchase_date)}` : ''}`
        : status === 'error' ? item.error : status === 'uploading' ? 'AI is reading and categorizing this file…' : 'Waiting for an upload slot';
      const match = status === 'ready' ? (matches.length ? `Suggested match: ${matches.join(', ')}` : 'Ready to choose an expense match') : '';
      return `<div class="mn-receipt-batch-item ${escapeHtml(status)}"><span class="mn-receipt-batch-icon"><i class="fas ${icon}"></i></span><div class="mn-receipt-batch-copy"><strong>${escapeHtml(title)}</strong><span>${escapeHtml(detail)}</span>${match ? `<span class="mn-receipt-batch-match"><i class="fas fa-wand-magic-sparkles"></i> ${escapeHtml(match)}</span>` : ''}</div>${status === 'ready' ? `<button type="button" class="mn-btn" data-money-batch-review="${String(escapeHtml(receipt.id))}"><i class="fas fa-code-compare"></i>${(globalThis.PlatformLanguage?.text("money","m_b42602750e1f54"," Match") ?? " Match")}</button>` : ''}</div>`;
    }).join('');
    return `<div class="mn-modal-shade"><div class="mn-receipt-batch-modal" role="dialog" aria-modal="true" aria-labelledby="mn-receipt-batch-title"><div class="mn-receipt-modal-head"><strong id="mn-receipt-batch-title">${(globalThis.PlatformLanguage?.text("money","m_5377fab7a5079b","Match uploaded receipts") ?? "Match uploaded receipts")}</strong><button type="button" class="mn-icon-btn" data-money-batch-close aria-label="${(globalThis.PlatformLanguage?.text("money","m_8f1a129fd1f30c","Close batch") ?? "Close batch")}"><i class="fas fa-xmark"></i></button></div><div class="mn-receipt-batch-summary"><i class="fas ${String(working ? 'fa-circle-notch fa-spin' : 'fa-layer-group')}"></i><span>${((v1,v2,v3) => globalThis.PlatformLanguage?.text("money","m_68ffed54b5366b",`${v1} ready · ${v2} processing${v3}`,{v1,v2,v3}) ?? `${v1} ready · ${v2} processing${v3}`)(ready,working,failed ? ` · ${failed} failed` : '')}</span></div><div class="mn-receipt-batch-list">${String(rows)}</div></div></div>`;
  }

  function scheduleSection(){
    return '';
  }

  function recordPaymentSection(){
    if (!canManageMoney()) return '';
    return `
      <div class="mn-section">
        <div class="mn-section-head"><h3>${String(escapeHtml(term('add_collected_payment')))}</h3><span>${String(escapeHtml(term('money_in')))}</span></div>
        <div class="mn-section-body">
          <form class="mn-form" data-money-payment-form>
            <label><span>${(globalThis.PlatformLanguage?.text("money","m_2b8c3448fa87a1","Amount") ?? "Amount")}</span><input class="mn-input" name="amount" type="number" min="0" step="0.01" required></label>
            <label><span>${(globalThis.PlatformLanguage?.text("money","m_6952fe71f8dc85","Method") ?? "Method")}</span><select class="mn-select" name="method"><option value="manual">${(globalThis.PlatformLanguage?.text("money","m_176ebb1c46589f","Manual") ?? "Manual")}</option><option value="check">${(globalThis.PlatformLanguage?.text("money","m_cc74e4e6c905ec","Check") ?? "Check")}</option><option value="cash">${(globalThis.PlatformLanguage?.text("money","m_f758b041cf8d5c","Cash") ?? "Cash")}</option><option value="card">${(globalThis.PlatformLanguage?.text("money","m_dd2dde7989cd96","Card") ?? "Card")}</option><option value="ach">${(globalThis.PlatformLanguage?.text("money","m_97ab16559ee9ee","ACH") ?? "ACH")}</option></select></label>
            <label><span>${(globalThis.PlatformLanguage?.text("money","m_1561bf1f3d2922","Action") ?? "Action")}</span><select class="mn-select" name="mode"><option value="settled">${(globalThis.PlatformLanguage?.text("money","m_ff35a2977f67a8","Record settled payment") ?? "Record settled payment")}</option><option value="intent">${(globalThis.PlatformLanguage?.text("money","m_a67f5c30bef342","Create payment request") ?? "Create payment request")}</option></select></label>
            <label><span>${(globalThis.PlatformLanguage?.text("money","m_023c7d7ca8a301","Received") ?? "Received")}</span><input class="mn-input" name="received_at" type="date" value="${String(new Date().toISOString().slice(0, 10))}"></label>
            <label class="wide"><span>${(globalThis.PlatformLanguage?.text("money","m_de7d6168ae1ad6","Notes") ?? "Notes")}</span><input class="mn-input" name="notes" type="text"></label>
            <div class="mn-form-actions"><button type="submit" class="mn-btn primary" ${String(moneyMutationBusy() ? 'disabled' : '')}><i class="fas fa-plus"></i> ${String(escapeHtml(term('save_collected_payment')))}</button></div>
          </form>
        </div>
      </div>
    `;
  }

  function eventPresentation(event){
    const type = cleanText(event?.type, event?.event_type) || 'money.updated';
    const payload = event?.payload || {};
    const amount = cents(payload.amount_cents ?? payload.total_cents ?? payload.actual_cents);
    const presentations = {
      'payment.created': ['Payment received', 'Customer payment recorded', 'fa-arrow-down', 'good'],
      'payment.refunded': ['Refund issued', 'Customer payment refunded', 'fa-rotate-left', 'bad'],
      'payment.reallocated': ['Payment allocation updated', `${Number(payload.allocation_count || 0)} allocation${Number(payload.allocation_count || 0) === 1 ? '' : 's'}`, 'fa-diagram-project', ''],
      'payment_intent.created': ['Payment request created', 'Awaiting customer payment', 'fa-paper-plane', ''],
      'payment_intent.cancelled': ['Payment request cancelled', 'Payment request closed', 'fa-ban', 'bad'],
      'invoice.created': ['Invoice created', 'Project invoice generated', 'fa-file-invoice-dollar', ''],
      'invoice.marked_due': ['Invoice marked due', payload.due_at ? `Due ${shortDate(payload.due_at)}` : 'Ready for payment', 'fa-calendar-check', 'warn'],
      'invoice.emailed': ['Invoice emailed', cleanText(payload.recipient) || 'Sent to customer', 'fa-envelope', 'good'],
      'invoice.email_failed': ['Invoice email failed', cleanText(payload.recipient) || 'Delivery needs attention', 'fa-triangle-exclamation', 'bad'],
      'receipt.uploaded': ['Receipt uploaded', 'Purchase document added', 'fa-receipt', ''],
      'receipt.upload_deduplicated': ['Duplicate receipt detected', 'Existing purchase document retained', 'fa-copy', 'warn'],
      'receipt.applied': ['Receipt applied', 'Project expenses updated', 'fa-check', 'good'],
      'receipt.voided': ['Receipt voided', 'Purchase document removed from totals', 'fa-ban', 'bad'],
      'project_expense.created': ['Expense added', 'Project cost forecast updated', 'fa-wallet', 'warn'],
      'project_expense.updated': ['Expense updated', 'Project cost forecast changed', 'fa-pen', 'warn'],
      'project_expense.actual_overridden': ['Expense actual updated', 'Tracked cost manually adjusted', 'fa-pen-to-square', 'warn'],
      'payment_payable.created': ['Expense added', 'New outbound project cost', 'fa-file-invoice', 'warn'],
      'payment_payable.voided': ['Expense removed', 'Outbound project cost removed', 'fa-trash', 'bad'],
      'payment_disbursement.created': ['Expense paid', 'Outbound payment recorded', 'fa-arrow-up', 'bad'],
      'payment_schedule.created_from_signed_proposal': ['Payment schedule created', 'Generated from the signed proposal', 'fa-calendar-days', 'good']
    };
    const fallbackTitle = titleText(type.replace(/[._-]+/g, ' '));
    const [label, detail, icon, tone] = presentations[type] || [fallbackTitle, 'Project money updated', 'fa-clock-rotate-left', ''];
    return { type, label, detail, icon, tone, amount:type === 'payment.refunded' ? -Math.abs(amount) : amount };
  }

  function expenseReceipts(expense){
    const targetKeys = new Set((expense?.expense_target_keys || []).map(cleanText).filter(Boolean));
    return (expenseData().receipts || []).filter((receipt) => {
      const associations = Array.isArray(receipt?.associations) ? receipt.associations : [];
      const directlyLinked = associations.some((association) => {
        const kind = cleanText(association?.kind, association?.type).toLowerCase();
        return ['expense', 'payable', 'payment_payable'].includes(kind) && cleanText(association?.id) === cleanText(expense?.id);
      });
      return directlyLinked || (receipt.attributed_target_keys || []).some((key) => targetKeys.has(cleanText(key)));
    });
  }

  function ledgerRows(){
    const transactionRows = [];
    payments().filter((payment) => cleanText(payment.direction) === 'inbound').forEach((payment) => {
      transactionRows.push({
        key:`payment:${cleanText(payment.id)}`, category:'payments', kind:'payment', id:cleanText(payment.id), source:payment,
        at:cleanText(payment.received_at, payment.settled_at, payment.created_at), createdAt:cleanText(payment.created_at),
        label:((v0) => globalThis.PlatformLanguage?.text("money","m_9d0facb0be310f",`${v0} received`,{v0}) ?? `${v0} received`)(term('collected_payment')), detail:titleText(payment.method?.label || payment.method?.type || payment.kind || term('collected_payment')),
        status:cleanText(payment.status || 'settled'), signed:cents(payment.amount_cents), receipts:[]
      });
    });
    (state.events || []).filter((event) => cleanText(event.type, event.event_type) === 'payment.refunded').forEach((event) => {
      const amount = Math.abs(cents(event.payload?.amount_cents));
      if (!amount) return;
      transactionRows.push({
        key:`refund:${cleanText(event.id)}`, category:'payments', kind:'refund', id:cleanText(event.id), source:event,
        at:cleanText(event.created_at), createdAt:cleanText(event.created_at), label:(globalThis.PlatformLanguage?.text("money","m_d1510b3d8932b4","Customer refund") ?? "Customer refund"),
        detail:cleanText(event.payload?.reason) || 'Payment refund', status:'refunded', signed:-amount, receipts:[]
      });
    });
    payables().forEach((expense) => {
      const payee = cleanText(expense.payee_ref?.name, expense.vendor_ref?.name);
      transactionRows.push({
        key:`expense:${cleanText(expense.id)}`, category:'expenses', kind:'expense', id:cleanText(expense.id), source:expense,
        at:cleanText(expense.due_at, expense.created_at), createdAt:cleanText(expense.created_at),
        label:payee || titleText(expense.kind || term('expense')), detail:titleText(expense.kind || term('expense')),
        status:cleanText(expense.status || 'open'), signed:-Math.abs(cents(expense.amount_cents)), receipts:expenseReceipts(expense)
      });
    });
    transactionRows.sort((left, right) => {
      const time = (Date.parse(left.at) || 0) - (Date.parse(right.at) || 0);
      return time || (Date.parse(left.createdAt) || 0) - (Date.parse(right.createdAt) || 0) || left.key.localeCompare(right.key);
    });
    let balance = 0;
    transactionRows.forEach((row) => { balance += row.signed; row.balance = balance; });

    const transactionEventTypes = new Set(['payment.created', 'payment.refunded', 'payment_payable.created', 'payment_payable.voided', 'payment_disbursement.created', 'invoice.receivable_created', 'receipt.review_updated', 'receipt.extracted']);
    const activityRows = (state.events || []).filter((event) => !transactionEventTypes.has(cleanText(event.type, event.event_type))).map((event) => {
      const display = eventPresentation(event);
      return { key:`activity:${cleanText(event.id)}`, category:'activity', kind:'activity', id:cleanText(event.id), source:event, at:cleanText(event.created_at), createdAt:cleanText(event.created_at), label:display.label, detail:display.detail, status:'', signed:0, balance:null, receipts:[] };
    });
    return [...transactionRows, ...activityRows]
      .filter((row) => state.ledgerFilters[row.category] === true)
      .sort(compareLedgerRows);
  }

  function ledgerSortValue(row, key){
    if (key === 'date') return Date.parse(row.at) || 0;
    if (key === 'transaction') return `${cleanText(row.label)} ${cleanText(row.detail)}`.toLocaleLowerCase();
    if (key === 'status') return cleanText(row.status, row.kind === 'activity' ? term('activity') : '').toLocaleLowerCase();
    if (key === 'receipt') return row.receipts?.length || 0;
    if (key === 'money_in') return row.signed > 0 ? row.signed : null;
    if (key === 'money_out') return row.signed < 0 ? Math.abs(row.signed) : null;
    if (key === 'balance') return row.balance;
    return null;
  }

  function compareLedgerRows(left, right){
    const { key, direction } = state.ledgerSort;
    const leftValue = ledgerSortValue(left, key);
    const rightValue = ledgerSortValue(right, key);
    const leftMissing = leftValue == null || leftValue === '';
    const rightMissing = rightValue == null || rightValue === '';
    if (leftMissing !== rightMissing) return leftMissing ? 1 : -1;
    let comparison = 0;
    if (!leftMissing) comparison = typeof leftValue === 'number' && typeof rightValue === 'number'
      ? leftValue - rightValue
      : String(leftValue).localeCompare(String(rightValue), undefined, { numeric:true, sensitivity:'base' });
    if (comparison) return direction === 'asc' ? comparison : -comparison;
    return (Date.parse(right.at) || 0) - (Date.parse(left.at) || 0)
      || (Date.parse(right.createdAt) || 0) - (Date.parse(left.createdAt) || 0)
      || left.key.localeCompare(right.key);
  }

  function ledgerDetail(row){
    const source = row.source || {};
    if (row.kind === 'activity') return '';
    const targetNames = row.kind === 'expense'
      ? (source.expense_target_keys || []).map((key) => expenseData().targets.find((target) => cleanText(target.target_key) === cleanText(key))?.title).filter(Boolean)
      : [];
    const facts = [
      ['Reference', row.id],
      row.kind === 'payment' ? ['Method', titleText(source.method?.label || source.method?.type || source.kind || term('collected_payment'))] : null,
      row.kind === 'expense' ? [term('recipient'), cleanText(source.payee_ref?.name, source.vendor_ref?.name) || 'Not specified'] : null,
      row.kind === 'expense' ? [term('expense_list'), targetNames.join(', ') || 'Unlinked'] : null,
      ['Status', titleText(row.status || 'Recorded')],
      ['Recorded', dateTime(source.created_at || row.at)]
    ].filter(Boolean);
    return `<tr class="mn-ledger-detail-row"><td colspan="8"><div class="mn-ledger-detail"><div class="mn-ledger-facts">${facts.map(([label, value]) => `<div><span>${escapeHtml(label)}</span><strong>${escapeHtml(value)}</strong></div>`).join('')}</div>${cleanText(source.notes, source.payload?.reason) ? `<p>${escapeHtml(cleanText(source.notes, source.payload?.reason))}</p>` : ''}${row.receipts.length ? `<div class="mn-ledger-receipts">${row.receipts.map((receipt) => `<button type="button" class="mn-receipt-chip" data-money-review-receipt="${escapeHtml(receipt.id)}"><i class="fas fa-receipt"></i>${escapeHtml(receipt.file?.file_name || receipt.title || (globalThis.PlatformLanguage?.text("money","m_154be17d295d02","View receipt") ?? "View receipt"))}</button>`).join('')}</div>` : ''}</div></td></tr>`;
  }

  function ledgerRow(row){
    const isActivity = row.kind === 'activity';
    const receipt = row.receipts[0];
    const canRemove = row.kind === 'expense' && cents(row.source?.paid_cents) === 0 && !['paid', 'void'].includes(cleanText(row.status));
    const html = `<tr class="mn-ledger-row ${isActivity ? 'activity' : ''}">
      <td>${escapeHtml(shortDate(row.at) || '-')}</td>
      <td><button type="button" class="mn-ledger-item" ${isActivity ? 'disabled' : `data-money-ledger-detail="${escapeHtml(row.key)}"`}><i class="fas ${isActivity ? 'fa-clock-rotate-left' : row.signed > 0 ? 'fa-arrow-down' : 'fa-arrow-up'}"></i><span><strong>${escapeHtml(row.label)}</strong><small>${escapeHtml(row.detail)}</small></span></button></td>
      <td>${row.status ? `<span class="mn-status ${escapeHtml(statusClass(row.status))}">${escapeHtml(titleText(row.status))}</span>` : `<span class="mn-muted">${(globalThis.PlatformLanguage?.text("money","m_37fc206eefac3e","Activity") ?? "Activity")}</span>`}</td>
      <td class="mn-ledger-receipt">${receipt ? `<button type="button" class="mn-icon-btn" title="${(globalThis.PlatformLanguage?.text("money","m_154be17d295d02","View receipt") ?? "View receipt")}" aria-label="${(globalThis.PlatformLanguage?.text("money","m_154be17d295d02","View receipt") ?? "View receipt")}" data-money-review-receipt="${String(escapeHtml(receipt.id))}"><i class="fas fa-receipt"></i></button>` : row.kind === 'expense' ? ("<i class=\"far fa-receipt mn-no-receipt\" title=\"" + (globalThis.PlatformLanguage?.text("money","m_b82c94623ec9d1","No receipt") ?? "No receipt") + "\" aria-label=\"" + (globalThis.PlatformLanguage?.text("money","m_b82c94623ec9d1","No receipt") ?? "No receipt") + "\"></i>") : '—'}</td>
      <td class="mn-ledger-money in">${row.signed > 0 ? money(row.signed) : '—'}</td>
      <td class="mn-ledger-money out">${row.signed < 0 ? money(Math.abs(row.signed)) : '—'}</td>
      <td class="mn-ledger-balance">${row.balance == null ? '—' : money(row.balance)}</td>
      <td>${canRemove && canManageMoney() ? `<button type="button" class="mn-icon-btn danger" title="${(globalThis.PlatformLanguage?.text("money","m_028ede988e2f28","Remove expense") ?? "Remove expense")}" aria-label="${(globalThis.PlatformLanguage?.text("money","m_028ede988e2f28","Remove expense") ?? "Remove expense")}" data-money-delete-expense="${String(escapeHtml(row.id))}" ${String(moneyMutationBusy() ? 'disabled' : '')}><i class="fas fa-trash"></i></button>` : ''}</td>
    </tr>`;
    return html + (state.ledgerDetailKey === row.key ? ledgerDetail(row) : '');
  }

  function ledgerSortHeader(key, label, align = ''){
    const active = state.ledgerSort.key === key;
    const direction = active ? state.ledgerSort.direction : '';
    const ariaSort = active ? (direction === 'asc' ? 'ascending' : 'descending') : 'none';
    const nextDirection = active && direction === 'asc' ? 'descending' : 'ascending';
    const icon = active ? (direction === 'asc' ? 'fa-arrow-up' : 'fa-arrow-down') : 'fa-sort';
    return ("<th aria-sort=\"" + String(ariaSort) + "\"><button type=\"button\" class=\"mn-ledger-sort" + String(active ? ' active' : '') + String(align ? ` ${align}` : '') + "\" data-money-ledger-sort=\"" + String(key) + "\" title=\"" + ((v4,v5) => globalThis.PlatformLanguage?.text("money","m_9840654edbea03",`Sort ${v4} ${v5}`,{v4,v5}) ?? `Sort ${v4} ${v5}`)(escapeHtml(label),nextDirection) + "\" aria-label=\"" + ((v6,v7) => globalThis.PlatformLanguage?.text("money","m_d653f1540000b0",`Sort ${v6} ${v7}`,{v6,v7}) ?? `Sort ${v6} ${v7}`)(escapeHtml(label),nextDirection) + "\">" + String(escapeHtml(label)) + "<i class=\"fas " + String(icon) + "\" aria-hidden=\"true\"></i></button></th>");
  }

  function ledgerSection(){
    const rows = ledgerRows();
    const transactionRows = rows.filter((row) => row.kind !== 'activity');
    const currentBalance = ledgerRowsForBalance();
    const filterButton = (key, icon, label) => `<button type="button" class="mn-ledger-filter${state.ledgerFilters[key] ? ' active' : ''}" data-money-ledger-filter="${key}" aria-pressed="${state.ledgerFilters[key] ? 'true' : 'false'}"><i class="fas ${icon}"></i>${label}</button>`;
    return `<div class="mn-section mn-ledger-section"><div class="mn-ledger-head"><div><h3>${String(escapeHtml(term('ledger')))}</h3><span>${((v1,v2,v3,v4) => globalThis.PlatformLanguage?.text("money","m_a0d78c8c64f3b6",`${v1} ${v2} shown · ${v3} ${v4}`,{v1,v2,v3,v4}) ?? `${v1} ${v2} shown · ${v3} ${v4}`)(transactionRows.length,escapeHtml(transactionRows.length === 1 ? term('transaction').toLowerCase() : term('transactions').toLowerCase()),money(currentBalance),escapeHtml(term('balance').toLowerCase()))}</span></div><div class="mn-ledger-filters" aria-label="${((v5) => globalThis.PlatformLanguage?.text("money","m_2bf97d45e17019",`${v5} filters`,{v5}) ?? `${v5} filters`)(escapeHtml(term('ledger')))}">${String(filterButton('payments', 'fa-arrow-down', term('payments')))}${String(filterButton('expenses', 'fa-arrow-up', term('expenses')))}${String(filterButton('activity', 'fa-clock-rotate-left', term('activity')))}</div></div>${String(rows.length ? `<div class="mn-table-wrap mn-ledger-scroll"><table class="mn-table mn-ledger-table"><thead><tr><th>Date</th><th>${escapeHtml(term('transaction'))}</th><th>Status</th><th>${escapeHtml(term('receipt'))}</th><th>${escapeHtml(term('money_in'))}</th><th>${escapeHtml(term('money_out'))}</th><th>${escapeHtml(term('balance'))}</th><th></th></tr></thead><tbody>${rows.map(ledgerRow).join('')}</tbody></table></div>` : '<div class="mn-empty">No entries match the selected filters.</div>')}</div>`;
  }

  function ledgerRowsForBalance(){
    return payments().filter((payment) => cleanText(payment.direction) === 'inbound').reduce((sum, payment) => sum + cents(payment.amount_cents), 0)
      - (state.events || []).filter((event) => cleanText(event.type, event.event_type) === 'payment.refunded').reduce((sum, event) => sum + Math.abs(cents(event.payload?.amount_cents)), 0)
      - payables().reduce((sum, expense) => sum + Math.abs(cents(expense.amount_cents)), 0);
  }

  function historyRow(row){
    const amount = Number(row.amount || 0);
    const paymentActions = row.kind === 'payment' && canManageMoney() ? (String(row.canRefund ? `<button type="button" class="mn-icon-btn" title="Refund payment" aria-label="Refund payment" data-money-action="refund" data-payment-id="${escapeHtml(row.id)}" ${moneyMutationBusy() ? 'disabled' : ''}><i class="fas fa-rotate-left"></i></button>` : '') + "<button type=\"button\" class=\"mn-icon-btn\" title=\"" + (globalThis.PlatformLanguage?.text("money","m_73e106096ea0fc","Reallocate payment") ?? "Reallocate payment") + "\" aria-label=\"" + (globalThis.PlatformLanguage?.text("money","m_73e106096ea0fc","Reallocate payment") ?? "Reallocate payment") + "\" data-money-action=\"reallocate\" data-payment-id=\"" + String(escapeHtml(row.id)) + "\" " + String(moneyMutationBusy() ? 'disabled' : '') + "><i class=\"fas fa-diagram-project\"></i></button>") : '';
    return `<div class="mn-history-row"><span class="mn-history-icon ${escapeHtml(row.tone || '')}"><i class="fas ${escapeHtml(row.icon || 'fa-clock-rotate-left')}"></i></span><div class="mn-history-copy"><strong>${escapeHtml(row.label || 'Money updated')}</strong><small>${escapeHtml(row.detail || 'Project money updated')} · ${escapeHtml(dateTime(row.at))}</small></div><div class="mn-history-side">${amount ? `<span class="mn-history-amount ${escapeHtml(row.amountTone || '')}">${amount < 0 ? '−' : ''}${escapeHtml(money(Math.abs(amount)))}</span>` : ''}${paymentActions}</div></div>`;
  }

  function paymentHistorySection(limit = 0){
    const rows = payments().filter((item) => cleanText(item.direction) === 'inbound');
    const shown = limit ? rows.slice(0, limit) : rows;
    return `
      <div class="mn-section">
        <div class="mn-section-head"><h3>${((v0) => globalThis.PlatformLanguage?.text("money","m_3544242881ea69",`${v0} History`,{v0}) ?? `${v0} History`)(escapeHtml(term('collected_payments')))}</h3><span>${String(rows.length)} ${String(escapeHtml(term('collected_payments').toLowerCase()))}</span></div>
        <div class="mn-section-body">${String(paymentTable(shown, rows.length > shown.length))}</div>
      </div>
    `;
  }

  function paymentTable(rows, truncated = false){
    if (!rows.length) return `<div class="mn-empty">${(globalThis.PlatformLanguage?.text("money","m_f6bb2b4027f6bd","Customer payments will appear here as they are recorded.") ?? "Customer payments will appear here as they are recorded.")}</div>`;
    return `
      <div class="mn-table-wrap">
        <table class="mn-table">
          <thead><tr><th>${(globalThis.PlatformLanguage?.text("money","m_2a0b11100c22a4","Date") ?? "Date")}</th><th>${(globalThis.PlatformLanguage?.text("money","m_6952fe71f8dc85","Method") ?? "Method")}</th><th>${(globalThis.PlatformLanguage?.text("money","m_1352cafa75b8da","Status") ?? "Status")}</th><th>${(globalThis.PlatformLanguage?.text("money","m_2b8c3448fa87a1","Amount") ?? "Amount")}</th><th>${(globalThis.PlatformLanguage?.text("money","m_5b10b90b175d30","Refunded") ?? "Refunded")}</th><th>${(globalThis.PlatformLanguage?.text("money","m_376b722115b602","Cleared") ?? "Cleared")}</th><th></th></tr></thead>
          <tbody>${String(rows.map((payment) => {
            const id = cleanText(payment.id);
            const status = statusClass(payment.status || 'settled');
            const clearedAt = cleanText(payment.cleared_at);
            const reconcilable = ['settled', 'partially_refunded', 'refunded'].includes(cleanText(payment.status || 'settled'));
            return `
              <tr>
                <td>${escapeHtml(shortDate(payment.received_at || payment.settled_at || payment.created_at) || '-')}</td>
                <td>${escapeHtml(titleText(payment.method?.label || payment.method?.type || payment.kind || 'Payment'))}</td>
                <td><span class="mn-status ${status}">${escapeHtml(titleText(payment.status || 'settled'))}</span></td>
                <td>${money(payment.amount_cents)}</td>
                <td>${money(payment.refunded_cents || 0)}</td>
                <td>${clearedAt ? `<span class="mn-status good" title="Reconciled — confirmed against the bank">${escapeHtml(shortDate(clearedAt))}</span>` : '<span class="mn-muted">—</span>'}</td>
                <td>${canManageMoney() ? `
                  <button type="button" class="mn-icon-btn" title="Refund payment" aria-label="Refund payment" data-money-action="refund" data-payment-id="${escapeHtml(id)}" ${moneyMutationBusy() ? 'disabled' : ''}><i class="fas fa-rotate-left"></i></button>
                  <button type="button" class="mn-icon-btn" title="Reallocate payment" aria-label="Reallocate payment" data-money-action="reallocate" data-payment-id="${escapeHtml(id)}" ${moneyMutationBusy() ? 'disabled' : ''}><i class="fas fa-diagram-project"></i></button>
                  ${reconcilable ? (clearedAt
                    ? `<button type="button" class="mn-icon-btn" title="Unmark cleared" aria-label="Unmark cleared" data-money-unclear-payment="${escapeHtml(id)}" ${moneyMutationBusy() ? 'disabled' : ''}><i class="fas fa-ban"></i></button>`
                    : `<button type="button" class="mn-icon-btn" title="Mark cleared at the bank" aria-label="Mark cleared at the bank" data-money-clear-payment="${escapeHtml(id)}" ${moneyMutationBusy() ? 'disabled' : ''}><i class="fas fa-check-double"></i></button>`) : ''}
                ` : ''}</td>
              </tr>
            `;
          }).join(''))}</tbody>
        </table>
      </div>
      ${String(truncated ? '<button type="button" class="mn-btn" data-money-view="payments">View All Payments</button>' : '')}
    `;
  }

  function payableSection(compact = false){
    return `
      <div class="mn-section${String(compact ? ' mn-compact-entry' : '')}">
        <div class="mn-section-head"><h3>${String(escapeHtml(term('add_expense')))}</h3><span>${String(escapeHtml(term('money_out')))}</span></div>
        <div class="mn-section-body">
          <form class="mn-form" data-money-payable-form>
            <label><span>${(globalThis.PlatformLanguage?.text("money","m_2b8c3448fa87a1","Amount") ?? "Amount")}</span><input class="mn-input" name="amount" type="number" min="0" step="0.01" required></label>
            <label><span>${(globalThis.PlatformLanguage?.text("money","m_2a0b11100c22a4","Date") ?? "Date")}</span><input class="mn-input" name="due_at" type="date" value="${String(new Date().toISOString().slice(0, 10))}"></label>
            <label><span>${(globalThis.PlatformLanguage?.text("money","m_c478c1907a4d4f","Category") ?? "Category")}</span><select class="mn-select" name="kind"><option value="labor">${(globalThis.PlatformLanguage?.text("money","m_7acfa5ed3b7739","Labor") ?? "Labor")}</option><option value="material_order">${(globalThis.PlatformLanguage?.text("money","m_691187e28aba8e","Materials") ?? "Materials")}</option><option value="reimbursement">${(globalThis.PlatformLanguage?.text("money","m_88e28eaf951742","Reimbursement") ?? "Reimbursement")}</option><option value="other">${(globalThis.PlatformLanguage?.text("money","m_4a04382820d2e1","Other") ?? "Other")}</option></select></label>
            <label><span>${String(escapeHtml(term('recipient')))}</span><input class="mn-input" name="vendor" type="text" placeholder="${(globalThis.PlatformLanguage?.text("money","m_a96780e95d7346","Vendor or person") ?? "Vendor or person")}"></label>
            <label class="wide"><span>${String(escapeHtml(term('expense_list')))}</span><select class="mn-select" name="expense_target_key"><option value="">${((v6) => globalThis.PlatformLanguage?.text("money","m_392c73bc5d4e6e",`Unlinked ${v6}`,{v6}) ?? `Unlinked ${v6}`)(escapeHtml(term('expense').toLowerCase()))}</option>${String(expenseData().targets.filter((target) => target?.receipt_attribution_enabled !== false).map((target) => `<option value="${escapeHtml(target.target_key)}">${escapeHtml(target.title || term('expense_list'))} - ${escapeHtml(money(target.projected_cents))}</option>`).join(''))}</select></label>
            <label class="wide"><span>${(globalThis.PlatformLanguage?.text("money","m_aa136ecb65672f","Description") ?? "Description")}</span><input class="mn-input" name="notes" type="text" placeholder="${(globalThis.PlatformLanguage?.text("money","m_a517102d3c8a89","What was this expense for?") ?? "What was this expense for?")}"></label>
            <div class="mn-form-actions"><button type="submit" class="mn-btn primary" ${String(moneyMutationBusy() ? 'disabled' : '')}><i class="fas fa-plus"></i> ${String(escapeHtml(term('add_expense')))}</button></div>
          </form>
        </div>
      </div>
    `;
  }

  function payablesTableSection(){
    const rows = payables();
    return `
      <div class="mn-section">
        <div class="mn-section-head"><h3>${String(escapeHtml(term('expenses')))}</h3><span>${((v1,v2) => globalThis.PlatformLanguage?.text("money","m_7cae9ec9dbaa48",`${v1} ${v2} items`,{v1,v2}) ?? `${v1} ${v2} items`)(rows.length,escapeHtml(term('expense').toLowerCase()))}</span></div>
        <div class="mn-section-body">${String(payablesTable(rows))}</div>
      </div>
    `;
  }

  function payablesTable(rows){
    if (!rows.length) return `<div class="mn-empty">${(globalThis.PlatformLanguage?.text("money","m_11d7fa97b07307","Labor payments, reimbursements, and other project payables will appear here.") ?? "Labor payments, reimbursements, and other project payables will appear here.")}</div>`;
    return `
      <div class="mn-table-wrap">
        <table class="mn-table">
          <thead><tr><th>${(globalThis.PlatformLanguage?.text("money","m_b220dbdedc8a70","Kind") ?? "Kind")}</th><th>${(globalThis.PlatformLanguage?.text("money","m_3dac4d5769efeb","Due") ?? "Due")}</th><th>${(globalThis.PlatformLanguage?.text("money","m_1352cafa75b8da","Status") ?? "Status")}</th><th>${(globalThis.PlatformLanguage?.text("money","m_2b8c3448fa87a1","Amount") ?? "Amount")}</th><th>${(globalThis.PlatformLanguage?.text("money","m_956173c8527121","Paid") ?? "Paid")}</th><th></th></tr></thead>
          <tbody>${String(rows.map((payable) => {
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
                <td>${open && canManageMoney() ? `<button type="button" class="mn-btn" data-money-action="pay-payable" data-payable-id="${escapeHtml(payable.id)}" ${moneyMutationBusy() ? 'disabled' : ''}>Pay ${escapeHtml(money(open))}</button>` : ''}</td>
              </tr>
            `;
          }).join(''))}</tbody>
        </table>
      </div>
    `;
  }

  function activitySection(limit = 10, eventTypes = null){
    let rows = state.events || [];
    if (eventTypes) rows = rows.filter((event) => eventTypes.includes(cleanText(event.type, event.event_type)));
    const shown = rows.slice(0, limit);
    return `
      <div class="mn-section">
        <div class="mn-section-head"><h3>${String(escapeHtml(term('activity')))}</h3><span>${((v1) => globalThis.PlatformLanguage?.text("money","m_45ae20ea3cdc0f",`${v1} events`,{v1}) ?? `${v1} events`)(rows.length)}</span></div>
        <div class="mn-history-list">${String(activityList(shown))}</div>
      </div>
    `;
  }

  function activityList(rows){
    if (!rows.length) return `<div class="mn-empty">${(globalThis.PlatformLanguage?.text("money","m_47662bbb86037b","Money activity will appear here.") ?? "Money activity will appear here.")}</div>`;
    return rows.map((event) => {
      const display = eventPresentation(event);
      return historyRow({ kind:'event', id:cleanText(event.id), at:cleanText(event.created_at), ...display, amountTone:display.amount < 0 ? 'bad' : '' });
    }).join('');
  }

  function renderActionPanel(){
    if (!state.action || !canManageMoney()) return '';
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
        <div class="mn-action-head"><strong>${((v0) => globalThis.PlatformLanguage?.text("money","m_ed4771d595c2f5",`Refund ${v0}`,{v0}) ?? `Refund ${v0}`)(escapeHtml(money(available)))}</strong><button type="button" class="mn-icon-btn" title="${(globalThis.PlatformLanguage?.text("money","m_3742924668fb10","Close") ?? "Close")}" data-money-action-close><i class="fas fa-xmark"></i></button></div>
        <form class="mn-form" data-money-refund-form data-payment-id="${String(escapeHtml(paymentId))}">
          <label><span>${(globalThis.PlatformLanguage?.text("money","m_2b8c3448fa87a1","Amount") ?? "Amount")}</span><input class="mn-input" name="amount" type="number" min="0" step="0.01" value="${String(escapeHtml((available / 100).toFixed(2)))}" required></label>
          <label><span>${(globalThis.PlatformLanguage?.text("money","m_6480ed19528b5a","Reason") ?? "Reason")}</span><input class="mn-input" name="reason" type="text" value="Customer refund"></label>
          <div class="mn-form-actions"><button type="submit" class="mn-btn danger" ${String(moneyMutationBusy() ? 'disabled' : '')}><i class="fas fa-rotate-left"></i>${(globalThis.PlatformLanguage?.text("money","m_13c747357e8f18"," Record Refund") ?? " Record Refund")}</button></div>
        </form>
      </div>
    `;
  }

  function reallocatePanel(paymentId){
    const payment = findPayment(paymentId) || {};
    return `
      <div class="mn-action-panel">
        <div class="mn-action-head"><strong>${((v0) => globalThis.PlatformLanguage?.text("money","m_a0e7936655ba0d",`Reallocate ${v0}`,{v0}) ?? `Reallocate ${v0}`)(escapeHtml(money(payment.amount_cents || 0)))}</strong><button type="button" class="mn-icon-btn" title="${(globalThis.PlatformLanguage?.text("money","m_3742924668fb10","Close") ?? "Close")}" data-money-action-close><i class="fas fa-xmark"></i></button></div>
        <form class="mn-form" data-money-reallocate-form data-payment-id="${String(escapeHtml(paymentId))}">
          <div class="wide mn-muted">${(globalThis.PlatformLanguage?.text("money","m_4c25692ac68e1f","Enter the dollar amount to apply to each scheduled payment. Blank rows are ignored.") ?? "Enter the dollar amount to apply to each scheduled payment. Blank rows are ignored.")}</div>
          ${String(obligations().map((item) => `
            <div class="wide mn-alloc-grid">
              <label><span>${escapeHtml(item.label || 'Payment')} - ${escapeHtml(money(item.amount_cents || 0))}</span><input class="mn-input" name="alloc:${escapeHtml(item.id)}" type="number" min="0" step="0.01" placeholder="0.00"></label>
              <span class="mn-status ${statusClass(item.status || 'scheduled')}">${escapeHtml(titleText(item.status || 'scheduled'))}</span>
            </div>
          `).join(''))}
          <div class="mn-form-actions"><button type="submit" class="mn-btn primary" ${String(moneyMutationBusy() ? 'disabled' : '')}><i class="fas fa-diagram-project"></i>${(globalThis.PlatformLanguage?.text("money","m_fc8467729d6a7e"," Save Allocation") ?? " Save Allocation")}</button></div>
        </form>
      </div>
    `;
  }

  function payablePaymentPanel(payableId){
    const payable = findPayable(payableId) || {};
    const open = Math.max(0, cents(payable.amount_cents) - cents(payable.paid_cents));
    return `
      <div class="mn-action-panel">
        <div class="mn-action-head"><strong>${((v0) => globalThis.PlatformLanguage?.text("money","m_57ce70ae5f31a4",`Pay ${v0}`,{v0}) ?? `Pay ${v0}`)(escapeHtml(titleText(payable.kind || 'Payable')))}</strong><button type="button" class="mn-icon-btn" title="${(globalThis.PlatformLanguage?.text("money","m_3742924668fb10","Close") ?? "Close")}" data-money-action-close><i class="fas fa-xmark"></i></button></div>
        <form class="mn-form" data-money-disbursement-form data-payable-id="${String(escapeHtml(payableId))}">
          <label><span>${(globalThis.PlatformLanguage?.text("money","m_2b8c3448fa87a1","Amount") ?? "Amount")}</span><input class="mn-input" name="amount" type="number" min="0" step="0.01" value="${String(escapeHtml((open / 100).toFixed(2)))}" required></label>
          <label><span>${(globalThis.PlatformLanguage?.text("money","m_6952fe71f8dc85","Method") ?? "Method")}</span><select class="mn-select" name="method"><option value="manual">${(globalThis.PlatformLanguage?.text("money","m_176ebb1c46589f","Manual") ?? "Manual")}</option><option value="check">${(globalThis.PlatformLanguage?.text("money","m_cc74e4e6c905ec","Check") ?? "Check")}</option><option value="cash">${(globalThis.PlatformLanguage?.text("money","m_f758b041cf8d5c","Cash") ?? "Cash")}</option><option value="ach">${(globalThis.PlatformLanguage?.text("money","m_97ab16559ee9ee","ACH") ?? "ACH")}</option><option value="card">${(globalThis.PlatformLanguage?.text("money","m_dd2dde7989cd96","Card") ?? "Card")}</option></select></label>
          <label class="wide"><span>${(globalThis.PlatformLanguage?.text("money","m_de7d6168ae1ad6","Notes") ?? "Notes")}</span><input class="mn-input" name="notes" type="text"></label>
          <div class="mn-form-actions"><button type="submit" class="mn-btn primary" ${String(moneyMutationBusy() ? 'disabled' : '')}><i class="fas fa-paper-plane"></i>${(globalThis.PlatformLanguage?.text("money","m_67bb4e6a07b913"," Record Payment Out") ?? " Record Payment Out")}</button></div>
        </form>
      </div>
    `;
  }

  function setMoneyView(view, options = {}){
    const next = normalizeMoneyView(view);
    state.activeView = next;
    state.action = null;
    state.ledgerDetailKey = '';
    if (options.updateRoute !== false && !rootWindow.Portal?.navigation?.applying) {
      rootWindow.Portal?.navigation?.push?.({ moneyView:next, receipt:null }, { source:'project-money-view', ownedKeys:['moneyView'] });
    }
    renderMain();
  }

  function findInvoice(id){
    return invoices().find((invoice) => cleanText(invoice.id) === cleanText(id));
  }

  function invoiceComposerLineHtml(item = {}){
    const type = cleanText(item.type) === 'payment' ? 'payment' : 'manual';
    const readonly = type === 'payment' ? 'readonly' : '';
    return `<div class="mn-invoice-line" data-money-invoice-line data-line-type="${String(type)}" data-obligation-id="${String(escapeHtml(item.obligation_id || ''))}" data-paid="${String(item.paid === true ? 'true' : 'false')}">
      <label><span>${(globalThis.PlatformLanguage?.text("money","m_feb2fa0bebb7bf","Item Title") ?? "Item Title")}</span><input class="mn-input" data-money-invoice-line-title value="${String(escapeHtml(item.description || ''))}" placeholder="${(globalThis.PlatformLanguage?.text("money","m_2e121533e8b8d3","Invoice item") ?? "Invoice item")}" ${String(readonly)}></label>
      <label><span>${(globalThis.PlatformLanguage?.text("money","m_2b8c3448fa87a1","Amount") ?? "Amount")}</span><input class="mn-input" data-money-invoice-line-amount type="number" min="0.01" step="0.01" value="${String((cents(item.amount_cents) / 100).toFixed(2))}" ${String(readonly)}></label>
      <button type="button" class="mn-invoice-line-remove" data-money-invoice-line-remove title="${(globalThis.PlatformLanguage?.text("money","m_79a02ecd535f66","Remove item") ?? "Remove item")}" aria-label="${(globalThis.PlatformLanguage?.text("money","m_1dfe8d61e491ea","Remove invoice item") ?? "Remove invoice item")}"><i class="fas fa-trash"></i></button>
    </div>`;
  }

  function updateInvoiceComposer(form, options = {}){
    if (!form) return;
    const lines = Array.from(form.querySelectorAll('[data-money-invoice-line]'));
    const subtotalCents = lines.reduce((sum, line) => sum + Math.max(0, centsFromDollars(line.querySelector('[data-money-invoice-line-amount]')?.value)), 0);
    const taxToggle = form.querySelector('[data-money-invoice-tax-toggle]');
    const taxPercentInput = form.querySelector('[data-money-invoice-tax-percent]');
    const taxEnabled = !!taxToggle?.checked;
    const taxPercent = taxEnabled ? Math.min(100, Math.max(0, Number(taxPercentInput?.value || 0))) : 0;
    const taxCents = Math.round(subtotalCents * taxPercent / 100);
    const totalCents = subtotalCents + taxCents;
    if (taxPercentInput) taxPercentInput.disabled = !taxEnabled;
    const subtotalRoot = form.querySelector('[data-money-invoice-subtotal]');
    const taxRoot = form.querySelector('[data-money-invoice-tax-total]');
    const totalRoot = form.querySelector('[data-money-invoice-total]');
    if (subtotalRoot) subtotalRoot.textContent = money(subtotalCents);
    if (taxRoot) taxRoot.textContent = money(taxCents);
    if (totalRoot) totalRoot.textContent = money(totalCents);
    form.querySelector('[data-money-invoice-tax-row-total]')?.toggleAttribute('hidden', !taxEnabled);
    form.querySelector('[data-money-invoice-empty]')?.toggleAttribute('hidden', lines.length > 0);
    form.querySelectorAll('[data-money-invoice-submit]').forEach((button) => {
      button.disabled = moneyMutationBusy() || !lines.length || totalCents <= 0;
    });
    const paidToggle = form.querySelector('[data-money-invoice-paid-toggle]');
    if (paidToggle && options.resetPaidDefault !== false && paidToggle.dataset.userChanged !== 'true') {
      paidToggle.checked = lines.length > 0 && lines.every((line) => line.dataset.lineType === 'payment' && line.dataset.paid === 'true');
    }
  }

  function addInvoiceComposerLine(form, item){
    if (!form) return;
    if (item.type === 'payment' && form.querySelector(`[data-money-invoice-line][data-obligation-id="${CSS.escape(cleanText(item.obligation_id))}"]`)) {
      showToast((globalThis.PlatformLanguage?.text("money","m_92746cc2722d5d","That payment is already on the invoice.") ?? "That payment is already on the invoice."), (globalThis.PlatformLanguage?.text("money","m_7e784f9b5540ab","error") ?? "error"));
      return;
    }
    form.querySelector('[data-money-invoice-lines]')?.insertAdjacentHTML('beforeend', invoiceComposerLineHtml(item));
    const picker = form.querySelector('[data-money-invoice-picker]');
    if (picker) picker.hidden = true;
    updateInvoiceComposer(form);
  }

  function bindInvoiceComposer(form){
    if (!form) return;
    const picker = form.querySelector('[data-money-invoice-picker]');
    form.querySelector('[data-money-invoice-picker-toggle]')?.addEventListener('click', () => {
      if (picker) picker.hidden = !picker.hidden;
    });
    form.querySelector('[data-money-invoice-add-manual]')?.addEventListener('click', () => {
      addInvoiceComposerLine(form, { type:'manual', description:(globalThis.PlatformLanguage?.text("money","m_2e105a57c9384a","Custom item") ?? "Custom item"), amount_cents:0, paid:false });
      form.querySelector('[data-money-invoice-line]:last-child [data-money-invoice-line-title]')?.select?.();
    });
    form.querySelectorAll('[data-money-invoice-add-payment]').forEach((button) => {
      button.addEventListener('click', () => {
        const obligation = obligations().find((item) => cleanText(item.id) === cleanText(button.dataset.moneyInvoiceAddPayment));
        if (!obligation) return;
        const paid = cleanText(obligation.status).toLowerCase() === 'paid';
        const amountCents = paid ? cents(obligation.amount_cents) : Math.max(0, cents(obligation.amount_cents) - cents(obligation.allocated_cents));
        addInvoiceComposerLine(form, { type:'payment', obligation_id:obligation.id, description:obligation.label || 'Project payment', amount_cents:amountCents, paid });
      });
    });
    form.addEventListener('click', (event) => {
      const remove = event.target.closest?.('[data-money-invoice-line-remove]');
      if (!remove) return;
      remove.closest('[data-money-invoice-line]')?.remove();
      const paidToggle = form.querySelector('[data-money-invoice-paid-toggle]');
      if (!form.querySelector('[data-money-invoice-line]') && paidToggle) paidToggle.dataset.userChanged = '';
      updateInvoiceComposer(form);
    });
    form.addEventListener('input', (event) => {
      if (event.target.matches?.('[data-money-invoice-line-amount],[data-money-invoice-tax-percent]')) updateInvoiceComposer(form, { resetPaidDefault:false });
    });
    form.querySelector('[data-money-invoice-tax-toggle]')?.addEventListener('change', () => updateInvoiceComposer(form, { resetPaidDefault:false }));
    form.querySelector('[data-money-invoice-paid-toggle]')?.addEventListener('change', (event) => { event.currentTarget.dataset.userChanged = 'true'; });
    updateInvoiceComposer(form);
  }

  function invoiceEmailModal(invoiceId, paidPresentation = false){
    const invoice = findInvoice(invoiceId) || {};
    const recipient = customerEmail() || cleanText(invoice?.customer?.email);
    return `
      <div class="mn-modal-shade" data-money-invoice-email-modal>
        <div class="mn-invoice-email-modal" role="dialog" aria-modal="true" aria-labelledby="mn-invoice-email-title">
          <div class="mn-receipt-modal-head"><strong id="mn-invoice-email-title">${String(invoiceId ? `Email ${escapeHtml(invoice.invoice_number || 'Invoice')}` : 'Generate and Email Invoice')}</strong><button type="button" class="mn-icon-btn" title="${(globalThis.PlatformLanguage?.text("money","m_3742924668fb10","Close") ?? "Close")}" aria-label="${(globalThis.PlatformLanguage?.text("money","m_9fec01010b24a1","Close email invoice") ?? "Close email invoice")}" data-money-invoice-email-close><i class="fas fa-xmark"></i></button></div>
          <form class="mn-form" data-money-invoice-email-modal-form data-invoice-id="${String(escapeHtml(invoiceId))}">
          <label class="wide"><span>${(globalThis.PlatformLanguage?.text("money","m_14b1c9a789a757","Email To") ?? "Email To")}</span><input class="mn-input" name="recipient" type="email" value="${String(escapeHtml(recipient))}" placeholder="${(globalThis.PlatformLanguage?.text("money","m_2780de7b9bd16a","customer@example.com") ?? "customer@example.com")}" required></label>
          <label class="wide"><span>${(globalThis.PlatformLanguage?.text("money","m_a16cfd85cfd122","Message") ?? "Message")}</span><textarea class="mn-input" name="message" rows="3" placeholder="${(globalThis.PlatformLanguage?.text("money","m_7321fe3378912c","Your invoice is attached.") ?? "Your invoice is attached.")}"></textarea></label>
          <label class="wide mn-check"><input type="checkbox" name="include_portal_link" ${String(paidPresentation ? '' : 'checked')}><span>${((v4) => globalThis.PlatformLanguage?.text("money","m_ef10c2a3c0ee95",`Include the customer portal link${v4}`,{v4}) ?? `Include the customer portal link${v4}`)(paidPresentation ? '' : ' to pay')}</span></label>
          <div class="mn-form-actions"><button type="button" class="mn-btn" data-money-invoice-email-close>${(globalThis.PlatformLanguage?.text("money","m_cbef679b21abb4","Cancel") ?? "Cancel")}</button><button type="submit" class="mn-btn primary" ${String(moneyMutationBusy() ? 'disabled' : '')}><i class="fas fa-paper-plane"></i> ${String(invoiceId ? 'Send Invoice' : 'Generate & Send')}</button></div>
          </form>
        </div>
      </div>
    `;
  }

  function openInvoiceEmailModal(root, options = {}){
    const invoiceForm = options.invoiceForm || null;
    const invoiceId = cleanText(options.invoiceId);
    const paidPresentation = invoiceId
      ? findInvoice(invoiceId)?.render_paid_in_full === true
      : !!invoiceForm?.querySelector('[data-money-invoice-paid-toggle]')?.checked;
    root.querySelector('[data-money-invoice-email-modal]')?.remove();
    root.insertAdjacentHTML('beforeend', invoiceEmailModal(invoiceId, paidPresentation));
    const shade = root.querySelector('[data-money-invoice-email-modal]');
    const close = () => shade?.remove();
    shade?.querySelectorAll('[data-money-invoice-email-close]').forEach((button) => button.addEventListener('click', close));
    shade?.addEventListener('click', (event) => { if (event.target === shade) close(); });
    shade?.querySelector('[data-money-invoice-email-modal-form]')?.addEventListener('submit', (event) => {
      if (invoiceId) void submitInvoiceEmail(event);
      else void submitGeneratedInvoiceEmail(event, invoiceForm);
    });
    shade?.querySelector('input[name="recipient"]')?.focus();
  }

  function bindLeft(){
    state.leftRoot?.querySelectorAll?.('[data-money-schedule]').forEach((button) => {
      button.addEventListener('click', () => {
        state.activeScheduleId = button.dataset.moneySchedule || 'all';
        renderLeft();
      });
    });
    state.leftRoot?.querySelector?.('[data-money-take-payment]')?.addEventListener('click', () => {
      if (!canManageMoney() || moneyMutationBusy()) return;
      setMoneyView('take_payment');
    });
    const leftRoot = state.leftRoot;
    leftRoot?.querySelector?.('[data-money-autopay-open]')?.addEventListener('click', () => {
      state.autopayEnrollOpen = true;
      state.autopayError = '';
      renderLeft();
    });
    leftRoot?.querySelector?.('[data-money-autopay-cancel]')?.addEventListener('click', () => {
      state.autopayEnrollOpen = false;
      state.autopayError = '';
      renderLeft();
    });
    leftRoot?.querySelector?.('[data-money-autopay-enroll]')?.addEventListener('click', () => {
      const methodId = cleanText(leftRoot.querySelector('[data-money-autopay-method]')?.value);
      const maxRaw = cleanText(leftRoot.querySelector('[data-money-autopay-max]')?.value);
      const maxCents = maxRaw ? centsFromDollars(maxRaw) : 0;
      if (!methodId) return;
      void autopayMutate(() => {
        const contact = primaryContact(state.project);
        return rootWindow.PaymentsAPI.autopay.enroll(orgId(), projectId(), {
          saved_method_id: methodId,
          status: 'active',
          max_amount_cents: maxCents > 0 ? maxCents : null,
          ...(contact ? { contact_ref: contact } : {})
        });
      });
    });
    leftRoot?.querySelector?.('[data-money-autopay-pause]')?.addEventListener('click', () => {
      void autopayMutate(() => rootWindow.PaymentsAPI.autopay.update(orgId(), projectId(), { status: 'paused' }));
    });
    leftRoot?.querySelector?.('[data-money-autopay-resume]')?.addEventListener('click', () => {
      void autopayMutate(() => rootWindow.PaymentsAPI.autopay.update(orgId(), projectId(), { status: 'active' }));
    });
    leftRoot?.querySelector?.('[data-money-autopay-remove]')?.addEventListener('click', () => {
      void autopayMutate(async () => {
        await rootWindow.PaymentsAPI.autopay.remove(orgId(), projectId());
        return { autopay: null };
      });
    });
  }

  function bindMain(root){
    const canManage = canManageMoney();
    const ledgerHeaderDefinitions = [
      ['date', 'Date'],
      ['transaction', term('transaction')],
      ['status', 'Status'],
      ['receipt', term('receipt')],
      ['money_in', 'In', 'end'],
      ['money_out', 'Out', 'end'],
      ['balance', term('balance'), 'end']
    ];
    root.querySelectorAll('.mn-ledger-table thead th').forEach((header, index) => {
      const definition = ledgerHeaderDefinitions[index];
      if (!definition) {
        header.setAttribute('aria-label', (globalThis.PlatformLanguage?.text("money","m_6067958dea3386","Actions") ?? "Actions"));
        return;
      }
      const template = document.createElement('template');
      template.innerHTML = ledgerSortHeader(...definition);
      header.replaceWith(template.content.firstElementChild);
    });
    root.querySelector('[data-money-refresh]')?.addEventListener('click', () => loadData());
    if (canManage) {
    root.querySelectorAll('[data-money-upload-receipt]').forEach((button) => {
      button.addEventListener('click', () => {
        if (!moneyMutationBusy() && !state.receiptUploadInFlight) root.querySelector('[data-money-receipt-input]')?.click();
      });
    });
      root.querySelector('[data-money-receipt-input]')?.addEventListener('change', (event) => {
        const files = Array.from(event.target.files || []);
        event.target.value = '';
        if (files.length && !moneyMutationBusy() && !state.receiptUploadInFlight) void uploadReceipts(files);
      });
    }
    root.querySelector('[data-money-batch-close]')?.addEventListener('click', () => {
      state.receiptBatch = null;
      renderMain();
    });
    root.querySelectorAll('[data-money-batch-review]').forEach((button) => {
      button.addEventListener('click', () => {
        const receipt = state.receiptBatch?.items?.find((item) => cleanText(item.receipt?.id) === cleanText(button.dataset.moneyBatchReview))?.receipt;
        if (!receipt) return;
        state.receiptBatch = null;
        state.receiptReview = { phase:'ready', receipt };
        renderMain();
      });
    });
    root.querySelector('[data-money-payment-back]')?.addEventListener('click', () => {
      setMoneyView('overview');
    });
    root.querySelectorAll('[data-money-view]').forEach((button) => {
      button.addEventListener('click', () => {
        setMoneyView(button.dataset.moneyView || 'overview');
      });
    });
    root.querySelectorAll('[data-money-action]').forEach((button) => {
      button.addEventListener('click', () => {
        if (!canManage || moneyMutationBusy()) return;
        state.action = { type: button.dataset.moneyAction, paymentId: button.dataset.paymentId || '', payableId: button.dataset.payableId || '', invoiceId: button.dataset.invoiceId || '' };
        renderMain();
      });
    });
    root.querySelectorAll('[data-money-ledger-filter]').forEach((button) => {
      button.addEventListener('click', () => {
        const filter = cleanText(button.dataset.moneyLedgerFilter);
        if (!Object.prototype.hasOwnProperty.call(state.ledgerFilters, filter)) return;
        state.ledgerFilters[filter] = !state.ledgerFilters[filter];
        state.ledgerDetailKey = '';
        renderMain();
      });
    });
    root.querySelectorAll('[data-money-ledger-sort]').forEach((button) => {
      button.addEventListener('click', () => {
        const key = cleanText(button.dataset.moneyLedgerSort);
        const sortableKeys = new Set(['date', 'transaction', 'status', 'receipt', 'money_in', 'money_out', 'balance']);
        if (!sortableKeys.has(key)) return;
        const direction = state.ledgerSort.key === key && state.ledgerSort.direction === 'asc' ? 'desc' : 'asc';
        state.ledgerSort = { key, direction };
        state.ledgerDetailKey = '';
        renderMain();
      });
    });
    root.querySelectorAll('[data-money-ledger-detail]').forEach((button) => {
      button.addEventListener('click', () => {
        const key = cleanText(button.dataset.moneyLedgerDetail);
        state.ledgerDetailKey = state.ledgerDetailKey === key ? '' : key;
        renderMain();
      });
    });
    root.querySelectorAll('[data-money-delete-expense]').forEach((button) => {
      button.addEventListener('click', () => {
        if (canManage && !moneyMutationBusy()) void removeExpense(button.dataset.moneyDeleteExpense);
      });
    });
    root.querySelectorAll('[data-money-clear-payment]').forEach((button) => {
      button.addEventListener('click', () => {
        if (canManage && !moneyMutationBusy()) void clearPaymentAction(button.dataset.moneyClearPayment);
      });
    });
    root.querySelectorAll('[data-money-unclear-payment]').forEach((button) => {
      button.addEventListener('click', () => {
        if (canManage && !moneyMutationBusy()) void unclearPaymentAction(button.dataset.moneyUnclearPayment);
      });
    });
    root.querySelector('[data-money-report-form]')?.addEventListener('submit', (event) => {
      event.preventDefault();
      if (!canManage || moneyMutationBusy()) return;
      const data = new FormData(event.currentTarget);
      void generateMoneyReport({
        template_id:cleanText(data.get('template_id')),
        period_from:cleanText(data.get('period_from')),
        period_to:cleanText(data.get('period_to'))
      });
    });
    if (state.activeView === 'reports' && state.reports === null) void loadReports();
    root.querySelectorAll('[data-money-invoice-due]').forEach((button) => {
      button.addEventListener('click', () => {
        if (canManage && !moneyMutationBusy()) void markInvoiceDueNow(button.dataset.moneyInvoiceDue);
      });
    });
    root.querySelectorAll('[data-money-review-receipt]').forEach((button) => {
      button.addEventListener('click', () => {
        if (state.saving) return;
        const receipt = (expenseData().receipts || []).find((item) => cleanText(item?.id) === cleanText(button.dataset.moneyReviewReceipt));
        if (!receipt) return;
        state.activeView = 'receipts';
        rootWindow.Portal?.navigation?.push?.({ receipt:receipt.id, moneyView:'receipts' }, { source:'receipt-browser-open', ownedKeys:['receipt','moneyView'] });
        renderMain();
      });
    });
    root.querySelectorAll('[data-money-reextract-receipt]').forEach((button) => {
      button.addEventListener('click', () => {
        if (canManage && !moneyMutationBusy()) void reextractReceipt(button.dataset.moneyReextractReceipt);
      });
    });
    root.querySelectorAll('[data-money-void-receipt]').forEach((button) => {
      button.addEventListener('click', () => {
        if (canManage && !moneyMutationBusy()) void voidReceipt(button.dataset.moneyVoidReceipt);
      });
    });
    root.querySelectorAll('[data-money-receipt-close]').forEach((button) => {
      button.addEventListener('click', () => {
        if (state.saving) return;
        state.receiptOperationSequence += 1;
        state.receiptReview = null;
        rootWindow.Portal?.navigation?.backOrClose?.(['receipt'], { receipt:null }, { source:'receipt-review-close' });
        renderMain();
      });
    });
    root.querySelectorAll('[data-money-set-actual]').forEach((button) => {
      button.addEventListener('click', () => {
        if (canManage && !moneyMutationBusy()) void editExpenseActual(button);
      });
    });
    root.querySelector('[data-money-action-close]')?.addEventListener('click', () => {
      state.action = null;
      renderMain();
    });
    if (canManage) {
      root.querySelector('[data-money-payment-form]')?.addEventListener('submit', submitPayment);
      root.querySelector('[data-money-refund-form]')?.addEventListener('submit', submitRefund);
      root.querySelector('[data-money-reallocate-form]')?.addEventListener('submit', submitReallocate);
      root.querySelector('[data-money-payable-form]')?.addEventListener('submit', submitPayable);
      root.querySelector('[data-money-disbursement-form]')?.addEventListener('submit', submitDisbursement);
      root.querySelector('[data-money-supplemental-form]')?.addEventListener('submit', submitSupplementalExpense);
      const invoiceForm = root.querySelector('[data-money-invoice-form]');
      invoiceForm?.addEventListener('submit', submitInvoice);
      bindInvoiceComposer(invoiceForm);
      invoiceForm?.querySelector('[data-money-invoice-email-review]')?.addEventListener('click', () => openInvoiceEmailModal(root, { invoiceForm }));
      root.querySelectorAll('[data-money-invoice-email-existing]').forEach((button) => {
        button.addEventListener('click', () => openInvoiceEmailModal(root, { invoiceId:button.dataset.moneyInvoiceEmailExisting }));
      });
      root.querySelector('[data-money-receipt-apply]')?.addEventListener('submit', submitReceiptApply);
      const reimburseSelect = root.querySelector('[data-money-reimburse-select]');
      if (reimburseSelect) {
        if (state.orgUsers === null) void loadOrgUsers();
        reimburseSelect.addEventListener('change', () => {
          const other = root.querySelector('[data-money-reimburse-other]');
          if (other) other.hidden = reimburseSelect.value !== '__other__';
        });
      }
    }
    mountPaymentIntake(root);
  }

  async function uploadLocationContext(){
    const context = {
      client_timezone: Intl.DateTimeFormat(globalThis.PlatformLanguage?.formatLocale?.()).resolvedOptions().timeZone || '',
      timezone_offset_minutes: new Date().getTimezoneOffset(),
      surface: 'project_money',
      route: location.pathname
    };
    if (!navigator.permissions?.query || !navigator.geolocation?.getCurrentPosition) return { client:context };
    try {
      const permission = await navigator.permissions.query({ name:'geolocation' });
      if (permission.state !== 'granted') return { client:context };
      const position = await new Promise((resolve) => navigator.geolocation.getCurrentPosition(resolve, () => resolve(null), {
        enableHighAccuracy:false,
        maximumAge:300000,
        timeout:1500
      }));
      if (position?.coords) context.device_coordinates = {
        latitude:position.coords.latitude,
        longitude:position.coords.longitude,
        accuracy_meters:position.coords.accuracy,
        captured_at:new Date(position.timestamp || Date.now()).toISOString(),
        source:'browser_geolocation_permission_granted'
      };
    } catch (_) {}
    return { client:context };
  }

  async function uploadReceipts(filesValue){
    const files = Array.from(filesValue || []).filter(Boolean);
    if (!rootWindow.PaymentsAPI?.receipts?.uploadBatch) return showToast((globalThis.PlatformLanguage?.text("money","m_5ddd55f5542f77","Receipt upload unavailable") ?? "Receipt upload unavailable"), (globalThis.PlatformLanguage?.text("money","m_13c311fc1f57d6","The batch receipt API is not loaded.") ?? "The batch receipt API is not loaded."), 'error');
    if (!files.length) return;
    if (!canManageMoney() || moneyMutationBusy()) return;
    const requestedOrgId = orgId();
    const requestedProjectId = projectId();
    const requestedBranchId = branchId();
    const uploadToken = ++state.receiptUploadToken;
    ++state.receiptOperationSequence;
    state.receiptUploadInFlight = true;
    const uploadOwnsLock = () => uploadToken === state.receiptUploadToken;
    const operationIsCurrent = () => uploadOwnsLock() && requestedOrgId === orgId() && requestedProjectId === projectId();
    const batchState = {
      token:uploadToken,
      items:files.map((file, index) => ({ id:`pending-${uploadToken}-${index}`, index, file_name:file.name || `Receipt ${index + 1}`, size_bytes:file.size || 0, content_type:file.type || '', status:'queued', receipt:null, error:'' }))
    };
    state.receiptReview = null;
    state.receiptBatch = batchState;
    renderMain();
    try {
      const uploadLocation = await uploadLocationContext();
      if (!operationIsCurrent()) return;
      const result = await rootWindow.PaymentsAPI.receipts.uploadBatch(requestedOrgId, requestedProjectId, files, {
        concurrency:4,
        upload_location:uploadLocation,
        idempotency_key:rootWindow.crypto?.randomUUID?.() || `receipt-batch-${Date.now()}`,
        metadata:{ source_surface:'project_money', project_id:requestedProjectId, branch_id:requestedBranchId },
        onUpdate:(_item, items) => {
          if (!operationIsCurrent()) return;
          if (state.receiptBatch?.token === uploadToken) {
            state.receiptBatch.items = items;
            const newestSummary = [...items].reverse().find((item) => item.result?.expense_summary)?.result?.expense_summary;
            if (newestSummary && state.summary) state.summary = { ...state.summary, expense_summary:newestSummary };
          }
          renderMain();
        }
      });
      if (!operationIsCurrent()) return;
      showToast(((v0,v1) => globalThis.PlatformLanguage?.text("money","m_7a7a9eeff9ac00",`${v0} receipt${v1} ready to match.`,{v0,v1}) ?? `${v0} receipt${v1} ready to match.`)(result.succeeded,result.succeeded === 1 ? '' : 's'), result.failed ? `${result.failed} file${result.failed === 1 ? '' : 's'} need attention.` : 'AI categorization completed.', result.failed === 0);
    } catch (error) {
      if (!operationIsCurrent()) return;
      showToast(error?.message || 'Could not upload these receipts.', (globalThis.PlatformLanguage?.text("money","m_7e784f9b5540ab","error") ?? "error"));
    } finally {
      if (uploadOwnsLock()) {
        state.receiptUploadInFlight = false;
        if (requestedOrgId === orgId() && requestedProjectId === projectId()) renderMain();
      }
    }
  }

  async function reextractReceipt(receiptId){
    if (!receiptId || !canManageMoney() || moneyMutationBusy()) return;
    await withSave(async () => {
      const result = await rootWindow.PaymentsAPI.receipts.extract(orgId(), receiptId);
      if (state.receiptReview?.receipt?.id === receiptId) state.receiptReview = { phase:'ready', receipt:result.receipt };
    }, 'Receipt extraction refreshed.');
  }

  async function voidReceipt(receiptId){
    if (!receiptId || !canManageMoney() || moneyMutationBusy()) return;
    const requestedOrgId = orgId();
    const requestedProjectId = projectId();
    const confirmFn = rootWindow.PlatformUI?.confirm || rootWindow.confirm;
    const confirmed = await Promise.resolve(confirmFn('Void this receipt? Its original evidence remains stored, but it will no longer affect expenses.'));
    if (!confirmed || !canManageMoney() || moneyMutationBusy() || requestedOrgId !== orgId() || requestedProjectId !== projectId()) return;
    await withSave(async () => {
      await rootWindow.PaymentsAPI.receipts.remove(requestedOrgId, receiptId);
      if (state.receiptReview?.receipt?.id === receiptId) state.receiptReview = null;
    }, 'Receipt voided.');
  }

  async function submitReceiptApply(event){
    event.preventDefault();
    if (!canManageMoney() || moneyMutationBusy()) return;
    const form = event.currentTarget;
    const receipt = state.receiptReview?.receipt || {};
    const requestedOrgId = orgId();
    const requestedProjectId = projectId();
    const receiptId = cleanText(form.dataset.receiptId);
    const operationSequence = ++state.receiptOperationSequence;
    const operationIsCurrent = () => (
      operationSequence === state.receiptOperationSequence
      && requestedOrgId === orgId()
      && requestedProjectId === projectId()
    );
    const data = new FormData(form);
    const targetKeys = data.getAll('target_key').map(cleanText).filter(Boolean);
    const total = centsFromDollars(data.get('total'));
    if (!targetKeys.length) return showToast((globalThis.PlatformLanguage?.text("money","m_226c50da93a695","Select at least one expense list.") ?? "Select at least one expense list."), (globalThis.PlatformLanguage?.text("money","m_7e784f9b5540ab","error") ?? "error"));
    if (total <= 0) return showToast((globalThis.PlatformLanguage?.text("money","m_4a53195eb31ba7","Enter the receipt total.") ?? "Enter the receipt total."), (globalThis.PlatformLanguage?.text("money","m_7e784f9b5540ab","error") ?? "error"));
    if (receipt.duplicate_of_receipt_id && data.get('confirm_duplicate') !== 'yes') return showToast((globalThis.PlatformLanguage?.text("money","m_adaa9e9e5c1e78","Confirm that this duplicate file is a separate project expense before applying it.") ?? "Confirm that this duplicate file is a separate project expense before applying it."), (globalThis.PlatformLanguage?.text("money","m_7e784f9b5540ab","error") ?? "error"));
    const suggestions = new Set(receipt.suggested_target_keys || []);
    const acceptedSuggestion = suggestions.size === targetKeys.length && targetKeys.every((key) => suggestions.has(key));
    state.saving = true;
    renderMain();
    try {
      const reimburseSelection = cleanText(data.get('reimburse_user'));
      const reimburseOtherName = cleanText(data.get('reimburse_other_name'));
      let reimbursementPayee = null;
      if (reimburseSelection === '__other__' && reimburseOtherName) {
        reimbursementPayee = {
          kind:'manual_payee',
          id:reimburseOtherName.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'payee',
          name:reimburseOtherName
        };
      } else if (reimburseSelection && reimburseSelection !== '__other__') {
        const user = (state.orgUsers || []).find((entry) => entry.id === reimburseSelection);
        reimbursementPayee = { kind:'organization_user', id:reimburseSelection, name:user?.name || reimburseSelection };
      }
      const result = await rootWindow.PaymentsAPI.receipts.apply(requestedOrgId, receiptId, {
        ...(Number(receipt.revision || 0) > 0 ? { expected_revision:Number(receipt.revision) } : {}),
        total_cents:total,
        purchase_date:cleanText(data.get('purchase_date')),
        purchase_time:cleanText(data.get('purchase_time')),
        target_keys:targetKeys,
        accepted_suggestion:acceptedSuggestion,
        ...(reimbursementPayee ? { reimbursement:{ payee_ref:reimbursementPayee } } : {})
      });
      if (!operationIsCurrent()) return;
      if (result.expense_summary && state.summary) state.summary = { ...state.summary, expense_summary:result.expense_summary };
      state.receiptReview = null;
      showToast(result.reimbursement_payable
        ? `Receipt applied. Reimbursement owed to ${result.reimbursement_payable.payee_ref?.name || 'the payee'} was added to payables.`
        : 'Receipt applied to project expenses.', (globalThis.PlatformLanguage?.text("money","m_b4e54589824dc5","success") ?? "success"));
      await loadData();
    } catch (error) {
      if (!operationIsCurrent()) return;
      state.error = error?.message || 'Could not apply this receipt.';
      showToast(state.error, (globalThis.PlatformLanguage?.text("money","m_7e784f9b5540ab","error") ?? "error"));
    } finally {
      if (operationIsCurrent()) {
        state.saving = false;
        renderMain();
      }
    }
  }

  async function editExpenseActual(button){
    if (!canManageMoney() || moneyMutationBusy()) return;
    const requestedOrgId = orgId();
    const requestedProjectId = projectId();
    const currentCents = cleanText(button.dataset.currentActual);
    const projectedCents = cents(button.dataset.projected);
    const initial = currentCents ? (cents(currentCents) / 100).toFixed(2) : (projectedCents / 100).toFixed(2);
    const promptFn = rootWindow.PlatformUI?.prompt || rootWindow.prompt;
    const value = await Promise.resolve(promptFn('Enter the actual expense in dollars. Leave blank to return to the projection.', initial));
    if (value == null || !canManageMoney() || moneyMutationBusy() || requestedOrgId !== orgId() || requestedProjectId !== projectId()) return;
    const actualCents = cleanText(value) ? centsFromDollars(value) : null;
    await withSave(async () => {
      await rootWindow.PaymentsAPI.expenses.setActual(requestedOrgId, requestedProjectId, {
        target_key:button.dataset.moneySetActual,
        actual_cents:actualCents,
        ...(Number(button.dataset.actualRevision || 0) > 0 ? { expected_revision:Number(button.dataset.actualRevision) } : {}),
        reason:'money_tab_manual_actual'
      });
    }, actualCents == null ? 'Actual override cleared.' : 'Actual expense updated.');
  }

  async function submitSupplementalExpense(event){
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    const amount = centsFromDollars(data.get('amount'));
    if (amount <= 0) return;
    await withSave(async () => {
      await rootWindow.PaymentsAPI.expenses.create(orgId(), projectId(), {
        title:cleanText(data.get('title')),
        projected_cents:amount,
        resource_type:cleanText(data.get('resource_type')) || 'other',
        notes:cleanText(data.get('notes'))
      });
    }, 'Supplemental expense added.');
  }

  async function submitInvoice(event){
    event.preventDefault();
    await generateInvoice(event.currentTarget);
  }

  function invoiceDraft(form){
    const data = new FormData(form);
    const lineItems = Array.from(form.querySelectorAll('[data-money-invoice-line]')).map((line) => ({
      type:line.dataset.lineType === 'payment' ? 'payment' : 'manual',
      obligation_id:cleanText(line.dataset.obligationId),
      description:cleanText(line.querySelector('[data-money-invoice-line-title]')?.value),
      amount_cents:Math.max(0, centsFromDollars(line.querySelector('[data-money-invoice-line-amount]')?.value))
    }));
    if (!lineItems.length) {
      showToast((globalThis.PlatformLanguage?.text("money","m_500e624e18fd4b","Add at least one invoice item.") ?? "Add at least one invoice item."), (globalThis.PlatformLanguage?.text("money","m_7e784f9b5540ab","error") ?? "error"));
      return null;
    }
    if (lineItems.some((line) => !line.description || line.amount_cents <= 0)) {
      showToast((globalThis.PlatformLanguage?.text("money","m_8374459e4ed14e","Every invoice item needs a title and an amount greater than zero.") ?? "Every invoice item needs a title and an amount greater than zero."), (globalThis.PlatformLanguage?.text("money","m_7e784f9b5540ab","error") ?? "error"));
      return null;
    }
    return { data, lineItems };
  }

  async function generateInvoice(form, email = null){
    const draft = invoiceDraft(form);
    if (!draft) return false;
    const { data, lineItems } = draft;
    const recipient = cleanText(email?.recipient);
    if (email && !recipient) {
      showToast((globalThis.PlatformLanguage?.text("money","m_16feb9c0f8092f","Enter the customer email before generating.") ?? "Enter the customer email before generating."), (globalThis.PlatformLanguage?.text("money","m_7e784f9b5540ab","error") ?? "error"));
      return false;
    }
    await withSave(async () => {
      const generated = await rootWindow.PaymentsAPI.invoices.create(orgId(), projectId(), {
        obligation_ids:lineItems.map((line) => line.obligation_id).filter(Boolean),
        line_items:lineItems,
        tax_enabled:data.get('tax_enabled') === 'on',
        tax_percent:Math.min(100, Math.max(0, Number(data.get('tax_percent') || 0))),
        issue_date:cleanText(data.get('issue_date')),
        due_date:cleanText(data.get('due_date')),
        render_paid_in_full:data.get('render_paid_in_full') === 'on',
        notes:cleanText(data.get('notes'))
      });
      const invoice = generated.invoice || {};
      if (email) {
        await rootWindow.PaymentsAPI.invoices.email(orgId(), invoice.id, {
          recipient,
          include_portal_link:email.includePortalLink === true,
          message:cleanText(email.message)
        });
      } else {
        const link = document.createElement('a');
        link.href = rootWindow.PaymentsAPI.invoices.pdfUrl(orgId(), invoice.id);
        link.download = `${cleanText(invoice.invoice_number || 'invoice').toLowerCase()}.pdf`;
        document.body.appendChild(link);
        link.click();
        link.remove();
      }
    }, email ? `Invoice generated and emailed to ${recipient}.` : 'Invoice generated and download started.');
    return true;
  }

  async function submitGeneratedInvoiceEmail(event, invoiceForm){
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    await generateInvoice(invoiceForm, {
      recipient:cleanText(data.get('recipient')),
      includePortalLink:data.get('include_portal_link') === 'on',
      message:cleanText(data.get('message'))
    });
  }

  async function clearPaymentAction(paymentId){
    const id = cleanText(paymentId);
    if (!id) return;
    await withSave(async () => {
      await rootWindow.PaymentsAPI.payments.clear(orgId(), id, {});
    }, 'Payment marked cleared.');
  }

  async function unclearPaymentAction(paymentId){
    const id = cleanText(paymentId);
    if (!id) return;
    await withSave(async () => {
      await rootWindow.PaymentsAPI.payments.unclear(orgId(), id);
    }, 'Payment reconciliation reopened.');
  }

  async function markInvoiceDueNow(invoiceId){
    const invoice = findInvoice(invoiceId);
    if (!invoice) return;
    const confirmFn = rootWindow.confirm || (() => true);
    const confirmed = confirmFn(`Mark ${invoice.invoice_number || 'this invoice'} as due now? This publishes the payment to the customer portal.`);
    if (!confirmed) return;
    await withSave(async () => {
      await rootWindow.PaymentsAPI.invoices.markDue(orgId(), invoiceId, {});
    }, 'Invoice is due and available in the customer portal.');
  }

  async function submitInvoiceEmail(event){
    event.preventDefault();
    const form = event.currentTarget;
    const data = new FormData(form);
    const recipient = cleanText(data.get('recipient'));
    if (!recipient) return showToast((globalThis.PlatformLanguage?.text("money","m_26a722f92451ba","Enter an email address.") ?? "Enter an email address."), (globalThis.PlatformLanguage?.text("money","m_7e784f9b5540ab","error") ?? "error"));
    const includePortalLink = data.get('include_portal_link') === 'on';
    await withSave(async () => {
      await rootWindow.PaymentsAPI.invoices.email(orgId(), form.dataset.invoiceId, {
        recipient,
        include_portal_link:includePortalLink,
        message:cleanText(data.get('message'))
      });
    }, `Invoice emailed to ${recipient}.`);
  }

  function paymentIntakeContactRef(){
    const contact = primaryContact(state.project || {}) || {};
    return cleanText(contact.id, contact.contact_id, String(contact.email || '').toLowerCase());
  }

  function paymentIntakeProviderOptions(){
    // Provider tokenization options — present only when the org resolves a
    // payment provider (state.paymentIntakeConfig.config non-null). Without
    // one every option below is omitted and the modal behaves exactly as the
    // legacy mock-record flow.
    const entry = state.paymentIntakeConfig;
    const config = entry && entry.key === `${orgId()}:${projectId()}` ? entry.config : null;
    if (!config || !config.provider) return {};
    const requestedOrgId = orgId();
    return {
      savedMethods: Array.isArray(config.saved_methods) ? config.saved_methods : [],
      tokenization: {
        mode: cleanText(config.tokenization?.mode) || 'mock',
        sdkUrl: cleanText(config.tokenization?.sdk_url),
        createPaymentMethod: (request) => rootWindow.PaymentsAPI.intake.createPaymentMethodIntent(requestedOrgId, request)
      },
      ...(config.surcharge?.enabled === true ? {
        surcharge: {
          enabled: true,
          mode: cleanText(config.surcharge.mode) || 'card_only',
          quote: async (amountCents, method) => (await rootWindow.PaymentsAPI.intake.surchargeQuote(requestedOrgId, { amount_cents: amountCents, method, branch_id: branchId() }))?.quote
        }
      } : {})
    };
  }

  async function refreshPaymentIntakeConfig(){
    const requestedKey = `${orgId()}:${projectId()}`;
    if (state.paymentIntakeConfig?.key === requestedKey) return state.paymentIntakeConfig.config;
    let config = null;
    try {
      if (rootWindow.PaymentsAPI?.intake?.config) {
        const result = await rootWindow.PaymentsAPI.intake.config(orgId(), {
          contact_ref: paymentIntakeContactRef(),
          branch_id: branchId()
        });
        config = result?.provider ? result : null;
        // Cache only definitive answers; a failed/aborted fetch must not pin
        // the org to the legacy flow for the rest of the session.
        state.paymentIntakeConfig = { key: requestedKey, config };
      }
    } catch (_) {
      config = null;
    }
    return config;
  }

  function paymentIntakeOptions(){
    const project = state.project || {};
    const contact = primaryContact(project);
    const primaryColor = rootWindow.getComputedStyle?.(document.documentElement).getPropertyValue('--primary').trim() || '#d93025';
    return {
      ...paymentIntakeProviderOptions(),
      title: (globalThis.PlatformLanguage?.text("money","m_75818d576558e2","Take a payment") ?? "Take a payment"),
      description: cleanText(contact?.name, project.address, project.title) ? `Collect a customer payment for ${cleanText(contact?.name, project.address, project.title)}.` : 'Collect a customer payment over the phone.',
      amountLabel: `${term('collected_payment')} amount`,
      amountCents: null,
      allowCustomAmount: true,
      methods: ['card', 'ach'],
      contact,
      allowSavedMethods: !!contact,
      allowSavePaymentMethod: true,
      primaryColor,
      submitLabel: term('save_collected_payment'),
      successTitle: `${term('collected_payment')} recorded`,
      details: [
        { label: (globalThis.PlatformLanguage?.text("money","m_aaebd7ccba0b30","Project") ?? "Project"), value: cleanText(project.title, project.address, projectId(), 'Current project') },
        { label: (globalThis.PlatformLanguage?.text("money","m_ae8e4953e07d70","Customer") ?? "Customer"), value: cleanText(contact?.name, contact?.email, contact?.phone, 'No contact selected') }
      ],
      successActions: [
        { label: (globalThis.PlatformLanguage?.text("money","m_1641c7d3dd9d7c","Print receipt") ?? "Print receipt"), onClick: (result) => printReceipt(result) },
        { label: (globalThis.PlatformLanguage?.text("money","m_44d5a64ac2cb37","Email receipt") ?? "Email receipt"), onClick: () => showToast((globalThis.PlatformLanguage?.text("money","m_ba3d2dc718b8ac","Receipt email is ready for processor wiring.") ?? "Receipt email is ready for processor wiring."), (globalThis.PlatformLanguage?.text("money","m_b4e54589824dc5","success") ?? "success")) },
        { label: (globalThis.PlatformLanguage?.text("money","m_f4305fea9e5634","Back to Money") ?? "Back to Money"), primary: true, onClick: () => { setMoneyView('overview'); void loadData(); } }
      ],
      onSubmit: async (payment) => {
        if (!canManageMoney() || moneyMutationBusy()) throw new Error('You do not have permission to record this payment, or another money change is still saving.');
        const requestedOrgId = orgId();
        const requestedProjectId = projectId();
        const requestedBranchId = branchId();
        const mutationToken = ++state.mutationToken;
        state.saving = true;
        const methodLabel = payment.savedPaymentMethod?.label || titleText(payment.method || 'payment');
        try {
          const tokenized = !!(payment.payment_method_id || payment.saved_method_id);
          const result = await rootWindow.PaymentsAPI.payments.create(requestedOrgId, {
            project_id: requestedProjectId,
            branch_id: requestedBranchId,
            amount_cents: payment.amountCents,
            kind: 'customer_payment',
            direction: 'inbound',
            status: 'settled',
            allocate: true,
            method: {
              type: payment.savedPaymentMethodId ? `saved_${payment.method}` : payment.method,
              label: methodLabel,
              ...(payment.brand ? { brand: payment.brand } : {}),
              ...(payment.last4 ? { last4: payment.last4 } : {})
            },
            contact_ref: contact || {},
            notes: payment.savedPaymentMethodId ? `Charged saved payment method ${methodLabel}.` : `Collected by ${titleText(payment.method)}.`,
            // Provider charge path: tokenized submissions carry the payment
            // method token; the server charges through the processor before
            // recording. Absent a token (or provider) nothing changes.
            ...(tokenized ? {
              payment_method_id: cleanText(payment.payment_method_id),
              saved_method_id: cleanText(payment.saved_method_id),
              save_payment_method: payment.save_method === true,
              method_label: methodLabel
            } : {})
          });
          if (tokenized) state.paymentIntakeConfig = null;
          showToast((globalThis.PlatformLanguage?.text("money","m_479951a836e19a","Payment saved.") ?? "Payment saved."), (globalThis.PlatformLanguage?.text("money","m_b4e54589824dc5","success") ?? "success"));
          return result?.payment || result || {};
        } finally {
          if (mutationToken === state.mutationToken && requestedOrgId === orgId() && requestedProjectId === projectId()) {
            state.saving = false;
            if (state.activeView === 'take_payment') renderLeft();
            else renderAll();
          }
        }
      }
    };
  }

  function mountPaymentIntake(root){
    const mount = root.querySelector('[data-money-payment-intake]');
    if (!canManageMoney() || !mount || !rootWindow.FirstMatePaymentIntake?.mount) {
      state.paymentIntakeHandle?.close?.();
      state.paymentIntakeHandle = null;
      return;
    }
    state.paymentIntakeHandle?.close?.();
    state.paymentIntakeHandle = null;
    if (state.paymentIntakeConfig?.key === `${orgId()}:${projectId()}`) {
      state.paymentIntakeHandle = rootWindow.FirstMatePaymentIntake.mount(mount, paymentIntakeOptions());
      return;
    }
    // Resolve provider config once per org+project before mounting so the
    // modal opens directly in the right mode (legacy when none resolves).
    void refreshPaymentIntakeConfig().then(() => {
      if (!mount.isConnected || !canManageMoney()) return;
      state.paymentIntakeHandle?.close?.();
      state.paymentIntakeHandle = rootWindow.FirstMatePaymentIntake.mount(mount, paymentIntakeOptions());
    });
  }

  function printReceipt(result = {}){
    const paymentId = cleanText(result.id, result.payment_id);
    const url = rootWindow.PaymentsAPI?.payments?.receiptPdfUrl?.(orgId(), paymentId);
    if (!paymentId || !url) return showToast((globalThis.PlatformLanguage?.text("money","m_5bedad4ed70b66","Payment receipt is not available yet.") ?? "Payment receipt is not available yet."), (globalThis.PlatformLanguage?.text("money","m_7e784f9b5540ab","error") ?? "error"));
    const win = window.open(url, '_blank', 'noopener');
    if (!win) showToast((globalThis.PlatformLanguage?.text("money","m_a3f7efd048a5e3","Could not open receipt PDF.") ?? "Could not open receipt PDF."), (globalThis.PlatformLanguage?.text("money","m_7e784f9b5540ab","error") ?? "error"));
  }

  async function withSave(work, successMessage){
    if (!canManageMoney() || moneyMutationBusy()) return false;
    const mutationToken = ++state.mutationToken;
    const mutationIsCurrent = () => mutationToken === state.mutationToken;
    state.saving = true;
    state.error = '';
    state.notice = '';
    renderMain();
    try {
      await work();
      if (!mutationIsCurrent()) return false;
      state.notice = successMessage || 'Saved.';
      showToast(state.notice, (globalThis.PlatformLanguage?.text("money","m_b4e54589824dc5","success") ?? "success"));
      state.action = null;
      await loadData();
      return true;
    } catch (error) {
      if (!mutationIsCurrent()) return false;
      state.error = error?.message || 'Could not save money changes.';
      showToast(state.error, (globalThis.PlatformLanguage?.text("money","m_7e784f9b5540ab","error") ?? "error"));
      renderMain();
      return false;
    } finally {
      if (mutationIsCurrent()) {
        state.saving = false;
        renderMain();
      }
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
      const expenseTargetKey = cleanText(data.get('expense_target_key'));
      await rootWindow.PaymentsAPI.payables.create(orgId(), {
        project_id: projectId(),
        branch_id: branchId(),
        amount_cents: amount,
        kind: cleanText(data.get('kind')) || 'other',
        due_at: cleanText(data.get('due_at')),
        notes: cleanText(data.get('notes')),
        expense_target_keys:expenseTargetKey ? [expenseTargetKey] : [],
        payee_ref: vendor ? { kind:'manual_payee', name:vendor } : {}
      });
    }, 'Expense added.');
  }

  async function removeExpense(expenseId){
    if (!canManageMoney() || moneyMutationBusy() || !expenseId) return;
    const expense = payables().find((item) => cleanText(item.id) === cleanText(expenseId));
    if (!expense || cents(expense.paid_cents) > 0) return showToast((globalThis.PlatformLanguage?.text("money","m_be2e9e776e4eb5","Paid expenses cannot be removed.") ?? "Paid expenses cannot be removed."), (globalThis.PlatformLanguage?.text("money","m_7e784f9b5540ab","error") ?? "error"));
    const approved = rootWindow.Portal?.ui?.confirm
      ? await rootWindow.Portal.ui.confirm((globalThis.PlatformLanguage?.text("money","m_cf842ec2f4d524","Remove this expense from the project ledger?") ?? "Remove this expense from the project ledger?"))
      : rootWindow.confirm((globalThis.PlatformLanguage?.text("money","m_cf842ec2f4d524","Remove this expense from the project ledger?") ?? "Remove this expense from the project ledger?"));
    if (!approved) return;
    await withSave(async () => {
      await rootWindow.PaymentsAPI.payables.remove(orgId(), expenseId);
      if (state.ledgerDetailKey === `expense:${expenseId}`) state.ledgerDetailKey = '';
    }, 'Expense removed.');
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
    const previousProjectId = projectId();
    const nextProjectId = cleanText(nextProject?.id, context.projectId, context.entityId);
    if (previousProjectId && nextProjectId && previousProjectId !== nextProjectId) reset();
    state.context = context;
    state.host = context.host || context.projectWorkspace || state.host;
    state.project = nextProject;
    state.panelRoot = context.panelRoot || context.roots?.main || context.root || state.panelRoot;
    state.leftRoot = context.leftRoot || context.roots?.left || state.leftRoot;
    state.active = context.active !== false;
    const routedView = rootWindow.Portal?.navigation?.read?.().moneyView;
    state.activeView = normalizeMoneyView(routedView || state.activeView);
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
      state.commissionHandle?.destroy?.();
      state.commissionHandle = null;
      state.receiptBrowserHandle?.destroy?.();
      state.receiptBrowserHandle = null;
      state.leftRoot?.querySelector?.('#rProposalList .mn-left')?.remove();
      const activeTab = state.host?.getActivePreviewTab?.() || state.context?.activeTab || '';
      if (!['proposal', 'materials', 'schedule', 'money'].includes(activeTab)) {
        state.leftRoot?.classList?.remove('visible', 'mode-edit', 'mode-list', 'mode-send');
      }
    }
  }

  function reset(){
    state.loadSequence += 1;
    state.receiptOperationSequence += 1;
    state.receiptUploadToken += 1;
    state.mutationToken += 1;
    state.receiptUploadInFlight = false;
    state.commissionHandle?.destroy?.();
    state.commissionHandle = null;
    state.receiptBrowserHandle?.destroy?.();
    state.receiptBrowserHandle = null;
    state.summary = null;
    state.events = [];
    state.invoices = [];
    state.invoiceSettings = { sales_tax_enabled:true, default_sales_tax_percent:0 };
    state.moneyTerms = { ...MONEY_TERM_DEFAULTS };
    state.error = '';
    state.notice = '';
    state.activeScheduleId = 'all';
    state.autopay = null;
    state.autopayBusy = false;
    state.autopayError = '';
    state.autopayEnrollOpen = false;
    state.activeView = 'overview';
    state.ledgerFilters = { payments:true, expenses:true, activity:false };
    state.ledgerSort = { key:'date', direction:'desc' };
    state.ledgerDetailKey = '';
    state.action = null;
    state.receiptReview = null;
    state.receiptBatch = null;
    state.actualEditKey = '';
    state.loading = false;
    state.saving = false;
    state.lastLoadedAt = '';
  }

  function unmount(){
    setWorkspaceChrome(false);
    state.leftRoot?.querySelector?.('#rProposalList .mn-left')?.remove();
    state.active = false;
    reset();
  }

  async function refreshMoneyTerminology(event){
    if (cleanText(event?.detail?.moduleId) !== 'variable_mappings' || !state.active || !orgId()) return;
    try {
      const config = await rootWindow.PlatformScheduling?.refreshBranchConfig?.(orgId(), branchId());
      state.moneyTerms = { ...MONEY_TERM_DEFAULTS, ...(config?.mappings?.labels?.money || {}) };
      renderAll();
    } catch (_) {}
  }
  rootWindow.addEventListener('fm:branch-module:updated', refreshMoneyTerminology);

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

  function applyMoneyRoute(route = rootWindow.Portal?.navigation?.read?.() || {}){
    if (!route.project || route.projectTab !== 'money' || !state.panelRoot) return;
    const nextView = normalizeMoneyView(route.moneyView);
    if (nextView === 'receipts' && state.activeView === 'receipts' && state.receiptBrowserHandle) {
      if (!cleanText(route.receipt)) state.receiptBrowserHandle.closeViewerFromRoute?.();
      return;
    }
    state.activeView = nextView;
    const receiptId = cleanText(route.receipt);
    if (!receiptId) state.receiptReview = null;
    else if (nextView !== 'receipts' && cleanText(state.receiptReview?.receipt?.id) !== receiptId) {
      const receipt = (expenseData().receipts || []).find((item) => cleanText(item?.id) === receiptId);
      if (receipt) state.receiptReview = { phase:'ready', receipt };
    }
    renderMain();
  }
  rootWindow.Portal?.navigation?.registerHandler?.('project-money-route', { priority:600, apply:applyMoneyRoute });

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
    title: (globalThis.PlatformLanguage?.text("money","m_05cb9dd7e5a780","Money") ?? "Money"),
    label: (globalThis.PlatformLanguage?.text("money","m_05cb9dd7e5a780","Money") ?? "Money"),
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
