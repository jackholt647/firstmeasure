/* public/libraries/apps/money/project.js
 * Project modal finance tab. One surface, no sidebar and no sub-tabs: a header like Docs and Photos (the terminology
 * term `money.workspace`, with Take a payment, Upload receipts and Generate invoice, then Reports and Settings), the
 * project's six figures as a row of tiles, and one ledger. The ledger starts with the payment schedule and lists
 * every payment, refund, expense, invoice and receipt, searchable, filtered by type or category, sorted by any
 * column, as a list or as tiles. Anything else (recording a payment or expense, an entry's details, refunds,
 * invoices, reports, a receipt beside its review form, the expense categories and receipt settings) opens as a
 * modal over the tab. Explanations live in tooltips, not on
 * the page.
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
    // Generate invoice's workflow over its draft invoice document (GP-104).
    invoiceFlow: null,
    paymentIntakeHandle: null,
    paymentIntakeConfig: null,
    autopay: null,
    autopayBusy: false,
    autopayError: '',
    receiptViewer: null,
    receiptDrafts: {},
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
  function term(key, fallback = titleText(key)){
    return cleanText(rootWindow.PlatformTerminology?.get?.(`money.${key}`, fallback), fallback);
  }
  // Copy that names the tab itself ("Loading Finance...") takes the `workspace` term as {workspace}, so renaming it
  // in the library or an organization's terminology renames it everywhere (FM-603).
  function workspaceText(key, fallback){
    const workspace = term('workspace');
    const readable = fallback.replace('{workspace}', workspace);
    return cleanText(globalThis.PlatformLanguage?.text?.('money', key, readable, { workspace }), readable);
  }
  function loadingText(){
    return workspaceText('loading_workspace', 'Loading {workspace}...');
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
    // The host paints this before mount: style it now so its loader is the tab's one loading message (GP-9).
    injectCSS();
    return `<div class="mn-app" data-money-root><div class="mn-shell" data-money-shell><div class="mn-state" role="status" aria-live="polite"><i class="fas fa-circle-notch fa-spin"></i><span>${escapeHtml(loadingText())}</span></div></div><div data-money-modal-layer></div></div>`;
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
      .mn-tools .mn-add-menu{display:none}
      .mn-add-list{display:flex;flex-direction:column;gap:2px}
      .mn-add-item{display:grid;grid-template-columns:42px minmax(0,1fr) auto;align-items:center;gap:12px;min-height:62px;padding:8px 10px;border:0;border-radius:12px;background:none;font:inherit;color:#101828;text-align:left;cursor:pointer}
      .mn-add-item:hover:not(:disabled),.mn-add-item:focus-visible{background:#f9fafb}
      .mn-add-item:disabled{opacity:.5;cursor:not-allowed}
      .mn-add-item>i:first-child{width:42px;height:42px;border-radius:11px;display:grid;place-items:center;background:rgba(var(--primary-rgb,217,48,37),.1);color:var(--primary-readable,var(--primary,#d93025));font-size:17px}
      .mn-add-item>span{min-width:0}
      .mn-add-item strong{display:block;font-size:15px;font-weight:700}
      .mn-add-item small{display:block;margin-top:2px;font-size:12px;color:#667085;line-height:1.35}
      .mn-add-item>i:last-child{color:#98a2b3;font-size:12px}
      /* Not set up yet (GP-17): the Operations tab's Setup badge, on Take a payment. */
      .mn-btn.mn-has-setup{position:relative}
      .mn-tools .mn-btn .mn-setup-pill,.mn-setup-pill{display:inline-block;border:1px solid #f2ca72;border-radius:20px;background:#fff0cb;color:#794c00;padding:0 5px;font-size:9px;font-weight:700;line-height:14px;white-space:nowrap;box-shadow:0 1px 2px rgba(16,24,40,.12);cursor:pointer}
      .mn-btn .mn-setup-pill{position:absolute;top:-9px;right:-8px}
      .mn-add-item strong .mn-setup-pill{margin-left:6px;vertical-align:2px}
      /* Phone: the + button's small warning while payments are not set up (GP-40); its menu shows the Setup pill. */
      /* Over the phone rule that hides every label inside a toolbar button (.mn-tools .mn-btn span). */
      .mn-tools .mn-btn .mn-setup-alert{position:absolute;top:-6px;right:-6px;width:20px;height:20px;border-radius:50%;background:#fff;box-shadow:0 1px 3px rgba(16,24,40,.28);display:grid;place-items:center;color:#f79009;font-size:11px;line-height:1;pointer-events:none}
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
      .mn-form .fm-select-list-menu{font-weight:500}
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
      .mn-receipt-strip{display:flex;gap:8px;flex-wrap:wrap}
      .mn-receipt-strip .mn-thumb{width:52px;height:52px;border-radius:10px}
      .mn-lines{display:flex;flex-direction:column;border:1px solid #eaecf0;border-radius:10px;overflow:hidden}
      .mn-lines div{display:flex;justify-content:space-between;gap:10px;padding:8px 10px;font-size:13px;border-bottom:1px solid #f2f4f7}
      .mn-lines div:last-child{border-bottom:0}
      .mn-sub-panel{border:1px solid #eaecf0;border-radius:12px;padding:12px;display:flex;flex-direction:column;gap:10px}
      .mn-sub-panel>strong{font-size:13px}
      .mn-alloc-row{display:grid;grid-template-columns:minmax(0,1fr) 120px;gap:8px;align-items:end}
      .mn-alert{display:flex;align-items:flex-start;gap:8px;border-radius:10px;padding:10px 12px;font-size:12px;font-weight:600;background:#fffaeb;color:#93370d}
      .mn-invoice-setup{flex-wrap:wrap;align-items:center;border:1px solid #f2ca72}.mn-invoice-setup>span{flex:1 1 150px;min-width:0;line-height:1.4}
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
      .mn-sr{position:absolute!important;width:1px;height:1px;margin:-1px;padding:0;overflow:hidden;clip:rect(0 0 0 0);white-space:nowrap;border:0}
      /* Generate invoice (GP-104): the invoice document's own workflow, one step with its live preview beside it, as in Docs. */
      .mn-modal.mn-invoice-modal{width:min(1180px,100%);height:min(860px,100%)}
      .mn-invoice-modal .mn-modal-body{flex:1 1 auto;padding:0;gap:0;overflow:hidden}
      .mn-invoice-setup{flex:none;margin:12px 16px 0}
      .mn-invoice-flow{flex:1 1 auto;min-height:0;display:flex}
      .mn-invoice-flow>.fmdw{flex:1 1 auto}
      .mn-invoice-flow .fmdw-step-head{display:none}
      .mn-invoice-state{flex:1;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:10px;padding:40px 16px;text-align:center;color:#667085;font-size:13px;font-weight:600}
      .mn-invoice-state i{font-size:22px;color:#98a2b3}
      .mn-invoice-state.error i{color:#b42318}
      .mn-invoice-foot-total{display:flex;align-items:baseline;gap:10px;margin-right:auto;font-size:13px;font-weight:700;color:#475467}
      .mn-invoice-foot-total strong{font-size:18px;font-weight:800;color:#101828;font-variant-numeric:tabular-nums}
      .mn-modal.mn-receipt-screen{width:min(1180px,100%);height:min(820px,100%)}
      .mn-receipt-screen .mn-modal-head>div:first-child{flex:1}
      .mn-receipt-nav{display:flex;align-items:center;gap:6px;flex:none}
      .mn-receipt-nav>span{min-width:46px;text-align:center;font-size:12px;font-weight:700;color:#667085;font-variant-numeric:tabular-nums}
      .mn-receipt-badge{display:inline-flex;align-items:center;gap:5px;flex:none;border-radius:999px;padding:4px 9px;font-size:11px;font-weight:800;white-space:nowrap}
      .mn-receipt-badge.done{background:#ecfdf3;color:#067647}
      .mn-receipt-badge.todo{background:#fffaeb;color:#b54708}
      .mn-receipt-screen-body{flex:1;min-height:0;display:grid;grid-template-columns:minmax(0,1.15fr) minmax(340px,.85fr)}
      .mn-receipt-preview{position:relative;min-width:0;min-height:0;background:#101828;display:flex;align-items:center;justify-content:center;overflow:hidden}
      .mn-receipt-preview>img{max-width:100%;max-height:100%;object-fit:contain;display:block}
      .mn-receipt-preview>iframe{width:100%;height:100%;border:0;background:#fff}
      .mn-receipt-file{display:flex;flex-direction:column;align-items:center;gap:10px;padding:20px;text-align:center;color:#d0d5dd;font-size:12px;font-weight:600}
      .mn-receipt-file>i{font-size:48px}
      .mn-receipt-file strong{color:#fff;font-size:13px;overflow-wrap:anywhere}
      .mn-receipt-file a{margin-top:6px;border:1px solid #667085;border-radius:9px;padding:8px 12px;color:#fff;text-decoration:none;font-weight:800}
      .mn-receipt-panel{min-width:0;min-height:0;overflow:auto;padding:16px;display:flex;flex-direction:column;gap:12px;border-left:1px solid #eaecf0}
      .mn-receipt-done{display:flex;align-items:flex-start;gap:10px;border-radius:10px;padding:10px 12px;background:#ecfdf3;color:#067647;font-size:12px;font-weight:700}
      .mn-receipt-done i{font-size:16px;margin-top:1px}
      .mn-receipt-done small{display:block;margin-top:2px;font-weight:600;color:#027a48}
      .mn-receipt-targets{display:flex;flex-direction:column;gap:8px}
      .mn-optional{font-weight:500;color:#98a2b3}
      .mn-setting-row strong{white-space:normal!important}
      .mn-setting-row small{display:block;margin-top:2px;font-size:11px;color:#667085;white-space:normal!important;overflow:visible!important}
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
      @container money (max-width:1100px){.mn-metric{padding:9px 10px}.mn-metric strong{font-size:clamp(14px,1.65cqi,18px)}.mn-tools .mn-btn.collapse span{display:none}.mn-tools .mn-btn.collapse{width:38px;padding:0}}
      @container money (max-width:760px){.mn-metrics{grid-template-columns:repeat(3,minmax(0,1fr))}.mn-metric strong{font-size:17px}}
      @container money (max-width:820px){.mn-table .mn-col-balance{display:none}.mn-table .mn-col-status{width:96px}.mn-table .mn-col-cat{width:120px}.mn-receipt-screen-body{grid-template-columns:1fr;grid-template-rows:minmax(220px,40%) auto;overflow:auto}.mn-receipt-panel{border-left:0;border-top:1px solid #eaecf0;overflow:visible}.mn-receipt-badge span{display:none}}
      @container money (max-width:640px){
        .mn-shell{padding:10px;gap:10px;overflow:auto}
        .mn-ledger{flex:none;min-height:60%;overflow:visible}
        .mn-ledger-body{overflow:visible}
        .mn-title strong{font-size:16px}
        .mn-tools .mn-btn span{display:none}
        .mn-tools .mn-btn{width:38px;padding:0}
        /* Phone: the actions and Reports live in one + menu beside Settings (GP-2). */
        .mn-tools .mn-desk-only{display:none}
        .mn-tools .mn-add-menu{display:inline-flex}
        .mn-tools .mn-btn.icon{width:44px;height:44px;border-radius:12px;font-size:17px}
        .mn-modal.mn-add-modal .mn-modal-body{padding:6px 8px 14px}
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
        .mn-form,.mn-facts{grid-template-columns:1fr}
        /* Phone: every money dialog is a tray rising from the bottom (GP-4); bindTray drags it away. */
        .mn-modal-shade{padding:0;align-items:flex-end;backdrop-filter:none}
        .mn-modal,.mn-modal.wide,.mn-modal.xwide,.mn-modal.mn-invoice-modal{width:100%;max-height:calc(100% - 28px);border-radius:18px 18px 0 0;box-shadow:0 -9px 28px rgba(15,23,42,.3)}
        .mn-modal.mn-tray-in{animation:mn-tray-up .3s cubic-bezier(.2,.8,.2,1)}
        .mn-modal[data-money-tray-drag]{padding-top:10px}
        .mn-modal[data-money-tray-drag]::before{content:"";position:absolute;top:6px;left:50%;width:38px;height:4px;margin-left:-19px;border-radius:2px;background:#d0d5dd;pointer-events:none}
        .mn-modal[data-money-tray-drag]>.mn-modal-head{touch-action:none;padding-top:8px}
        .mn-intake-modal[data-money-tray-drag]{padding-top:24px}
        .mn-modal-foot .mn-btn{height:44px;font-size:13px}
        .mn-modal.mn-invoice-modal{height:calc(100% - 28px)}
        .mn-invoice-modal .mn-modal-foot{padding:10px 16px 14px}
        .mn-invoice-modal .mn-modal-foot .mn-invoice-cancel{display:none}
        .mn-invoice-modal .mn-modal-foot [data-money-invoice-submit]{flex:1 1 150px}
        .mn-invoice-foot-total{width:100%;justify-content:space-between;margin-right:0}
        .mn-invoice-foot-total strong{font-size:20px}
      }
      @keyframes mn-tray-up{from{transform:translateY(100%)}to{transform:none}}
      @media (prefers-reduced-motion:reduce){.mn-modal.mn-tray-in{animation:none}}
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

  // A receipt can be filed under an expense category (`expense_category:<id>`, GP-108) as well as under the
  // project's projected expense lists; the server lists the categories in `category_targets`.
  function categoryTargets(){
    return Array.isArray(expenseData().category_targets) ? expenseData().category_targets : [];
  }

  function targetTitle(target){
    return target?.source_type === 'expense_category' ? categoryLabel(target.category_id) : cleanText(target?.title, term('expense_list'));
  }

  function expenseTargetTitle(key){
    const wanted = cleanText(key);
    const groupTargets = (expenseData().groups || []).flatMap((group) => Array.isArray(group?.targets) ? group.targets : []);
    const target = [...(expenseData().targets || []), ...categoryTargets(), ...groupTargets].find((item) => cleanText(item?.target_key) === wanted);
    return target ? targetTitle(target) : '';
  }

  function receiptCategoryIds(receipt){
    const prefix = 'expense_category:';
    return (receipt?.attributed_target_keys || []).map(cleanText).filter((key) => key.startsWith(prefix)).map((key) => key.slice(prefix.length));
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
      const filedUnder = (receipt.attributed_target_keys || []).map(expenseTargetTitle).filter(Boolean);
      records.push({
        key:`receipt:${cleanText(receipt.id)}`, kind:'receipt', type:'record', id:cleanText(receipt.id), source:receipt,
        at:cleanText(receipt.purchase_date, receipt.effective?.purchase_date, receipt.uploaded_at, receipt.created_at), createdAt:cleanText(receipt.created_at),
        title:receiptTitle(receipt), detail:filedUnder.join(', ') || cleanText(receipt.file?.file_name), categories:receiptCategoryIds(receipt),
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
    if (filter.startsWith('cat:')) return (row.kind === 'expense' && row.category === filter.slice(4)) || (row.kind === 'receipt' && (row.categories || []).includes(filter.slice(4)));
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
    const setupPending = manage && paymentsSetupPending();
    return `
      <div class="mn-toolbar">
        <div class="mn-title"><i class="fas fa-dollar-sign" aria-hidden="true"></i><strong>${escapeHtml(term('workspace'))}</strong></div>
        <div class="mn-tools">
          ${manage ? `
            <button type="button" class="mn-btn primary${setupPending ? ' mn-has-setup' : ''} mn-desk-only" data-money-take-payment ${busyAttr()} aria-label="${escapeHtml(term('take_collected_payment'))}" data-fm-tooltip="${escapeHtml(setupPending ? setUpPaymentsText() : 'Charge a card or bank account now')}"><i class="fas fa-credit-card"></i><span>${escapeHtml(term('take_collected_payment'))}</span>${setupPending ? paymentsSetupPillHtml() : ''}</button>
            <button type="button" class="mn-btn collapse mn-desk-only" data-money-upload-receipt data-money-busy ${uploadBusy ? 'disabled' : ''} aria-label="${escapeHtml(`Upload ${term('receipts').toLowerCase()}`)}" data-fm-tooltip="${escapeHtml('Upload receipts or bills; totals are read for you')}"><i class="fas fa-file-arrow-up"></i><span>${escapeHtml(`Upload ${term('receipts').toLowerCase()}`)}</span></button>
            <input type="file" data-money-receipt-input multiple accept="image/*,.pdf,.doc,.docx,.dot,.odt,.rtf,.pages,.xls,.xlsx,.csv,.tsv,.iif,.ppt,.pptx,.txt,.md,.json,.xml,.html,.htm,.eml,.mht,.tif,.tiff,.avif,.bmp,.heic,.heif" hidden>
            <button type="button" class="mn-btn collapse mn-desk-only" data-money-open-modal="invoice" ${busyAttr()} aria-label="${escapeHtml(term('generate_invoice'))}" data-fm-tooltip="${escapeHtml('Bill scheduled payments or custom items')}"><i class="fas fa-file-invoice-dollar"></i><span>${escapeHtml(term('generate_invoice'))}</span></button>
            <span class="mn-tool-sep mn-desk-only" aria-hidden="true"></span>` : ''}
          <button type="button" class="mn-btn icon mn-desk-only" data-money-open-modal="reports" aria-label="${escapeHtml(term('reports'))}" data-fm-tooltip="${escapeHtml(term('reports'))}"><i class="fas fa-chart-column"></i></button>
          <button type="button" class="mn-btn primary icon mn-add-menu${setupPending ? ' mn-has-setup' : ''}" data-money-open-modal="add_menu" aria-haspopup="dialog" aria-label="${escapeHtml('New')}"${setupPending ? ` data-fm-tooltip="${escapeHtml(setUpPaymentsText())}"` : ''}><i class="fas fa-plus"></i>${setupPending ? paymentsSetupAlertHtml() : ''}</button>
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
    const categoriesInUse = new Set(entries.flatMap((row) => row.kind === 'expense' ? [row.category] : row.kind === 'receipt' ? (row.categories || []) : []));
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
      shell.innerHTML = `<div class="mn-state"><i class="fas fa-circle-notch fa-spin"></i><span>${escapeHtml(loadingText())}</span></div>`;
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
      const key = cleanText(node.dataset.moneyEntry);
      const open = () => key.startsWith('receipt:') ? openReceiptViewer(key.slice(8)) : openModal({ type:'item', key });
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
    return ({ payments:'in', expenses:'out', invoices:'invoices', new_invoice:'invoices', receipts:'receipts', recurring:'recurring' })[cleanText(view)] || 'all';
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
    syncInvoiceButtons();
  }

  function bindShell(root){
    const shell = root.querySelector('[data-money-shell]');
    shell.querySelector('[data-money-take-payment]')?.addEventListener('click', (event) => {
      if (!canManageMoney() || moneyMutationBusy()) return;
      if (event.target.closest?.('[data-money-payments-setup]') && canSetUpPayments()) { startPaymentSetup(); return; }
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
    // Not ready last time: setup may have moved on since, so ask again.
    if (modal.type === 'take_payment' && state.paymentIntakeConfig?.config?.ready !== true) state.paymentIntakeConfig = null;
    state.modal = modal;
    if (modal.type === 'reports' && state.reports === null) void loadReports();
    if (modal.type === 'settings') {
      state.modal.draft = moneyCategories().map((category) => ({ ...category }));
      state.modal.receipts = receiptSettings();
    }
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
    if (state.modal?.type === 'invoice' && rootWindow.Portal?.navigation?.read?.()?.moneyView === 'new_invoice') {
      rootWindow.Portal.navigation.replace?.({ moneyView:viewForFilter(state.ledgerFilter) }, { source:'project-money-new-invoice-close', ownedKeys:['moneyView'] });
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
    const opening = !layer.dataset.modalKey;
    if (!options.force && key && layer.dataset.modalKey === key && FORM_MODALS.has(state.modal?.type) && !state.receiptBatch && !state.receiptReview) {
      syncBusy();
      return;
    }
    // A refresh behind the receipt screen leaves what is being typed alone.
    if (!options.force && key && layer.dataset.modalKey === key && state.receiptReview?.phase === 'ready' && !state.receiptBatch) {
      syncBusy();
      return;
    }
    if (layer.dataset.modalKey === 'take_payment::' && key !== 'take_payment::') {
      state.paymentIntakeHandle?.close?.();
      state.paymentIntakeHandle = null;
    }
    layer.dataset.modalKey = key;
    if (state.invoiceFlow && (state.modal?.type !== 'invoice' || state.receiptBatch || state.receiptReview)) discardInvoiceFlow();
    if (state.receiptBatch) { layer.innerHTML = receiptBatchHtml(); bindModal(layer, opening); return; }
    if (state.receiptReview) { layer.innerHTML = receiptReviewHtml(); bindModal(layer, opening); return; }
    const modal = state.modal;
    if (!modal) { layer.innerHTML = ''; return; }
    const html = {
      take_payment:takePaymentModalHtml,
      add_payment:addPaymentModalHtml,
      add_expense:addExpenseModalHtml,
      invoice:invoiceModalHtml,
      reports:reportsModalHtml,
      add_menu:addMenuModalHtml,
      settings:settingsModalHtml,
      autopay:autopayModalHtml,
      expense_lists:expenseListsModalHtml,
      item:itemModalHtml
    }[modal.type];
    if (!html) { state.modal = null; layer.innerHTML = ''; return; }
    const markup = html(modal);
    if (!markup) { state.modal = null; layer.innerHTML = ''; return; }
    layer.innerHTML = markup;
    bindModal(layer, opening);
  }

  function takePaymentModalHtml(){
    return `<div data-fm-window-backdrop="off" class="mn-modal-shade" data-money-modal-shade><div class="mn-modal mn-intake-modal" role="dialog" aria-modal="true" aria-label="${escapeHtml(term('take_collected_payment'))}"><button type="button" class="mn-btn small icon" data-money-modal-close aria-label="${escapeHtml('Close')}"><i class="fas fa-xmark"></i></button><div data-money-payment-intake></div></div></div>`;
  }

  // The phone's + menu (GP-2): what the toolbar offers on a desktop, as a tray of plain choices that say what
  // each one does. Reports are there for everyone; the rest only for those who manage money. Taking and recording
  // a payment are two choices (GP-129): Take a Payment goes straight into payment setup while that is pending.
  function addMenuModalHtml(){
    const manage = canManageMoney();
    const busy = moneyMutationBusy();
    const item = (action, icon, label, hint, disabled = false, pill = '') => `<button type="button" class="mn-add-item" data-money-add-action="${action}" ${disabled ? 'disabled' : ''}><i class="fas ${icon}" aria-hidden="true"></i><span><strong>${escapeHtml(label)}${pill}</strong><small>${escapeHtml(hint)}</small></span><i class="fas fa-chevron-right" aria-hidden="true"></i></button>`;
    const setupPending = manage && paymentsSetupPending();
    const body = `<div class="mn-add-list">
      ${manage ? item('take_payment', 'fa-credit-card', term('take_collected_payment'), setupPending ? setUpPaymentsText() : 'Charge a card or bank account now', busy, setupPending ? paymentsSetupPillHtml() : '') : ''}
      ${manage ? item('add_payment', 'fa-money-bill-wave', 'Record a Payment', 'Cash, a check or a payment taken elsewhere', busy) : ''}
      ${manage ? item('upload_receipts', 'fa-file-arrow-up', `Upload ${term('receipts').toLowerCase()}`, 'Receipts and bills; totals are read for you', busy || state.receiptUploadInFlight) : ''}
      ${manage ? item('invoice', 'fa-file-invoice-dollar', term('generate_invoice'), 'Bill scheduled payments or custom items', busy) : ''}
      ${item('reports', 'fa-chart-column', 'Generate report', manage ? 'From a template, or open a past one' : 'Open reports made for this project')}
    </div>`;
    return modalFrame({ title:term('workspace'), icon:'fa-plus', body, size:'mn-add-modal' });
  }

  function runAddAction(action){
    closeModal();
    if (action === 'upload_receipts') {
      if (canManageMoney() && !moneyMutationBusy() && !state.receiptUploadInFlight) rootNode()?.querySelector('[data-money-receipt-input]')?.click();
      return;
    }
    if (action === 'take_payment' && paymentsSetupPending() && canSetUpPayments()) {
      if (canManageMoney() && !moneyMutationBusy()) startPaymentSetup();
      return;
    }
    if (action === 'reports' || !moneyMutationBusy()) openModal({ type:action });
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

  // Generate invoice (GP-104) is the invoice document's own workflow (wfl_invoice over tpl_invoice_default): the same
  // single step, questions and live preview as an invoice made in Docs, over a draft the server resolves but never
  // saves (payments' invoices/draft). Generating makes this tab's invoice from what the draft says.
  function invoiceModalHtml(){
    const ready = state.invoiceFlow?.status === 'ready' && !moneyMutationBusy();
    const setup = paymentsSetupPending() && canSetUpPayments()
      ? `<div class="mn-alert mn-invoice-setup"><i class="fas fa-credit-card" aria-hidden="true"></i><span>${(globalThis.PlatformLanguage?.htmlText("money","m_67f39fd217c909","Customers can't pay this invoice online until payments are set up.") ?? "Customers can't pay this invoice online until payments are set up.")}</span><button type="button" class="mn-btn small primary" data-money-invoice-setup>${escapeHtml(setUpPaymentsText())}</button></div>`
      : '';
    const body = `${setup}<div class="mn-invoice-flow" data-money-invoice-flow></div>`;
    const foot = `<div class="mn-invoice-foot-total"><span>${escapeHtml(term('invoice_total'))}</span><strong data-money-invoice-foot-total>${money(state.invoiceFlow?.totalCents || 0)}</strong></div><button type="button" class="mn-btn mn-invoice-cancel" data-money-modal-close>${(globalThis.PlatformLanguage?.htmlText("money","m_cbef679b21abb4","Cancel") ?? "Cancel")}</button><button type="button" class="mn-btn" data-money-invoice-submit data-money-invoice-download ${ready ? '' : 'disabled'}><i class="fas fa-download"></i>${(globalThis.PlatformLanguage?.htmlText("money","m_92e593a70bd06d","Generate & Download") ?? "Generate & Download")}</button><button type="button" class="mn-btn primary" data-money-invoice-submit data-money-invoice-email-review ${ready ? '' : 'disabled'}><i class="fas fa-paper-plane"></i>${(globalThis.PlatformLanguage?.htmlText("money","m_61ede0befce19b","Generate an Email") ?? "Generate an Email")}</button>`;
    return modalFrame({ title:term('generate_invoice'), icon:'fa-file-invoice-dollar', body, foot, size:'mn-invoice-modal' });
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
      <div class="mn-list" data-money-category-list>${rows}</div>
      <div class="mn-section-label"><span>${escapeHtml(term('receipts'))}</span></div>
      <div class="mn-list" data-money-receipt-settings>${receiptSettingRows(modal.receipts || receiptSettings())}</div>`;
    const foot = `<button type="button" class="mn-btn" data-money-modal-close>${(globalThis.PlatformLanguage?.htmlText("money","m_cbef679b21abb4","Cancel") ?? "Cancel")}</button><button type="button" class="mn-btn primary" data-money-settings-save ${busyAttr()}><i class="fas fa-check"></i>${(globalThis.PlatformLanguage?.htmlText("money","m_5bab3e72de1ebf","Save") ?? "Save")}</button>`;
    return modalFrame({ title:(globalThis.PlatformLanguage?.text("money","m_7d461dc7d355cc","Settings") ?? "Settings"), icon:'fa-gear', body, foot });
  }

  // GP-109: what a receipt needs before it can be applied, and whether expense lists are suggested for it. The
  // server enforces the same settings (payments/receipts.ts).
  function receiptSettingRows(settings){
    const row = (key, title, detail) => `<div class="mn-list-row mn-setting-row"><div><strong>${escapeHtml(title)}</strong><small>${escapeHtml(detail)}</small></div><label class="mn-switch"><input type="checkbox" data-money-receipt-setting="${key}" ${settings[key] ? 'checked' : ''} aria-label="${escapeHtml(title)}"><span aria-hidden="true"></span></label></div>`;
    return [
      row('require_date', (globalThis.PlatformLanguage?.text("money","m_fc748c1dcbd91e","Require a purchase date") ?? "Require a purchase date"), (globalThis.PlatformLanguage?.text("money","m_33199629259384","A receipt without a purchase date cannot be applied.") ?? "A receipt without a purchase date cannot be applied.")),
      row('require_time', (globalThis.PlatformLanguage?.text("money","m_f28c8b20aa8156","Require a purchase time") ?? "Require a purchase time"), (globalThis.PlatformLanguage?.text("money","m_98318e06320f96","A receipt without a purchase time cannot be applied.") ?? "A receipt without a purchase time cannot be applied.")),
      row('auto_categorize', (globalThis.PlatformLanguage?.text("money","m_45d6040e90a537","Suggest expense lists automatically") ?? "Suggest expense lists automatically"), (globalThis.PlatformLanguage?.text("money","m_a524ed5f8b6e79","New receipts come with their expense lists picked from the total. Off: you choose every list yourself.") ?? "New receipts come with their expense lists picked from the total. Off: you choose every list yourself."))
    ].join('');
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
    const targetOrder = new Map([...(Array.isArray(expenses.targets) ? expenses.targets : []), ...categoryTargets()].map((target, index) => [cleanText(target?.target_key), index]));
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
    return `<div class="mn-list-row" style="--dot:${escapeHtml(target?.color || '#98a2b3')}"><span class="mn-dot" aria-hidden="true"></span><div><strong>${escapeHtml(targetTitle(target))}</strong><small>${target?.source_type === 'expense_category' ? (globalThis.PlatformLanguage?.htmlText("money","m_c478c1907a4d4f","Category") ?? "Category") : escapeHtml(titleText(target?.resource_type || 'other'))}${group?.grouped ? ` · ${escapeHtml(group.title || '')}` : ''}</small></div><span class="mn-amount" data-fm-tooltip="${escapeHtml(tip)}">${escapeHtml(money(shown))}</span>${canSetActual ? `<button type="button" class="mn-btn small icon" data-money-set-actual="${escapeHtml(target?.target_key)}" data-current-actual="${manualActual == null ? '' : escapeHtml(manualActual)}" data-projected="${escapeHtml(target?.projected_cents || 0)}" data-actual-revision="${escapeHtml(actualRevision || '')}" ${busyAttr()} aria-label="${escapeHtml(manualActual == null ? 'Set actual' : 'Edit actual')}" data-fm-tooltip="${escapeHtml(manualActual == null ? 'Set actual' : 'Edit actual')}"><i class="fas fa-pen"></i></button>` : '<span class="mn-btn small icon" aria-hidden="true" style="visibility:hidden"></span>'}</div>`;
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
      const targetNames = (source.expense_target_keys || []).map(expenseTargetTitle).filter(Boolean);
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
    }
    const notes = cleanText(source.notes) ? `<p class="mn-note">${escapeHtml(source.notes)}</p>` : '';
    const body = `${hero}<div class="mn-facts">${facts.filter(Boolean).join('')}</div>${notes}${extra}`;
    return modalFrame({ title:row.title, icon:row.icon, body, foot, size:row.kind === 'invoice' ? 'wide' : '' });
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
    const draft = state.receiptDrafts[cleanText(receipt.id)] || null;
    const settings = receiptSettings();
    const done = receiptApplied(receipt);
    const attributed = Array.isArray(receipt.attributed_target_keys) ? receipt.attributed_target_keys : [];
    const selected = new Set(draft ? draft.target_keys : attributed.length ? attributed : settings.auto_categorize ? (receipt.suggested_target_keys || []) : []);
    const targets = [
      ...(expenseData().targets || []).filter((target) => target?.receipt_attribution_enabled !== false),
      ...categoryTargets().filter((target) => !target?.hidden || selected.has(target.target_key))
    ];
    const lines = Array.isArray(receipt.extraction?.line_items) ? receipt.extraction.line_items : [];
    const warnings = done ? [] : (Array.isArray(receipt.extraction?.warnings) ? receipt.extraction.warnings : []);
    const manage = canManageMoney();
    const reviewDisabled = !manage || moneyMutationBusy() ? 'disabled' : '';
    const value = (key, fallback) => escapeHtml(draft ? cleanText(draft[key]) : cleanText(fallback));
    const reimburseId = draft ? cleanText(draft.reimburse_user) : cleanText(receipt.reimbursement?.payee_ref?.id);
    const order = Array.isArray(review.order) ? review.order : [];
    const position = order.indexOf(cleanText(receipt.id));
    const left = receipts().filter((item) => order.includes(cleanText(item.id)) && !receiptApplied(item)).length;
    const appliedTo = attributed.map(expenseTargetTitle).filter(Boolean);
    const optional = (required) => required ? '' : ` <span class="mn-optional">${(globalThis.PlatformLanguage?.htmlText("money","m_82710819dd8da8","(optional)") ?? "(optional)")}</span>`;
    const originalUrl = rootWindow.PaymentsAPI?.receipts?.fileUrl?.(orgId(), receipt.id) || receipt.file_url || '';
    const nav = order.length > 1 ? `<button type="button" class="mn-btn small icon" data-money-receipt-move="-1" aria-label="${escapeHtml((globalThis.PlatformLanguage?.text("money","m_77c08e212dd0d0","Previous receipt") ?? "Previous receipt"))}" data-fm-tooltip="${escapeHtml((globalThis.PlatformLanguage?.text("money","m_277dbeb30b6e26","Previous (←)") ?? "Previous (←)"))}"><i class="fas fa-chevron-left"></i></button><span data-fm-tooltip="${escapeHtml(left ? ((v0) => globalThis.PlatformLanguage?.text("money","m_c2c8ded82609ff",`${v0} still to apply`,{v0}) ?? `${v0} still to apply`)(left) : (globalThis.PlatformLanguage?.text("money","m_052261419f39c5","All applied") ?? "All applied"))}">${position + 1} / ${order.length}</span><button type="button" class="mn-btn small icon" data-money-receipt-move="1" aria-label="${escapeHtml((globalThis.PlatformLanguage?.text("money","m_b4f6c3430f3ec3","Next receipt") ?? "Next receipt"))}" data-fm-tooltip="${escapeHtml((globalThis.PlatformLanguage?.text("money","m_f9183b5949f35f","Next (→)") ?? "Next (→)"))}"><i class="fas fa-chevron-right"></i></button>` : '';
    const badge = done
      ? `<span class="mn-receipt-badge done" data-money-receipt-state="applied"><i class="fas fa-circle-check"></i><span>${(globalThis.PlatformLanguage?.htmlText("money","m_8ff232d529b55f","Applied") ?? "Applied")}</span></span>`
      : `<span class="mn-receipt-badge todo" data-money-receipt-state="open"><i class="fas fa-circle-exclamation"></i><span>${(globalThis.PlatformLanguage?.htmlText("money","m_e56705d557914c","Not applied") ?? "Not applied")}</span></span>`;
    return `<div data-fm-window-backdrop="off" class="mn-modal-shade" data-money-modal-shade><form class="mn-modal mn-receipt-screen" data-money-receipt-apply data-receipt-id="${escapeHtml(receipt.id)}" role="dialog" aria-modal="true" aria-label="${escapeHtml(receiptTitle(receipt))}" novalidate>
      <div class="mn-modal-head"><div><span class="mn-thumb" aria-hidden="true"><i class="fas fa-receipt"></i></span><strong>${escapeHtml(receiptTitle(receipt))}</strong>${badge}</div><div class="mn-receipt-nav">${nav}<button type="button" class="mn-btn small icon" data-money-receipt-close aria-label="${(globalThis.PlatformLanguage?.htmlText("money","m_3742924668fb10","Close") ?? "Close")}" ${state.saving ? 'disabled' : ''}><i class="fas fa-xmark"></i></button></div></div>
      <div class="mn-receipt-screen-body"><div class="mn-receipt-preview" data-money-receipt-preview>${receiptPreviewHtml(receipt)}</div><div class="mn-receipt-panel">
        ${done ? `<div class="mn-receipt-done"><i class="fas fa-circle-check"></i><div>${escapeHtml(appliedTo.length ? ((v0) => globalThis.PlatformLanguage?.text("money","m_515c966dfe8109",`Applied to ${v0}`,{v0}) ?? `Applied to ${v0}`)(appliedTo.join(', ')) : (globalThis.PlatformLanguage?.text("money","m_8ff232d529b55f","Applied") ?? "Applied"))}<small>${escapeHtml(receipt.applied_at ? `${dateTime(receipt.applied_at)} · ` : '')}${escapeHtml((globalThis.PlatformLanguage?.text("money","m_3c338fa271d5a5","Change anything below and save.") ?? "Change anything below and save."))}</small></div></div>` : ''}
        ${receipt.duplicate_of_receipt_id && !done ? `<label class="mn-alert"><input type="checkbox" name="confirm_duplicate" value="yes" ${draft?.confirm_duplicate ? 'checked' : ''} ${reviewDisabled}>${(globalThis.PlatformLanguage?.htmlText("money","m_4ff2334846d39b","This file matches an existing receipt. Confirm it is a separate expense before applying.") ?? "This file matches an existing receipt. Confirm it is a separate expense before applying.")}</label>` : ''}
        ${warnings.length ? `<div class="mn-alert">${escapeHtml(warnings.join(' '))}</div>` : ''}
        <div class="mn-form">
          <label class="wide"><span>${(globalThis.PlatformLanguage?.htmlText("money","m_9403c7637d4905","Total") ?? "Total")}</span><input class="mn-input" name="total" type="number" min="0" step="0.01" inputmode="decimal" value="${draft ? value('total') : escapeHtml(receipt.total_cents ? (receipt.total_cents / 100).toFixed(2) : '')}" required ${reviewDisabled}></label>
          <label><span>${(globalThis.PlatformLanguage?.htmlText("money","m_f3cb225c1c3e0a","Purchase Date") ?? "Purchase Date")}${optional(settings.require_date)}</span><input class="mn-input" name="purchase_date" type="date" data-picker-near value="${value('purchase_date', receipt.purchase_date)}" ${settings.require_date ? 'required' : ''} ${reviewDisabled}></label>
          <label><span>${(globalThis.PlatformLanguage?.htmlText("money","m_2d11bf79588d5e","Purchase Time") ?? "Purchase Time")}${optional(settings.require_time)}</span><input class="mn-input" name="purchase_time" type="time" step="60" data-picker-near value="${value('purchase_time', cleanText(receipt.purchase_time).slice(0, 5))}" ${settings.require_time ? 'required' : ''} ${reviewDisabled}></label>
          <label class="wide"><span>${(globalThis.PlatformLanguage?.htmlText("money","m_8b8d7106c3c872","Reimburse to ") ?? "Reimburse to ")}<i class="fas fa-circle-info mn-help" tabindex="0" data-fm-tooltip="Optional: someone who paid out of pocket. A reimbursement is added to the ledger."></i></span>
            <select class="mn-select" name="reimburse_user" data-money-reimburse-select ${reviewDisabled}>
              <option value="">${(globalThis.PlatformLanguage?.htmlText("money","m_79d4145b0d2889","No reimbursement") ?? "No reimbursement")}</option>
              ${(state.orgUsers || []).map((user) => `<option value="${escapeHtml(user.id)}" ${reimburseId === user.id ? 'selected' : ''}>${escapeHtml(user.name)}</option>`).join('')}
              <option value="__other__" ${reimburseId === '__other__' ? 'selected' : ''}>${(globalThis.PlatformLanguage?.htmlText("money","m_b0d2b8a6eddf50","Other person…") ?? "Other person…")}</option>
            </select></label>
          <label class="wide" data-money-reimburse-other ${reimburseId === '__other__' ? '' : 'hidden'}><span>${(globalThis.PlatformLanguage?.htmlText("money","m_5875991c412359","Person to pay back") ?? "Person to pay back")}</span><input class="mn-input" name="reimburse_other_name" type="text" value="${value('reimburse_other_name', '')}" placeholder="${(globalThis.PlatformLanguage?.htmlText("money","m_8cf345002184e5","Name") ?? "Name")}" ${reviewDisabled}></label>
        </div>
        ${lines.length ? `<details class="mn-receipt-lines"><summary>${((v0,v1) => globalThis.PlatformLanguage?.htmlText("money","m_c2957dd4e77e96",`${v0} extracted line item${v1}`,{v0,v1}) ?? `${v0} extracted line item${v1}`)(lines.length,lines.length === 1 ? '' : 's')}</summary>${lines.slice(0, 30).map((line) => `<div><span>${escapeHtml(line.description || 'Line item')}</span><strong>${money(line.total_cents || 0)}</strong></div>`).join('')}</details>` : ''}
        <div class="mn-receipt-targets"><div class="mn-section-label"><span>${((v17) => globalThis.PlatformLanguage?.htmlText("money","m_3c334ae999e449",`Apply to ${v17} `,{v17}) ?? `Apply to ${v17} `)(escapeHtml(term('expense_lists').toLowerCase()))}<i class="fas fa-circle-info mn-help" tabindex="0" data-fm-tooltip="${escapeHtml(settings.auto_categorize ? (globalThis.PlatformLanguage?.text("money","m_2fc0291fcdab0c","Suggested from the total. Select every list this document covers.") ?? "Suggested from the total. Select every list this document covers.") : (globalThis.PlatformLanguage?.text("money","m_ea60a46b85d56e","Select every list this document covers.") ?? "Select every list this document covers."))}"></i></span></div>
        ${targets.map((target) => { const category = target.source_type === 'expense_category'; return `<label class="mn-receipt-target-choice"${category ? ' data-money-receipt-category' : ''}><input type="checkbox" name="target_key" value="${escapeHtml(target.target_key)}" ${selected.has(target.target_key) ? 'checked' : ''} ${reviewDisabled}><span><strong>${escapeHtml(targetTitle(target))}</strong><span>${category ? (globalThis.PlatformLanguage?.htmlText("money","m_c478c1907a4d4f","Category") ?? "Category") : escapeHtml(titleText(target.resource_type || 'other'))}</span></span>${category ? '' : `<strong>${money(target.projected_cents || 0)}</strong>`}</label>`; }).join('') || `<div class="mn-empty">${((v0) => globalThis.PlatformLanguage?.htmlText("money","m_2076b6166d76ad",`No ${v0} yet.`,{v0}) ?? `No ${v0} yet.`)(escapeHtml(term('expense_lists').toLowerCase()))}</div>`}
        </div>
      </div></div>
      <div class="mn-modal-foot">${manage ? `<button type="button" class="mn-btn danger" data-money-void-receipt="${escapeHtml(receipt.id)}" ${busyAttr()}><i class="fas fa-ban"></i>${(globalThis.PlatformLanguage?.htmlText("money","m_ce16922c5208b8","Void") ?? "Void")}</button>` : ''}<a class="mn-btn mn-spacer" href="${escapeHtml(originalUrl || '#')}" target="_blank" rel="noopener"><i class="fas fa-download"></i>${(globalThis.PlatformLanguage?.htmlText("money","m_7211fc5d40302a","Original") ?? "Original")}</a>${manage ? `<button type="submit" class="mn-btn primary" data-money-receipt-submit ${moneyMutationBusy() || !targets.length ? 'disabled' : ''}><i class="fas fa-check"></i>${done ? escapeHtml((globalThis.PlatformLanguage?.text("money","m_1d368860f0287e","Save changes") ?? "Save changes")) : (globalThis.PlatformLanguage?.htmlText("money","m_f1a988cdd500c6","Apply Receipt") ?? "Apply Receipt")}</button>` : ''}</div>
    </form></div>`;
  }

  // The file beside the form: an image as is, a PDF in a frame once fetched (the receipt file route answers with
  // a download), anything else as an icon with the original to open.
  function receiptPreviewHtml(receipt){
    const type = receiptContentType(receipt);
    const name = cleanText(receipt?.file?.file_name);
    const inline = cleanText(rootWindow.PaymentsAPI?.receipts?.fileUrl?.(orgId(), receipt.id, { inline:true }));
    if (type.startsWith('image/') && inline) return `<img src="${escapeHtml(inline)}" alt="${escapeHtml(receiptTitle(receipt))}">`;
    if ((type.includes('pdf') || name.toLowerCase().endsWith('.pdf')) && inline) return `<div class="mn-receipt-file" data-money-receipt-pdf="${escapeHtml(inline)}"><i class="fas fa-circle-notch fa-spin"></i><span>${(globalThis.PlatformLanguage?.htmlText("money","m_1d41c6e4a787b2","Loading PDF…") ?? "Loading PDF…")}</span></div>`;
    return `<div class="mn-receipt-file"><i class="fas fa-file-lines"></i><strong>${escapeHtml(name || receiptTitle(receipt))}</strong><span>${(globalThis.PlatformLanguage?.htmlText("money","m_86f098a8f511a9","No preview for this file type.") ?? "No preview for this file type.")}</span>${inline ? `<a href="${escapeHtml(inline)}" target="_blank" rel="noopener">Open file</a>` : ''}</div>`;
  }

  let receiptPdfUrl = '';
  function releaseReceiptPdf(){
    if (receiptPdfUrl) URL.revokeObjectURL(receiptPdfUrl);
    receiptPdfUrl = '';
  }
  async function loadReceiptPdf(layer){
    releaseReceiptPdf();
    const holder = layer.querySelector('[data-money-receipt-pdf]');
    if (!holder) return;
    const url = cleanText(holder.dataset.moneyReceiptPdf);
    try {
      const response = await fetch(url, { credentials:'include' });
      if (!response.ok) throw new Error(String(response.status));
      const blob = await response.blob();
      if (!holder.isConnected) return;
      receiptPdfUrl = URL.createObjectURL(blob.type === 'application/pdf' ? blob : new Blob([blob], { type:'application/pdf' }));
      const frame = document.createElement('iframe');
      frame.src = receiptPdfUrl;
      frame.title = (globalThis.PlatformLanguage?.text("money","m_8387f77c976f30","Receipt PDF") ?? "Receipt PDF");
      holder.replaceWith(frame);
    } catch (_) {
      if (holder.isConnected) holder.innerHTML = `<i class="fas fa-file-pdf"></i><strong>${(globalThis.PlatformLanguage?.htmlText("money","m_fd2d77217bda32","PDF preview could not be loaded.") ?? "PDF preview could not be loaded.")}</strong><a href="${escapeHtml(url)}" target="_blank" rel="noopener">${(globalThis.PlatformLanguage?.htmlText("money","m_4ba7f2cffb9394","Open file") ?? "Open file")}</a>`;
    }
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

  /**
   * Money dialogs on a phone (the tab no wider than 640 px) are trays rising from the bottom (GP-4), like the
   * platform's phone sheets: tapping the page above one or dragging its top down puts it away, and its close
   * buttons slide it down. Elsewhere they open and close in place. dismissible() says whether a tap outside or a
   * drag may close it; dismiss() is for its own close buttons and always closes.
   */
  function bindTray(shade, close, options = {}){
    const sheet = shade?.querySelector('.mn-modal');
    if (!sheet) return { dismiss:close };
    const dismissible = options.dismissible || (() => true);
    const tray = () => (rootNode()?.clientWidth || innerWidth) <= 640;
    const still = () => !!window.matchMedia?.('(prefers-reduced-motion: reduce)').matches || typeof sheet.animate !== 'function';
    if (options.opening) sheet.classList.add('mn-tray-in');
    sheet.toggleAttribute('data-money-tray-drag', dismissible());
    let leaving = false;
    function dismiss(){
      if (leaving) return;
      if (!tray() || still()) { close(); return; }
      leaving = true;
      const from = getComputedStyle(sheet).transform;
      sheet.animate([{ transform:from === 'none' ? 'translateY(0)' : from }, { transform:'translateY(100%)' }], { duration:220, easing:'cubic-bezier(.4,0,1,1)', fill:'forwards' });
      shade.animate([{ opacity:1 }, { opacity:0 }], { duration:220, fill:'forwards' }).onfinish = () => close();
    }
    shade.addEventListener('mousedown', (event) => {
      if (event.target === shade && dismissible()) dismiss();
    });
    sheet.addEventListener('pointerdown', (event) => {
      if (leaving || !tray() || !dismissible() || (event.button || 0) !== 0) return;
      if (event.target.closest('button,input,a,select,textarea,label,[tabindex]')) return;
      if (event.clientY - sheet.getBoundingClientRect().top > 72) return;
      const startY = event.clientY;
      let dy = 0, lastY = startY, lastAt = event.timeStamp, speed = 0;
      try { sheet.setPointerCapture(event.pointerId); } catch (e) {}
      const move = (next) => {
        dy = Math.max(0, next.clientY - startY);
        speed = (next.clientY - lastY) / Math.max(1, next.timeStamp - lastAt);
        lastY = next.clientY;
        lastAt = next.timeStamp;
        sheet.style.transform = dy ? `translateY(${dy}px)` : '';
        shade.style.backgroundColor = `rgba(16,24,40,${(.42 * Math.max(0, 1 - dy / Math.max(1, sheet.offsetHeight))).toFixed(3)})`;
      };
      const end = (next) => {
        sheet.removeEventListener('pointermove', move);
        sheet.removeEventListener('pointerup', end);
        sheet.removeEventListener('pointercancel', end);
        if (next.type === 'pointerup' && (dy > Math.min(140, sheet.offsetHeight * .25) || (speed > .5 && dy > 24))) { dismiss(); return; }
        shade.style.removeProperty('background-color');
        sheet.style.removeProperty('transform');
        if (dy && !still()) sheet.animate([{ transform:`translateY(${dy}px)` }, { transform:'none' }], { duration:200, easing:'cubic-bezier(.2,.8,.2,1)' });
      };
      sheet.addEventListener('pointermove', move);
      sheet.addEventListener('pointerup', end);
      sheet.addEventListener('pointercancel', end);
    });
    return { dismiss };
  }

  function bindModal(layer, opening = false){
    const manage = canManageMoney();
    const tray = bindTray(layer.querySelector('[data-money-modal-shade]'), closeModal, {
      opening,
      dismissible:() => !state.receiptBatch && !state.receiptReview && !(state.modal?.type === 'take_payment' && moneyMutationBusy())
    });
    layer.querySelectorAll('[data-money-modal-close]').forEach((button) => button.addEventListener('click', () => {
      if (button.hasAttribute('data-money-autopay-cancel')) state.autopayError = '';
      tray.dismiss();
    }));
    layer.querySelectorAll('[data-money-add-action]').forEach((button) => button.addEventListener('click', () => runAddAction(cleanText(button.dataset.moneyAddAction))));
    layer.querySelector('[data-money-invoice-setup]')?.addEventListener('click', () => { if (canSetUpPayments() && !moneyMutationBusy()) startPaymentSetup(); });
    layer.querySelectorAll('[data-money-item-action]').forEach((button) => button.addEventListener('click', () => {
      if (!state.modal) return;
      state.modal = { ...state.modal, action:cleanText(button.dataset.moneyItemAction) };
      renderModal({ force:true });
    }));
    layer.querySelectorAll('[data-money-open-receipt]').forEach((button) => button.addEventListener('click', () => openReceiptViewer(button.dataset.moneyOpenReceipt)));
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
    layer.querySelectorAll('[data-money-receipt-close]').forEach((button) => button.addEventListener('click', () => closeReceiptReview()));
    layer.querySelectorAll('[data-money-receipt-move]').forEach((button) => button.addEventListener('click', () => {
      moveReceipt(Number(button.dataset.moneyReceiptMove), `[data-money-receipt-move="${button.dataset.moneyReceiptMove}"]`);
    }));
    const receiptForm = layer.querySelector('[data-money-receipt-apply]');
    if (receiptForm) {
      const markDirty = () => { receiptForm.dataset.dirty = '1'; };
      receiptForm.addEventListener('input', markDirty);
      receiptForm.addEventListener('change', markDirty);
      if (state.receiptDrafts[cleanText(receiptForm.dataset.receiptId)]) markDirty();
      void loadReceiptPdf(layer);
    }
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
    if (layer.querySelector('[data-money-invoice-flow]')) {
      attachInvoiceFlow(layer);
      layer.querySelector('[data-money-invoice-download]')?.addEventListener('click', () => { void generateInvoice(); });
      layer.querySelector('[data-money-invoice-email-review]')?.addEventListener('click', () => {
        if (state.invoiceFlow?.handle?.validate?.()) openInvoiceEmailModal(layer, { invoiceFlow:true });
      });
    }
    layer.querySelector('[data-money-receipt-apply]')?.addEventListener('submit', submitReceiptApply);
    const reimburseSelect = layer.querySelector('[data-money-reimburse-select]');
    if (reimburseSelect) {
      if (state.orgUsers === null) void loadOrgUsers();
      reimburseSelect.addEventListener('change', () => {
        const other = layer.querySelector('[data-money-reimburse-other]');
        if (other) other.hidden = reimburseSelect.value !== '__other__';
      });
      enhanceReimburseSelect(reimburseSelect);
    }
    bindSettingsModal(layer);
    bindAutopayModal(layer);
    mountPaymentIntake(layer);
  }

  function bindSettingsModal(layer){
    const list = layer.querySelector('[data-money-category-list]');
    if (!list || state.modal?.type !== 'settings') return;
    layer.querySelectorAll('[data-money-receipt-setting]').forEach((input) => input.addEventListener('change', () => {
      state.modal.receipts = { ...(state.modal.receipts || receiptSettings()), [input.dataset.moneyReceiptSetting]:input.checked };
    }));
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
      void saveMoneySettings(state.modal.draft, state.modal.receipts);
    });
  }

  function categoryId(label, taken){
    const base = `custom_${cleanText(label).toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 40) || 'category'}`;
    let id = base;
    for (let index = 2; taken.has(id); index += 1) id = `${base}_${index}`;
    taken.add(id);
    return id;
  }

  async function saveMoneySettings(draft, receiptDraft = receiptSettings()){
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
      const next = { ...(state.moneySettings || {}), expense_categories:categories, receipts:receiptSettings({ receipts:receiptDraft }) };
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
    if (receipt?.id) openReceiptViewer(receipt.id, { receipt });
  }

  // GP-109: a receipt opens as one screen, the file beside its review form, from the ledger, an expense's receipts
  // or an upload batch; whether it is applied shows at a glance. ← / → (or the head's arrows) step through the
  // ledger's receipts as listed, keeping unsaved edits per receipt. The open receipt is the route's `receipt`.
  function receiptSettings(settings = state.moneySettings){
    const value = settings?.receipts && typeof settings.receipts === 'object' ? settings.receipts : {};
    return { require_date:value.require_date === true, require_time:value.require_time === true, auto_categorize:value.auto_categorize !== false };
  }

  function receiptApplied(receipt){
    return cleanText(receipt?.status).toLowerCase() === 'applied';
  }

  function receiptSequence(receiptId){
    const listed = visibleLedgerRows().filter((row) => row.kind === 'receipt').map((row) => cleanText(row.id));
    const order = listed.includes(receiptId) ? listed : ledgerEntries().filter((row) => row.kind === 'receipt').sort((left, right) => (Date.parse(right.at) || 0) - (Date.parse(left.at) || 0)).map((row) => cleanText(row.id));
    return order.includes(receiptId) ? order : [receiptId, ...order];
  }

  function routeReceipt(id, history){
    rootWindow.Portal?.navigation?.[history]?.({ receipt:id || null }, { source:`money-receipt-${history}`, ownedKeys:['receipt'] });
  }

  function openReceiptViewer(receiptId, options = {}){
    const id = cleanText(receiptId);
    const receipt = options.receipt || receipts().find((item) => cleanText(item.id) === id);
    if (!receipt) return false;
    state.receiptOperationSequence += 1;
    state.receiptBatch = null;
    state.receiptReview = { phase:'ready', receipt, order:receiptSequence(id) };
    state.receiptViewer = { receiptId:() => cleanText(state.receiptReview?.receipt?.id), close:closeReceiptReview };
    renderModal({ force:true });
    // The screen is open before the route names it, so the route handler sees it and does not open another.
    if (!options.fromRoute) routeReceipt(id, 'push');
    return true;
  }

  function closeReceiptReview({ fromRoute = false, force = false } = {}){
    if (state.saving && !fromRoute && !force) return;
    state.receiptOperationSequence += 1;
    state.receiptReview = null;
    state.receiptViewer = null;
    state.receiptDrafts = {};
    releaseReceiptPdf();
    renderModal({ force:true });
    if (!fromRoute && cleanText(rootWindow.Portal?.navigation?.read?.()?.receipt)) {
      rootWindow.Portal.navigation.backOrClose?.(['receipt'], { receipt:null }, { source:'money-receipt-close' });
    }
  }

  function keepReceiptDraft(){
    const form = rootNode()?.querySelector('[data-money-receipt-apply]');
    const id = cleanText(form?.dataset.receiptId);
    if (!form || !id || !form.dataset.dirty) return;
    const data = new FormData(form);
    state.receiptDrafts[id] = {
      total:cleanText(data.get('total')),
      purchase_date:cleanText(data.get('purchase_date')),
      purchase_time:cleanText(data.get('purchase_time')),
      reimburse_user:cleanText(data.get('reimburse_user')),
      reimburse_other_name:cleanText(data.get('reimburse_other_name')),
      confirm_duplicate:data.get('confirm_duplicate') === 'yes',
      target_keys:data.getAll('target_key').map(cleanText).filter(Boolean)
    };
  }

  function moveReceipt(delta, focusSelector = ''){
    const review = state.receiptReview;
    if (review?.phase !== 'ready' || state.saving) return;
    const order = review.order || [];
    const from = order.indexOf(cleanText(review.receipt?.id));
    if (order.length < 2 || from < 0) return;
    keepReceiptDraft();
    for (let step = 1; step < order.length; step += 1) {
      const id = order[(((from + delta * step) % order.length) + order.length) % order.length];
      const receipt = receipts().find((item) => cleanText(item.id) === id);
      if (!receipt) continue;
      state.receiptOperationSequence += 1;
      state.receiptReview = { ...review, receipt };
      renderModal({ force:true });
      routeReceipt(id, 'replace');
      const layer = rootNode()?.querySelector('[data-money-modal-layer]');
      (focusSelector && layer?.querySelector(focusSelector) || layer?.querySelector('[data-money-receipt-apply]'))?.focus?.({ preventScroll:true });
      return;
    }
  }

  // Arrow keys move between receipts unless they belong to what has focus: a text, number, date or time field, a
  // select, an open select list or date picker.
  function receiptArrowKey(event){
    if (!['ArrowLeft', 'ArrowRight'].includes(event.key) || event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return false;
    if (state.receiptReview?.phase !== 'ready' || state.receiptBatch) return false;
    const target = event.composedPath?.()[0] || event.target;
    if (target?.closest?.('input:not([type="checkbox"]):not([type="radio"]),textarea,select,[contenteditable="true"],[contenteditable=""],fm-date-time-picker,.fm-select-list-menu')) return false;
    if (target?.isContentEditable || document.querySelector('fm-date-time-picker[popover]')) return false;
    if (rootNode()?.querySelector('.fm-select-list-trigger[aria-expanded="true"]')) return false;
    return true;
  }

  // GP-107: the person picker is the shared select list with a search box, so a large organization is searchable;
  // the select stays in the form as the value. "No reimbursement" and "Other person…" stay listed while searching.
  let selectListLibrary = null;
  function loadSelectList(){
    if (rootWindow.FirstMateSelectList) return Promise.resolve(rootWindow.FirstMateSelectList);
    selectListLibrary ??= new Promise((resolve, reject) => {
      const script = document.createElement('script');
      script.src = '/libraries/select-list/select-list.js?v=20261119-gp107';
      script.onload = () => rootWindow.FirstMateSelectList ? resolve(rootWindow.FirstMateSelectList) : reject(new Error('select-list did not initialize.'));
      script.onerror = () => reject(new Error('select-list could not be loaded.'));
      document.head.append(script);
    }).catch((error) => { selectListLibrary = null; throw error; });
    return selectListLibrary;
  }
  function enhanceReimburseSelect(select){
    loadSelectList().then((library) => {
      if (!select.isConnected || select.hidden) return;
      library.attach(select, {
        items:[...select.options].map((option) => ({ value:option.value, label:option.textContent, pinned:option.value === '' || option.value === '__other__' })),
        label:(globalThis.PlatformLanguage?.text("money","m_8b8d7106c3c872","Reimburse to ") ?? "Reimburse to ").trim(),
        floating:true,
        search:{
          placeholder:(globalThis.PlatformLanguage?.text("money","m_0b00bfad983f3f","Search people") ?? "Search people"),
          empty:(globalThis.PlatformLanguage?.text("money","m_e6261fd56b82c2","No matches") ?? "No matches")
        }
      });
    }).catch(() => {});
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
    const invoiceId = cleanText(options.invoiceId);
    const paidPresentation = invoiceId
      ? findInvoice(invoiceId)?.render_paid_in_full === true
      : state.invoiceFlow?.handle?.state?.().params?.render_paid_in_full === true;
    layer.querySelector('[data-money-invoice-email-modal]')?.remove();
    layer.insertAdjacentHTML('beforeend', invoiceEmailModal(invoiceId, paidPresentation));
    const shade = layer.querySelector('[data-money-invoice-email-modal]');
    const tray = bindTray(shade, () => shade?.remove(), { opening:true });
    shade?.querySelectorAll('[data-money-invoice-email-close]').forEach((button) => button.addEventListener('click', tray.dismiss));
    shade?.querySelector('[data-money-invoice-email-modal-form]')?.addEventListener('submit', (event) => {
      if (invoiceId) void submitInvoiceEmail(event);
      else void submitGeneratedInvoiceEmail(event);
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
    state.receiptViewer = null;
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
      // The receipt screen moves on to the next receipt, or closes after the last one.
      const review = state.receiptReview;
      if (cleanText(review?.receipt?.id) !== cleanText(receiptId)) return;
      delete state.receiptDrafts[cleanText(receiptId)];
      const order = (review.order || []).filter((id) => id !== cleanText(receiptId));
      const at = Math.max(0, (review.order || []).indexOf(cleanText(receiptId)));
      const next = [...order.slice(at), ...order.slice(0, at)].map((id) => receipts().find((item) => cleanText(item.id) === id)).find(Boolean);
      if (!next) { closeReceiptReview({ force:true }); return; }
      state.receiptReview = { ...review, receipt:next, order };
      routeReceipt(next.id, 'replace');
    }, 'Receipt voided.', { keepModal:true });
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
    const purchaseDate = cleanText(data.get('purchase_date'));
    const purchaseTime = cleanText(data.get('purchase_time'));
    const settings = receiptSettings();
    const fail = (message) => showToast(message, (globalThis.PlatformLanguage?.text("money","m_7e784f9b5540ab","error") ?? "error"));
    if (total <= 0) return fail((globalThis.PlatformLanguage?.text("money","m_4a53195eb31ba7","Enter the receipt total.") ?? "Enter the receipt total."));
    if (settings.require_date && !purchaseDate) return fail((globalThis.PlatformLanguage?.text("money","m_5c773ab6d5c406","Enter the purchase date.") ?? "Enter the purchase date."));
    if (settings.require_time && !purchaseTime) return fail((globalThis.PlatformLanguage?.text("money","m_ffe7faa9cf2581","Enter the purchase time.") ?? "Enter the purchase time."));
    if (!targetKeys.length) return fail((globalThis.PlatformLanguage?.text("money","m_226c50da93a695","Select at least one expense list.") ?? "Select at least one expense list."));
    if (receipt.duplicate_of_receipt_id && !receiptApplied(receipt) && data.get('confirm_duplicate') !== 'yes') return fail((globalThis.PlatformLanguage?.text("money","m_adaa9e9e5c1e78","Confirm that this duplicate file is a separate project expense before applying it.") ?? "Confirm that this duplicate file is a separate project expense before applying it."));
    const suggestions = new Set(receipt.suggested_target_keys || []);
    const acceptedSuggestion = settings.auto_categorize && suggestions.size === targetKeys.length && targetKeys.every((key) => suggestions.has(key));
    const wasApplied = receiptApplied(receipt);
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
        purchase_date:purchaseDate,
        purchase_time:purchaseTime,
        target_keys:targetKeys,
        accepted_suggestion:acceptedSuggestion,
        ...(reimbursementPayee ? { reimbursement:{ payee_ref:reimbursementPayee } } : {})
      });
      if (!operationIsCurrent()) return;
      if (result.expense_summary && state.summary) state.summary = { ...state.summary, expense_summary:result.expense_summary };
      delete state.receiptDrafts[receiptId];
      // The screen stays on this receipt, now marked applied; the arrows go on to the next one.
      const applied = { ...receipt, ...(result?.receipt || {}), status:'applied', attributed_target_keys:targetKeys };
      if (cleanText(state.receiptReview?.receipt?.id) === receiptId) state.receiptReview = { ...state.receiptReview, receipt:applied };
      showToast(result.reimbursement_payable
        ? `Receipt applied. Reimbursement owed to ${result.reimbursement_payable.payee_ref?.name || 'the payee'} was added.`
        : wasApplied ? (globalThis.PlatformLanguage?.text("money","m_45d786a380f16d","Receipt updated.") ?? "Receipt updated.") : 'Receipt applied to project expenses.', (globalThis.PlatformLanguage?.text("money","m_b4e54589824dc5","success") ?? "success"));
      state.saving = false;
      renderModal({ force:true });
      rootNode()?.querySelector('[data-money-receipt-move="1"],[data-money-receipt-close]')?.focus?.({ preventScroll:true });
      await loadData();
      const fresh = receipts().find((item) => cleanText(item.id) === receiptId);
      const open = rootNode()?.querySelector('[data-money-receipt-apply]');
      if (fresh && cleanText(state.receiptReview?.receipt?.id) === receiptId && !open?.dataset.dirty) {
        state.receiptReview = { ...state.receiptReview, receipt:fresh };
        renderModal({ force:true });
        rootNode()?.querySelector('[data-money-receipt-move="1"],[data-money-receipt-close]')?.focus?.({ preventScroll:true });
      }
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

  let invoiceRuntimePromise = null;

  function invoiceWorkflowRuntime(){
    const loaded = () => (rootWindow.FMDocWorkflow?.mount ? rootWindow.FMDocWorkflow : null);
    if (loaded()) return Promise.resolve(loaded());
    invoiceRuntimePromise = invoiceRuntimePromise || new Promise((resolve) => {
      const script = document.createElement('script');
      script.src = '/libraries/doc-workflow/firstmate-doc-workflow.js';
      script.async = true;
      script.onload = () => resolve(loaded());
      script.onerror = () => { invoiceRuntimePromise = null; resolve(null); };
      document.head.appendChild(script);
    });
    return invoiceRuntimePromise;
  }

  function invoiceFlowKey(){
    return `${orgId()}:${projectId()}`;
  }

  function syncInvoiceButtons(){
    const ready = state.invoiceFlow?.status === 'ready' && !moneyMutationBusy();
    rootNode()?.querySelectorAll('[data-money-invoice-submit]').forEach((button) => { button.disabled = !ready; });
  }

  /** Puts the dialog's workflow in place: the one already running (a redraw of the dialog keeps it), else a new one. */
  function attachInvoiceFlow(layer){
    const slot = layer.querySelector('[data-money-invoice-flow]');
    if (!slot) return;
    const current = state.invoiceFlow;
    const flow = current && current.key === invoiceFlowKey() ? current : startInvoiceFlow();
    slot.replaceWith(flow.host);
    syncInvoiceButtons();
  }

  function startInvoiceFlow(){
    discardInvoiceFlow();
    const host = document.createElement('div');
    host.className = 'mn-invoice-flow';
    host.setAttribute('data-money-invoice-flow', '');
    host.innerHTML = `<div class="mn-invoice-state"><i class="fas fa-circle-notch fa-spin" aria-hidden="true"></i><span>${(globalThis.PlatformLanguage?.htmlText("money","m_5f33627052a81a","Starting the invoice…") ?? "Starting the invoice…")}</span></div>`;
    const flow = { key:invoiceFlowKey(), orgId:orgId(), projectId:projectId(), host, status:'loading', params:{}, started:null, handle:null, totalCents:0, closed:false };
    state.invoiceFlow = flow;
    void openInvoiceFlow(flow);
    return flow;
  }

  /** The invoice draft on the server (payments' invoices/draft): never saved, resolved as the invoice document would be. */
  function invoiceDraft(flow, body){
    return rootWindow.PaymentsAPI.request(`/organizations/${encodeURIComponent(flow.orgId)}/projects/${encodeURIComponent(flow.projectId)}/invoices/draft`, { method:'POST', body });
  }

  async function openInvoiceFlow(flow){
    try {
      const runtime = await invoiceWorkflowRuntime();
      if (!runtime || !rootWindow.PaymentsAPI?.request) throw new Error((globalThis.PlatformLanguage?.text("money","m_23a9ed6b914f78","The invoice workflow is not loaded. Refresh the portal and try again.") ?? "The invoice workflow is not loaded. Refresh the portal and try again."));
      const started = await invoiceDraft(flow, { start:true });
      if (flow.closed) return;
      const workflow = started?.workflow;
      if (!Array.isArray(workflow?.steps) || !workflow.steps.length) throw new Error((globalThis.PlatformLanguage?.text("money","m_d7e505333f5522","The invoice could not be started.") ?? "The invoice could not be started."));
      flow.params = JSON.parse(JSON.stringify(started.params || {}));
      // The first preview is the one the draft started with.
      flow.started = started.resolved || null;
      noteInvoiceTotal(flow, flow.started);
      flow.host.innerHTML = '';
      flow.handle = runtime.mount(flow.host, {
        workflow,
        audience:'internal',
        contract:workflow.contract || {},
        state:{ params:JSON.parse(JSON.stringify(flow.params)) },
        scope:{ project:state.project || {} },
        document:{ id:'', type:'invoice' },
        showWorkflowTitle:false,
        // The dialog's own buttons generate it.
        footer:false,
        onWrite:(path, value) => writeInvoiceParam(flow, path, value),
        preview:{ pinned:true, collapsible:true, resolve:() => resolveInvoiceFlow(flow) }
      });
      flow.status = 'ready';
    } catch (error) {
      if (flow.closed) return;
      flow.status = 'error';
      flow.host.innerHTML = `<div class="mn-invoice-state error"><i class="fas fa-triangle-exclamation" aria-hidden="true"></i><span>${escapeHtml(error?.message || (globalThis.PlatformLanguage?.text("money","m_d7e505333f5522","The invoice could not be started.") ?? "The invoice could not be started."))}</span></div>`;
    }
    syncInvoiceButtons();
  }

  function writeInvoiceParam(flow, path, value){
    const target = cleanText(path);
    if (!target.startsWith('params.')) return;
    const parts = target.slice('params.'.length).split('.');
    let cursor = flow.params;
    parts.slice(0, -1).forEach((part) => { cursor[part] = cursor[part] && typeof cursor[part] === 'object' ? cursor[part] : {}; cursor = cursor[part]; });
    cursor[parts[parts.length - 1]] = JSON.parse(JSON.stringify(value ?? null));
  }

  function noteInvoiceTotal(flow, resolved){
    const billing = resolved?.scope?.params?.billing;
    if (!billing || flow.closed) return;
    flow.totalCents = cents(billing.total_cents);
    rootNode()?.querySelectorAll('[data-money-invoice-foot-total]').forEach((node) => { node.textContent = money(flow.totalCents); });
  }

  /** The draft as it reads now: the live preview, and the total in the dialog's footer. */
  async function resolveInvoiceFlow(flow){
    if (flow.started) { const first = flow.started; flow.started = null; return first; }
    const result = await invoiceDraft(flow, { params:flow.params });
    noteInvoiceTotal(flow, result?.resolved);
    return result?.resolved || {};
  }

  /** The invoice the draft describes, as this tab makes it: the payments it bills, its other charges taxed as the document taxes them. */
  async function invoiceFromFlow(flow){
    const result = await invoiceDraft(flow, { params:flow.params });
    const params = result?.resolved?.scope?.params || {};
    const schedule = new Map((Array.isArray(params.account?.schedule) ? params.account.schedule : []).map((row) => [cleanText(row?.id), row]));
    const obligationIds = (Array.isArray(params.billing?.obligation_ids) ? params.billing.obligation_ids : []).map((id) => cleanText(id)).filter(Boolean);
    const lineCents = (line) => {
      const price = Number(line?.unit_price ?? line?.unitPrice);
      return Number.isFinite(price) ? Math.round((Number(line?.quantity ?? 1) || 0) * price * 100) : cents(line?.amount_cents);
    };
    const charges = (Array.isArray(params.line_items) ? params.line_items : [])
      .map((line) => ({ type:'manual', description:cleanText(line?.display_name, line?.name, line?.description, 'Charge'), amount_cents:lineCents(line) }))
      .filter((line) => line.amount_cents > 0);
    const lineItems = [
      ...obligationIds.map((id) => ({ type:'payment', obligation_id:id, description:cleanText(schedule.get(id)?.label, 'Project payment'), amount_cents:Math.max(1, cents(schedule.get(id)?.amount_cents)) })),
      ...charges
    ];
    if (!lineItems.length) throw new Error((globalThis.PlatformLanguage?.text("money","m_2799b0873b6af7","Choose what to bill, or add a charge.") ?? "Choose what to bill, or add a charge."));
    return {
      obligation_ids:obligationIds,
      line_items:lineItems,
      tax_enabled:params.sales_tax_available !== false && params.tax_enabled !== false,
      tax_percent:Math.min(100, Math.max(0, Number(params.tax_percent) || 0)),
      tax_base:'charges',
      issue_date:cleanText(params.issue_date),
      due_date:cleanText(params.due_date),
      render_paid_in_full:params.render_paid_in_full === true,
      notes:cleanText(params.notes)
    };
  }

  function discardInvoiceFlow(){
    const flow = state.invoiceFlow;
    if (!flow) return;
    state.invoiceFlow = null;
    flow.closed = true;
    try { flow.handle?.destroy?.(); } catch (_) { /* already gone */ }
    flow.host.remove();
  }

  async function generateInvoice(email = null){
    const flow = state.invoiceFlow;
    if (!flow?.handle || flow.status !== 'ready' || flow.key !== invoiceFlowKey()) return false;
    const recipient = cleanText(email?.recipient);
    if (email && !recipient) {
      showToast((globalThis.PlatformLanguage?.text("money","m_16feb9c0f8092f","Enter the customer email before generating.") ?? "Enter the customer email before generating."), (globalThis.PlatformLanguage?.text("money","m_7e784f9b5540ab","error") ?? "error"));
      return false;
    }
    if (!flow.handle.validate()) return false;
    return withSave(async () => {
      const generated = await rootWindow.PaymentsAPI.invoices.create(flow.orgId, flow.projectId, await invoiceFromFlow(flow));
      const invoice = generated.invoice || {};
      if (email) {
        await rootWindow.PaymentsAPI.invoices.email(flow.orgId, invoice.id, {
          recipient,
          include_portal_link:email.includePortalLink === true,
          message:cleanText(email.message)
        });
      } else {
        const link = document.createElement('a');
        link.href = rootWindow.PaymentsAPI.invoices.pdfUrl(flow.orgId, invoice.id);
        link.download = `${cleanText(invoice.invoice_number || 'invoice').toLowerCase()}.pdf`;
        document.body.appendChild(link);
        link.click();
        link.remove();
      }
    }, email ? `Invoice generated and emailed to ${recipient}.` : 'Invoice generated and download started.');
  }

  async function submitGeneratedInvoiceEmail(event){
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    await generateInvoice({
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

  // Payment setup runs in the portal that holds this project window (its
  // Money setup turns on processing and opens Forward's application).
  function paymentsHostWindow(){
    let target = rootWindow;
    try { while (target.parent !== target && target.parent.Portal?.appSetup) target = target.parent; } catch (_) { /* foreign parent */ }
    return target;
  }

  function canSetUpPayments(){
    const host = paymentsHostWindow();
    return (host.Portal?.util?.hasPerm || rootWindow.Portal?.util?.hasPerm)?.('manage_company_settings') === true;
  }

  function openPaymentSettings(){
    closeModal();
    paymentsHostWindow().Portal?.navigation?.navigate?.(
      { tab:'company_settings', sub:'money', settingsView:'payments', settingsEntity:'' },
      { source:'project-money-payment-setup', ownedKeys:['tab', 'sub', 'settingsView', 'settingsEntity'] }
    );
    // Settings opens in the portal behind this project window: close it, as opening a contact from it does.
    try {
      const name = String(rootWindow.name || '');
      const windows = rootWindow.parent !== rootWindow ? rootWindow.parent.FirstMateProjectWindows : null;
      const token = name.startsWith('fm-project-window:') ? name.slice(18) : '';
      if (token && windows?.accepts?.(token, rootWindow)) windows.close(token);
    } catch (_) { /* not in a project window */ }
  }

  function startPaymentSetup(){
    const host = paymentsHostWindow();
    closeModal();
    const setup = host.Portal?.appSetup?.has?.('platform.money')
      ? host.Portal.appSetup.run('platform.money')
      : host.FirstMatePaymentsSetup?.open?.();
    if (!setup) { openPaymentSettings(); return; }
    Promise.resolve(setup).then(recheckPaymentsSetup, () => openPaymentSettings());
  }

  // Online payments are not set up yet (off, no merchant account, or the
  // application not approved), by the server's readiness answer loaded with
  // the tab. Paused processing or a provider outage is not setup, and unknown
  // (not asked, or the ask failed) is not "not set up": no pill for those.
  function paymentsSetupPending(){
    const entry = state.paymentIntakeConfig;
    const config = entry && entry.key === `${orgId()}:${projectId()}` ? entry.config : null;
    return !!config && config.ready !== true && ['online_processing_off', 'no_merchant_account', 'not_approved'].includes(cleanText(config.not_ready_reason));
  }

  function setUpPaymentsText(){
    return (globalThis.PlatformLanguage?.text("money","m_f36100a458bee9","Set up online payments") ?? "Set up online payments");
  }

  // GP-17: the Operations tab's labor/equipment "Setup" badge. Clicking it opens payment setup for those who can
  // set payments up; anyone else gets Take a payment's own explanation.
  function paymentsSetupPillHtml(){
    return `<span class="mn-setup-pill" data-money-payments-setup>${(globalThis.PlatformLanguage?.htmlText("money","m_b06faf127e1505","Setup") ?? "Setup")}</span>`;
  }

  // GP-40: the same reminder on the phone's + button, as a small warning triangle (there is no room for the pill).
  function paymentsSetupAlertHtml(){
    return `<span class="mn-setup-alert" data-money-setup-alert role="img" aria-label="${escapeHtml(setUpPaymentsText())}"><i class="fas fa-triangle-exclamation" aria-hidden="true"></i></span>`;
  }

  // After the setup closes, ask again so the pill goes once payments are ready.
  function recheckPaymentsSetup(){
    const before = paymentsSetupPending();
    state.paymentIntakeConfig = null;
    void refreshPaymentIntakeConfig().then(() => {
      if (state.active && paymentsSetupPending() !== before) renderMain();
    });
  }

  // When payments are not ready, Take a Payment is a way into setup: whoever
  // can set payments up gets the setup (or its status once applied); anyone
  // else is told who can, and can still record a cash or check payment.
  function paymentNotReadyOptions(config){
    const reason = cleanText(config?.not_ready_reason);
    const record = { label: (globalThis.PlatformLanguage?.text("money","m_e28623b06e54fa","Record a cash or check payment") ?? "Record a cash or check payment"), onClick: () => { closeModal(); openModal({ type:'add_payment' }); } };
    const setUp = canSetUpPayments();
    if (!config) {
      return {
        notReadyTitle: (globalThis.PlatformLanguage?.text("money","m_ee79dc11b89d27","Online payments could not be checked") ?? "Online payments could not be checked"),
        notReadyMessage: (globalThis.PlatformLanguage?.text("money","m_e1a5ebb81bdc45","Close this and try again in a moment.") ?? "Close this and try again in a moment."),
        notReadyActions: [record]
      };
    }
    if (['online_processing_off', 'no_merchant_account'].includes(reason)) {
      return {
        notReadyTitle: (globalThis.PlatformLanguage?.text("money","m_f36100a458bee9","Set up online payments") ?? "Set up online payments"),
        notReadyMessage: setUp
          ? (globalThis.PlatformLanguage?.text("money","m_a228986f574138","To take card and bank payments here, set up your payment account first. You only do this once.") ?? "To take card and bank payments here, set up your payment account first. You only do this once.")
          : (globalThis.PlatformLanguage?.text("money","m_ed20a1fba9e02d","Online payments are not set up yet. Ask an administrator to set them up in Settings, Payments.") ?? "Online payments are not set up yet. Ask an administrator to set them up in Settings, Payments."),
        notReadyActions: setUp ? [{ label: (globalThis.PlatformLanguage?.text("money","m_95c81d9a92d972","Set up payments") ?? "Set up payments"), primary: true, onClick: startPaymentSetup }, record] : [record]
      };
    }
    if (['not_approved', 'processing_disabled'].includes(reason)) {
      return {
        notReadyTitle: reason === 'not_approved' ? (globalThis.PlatformLanguage?.text("money","m_bd23780eab3341","Payment setup is in review") ?? "Payment setup is in review") : (globalThis.PlatformLanguage?.text("money","m_e688d7fb796e90","Payments are paused") ?? "Payments are paused"),
        notReadyMessage: cleanText(config.message) || (globalThis.PlatformLanguage?.text("money","m_b752fc50bd294b","Online payments are not available yet.") ?? "Online payments are not available yet."),
        notReadyActions: setUp ? [{ label: (globalThis.PlatformLanguage?.text("money","m_6a00152380cdc8","View payment setup") ?? "View payment setup"), primary: true, onClick: openPaymentSettings }, record] : [record]
      };
    }
    return {
      notReadyTitle: (globalThis.PlatformLanguage?.text("money","m_7a8078bb2d8ed0","Online payments are not available") ?? "Online payments are not available"),
      notReadyMessage: cleanText(config.message) || (globalThis.PlatformLanguage?.text("money","m_c2c26759407079","Online payments are not available right now.") ?? "Online payments are not available right now."),
      notReadyActions: [record]
    };
  }

  function paymentIntakeProviderOptions(){
    // The payment form offers card or bank entry only when the organization
    // can take payments (the server's readiness answer). Otherwise it says
    // why and leads to payment setup; nothing in it can record a payment.
    const entry = state.paymentIntakeConfig;
    const config = entry && entry.key === `${orgId()}:${projectId()}` ? entry.config : null;
    if (!config || config.ready !== true || !config.provider) {
      return {
        ...paymentNotReadyOptions(config),
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
        { label: workspaceText('back_to_workspace', 'Back to {workspace}'), primary: true, onClick: () => { closeModal(); void loadData(); } }
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
    const setupBefore = rootNode()?.querySelector('[data-money-take-payment] [data-money-payments-setup]') != null;
    // Resolve provider config once per org+project before mounting so the
    // form opens directly in the right mode.
    void refreshPaymentIntakeConfig().then(() => {
      if (state.active && state.paymentIntakeConfig && paymentsSetupPending() !== setupBefore) renderMain();
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
    if (event.defaultPrevented || !state.active) return;
    if (receiptArrowKey(event)) {
      event.preventDefault();
      moveReceipt(event.key === 'ArrowLeft' ? -1 : 1);
      return;
    }
    if (event.key !== 'Escape') return;
    const layer = rootNode()?.querySelector('[data-money-modal-layer]');
    const handled = () => { event.preventDefault(); event.stopImmediatePropagation(); };
    if (!layer?.firstElementChild) return;
    // An open select list (GP-107) or date picker (GP-109) closes itself on this Escape.
    if (layer.querySelector('.fm-select-list-trigger[aria-expanded="true"]') || document.querySelector('fm-date-time-picker[popover]')) return;
    handled();
    const emailModal = layer.querySelector('[data-money-invoice-email-modal]');
    if (emailModal) { emailModal.remove(); return; }
    if (state.saving || state.receiptBatch) return;
    if (state.receiptReview) { closeReceiptReview(); return; }
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
    discardInvoiceFlow();
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
  // Payment setup closed, wherever it was started (the Finance tour's setup step, GP-40): ask again, so the Setup pill
  // and the + button's warning go once payments are ready.
  const onPaymentsSetupUpdated = () => { if (state.active && state.paymentIntakeConfig) recheckPaymentsSetup(); };
  for (const target of new Set([rootWindow, paymentsHostWindow()])) { try { target.addEventListener('fm:payments-setup-updated', onPaymentsSetupUpdated); } catch (_) { /* foreign window */ } }

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
    } else if (view === 'new_invoice') {
      // GP-60: the global Invoices tab's New invoice opens this project's Generate invoice dialog.
      if (canManageMoney() && state.modal?.type !== 'invoice' && !moneyMutationBusy()) openModal({ type:'invoice' });
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
    // The tab's name is the `money.project_tab` term, like the manifest entry; this registration must not replace it.
    terminologyKey: 'money.project_tab',
    title: term('project_tab', 'Financials'),
    label: term('project_tab', 'Financials'),
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
