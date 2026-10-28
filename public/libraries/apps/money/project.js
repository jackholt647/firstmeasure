/* public/libraries/apps/money/project.js
 * Project modal Money tab. One surface, no sidebar and no sub-tabs: a header like Docs and Photos (Money, with
 * Take a payment, Upload receipts and Generate invoice, then Reports and Settings), the project's six figures as a
 * row of tiles, and one ledger. The ledger starts with the payment schedule and lists every payment, refund,
 * expense, invoice and receipt, searchable, filtered by type or category, sorted by any column, as a list or as
 * tiles. Anything else (recording a payment or expense, an entry's details, refunds, invoices, reports, the
 * expense categories) opens as a modal over the tab. Explanations live in tooltips, not on the page.
 */
(function(){
  const rootWindow = window;
  const runtime = rootWindow.FirstMateEmbeddableApps;
  const Portal = rootWindow.Portal = rootWindow.Portal || {};
  const rawShowToast = Portal?.ui?.showToast || rootWindow.showToast || (() => {});

  function showToast(title, bodyOrStatus = '', okValue){
    const statusOnly = ['success', 'error'].includes(cleanText(bodyOrStatus).toLowerCase()) && okValue == null;
    const ok = statusOnly ? cleanText(bodyOrStatus).toLowerCase() === 'success' : !(okValue === false || cleanText(okValue).toLowerCase() === 'error');
    return rawShowToast(title, statusOnly ? '' : bodyOrStatus, ok);
  }

  // Expense categories are the payable `kind`. These four are the codes the platform has always written; an
  // organization renames or hides them and adds its own in Settings (branch module `money_settings`).
  const BUILT_IN_CATEGORIES = ['labor', 'material_order', 'reimbursement', 'other'];
  const LEDGER_VIEW_KEY = 'fm.money.ledgerView';
  const RECURRING_LIMIT = 36;
  // Modals holding a form are not redrawn by a background refresh, so what someone is typing survives it.
  const FORM_MODALS = new Set(['take_payment', 'add_payment', 'add_expense', 'invoice', 'settings', 'autopay']);

  const state = {
    context: null,
    host: null,
    panelRoot: null,
    project: null,
    active: false,
    loading: false,
    saving: false,
    error: '',
    summary: null,
    events: [],
    invoices: [],
    invoiceSettings: { sales_tax_enabled:true, default_sales_tax_percent:0 },
    reports: null,
    reportTemplates: [],
    reportGenerating: false,
    orgUsers: null,
    moneySettings: null,
    activeScheduleId: 'all',
    ledgerFilter: 'all',
    ledgerSearch: '',
    ledgerView: storedLedgerView(),
    ledgerSort: { key:'date', direction:'desc' },
    modal: null,
    paymentIntakeHandle: null,
    paymentIntakeConfig: null,
    autopay: null,
    autopayBusy: false,
    autopayError: '',
    receiptViewer: null,
    receiptReview: null,
    receiptBatch: null,
    loadSequence: 0,
    receiptOperationSequence: 0,
    receiptUploadToken: 0,
    receiptUploadInFlight: false,
    mutationToken: 0
  };

  function storedLedgerView(){
    try { return rootWindow.localStorage?.getItem(LEDGER_VIEW_KEY) === 'tiles' ? 'tiles' : 'list'; } catch (_) { return 'list'; }
  }

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

  function todayKey(){
    const now = new Date();
    return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
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

  // Money's words are config library terminology (namespace `money`), resolved with the organization's
  // overrides by PlatformTerminology; a key the library lacks reads as the key itself.
  function term(key){
    return cleanText(rootWindow.PlatformTerminology?.get?.(`money.${key}`, titleText(key)), titleText(key));
  }
  function moneyTerms(){
    return Object.fromEntries(Object.keys(rootWindow.PlatformTerminology?.DEFAULT_LABELS?.money || {}).map((key) => [key, term(key)]));
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

  function moneyMutationBusy(){
    return state.saving || state.receiptUploadInFlight;
  }

  function busyAttr(){
    return `data-money-busy ${moneyMutationBusy() ? 'disabled' : ''}`;
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
    return `<div class="mn-app" data-money-root><div class="mn-shell" data-money-shell><div class="mn-state"><i class="fas fa-circle-notch fa-spin"></i><span>${(globalThis.PlatformLanguage?.htmlText("money","m_487adb3f2ba511","Loading money...") ?? "Loading money...")}</span></div></div><div data-money-modal-layer></div></div>`;
  }

  function css(){
    return `
      .mn-app{height:100%;min-height:0;position:relative;container-type:inline-size;container-name:money;color:#101828}
      .mn-app *{box-sizing:border-box}
      .mn-app [hidden]{display:none!important}
      .mn-shell{height:100%;min-height:0;display:flex;flex-direction:column;gap:12px;padding:16px 18px;background:#f8fafc}
      .mn-state{flex:1;min-height:120px;display:flex;align-items:center;justify-content:center;gap:8px;color:#667085;font-size:13px;font-weight:700}
      .mn-toolbar{display:flex;align-items:center;justify-content:space-between;gap:14px;flex:none;min-width:0}
      .mn-title{display:flex;align-items:center;gap:11px;min-width:0}
      .mn-title>i{width:36px;height:36px;border-radius:10px;background:var(--primary,#d93025);color:var(--on-primary,#fff);display:flex;align-items:center;justify-content:center;flex:none}
      .mn-title strong{font-size:18px;line-height:1.15;white-space:nowrap}
      .mn-tools{display:flex;align-items:center;gap:8px;min-width:0}
      .mn-tool-sep{width:1px;height:24px;background:#e4e7ec;margin:0 2px;flex:none}
      .mn-btn{height:38px;border:1px solid #d0d5dd;border-radius:10px;background:#fff;color:#344054;padding:0 12px;font:inherit;font-size:12px;font-weight:800;display:inline-flex;align-items:center;justify-content:center;gap:8px;cursor:pointer;white-space:nowrap;text-decoration:none;flex:none;transition:border-color .15s ease,color .15s ease,background-color .15s ease}
      .mn-btn:hover:not(:disabled){border-color:rgba(var(--primary-rgb,217,48,37),.4);color:var(--primary-readable,var(--primary,#d93025))}
      .mn-btn.primary{background:var(--primary,#d93025);border-color:var(--primary,#d93025);color:var(--on-primary,#fff)}
      .mn-btn.primary:hover:not(:disabled){background:var(--primary-dark,var(--primary,#d93025));border-color:var(--primary-dark,var(--primary,#d93025));color:var(--on-primary,#fff)}
      .mn-btn.icon{width:38px;padding:0}
      .mn-btn.small{height:32px;border-radius:9px;padding:0 10px}
      .mn-btn.small.icon{width:32px;padding:0}
      .mn-btn.danger{color:#b42318;border-color:#fecdca}
      .mn-btn.danger:hover:not(:disabled){color:#b42318;border-color:#f97066;background:#fef3f2}
      .mn-btn:disabled{opacity:.5;cursor:not-allowed}
      .mn-metrics{display:grid;grid-template-columns:repeat(6,minmax(0,1fr));gap:8px;flex:none}
      .mn-metric{position:relative;display:flex;flex-direction:column;justify-content:flex-start;background:#fff;border:1px solid #eaecf0;border-radius:12px;padding:10px 12px;min-width:0;text-align:left;font:inherit;color:inherit}
      button.mn-metric{cursor:pointer}
      button.mn-metric:hover{border-color:rgba(var(--primary-rgb,217,48,37),.35)}
      .mn-metric:focus{outline:none}
      .mn-metric:focus-visible{outline:2px solid var(--primary,#d93025);outline-offset:1px}
      .mn-metric span{display:block;font-size:11px;font-weight:700;color:#667085;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
      .mn-metric strong{display:block;margin-top:3px;font-size:18px;line-height:1.2;font-weight:800;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;font-variant-numeric:tabular-nums}
      .mn-metric small{display:block;margin-top:2px;font-size:11px;color:#98a2b3;font-weight:600;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
      .mn-metric.bad strong{color:#b42318}
      .mn-bar{height:4px;border-radius:99px;background:#f2f4f7;overflow:hidden;margin-top:7px}
      .mn-bar i{display:block;height:100%;border-radius:inherit;background:var(--primary,#d93025)}
      .mn-ledger{flex:1;min-height:0;display:flex;flex-direction:column;background:#fff;border:1px solid #eaecf0;border-radius:14px;overflow:hidden}
      .mn-schedule{display:flex;align-items:stretch;gap:8px;padding:10px 12px;border-bottom:1px solid #eaecf0;overflow-x:auto;background:#fcfcfd;flex:none;scrollbar-width:thin}
      .mn-schedule-head{flex:none;display:flex;flex-direction:column;justify-content:center;gap:6px;padding-right:2px}
      .mn-schedule-head strong{display:flex;align-items:center;gap:6px;font-size:12px;white-space:nowrap}
      .mn-schedule-head strong i{color:var(--primary,#d93025)}
      .mn-schedule-head .mn-select{height:28px;font-size:12px;max-width:170px}
      .mn-due-card{flex:0 0 200px;min-width:0;border:1px solid #eaecf0;border-radius:10px;background:#fff;padding:8px 10px;display:flex;flex-direction:column;gap:5px}
      .mn-due-card.paid,.mn-due-card.void{opacity:.62}
      .mn-due-line{display:flex;align-items:center;justify-content:space-between;gap:8px;font-size:12px;min-width:0}
      .mn-due-line strong{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;display:flex;align-items:center;gap:5px}
      .mn-due-line strong i{color:#98a2b3;font-size:10px}
      .mn-due-line span{font-weight:800;font-variant-numeric:tabular-nums;white-space:nowrap}
      .mn-due-meta{display:flex;align-items:center;justify-content:space-between;gap:6px;font-size:11px;color:#667085;min-width:0}
      .mn-due-meta>span:last-child{white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
      .mn-due-card .mn-bar{margin-top:0}
      .mn-autopay{flex:0 0 auto;border:1px dashed #d0d5dd;border-radius:10px;background:#fff;padding:8px 10px;display:flex;flex-direction:column;justify-content:center;gap:6px;cursor:pointer;font:inherit;color:inherit;text-align:left;min-width:150px}
      .mn-autopay:hover{border-color:rgba(var(--primary-rgb,217,48,37),.45)}
      .mn-autopay strong{display:flex;align-items:center;gap:6px;font-size:12px}
      .mn-autopay strong i{color:var(--primary,#d93025)}
      .mn-ledger-bar{display:flex;align-items:center;gap:8px;padding:10px 12px;border-bottom:1px solid #eaecf0;flex:none;flex-wrap:wrap}
      .mn-search{position:relative;flex:1 1 220px;min-width:150px;max-width:360px}
      .mn-search i{position:absolute;left:11px;top:50%;transform:translateY(-50%);color:#98a2b3;font-size:12px;pointer-events:none}
      .mn-search input{width:100%;height:34px;border:1px solid #d0d5dd;border-radius:9px;padding:0 10px 0 31px;font:inherit;font-size:13px;outline:none;background:#fff;color:#101828}
      .mn-search input:focus,.mn-input:focus,.mn-select:focus{border-color:var(--primary,#d93025);box-shadow:0 0 0 4px rgba(var(--primary-rgb,217,48,37),.12)}
      .mn-filter{height:34px;max-width:200px}
      .mn-density{display:flex;border:1px solid #d0d5dd;border-radius:9px;overflow:hidden;background:#fff;flex:none}
      .mn-density button{width:34px;height:32px;border:0;background:#fff;color:#667085;cursor:pointer}
      .mn-density button.active{background:rgba(var(--primary-rgb,217,48,37),.1);color:var(--primary-readable,var(--primary,#d93025))}
      .mn-ledger-add{margin-left:auto;display:flex;align-items:center;gap:6px}
      .mn-ledger-body{flex:1;min-height:0;overflow:auto}
      .mn-table{width:100%;border-collapse:collapse;table-layout:fixed}
      .mn-table th{position:sticky;top:0;z-index:1;background:#fff;padding:8px 10px;font-size:11px;font-weight:700;color:#667085;text-align:left;border-bottom:1px solid #eaecf0;white-space:nowrap}
      .mn-table td{padding:7px 10px;border-bottom:1px solid #f2f4f7;font-size:13px;vertical-align:middle;min-width:0}
      .mn-table .mn-col-date{width:104px;color:#475467;white-space:nowrap}
      .mn-table .mn-col-cat{width:150px}
      .mn-table .mn-col-status{width:118px}
      .mn-table .mn-col-amount,.mn-table .mn-col-balance{width:116px;text-align:right}
      .mn-row{cursor:pointer}
      .mn-row:hover td{background:#f9fafb}
      .mn-row:focus-visible{outline:2px solid var(--primary,#d93025);outline-offset:-2px}
      .mn-sort{border:0;background:none;padding:0;font:inherit;color:inherit;cursor:pointer;display:inline-flex;align-items:center;gap:5px}
      .mn-sort.active{color:#101828}
      .mn-sort i{font-size:9px;color:#98a2b3}
      .mn-sort.active i{color:var(--primary,#d93025)}
      .mn-col-amount .mn-sort,.mn-col-balance .mn-sort{flex-direction:row-reverse}
      .mn-item{display:flex;align-items:center;gap:10px;min-width:0}
      .mn-thumb{width:34px;height:34px;border-radius:8px;flex:none;display:grid;place-items:center;background:#f2f4f7;color:#475467;overflow:hidden;border:0;padding:0;font-size:13px}
      .mn-thumb img{width:100%;height:100%;object-fit:cover;object-position:top center;display:block}
      button.mn-thumb{cursor:zoom-in}
      .mn-thumb.in{background:#101828;color:#fff}
      .mn-item-copy{min-width:0}
      .mn-item-copy strong{display:flex;align-items:center;gap:6px;font-size:13px;font-weight:700;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
      .mn-item-copy strong i{color:#98a2b3;font-size:10px}
      .mn-item-copy small{display:block;margin-top:1px;font-size:11px;color:#667085;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
      .mn-cat{display:inline-flex;align-items:center;gap:5px;max-width:100%;padding:3px 8px;border-radius:999px;background:#f2f4f7;color:#344054;font-size:11px;font-weight:700;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
      .mn-status{display:inline-flex;align-items:center;max-width:100%;border-radius:999px;padding:3px 8px;font-size:11px;font-weight:700;background:#f2f4f7;color:#475467;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;text-transform:capitalize}
      .mn-status.paid,.mn-status.settled,.mn-status.applied,.mn-status.active,.mn-status.cleared{background:#f2f4f7;color:#344054}
      .mn-status.due,.mn-status.open,.mn-status.partially_paid,.mn-status.pending,.mn-status.needs_review,.mn-status.ready,.mn-status.issued,.mn-status.sent{background:#fffaeb;color:#b54708}
      .mn-status.overdue,.mn-status.failed,.mn-status.refunded,.mn-status.void,.mn-status.voided,.mn-status.paused{background:#fef3f2;color:#b42318}
      .mn-amount{text-align:right;font-variant-numeric:tabular-nums;font-weight:700;white-space:nowrap}
      .mn-amount.out{color:#475467;font-weight:600}
      .mn-amount.doc{color:#98a2b3;font-weight:600}
      .mn-balance{text-align:right;font-variant-numeric:tabular-nums;color:#667085;white-space:nowrap}
      .mn-empty{padding:34px 16px;text-align:center;color:#98a2b3;font-size:13px;font-weight:600}
      .mn-empty i{display:block;font-size:22px;margin-bottom:8px;color:#d0d5dd}
      .mn-tiles{display:grid;grid-template-columns:repeat(auto-fill,minmax(190px,1fr));gap:10px;padding:12px}
      .mn-tile{border:1px solid #eaecf0;border-radius:12px;background:#fff;overflow:hidden;cursor:pointer;display:flex;flex-direction:column;text-align:left;padding:0;font:inherit;color:inherit;min-width:0}
      .mn-tile:hover{border-color:rgba(var(--primary-rgb,217,48,37),.35);box-shadow:0 6px 18px rgba(16,24,40,.08)}
      .mn-tile-preview{position:relative;height:112px;background:#f2f4f7;display:grid;place-items:center;color:#98a2b3;font-size:26px;overflow:hidden}
      .mn-tile-preview.in{background:#eef0f3;color:#344054}
      .mn-tile-preview img{position:absolute;inset:0;width:100%;height:100%;object-fit:cover;object-position:top center}
      .mn-tile-preview .mn-cat{position:absolute;left:8px;top:8px;max-width:calc(100% - 16px);background:rgba(255,255,255,.94);font-size:10px}
      .mn-tile-body{padding:9px 10px;display:flex;flex-direction:column;gap:3px;min-width:0}
      .mn-tile-body strong{font-size:13px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
      .mn-tile-foot{display:flex;align-items:center;justify-content:space-between;gap:8px;font-size:11px;color:#667085}
      .mn-tile-foot .mn-amount{font-size:13px}
      /* Tab-local modals keep their own dimming: the window manager's backdrop pass skips them (data-fm-window-backdrop="off"). */
      .mn-modal-shade{position:absolute;inset:0;z-index:80;background:rgba(16,24,40,.42);backdrop-filter:blur(2px);display:flex;align-items:center;justify-content:center;padding:18px}
      .mn-modal-shade.top{z-index:90}
      .mn-modal{position:relative;width:min(520px,100%);max-height:100%;display:flex;flex-direction:column;background:#fff;border-radius:14px;box-shadow:0 24px 70px rgba(15,23,42,.28);overflow:hidden}
      .mn-modal.wide{width:min(760px,100%)}
      .mn-modal.xwide{width:min(980px,100%)}
      .mn-modal-head{display:flex;align-items:center;justify-content:space-between;gap:10px;padding:14px 16px;border-bottom:1px solid #eaecf0;flex:none}
      .mn-modal-head>div{display:flex;align-items:center;gap:10px;min-width:0}
      .mn-modal-head strong{font-size:15px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
      .mn-modal-body{padding:16px;overflow:auto;min-height:0;display:flex;flex-direction:column;gap:14px}
      .mn-modal-foot{display:flex;align-items:center;justify-content:flex-end;gap:8px;padding:12px 16px;border-top:1px solid #eaecf0;background:#fcfcfd;flex:none;flex-wrap:wrap}
      .mn-modal-foot .mn-spacer{margin-right:auto}
      .mn-intake-modal{width:min(940px,100%);padding:18px;overflow:auto}
      .mn-intake-modal>.mn-btn.icon{position:absolute;right:14px;top:14px;z-index:2}
      .mn-form{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:10px}
      .mn-form label{display:flex;flex-direction:column;gap:5px;font-size:12px;font-weight:700;color:#344054;min-width:0}
      .mn-form .wide{grid-column:1/-1}
      .mn-form label.mn-check{flex-direction:row;align-items:flex-start;gap:8px;font-weight:600}
      .mn-form label.mn-check input{margin-top:2px}
      .mn-form-actions{grid-column:1/-1;display:flex;justify-content:flex-end;gap:8px;flex-wrap:wrap}
      .mn-input,.mn-select{width:100%;height:38px;border:1px solid #d0d5dd;border-radius:9px;background:#fff;padding:0 10px;font:inherit;font-size:13px;color:#101828;outline:none}
      textarea.mn-input{height:auto;min-height:64px;padding:8px 10px;resize:vertical}
      .mn-input[readonly]{background:#f9fafb;color:#475467}
      .mn-help{display:inline-flex;align-items:center;justify-content:center;width:15px;height:15px;color:#98a2b3;font-size:11px;cursor:help}
      .mn-facts{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:12px 16px}
      .mn-facts div{min-width:0}
      .mn-facts span{display:block;font-size:11px;font-weight:700;color:#667085}
      .mn-facts strong{display:block;margin-top:2px;font-size:13px;overflow-wrap:anywhere}
      .mn-note{margin:0;padding:10px 12px;border-radius:10px;background:#f9fafb;color:#475467;font-size:13px}
      .mn-amount-hero{display:flex;align-items:baseline;justify-content:space-between;gap:12px}
      .mn-amount-hero strong{font-size:26px;font-variant-numeric:tabular-nums}
      .mn-preview{border:1px solid #eaecf0;border-radius:12px;overflow:hidden;background:#f2f4f7;display:grid;place-items:center;min-height:120px;max-height:260px;cursor:zoom-in;padding:0;font:inherit;color:#98a2b3;font-size:30px}
      .mn-preview img{width:100%;max-height:260px;object-fit:contain;display:block}
      .mn-receipt-strip{display:flex;gap:8px;flex-wrap:wrap}
      .mn-receipt-strip .mn-thumb{width:52px;height:52px;border-radius:10px}
      .mn-lines{display:flex;flex-direction:column;border:1px solid #eaecf0;border-radius:10px;overflow:hidden}
      .mn-lines div{display:flex;justify-content:space-between;gap:10px;padding:8px 10px;font-size:13px;border-bottom:1px solid #f2f4f7}
      .mn-lines div:last-child{border-bottom:0}
      .mn-sub-panel{border:1px solid #eaecf0;border-radius:12px;padding:12px;display:flex;flex-direction:column;gap:10px}
      .mn-sub-panel>strong{font-size:13px}
      .mn-alloc-row{display:grid;grid-template-columns:minmax(0,1fr) 120px;gap:8px;align-items:end}
      .mn-alert{display:flex;align-items:flex-start;gap:8px;border-radius:10px;padding:10px 12px;font-size:12px;font-weight:600;background:#fffaeb;color:#93370d}
      .mn-alert.error{background:#fef3f2;color:#b42318}
      .mn-list{display:flex;flex-direction:column;border:1px solid #eaecf0;border-radius:12px;overflow:hidden}
      .mn-list-row{display:flex;align-items:center;gap:10px;padding:9px 12px;border-bottom:1px solid #f2f4f7;min-width:0}
      .mn-list-row:last-child{border-bottom:0}
      .mn-list-row>div{flex:1;min-width:0}
      .mn-list-row strong{display:block;font-size:13px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
      .mn-list-row small{display:block;font-size:11px;color:#667085;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
      .mn-list-row .mn-amount{flex:none}
      .mn-list-row .mn-input{height:32px}
      .mn-dot{width:10px;height:10px;border-radius:50%;flex:none;background:var(--dot,#98a2b3)}
      .mn-section-label{display:flex;align-items:center;justify-content:space-between;gap:8px;font-size:12px;font-weight:800;color:#344054}
      .mn-switch{position:relative;display:inline-flex;align-items:center;flex:none;cursor:pointer}
      .mn-switch input{position:absolute;width:1px;height:1px;opacity:0}
      .mn-switch span{width:36px;height:20px;padding:2px;border-radius:999px;background:#d0d5dd;transition:background .16s ease}
      .mn-switch span::after{content:"";display:block;width:16px;height:16px;border-radius:50%;background:#fff;box-shadow:0 1px 3px rgba(16,24,40,.3);transition:transform .16s ease}
      .mn-switch input:checked+span{background:var(--primary,#d93025)}
      .mn-switch input:checked+span::after{transform:translateX(16px)}
      .mn-switch input:focus-visible+span{box-shadow:0 0 0 4px rgba(var(--primary-rgb,217,48,37),.14)}
      .mn-switch-field{display:flex!important;flex-direction:row!important;align-items:center;justify-content:space-between;gap:10px;height:38px}
      .mn-invoice-items{grid-column:1/-1;border:1px solid #eaecf0;border-radius:10px;overflow:hidden}
      .mn-invoice-items-head{display:flex;align-items:center;justify-content:space-between;gap:10px;padding:8px 10px;background:#f9fafb;border-bottom:1px solid #eaecf0}
      .mn-invoice-items-head strong{font-size:12px}
      .mn-invoice-item-picker{padding:8px;border-bottom:1px solid #eaecf0}
      .mn-invoice-picker-list{display:flex;flex-direction:column;gap:5px;max-height:180px;overflow:auto}
      .mn-invoice-picker-choice{display:flex;align-items:center;justify-content:space-between;gap:10px;width:100%;border:1px solid #eaecf0;border-radius:8px;background:#fff;padding:8px 10px;text-align:left;cursor:pointer;font:inherit}
      .mn-invoice-picker-choice:hover{border-color:rgba(var(--primary-rgb,217,48,37),.35)}
      .mn-invoice-picker-choice strong{display:block;font-size:12px}
      .mn-invoice-picker-choice span span{display:block;color:#667085;font-size:11px}
      .mn-invoice-picker-choice>i{color:var(--primary,#d93025)}
      .mn-invoice-lines{display:flex;flex-direction:column}
      .mn-invoice-line{display:grid;grid-template-columns:minmax(0,1fr) 130px 34px;gap:8px;align-items:end;padding:8px 10px;border-bottom:1px solid #f2f4f7}
      .mn-invoice-line:last-child{border-bottom:0}
      .mn-invoice-line-remove{width:34px;height:38px;border:0;background:transparent;color:#b42318;cursor:pointer;border-radius:8px}
      .mn-invoice-line-remove:hover{background:#fef3f2}
      .mn-invoice-empty{padding:14px;text-align:center;color:#98a2b3;font-size:12px}
      .mn-invoice-date-row{grid-column:1/-1;display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:10px;align-items:end}
      .mn-invoice-tax-row{grid-column:1/-1;display:grid;grid-template-columns:minmax(0,1fr) 130px;gap:10px;align-items:end}
      .mn-invoice-total-box{grid-column:1/-1;margin-left:auto;width:min(300px,100%);display:flex;flex-direction:column;gap:5px}
      .mn-invoice-total-row{display:flex;justify-content:space-between;gap:15px;font-size:13px;color:#475467;font-variant-numeric:tabular-nums}
      .mn-invoice-total-row.grand{border-top:1px solid #d0d5dd;padding-top:8px;margin-top:3px;font-size:16px;font-weight:800;color:#101828}
      .mn-receipt-modal-body{display:grid;grid-template-columns:minmax(0,.9fr) minmax(300px,1.1fr);min-height:0;overflow:auto}
      .mn-receipt-review{min-width:0;padding:16px;border-right:1px solid #eaecf0;display:flex;flex-direction:column;gap:12px}
      .mn-receipt-targets{min-width:0;padding:16px;display:flex;flex-direction:column;gap:8px}
      .mn-receipt-target-choice{min-width:0;display:grid;grid-template-columns:auto minmax(0,1fr) auto;align-items:center;gap:9px;border:1px solid #eaecf0;border-radius:10px;padding:9px 10px;cursor:pointer}
      .mn-receipt-target-choice:has(input:checked){border-color:rgba(var(--primary-rgb,217,48,37),.4);background:rgba(var(--primary-rgb,217,48,37),.05)}
      .mn-receipt-target-choice input{accent-color:var(--primary,#d93025)}
      .mn-receipt-target-choice>span{min-width:0}
      .mn-receipt-target-choice>span>strong,.mn-receipt-target-choice>span>span{display:block;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
      .mn-receipt-target-choice strong{font-size:12px}
      .mn-receipt-target-choice span span{font-size:11px;color:#667085}
      .mn-receipt-loading{min-height:260px;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:12px;color:#475467;font-weight:700;padding:20px;text-align:center}
      .mn-receipt-loading i{font-size:26px;color:var(--primary,#d93025)}
      .mn-receipt-lines summary{font-size:12px;font-weight:700;cursor:pointer;color:#475467}
      .mn-receipt-lines div{display:flex;justify-content:space-between;gap:8px;padding-top:5px;font-size:12px;color:#667085}
      .mn-file-summary{display:flex;align-items:center;gap:10px;min-width:0}
      .mn-file-summary>i{width:36px;height:36px;border-radius:9px;display:grid;place-items:center;background:#f2f4f7;color:#475467;flex:none}
      .mn-file-summary strong,.mn-file-summary span{display:block;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
      .mn-file-summary span{font-size:11px;color:#667085}
      .mn-batch-summary{display:flex;align-items:center;gap:8px;color:#475467;font-size:12px;font-weight:700}
      .mn-batch-item{display:grid;grid-template-columns:auto minmax(0,1fr) auto;align-items:center;gap:11px;border:1px solid #eaecf0;border-radius:10px;padding:10px}
      .mn-batch-icon{width:34px;height:34px;border-radius:9px;display:grid;place-items:center;background:#f2f4f7;color:#667085}
      .mn-batch-item.ready .mn-batch-icon{background:rgba(var(--primary-rgb,217,48,37),.1);color:var(--primary-readable,var(--primary,#d93025))}
      .mn-batch-item.error .mn-batch-icon{background:#fef3f2;color:#b42318}
      .mn-batch-copy{min-width:0}
      .mn-batch-copy strong,.mn-batch-copy span{display:block;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
      .mn-batch-copy strong{font-size:13px}
      .mn-batch-copy span{margin-top:2px;color:#667085;font-size:11px}
      .mn-batch-match{color:var(--primary-readable,var(--primary,#d93025))!important}
      .mn-muted{color:#667085;font-size:12px;font-weight:600}
      .mn-spin{animation:mn-spin .9s linear infinite}
      @keyframes mn-spin{to{transform:rotate(360deg)}}
      @container money (max-width:1100px){.mn-metrics{grid-template-columns:repeat(3,minmax(0,1fr))}.mn-tools .mn-btn.collapse span{display:none}.mn-tools .mn-btn.collapse{width:38px;padding:0}}
      @container money (max-width:820px){.mn-table .mn-col-balance{display:none}.mn-table .mn-col-status{width:96px}.mn-table .mn-col-cat{width:120px}.mn-receipt-modal-body{grid-template-columns:1fr}.mn-receipt-review{border-right:0;border-bottom:1px solid #eaecf0}}
      @container money (max-width:640px){
        .mn-shell{padding:10px;gap:10px;overflow:auto}
        .mn-ledger{flex:none;min-height:60%;overflow:visible}
        .mn-ledger-body{overflow:visible}
        .mn-title strong{font-size:16px}
        .mn-tools .mn-btn span{display:none}
        .mn-tools .mn-btn{width:38px;padding:0}
        .mn-metrics{display:flex;overflow-x:auto;scrollbar-width:none;margin:0 -10px;padding:0 10px}
        .mn-metrics::-webkit-scrollbar{display:none}
        .mn-metric{flex:0 0 136px}
        .mn-metric strong{font-size:16px}
        .mn-table .mn-col-cat,.mn-table .mn-col-status{display:none}
        .mn-table .mn-col-date{width:74px;font-size:12px}
        .mn-table .mn-col-amount{width:92px}
        .mn-search{flex-basis:100%;max-width:none}
        .mn-ledger-add .mn-btn span{display:none}
        .mn-ledger-add .mn-btn{width:34px;padding:0}
        .mn-tiles{grid-template-columns:repeat(2,minmax(0,1fr));gap:8px;padding:8px}
        .mn-modal-shade{padding:8px;align-items:flex-end}
        .mn-form,.mn-facts,.mn-invoice-date-row,.mn-invoice-tax-row{grid-template-columns:1fr}
        .mn-invoice-line{grid-template-columns:minmax(0,1fr) 100px 34px}
      }
    `;
  }

  function injectCSS(){
    let style = document.getElementById('money-tab-css');
    if (!style) {
      style = document.createElement('style');
      style.id = 'money-tab-css';
      document.head.appendChild(style);
    }
    const text = css();
    if (style.textContent !== text) style.textContent = text;
  }

  async function loadData(){
    if (!apiReady()) {
      state.summary = null;
      state.events = [];
      state.invoices = [];
      state.invoiceSettings = { sales_tax_enabled:true, default_sales_tax_percent:0 };
      state.error = 'Payments API is not available for this project.';
      renderAll();
      return;
    }
    const sequence = ++state.loadSequence;
    const requestedProjectId = projectId();
    const requestedOrgId = orgId();
    state.loading = true;
    state.error = '';
    if (!state.summary) renderAll();
    try {
      const [summaryResult, eventsResult, invoiceResult, , autopayResult] = await Promise.all([
        rootWindow.PaymentsAPI.projects.summary(requestedOrgId, requestedProjectId),
        rootWindow.PaymentsAPI.events?.list ? rootWindow.PaymentsAPI.events.list(requestedOrgId, { project_id: requestedProjectId }).catch(() => ({ events: [] })) : Promise.resolve({ events: [] }),
        rootWindow.PaymentsAPI.invoices?.list ? rootWindow.PaymentsAPI.invoices.list(requestedOrgId, requestedProjectId).catch(() => ({ invoices: [] })) : Promise.resolve({ invoices: [] }),
        Promise.resolve(rootWindow.PlatformTerminology?.ready?.()).catch(() => null),
        rootWindow.PaymentsAPI.autopay?.get ? rootWindow.PaymentsAPI.autopay.get(requestedOrgId, requestedProjectId).catch(() => ({ autopay: null })) : Promise.resolve({ autopay: null }),
        state.moneySettings ? Promise.resolve(null) : loadMoneySettings()
      ]);
      if (sequence !== state.loadSequence || requestedProjectId !== projectId() || requestedOrgId !== orgId()) return;
      state.summary = summaryResult.summary || null;
      state.events = eventsResult.events || [];
      state.invoices = invoiceResult.invoices || [];
      state.invoiceSettings = {
        sales_tax_enabled: invoiceResult.settings?.sales_tax_enabled !== false,
        default_sales_tax_percent: Math.min(100, Math.max(0, Number(invoiceResult.settings?.default_sales_tax_percent || 0)))
      };
      state.autopay = autopayResult?.autopay || null;
      // Provider + saved-method availability drives the autopay affordance.
      await refreshPaymentIntakeConfig().catch(() => null);
      const schedules = state.summary?.schedules || [];
      if (state.activeScheduleId !== 'all' && !schedules.some((schedule) => cleanText(schedule.id) === state.activeScheduleId)) state.activeScheduleId = 'all';
    } catch (error) {
      if (sequence !== state.loadSequence) return;
      state.error = error?.message || 'Could not load money.';
      state.summary = null;
      state.events = [];
      state.invoices = [];
      state.invoiceSettings = { sales_tax_enabled:true, default_sales_tax_percent:0 };
    } finally {
      if (sequence !== state.loadSequence) return;
      state.loading = false;
      renderAll();
      applyMoneyRoute();
    }
  }

  async function loadMoneySettings(){
    try {
      const module = await rootWindow.PlatformAPI?.branchModules?.get?.(orgId(), branchId(), 'money_settings');
      state.moneySettings = module?.data && typeof module.data === 'object' ? module.data : {};
    } catch (_) {
      state.moneySettings = {};
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

  function invoices(){
    return Array.isArray(state.invoices) ? state.invoices : [];
  }

  function expenseData(summary = state.summary || {}){
    return summary?.expense_summary || { targets:[], groups:[], receipts:[], totals:{} };
  }

  function receipts(){
    return (Array.isArray(expenseData().receipts) ? expenseData().receipts : []).filter((receipt) => !['void', 'voided', 'deleted'].includes(cleanText(receipt?.status).toLowerCase()));
  }

  function filteredObligations(){
    if (state.activeScheduleId === 'all') return obligations();
    return obligations().filter((item) => cleanText(item.schedule_id) === state.activeScheduleId);
  }

  // ---- Categories ---------------------------------------------------------------------------------------------

  function builtInCategoryLabel(id){
    const fallback = { labor:'Labor', material_order:'Materials', reimbursement:'Reimbursement', other:'Other', recurring_expense:'Recurring', commission:'Commission' }[id] || titleText(id);
    return cleanText(rootWindow.PlatformTerminology?.get?.(`money.category_${id}`, fallback), fallback);
  }

  // Every category the organization offers, in its order: the built-in four (renamed or hidden in Settings) and
  // its own. `hidden` ones are not offered for new expenses; entries already filed under them keep their label.
  function moneyCategories(settings = state.moneySettings){
    const saved = Array.isArray(settings?.expense_categories) ? settings.expense_categories : [];
    const byId = new Map(saved.map((entry) => [cleanText(entry?.id), entry]).filter(([id]) => id));
    const list = [];
    saved.forEach((entry) => {
      const id = cleanText(entry?.id);
      if (!id || list.some((item) => item.id === id)) return;
      list.push({ id, label:cleanText(entry.label, builtInCategoryLabel(id)), hidden:entry.hidden === true, builtIn:BUILT_IN_CATEGORIES.includes(id) });
    });
    BUILT_IN_CATEGORIES.forEach((id) => {
      if (!byId.has(id)) list.push({ id, label:builtInCategoryLabel(id), hidden:false, builtIn:true });
    });
    return list;
  }

  function categoryLabel(id){
    const key = cleanText(id) || 'other';
    return moneyCategories().find((item) => item.id === key)?.label || builtInCategoryLabel(key);
  }

  // ---- Ledger entries -----------------------------------------------------------------------------------------

  function expenseReceipts(expense){
    const targetKeys = new Set((expense?.expense_target_keys || []).map(cleanText).filter(Boolean));
    return receipts().filter((receipt) => {
      const associations = Array.isArray(receipt?.associations) ? receipt.associations : [];
      const directlyLinked = associations.some((association) => {
        const kind = cleanText(association?.kind, association?.type).toLowerCase();
        return ['expense', 'payable', 'payment_payable'].includes(kind) && cleanText(association?.id) === cleanText(expense?.id);
      });
      return directlyLinked || (receipt.attributed_target_keys || []).some((key) => targetKeys.has(cleanText(key)));
    });
  }

  function receiptContentType(receipt){
    return cleanText(receipt?.file?.content_type, receipt?.content_type).toLowerCase();
  }

  function receiptIsImage(receipt){
    return receiptContentType(receipt).startsWith('image/');
  }

  function receiptImageUrl(receipt){
    if (!receipt?.id || !receiptIsImage(receipt)) return '';
    return cleanText(rootWindow.PaymentsAPI?.receipts?.fileUrl?.(orgId(), receipt.id, { inline:true }));
  }

  function receiptTotal(receipt){
    return cents(receipt?.total_cents ?? receipt?.effective?.total_cents ?? receipt?.extraction?.total_cents);
  }

  function receiptTitle(receipt){
    return cleanText(receipt?.title, receipt?.extraction?.vendor_name, receipt?.file?.file_name, term('receipt'));
  }

  function payableRecurring(payable){
    return !!(payable?.metadata?.recurring || cleanText(payable?.recurrence_series_id) || cleanText(payable?.metadata?.recurrence_group_id));
  }

  function ledgerEntries(){
    const moneyRows = [];
    payments().filter((payment) => cleanText(payment.direction) === 'inbound').forEach((payment) => {
      const method = cleanText(payment.method?.label, titleText(payment.method?.type), titleText(payment.kind));
      moneyRows.push({
        key:`payment:${cleanText(payment.id)}`, kind:'payment', type:'in', id:cleanText(payment.id), source:payment,
        at:cleanText(payment.received_at, payment.settled_at, payment.created_at), createdAt:cleanText(payment.created_at),
        title:method || term('collected_payment'), detail:cleanText(payment.notes),
        category:'payment', categoryLabel:term('collected_payment'), icon:'fa-arrow-down',
        status:cleanText(payment.status || 'settled'), amount:cents(payment.amount_cents), signed:cents(payment.amount_cents), receipts:[]
      });
    });
    (state.events || []).filter((event) => cleanText(event.type, event.event_type) === 'payment.refunded').forEach((event) => {
      const amount = Math.abs(cents(event.payload?.amount_cents));
      if (!amount) return;
      moneyRows.push({
        key:`refund:${cleanText(event.id)}`, kind:'refund', type:'in', id:cleanText(event.id), source:event,
        at:cleanText(event.created_at), createdAt:cleanText(event.created_at),
        title:(globalThis.PlatformLanguage?.text("money","m_aeef17228560b9","Refund") ?? "Refund"), detail:cleanText(event.payload?.reason, 'Customer refund'),
        category:'refund', categoryLabel:'Refund', icon:'fa-rotate-left',
        status:'refunded', amount, signed:-amount, receipts:[]
      });
    });
    payables().filter((expense) => cleanText(expense.status) !== 'void').forEach((expense) => {
      const payee = cleanText(expense.payee_ref?.name, expense.vendor_ref?.name);
      const kind = cleanText(expense.kind) || 'other';
      moneyRows.push({
        key:`expense:${cleanText(expense.id)}`, kind:'expense', type:'out', id:cleanText(expense.id), source:expense,
        at:cleanText(expense.due_at, expense.created_at), createdAt:cleanText(expense.created_at),
        title:payee || cleanText(expense.notes) || categoryLabel(kind), detail:[payee ? cleanText(expense.notes) : '', payableRecurring(expense) ? recurrenceLabel(expense) : ''].filter(Boolean).join(' · '),
        category:kind, categoryLabel:categoryLabel(kind), icon:'fa-arrow-up', recurring:payableRecurring(expense),
        status:cleanText(expense.status || 'open'), amount:Math.abs(cents(expense.amount_cents)), signed:-Math.abs(cents(expense.amount_cents)), receipts:expenseReceipts(expense)
      });
    });
    moneyRows.sort((left, right) => (Date.parse(left.at) || 0) - (Date.parse(right.at) || 0) || (Date.parse(left.createdAt) || 0) - (Date.parse(right.createdAt) || 0) || left.key.localeCompare(right.key));
    let balance = 0;
    moneyRows.forEach((row) => { balance += row.signed; row.balance = balance; });

    // Invoices and receipts are records: listed with their amounts, never counted in the balance.
    const records = [];
    invoices().forEach((invoice) => {
      const descriptions = (invoice.line_items || []).map((item) => item.description).filter(Boolean);
      records.push({
        key:`invoice:${cleanText(invoice.id)}`, kind:'invoice', type:'record', id:cleanText(invoice.id), source:invoice,
        at:cleanText(invoice.issue_date, invoice.created_at), createdAt:cleanText(invoice.created_at),
        title:cleanText(invoice.invoice_number, term('invoice')), detail:`${descriptions.slice(0, 2).join(', ')}${descriptions.length > 2 ? ` +${descriptions.length - 2}` : ''}`,
        category:'invoice', categoryLabel:term('invoice'), icon:'fa-file-invoice-dollar',
        status:cleanText(invoice.status || 'draft'), amount:cents(invoice.total_cents), signed:0, balance:null, receipts:[]
      });
    });
    receipts().forEach((receipt) => {
      records.push({
        key:`receipt:${cleanText(receipt.id)}`, kind:'receipt', type:'record', id:cleanText(receipt.id), source:receipt,
        at:cleanText(receipt.purchase_date, receipt.effective?.purchase_date, receipt.uploaded_at, receipt.created_at), createdAt:cleanText(receipt.created_at),
        title:receiptTitle(receipt), detail:cleanText(receipt.file?.file_name),
        category:'receipt', categoryLabel:term('receipt'), icon:'fa-receipt',
        status:cleanText(receipt.status || 'ready'), amount:receiptTotal(receipt), signed:0, balance:null, receipts:[receipt]
      });
    });
    return [...moneyRows, ...records];
  }

  function entryMatchesFilter(row, filter = state.ledgerFilter){
    if (filter === 'all') return true;
    if (filter === 'in') return row.type === 'in';
    if (filter === 'out') return row.kind === 'expense';
    if (filter === 'invoices') return row.kind === 'invoice';
    if (filter === 'receipts') return row.kind === 'receipt';
    if (filter === 'recurring') return row.recurring === true;
    if (filter.startsWith('cat:')) return row.kind === 'expense' && row.category === filter.slice(4);
    return true;
  }

  function entryMatchesSearch(row, search = state.ledgerSearch){
    const needle = cleanText(search).toLowerCase();
    if (!needle) return true;
    const haystack = [row.title, row.detail, row.categoryLabel, titleText(row.status), money(row.amount), String(row.amount / 100), shortDate(row.at), row.source?.notes, row.source?.invoice_number]
      .map((value) => cleanText(value).toLowerCase()).join(' ');
    return needle.split(/\s+/).every((word) => haystack.includes(word));
  }

  function ledgerSortValue(row, key){
    if (key === 'date') return Date.parse(row.at) || 0;
    if (key === 'item') return cleanText(row.title).toLocaleLowerCase();
    if (key === 'category') return cleanText(row.categoryLabel).toLocaleLowerCase();
    if (key === 'status') return cleanText(row.status).toLocaleLowerCase();
    if (key === 'amount') return row.type === 'record' ? row.amount : row.signed;
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

  function visibleLedgerRows(){
    return ledgerEntries().filter((row) => entryMatchesFilter(row) && entryMatchesSearch(row)).sort(compareLedgerRows);
  }

  function findEntry(key){
    return ledgerEntries().find((row) => row.key === key) || null;
  }

  // ---- Shell --------------------------------------------------------------------------------------------------

  function rootNode(){
    if (!state.panelRoot) return null;
    let root = state.panelRoot.matches?.('[data-money-root]') ? state.panelRoot : state.panelRoot.querySelector('[data-money-root]');
    if (!root) {
      state.panelRoot.innerHTML = panelHtml();
      root = state.panelRoot.querySelector('[data-money-root]');
    }
    if (!root.querySelector('[data-money-shell]')) root.insertAdjacentHTML('afterbegin', '<div class="mn-shell" data-money-shell></div>');
    if (!root.querySelector('[data-money-modal-layer]')) root.insertAdjacentHTML('beforeend', '<div data-money-modal-layer></div>');
    return root;
  }

  function toolbarHtml(){
    const manage = canManageMoney();
    const uploadBusy = moneyMutationBusy() || state.receiptUploadInFlight;
    return `
      <div class="mn-toolbar">
        <div class="mn-title"><i class="fas fa-dollar-sign" aria-hidden="true"></i><strong>${escapeHtml(term('workspace'))}</strong></div>
        <div class="mn-tools">
          ${manage ? `
            <button type="button" class="mn-btn primary" data-money-take-payment ${busyAttr()} aria-label="${escapeHtml(term('take_collected_payment'))}" data-fm-tooltip="${escapeHtml('Charge a card or bank account now')}"><i class="fas fa-credit-card"></i><span>${escapeHtml(term('take_collected_payment'))}</span></button>
            <button type="button" class="mn-btn collapse" data-money-upload-receipt data-money-busy ${uploadBusy ? 'disabled' : ''} aria-label="${escapeHtml(`Upload ${term('receipts').toLowerCase()}`)}" data-fm-tooltip="${escapeHtml('Upload receipts or bills; totals are read for you')}"><i class="fas fa-file-arrow-up"></i><span>${escapeHtml(`Upload ${term('receipts').toLowerCase()}`)}</span></button>
            <input type="file" data-money-receipt-input multiple accept="image/*,.pdf,.doc,.docx,.dot,.odt,.rtf,.pages,.xls,.xlsx,.csv,.tsv,.iif,.ppt,.pptx,.txt,.md,.json,.xml,.html,.htm,.eml,.mht,.tif,.tiff,.avif,.bmp,.heic,.heif" hidden>
            <button type="button" class="mn-btn collapse" data-money-open-modal="invoice" ${busyAttr()} aria-label="${escapeHtml(term('generate_invoice'))}" data-fm-tooltip="${escapeHtml('Bill scheduled payments or custom items')}"><i class="fas fa-file-invoice-dollar"></i><span>${escapeHtml(term('generate_invoice'))}</span></button>
            <span class="mn-tool-sep" aria-hidden="true"></span>` : ''}
          <button type="button" class="mn-btn icon" data-money-open-modal="reports" aria-label="${escapeHtml(term('reports'))}" data-fm-tooltip="${escapeHtml(term('reports'))}"><i class="fas fa-chart-column"></i></button>
          ${manage ? `<button type="button" class="mn-btn icon" data-money-open-modal="settings" aria-label="${escapeHtml('Settings')}" data-fm-tooltip="${escapeHtml('Settings')}"><i class="fas fa-gear"></i></button>` : ''}
        </div>
      </div>
    `;
  }

  function metricsHtml(){
    const summary = state.summary || {};
    const revenue = cents(summary.projected_revenue_cents ?? summary.project_total_cents);
    const collected = cents(summary.total_collected_cents);
    const remaining = Math.max(0, cents(summary.total_remaining_cents ?? revenue - collected));
    const costForecast = cents(summary.forecast_expenses_cents ?? summary.projected_expenses_cents);
    const actualCosts = cents(summary.actual_expenses_cents ?? summary.expenses_to_date_cents);
    const forecastProfit = cents(summary.forecast_profit_cents ?? summary.projected_profit_cents ?? revenue - costForecast);
    const profitToDate = cents(summary.profit_to_date_cents ?? collected - actualCosts);
    const margin = revenue > 0 ? Math.round((forecastProfit / revenue) * 100) : 0;
    const collectedShare = revenue > 0 ? Math.max(0, Math.min(100, Math.round((collected / revenue) * 100))) : 0;
    const costShare = costForecast > 0 ? Math.max(0, Math.min(100, Math.round((actualCosts / costForecast) * 100))) : 0;
    const tile = ({ key, label, value, tip, tone = '', small = '', bar = null, action = '' }) => {
      const tag = action ? 'button' : 'div';
      return `<${tag} ${action ? `type="button" data-money-open-modal="${action}"` : 'tabindex="0"'} class="mn-metric ${tone}" data-money-metric="${key}" data-fm-tooltip="${escapeHtml(tip)}" aria-label="${escapeHtml(`${label}: ${money(value)}. ${tip}`)}"><span>${escapeHtml(label)}</span><strong>${escapeHtml(money(value))}</strong>${small ? `<small>${escapeHtml(small)}</small>` : ''}${bar == null ? '' : `<div class="mn-bar"><i style="width:${bar}%"></i></div>`}</${tag}>`;
    };
    return `<div class="mn-metrics">
      ${tile({ key:'revenue', label:term('revenue'), value:revenue, tip:'Customer revenue scheduled from signed proposals and project payment obligations.' })}
      ${tile({ key:'collected', label:term('collected'), value:collected, tip:`Customer payments received for this project (${collectedShare}% of revenue), before expenses.`, bar:collectedShare })}
      ${tile({ key:'remaining', label:term('remaining'), value:remaining, tip:'Scheduled customer revenue not yet collected.' })}
      ${tile({ key:'cost_forecast', label:term('cost_forecast'), value:costForecast, tip:`Actual costs where known plus remaining projected costs; ${money(actualCosts)} spent so far. Open to see each ${term('expense_list').toLowerCase()}.`, bar:costShare, action:'expense_lists' })}
      ${tile({ key:'forecast_profit', label:term('forecast_profit'), value:forecastProfit, tip:`Revenue minus the cost forecast: a ${margin}% projected margin.`, tone:forecastProfit < 0 ? 'bad' : '', small:revenue > 0 ? `${margin}%` : '' })}
      ${tile({ key:'profit_to_date', label:term('profit_to_date'), value:profitToDate, tip:'Payments collected so far minus expenses already recorded.', tone:profitToDate < 0 ? 'bad' : '' })}
    </div>`;
  }

  function scheduleHtml(){
    const rows = filteredObligations();
    const schedules = state.summary?.schedules || [];
    const autopay = autopayCardHtml();
    if (!obligations().length && !autopay) return '';
    const scheduleSelect = schedules.length > 1
      ? `<select class="mn-select" data-money-schedule aria-label="${escapeHtml(term('payment_schedule'))}"><option value="all"${state.activeScheduleId === 'all' ? ' selected' : ''}>${(globalThis.PlatformLanguage?.htmlText("money","m_61df468d92e238","All") ?? "All")}</option>${schedules.map((schedule, index) => `<option value="${escapeHtml(schedule.id)}"${state.activeScheduleId === cleanText(schedule.id) ? ' selected' : ''}>${escapeHtml(schedule.title || ((v0) => globalThis.PlatformLanguage?.text("money","m_02d86b107dab82",`Proposal ${v0}`,{v0}) ?? `Proposal ${v0}`)(index + 1))}</option>`).join('')}</select>`
      : '';
    return `<div class="mn-schedule" data-money-schedule-strip aria-label="${escapeHtml(term('payment_schedule'))}">
      <div class="mn-schedule-head"><strong data-fm-tooltip="${escapeHtml('Payments the customer owes, from signed proposals and recurring billing.')}"><i class="fas fa-calendar-days"></i>${escapeHtml(term('payment_schedule'))}</strong>${scheduleSelect}</div>
      ${rows.map(dueCardHtml).join('')}
      ${autopay}
    </div>`;
  }

  function dueCardHtml(item){
    const amount = cents(item.amount_cents);
    const paid = cents(item.allocated_cents);
    const remaining = Math.max(0, amount - paid);
    const status = statusClass(item.status || 'scheduled');
    const share = amount > 0 ? Math.max(0, Math.min(100, Math.round((paid / amount) * 100))) : 0;
    const recurring = cleanText(item.due_rule) === 'recurring' || item.metadata?.recurring === true;
    const due = shortDate(item.due_at);
    const tip = [`${money(paid)} paid`, remaining ? `${money(remaining)} remaining` : '', due ? `Due ${due}` : 'Not due yet', item.due_rule && !recurring ? titleText(item.due_rule) : '', recurring ? 'Recurring' : ''].filter(Boolean).join(' · ');
    return `<div class="mn-due-card ${escapeHtml(status)}" data-fm-tooltip="${escapeHtml(tip)}">
      <div class="mn-due-line"><strong>${recurring ? '<i class="fas fa-repeat" aria-hidden="true"></i>' : ''}${escapeHtml(item.label || 'Payment')}</strong><span>${escapeHtml(money(amount))}</span></div>
      <div class="mn-bar"><i style="width:${share}%"></i></div>
      <div class="mn-due-meta"><span class="mn-status ${escapeHtml(status)}">${escapeHtml(titleText(item.status || 'scheduled'))}</span><span>${escapeHtml(due || 'Not due yet')}</span></div>
    </div>`;
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

  // Autopay sits at the end of the payment schedule. It only appears when the organization resolves a payment
  // provider and the customer has saved methods (or an enrollment already exists); it opens its own modal.
  function autopayCardHtml(){
    if (!canManageMoney()) return '';
    const providerReady = !!state.paymentIntakeConfig?.config?.provider;
    const autopay = state.autopay;
    if (!providerReady || (!autopay && !autopaySavedMethods().length)) return '';
    const paused = cleanText(autopay?.status) === 'paused';
    const status = !autopay ? 'Off' : paused ? 'Paused' : 'Active';
    const tip = !autopay ? 'Charge a saved payment method when payments come due.' : [cleanText(autopay.method_label, 'Saved payment method'), autopay.max_amount_cents ? `Max ${money(autopay.max_amount_cents)}` : '', !paused && autopayNextDueLabel() ? `Next: ${autopayNextDueLabel()}` : ''].filter(Boolean).join(' · ');
    return `<button type="button" class="mn-autopay" data-money-autopay ${autopay ? '' : 'data-money-autopay-open'} data-money-open-modal="autopay" data-fm-tooltip="${escapeHtml(tip)}">
      <strong><i class="fas fa-arrows-rotate"></i>${(globalThis.PlatformLanguage?.htmlText("money","m_adb80fcef9bf78","Autopay") ?? "Autopay")}</strong>
      <span class="mn-status ${!autopay ? '' : paused ? 'paused' : 'active'}" data-money-autopay-status>${escapeHtml(status)}</span>
    </button>`;
  }

  function filterOptionsHtml(){
    const entries = ledgerEntries();
    const categoriesInUse = new Set(entries.filter((row) => row.kind === 'expense').map((row) => row.category));
    const categories = moneyCategories().filter((category) => !category.hidden || categoriesInUse.has(category.id));
    categoriesInUse.forEach((id) => { if (!categories.some((category) => category.id === id)) categories.push({ id, label:categoryLabel(id) }); });
    const hasRecurring = entries.some((row) => row.recurring);
    const option = (value, label) => `<option value="${escapeHtml(value)}"${state.ledgerFilter === value ? ' selected' : ''}>${escapeHtml(label)}</option>`;
    return [
      option('all', 'All entries'),
      option('in', term('payments')),
      option('out', term('expenses')),
      categories.length ? `<optgroup label="${escapeHtml(term('expenses'))}">${categories.map((category) => option(`cat:${category.id}`, category.label)).join('')}</optgroup>` : '',
      option('invoices', term('invoices')),
      option('receipts', term('receipts')),
      hasRecurring || state.ledgerFilter === 'recurring' ? option('recurring', term('recurring')) : ''
    ].join('');
  }

  function ledgerHtml(){
    const manage = canManageMoney();
    return `<section class="mn-ledger" aria-label="${escapeHtml(term('ledger'))}">
      ${scheduleHtml()}
      <div class="mn-ledger-bar">
        <label class="mn-search"><i class="fas fa-magnifying-glass" aria-hidden="true"></i><input type="search" data-money-ledger-search value="${escapeHtml(state.ledgerSearch)}" placeholder="${escapeHtml(`Search ${term('ledger').toLowerCase()}`)}" aria-label="${escapeHtml(`Search ${term('ledger').toLowerCase()}`)}"></label>
        <select class="mn-select mn-filter" data-money-ledger-filter aria-label="${escapeHtml('Show')}">${filterOptionsHtml()}</select>
        <div class="mn-density" role="group" aria-label="${escapeHtml('Ledger view')}">
          <button type="button" class="${state.ledgerView === 'list' ? 'active' : ''}" data-money-ledger-view="list" aria-pressed="${state.ledgerView === 'list'}" aria-label="${escapeHtml('List')}" data-fm-tooltip="${escapeHtml('List')}"><i class="fas fa-list"></i></button>
          <button type="button" class="${state.ledgerView === 'tiles' ? 'active' : ''}" data-money-ledger-view="tiles" aria-pressed="${state.ledgerView === 'tiles'}" aria-label="${escapeHtml('Tiles')}" data-fm-tooltip="${escapeHtml('Tiles')}"><i class="fas fa-grip"></i></button>
        </div>
        ${manage ? `<div class="mn-ledger-add">
          <button type="button" class="mn-btn small" data-money-open-modal="add_payment" ${busyAttr()} aria-label="${escapeHtml(term('add_collected_payment'))}" data-fm-tooltip="${escapeHtml('Record cash, a check or a payment taken elsewhere')}"><i class="fas fa-arrow-down"></i><span>${escapeHtml(term('collected_payment'))}</span></button>
          <button type="button" class="mn-btn small" data-money-open-modal="add_expense" ${busyAttr()} aria-label="${escapeHtml(term('add_expense'))}" data-fm-tooltip="${escapeHtml(term('add_expense'))}"><i class="fas fa-arrow-up"></i><span>${escapeHtml(term('expense'))}</span></button>
        </div>` : ''}
      </div>
      <div class="mn-ledger-body" data-money-ledger-body></div>
    </section>`;
  }

  function renderMain(){
    const root = rootNode();
    if (!root) return;
    const shell = root.querySelector('[data-money-shell]');
    const focused = document.activeElement?.matches?.('[data-money-ledger-search]') && shell.contains(document.activeElement)
      ? { start:document.activeElement.selectionStart, end:document.activeElement.selectionEnd }
      : null;
    if (state.loading && !state.summary) {
      shell.innerHTML = `<div class="mn-state"><i class="fas fa-circle-notch fa-spin"></i><span>${(globalThis.PlatformLanguage?.htmlText("money","m_487adb3f2ba511","Loading money...") ?? "Loading money...")}</span></div>`;
      return;
    }
    if (state.error && !state.summary) {
      shell.innerHTML = `<div class="mn-state"><i class="fas fa-triangle-exclamation"></i><span>${escapeHtml(state.error)}</span></div>`;
      return;
    }
    shell.innerHTML = `${toolbarHtml()}${metricsHtml()}${ledgerHtml()}`;
    bindShell(root);
    renderLedgerBody();
    if (focused) {
      const input = shell.querySelector('[data-money-ledger-search]');
      input?.focus();
      try { input?.setSelectionRange(focused.start, focused.end); } catch (_) {}
    }
  }

  function sortHeader(key, label, className){
    const active = state.ledgerSort.key === key;
    const direction = active ? state.ledgerSort.direction : '';
    const ariaSort = active ? (direction === 'asc' ? 'ascending' : 'descending') : 'none';
    const icon = active ? (direction === 'asc' ? 'fa-arrow-up' : 'fa-arrow-down') : 'fa-sort';
    return `<th class="${className}" aria-sort="${ariaSort}"><button type="button" class="mn-sort${active ? ' active' : ''}" data-money-ledger-sort="${key}" aria-label="${escapeHtml(`Sort by ${label}`)}">${escapeHtml(label)}<i class="fas ${icon}" aria-hidden="true"></i></button></th>`;
  }

  function entryThumbHtml(row, size = 'row'){
    const receipt = row.receipts?.[0];
    const image = receipt ? receiptImageUrl(receipt) : '';
    if (size === 'tile') {
      return `<div class="mn-tile-preview ${row.type === 'in' ? 'in' : ''}">${image ? `<img loading="lazy" src="${escapeHtml(image)}" alt="">` : `<i class="fas ${receipt ? 'fa-receipt' : row.icon}" aria-hidden="true"></i>`}<span class="mn-cat">${escapeHtml(row.categoryLabel)}</span></div>`;
    }
    if (receipt) {
      return `<button type="button" class="mn-thumb" data-money-open-receipt="${escapeHtml(receipt.id)}" aria-label="${escapeHtml(`Open ${receiptTitle(receipt)}`)}" data-fm-tooltip="${escapeHtml(receiptTitle(receipt))}">${image ? `<img loading="lazy" src="${escapeHtml(image)}" alt="">` : '<i class="fas fa-receipt" aria-hidden="true"></i>'}</button>`;
    }
    return `<span class="mn-thumb ${row.type === 'in' ? 'in' : ''}" aria-hidden="true"><i class="fas ${row.icon}"></i></span>`;
  }

  function amountHtml(row){
    if (row.type === 'record') return `<span class="mn-amount doc">${row.amount ? escapeHtml(money(row.amount)) : '—'}</span>`;
    return `<span class="mn-amount ${row.signed < 0 ? 'out' : 'in'}">${row.signed < 0 ? '−' : '+'}${escapeHtml(money(Math.abs(row.signed)))}</span>`;
  }

  function ledgerListHtml(rows){
    return `<table class="mn-table">
      <thead><tr>
        ${sortHeader('date', 'Date', 'mn-col-date')}
        ${sortHeader('item', term('transaction'), 'mn-col-item')}
        ${sortHeader('category', 'Category', 'mn-col-cat')}
        ${sortHeader('status', 'Status', 'mn-col-status')}
        ${sortHeader('amount', 'Amount', 'mn-col-amount')}
        ${sortHeader('balance', term('balance'), 'mn-col-balance')}
      </tr></thead>
      <tbody>${rows.map((row) => `<tr class="mn-row" tabindex="0" data-money-entry="${escapeHtml(row.key)}">
        <td class="mn-col-date">${escapeHtml(shortDate(row.at) || '—')}</td>
        <td class="mn-col-item"><div class="mn-item">${entryThumbHtml(row)}<div class="mn-item-copy"><strong>${row.recurring ? `<i class="fas fa-repeat" aria-label="${escapeHtml(term('recurring'))}"></i>` : ''}${escapeHtml(row.title)}</strong><small>${escapeHtml(row.detail)}</small></div></div></td>
        <td class="mn-col-cat"><span class="mn-cat">${escapeHtml(row.categoryLabel)}</span></td>
        <td class="mn-col-status"><span class="mn-status ${escapeHtml(statusClass(row.status))}">${escapeHtml(titleText(row.status))}</span></td>
        <td class="mn-col-amount">${amountHtml(row)}</td>
        <td class="mn-col-balance"><span class="mn-balance">${row.balance == null ? '' : escapeHtml(money(row.balance))}</span></td>
      </tr>`).join('')}</tbody>
    </table>`;
  }

  function ledgerTilesHtml(rows){
    return `<div class="mn-tiles">${rows.map((row) => `<button type="button" class="mn-tile" data-money-entry="${escapeHtml(row.key)}" aria-label="${escapeHtml(`${row.title}, ${money(row.amount)}`)}">
      ${entryThumbHtml(row, 'tile')}
      <div class="mn-tile-body"><strong>${escapeHtml(row.title)}</strong><div class="mn-tile-foot"><span>${escapeHtml(shortDate(row.at) || '—')}</span>${amountHtml(row)}</div></div>
    </button>`).join('')}</div>`;
  }

  function renderLedgerBody(){
    const root = rootNode();
    const body = root?.querySelector('[data-money-ledger-body]');
    if (!body) return;
    const rows = visibleLedgerRows();
    if (!rows.length) {
      const anything = ledgerEntries().length > 0;
      body.innerHTML = `<div class="mn-empty"><i class="fas ${anything ? 'fa-magnifying-glass' : 'fa-book-open'}" aria-hidden="true"></i>${escapeHtml(anything ? 'Nothing matches.' : 'No entries yet.')}</div>`;
      return;
    }
    body.innerHTML = state.ledgerView === 'tiles' ? ledgerTilesHtml(rows) : ledgerListHtml(rows);
    body.querySelectorAll('[data-money-ledger-sort]').forEach((button) => {
      button.addEventListener('click', () => {
        const key = cleanText(button.dataset.moneyLedgerSort);
        const direction = state.ledgerSort.key === key ? (state.ledgerSort.direction === 'asc' ? 'desc' : 'asc') : (['date', 'amount', 'balance'].includes(key) ? 'desc' : 'asc');
        state.ledgerSort = { key, direction };
        renderLedgerBody();
      });
    });
    body.querySelectorAll('[data-money-open-receipt]').forEach((button) => {
      button.addEventListener('click', (event) => {
        event.stopPropagation();
        openReceiptViewer(button.dataset.moneyOpenReceipt);
      });
    });
    body.querySelectorAll('[data-money-entry]').forEach((node) => {
      const open = () => openModal({ type:'item', key:node.dataset.moneyEntry });
      node.addEventListener('click', open);
      if (node.tagName === 'TR') node.addEventListener('keydown', (event) => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); open(); } });
    });
  }

  function setLedgerFilter(filter, options = {}){
    state.ledgerFilter = filter;
    if (options.route !== false && !rootWindow.Portal?.navigation?.applying) {
      rootWindow.Portal?.navigation?.replace?.({ moneyView:viewForFilter(filter) }, { source:'project-money-filter', ownedKeys:['moneyView'] });
    }
    renderLedgerBody();
  }

  // The route's moneyView names what the ledger shows. Older views (Overview, the Expense lists, Recurring and
  // Receipts tabs, the phone's Ledger and Payments tabs) land on the ledger with the matching filter.
  function filterForView(view){
    return ({ payments:'in', expenses:'out', invoices:'invoices', receipts:'receipts', recurring:'recurring' })[cleanText(view)] || 'all';
  }

  function viewForFilter(filter){
    if (filter === 'in') return 'payments';
    if (filter === 'out' || filter.startsWith('cat:')) return 'expenses';
    if (['invoices', 'receipts', 'recurring'].includes(filter)) return filter;
    return 'overview';
  }

  function syncBusy(){
    const root = rootNode();
    root?.querySelectorAll('[data-money-busy]').forEach((button) => { button.disabled = moneyMutationBusy(); });
  }

  function bindShell(root){
    const shell = root.querySelector('[data-money-shell]');
    shell.querySelector('[data-money-take-payment]')?.addEventListener('click', () => {
      if (!canManageMoney() || moneyMutationBusy()) return;
      openModal({ type:'take_payment' });
    });
    shell.querySelectorAll('[data-money-open-modal]').forEach((button) => {
      button.addEventListener('click', () => {
        const type = cleanText(button.dataset.moneyOpenModal);
        if (type === 'autopay') { state.autopayError = ''; }
        openModal({ type });
      });
    });
    shell.querySelector('[data-money-upload-receipt]')?.addEventListener('click', () => {
      if (canManageMoney() && !moneyMutationBusy() && !state.receiptUploadInFlight) shell.querySelector('[data-money-receipt-input]')?.click();
    });
    shell.querySelector('[data-money-receipt-input]')?.addEventListener('change', (event) => {
      const files = Array.from(event.target.files || []);
      event.target.value = '';
      if (files.length && canManageMoney() && !moneyMutationBusy() && !state.receiptUploadInFlight) void uploadReceipts(files);
    });
    shell.querySelector('[data-money-schedule]')?.addEventListener('change', (event) => {
      state.activeScheduleId = cleanText(event.target.value) || 'all';
      renderMain();
    });
    const search = shell.querySelector('[data-money-ledger-search]');
    search?.addEventListener('input', () => {
      state.ledgerSearch = search.value;
      renderLedgerBody();
    });
    shell.querySelector('[data-money-ledger-filter]')?.addEventListener('change', (event) => setLedgerFilter(cleanText(event.target.value) || 'all'));
    shell.querySelectorAll('[data-money-ledger-view]').forEach((button) => {
      button.addEventListener('click', () => {
        state.ledgerView = button.dataset.moneyLedgerView === 'tiles' ? 'tiles' : 'list';
        try { rootWindow.localStorage?.setItem(LEDGER_VIEW_KEY, state.ledgerView); } catch (_) {}
        shell.querySelectorAll('[data-money-ledger-view]').forEach((other) => {
          const active = other.dataset.moneyLedgerView === state.ledgerView;
          other.classList.toggle('active', active);
          other.setAttribute('aria-pressed', String(active));
        });
        renderLedgerBody();
      });
    });
  }

  // ---- Modals -------------------------------------------------------------------------------------------------

  function openModal(modal){
    if (!modal?.type) return;
    const manageOnly = ['take_payment', 'add_payment', 'add_expense', 'invoice', 'settings', 'autopay'];
    if (manageOnly.includes(modal.type) && !canManageMoney()) return;
    state.modal = modal;
    if (modal.type === 'reports' && state.reports === null) void loadReports();
    if (modal.type === 'settings') state.modal.draft = moneyCategories().map((category) => ({ ...category }));
    renderModal({ force:true });
  }

  function closeModal(){
    if (state.modal?.type === 'take_payment') {
      state.paymentIntakeHandle?.close?.();
      state.paymentIntakeHandle = null;
      if (rootWindow.Portal?.navigation?.read?.()?.moneyView === 'take_payment') {
        rootWindow.Portal.navigation.replace?.({ moneyView:viewForFilter(state.ledgerFilter) }, { source:'project-money-take-payment-close', ownedKeys:['moneyView'] });
      }
    }
    state.modal = null;
    renderModal({ force:true });
  }

  function modalFrame({ title, icon = '', body, foot = '', size = '', attrs = '' }){
    return `<div data-fm-window-backdrop="off" class="mn-modal-shade" data-money-modal-shade><div class="mn-modal ${size}" role="dialog" aria-modal="true" aria-label="${escapeHtml(title)}" ${attrs}>
      <div class="mn-modal-head"><div>${icon ? `<span class="mn-thumb" aria-hidden="true"><i class="fas ${icon}"></i></span>` : ''}<strong>${escapeHtml(title)}</strong></div><button type="button" class="mn-btn small icon" data-money-modal-close aria-label="${escapeHtml('Close')}"><i class="fas fa-xmark"></i></button></div>
      <div class="mn-modal-body">${body}</div>
      ${foot ? `<div class="mn-modal-foot">${foot}</div>` : ''}
    </div></div>`;
  }

  function modalKey(){
    if (state.receiptBatch) return 'receipt-batch';
    if (state.receiptReview) return `receipt-review:${state.receiptReview.phase}:${cleanText(state.receiptReview.receipt?.id)}`;
    if (!state.modal) return '';
    return `${state.modal.type}:${cleanText(state.modal.key)}:${cleanText(state.modal.action)}`;
  }

  function renderModal(options = {}){
    const root = rootNode();
    const layer = root?.querySelector('[data-money-modal-layer]');
    if (!layer) return;
    const key = modalKey();
    if (!options.force && key && layer.dataset.modalKey === key && FORM_MODALS.has(state.modal?.type) && !state.receiptBatch && !state.receiptReview) {
      syncBusy();
      return;
    }
    if (layer.dataset.modalKey === 'take_payment::' && key !== 'take_payment::') {
      state.paymentIntakeHandle?.close?.();
      state.paymentIntakeHandle = null;
    }
    layer.dataset.modalKey = key;
    if (state.receiptBatch) { layer.innerHTML = receiptBatchHtml(); bindModal(layer); return; }
    if (state.receiptReview) { layer.innerHTML = receiptReviewHtml(); bindModal(layer); return; }
    const modal = state.modal;
    if (!modal) { layer.innerHTML = ''; return; }
    const html = {
      take_payment:takePaymentModalHtml,
      add_payment:addPaymentModalHtml,
      add_expense:addExpenseModalHtml,
      invoice:invoiceModalHtml,
      reports:reportsModalHtml,
      settings:settingsModalHtml,
      autopay:autopayModalHtml,
      expense_lists:expenseListsModalHtml,
      item:itemModalHtml
    }[modal.type];
    if (!html) { state.modal = null; layer.innerHTML = ''; return; }
    const markup = html(modal);
    if (!markup) { state.modal = null; layer.innerHTML = ''; return; }
    layer.innerHTML = markup;
    bindModal(layer);
  }

  function takePaymentModalHtml(){
    return `<div data-fm-window-backdrop="off" class="mn-modal-shade" data-money-modal-shade><div class="mn-modal mn-intake-modal" role="dialog" aria-modal="true" aria-label="${escapeHtml(term('take_collected_payment'))}"><button type="button" class="mn-btn small icon" data-money-modal-close aria-label="${escapeHtml('Close')}"><i class="fas fa-xmark"></i></button><div data-money-payment-intake></div></div></div>`;
  }

  function addPaymentModalHtml(){
    const body = `<form class="mn-form" data-money-payment-form id="mnPaymentForm">
      <label><span>${(globalThis.PlatformLanguage?.htmlText("money","m_2b8c3448fa87a1","Amount") ?? "Amount")}</span><input class="mn-input" name="amount" type="number" min="0" step="0.01" inputmode="decimal" required autofocus></label>
      <label><span>${(globalThis.PlatformLanguage?.htmlText("money","m_023c7d7ca8a301","Received") ?? "Received")}</span><input class="mn-input" name="received_at" type="date" value="${todayKey()}"></label>
      <label><span>${(globalThis.PlatformLanguage?.htmlText("money","m_6952fe71f8dc85","Method") ?? "Method")}</span><select class="mn-select" name="method"><option value="check">${(globalThis.PlatformLanguage?.htmlText("money","m_cc74e4e6c905ec","Check") ?? "Check")}</option><option value="cash">${(globalThis.PlatformLanguage?.htmlText("money","m_f758b041cf8d5c","Cash") ?? "Cash")}</option><option value="card">${(globalThis.PlatformLanguage?.htmlText("money","m_dd2dde7989cd96","Card") ?? "Card")}</option><option value="ach">${(globalThis.PlatformLanguage?.htmlText("money","m_97ab16559ee9ee","ACH") ?? "ACH")}</option><option value="manual">${(globalThis.PlatformLanguage?.htmlText("money","m_4a04382820d2e1","Other") ?? "Other")}</option></select></label>
      <label><span>${(globalThis.PlatformLanguage?.htmlText("money","m_171e062837e2d5","Action ") ?? "Action ")}<i class="fas fa-circle-info mn-help" tabindex="0" data-fm-tooltip="${escapeHtml('Record a payment already received, or create a request the customer still has to pay.')}"></i></span><select class="mn-select" name="mode"><option value="settled">${(globalThis.PlatformLanguage?.htmlText("money","m_ff35a2977f67a8","Record settled payment") ?? "Record settled payment")}</option><option value="intent">${(globalThis.PlatformLanguage?.htmlText("money","m_a67f5c30bef342","Create payment request") ?? "Create payment request")}</option></select></label>
      <label class="wide"><span>${(globalThis.PlatformLanguage?.htmlText("money","m_de7d6168ae1ad6","Notes") ?? "Notes")}</span><input class="mn-input" name="notes" type="text"></label>
    </form>`;
    const foot = `<button type="button" class="mn-btn" data-money-modal-close>${(globalThis.PlatformLanguage?.htmlText("money","m_cbef679b21abb4","Cancel") ?? "Cancel")}</button><button type="submit" form="mnPaymentForm" class="mn-btn primary" ${busyAttr()}><i class="fas fa-check"></i>${escapeHtml(term('save_collected_payment'))}</button>`;
    return modalFrame({ title:term('add_collected_payment'), icon:'fa-arrow-down', body, foot });
  }

  function addExpenseModalHtml(){
    const categories = moneyCategories().filter((category) => !category.hidden);
    const targets = (expenseData().targets || []).filter((target) => target?.receipt_attribution_enabled !== false);
    const body = `<form class="mn-form" data-money-payable-form id="mnExpenseForm">
      <label><span>${(globalThis.PlatformLanguage?.htmlText("money","m_2b8c3448fa87a1","Amount") ?? "Amount")}</span><input class="mn-input" name="amount" type="number" min="0" step="0.01" inputmode="decimal" required autofocus></label>
      <label><span>${(globalThis.PlatformLanguage?.htmlText("money","m_2a0b11100c22a4","Date") ?? "Date")}</span><input class="mn-input" name="due_at" type="date" value="${todayKey()}"></label>
      <label><span>${(globalThis.PlatformLanguage?.htmlText("money","m_c478c1907a4d4f","Category") ?? "Category")}</span><select class="mn-select" name="kind">${categories.map((category) => `<option value="${escapeHtml(category.id)}">${escapeHtml(category.label)}</option>`).join('')}</select></label>
      <label><span>${escapeHtml(term('recipient'))}</span><input class="mn-input" name="vendor" type="text" placeholder="${(globalThis.PlatformLanguage?.htmlText("money","m_a96780e95d7346","Vendor or person") ?? "Vendor or person")}"></label>
      ${targets.length ? `<label class="wide"><span>${escapeHtml(term('expense_list'))} <i class="fas fa-circle-info mn-help" tabindex="0" data-fm-tooltip="${escapeHtml(`Count this against one of the project's projected ${term('expense_lists').toLowerCase()}.`)}"></i></span><select class="mn-select" name="expense_target_key"><option value="">${(globalThis.PlatformLanguage?.htmlText("money","m_2d4ff8a83b1b5c","None") ?? "None")}</option>${targets.map((target) => `<option value="${escapeHtml(target.target_key)}">${escapeHtml(target.title || term('expense_list'))} · ${escapeHtml(money(target.projected_cents))}</option>`).join('')}</select></label>` : ''}
      <label class="wide"><span>${(globalThis.PlatformLanguage?.htmlText("money","m_aa136ecb65672f","Description") ?? "Description")}</span><input class="mn-input" name="notes" type="text" placeholder="${(globalThis.PlatformLanguage?.htmlText("money","m_160eeb4f3db485","What was this for?") ?? "What was this for?")}"></label>
      <label><span>${(globalThis.PlatformLanguage?.htmlText("money","m_db77f54f075418","Repeats ") ?? "Repeats ")}<i class="fas fa-circle-info mn-help" tabindex="0" data-fm-tooltip="${escapeHtml(`A repeating expense is added once for each date through the end date (up to ${RECURRING_LIMIT}). Each one can be paid or removed on its own.`)}"></i></span><select class="mn-select" name="repeat" data-money-repeat><option value="">${(globalThis.PlatformLanguage?.htmlText("money","m_ba3e276efa7ed8","Does not repeat") ?? "Does not repeat")}</option><option value="weekly:1">${(globalThis.PlatformLanguage?.htmlText("money","m_093d55e6272fc0","Weekly") ?? "Weekly")}</option><option value="weekly:2">${(globalThis.PlatformLanguage?.htmlText("money","m_2ee94fb768b2fa","Every 2 weeks") ?? "Every 2 weeks")}</option><option value="monthly:1">${(globalThis.PlatformLanguage?.htmlText("money","m_d7014f792d2583","Monthly") ?? "Monthly")}</option><option value="monthly:3">${(globalThis.PlatformLanguage?.htmlText("money","m_03e59d03617275","Quarterly") ?? "Quarterly")}</option><option value="yearly:1">${(globalThis.PlatformLanguage?.htmlText("money","m_ef289ba5429ef5","Yearly") ?? "Yearly")}</option></select></label>
      <label data-money-repeat-until hidden><span>${(globalThis.PlatformLanguage?.htmlText("money","m_7a571a426468ff","Until") ?? "Until")}</span><input class="mn-input" name="repeat_until" type="date"></label>
    </form>`;
    const foot = `<button type="button" class="mn-btn" data-money-modal-close>${(globalThis.PlatformLanguage?.htmlText("money","m_cbef679b21abb4","Cancel") ?? "Cancel")}</button><button type="submit" form="mnExpenseForm" class="mn-btn primary" ${busyAttr()}><i class="fas fa-check"></i>${escapeHtml(term('add_expense'))}</button>`;
    return modalFrame({ title:term('add_expense'), icon:'fa-arrow-up', body, foot });
  }

  function invoiceModalHtml(){
    const invoiceable = obligations().filter((item) => cleanText(item.source?.type) === 'proposal' && cleanText(item.status).toLowerCase() !== 'void' && cents(item.amount_cents) > 0);
    const today = todayKey();
    const taxSettings = state.invoiceSettings || {};
    const taxEnabled = taxSettings.sales_tax_enabled !== false;
    const defaultTaxPercent = Math.min(100, Math.max(0, Number(taxSettings.default_sales_tax_percent || 0)));
    const body = `<form class="mn-form" data-money-invoice-form id="mnInvoiceForm">
      <div class="mn-invoice-items">
        <div class="mn-invoice-items-head"><strong>${escapeHtml(term('invoice_items'))}</strong><button type="button" class="mn-btn small" data-money-invoice-picker-toggle><i class="fas fa-plus"></i>${(globalThis.PlatformLanguage?.htmlText("money","m_4d801afb3ef0c9","Add item") ?? "Add item")}</button></div>
        <div class="mn-invoice-item-picker" data-money-invoice-picker hidden><div class="mn-invoice-picker-list">
          <button type="button" class="mn-invoice-picker-choice" data-money-invoice-add-manual><span><strong>${(globalThis.PlatformLanguage?.htmlText("money","m_2e105a57c9384a","Custom item") ?? "Custom item")}</strong></span><i class="fas fa-plus"></i></button>
          ${invoiceable.map((item) => { const paid = cleanText(item.status).toLowerCase() === 'paid'; const displayCents = paid ? cents(item.amount_cents) : Math.max(0, cents(item.amount_cents) - cents(item.allocated_cents)); return `<button type="button" class="mn-invoice-picker-choice" data-money-invoice-add-payment="${escapeHtml(item.id)}"><span><strong>${escapeHtml(item.label || 'Payment')}</strong><span>${escapeHtml(money(displayCents))}${paid ? ' · Paid' : ''}</span></span><i class="fas fa-plus"></i></button>`; }).join('')}
        </div></div>
        <div class="mn-invoice-lines" data-money-invoice-lines><div class="mn-invoice-empty" data-money-invoice-empty>${(globalThis.PlatformLanguage?.htmlText("money","m_106189435c8ab8","No items yet.") ?? "No items yet.")}</div></div>
      </div>
      <div class="mn-invoice-date-row">
        <label><span>${(globalThis.PlatformLanguage?.htmlText("money","m_9007c34fd0a5f1","Issue Date") ?? "Issue Date")}</span><input class="mn-input" type="date" name="issue_date" value="${today}" required></label>
        <label><span>${(globalThis.PlatformLanguage?.htmlText("money","m_0c1007c4897c83","Due Date") ?? "Due Date")}</span><input class="mn-input" type="date" name="due_date" value="${today}" required></label>
        <label class="mn-switch-field"><span>${(globalThis.PlatformLanguage?.htmlText("money","m_c296b7859a927d","Paid in full ") ?? "Paid in full ")}<i class="fas fa-circle-info mn-help" tabindex="0" data-fm-tooltip="${escapeHtml('Render the PDF as paid in full.')}"></i></span><span class="mn-switch"><input type="checkbox" name="render_paid_in_full" data-money-invoice-paid-toggle role="switch" aria-label="${(globalThis.PlatformLanguage?.htmlText("money","m_edfaf579e9ff18","Render PDF as paid in full") ?? "Render PDF as paid in full")}"><span aria-hidden="true"></span></span></label>
      </div>
      ${taxEnabled ? `<div class="mn-invoice-tax-row"><label class="mn-switch-field"><span>${(globalThis.PlatformLanguage?.htmlText("money","m_265aee5b3f6c36","Sales tax") ?? "Sales tax")}</span><span class="mn-switch"><input type="checkbox" name="tax_enabled" data-money-invoice-tax-toggle role="switch" aria-label="${(globalThis.PlatformLanguage?.htmlText("money","m_3c60eff258a89d","Enable sales tax") ?? "Enable sales tax")}" checked><span aria-hidden="true"></span></span></label><label><span>${(globalThis.PlatformLanguage?.htmlText("money","m_609bec5738d42c","Tax %") ?? "Tax %")}</span><input class="mn-input" type="number" name="tax_percent" data-money-invoice-tax-percent min="0" max="100" step="0.01" value="${escapeHtml(String(defaultTaxPercent))}"></label></div>` : ''}
      <div class="mn-invoice-total-box"><div class="mn-invoice-total-row"><span>${(globalThis.PlatformLanguage?.htmlText("money","m_2fc5623e2a7511","Subtotal") ?? "Subtotal")}</span><span data-money-invoice-subtotal>${money(0)}</span></div>${taxEnabled ? `<div class="mn-invoice-total-row" data-money-invoice-tax-row-total><span>${(globalThis.PlatformLanguage?.htmlText("money","m_9920e005677da9","Tax") ?? "Tax")}</span><span data-money-invoice-tax-total>${money(0)}</span></div>` : ''}<div class="mn-invoice-total-row grand"><span>${escapeHtml(term('invoice_total'))}</span><span data-money-invoice-total>${money(0)}</span></div></div>
      <label class="wide"><span>${(globalThis.PlatformLanguage?.htmlText("money","m_78996580b607e8","Invoice Note") ?? "Invoice Note")}</span><textarea class="mn-input" name="notes" rows="2" placeholder="${(globalThis.PlatformLanguage?.htmlText("money","m_6db2d80ab62324","Shown to the customer") ?? "Shown to the customer")}"></textarea></label>
    </form>`;
    const foot = `<button type="button" class="mn-btn" data-money-modal-close>${(globalThis.PlatformLanguage?.htmlText("money","m_cbef679b21abb4","Cancel") ?? "Cancel")}</button><button type="submit" form="mnInvoiceForm" class="mn-btn" data-money-invoice-submit disabled><i class="fas fa-download"></i>${(globalThis.PlatformLanguage?.htmlText("money","m_92e593a70bd06d","Generate & Download") ?? "Generate & Download")}</button><button type="button" class="mn-btn primary" data-money-invoice-submit data-money-invoice-email-review disabled><i class="fas fa-paper-plane"></i>${(globalThis.PlatformLanguage?.htmlText("money","m_61ede0befce19b","Generate an Email") ?? "Generate an Email")}</button>`;
    return modalFrame({ title:term('generate_invoice'), icon:'fa-file-invoice-dollar', body, foot, size:'wide' });
  }

  function reportsModalHtml(){
    const docsApi = rootWindow.DocumentsAPI;
    if (!docsApi) return modalFrame({ title:term('reports'), icon:'fa-chart-column', body:`<div class="mn-alert error">Reports are unavailable. Refresh the portal to load them.</div>` });
    const rows = Array.isArray(state.reports) ? state.reports : null;
    const templates = Array.isArray(state.reportTemplates) ? state.reportTemplates : [];
    const generate = canManageMoney()
      ? `<form class="mn-form" data-money-report-form>
          <label class="wide"><span>${(globalThis.PlatformLanguage?.htmlText("money","m_587d96db750df7","Template") ?? "Template")}</span><select class="mn-select" name="template_id">${templates.length
            ? templates.map((template) => `<option value="${escapeHtml(template.id)}">${escapeHtml(template.name || template.id)}</option>`).join('')
            : `<option value="">${(globalThis.PlatformLanguage?.htmlText("money","m_393f42326e2feb","Job Cost Report") ?? "Job Cost Report")}</option>`}</select></label>
          <label><span>${(globalThis.PlatformLanguage?.htmlText("money","m_c313c42d1f7a10","From") ?? "From")}</span><input class="mn-input" name="period_from" type="date"></label>
          <label><span>${(globalThis.PlatformLanguage?.htmlText("money","m_6089f8623b0f11","Through") ?? "Through")}</span><input class="mn-input" name="period_to" type="date"></label>
          <div class="mn-form-actions"><button type="submit" class="mn-btn primary" ${busyAttr()} ${state.reportGenerating ? 'disabled' : ''}><i class="fas ${state.reportGenerating ? 'fa-circle-notch fa-spin' : 'fa-file-circle-plus'}"></i>${state.reportGenerating ? 'Generating…' : 'Generate'}</button></div>
        </form>`
      : '';
    const list = rows === null
      ? `<div class="mn-state"><i class="fas fa-circle-notch fa-spin"></i><span>${(globalThis.PlatformLanguage?.htmlText("money","m_d2da77452877dd","Loading…") ?? "Loading…")}</span></div>`
      : rows.length
        ? `<div class="mn-list">${rows.map((report) => `<div class="mn-list-row"><span class="mn-thumb" aria-hidden="true"><i class="fas fa-file-pdf"></i></span><div><strong>${escapeHtml(report.title || (globalThis.PlatformLanguage?.text("money","m_393f42326e2feb","Job Cost Report") ?? "Job Cost Report"))}</strong><small>${escapeHtml(dateTime(report.created_at) || '')}</small></div><a class="mn-btn small icon" aria-label="${(globalThis.PlatformLanguage?.htmlText("money","m_4944e59816b60a","Download PDF") ?? "Download PDF")}" data-fm-tooltip="Download PDF" href="${escapeHtml(docsApi.documents.pdfUrl(orgId(), cleanText(report.id)))}" target="_blank" rel="noopener"><i class="fas fa-download"></i></a></div>`).join('')}</div>`
        : `<div class="mn-empty"><i class="fas fa-chart-column" aria-hidden="true"></i>${(globalThis.PlatformLanguage?.htmlText("money","m_205b9549fb94da","No reports yet.") ?? "No reports yet.")}</div>`;
    const body = `${generate}<div class="mn-section-label"><span>${(globalThis.PlatformLanguage?.htmlText("money","m_9981230aa8e5d7","Generated ") ?? "Generated ")}<i class="fas fa-circle-info mn-help" tabindex="0" data-fm-tooltip="${escapeHtml("A report snapshots this project's financials (figures, expenses and payment history) as a PDF.")}"></i></span></div>${list}`;
    return modalFrame({ title:term('reports'), icon:'fa-chart-column', body });
  }

  function settingsModalHtml(modal){
    const draft = Array.isArray(modal.draft) ? modal.draft : moneyCategories();
    const rows = draft.map((category, index) => `<div class="mn-list-row" data-money-category-row="${index}">
      <input class="mn-input" data-money-category-label value="${escapeHtml(category.label)}" aria-label="${(globalThis.PlatformLanguage?.htmlText("money","m_bf56e73c5af69f","Category name") ?? "Category name")}" maxlength="60">
      <label class="mn-switch" data-fm-tooltip="${escapeHtml(category.hidden ? 'Hidden from new expenses' : 'Offered for new expenses')}"><input type="checkbox" data-money-category-visible ${category.hidden ? '' : 'checked'} aria-label="${escapeHtml(`Offer ${category.label}`)}"><span aria-hidden="true"></span></label>
      ${category.builtIn ? '<span class="mn-btn small icon" aria-hidden="true" style="visibility:hidden"></span>' : `<button type="button" class="mn-btn small icon danger" data-money-category-remove="${index}" aria-label="${escapeHtml(`Remove ${category.label}`)}" data-fm-tooltip="Remove"><i class="fas fa-trash"></i></button>`}
    </div>`).join('');
    const body = `<div class="mn-section-label"><span>${((v0) => globalThis.PlatformLanguage?.htmlText("money","m_2c563831005360",`${v0} categories `,{v0}) ?? `${v0} categories `)(escapeHtml(term('expense')))}<i class="fas fa-circle-info mn-help" tabindex="0" data-fm-tooltip="${escapeHtml('Categories sort and filter the ledger. Rename any, hide the ones you do not use, or add your own. Entries keep their category.')}"></i></span><button type="button" class="mn-btn small" data-money-category-add><i class="fas fa-plus"></i>${(globalThis.PlatformLanguage?.htmlText("money","m_c807a71e1c06f5","Add") ?? "Add")}</button></div>
      <div class="mn-list" data-money-category-list>${rows}</div>`;
    const foot = `<button type="button" class="mn-btn" data-money-modal-close>${(globalThis.PlatformLanguage?.htmlText("money","m_cbef679b21abb4","Cancel") ?? "Cancel")}</button><button type="button" class="mn-btn primary" data-money-settings-save ${busyAttr()}><i class="fas fa-check"></i>${(globalThis.PlatformLanguage?.htmlText("money","m_5bab3e72de1ebf","Save") ?? "Save")}</button>`;
    return modalFrame({ title:(globalThis.PlatformLanguage?.text("money","m_7d461dc7d355cc","Settings") ?? "Settings"), icon:'fa-gear', body, foot });
  }

  function autopayModalHtml(){
    const autopay = state.autopay;
    const methods = autopaySavedMethods();
    const busy = state.autopayBusy ? 'disabled' : '';
    const failNote = state.autopayError ? `<div class="mn-alert error">${escapeHtml(state.autopayError)}</div>` : '';
    if (!autopay) {
      const body = `<div class="mn-form">
          <label class="wide"><span>${(globalThis.PlatformLanguage?.htmlText("money","m_3d033c5dae7c96","Payment method") ?? "Payment method")}</span><select class="mn-select" data-money-autopay-method aria-label="${(globalThis.PlatformLanguage?.htmlText("money","m_03749d6c9f558b","Saved payment method") ?? "Saved payment method")}">${methods.map((method) => `<option value="${escapeHtml(method.id)}">${escapeHtml(cleanText(method.label, `${method.brand || 'Card'} ending in ${method.last4 || '????'}`))}</option>`).join('')}</select></label>
          <label class="wide"><span>${(globalThis.PlatformLanguage?.htmlText("money","m_dff87227ac01ef","Max charge ") ?? "Max charge ")}<i class="fas fa-circle-info mn-help" tabindex="0" data-fm-tooltip="Optional. A payment above this is not charged automatically."></i></span><input class="mn-input" type="text" inputmode="decimal" placeholder="$" data-money-autopay-max aria-label="${(globalThis.PlatformLanguage?.htmlText("money","m_2403460d906098","Maximum autopay amount") ?? "Maximum autopay amount")}"></label>
          <label class="wide mn-check"><input type="checkbox" data-money-autopay-consent><span>${(globalThis.PlatformLanguage?.htmlText("money","m_31dbd26f2b6bc4","The customer agreed to have this payment method charged automatically when each scheduled payment comes due.") ?? "The customer agreed to have this payment method charged automatically when each scheduled payment comes due.")}</span></label>
        </div>${failNote}`;
      const foot = `<button type="button" class="mn-btn" data-money-modal-close data-money-autopay-cancel>${(globalThis.PlatformLanguage?.htmlText("money","m_cbef679b21abb4","Cancel") ?? "Cancel")}</button><button type="button" class="mn-btn primary" data-money-autopay-enroll ${busy}><i class="fas fa-check"></i>${(globalThis.PlatformLanguage?.htmlText("money","m_53343f73dc0cb9","Enroll") ?? "Enroll")}</button>`;
      return modalFrame({ title:(globalThis.PlatformLanguage?.text("money","m_adb80fcef9bf78","Autopay") ?? "Autopay"), icon:'fa-arrows-rotate', body, foot, attrs:'data-money-autopay' });
    }
    const paused = cleanText(autopay.status) === 'paused';
    const failures = Array.isArray(autopay.failures) ? autopay.failures : [];
    const lastFailure = failures.length ? failures[failures.length - 1] : null;
    const nextDue = autopayNextDueLabel();
    const body = `<div class="mn-facts">
        <div><span>${(globalThis.PlatformLanguage?.htmlText("money","m_1352cafa75b8da","Status") ?? "Status")}</span><strong><span class="mn-status ${paused ? 'paused' : 'active'}" data-money-autopay-status>${paused ? 'Paused' : 'Active'}</span></strong></div>
        <div><span>${(globalThis.PlatformLanguage?.htmlText("money","m_3d033c5dae7c96","Payment method") ?? "Payment method")}</span><strong>${escapeHtml(cleanText(autopay.method_label, 'Saved payment method'))}</strong></div>
        <div><span>${(globalThis.PlatformLanguage?.htmlText("money","m_79fd1a7781df79","Max charge") ?? "Max charge")}</span><strong>${autopay.max_amount_cents ? escapeHtml(money(autopay.max_amount_cents)) : 'None'}</strong></div>
        <div><span>${(globalThis.PlatformLanguage?.htmlText("money","m_5e03a7c216f500","Next") ?? "Next")}</span><strong>${escapeHtml(paused ? '—' : nextDue || 'Nothing due')}</strong></div>
      </div>
      ${paused && lastFailure ? `<div class="mn-alert error" data-money-autopay-failure><i class="fas fa-triangle-exclamation"></i>${escapeHtml(cleanText(lastFailure.message, titleText(cleanText(lastFailure.decline_category, 'Charge failed'))))}</div>` : ''}
      ${failNote}`;
    const foot = `<button type="button" class="mn-btn danger mn-spacer" data-money-autopay-remove ${busy}><i class="fas fa-xmark"></i>${(globalThis.PlatformLanguage?.htmlText("money","m_9174f0f0b06dda","Turn off") ?? "Turn off")}</button>${paused
      ? `<button type="button" class="mn-btn primary" data-money-autopay-resume ${busy}><i class="fas fa-play"></i>${(globalThis.PlatformLanguage?.htmlText("money","m_6e04458d1b875e","Resume") ?? "Resume")}</button>`
      : `<button type="button" class="mn-btn" data-money-autopay-pause ${busy}><i class="fas fa-pause"></i>${(globalThis.PlatformLanguage?.htmlText("money","m_d7bcc3630f9499","Pause") ?? "Pause")}</button>`}`;
    return modalFrame({ title:(globalThis.PlatformLanguage?.text("money","m_adb80fcef9bf78","Autopay") ?? "Autopay"), icon:'fa-arrows-rotate', body, foot, attrs:'data-money-autopay' });
  }

  function expenseListsModalHtml(){
    const expenses = expenseData();
    const totals = expenses.totals || {};
    const targetOrder = new Map((Array.isArray(expenses.targets) ? expenses.targets : []).map((target, index) => [cleanText(target?.target_key), index]));
    const groups = (Array.isArray(expenses.groups) ? [...expenses.groups] : []).sort((a, b) => {
      const displayOrder = (group) => {
        const positions = (Array.isArray(group?.targets) ? group.targets : []).map((target) => targetOrder.get(cleanText(target?.target_key))).filter((position) => Number.isInteger(position));
        return positions.length ? Math.min(...positions) : Number.MAX_SAFE_INTEGER;
      };
      return displayOrder(a) - displayOrder(b) || cleanText(a?.title).localeCompare(cleanText(b?.title));
    });
    const variance = cents(totals.variance_cents);
    const body = `<div class="mn-facts">
        <div><span>${escapeHtml(term('current_forecast'))}</span><strong>${escapeHtml(money(totals.current_cents || 0))}</strong></div>
        <div><span>${escapeHtml(term('projected'))}</span><strong>${escapeHtml(money(totals.projected_cents || 0))}</strong></div>
        <div><span>${escapeHtml(term('tracked_actual'))}</span><strong>${escapeHtml(money(totals.actual_cents || 0))}</strong></div>
        <div><span>${escapeHtml(term('variance'))}</span><strong${variance > 0 ? ' style="color:#b42318"' : ''}>${variance > 0 ? '+' : variance < 0 ? '−' : ''}${escapeHtml(money(Math.abs(variance)))}</strong></div>
      </div>
      ${groups.length ? `<div class="mn-list">${groups.flatMap((group) => (Array.isArray(group?.targets) ? group.targets : []).map((target) => expenseTargetRowHtml(target, group))).join('')}</div>` : `<div class="mn-empty"><i class="fas fa-list-check" aria-hidden="true"></i>${((v0) => globalThis.PlatformLanguage?.htmlText("money","m_2076b6166d76ad",`No ${v0} yet.`,{v0}) ?? `No ${v0} yet.`)(escapeHtml(term('expense_lists').toLowerCase()))}</div>`}`;
    return modalFrame({ title:term('cost_forecast'), icon:'fa-list-check', body, size:'wide' });
  }

  function expenseTargetRowHtml(target, group){
    const manualActual = target?.actual_override_cents;
    const systemActual = target?.system_managed && target?.actual_cents != null ? cents(target.actual_cents) : null;
    const actualRevision = Number(target?.override?.revision || 0);
    const hasReceipts = Array.isArray(group?.receipts) && group.receipts.length > 0;
    const canSetActual = canManageMoney() && target?.actual_override_enabled !== false && !hasReceipts && systemActual == null;
    const shown = systemActual != null ? systemActual : manualActual != null ? manualActual : group?.actual_cents != null && (group.targets || []).length === 1 ? cents(group.actual_cents) : cents(target?.projected_cents);
    const tip = systemActual != null ? 'Accrued from the commission ledger' : manualActual != null ? `Actual entered by hand; projected ${money(target?.projected_cents || 0)}` : hasReceipts ? `From ${term('receipts').toLowerCase()}; projected ${money(group?.projected_cents || 0)}` : 'Projected';
    return `<div class="mn-list-row" style="--dot:${escapeHtml(target?.color || '#98a2b3')}"><span class="mn-dot" aria-hidden="true"></span><div><strong>${escapeHtml(target?.title || term('expense_list'))}</strong><small>${escapeHtml(titleText(target?.resource_type || 'other'))}${group?.grouped ? ` · ${escapeHtml(group.title || '')}` : ''}</small></div><span class="mn-amount" data-fm-tooltip="${escapeHtml(tip)}">${escapeHtml(money(shown))}</span>${canSetActual ? `<button type="button" class="mn-btn small icon" data-money-set-actual="${escapeHtml(target?.target_key)}" data-current-actual="${manualActual == null ? '' : escapeHtml(manualActual)}" data-projected="${escapeHtml(target?.projected_cents || 0)}" data-actual-revision="${escapeHtml(actualRevision || '')}" ${busyAttr()} aria-label="${escapeHtml(manualActual == null ? 'Set actual' : 'Edit actual')}" data-fm-tooltip="${escapeHtml(manualActual == null ? 'Set actual' : 'Edit actual')}"><i class="fas fa-pen"></i></button>` : '<span class="mn-btn small icon" aria-hidden="true" style="visibility:hidden"></span>'}</div>`;
  }

  function fact(label, value){
    return `<div><span>${escapeHtml(label)}</span><strong>${escapeHtml(cleanText(value) || '—')}</strong></div>`;
  }

  function itemModalHtml(modal){
    const row = findEntry(modal.key);
    if (!row) return '';
    const manage = canManageMoney();
    const source = row.source || {};
    const hero = `<div class="mn-amount-hero"><span class="mn-cat">${escapeHtml(row.categoryLabel)}</span><strong>${row.type === 'record' ? escapeHtml(money(row.amount)) : `${row.signed < 0 ? '−' : '+'}${escapeHtml(money(Math.abs(row.signed)))}`}</strong></div>`;
    let facts = [];
    let extra = '';
    let foot = '';
    if (row.kind === 'payment') {
      const clearedAt = cleanText(source.cleared_at);
      const reconcilable = ['settled', 'partially_refunded', 'refunded'].includes(cleanText(source.status || 'settled'));
      const refundable = Math.max(0, cents(source.amount_cents) - cents(source.refunded_cents));
      facts = [fact('Received', shortDate(row.at)), fact('Method', row.title), fact('Status', titleText(row.status)), fact('Refunded', money(source.refunded_cents || 0)), fact('Cleared', clearedAt ? shortDate(clearedAt) : 'No'), fact('Reference', row.id)];
      if (manage && modal.action === 'refund') extra = refundFormHtml(row, refundable);
      else if (manage && modal.action === 'reallocate') extra = reallocateFormHtml(row);
      else if (manage) foot = `<button type="button" class="mn-btn mn-spacer" data-money-print-receipt="${escapeHtml(row.id)}"><i class="fas fa-print"></i>${(globalThis.PlatformLanguage?.htmlText("money","m_ab3df34a8730df","Receipt") ?? "Receipt")}</button>
        ${reconcilable ? (clearedAt
          ? `<button type="button" class="mn-btn" data-money-unclear-payment="${escapeHtml(row.id)}" ${busyAttr()} data-fm-tooltip="Reopen bank reconciliation"><i class="fas fa-ban"></i>${(globalThis.PlatformLanguage?.htmlText("money","m_7e8ea8edb916d5","Unmark cleared") ?? "Unmark cleared")}</button>`
          : `<button type="button" class="mn-btn" data-money-clear-payment="${escapeHtml(row.id)}" ${busyAttr()} data-fm-tooltip="Confirmed against the bank"><i class="fas fa-check-double"></i>${(globalThis.PlatformLanguage?.htmlText("money","m_9f00a7e6f0e015","Mark cleared") ?? "Mark cleared")}</button>`) : ''}
        <button type="button" class="mn-btn" data-money-item-action="reallocate" ${busyAttr()}><i class="fas fa-diagram-project"></i>${(globalThis.PlatformLanguage?.htmlText("money","m_0005067130883e","Reallocate") ?? "Reallocate")}</button>
        ${refundable ? `<button type="button" class="mn-btn danger" data-money-item-action="refund" ${busyAttr()}><i class="fas fa-rotate-left"></i>${(globalThis.PlatformLanguage?.htmlText("money","m_aeef17228560b9","Refund") ?? "Refund")}</button>` : ''}`;
    } else if (row.kind === 'refund') {
      facts = [fact('Date', shortDate(row.at)), fact('Reason', row.detail)];
    } else if (row.kind === 'expense') {
      const targetNames = (source.expense_target_keys || []).map((key) => (expenseData().targets || []).find((target) => cleanText(target.target_key) === cleanText(key))?.title).filter(Boolean);
      const open = Math.max(0, cents(source.amount_cents) - cents(source.paid_cents));
      const canRemove = cents(source.paid_cents) === 0 && !['paid', 'void'].includes(cleanText(row.status));
      const later = row.recurring && cleanText(source.metadata?.recurrence_group_id) ? laterRecurringExpenses(source) : [];
      facts = [fact('Date', shortDate(row.at)), fact(term('recipient'), cleanText(source.payee_ref?.name, source.vendor_ref?.name)), fact('Status', titleText(row.status)), fact('Paid', money(source.paid_cents || 0)), fact(term('expense_list'), targetNames.join(', ')), row.recurring ? fact(term('recurring'), recurrenceLabel(source)) : ''];
      extra = row.receipts.length ? `<div class="mn-section-label">${escapeHtml(term('receipts'))}</div><div class="mn-receipt-strip">${row.receipts.map((receipt) => `<button type="button" class="mn-thumb" data-money-open-receipt="${escapeHtml(receipt.id)}" aria-label="${escapeHtml(receiptTitle(receipt))}" data-fm-tooltip="${escapeHtml(`${receiptTitle(receipt)} · ${money(receiptTotal(receipt))}`)}">${receiptImageUrl(receipt) ? `<img loading="lazy" src="${escapeHtml(receiptImageUrl(receipt))}" alt="">` : '<i class="fas fa-receipt"></i>'}</button>`).join('')}</div>` : '';
      if (manage && modal.action === 'pay') extra += payExpenseFormHtml(row, open);
      else if (manage) foot = `${canRemove ? `<button type="button" class="mn-btn danger mn-spacer" data-money-delete-expense="${escapeHtml(row.id)}" ${busyAttr()}><i class="fas fa-trash"></i>${(globalThis.PlatformLanguage?.htmlText("money","m_f643f568915438","Remove") ?? "Remove")}</button>` : ''}
        ${canRemove && later.length ? `<button type="button" class="mn-btn danger" data-money-delete-recurring="${escapeHtml(row.id)}" ${busyAttr()} data-fm-tooltip="${escapeHtml(`Also removes ${later.length} later unpaid ${later.length === 1 ? 'one' : 'ones'}`)}"><i class="fas fa-repeat"></i>${(globalThis.PlatformLanguage?.htmlText("money","m_7dcf0ac7ea70a7","Remove this and later") ?? "Remove this and later")}</button>` : ''}
        ${open ? `<button type="button" class="mn-btn primary" data-money-item-action="pay" ${busyAttr()}><i class="fas fa-paper-plane"></i>${((v1) => globalThis.PlatformLanguage?.htmlText("money","m_e1a3489698dc61",`Pay ${v1}`,{v1}) ?? `Pay ${v1}`)(escapeHtml(money(open)))}</button>` : ''}`;
    } else if (row.kind === 'invoice') {
      const status = statusClass(source.status || 'draft');
      facts = [fact('Issued', shortDate(source.issue_date)), fact('Due', shortDate(source.due_date)), fact('Status', titleText(row.status)), fact('Balance due', money(source.balance_due_cents ?? source.total_cents)), source.render_paid_in_full === true ? fact('PDF', 'Paid in full') : ''];
      extra = (source.line_items || []).length ? `<div class="mn-lines">${(source.line_items || []).map((item) => `<div><span>${escapeHtml(item.description || 'Item')}</span><strong>${escapeHtml(money(item.amount_cents || 0))}</strong></div>`).join('')}</div>` : '';
      foot = `<a class="mn-btn mn-spacer" href="${escapeHtml(rootWindow.PaymentsAPI?.invoices?.pdfUrl?.(orgId(), row.id) || '#')}"><i class="fas fa-download"></i>${(globalThis.PlatformLanguage?.htmlText("money","m_2440c46d7ac5f3","PDF") ?? "PDF")}</a>
        ${manage ? `<button type="button" class="mn-btn" data-money-invoice-email-existing="${escapeHtml(row.id)}" ${busyAttr()}><i class="fas fa-envelope"></i>${(globalThis.PlatformLanguage?.htmlText("money","m_5d2b9327181e33","Email") ?? "Email")}</button>` : ''}
        ${manage && !['paid', 'due', 'overdue'].includes(status) ? `<button type="button" class="mn-btn primary" data-money-invoice-due="${escapeHtml(row.id)}" ${busyAttr()} data-fm-tooltip="Publish to the customer portal for payment"><i class="fas fa-calendar-check"></i>${(globalThis.PlatformLanguage?.htmlText("money","m_4ab97a813f8f30","Mark Due") ?? "Mark Due")}</button>` : ''}`;
    } else if (row.kind === 'receipt') {
      const image = receiptImageUrl(source);
      const attributed = (source.attributed_target_keys || []).map((key) => (expenseData().targets || []).find((target) => cleanText(target.target_key) === cleanText(key))?.title).filter(Boolean);
      extra = `<button type="button" class="mn-preview" data-money-open-receipt="${escapeHtml(row.id)}" aria-label="${escapeHtml(`Open ${row.title}`)}">${image ? `<img src="${escapeHtml(image)}" alt="">` : '<i class="fas fa-file-lines"></i>'}</button>`;
      facts = [fact('Purchased', shortDate(cleanText(source.purchase_date, source.effective?.purchase_date))), fact('Status', titleText(row.status)), fact(term('expense_lists'), attributed.join(', ')), fact('Uploaded', dateTime(cleanText(source.uploaded_at, source.created_at))), source.reimbursement?.payee_ref?.name ? fact('Reimburse', source.reimbursement.payee_ref.name) : ''];
      foot = `${manage ? `<button type="button" class="mn-btn danger mn-spacer" data-money-void-receipt="${escapeHtml(row.id)}" ${busyAttr()}><i class="fas fa-ban"></i>${(globalThis.PlatformLanguage?.htmlText("money","m_ce16922c5208b8","Void") ?? "Void")}</button>` : ''}
        <a class="mn-btn${manage ? '' : ' mn-spacer'}" href="${escapeHtml(rootWindow.PaymentsAPI?.receipts?.fileUrl?.(orgId(), row.id) || '#')}" target="_blank" rel="noopener"><i class="fas fa-download"></i>${(globalThis.PlatformLanguage?.htmlText("money","m_7211fc5d40302a","Original") ?? "Original")}</a>
        ${manage ? `<button type="button" class="mn-btn primary" data-money-review-receipt="${escapeHtml(row.id)}" ${busyAttr()}><i class="fas fa-list-check"></i>${(globalThis.PlatformLanguage?.htmlText("money","m_4420b0058ee405","Review & apply") ?? "Review & apply")}</button>` : ''}`;
    }
    const notes = cleanText(source.notes) ? `<p class="mn-note">${escapeHtml(source.notes)}</p>` : '';
    const body = `${hero}${row.kind === 'receipt' ? extra : ''}<div class="mn-facts">${facts.filter(Boolean).join('')}</div>${notes}${row.kind === 'receipt' ? '' : extra}`;
    return modalFrame({ title:row.title, icon:row.icon, body, foot, size:row.kind === 'invoice' || row.kind === 'receipt' ? 'wide' : '' });
  }

  function refundFormHtml(row, available){
    return `<form class="mn-sub-panel" data-money-refund-form data-payment-id="${escapeHtml(row.id)}"><strong>${(globalThis.PlatformLanguage?.htmlText("money","m_aeef17228560b9","Refund") ?? "Refund")}</strong><div class="mn-form">
      <label><span>${(globalThis.PlatformLanguage?.htmlText("money","m_2b8c3448fa87a1","Amount") ?? "Amount")}</span><input class="mn-input" name="amount" type="number" min="0" step="0.01" value="${escapeHtml((available / 100).toFixed(2))}" required></label>
      <label><span>${(globalThis.PlatformLanguage?.htmlText("money","m_6480ed19528b5a","Reason") ?? "Reason")}</span><input class="mn-input" name="reason" type="text" value="Customer refund"></label>
      <div class="mn-form-actions"><button type="button" class="mn-btn" data-money-item-action="">${(globalThis.PlatformLanguage?.htmlText("money","m_cbef679b21abb4","Cancel") ?? "Cancel")}</button><button type="submit" class="mn-btn danger" ${busyAttr()}><i class="fas fa-rotate-left"></i>${(globalThis.PlatformLanguage?.htmlText("money","m_5142397f39ed11","Record Refund") ?? "Record Refund")}</button></div>
    </div></form>`;
  }

  function reallocateFormHtml(row){
    return `<form class="mn-sub-panel" data-money-reallocate-form data-payment-id="${escapeHtml(row.id)}"><strong>${(globalThis.PlatformLanguage?.htmlText("money","m_f9a5679a38ff8e","Reallocate ") ?? "Reallocate ")}<i class="fas fa-circle-info mn-help" tabindex="0" data-fm-tooltip="Enter the amount to apply to each scheduled payment. Blank rows are ignored."></i></strong>
      ${obligations().map((item) => `<div class="mn-alloc-row"><label class="mn-form"><span style="font-size:12px;font-weight:700">${escapeHtml(item.label || 'Payment')} · ${escapeHtml(money(item.amount_cents || 0))}</span><input class="mn-input" name="alloc:${escapeHtml(item.id)}" type="number" min="0" step="0.01" placeholder="0.00"></label><span class="mn-status ${statusClass(item.status || 'scheduled')}">${escapeHtml(titleText(item.status || 'scheduled'))}</span></div>`).join('') || `<div class="mn-empty">${(globalThis.PlatformLanguage?.htmlText("money","m_54006129c09b01","No scheduled payments.") ?? "No scheduled payments.")}</div>`}
      <div class="mn-form-actions"><button type="button" class="mn-btn" data-money-item-action="">${(globalThis.PlatformLanguage?.htmlText("money","m_cbef679b21abb4","Cancel") ?? "Cancel")}</button><button type="submit" class="mn-btn primary" ${busyAttr()}><i class="fas fa-diagram-project"></i>${(globalThis.PlatformLanguage?.htmlText("money","m_265446118d78a1","Save Allocation") ?? "Save Allocation")}</button></div>
    </form>`;
  }

  function payExpenseFormHtml(row, open){
    return `<form class="mn-sub-panel" data-money-disbursement-form data-payable-id="${escapeHtml(row.id)}"><strong>${(globalThis.PlatformLanguage?.htmlText("money","m_f4f42f8c853a8d","Pay") ?? "Pay")}</strong><div class="mn-form">
      <label><span>${(globalThis.PlatformLanguage?.htmlText("money","m_2b8c3448fa87a1","Amount") ?? "Amount")}</span><input class="mn-input" name="amount" type="number" min="0" step="0.01" value="${escapeHtml((open / 100).toFixed(2))}" required></label>
      <label><span>${(globalThis.PlatformLanguage?.htmlText("money","m_6952fe71f8dc85","Method") ?? "Method")}</span><select class="mn-select" name="method"><option value="check">${(globalThis.PlatformLanguage?.htmlText("money","m_cc74e4e6c905ec","Check") ?? "Check")}</option><option value="cash">${(globalThis.PlatformLanguage?.htmlText("money","m_f758b041cf8d5c","Cash") ?? "Cash")}</option><option value="ach">${(globalThis.PlatformLanguage?.htmlText("money","m_97ab16559ee9ee","ACH") ?? "ACH")}</option><option value="card">${(globalThis.PlatformLanguage?.htmlText("money","m_dd2dde7989cd96","Card") ?? "Card")}</option><option value="manual">${(globalThis.PlatformLanguage?.htmlText("money","m_4a04382820d2e1","Other") ?? "Other")}</option></select></label>
      <label class="wide"><span>${(globalThis.PlatformLanguage?.htmlText("money","m_de7d6168ae1ad6","Notes") ?? "Notes")}</span><input class="mn-input" name="notes" type="text"></label>
      <div class="mn-form-actions"><button type="button" class="mn-btn" data-money-item-action="">${(globalThis.PlatformLanguage?.htmlText("money","m_cbef679b21abb4","Cancel") ?? "Cancel")}</button><button type="submit" class="mn-btn primary" ${busyAttr()}><i class="fas fa-paper-plane"></i>${(globalThis.PlatformLanguage?.htmlText("money","m_1a47eb522f1195","Record Payment Out") ?? "Record Payment Out")}</button></div>
    </div></form>`;
  }

  function recurrenceLabel(payable){
    const rule = payable?.metadata?.recurrence || {};
    const frequency = cleanText(rule.frequency);
    if (!frequency) return 'Yes';
    const interval = Math.max(1, Number(rule.interval || 1));
    const unit = { weekly:'week', monthly:'month', yearly:'year' }[frequency] || frequency;
    return `${interval === 1 ? `Every ${unit}` : `Every ${interval} ${unit}s`}${rule.until ? ` until ${shortDate(rule.until)}` : ''}`;
  }

  function laterRecurringExpenses(payable){
    const group = cleanText(payable?.metadata?.recurrence_group_id);
    const from = Date.parse(cleanText(payable?.due_at)) || 0;
    return payables().filter((item) => item.id !== payable.id
      && cleanText(item.metadata?.recurrence_group_id) === group
      && (Date.parse(cleanText(item.due_at)) || 0) > from
      && cents(item.paid_cents) === 0
      && !['paid', 'void'].includes(cleanText(item.status)));
  }

  function receiptReviewHtml(){
    const review = state.receiptReview;
    if (review.phase === 'uploading') return modalFrame({ title:(globalThis.PlatformLanguage?.text("money","m_c1767dcd832c57","Reading purchase document") ?? "Reading purchase document"), icon:'fa-receipt', body:`<div class="mn-receipt-loading"><i class="fas fa-circle-notch fa-spin"></i><div>Pulling totals and purchase details…</div><span class="mn-muted">${escapeHtml(review.fileName || term('receipt'))}</span></div>`, attrs:'data-money-receipt-modal' });
    if (review.phase === 'error') return modalFrame({ title:(globalThis.PlatformLanguage?.text("money","m_c9b0194ff9817b","Receipt upload needs attention") ?? "Receipt upload needs attention"), icon:'fa-triangle-exclamation', body:`<div class="mn-receipt-loading"><div>${escapeHtml(review.error || 'Could not process this file.')}</div></div>`, foot:'<button type="button" class="mn-btn" data-money-receipt-close>Close</button>', attrs:'data-money-receipt-modal' });
    const receipt = review.receipt || {};
    const targets = (expenseData().targets || []).filter((target) => target?.receipt_attribution_enabled !== false);
    const selected = new Set((Array.isArray(receipt.attributed_target_keys) && receipt.attributed_target_keys.length ? receipt.attributed_target_keys : receipt.suggested_target_keys) || []);
    const lines = Array.isArray(receipt.extraction?.line_items) ? receipt.extraction.line_items : [];
    const warnings = Array.isArray(receipt.extraction?.warnings) ? receipt.extraction.warnings : [];
    const readOnly = !canManageMoney();
    const reviewDisabled = readOnly || moneyMutationBusy() ? 'disabled' : '';
    return `<div data-fm-window-backdrop="off" class="mn-modal-shade" data-money-modal-shade><form class="mn-modal xwide" data-money-receipt-apply data-receipt-id="${escapeHtml(receipt.id)}" role="dialog" aria-modal="true" aria-label="${(globalThis.PlatformLanguage?.htmlText("money","m_2df085d0598fd3","Review Receipt") ?? "Review Receipt")}">
      <div class="mn-modal-head"><div><span class="mn-thumb" aria-hidden="true"><i class="fas fa-receipt"></i></span><strong>${(globalThis.PlatformLanguage?.htmlText("money","m_2df085d0598fd3","Review Receipt") ?? "Review Receipt")}</strong></div><button type="button" class="mn-btn small icon" data-money-receipt-close aria-label="${(globalThis.PlatformLanguage?.htmlText("money","m_3742924668fb10","Close") ?? "Close")}" ${state.saving ? 'disabled' : ''}><i class="fas fa-xmark"></i></button></div>
      <div class="mn-receipt-modal-body"><div class="mn-receipt-review">
        <div class="mn-file-summary"><i class="fas fa-file-invoice-dollar"></i><div><strong>${escapeHtml(receipt.file?.file_name || receipt.title || term('receipt'))}</strong><span>${escapeHtml(receipt.file?.content_type || '')}${receipt.file?.size_bytes ? ` · ${Math.max(1, Math.round(receipt.file.size_bytes / 1024)).toLocaleString(globalThis.PlatformLanguage?.formatLocale?.())} KB` : ''}</span></div></div>
        ${receipt.duplicate_of_receipt_id ? `<label class="mn-alert"><input type="checkbox" name="confirm_duplicate" value="yes" ${reviewDisabled}>${(globalThis.PlatformLanguage?.htmlText("money","m_4ff2334846d39b","This file matches an existing receipt. Confirm it is a separate expense before applying.") ?? "This file matches an existing receipt. Confirm it is a separate expense before applying.")}</label>` : ''}
        ${warnings.length ? `<div class="mn-alert">${escapeHtml(warnings.join(' '))}</div>` : ''}
        <div class="mn-form">
          <label class="wide"><span>${(globalThis.PlatformLanguage?.htmlText("money","m_9403c7637d4905","Total") ?? "Total")}</span><input class="mn-input" name="total" type="number" min="0" step="0.01" value="${escapeHtml(receipt.total_cents ? (receipt.total_cents / 100).toFixed(2) : '')}" required ${reviewDisabled}></label>
          <label><span>${(globalThis.PlatformLanguage?.htmlText("money","m_f3cb225c1c3e0a","Purchase Date") ?? "Purchase Date")}</span><input class="mn-input" name="purchase_date" type="date" value="${escapeHtml(receipt.purchase_date || '')}" ${reviewDisabled}></label>
          <label><span>${(globalThis.PlatformLanguage?.htmlText("money","m_2d11bf79588d5e","Purchase Time") ?? "Purchase Time")}</span><input class="mn-input" name="purchase_time" type="time" step="1" value="${escapeHtml(receipt.purchase_time || '')}" ${reviewDisabled}></label>
        </div>
        ${lines.length ? `<details class="mn-receipt-lines"><summary>${((v0,v1) => globalThis.PlatformLanguage?.text("money","m_c2957dd4e77e96",`${v0} extracted line item${v1}`,{v0,v1}) ?? `${v0} extracted line item${v1}`)(lines.length,lines.length === 1 ? '' : 's')}</summary>${lines.slice(0, 30).map((line) => `<div><span>${escapeHtml(line.description || 'Line item')}</span><strong>${money(line.total_cents || 0)}</strong></div>`).join('')}</details>` : ''}
        <div class="mn-form">
          <label class="wide"><span>${(globalThis.PlatformLanguage?.htmlText("money","m_8b8d7106c3c872","Reimburse to ") ?? "Reimburse to ")}<i class="fas fa-circle-info mn-help" tabindex="0" data-fm-tooltip="Optional: someone who paid out of pocket. A reimbursement is added to the ledger."></i></span>
            <select class="mn-select" name="reimburse_user" data-money-reimburse-select ${reviewDisabled}>
              <option value="">${(globalThis.PlatformLanguage?.htmlText("money","m_79d4145b0d2889","No reimbursement") ?? "No reimbursement")}</option>
              ${(state.orgUsers || []).map((user) => `<option value="${escapeHtml(user.id)}" ${cleanText(receipt.reimbursement?.payee_ref?.id) === user.id ? 'selected' : ''}>${escapeHtml(user.name)}</option>`).join('')}
              <option value="__other__">${(globalThis.PlatformLanguage?.htmlText("money","m_b0d2b8a6eddf50","Other person…") ?? "Other person…")}</option>
            </select></label>
          <label class="wide" data-money-reimburse-other hidden><span>${(globalThis.PlatformLanguage?.htmlText("money","m_5875991c412359","Person to pay back") ?? "Person to pay back")}</span><input class="mn-input" name="reimburse_other_name" type="text" placeholder="${(globalThis.PlatformLanguage?.htmlText("money","m_8cf345002184e5","Name") ?? "Name")}" ${reviewDisabled}></label>
        </div>
      </div><div class="mn-receipt-targets"><div class="mn-section-label"><span>${((v17) => globalThis.PlatformLanguage?.htmlText("money","m_3c334ae999e449",`Apply to ${v17} `,{v17}) ?? `Apply to ${v17} `)(escapeHtml(term('expense_lists').toLowerCase()))}<i class="fas fa-circle-info mn-help" tabindex="0" data-fm-tooltip="Suggested from the total. Select every list this document covers."></i></span></div>
        ${targets.map((target) => `<label class="mn-receipt-target-choice"><input type="checkbox" name="target_key" value="${escapeHtml(target.target_key)}" ${selected.has(target.target_key) ? 'checked' : ''} ${reviewDisabled}><span><strong>${escapeHtml(target.title || term('expense_list'))}</strong><span>${escapeHtml(titleText(target.resource_type || 'other'))}</span></span><strong>${money(target.projected_cents || 0)}</strong></label>`).join('') || `<div class="mn-empty">${((v0) => globalThis.PlatformLanguage?.text("money","m_2076b6166d76ad",`No ${v0} yet.`,{v0}) ?? `No ${v0} yet.`)(escapeHtml(term('expense_lists').toLowerCase()))}</div>`}
      </div></div>
      <div class="mn-modal-foot"><a class="mn-btn mn-spacer" href="${escapeHtml(rootWindow.PaymentsAPI?.receipts?.fileUrl?.(orgId(), receipt.id) || receipt.file_url || '#')}" target="_blank" rel="noopener"><i class="fas fa-download"></i>${(globalThis.PlatformLanguage?.htmlText("money","m_7211fc5d40302a","Original") ?? "Original")}</a><button type="button" class="mn-btn" data-money-receipt-close ${state.saving ? 'disabled' : ''}>${(globalThis.PlatformLanguage?.htmlText("money","m_3742924668fb10","Close") ?? "Close")}</button>${canManageMoney() ? `<button type="submit" class="mn-btn primary" ${moneyMutationBusy() || !targets.length ? 'disabled' : ''}><i class="fas fa-check"></i>${(globalThis.PlatformLanguage?.htmlText("money","m_f1a988cdd500c6","Apply Receipt") ?? "Apply Receipt")}</button>` : ''}</div>
    </form></div>`;
  }

  function receiptBatchHtml(){
    const batch = state.receiptBatch;
    const targets = Array.isArray(expenseData().targets) ? expenseData().targets : [];
    const ready = batch.items.filter((item) => item.status === 'ready').length;
    const failed = batch.items.filter((item) => item.status === 'error').length;
    const working = batch.items.length - ready - failed;
    const rows = batch.items.map((item) => {
      const receipt = item.receipt || {};
      const suggested = new Set(receipt.suggested_target_keys || []);
      const matches = targets.filter((target) => suggested.has(target.target_key)).map((target) => target.title || term('expense_list'));
      const status = item.status || 'queued';
      const icon = status === 'ready' ? 'fa-check' : status === 'error' ? 'fa-triangle-exclamation' : status === 'uploading' ? 'fa-circle-notch fa-spin' : 'fa-clock';
      const title = cleanText(receipt.title, receipt.extraction?.vendor_name, item.file_name, 'Receipt');
      const detail = status === 'ready'
        ? `${receipt.total_cents ? money(receipt.total_cents) : 'Total needs review'}${receipt.purchase_date ? ` · ${shortDate(receipt.purchase_date)}` : ''}`
        : status === 'error' ? item.error : status === 'uploading' ? 'Reading this file…' : 'Waiting';
      const match = status === 'ready' ? (matches.length ? `Suggested match: ${matches.join(', ')}` : '') : '';
      return `<div class="mn-batch-item ${escapeHtml(status)}"><span class="mn-batch-icon"><i class="fas ${icon}"></i></span><div class="mn-batch-copy"><strong>${escapeHtml(title)}</strong><span>${escapeHtml(detail)}</span>${match ? `<span class="mn-batch-match"><i class="fas fa-wand-magic-sparkles"></i> ${escapeHtml(match)}</span>` : ''}</div>${status === 'ready' ? `<button type="button" class="mn-btn small" data-money-batch-review="${escapeHtml(receipt.id)}"><i class="fas fa-code-compare"></i>${(globalThis.PlatformLanguage?.htmlText("money","m_e3fbd46ed1ed15","Match") ?? "Match")}</button>` : ''}</div>`;
    }).join('');
    const body = `<div class="mn-batch-summary"><i class="fas ${working ? 'fa-circle-notch fa-spin' : 'fa-layer-group'}"></i><span>${((v1,v2,v3) => globalThis.PlatformLanguage?.htmlText("money","m_68ffed54b5366b",`${v1} ready · ${v2} processing${v3}`,{v1,v2,v3}) ?? `${v1} ready · ${v2} processing${v3}`)(ready,working,failed ? ` · ${failed} failed` : '')}</span></div>${rows}`;
    return `<div data-fm-window-backdrop="off" class="mn-modal-shade" data-money-modal-shade><div class="mn-modal wide" role="dialog" aria-modal="true" aria-label="${(globalThis.PlatformLanguage?.htmlText("money","m_5377fab7a5079b","Match uploaded receipts") ?? "Match uploaded receipts")}"><div class="mn-modal-head"><div><span class="mn-thumb" aria-hidden="true"><i class="fas fa-receipt"></i></span><strong>${(globalThis.PlatformLanguage?.htmlText("money","m_5377fab7a5079b","Match uploaded receipts") ?? "Match uploaded receipts")}</strong></div><button type="button" class="mn-btn small icon" data-money-batch-close aria-label="${(globalThis.PlatformLanguage?.htmlText("money","m_8f1a129fd1f30c","Close batch") ?? "Close batch")}"><i class="fas fa-xmark"></i></button></div><div class="mn-modal-body">${body}</div></div></div>`;
  }

  function bindModal(layer){
    const manage = canManageMoney();
    layer.querySelectorAll('[data-money-modal-close]').forEach((button) => button.addEventListener('click', () => {
      if (button.hasAttribute('data-money-autopay-cancel')) state.autopayError = '';
      closeModal();
    }));
    layer.querySelector('[data-money-modal-shade]')?.addEventListener('mousedown', (event) => {
      if (event.target !== event.currentTarget) return;
      if (state.receiptBatch || state.receiptReview) return;
      if (state.modal?.type === 'take_payment' && moneyMutationBusy()) return;
      closeModal();
    });
    layer.querySelectorAll('[data-money-item-action]').forEach((button) => button.addEventListener('click', () => {
      if (!state.modal) return;
      state.modal = { ...state.modal, action:cleanText(button.dataset.moneyItemAction) };
      renderModal({ force:true });
    }));
    layer.querySelectorAll('[data-money-open-receipt]').forEach((button) => button.addEventListener('click', () => openReceiptViewer(button.dataset.moneyOpenReceipt)));
    layer.querySelectorAll('[data-money-review-receipt]').forEach((button) => button.addEventListener('click', () => {
      const receipt = receipts().find((item) => cleanText(item.id) === cleanText(button.dataset.moneyReviewReceipt));
      if (!receipt) return;
      openReceiptReview(receipt);
    }));
    layer.querySelectorAll('[data-money-print-receipt]').forEach((button) => button.addEventListener('click', () => printReceipt({ id:button.dataset.moneyPrintReceipt })));
    layer.querySelector('[data-money-batch-close]')?.addEventListener('click', () => {
      state.receiptBatch = null;
      renderModal({ force:true });
    });
    layer.querySelectorAll('[data-money-batch-review]').forEach((button) => button.addEventListener('click', () => {
      const receipt = state.receiptBatch?.items?.find((item) => cleanText(item.receipt?.id) === cleanText(button.dataset.moneyBatchReview))?.receipt;
      if (!receipt) return;
      state.receiptBatch = null;
      openReceiptReview(receipt);
    }));
    layer.querySelectorAll('[data-money-receipt-close]').forEach((button) => button.addEventListener('click', () => {
      if (state.saving) return;
      state.receiptOperationSequence += 1;
      state.receiptReview = null;
      renderModal({ force:true });
    }));
    layer.querySelector('[data-money-report-form]')?.addEventListener('submit', (event) => {
      event.preventDefault();
      if (!manage || moneyMutationBusy()) return;
      const data = new FormData(event.currentTarget);
      void generateMoneyReport({ template_id:cleanText(data.get('template_id')), period_from:cleanText(data.get('period_from')), period_to:cleanText(data.get('period_to')) });
    });
    if (!manage) return;
    layer.querySelector('[data-money-payment-form]')?.addEventListener('submit', submitPayment);
    const expenseForm = layer.querySelector('[data-money-payable-form]');
    expenseForm?.addEventListener('submit', submitPayable);
    expenseForm?.querySelector('[data-money-repeat]')?.addEventListener('change', (event) => {
      const until = expenseForm.querySelector('[data-money-repeat-until]');
      if (until) until.hidden = !cleanText(event.target.value);
      const input = until?.querySelector('input');
      if (input) input.required = !!cleanText(event.target.value);
    });
    layer.querySelector('[data-money-refund-form]')?.addEventListener('submit', submitRefund);
    layer.querySelector('[data-money-reallocate-form]')?.addEventListener('submit', submitReallocate);
    layer.querySelector('[data-money-disbursement-form]')?.addEventListener('submit', submitDisbursement);
    layer.querySelectorAll('[data-money-delete-expense]').forEach((button) => button.addEventListener('click', () => { if (!moneyMutationBusy()) void removeExpense(button.dataset.moneyDeleteExpense); }));
    layer.querySelectorAll('[data-money-delete-recurring]').forEach((button) => button.addEventListener('click', () => { if (!moneyMutationBusy()) void removeExpense(button.dataset.moneyDeleteRecurring, { later:true }); }));
    layer.querySelectorAll('[data-money-clear-payment]').forEach((button) => button.addEventListener('click', () => { if (!moneyMutationBusy()) void clearPaymentAction(button.dataset.moneyClearPayment); }));
    layer.querySelectorAll('[data-money-unclear-payment]').forEach((button) => button.addEventListener('click', () => { if (!moneyMutationBusy()) void unclearPaymentAction(button.dataset.moneyUnclearPayment); }));
    layer.querySelectorAll('[data-money-invoice-due]').forEach((button) => button.addEventListener('click', () => { if (!moneyMutationBusy()) void markInvoiceDueNow(button.dataset.moneyInvoiceDue); }));
    layer.querySelectorAll('[data-money-void-receipt]').forEach((button) => button.addEventListener('click', () => { if (!moneyMutationBusy()) void voidReceipt(button.dataset.moneyVoidReceipt); }));
    layer.querySelectorAll('[data-money-set-actual]').forEach((button) => button.addEventListener('click', () => { if (!moneyMutationBusy()) void editExpenseActual(button); }));
    layer.querySelectorAll('[data-money-invoice-email-existing]').forEach((button) => button.addEventListener('click', () => openInvoiceEmailModal(layer, { invoiceId:button.dataset.moneyInvoiceEmailExisting })));
    const invoiceForm = layer.querySelector('[data-money-invoice-form]');
    if (invoiceForm) {
      invoiceForm.addEventListener('submit', submitInvoice);
      bindInvoiceComposer(invoiceForm);
      layer.querySelector('[data-money-invoice-email-review]')?.addEventListener('click', () => openInvoiceEmailModal(layer, { invoiceForm }));
    }
    layer.querySelector('[data-money-receipt-apply]')?.addEventListener('submit', submitReceiptApply);
    const reimburseSelect = layer.querySelector('[data-money-reimburse-select]');
    if (reimburseSelect) {
      if (state.orgUsers === null) void loadOrgUsers();
      reimburseSelect.addEventListener('change', () => {
        const other = layer.querySelector('[data-money-reimburse-other]');
        if (other) other.hidden = reimburseSelect.value !== '__other__';
      });
    }
    bindSettingsModal(layer);
    bindAutopayModal(layer);
    mountPaymentIntake(layer);
  }

  function bindSettingsModal(layer){
    const list = layer.querySelector('[data-money-category-list]');
    if (!list || state.modal?.type !== 'settings') return;
    const readDraft = () => {
      list.querySelectorAll('[data-money-category-row]').forEach((rowNode) => {
        const entry = state.modal.draft[Number(rowNode.dataset.moneyCategoryRow)];
        if (!entry) return;
        entry.label = cleanText(rowNode.querySelector('[data-money-category-label]')?.value) || entry.label;
        entry.hidden = !rowNode.querySelector('[data-money-category-visible]')?.checked;
      });
    };
    layer.querySelector('[data-money-category-add]')?.addEventListener('click', () => {
      readDraft();
      state.modal.draft.push({ id:'', label:'', hidden:false, builtIn:false });
      renderModal({ force:true });
      const inputs = rootNode()?.querySelectorAll('[data-money-category-label]');
      inputs?.[inputs.length - 1]?.focus();
    });
    list.querySelectorAll('[data-money-category-remove]').forEach((button) => button.addEventListener('click', () => {
      readDraft();
      state.modal.draft.splice(Number(button.dataset.moneyCategoryRemove), 1);
      renderModal({ force:true });
    }));
    layer.querySelector('[data-money-settings-save]')?.addEventListener('click', () => {
      readDraft();
      void saveMoneySettings(state.modal.draft);
    });
  }

  function categoryId(label, taken){
    const base = `custom_${cleanText(label).toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 40) || 'category'}`;
    let id = base;
    for (let index = 2; taken.has(id); index += 1) id = `${base}_${index}`;
    taken.add(id);
    return id;
  }

  async function saveMoneySettings(draft){
    if (!canManageMoney() || moneyMutationBusy()) return;
    if (!rootWindow.PlatformAPI?.branchModules?.save) return showToast((globalThis.PlatformLanguage?.text("money","m_405553670d574e","Settings could not be saved.") ?? "Settings could not be saved."), (globalThis.PlatformLanguage?.text("money","m_7e784f9b5540ab","error") ?? "error"));
    const taken = new Set(draft.map((entry) => cleanText(entry.id)).filter(Boolean));
    const categories = draft
      .filter((entry) => cleanText(entry.id) || cleanText(entry.label))
      .map((entry) => ({ id:cleanText(entry.id) || categoryId(entry.label, taken), label:cleanText(entry.label, builtInCategoryLabel(entry.id)).slice(0, 60), ...(entry.hidden ? { hidden:true } : {}) }));
    const requestedOrgId = orgId();
    state.saving = true;
    syncBusy();
    try {
      const next = { ...(state.moneySettings || {}), expense_categories:categories };
      const result = await rootWindow.PlatformAPI.branchModules.save(requestedOrgId, branchId(), 'money_settings', next, { kind:'branch_money_settings', source:'project_money_settings' });
      if (requestedOrgId !== orgId()) return;
      state.moneySettings = result?.data || result?.module?.data || next;
      showToast((globalThis.PlatformLanguage?.text("money","m_4c73b46df33b36","Settings saved.") ?? "Settings saved."), (globalThis.PlatformLanguage?.text("money","m_b4e54589824dc5","success") ?? "success"));
      state.modal = null;
      renderAll();
    } catch (error) {
      showToast(error?.message || 'Settings could not be saved.', (globalThis.PlatformLanguage?.text("money","m_7e784f9b5540ab","error") ?? "error"));
    } finally {
      state.saving = false;
      syncBusy();
    }
  }

  function bindAutopayModal(layer){
    if (state.modal?.type !== 'autopay') return;
    layer.querySelector('[data-money-autopay-enroll]')?.addEventListener('click', () => {
      const methodId = cleanText(layer.querySelector('[data-money-autopay-method]')?.value);
      const maxRaw = cleanText(layer.querySelector('[data-money-autopay-max]')?.value);
      const maxCents = maxRaw ? centsFromDollars(maxRaw) : 0;
      if (!methodId) return;
      if (!layer.querySelector('[data-money-autopay-consent]')?.checked) {
        state.autopayError = 'Confirm the customer agreed to automatic payments first.';
        renderModal({ force:true });
        return;
      }
      void autopayMutate(() => {
        const contact = primaryContact(state.project);
        return rootWindow.PaymentsAPI.autopay.enroll(orgId(), projectId(), {
          saved_method_id: methodId,
          status: 'active',
          customer_authorized: true,
          max_amount_cents: maxCents > 0 ? maxCents : null,
          ...(contact ? { contact_ref: contact } : {})
        });
      });
    });
    layer.querySelector('[data-money-autopay-pause]')?.addEventListener('click', () => {
      void autopayMutate(() => rootWindow.PaymentsAPI.autopay.update(orgId(), projectId(), { status: 'paused' }));
    });
    layer.querySelector('[data-money-autopay-resume]')?.addEventListener('click', () => {
      void autopayMutate(() => rootWindow.PaymentsAPI.autopay.update(orgId(), projectId(), { status: 'active' }));
    });
    layer.querySelector('[data-money-autopay-remove]')?.addEventListener('click', () => {
      void autopayMutate(async () => {
        await rootWindow.PaymentsAPI.autopay.remove(orgId(), projectId());
        return { autopay: null };
      });
    });
  }

  async function autopayMutate(work){
    if (!canManageMoney() || state.autopayBusy) return;
    state.autopayBusy = true;
    state.autopayError = '';
    renderModal({ force:true });
    try {
      const result = await work();
      state.autopay = result && Object.prototype.hasOwnProperty.call(result, 'autopay') ? result.autopay : null;
    } catch (error) {
      state.autopayError = error?.message || 'Autopay change failed.';
    } finally {
      state.autopayBusy = false;
      if (state.modal?.type === 'autopay') renderModal({ force:true });
      renderMain();
    }
  }

  function openReceiptReview(receipt){
    state.receiptOperationSequence += 1;
    state.receiptViewer?.close?.({ fromRoute:true });
    state.receiptViewer = null;
    if (cleanText(rootWindow.Portal?.navigation?.read?.()?.receipt)) {
      rootWindow.Portal.navigation.replace?.({ receipt:null }, { source:'money-receipt-review', ownedKeys:['receipt'] });
    }
    state.receiptReview = { phase:'ready', receipt };
    renderModal({ force:true });
  }

  // Receipts open in the shared receipt viewer (image or PDF preview, details, download); its Review & apply
  // opens this tab's review over the ledger. The open receipt is the route's `receipt`.
  function openReceiptViewer(receiptId, options = {}){
    const all = receipts().slice().sort((left, right) => cleanText(right.purchase_date, right.created_at).localeCompare(cleanText(left.purchase_date, left.created_at)));
    const index = all.findIndex((receipt) => cleanText(receipt.id) === cleanText(receiptId));
    if (index < 0) return false;
    if (!rootWindow.Portal?.ReceiptsBrowser?.openViewer) {
      openModal({ type:'item', key:`receipt:${cleanText(receiptId)}` });
      return true;
    }
    state.receiptViewer?.close?.({ fromRoute:true });
    const project = state.project || {};
    const routeReceipt = (id, history) => rootWindow.Portal?.navigation?.[history]?.({ receipt:id || null }, { source:`money-receipt-viewer-${history}`, ownedKeys:['receipt'] });
    state.receiptViewer = rootWindow.Portal.ReceiptsBrowser.openViewer({
      items:all.map((receipt) => ({ photo:{ receipt }, project })),
      index,
      orgId:orgId(),
      onReview:canManageMoney() ? (receipt) => openReceiptReview(receipt) : undefined,
      onChange:(receipt) => routeReceipt(receipt.id, 'replace'),
      onClose:() => {
        state.receiptViewer = null;
        rootWindow.Portal?.navigation?.backOrClose?.(['receipt'], { receipt:null }, { source:'money-receipt-viewer-close' });
      }
    });
    // The viewer is open before the route names it, so the route handler sees it and does not open another.
    if (!options.fromRoute) routeReceipt(receiptId, 'push');
    return true;
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
    if (state.receiptReview) renderModal({ force:true });
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
    if (state.modal?.type === 'reports') renderModal({ force:true });
  }

  async function generateMoneyReport(options = {}){
    const docsApi = rootWindow.DocumentsAPI;
    if (!docsApi || state.reportGenerating) return;
    state.reportGenerating = true;
    renderModal({ force:true });
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
    renderModal({ force:true });
    void loadReports();
  }

  function findInvoice(id){
    return invoices().find((invoice) => cleanText(invoice.id) === cleanText(id));
  }

  function invoiceComposerLineHtml(item = {}){
    const type = cleanText(item.type) === 'payment' ? 'payment' : 'manual';
    const readonly = type === 'payment' ? 'readonly' : '';
    return `<div class="mn-invoice-line" data-money-invoice-line data-line-type="${String(type)}" data-obligation-id="${String(escapeHtml(item.obligation_id || ''))}" data-paid="${String(item.paid === true ? 'true' : 'false')}">
      <label><span>${(globalThis.PlatformLanguage?.htmlText("money","m_feb2fa0bebb7bf","Item Title") ?? "Item Title")}</span><input class="mn-input" data-money-invoice-line-title value="${String(escapeHtml(item.description || ''))}" placeholder="${(globalThis.PlatformLanguage?.htmlText("money","m_2e121533e8b8d3","Invoice item") ?? "Invoice item")}" ${String(readonly)}></label>
      <label><span>${(globalThis.PlatformLanguage?.htmlText("money","m_2b8c3448fa87a1","Amount") ?? "Amount")}</span><input class="mn-input" data-money-invoice-line-amount type="number" min="0.01" step="0.01" value="${String((cents(item.amount_cents) / 100).toFixed(2))}" ${String(readonly)}></label>
      <button type="button" class="mn-invoice-line-remove" data-money-invoice-line-remove aria-label="${(globalThis.PlatformLanguage?.htmlText("money","m_1dfe8d61e491ea","Remove invoice item") ?? "Remove invoice item")}"><i class="fas fa-trash"></i></button>
    </div>`;
  }

  function invoiceSubmitButtons(form){
    return [...form.querySelectorAll('[data-money-invoice-submit]'), ...(form.closest('[data-money-modal-layer]')?.querySelectorAll('[data-money-invoice-submit]') || [])];
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
    invoiceSubmitButtons(form).forEach((button) => {
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
      <div data-fm-window-backdrop="off" class="mn-modal-shade top" data-money-invoice-email-modal>
        <form class="mn-modal" role="dialog" aria-modal="true" aria-label="${escapeHtml(invoiceId ? `Email ${invoice.invoice_number || 'Invoice'}` : 'Generate and Email Invoice')}" data-money-invoice-email-modal-form data-invoice-id="${String(escapeHtml(invoiceId))}">
          <div class="mn-modal-head"><div><span class="mn-thumb" aria-hidden="true"><i class="fas fa-envelope"></i></span><strong>${String(invoiceId ? `Email ${escapeHtml(invoice.invoice_number || 'Invoice')}` : 'Generate and Email Invoice')}</strong></div><button type="button" class="mn-btn small icon" aria-label="${(globalThis.PlatformLanguage?.htmlText("money","m_9fec01010b24a1","Close email invoice") ?? "Close email invoice")}" data-money-invoice-email-close><i class="fas fa-xmark"></i></button></div>
          <div class="mn-modal-body"><div class="mn-form">
            <label class="wide"><span>${(globalThis.PlatformLanguage?.htmlText("money","m_14b1c9a789a757","Email To") ?? "Email To")}</span><input class="mn-input" name="recipient" type="email" value="${escapeHtml(recipient)}" placeholder="${(globalThis.PlatformLanguage?.htmlText("money","m_2780de7b9bd16a","customer@example.com") ?? "customer@example.com")}" required></label>
            <label class="wide"><span>${(globalThis.PlatformLanguage?.htmlText("money","m_a16cfd85cfd122","Message") ?? "Message")}</span><textarea class="mn-input" name="message" rows="3" placeholder="${(globalThis.PlatformLanguage?.htmlText("money","m_7321fe3378912c","Your invoice is attached.") ?? "Your invoice is attached.")}"></textarea></label>
            <label class="wide mn-check"><input type="checkbox" name="include_portal_link" ${String(paidPresentation ? '' : 'checked')}><span>${((v4) => globalThis.PlatformLanguage?.htmlText("money","m_ef10c2a3c0ee95",`Include the customer portal link${v4}`,{v4}) ?? `Include the customer portal link${v4}`)(paidPresentation ? '' : ' to pay')}</span></label>
          </div></div>
          <div class="mn-modal-foot"><button type="button" class="mn-btn" data-money-invoice-email-close>${(globalThis.PlatformLanguage?.htmlText("money","m_cbef679b21abb4","Cancel") ?? "Cancel")}</button><button type="submit" class="mn-btn primary" ${busyAttr()}><i class="fas fa-paper-plane"></i> ${String(invoiceId ? 'Send Invoice' : 'Generate & Send')}</button></div>
        </form>
      </div>
    `;
  }

  function openInvoiceEmailModal(layer, options = {}){
    const invoiceForm = options.invoiceForm || null;
    const invoiceId = cleanText(options.invoiceId);
    const paidPresentation = invoiceId
      ? findInvoice(invoiceId)?.render_paid_in_full === true
      : !!invoiceForm?.querySelector('[data-money-invoice-paid-toggle]')?.checked;
    layer.querySelector('[data-money-invoice-email-modal]')?.remove();
    layer.insertAdjacentHTML('beforeend', invoiceEmailModal(invoiceId, paidPresentation));
    const shade = layer.querySelector('[data-money-invoice-email-modal]');
    const close = () => shade?.remove();
    shade?.querySelectorAll('[data-money-invoice-email-close]').forEach((button) => button.addEventListener('click', close));
    shade?.addEventListener('mousedown', (event) => { if (event.target === shade) close(); });
    shade?.querySelector('[data-money-invoice-email-modal-form]')?.addEventListener('submit', (event) => {
      if (invoiceId) void submitInvoiceEmail(event);
      else void submitGeneratedInvoiceEmail(event, invoiceForm);
    });
    shade?.querySelector('input[name="recipient"]')?.focus();
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
    syncBusy();
    renderModal({ force:true });
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
          renderModal({ force:true });
        }
      });
      if (!operationIsCurrent()) return;
      showToast(((v0,v1) => globalThis.PlatformLanguage?.text("money","m_7a7a9eeff9ac00",`${v0} receipt${v1} ready to match.`,{v0,v1}) ?? `${v0} receipt${v1} ready to match.`)(result.succeeded,result.succeeded === 1 ? '' : 's'), result.failed ? `${result.failed} file${result.failed === 1 ? '' : 's'} need attention.` : '', result.failed === 0);
    } catch (error) {
      if (!operationIsCurrent()) return;
      showToast(error?.message || 'Could not upload these receipts.', (globalThis.PlatformLanguage?.text("money","m_7e784f9b5540ab","error") ?? "error"));
    } finally {
      if (uploadOwnsLock()) {
        state.receiptUploadInFlight = false;
        if (requestedOrgId === orgId() && requestedProjectId === projectId()) {
          syncBusy();
          renderMain();
        }
      }
    }
  }

  async function voidReceipt(receiptId){
    if (!receiptId || !canManageMoney() || moneyMutationBusy()) return;
    const requestedOrgId = orgId();
    const requestedProjectId = projectId();
    const confirmFn = rootWindow.PlatformUI?.confirm || rootWindow.confirm;
    const confirmed = await Promise.resolve(confirmFn('Void this receipt? Its original file stays stored, but it no longer counts toward expenses.'));
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
    syncBusy();
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
        ? `Receipt applied. Reimbursement owed to ${result.reimbursement_payable.payee_ref?.name || 'the payee'} was added.`
        : 'Receipt applied to project expenses.', (globalThis.PlatformLanguage?.text("money","m_b4e54589824dc5","success") ?? "success"));
      state.saving = false;
      renderModal({ force:true });
      await loadData();
    } catch (error) {
      if (!operationIsCurrent()) return;
      showToast(error?.message || 'Could not apply this receipt.', (globalThis.PlatformLanguage?.text("money","m_7e784f9b5540ab","error") ?? "error"));
    } finally {
      if (operationIsCurrent()) {
        state.saving = false;
        syncBusy();
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
    const value = await Promise.resolve(promptFn('Actual expense in dollars. Leave blank to use the projection.', initial));
    if (value == null || !canManageMoney() || moneyMutationBusy() || requestedOrgId !== orgId() || requestedProjectId !== projectId()) return;
    const actualCents = cleanText(value) ? centsFromDollars(value) : null;
    await withSave(async () => {
      await rootWindow.PaymentsAPI.expenses.setActual(requestedOrgId, requestedProjectId, {
        target_key:button.dataset.moneySetActual,
        actual_cents:actualCents,
        ...(Number(button.dataset.actualRevision || 0) > 0 ? { expected_revision:Number(button.dataset.actualRevision) } : {}),
        reason:'money_tab_manual_actual'
      });
    }, actualCents == null ? 'Actual override cleared.' : 'Actual expense updated.', { keepModal:true });
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
    return withSave(async () => {
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
    }, 'Payment marked cleared.', { keepModal:true });
  }

  async function unclearPaymentAction(paymentId){
    const id = cleanText(paymentId);
    if (!id) return;
    await withSave(async () => {
      await rootWindow.PaymentsAPI.payments.unclear(orgId(), id);
    }, 'Payment reconciliation reopened.', { keepModal:true });
  }

  async function markInvoiceDueNow(invoiceId){
    const invoice = findInvoice(invoiceId);
    if (!invoice) return;
    const confirmFn = rootWindow.PlatformUI?.confirm || rootWindow.confirm || (() => true);
    const confirmed = await Promise.resolve(confirmFn(`Mark ${invoice.invoice_number || 'this invoice'} as due now? This publishes the payment to the customer portal.`));
    if (!confirmed) return;
    await withSave(async () => {
      await rootWindow.PaymentsAPI.invoices.markDue(orgId(), invoiceId, {});
    }, 'Invoice is due and available in the customer portal.', { keepModal:true });
  }

  async function submitInvoiceEmail(event){
    event.preventDefault();
    const form = event.currentTarget;
    const data = new FormData(form);
    const recipient = cleanText(data.get('recipient'));
    if (!recipient) return showToast((globalThis.PlatformLanguage?.text("money","m_26a722f92451ba","Enter an email address.") ?? "Enter an email address."), (globalThis.PlatformLanguage?.text("money","m_7e784f9b5540ab","error") ?? "error"));
    const includePortalLink = data.get('include_portal_link') === 'on';
    const sent = await withSave(async () => {
      await rootWindow.PaymentsAPI.invoices.email(orgId(), form.dataset.invoiceId, {
        recipient,
        include_portal_link:includePortalLink,
        message:cleanText(data.get('message'))
      });
    }, `Invoice emailed to ${recipient}.`, { keepModal:true });
    if (sent) form.closest('[data-money-invoice-email-modal]')?.remove();
  }

  function paymentIntakeContactRef(){
    const contact = primaryContact(state.project || {}) || {};
    return cleanText(contact.id, contact.contact_id, String(contact.email || '').toLowerCase());
  }

  function paymentIntakeProviderOptions(){
    // The payment form offers card or bank entry only when the organization
    // can take payments (the server's readiness answer). Otherwise it says
    // why, and nothing in it can record a payment.
    const entry = state.paymentIntakeConfig;
    const config = entry && entry.key === `${orgId()}:${projectId()}` ? entry.config : null;
    if (!config || config.ready !== true || !config.provider) {
      return {
        notReadyMessage: cleanText(config?.message) || 'Online payments are not set up yet. Finish payment setup in Settings, Payments.',
        refundPolicy: cleanText(config?.refund_policy)
      };
    }
    const requestedOrgId = orgId();
    const rails = config.rails || {};
    const contact = primaryContact(state.project || {}) || {};
    return {
      savedMethods: Array.isArray(config.saved_methods) ? config.saved_methods : [],
      refundPolicy: cleanText(config.refund_policy),
      methods: [rails.card !== false ? 'card' : '', rails.bank !== false ? 'ach' : ''].filter(Boolean),
      tokenization: {
        mode: cleanText(config.tokenization?.mode) || 'mock',
        sdkUrl: cleanText(config.tokenization?.sdk_url),
        publicKey: cleanText(config.tokenization?.public_key),
        prepare: async ({ method, amountCents }) => (await rootWindow.PaymentsAPI.intake.checkout(requestedOrgId, {
          amount_cents: amountCents,
          method,
          project_id: projectId(),
          branch_id: branchId(),
          contact_ref: contact,
          apply_surcharge: config.surcharge?.enabled === true
        }))?.checkout,
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
        config = result && typeof result.ready === 'boolean' ? result : null;
        // Cache only definitive answers; a failed/aborted fetch is asked again.
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
      title: term('take_collected_payment'),
      description: '',
      amountLabel: `${term('collected_payment')} amount`,
      amountCents: null,
      allowCustomAmount: true,
      methods: ['card', 'ach'],
      ...paymentIntakeProviderOptions(),
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
        { label: (globalThis.PlatformLanguage?.text("money","m_f4305fea9e5634","Back to Money") ?? "Back to Money"), primary: true, onClick: () => { closeModal(); void loadData(); } }
      ],
      onSubmit: async (payment) => {
        if (!canManageMoney() || moneyMutationBusy()) throw new Error('You do not have permission to record this payment, or another money change is still saving.');
        const requestedOrgId = orgId();
        const requestedProjectId = projectId();
        const requestedBranchId = branchId();
        const mutationToken = ++state.mutationToken;
        state.saving = true;
        syncBusy();
        const methodLabel = payment.savedPaymentMethod?.label || titleText(payment.method || 'payment');
        try {
          const tokenized = !!(payment.payment_method_id || payment.saved_method_id);
          // Card and bank payments are charged through the processor; this
          // form never records one as paid without a charge.
          if (!tokenized) throw new Error('Enter the payment details to continue.');
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
              checkout_id: cleanText(payment.checkout_id),
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
            syncBusy();
          }
        }
      }
    };
  }

  function mountPaymentIntake(layer){
    const mount = layer.querySelector('[data-money-payment-intake]');
    if (!canManageMoney() || !mount || !rootWindow.FirstMatePaymentIntake?.mount) {
      if (mount) mount.innerHTML = `<div class="mn-alert error">${escapeHtml('Payments are unavailable. Refresh the portal to load them.')}</div>`;
      return;
    }
    state.paymentIntakeHandle?.close?.();
    state.paymentIntakeHandle = null;
    if (state.paymentIntakeConfig?.key === `${orgId()}:${projectId()}`) {
      state.paymentIntakeHandle = rootWindow.FirstMatePaymentIntake.mount(mount, paymentIntakeOptions());
      return;
    }
    mount.innerHTML = `<div class="mn-state"><i class="fas fa-circle-notch fa-spin"></i></div>`;
    // Resolve provider config once per org+project before mounting so the
    // form opens directly in the right mode.
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

  // Runs one money change. The open modal keeps what was typed if it fails; on success it closes (or, for an
  // entry's own actions, `keepModal` redraws the entry with the refreshed data).
  async function withSave(work, successMessage, options = {}){
    if (!canManageMoney() || moneyMutationBusy()) return false;
    const mutationToken = ++state.mutationToken;
    const mutationIsCurrent = () => mutationToken === state.mutationToken;
    state.saving = true;
    state.error = '';
    syncBusy();
    try {
      await work();
      if (!mutationIsCurrent()) return false;
      showToast(successMessage || 'Saved.', (globalThis.PlatformLanguage?.text("money","m_b4e54589824dc5","success") ?? "success"));
      if (options.keepModal && state.modal) state.modal = { ...state.modal, action:'' };
      else state.modal = null;
      state.saving = false;
      renderModal({ force:true });
      await loadData();
      return true;
    } catch (error) {
      if (!mutationIsCurrent()) return false;
      showToast(error?.message || 'Could not save money changes.', (globalThis.PlatformLanguage?.text("money","m_7e784f9b5540ab","error") ?? "error"));
      return false;
    } finally {
      if (mutationIsCurrent()) {
        state.saving = false;
        syncBusy();
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
        method: { type: method, label: method === 'manual' ? 'Other' : method === 'ach' ? 'ACH' : titleText(method) },
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
    }, 'Refund recorded.', { keepModal:true });
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
    }, 'Payment allocation updated.', { keepModal:true });
  }

  // The dates of a repeating expense: the first date and every interval after it through `until`.
  function recurrenceDates(first, frequency, interval, until){
    const match = cleanText(first).match(/^(\d{4})-(\d{2})-(\d{2})$/);
    const end = cleanText(until);
    if (!match || !end) return [cleanText(first)];
    const [year, month, day] = [Number(match[1]), Number(match[2]) - 1, Number(match[3])];
    const dates = [];
    for (let index = 0; index < 1000; index += 1) {
      let date;
      if (frequency === 'weekly') date = new Date(Date.UTC(year, month, day + index * 7 * interval));
      else {
        const months = frequency === 'yearly' ? index * 12 * interval : index * interval;
        const target = new Date(Date.UTC(year, month + months, 1));
        const lastDay = new Date(Date.UTC(target.getUTCFullYear(), target.getUTCMonth() + 1, 0)).getUTCDate();
        date = new Date(Date.UTC(target.getUTCFullYear(), target.getUTCMonth(), Math.min(day, lastDay)));
      }
      const key = date.toISOString().slice(0, 10);
      if (key > end) break;
      dates.push(key);
    }
    return dates;
  }

  async function submitPayable(event){
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    const amount = centsFromDollars(data.get('amount'));
    if (amount <= 0) return;
    const firstDate = cleanText(data.get('due_at')) || todayKey();
    const [frequency, intervalText] = cleanText(data.get('repeat')).split(':');
    const until = cleanText(data.get('repeat_until'));
    const interval = Math.max(1, Number(intervalText || 1));
    const dates = frequency ? recurrenceDates(firstDate, frequency, interval, until) : [firstDate];
    if (frequency && until < firstDate) return showToast((globalThis.PlatformLanguage?.text("money","m_4fb5facd19c69c","The end date is before the first date.") ?? "The end date is before the first date."), (globalThis.PlatformLanguage?.text("money","m_7e784f9b5540ab","error") ?? "error"));
    if (dates.length > RECURRING_LIMIT) return showToast(((v0,v1) => globalThis.PlatformLanguage?.text("money","m_3f5d0170df8d22",`That repeats ${v0} times. Choose an end date with at most ${v1}.`,{v0,v1}) ?? `That repeats ${v0} times. Choose an end date with at most ${v1}.`)(dates.length,RECURRING_LIMIT), (globalThis.PlatformLanguage?.text("money","m_7e784f9b5540ab","error") ?? "error"));
    const groupId = frequency ? (rootWindow.crypto?.randomUUID?.() || `recurring-${Date.now()}`) : '';
    await withSave(async () => {
      const vendor = cleanText(data.get('vendor'));
      const expenseTargetKey = cleanText(data.get('expense_target_key'));
      for (const [index, dueAt] of dates.entries()) {
        await rootWindow.PaymentsAPI.payables.create(orgId(), {
          project_id: projectId(),
          branch_id: branchId(),
          amount_cents: amount,
          kind: cleanText(data.get('kind')) || 'other',
          due_at: dueAt,
          notes: cleanText(data.get('notes')),
          expense_target_keys:expenseTargetKey ? [expenseTargetKey] : [],
          payee_ref: vendor ? { kind:'manual_payee', name:vendor } : {},
          ...(groupId ? { metadata:{ recurring:true, recurrence_group_id:groupId, occurrence_index:index, recurrence:{ frequency, interval, until } } } : {})
        });
      }
    }, dates.length > 1 ? `${dates.length} expenses added.` : 'Expense added.');
  }

  async function removeExpense(expenseId, options = {}){
    if (!canManageMoney() || moneyMutationBusy() || !expenseId) return;
    const expense = payables().find((item) => cleanText(item.id) === cleanText(expenseId));
    if (!expense || cents(expense.paid_cents) > 0) return showToast((globalThis.PlatformLanguage?.text("money","m_be2e9e776e4eb5","Paid expenses cannot be removed.") ?? "Paid expenses cannot be removed."), (globalThis.PlatformLanguage?.text("money","m_7e784f9b5540ab","error") ?? "error"));
    const later = options.later ? laterRecurringExpenses(expense) : [];
    const question = later.length ? `Remove this expense and ${later.length} later unpaid ${later.length === 1 ? 'one' : 'ones'}?` : 'Remove this expense from the project ledger?';
    const confirmFn = rootWindow.PlatformUI?.confirm || rootWindow.Portal?.ui?.confirm || rootWindow.confirm;
    const approved = await Promise.resolve(confirmFn(question));
    if (!approved) return;
    await withSave(async () => {
      for (const item of [expense, ...later]) await rootWindow.PaymentsAPI.payables.remove(orgId(), item.id);
    }, later.length ? `${later.length + 1} expenses removed.` : 'Expense removed.');
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
        method: { type: method, label: method === 'manual' ? 'Other' : method === 'ach' ? 'ACH' : titleText(method) },
        notes: cleanText(data.get('notes'))
      });
    }, 'Payment out recorded.', { keepModal:true });
  }

  function renderAll(){
    if (!state.active) return;
    renderMain();
    renderModal();
  }

  // Escape closes the topmost Money layer only. It runs from window capture, ahead of the project window's own
  // Escape (which would close the whole window), and stops there when it closed something.
  function onKeydown(event){
    if (event.key !== 'Escape' || event.defaultPrevented || !state.active) return;
    const layer = rootNode()?.querySelector('[data-money-modal-layer]');
    const handled = () => { event.preventDefault(); event.stopImmediatePropagation(); };
    if (state.receiptViewer) { handled(); state.receiptViewer.close?.(); return; }
    if (!layer?.firstElementChild) return;
    handled();
    const emailModal = layer.querySelector('[data-money-invoice-email-modal]');
    if (emailModal) { emailModal.remove(); return; }
    if (state.saving || state.receiptBatch) return;
    if (state.receiptReview) { state.receiptReview = null; renderModal({ force:true }); return; }
    if (state.modal?.action) { state.modal = { ...state.modal, action:'' }; renderModal({ force:true }); return; }
    closeModal();
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
    state.active = context.active !== false;
    const route = rootWindow.Portal?.navigation?.read?.() || {};
    if (route.moneyView) state.ledgerFilter = filterForView(route.moneyView);
    rootNode();
    if (state.active) loadData();
    return api;
  }

  function setActive(active, context = null){
    if (context) mount({ ...state.context, ...context, active });
    state.active = !!active;
    if (state.active) loadData();
    else {
      state.receiptViewer?.close?.({ fromRoute:true });
      state.receiptViewer = null;
    }
  }

  function reset(){
    state.loadSequence += 1;
    state.receiptOperationSequence += 1;
    state.receiptUploadToken += 1;
    state.mutationToken += 1;
    state.receiptUploadInFlight = false;
    state.receiptViewer?.close?.({ fromRoute:true });
    state.receiptViewer = null;
    state.paymentIntakeHandle?.close?.();
    state.paymentIntakeHandle = null;
    state.summary = null;
    state.events = [];
    state.invoices = [];
    state.invoiceSettings = { sales_tax_enabled:true, default_sales_tax_percent:0 };
    state.reports = null;
    state.error = '';
    state.activeScheduleId = 'all';
    state.autopay = null;
    state.autopayBusy = false;
    state.autopayError = '';
    state.ledgerFilter = 'all';
    state.ledgerSearch = '';
    state.ledgerSort = { key:'date', direction:'desc' };
    state.modal = null;
    state.receiptReview = null;
    state.receiptBatch = null;
    state.loading = false;
    state.saving = false;
    const layer = state.panelRoot?.querySelector?.('[data-money-modal-layer]');
    if (layer) { layer.innerHTML = ''; layer.dataset.modalKey = ''; }
  }

  function unmount(){
    state.active = false;
    reset();
  }

  // A save of the organization's wording reloads it (PlatformTerminology announces the new words, and every
  // change of words, including the library terms arriving, repaints the tab).
  async function refreshMoneyTerminology(event){
    if (cleanText(event?.detail?.moduleId) !== 'variable_mappings' || !state.active || !orgId()) return;
    try { await rootWindow.PlatformTerminology?.refresh?.(orgId(), branchId()); } catch (_) {}
  }
  rootWindow.addEventListener('fm:branch-module:updated', refreshMoneyTerminology);
  rootWindow.addEventListener('fm:terminology:updated', () => { if (state.active && state.host) renderAll(); });
  rootWindow.addEventListener('keydown', onKeydown, true);

  const api = {
    mount,
    setActive,
    activate: (context) => setActive(true, context),
    deactivate: () => setActive(false),
    reset,
    unmount,
    refresh: loadData,
    context: () => ({ mounted: !!state.panelRoot, active: state.active, projectId: projectId(), view: viewForFilter(state.ledgerFilter), filter: state.ledgerFilter, modal: state.modal?.type || '' })
  };

  Portal.modules = Portal.modules || {};
  Portal.modules.moneyTab = api;
  Portal.MoneyTab = api;

  function applyMoneyRoute(route = rootWindow.Portal?.navigation?.read?.() || {}){
    if (!route.project || route.projectTab !== 'money' || !state.panelRoot || !state.summary) return;
    const view = cleanText(route.moneyView);
    if (view === 'take_payment') {
      if (canManageMoney() && state.modal?.type !== 'take_payment') openModal({ type:'take_payment' });
    } else if (viewForFilter(state.ledgerFilter) !== (view || 'overview') && !(view === 'ledger' && state.ledgerFilter === 'all')) {
      setLedgerFilter(filterForView(view), { route:false });
      const select = rootNode()?.querySelector('[data-money-ledger-filter]');
      if (select) select.value = state.ledgerFilter;
    }
    const receiptId = cleanText(route.receipt);
    if (!receiptId && state.receiptViewer) {
      state.receiptViewer.close?.({ fromRoute:true });
      state.receiptViewer = null;
    } else if (receiptId && cleanText(state.receiptViewer?.receiptId?.()) !== receiptId) {
      openReceiptViewer(receiptId, { fromRoute:true });
    }
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
    regions: ['main'],
    requiresContext: ['project'],
    enabled: moneyEnabled,
    panelHtml,
    mount: (context = {}) => mount(context)
  });
})();
