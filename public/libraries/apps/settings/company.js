/* public/libraries/apps/settings/company.js
 * - Adds Billing tab (org-level auto top-up) with:
 *    - Enable toggle (default off)
 *    - Threshold + Top-up Amount with +/- (step 7) and manual typing
 *    - Minimums: $35 for both threshold + top-up
 *    - Requires manage_billing permission
 *    - Monthly Statement with detail modal + CSV export
 * - Keeps existing Company / Users / Reports behavior + permissions logic
 * - MOBILE RESPONSIVE: full redesign for screens <= 820px without affecting desktop
 */
(function(){
  if (!window.Portal) return;
  const { $, escapeHtml, injectCSS, postAction, hasPerm } = window.Portal.util;
  const { showToast } = window.Portal.ui;
  const DEFAULT_LOGO = '/images/logo_red.png';
  const SAMPLE_DIAGRAM = 'media/sample_diagram.png';
  const LS_KEY = 'fm_org_theme_v1';
  const DEFAULT_PRIMARY = '#d93025';
  const DEFAULT_SECONDARY = '#960000';
  const ME_EMAIL = (window.__APP && window.__APP.userEmail)
    ? String(window.__APP.userEmail).toLowerCase().trim()
    : '';
  const DEFAULT_GENERAL_REPORT_SETTINGS = {
    nfva_ratio: 300,
  };
  const DEFAULT_CUSTOMER_REPORT_SETTINGS = {
    cover_show_customer: true,
    cover_show_squares: true,
    cover_show_waste: true,
    cover_show_breakdown: true,
    cover_show_pitch: true,
    cover_show_facets: true,
    page_top_view: true,
    page_elevations: true,
    page_3d: true,
    page_pitch: true,
    page_area: true,
    page_layers: true,
    page_summary: true,
    page_materials: true,
    page_ventilation: true,
    page_gutters: false,
    page_notes: true
  };
  const DEFAULT_ESTIMATE_PRICING = [
    { roof_type: 'Asphalt', pitch: 'Low', low_price_sqft: 6.75, high_price_sqft: 9.25 },
    { roof_type: 'Asphalt', pitch: 'Moderate', low_price_sqft: 7.5, high_price_sqft: 10.5 },
    { roof_type: 'Asphalt', pitch: 'Steep', low_price_sqft: 8.75, high_price_sqft: 12.25 },
    { roof_type: 'Metal', pitch: 'Low', low_price_sqft: 10.5, high_price_sqft: 14.5 },
    { roof_type: 'Metal', pitch: 'Moderate', low_price_sqft: 12, high_price_sqft: 16.75 },
    { roof_type: 'Metal', pitch: 'Steep', low_price_sqft: 14, high_price_sqft: 19.5 },
    { roof_type: 'Tile', pitch: 'Low', low_price_sqft: 13.5, high_price_sqft: 18 },
    { roof_type: 'Tile', pitch: 'Moderate', low_price_sqft: 15, high_price_sqft: 21 },
    { roof_type: 'Tile', pitch: 'Steep', low_price_sqft: 17.5, high_price_sqft: 24.5 }
  ];
  const PERM_META = [
    { k:'order_reports',                   label:'Order Reports' },
    { k:'view_reports',                    label:'View Reports' },
    { k:'manage_billing',                  label:'Manage Billing' },
    { k:'manage_company_settings',         label:'Manage Company Settings' },
    { k:'manage_report_settings',          label:'Manage Report Settings' },
    { k:'manage_company_users',            label:'Manage Users' },
    { k:'manage_company_user_permissions', label:'Manage User Permissions' },
  ];
  const LEVEL_OPTIONS = [
    { v:'viewer',      label:'Viewer' },
    { v:'manager',     label:'Manager' },
    { v:'admin',       label:'Admin' },
    { v:'custom',      label:'Custom' },
    { v:'super_admin', label:'Super Admin' },
  ];
  const LEVEL_PRESET_META = [
    { v:'viewer',      label:'Viewer',      icon:'fa-eye' },
    { v:'manager',     label:'Manager',     icon:'fa-briefcase' },
    { v:'admin',       label:'Admin',       icon:'fa-shield-halved' },
    { v:'super_admin', label:'Super Admin', icon:'fa-user-shield' },
  ];
  const LEVEL_PERM_DEFAULTS = {
    viewer: {
      order_reports:false,
      view_reports:true,
      manage_billing:false,
      manage_company_settings:false,
      manage_report_settings:false,
      manage_company_users:false,
      manage_company_user_permissions:false,
    },
    manager: {
      order_reports:true,
      view_reports:true,
      manage_billing:false,
      manage_company_settings:false,
      manage_report_settings:false,
      manage_company_users:false,
      manage_company_user_permissions:false,
    },
    admin: {
      order_reports:true,
      view_reports:true,
      manage_billing:true,
      manage_company_settings:true,
      manage_report_settings:true,
      manage_company_users:true,
      manage_company_user_permissions:false,
    },
    super_admin: Object.fromEntries(PERM_META.map(pm => [pm.k, true])),
  };
  // Billing constants
  const BILL_MIN = 35;   // dollars
  const BILL_STEP = 10;  // dollars
  const BILL_DEFAULT_THRESHOLD = 50;
  const BILL_DEFAULT_TOPUP = 100;
  const PROPOSAL_FONT_OPTIONS = ['Montserrat','Inter','Roboto','Open Sans','Lato','Poppins','Source Sans 3'];
  // Month names for statement
  const MONTH_NAMES = ['January','February','March','April','May','June','July','August','September','October','November','December'];
  function currentOrgId(){
    return String(window.__APP?.userOrgId || state?.id || '').trim();
  }
  function currentBranchId(){
    return String(window.Portal?.branchModules?.currentBranchId?.() || window.__APP?.userBranchId || 'default').trim() || 'default';
  }
  function normalizeProposalSettings(input){
    const data = input && typeof input === 'object' ? input : {};
    const defaults = data.proposal_defaults && typeof data.proposal_defaults === 'object' ? data.proposal_defaults : {};
    const number = (value, fallback = 0) => {
      const parsed = Number(String(value ?? '').replace(/[^0-9.]/g, ''));
      return Number.isFinite(parsed) ? parsed : fallback;
    };
    const configuredSchedule = Array.isArray(defaults.payment_schedule) ? defaults.payment_schedule : [];
    const fallbackSchedule = [
      { label: 'Deposit', percent: 30, due_rule: 'on_signature' },
      { label: 'Progress Payment', percent: 30, due_rule: 'manual' },
      { label: 'Final Payment', percent: 40, due_rule: 'project_completion' }
    ];
    const paymentSchedule = fallbackSchedule.map((fallback, index) => {
      const source = configuredSchedule[index] && typeof configuredSchedule[index] === 'object' ? configuredSchedule[index] : {};
      return {
        label: String(source.label || fallback.label).trim() || fallback.label,
        percent: Math.max(0, number(source.percent, fallback.percent)),
        due_rule: String(source.due_rule || source.dueRule || fallback.due_rule).trim() || fallback.due_rule
      };
    });
    const theme = String(data.default_theme || defaults.default_theme || 'margin').trim();
    return {
      ...data,
      default_theme: ['margin', 'clean', 'triangles'].includes(theme) ? theme : 'margin',
      proposal_defaults: {
        ...defaults,
        send_include_pdf: defaults.send_include_pdf !== false,
        send_include_portal: defaults.send_include_portal !== false,
        default_title_prefix: String(defaults.default_title_prefix || 'Proposal').trim() || 'Proposal',
        sales_tax_percent: Math.max(0, number(defaults.sales_tax_percent, 0)),
        payment_schedule: paymentSchedule,
        font_family: PROPOSAL_FONT_OPTIONS.includes(String(defaults.font_family || data.proposal_font_family || data.font_family || '').trim())
          ? String(defaults.font_family || data.proposal_font_family || data.font_family).trim()
          : 'Montserrat'
      }
    };
  }
  function injectSettingsPageCommonCss(){
    injectCSS('firstmate_settings_pages_common', `
      .fm-settings-page{height:100%;min-height:0;overflow:auto;background:#fff;color:#111827}
      .fm-settings-page.embedded{padding:18px}
      .fm-settings-page .cs-section{display:flex;flex-direction:column;gap:14px}
      .fm-settings-page h3{margin:0;font-size:18px;line-height:1.2;font-weight:1000;color:#111827}
      .fm-settings-page .cs-note{font-size:12px;line-height:1.45;color:#667085;font-weight:750;margin:0}
      .fm-settings-page .cs-grid{display:grid;grid-template-columns:1fr;gap:12px}
      .fm-settings-page .cs-row{display:flex;flex-direction:column;gap:7px}
      .fm-settings-page .cs-lbl{font-size:12px;font-weight:950;color:#344054}
      .fm-settings-page .cs-in{height:40px;border:1px solid #d0d5dd;border-radius:10px;background:#fff;padding:0 12px;font:inherit;font-size:13px;font-weight:800;color:#111827;outline:none}
      .fm-settings-page .cs-in:focus{border-color:rgba(var(--primary-rgb,217,48,37),.45);box-shadow:0 0 0 4px rgba(var(--primary-rgb,217,48,37),.09)}
      .fm-settings-page .proposal-default-grid{display:grid;grid-template-columns:1fr 180px;gap:12px}
      .fm-settings-page .proposal-schedule{display:grid;gap:8px;border:1px solid #e4e7ec;border-radius:12px;padding:12px}
      .fm-settings-page .proposal-schedule-head,.fm-settings-page .proposal-schedule-row{display:grid;grid-template-columns:minmax(0,1fr) 110px;gap:10px;align-items:center}
      .fm-settings-page .proposal-schedule-head{color:#667085;font-size:11px;font-weight:950;text-transform:uppercase}
      .fm-settings-page .proposal-schedule-row .cs-in{text-align:left}
      .fm-settings-page .proposal-schedule-row .percent{position:relative}
      .fm-settings-page .proposal-schedule-row .percent .cs-in{padding-right:28px;text-align:right}
      .fm-settings-page .proposal-schedule-row .percent:after{content:"%";position:absolute;right:11px;top:50%;transform:translateY(-50%);color:#667085;font-weight:950;font-size:12px}
      .fm-settings-page .cfg-options{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:10px}
      .fm-settings-page .cfg-option{border:1px solid #e4e7ec;background:#fff;border-radius:12px;padding:12px;text-align:left;cursor:pointer;display:flex;flex-direction:column;gap:5px;min-height:94px;transition:.16s ease}
      .fm-settings-page .cfg-option strong{font-size:13px;font-weight:1000;color:#111827}
      .fm-settings-page .cfg-option span{font-size:11px;line-height:1.35;font-weight:750;color:#667085}
      .fm-settings-page .cfg-option.active{border-color:rgba(var(--primary-rgb,217,48,37),.38);background:rgba(var(--primary-rgb,217,48,37),.05);box-shadow:inset 0 0 0 1px rgba(var(--primary-rgb,217,48,37),.06)}
      .fm-settings-page .li-switch-row{border:1px solid #e4e7ec;border-radius:12px;padding:12px;display:flex;align-items:center;justify-content:space-between;gap:14px}
      .fm-settings-page .li-switch{width:42px;height:24px;border-radius:999px;background:#d0d5dd;position:relative;display:inline-flex;flex:0 0 auto;cursor:pointer}
      .fm-settings-page .li-switch input{position:absolute;opacity:0;pointer-events:none}
      .fm-settings-page .li-slider{position:absolute;inset:0;border-radius:999px;transition:.16s ease}
      .fm-settings-page .li-slider:before{content:"";position:absolute;width:18px;height:18px;left:3px;top:3px;background:#fff;border-radius:50%;box-shadow:0 1px 3px rgba(15,23,42,.24);transition:.16s ease}
      .fm-settings-page .li-switch input:checked + .li-slider{background:var(--primary-readable,var(--primary,#d93025))}
      .fm-settings-page .li-switch input:checked + .li-slider:before{transform:translateX(18px)}
      .fm-settings-page .li-actions{display:flex;align-items:center;gap:10px;flex-wrap:wrap}
      .fm-settings-page .cs-btn{border:1px solid #d0d5dd;background:#fff;color:#344054;border-radius:10px;height:38px;padding:0 13px;font-size:12px;font-weight:1000;display:inline-flex;align-items:center;justify-content:center;gap:8px;cursor:pointer}
      .fm-settings-page .cs-btn.primary{border-color:var(--primary-readable,var(--primary,#d93025));background:var(--primary-readable,var(--primary,#d93025));color:#fff}
      .fm-settings-page .cs-btn:disabled{opacity:.62;cursor:default}
      @media(max-width:780px){.fm-settings-page.embedded{padding:14px}.fm-settings-page .cfg-options,.fm-settings-page .proposal-default-grid{grid-template-columns:1fr}}
    `);
  }
  function proposalSettingsStore(context = {}){
    const pages = window.FirstMateSettingsPages;
    return pages?.branchModuleStore?.('presentation_style', {
      orgId: context.orgId || currentOrgId(),
      branchId: context.branchId || currentBranchId(),
      normalize: normalizeProposalSettings,
      kind: 'branch_presentation_style',
      source: context.source || 'settings_pages_proposals',
      updatedEvent: 'fm:proposal-settings:updated'
    });
  }
  function renderReusableProposalSettingsPage(context){
    const pages = window.FirstMateSettingsPages;
    const root = context.root;
    const escape = context.escapeHtml || escapeHtml;
    const show = context.showToast || showToast;
    const store = proposalSettingsStore(context);
    if (!root || !store) {
      if (root) root.innerHTML = `<div class="cs-note">Proposal settings are unavailable.</div>`;
      return {};
    }
    injectSettingsPageCommonCss();
    let destroyed = false;
    let settings = normalizeProposalSettings({});
    const ids = {
      title: `${context.instanceId}_proposalTitlePrefix`,
      font: `${context.instanceId}_proposalFontFamily`,
      tax: `${context.instanceId}_proposalSalesTax`,
      pay0Label: `${context.instanceId}_proposalPayment0Label`,
      pay0Percent: `${context.instanceId}_proposalPayment0Percent`,
      pay1Label: `${context.instanceId}_proposalPayment1Label`,
      pay1Percent: `${context.instanceId}_proposalPayment1Percent`,
      pay2Label: `${context.instanceId}_proposalPayment2Label`,
      pay2Percent: `${context.instanceId}_proposalPayment2Percent`,
      pdf: `${context.instanceId}_proposalSendPdfDefault`,
      portal: `${context.instanceId}_proposalSendPortalDefault`,
      save: `${context.instanceId}_proposalSettingsSave`,
      status: `${context.instanceId}_proposalSettingsStatus`
    };
    const numberValue = (id, fallback = 0) => {
      const parsed = Number(String(root.querySelector(`#${CSS.escape(id)}`)?.value || '').replace(/[^0-9.]/g, ''));
      return Number.isFinite(parsed) ? parsed : fallback;
    };
    const collectDraft = () => normalizeProposalSettings({
      ...settings,
      proposal_defaults: {
        ...(settings.proposal_defaults || {}),
        default_title_prefix: String(root.querySelector(`#${CSS.escape(ids.title)}`)?.value || 'Proposal').trim() || 'Proposal',
        sales_tax_percent: numberValue(ids.tax, 0),
        payment_schedule: [
          { label: String(root.querySelector(`#${CSS.escape(ids.pay0Label)}`)?.value || 'Deposit').trim() || 'Deposit', percent: numberValue(ids.pay0Percent, 30), due_rule: 'on_signature' },
          { label: String(root.querySelector(`#${CSS.escape(ids.pay1Label)}`)?.value || 'Progress Payment').trim() || 'Progress Payment', percent: numberValue(ids.pay1Percent, 30), due_rule: 'manual' },
          { label: String(root.querySelector(`#${CSS.escape(ids.pay2Label)}`)?.value || 'Final Payment').trim() || 'Final Payment', percent: numberValue(ids.pay2Percent, 40), due_rule: 'project_completion' }
        ],
        font_family: PROPOSAL_FONT_OPTIONS.includes(root.querySelector(`#${CSS.escape(ids.font)}`)?.value)
          ? root.querySelector(`#${CSS.escape(ids.font)}`)?.value
          : 'Montserrat',
        send_include_pdf: !!root.querySelector(`#${CSS.escape(ids.pdf)}`)?.checked,
        send_include_portal: !!root.querySelector(`#${CSS.escape(ids.portal)}`)?.checked
      }
    });
    const publishInputDraft = () => {
      settings = collectDraft();
      store.setDraft(settings, { source: context.instanceId, pageId: 'proposals' });
    };
    const render = (saving = false, statusText = '') => {
      const defaults = settings.proposal_defaults || {};
      const paymentSchedule = Array.isArray(defaults.payment_schedule) ? defaults.payment_schedule : [];
      const scheduleRows = [
        { label: 'Deposit', percent: 30 },
        { label: 'Progress Payment', percent: 30 },
        { label: 'Final Payment', percent: 40 }
      ].map((fallback, index) => ({
        label: String(paymentSchedule[index]?.label || fallback.label).trim() || fallback.label,
        percent: Number.isFinite(Number(paymentSchedule[index]?.percent)) ? Number(paymentSchedule[index].percent) : fallback.percent
      }));
      const themes = [
        ['margin', 'Margin', 'Uses a branded left margin and roomy contract-style pages.'],
        ['clean', 'Clean', 'Uses a quiet header and minimal page framing.'],
        ['triangles', 'Triangles', 'Uses stronger branded geometry for sales-forward proposals.']
      ];
      root.classList.add('fm-settings-page');
      root.classList.toggle('embedded', !!context.embedded);
      root.innerHTML = `
        <div class="cs-section">
          <h3>Proposal Settings</h3>
          <p class="cs-note">Set branch defaults for new proposals. Existing proposals keep their saved style unless edited.</p>
          <div class="cfg-options">
            ${themes.map(([value, label, description]) => `
              <button type="button" class="cfg-option ${settings.default_theme === value ? 'active' : ''}" data-proposal-theme="${escape(value)}">
                <strong>${escape(label)}</strong>
                <span>${escape(description)}</span>
              </button>
            `).join('')}
          </div>
          <div class="cs-grid" style="margin-top:2px">
              <div class="cs-row">
                <div class="cs-lbl">Proposal Title Prefix</div>
                <input class="cs-in" id="${escape(ids.title)}" value="${escape(defaults.default_title_prefix || 'Proposal')}">
              </div>
              <div class="cs-row">
                <div class="cs-lbl">Proposal Font</div>
                <select class="cs-in" id="${escape(ids.font)}">
                  ${PROPOSAL_FONT_OPTIONS.map((font) => `<option value="${escape(font)}" ${String(defaults.font_family || 'Montserrat') === font ? 'selected' : ''}>${escape(font)}</option>`).join('')}
                </select>
              </div>
              <div class="proposal-default-grid">
                <div class="cs-row">
                  <div class="cs-lbl">Default Sales Tax</div>
                  <input class="cs-in" id="${escape(ids.tax)}" inputmode="decimal" value="${escape(String(defaults.sales_tax_percent ?? 0))}">
                </div>
                <div class="cs-row">
                  <div class="cs-lbl">Payment Total</div>
                  <input class="cs-in" value="${escape(String(scheduleRows.reduce((sum, row) => sum + Number(row.percent || 0), 0)))}%" readonly>
                </div>
              </div>
              <div class="proposal-schedule">
                <div class="proposal-schedule-head"><span>Default Payment Step</span><span>Percent</span></div>
                ${scheduleRows.map((row, index) => `
                  <div class="proposal-schedule-row">
                    <input class="cs-in" id="${escape(ids[`pay${index}Label`])}" value="${escape(row.label)}">
                    <span class="percent"><input class="cs-in" id="${escape(ids[`pay${index}Percent`])}" inputmode="decimal" value="${escape(String(row.percent))}"></span>
                  </div>
                `).join('')}
              </div>
            <label class="li-switch-row">
              <div>
                <div class="cs-lbl">Include PDF by default</div>
                <div class="cs-note" style="margin:2px 0 0">Preselect the PDF option when sending proposals.</div>
              </div>
              <span class="li-switch"><input id="${escape(ids.pdf)}" type="checkbox" ${defaults.send_include_pdf !== false ? 'checked' : ''}><span class="li-slider"></span></span>
            </label>
            <label class="li-switch-row">
              <div>
                <div class="cs-lbl">Include portal link by default</div>
                <div class="cs-note" style="margin:2px 0 0">Preselect the customer portal link option when available.</div>
              </div>
              <span class="li-switch"><input id="${escape(ids.portal)}" type="checkbox" ${defaults.send_include_portal !== false ? 'checked' : ''}><span class="li-slider"></span></span>
            </label>
          </div>
          <div class="li-actions" style="margin-top:0">
            <button class="cs-btn primary" id="${escape(ids.save)}" type="button" ${saving ? 'disabled' : ''}>${saving ? '<i class="fas fa-spinner fa-spin"></i> Saving...' : '<i class="fas fa-save"></i> Save Proposal Settings'}</button>
          </div>
          <div class="cs-note" id="${escape(ids.status)}">${escape(statusText || '')}</div>
        </div>
      `;
      root.querySelectorAll('[data-proposal-theme]').forEach((button) => {
        button.addEventListener('click', () => {
          settings = normalizeProposalSettings({ ...collectDraft(), default_theme: button.dataset.proposalTheme || 'margin' });
          store.setDraft(settings, { source: context.instanceId, pageId: 'proposals' });
          render(false);
        });
      });
      [ids.title, ids.font, ids.tax, ids.pay0Label, ids.pay0Percent, ids.pay1Label, ids.pay1Percent, ids.pay2Label, ids.pay2Percent, ids.pdf, ids.portal].forEach((id) => {
        const input = root.querySelector(`#${CSS.escape(id)}`);
        input?.addEventListener('input', publishInputDraft);
        input?.addEventListener('change', publishInputDraft);
      });
      root.querySelector(`#${CSS.escape(ids.save)}`)?.addEventListener('click', async () => {
        settings = collectDraft();
        store.setDraft(settings, { source: context.instanceId, pageId: 'proposals' });
        render(true);
        try {
          settings = await store.save(settings, { source: context.instanceId, pageId: 'proposals' });
          render(false, 'Saved.');
          show('Saved', 'Proposal settings updated.', true);
        } catch (e) {
          render(false);
          show('Save failed', e?.message || 'Could not save proposal settings.', false);
        }
      });
    };
    root.innerHTML = `<div class="cs-note">Loading proposal settings...</div>`;
    const unsubscribe = store.subscribe((next, meta = {}) => {
      if (destroyed || meta.source === context.instanceId) return;
      settings = normalizeProposalSettings(next);
      render(false, meta.type === 'save' ? 'Saved.' : '');
    });
    store.load().then((loaded) => {
      if (destroyed) return;
      settings = normalizeProposalSettings(loaded);
      render(false);
    }).catch((e) => {
      if (destroyed) return;
      root.innerHTML = `<div class="cs-note">${escape(e?.message || 'Could not load proposal settings.')}</div>`;
    });
    return {
      destroy(){
        destroyed = true;
        unsubscribe?.();
      }
    };
  }
  function registerSettingsPages(){
    const pages = window.FirstMateSettingsPages;
    if (!pages || registerSettingsPages.done) return;
    registerSettingsPages.done = true;
    pages.registerPage({
      id: 'proposals',
      title: 'Proposal Settings',
      subtitle: 'Branch defaults for new proposals.',
      icon: 'fa-file-signature',
      render: renderReusableProposalSettingsPage
    });
  }
  registerSettingsPages();
  function platformUserFromDocument(doc){
    if (window.PlatformAPI?.users?.normalize) return window.PlatformAPI.users.normalize(doc || {});
    const data = doc?.data && typeof doc.data === 'object' ? doc.data : (doc || {});
    const orgPermissions = data.org_permissions && typeof data.org_permissions === 'object' ? data.org_permissions : {};
    const level = orgPermissions.level || data.org_permission_level || data.permission_level || data.role || 'viewer';
    const items = orgPermissions.items || data.permissions || {};
    return {
      id: doc?.id || data.id || '',
      ...data,
      org_permissions: { level, items },
      org_permission_level: level,
      disabled: data.disabled === true || data.status === 'disabled'
    };
  }
  let state = null;
  const viewState = {
    activeTab: '',
    activeLeadPane: '',
    previewMode: 'desktop'
  };
  let usersState = {
    list: [],
    itemsById: {},
    showPerms: true,
    superAdmins: [],
    openMenuUserId: null,
  };
  let msState = {
    month: new Date().getMonth() + 1,
    year: new Date().getFullYear(),
    loading: false,
    data: null,
    cache: {},
  };
  function clampHex(hex, fallback){
    let h = String(hex || '').trim().toUpperCase();
    if (!h) return fallback;
    if (!h.startsWith('#')) h = '#'+h;
    if (!/^#[0-9A-F]{6}$/.test(h)) return fallback;
    return h;
  }
  function hexToRgbCSV(hex){
    try{
      const h = clampHex(hex, DEFAULT_PRIMARY).slice(1);
      const r = parseInt(h.slice(0,2),16);
      const g = parseInt(h.slice(2,4),16);
      const b = parseInt(h.slice(4,6),16);
      return `${r},${g},${b}`;
    }catch(e){
      return '217,48,37';
    }
  }
  function darken(hex, amt=0.16){
    try{
      const h = clampHex(hex, DEFAULT_PRIMARY).slice(1);
      const r = parseInt(h.slice(0,2),16), g = parseInt(h.slice(2,4),16), b = parseInt(h.slice(4,6),16);
      const d = (n)=>Math.max(0,Math.min(255,Math.round(n*(1-amt)))).toString(16).padStart(2,'0').toUpperCase();
      return '#'+d(r)+d(g)+d(b);
    }catch(e){
      return '#b0261e';
    }
  }
  function cacheTheme(theme){
    try{ localStorage.setItem(LS_KEY, JSON.stringify(theme || {})); }catch(e){}
  }
  function readCachedTheme(){
    try{
      const raw = localStorage.getItem(LS_KEY);
      if (!raw) return null;
      const obj = JSON.parse(raw);
      if (!obj || typeof obj !== 'object') return null;
      return obj;
    }catch(e){ return null; }
  }
  function currentThemeSnapshot(){
    const theme = window.Portal?.currentTheme || window.__APP?.theme || null;
    if (!theme || typeof theme !== 'object') return null;
    const logo = String(theme.logo || theme.logo_url || '').trim();
    return {
      name: String(theme.name || theme.companyName || '').trim(),
      logo: logo && logo !== DEFAULT_LOGO ? logo : null,
      primary: theme.primary || theme.accent || null,
      secondary: theme.secondary || null
    };
  }
  function companyLogoForSave(){
    const logo = String(state?.logo || '').trim();
    return logo && logo !== DEFAULT_LOGO ? logo : null;
  }
  function portalAssetUrl(url){
    const raw = String(url || '').trim();
    if (!raw) return '';
    if (/^(https?:|blob:|data:)/i.test(raw)) return raw;
    if (raw.startsWith('/v1/')) {
      try {
        const configured = String(window.__APP?.platformApiBase || '').trim().replace(/\/+$/, '');
        const host = String(location.hostname || '').toLowerCase();
        const base = configured || (host === '127.0.0.1' || host === 'localhost'
          ? ''
          : `${location.origin}/v1/platform`);
        if (!base) return '';
        return new URL(raw, base).href;
      } catch(e) {
        return raw;
      }
    }
    if (raw.startsWith('/')) return raw;
    if (raw.startsWith('organizations/')) {
      const configured = String(window.__APP?.platformApiBase || '').trim().replace(/\/+$/, '');
      const host = String(location.hostname || '').toLowerCase();
      const base = configured || (host === '127.0.0.1' || host === 'localhost'
        ? ''
        : `${location.origin}/v1/platform`);
      if (!base) return '';
      return `${base}/${raw}`;
    }
    return raw;
  }
  function logoFromBranding(branding, orgId = currentOrgId()){
    const b = branding && typeof branding === 'object' ? branding : {};
    const canonicalLogo = String(b.logo || '').trim();
    if (canonicalLogo === DEFAULT_LOGO) return '';
    if (/^(https?:|blob:|data:|\/v1\/)/i.test(canonicalLogo)) return portalAssetUrl(canonicalLogo);
    const direct = b.logo_node_url || b.logoNodeUrl || b.logo_url || b.logoUrl || b.companyLogo || b.brandLogo;
    if (direct) {
      const directLogo = String(direct).trim();
      return directLogo === DEFAULT_LOGO ? '' : directLogo;
    }
    const mediaId = b.logo_media_id || b.logoMediaId || b.logo_media || b.logoMedia;
    if (mediaId && orgId && window.PlatformAPI?.media?.fileUrl) return window.PlatformAPI.media.fileUrl(orgId, mediaId, 'original');
    return canonicalLogo;
  }
  function isLegacyOrgLogo(url){
    const raw = String(url || '').trim();
    return /(^|\/)organizations\/[^/?#]+\/logo\.png(?:[?#].*)?$/i.test(raw);
  }
  function shouldReplaceLogo(currentLogo, candidateLogo){
    const current = String(currentLogo || '').trim();
    const candidate = String(candidateLogo || '').trim();
    if (!candidate) return false;
    if (!current) return true;
    if (isLegacyOrgLogo(candidate) && (current.includes('/v1/platform/') || /^https?:\/\//i.test(current) || current.startsWith('/v1/'))) return false;
    return true;
  }
  function withoutCacheBust(value){
    const raw = String(value || '').trim();
    if (!raw) return '';
    try {
      const parsed = new URL(raw, location.href);
      parsed.searchParams.delete('v');
      return parsed.href;
    } catch(e) {
      return raw.replace(/([?&])v=[^&#]*(&?)/, (match, prefix, suffix) => suffix ? prefix : '');
    }
  }
  function setImgSmart(imgEl, url, { forceBust=false, bustKey=0 } = {}){
    if (!imgEl) return;
    const requested = String(url || '').trim();
    const isShellLogo = imgEl.id === 'companyLogoImg' || imgEl.id === 'mobLogoImg';
    const useDefaultSidebarLogo = requested === DEFAULT_LOGO && isShellLogo;
    const base = useDefaultSidebarLogo ? DEFAULT_LOGO : portalAssetUrl(requested);
    imgEl.onerror = null;
    if (isShellLogo) {
      document.querySelector('.logo-area')?.classList.toggle('default-firstmeasure-logo', useDefaultSidebarLogo);
      document.querySelector('.mobile-topbar .mob-logo')?.classList.toggle('default-firstmeasure-logo', useDefaultSidebarLogo);
    }
    if (!base) {
      imgEl.removeAttribute('src');
      imgEl.style.display = 'none';
      imgEl.removeAttribute('data-last-url');
      return;
    }
    if (useDefaultSidebarLogo) {
      imgEl.removeAttribute('src');
      imgEl.setAttribute('data-last-url', DEFAULT_LOGO);
      imgEl.style.display = 'none';
      return;
    }
    imgEl.onerror = function(){
      imgEl.removeAttribute('src');
      imgEl.style.display = 'none';
    };
    const finalUrl = forceBust && bustKey
      ? (base + (base.includes('?') ? '&' : '?') + 'v=' + String(bustKey))
      : base;
    if (!forceBust && withoutCacheBust(imgEl.src) === withoutCacheBust(base)) {
      imgEl.setAttribute('data-last-url', imgEl.src || base);
      imgEl.style.display = 'block';
      return;
    }
    if (imgEl.getAttribute('data-last-url') === finalUrl) return;
    imgEl.setAttribute('data-last-url', finalUrl);
    imgEl.src = finalUrl;
    imgEl.style.display = 'block';
  }
  function applyCssVars(primary, secondary){
      const p = clampHex(primary, DEFAULT_PRIMARY);
      const s = clampHex(secondary, DEFAULT_SECONDARY);
      document.documentElement.style.setProperty('--primary', p);
      document.documentElement.style.setProperty('--primary-rgb', hexToRgbCSV(p));
      document.documentElement.style.setProperty('--primary-dark', darken(p, 0.16));
      document.documentElement.style.setProperty('--secondary', s);
      // Keep contrast vars in sync during live preview
      const tc = window.__themeContrast;
      if (tc) {
        const onP = tc.contrastTextFor(p);
        document.documentElement.style.setProperty('--on-primary', onP);
        document.documentElement.style.setProperty('--on-primary-rgb', tc.hexToRgbCSV(onP));
        document.documentElement.style.setProperty('--primary-readable', tc.readableOnWhite(p));
      }
      const meta = document.querySelector('meta[name="theme-color"]');
      if (meta) meta.setAttribute('content', p);
  }

  function mergeGeneralReportSettings(rs){
    const out = Object.assign({}, DEFAULT_GENERAL_REPORT_SETTINGS);
    if (rs && typeof rs === 'object'){
      if ('nfva_ratio' in rs) out.nfva_ratio = rs.nfva_ratio;
    }
    out.nfva_ratio = Math.max(1, Math.min(1000, parseInt(out.nfva_ratio, 10) || DEFAULT_GENERAL_REPORT_SETTINGS.nfva_ratio));
    return out;
  }
  function mergeCustomerReportSettings(rs){
    const out = Object.assign({}, DEFAULT_CUSTOMER_REPORT_SETTINGS);
    if (rs && typeof rs === 'object'){
      for (const k of Object.keys(out)){
        if (k in rs) out[k] = rs[k];
      }
    }
    for (const k of Object.keys(out)) out[k] = !!out[k];
    return out;
  }
  function normLevel(u){
    const lvl = (u && u.org_permissions && u.org_permissions.level) ? u.org_permissions.level : 'viewer';
    return String(lvl || 'viewer').toLowerCase().trim();
  }
  function normEmail(u){
    return String(u?.email || '').toLowerCase().trim();
  }
  function asBoolMap(m){
    const out = {};
    if (m && typeof m === 'object'){
      for (const k of Object.keys(m)) out[k] = !!m[k];
    }
    return out;
  }
  function effectivePerms(u){
    const eff = (u && u.effective_permissions && typeof u.effective_permissions === 'object') ? u.effective_permissions : {};
    return asBoolMap(eff);
  }
  function levelLabel(lvl){
    const x = String(lvl || '').toLowerCase().trim();
    const hit = LEVEL_OPTIONS.find(o => o.v === x);
    return hit ? hit.label : (x ? x : 'Viewer');
  }
  function clonedLevelPerms(level){
    const key = String(level || '').toLowerCase().trim();
    const src = LEVEL_PERM_DEFAULTS[key];
    if (!src || typeof src !== 'object') return {};
    return Object.assign({}, src);
  }
  function effectiveOrLocalPermsForUser(u, userId){
    const lvl = normLevel(u) || 'viewer';
    if (lvl === 'custom') {
      return Object.assign({}, usersState.itemsById[userId] || asBoolMap(u?.org_permissions?.items || {}));
    }
    const preset = clonedLevelPerms(lvl);
    if (Object.keys(preset).length) return preset;
    return asBoolMap(effectivePerms(u));
  }
  function effectivePermsForLevel(level, items){
    const lvl = String(level || 'viewer').toLowerCase().trim();
    if (lvl === 'custom') return Object.assign({}, asBoolMap(items || {}));
    const preset = clonedLevelPerms(lvl);
    if (Object.keys(preset).length) return preset;
    return Object.assign({}, asBoolMap(items || {}));
  }
  function permissionHintText(level, canEdit){
    return canEdit ? '' : 'Permissions are read-only.';
  }
  function userInitial(name, email){
    const raw = String(name || email || '?').trim();
    return raw ? raw.charAt(0).toUpperCase() : '?';
  }
  function userAvatarUrl(u){
    return portalAssetUrl(u?.profile_photo_url || u?.profile_photo || '');
  }
  function renderRolePresetButtons(activeLevel, disabled){
    const isDisabled = !!disabled;
    return LEVEL_PRESET_META.map(meta => {
      const active = String(activeLevel || '').toLowerCase().trim() === meta.v ? 'active' : '';
      return `<button class="cu-roleBtn ${active}" data-role="${escapeHtml(meta.v)}" type="button" ${isDisabled ? 'disabled' : ''}><i class="fas ${meta.icon}"></i> ${escapeHtml(meta.label)}</button>`;
    }).join('') + `<button class="cu-roleBtn custom ${String(activeLevel || '').toLowerCase().trim() === 'custom' ? 'active' : ''}" data-role="custom" type="button" ${isDisabled ? 'disabled' : ''}><i class="fas fa-sliders"></i> Custom</button>`;
  }
  function renderPermissionButtons(items, disabled){
    const isDisabled = !!disabled;
    return PERM_META.map(pm => {
      const on = !!items[pm.k];
      return `<button class="cu-pbtn ${on ? 'on' : 'off'} ${isDisabled ? 'ro' : ''}" data-perm="${escapeHtml(pm.k)}" type="button" ${isDisabled ? 'disabled' : ''}><span class="dot"></span><span>${escapeHtml(pm.label)}</span></button>`;
    }).join('');
  }
  function safeInt(v, fallback=0){
    const n = parseInt(String(v ?? '').replace(/[^\d\-]/g,''), 10);
    return Number.isFinite(n) ? n : fallback;
  }
  function clampMoney(v, min){
    const n = safeInt(v, min);
    return Math.max(min, n);
  }
  function moneySettingOrDefault(obj, key, fallback){
    if (!obj || typeof obj !== 'object' || !Object.prototype.hasOwnProperty.call(obj, key)) return fallback;
    return clampMoney(obj[key], BILL_MIN);
  }
  async function billingFetchHistory(limit = 200){
    const orgId = currentOrgId();
    if (orgId && window.PlatformAPI?.credits?.get) {
      try {
        const result = await window.PlatformAPI.credits.get(orgId, { limit });
        return { ok:true, events: [], ledger: result.ledger || result.events || [] };
      } catch(e) {
        // Fall back to the PHP bridge while the Platform credits API is being reshaped.
      }
    }
    const { data } = await postAction('org_billing_history_my', { limit: String(limit|0) });
    if (!data || !data.success) return { ok:false, error: data?.error || 'Could not load billing history' };
    return { ok:true, events: data.events || [], ledger: data.ledger || [] };
  }
  // **** Monthly Statement API ----
  async function fetchMonthlyStatement(month, year){
    const { data } = await postAction('org_monthly_statement', {
      month: String(month|0),
      year: String(year|0)
    });
    if (!data || !data.success) return { ok:false, error: data?.error || 'Could not load statement' };
    return {
      ok: true,
      month: data.month,
      year: data.year,
      month_label: data.month_label || '',
      transactions: data.transactions || data.ledger || [],
      ledger: data.ledger || data.transactions || [],
      orders: data.orders || [],
      total_transactions: data.total_transactions || 0,
      total_orders: data.total_orders || 0,
      total_payments: data.total_payments || 0,
      total_in: data.total_in || 0,
      total_out: data.total_out || 0,
      net_change: data.net_change || 0,
      total_spent: data.total_spent || 0,
      by_type: data.by_type || {}
    };
  }
  // ---------------- Org API ----------------
  async function fetchOrg(){
    const orgId = currentOrgId();
    let o = null;
    let portalState = null;
    if (orgId && window.PlatformAPI?.orgs?.portalState) {
      portalState = await window.PlatformAPI.orgs.portalState(orgId);
      const branchData = portalState?.branch?.data || {};
      const globalData = portalState?.global?.data || {};
      const organizationData = portalState?.organization?.data || {};
      o = {
        id: portalState?.organization?.id || orgId,
        // Company Settings edits the organization name. A branch label (for
        // example "Default Branch") must never replace the company name.
        name: portalState?.organization?.name || '',
        branding: {
          ...(organizationData.branding || {}),
          ...(globalData.branding || {}),
          ...(branchData.branding || {})
        },
        contact: branchData.contact || {},
        report_settings: branchData.report_settings || {},
        billing: portalState?.billing || globalData.billing || {}
      };
    } else {
      const { data } = await postAction('org_get_my');
      if (!data || !data.success || !data.org) return null;
      o = data.org;
    }
    const rawRS = o?.report_settings || null;
    let general = null, customer = null;
    if (rawRS && typeof rawRS === 'object' && (rawRS.general || rawRS.customer)){
      general = rawRS.general || null;
      customer = rawRS.customer || null;
    } else {
      general = { nfva_ratio: rawRS?.nfva_ratio };
      customer = rawRS;
    }
    const contact = (o?.contact && typeof o.contact === 'object') ? o.contact : {};
    // Billing (optional; comes from server once you wire it)
    const billing = (o?.billing && typeof o.billing === 'object') ? o.billing : {};
    const auto = (billing?.auto_topup && typeof billing.auto_topup === 'object') ? billing.auto_topup : {};
    const stripe = (billing?.stripe && typeof billing.stripe === 'object') ? billing.stripe : {};
    const liveTheme = currentThemeSnapshot();
    const result = {
      id: o.id,
      name: o.name || liveTheme?.name || '',
      logo: logoFromBranding(o?.branding, o.id) || liveTheme?.logo || null,
      primary: o?.branding?.colors?.primary ?? o?.branding?.colors?.accent ?? liveTheme?.primary ?? DEFAULT_PRIMARY,
      secondary: o?.branding?.colors?.secondary ?? liveTheme?.secondary ?? DEFAULT_SECONDARY,
      company_email: contact.email || '',
      company_phone: contact.phone || '',
      company_address: contact.address || '',
      report_general: mergeGeneralReportSettings(general),
      report_customer: mergeCustomerReportSettings(customer),
      billing: {
        auto_topup: {
          enabled: !!auto.enabled,
          threshold_dollars: moneySettingOrDefault(auto, 'threshold_dollars', BILL_DEFAULT_THRESHOLD),
          topup_dollars: moneySettingOrDefault(auto, 'topup_dollars', BILL_DEFAULT_TOPUP),
        },
        stripe: {
          has_payment_method: !!stripe.has_payment_method,
          brand: stripe.brand || '',
          last4: stripe.last4 || '',
          exp_month: stripe.exp_month || '',
          exp_year: stripe.exp_year || '',
        }
      }
    };
    try {
      const orgId = String(currentOrgId() || result.id || '').trim();
      const branchId = currentBranchId();
      if (orgId && window.PlatformAPI?.branches?.get) {
        const branchResp = await window.PlatformAPI.branches.get(orgId, branchId);
        const branch = branchResp?.document?.data || branchResp?.data || {};
        const branchBrand = branch?.branding || {};
        const branchColors = branchBrand?.colors || {};
        if (branch?.contact && typeof branch.contact === 'object') {
          result.company_email = branch.contact.email || result.company_email;
          result.company_phone = branch.contact.phone || result.company_phone;
          result.company_address = branch.contact.address || result.company_address;
        }
        const branchLogo = logoFromBranding(branchBrand, orgId);
        if (shouldReplaceLogo(result.logo, branchLogo)) result.logo = branchLogo;
        if (branchColors.primary || branchColors.accent) result.primary = branchColors.primary || branchColors.accent;
        if (branchColors.secondary) result.secondary = branchColors.secondary;
      }
      if (orgId && window.PlatformAPI?.branchModules?.get) {
        const styleModule = await window.PlatformAPI.branchModules.get(orgId, branchId, 'presentation_style');
        const styleData = styleModule?.data || {};
        const styleBrand = styleData.branding || {};
        const styleColors = styleBrand.colors || {};
        if (styleColors.primary || styleColors.accent) result.primary = styleColors.primary || styleColors.accent;
        if (styleColors.secondary) result.secondary = styleColors.secondary;
        const styleLogo = logoFromBranding(styleBrand, orgId);
        if (shouldReplaceLogo(result.logo, styleLogo)) result.logo = styleLogo;
      }
    } catch(e) {}
    return result;
  }
  async function saveOrg({ name, primary, secondary, company_email, company_phone, company_address }){
    const orgId = currentOrgId();
    if (!orgId) return { ok:false, error:'Missing organization.' };
    const canSaveBranch = !!(window.PlatformAPI?.branches?.get && window.PlatformAPI?.branches?.save);
    if (canSaveBranch) {
      // Keep the organization name authoritative for Company Settings and
      // Internal Customers. Branch names are separate labels and are preserved.
      if (window.PlatformAPI?.orgs?.patch) {
        await window.PlatformAPI.orgs.patch(orgId, { name: name ?? '' });
      } else {
        const { data } = await postAction('org_update_my', { name: name ?? '' });
        if (!data || !data.success) return { ok:false, error: data?.error || 'Save failed' };
      }
      const branchId = currentBranchId();
      const branchResp = await window.PlatformAPI.branches.get(orgId, branchId).catch(() => null);
      const branch = branchResp?.document?.data || branchResp?.data || {};
      const existingBranchLogo = String(branch.branding?.logo || '').trim();
      await window.PlatformAPI.branches.save(orgId, branchId, {
        ...branch,
        name: branch.name ?? '',
        contact: {
          ...(branch.contact || {}),
          email: company_email ?? '',
          phone: company_phone ?? '',
          address: company_address ?? ''
        },
        branding: {
          ...(branch.branding || {}),
          logo: existingBranchLogo && existingBranchLogo !== DEFAULT_LOGO ? existingBranchLogo : companyLogoForSave(),
          colors: {
            ...(branch.branding?.colors || {}),
            primary: primary ?? '',
            secondary: secondary ?? '',
            accent: primary ?? ''
          }
        }
      }, { source: 'company_settings' });
    } else {
      const { data } = await postAction('org_update_my', {
        name: name ?? '',
        accent: primary ?? '',
        secondary: secondary ?? '',
        company_email: company_email ?? '',
        company_phone: company_phone ?? '',
        company_address: company_address ?? ''
      });
      if (!data || !data.success) return { ok:false, error: data?.error || 'Save failed' };
    }
    try {
      const branchId = currentBranchId();
      if (orgId && window.PlatformAPI?.branchModules?.get && window.PlatformAPI?.branchModules?.save) {
        const styleModule = await window.PlatformAPI.branchModules.get(orgId, branchId, 'presentation_style');
        const styleData = styleModule?.data || {};
        await window.PlatformAPI.branchModules.save(orgId, branchId, 'presentation_style', {
          ...styleData,
          companyName: name ?? styleData.companyName ?? '',
          branding: {
            ...(styleData.branding || {}),
            colors: {
              ...(styleData.branding?.colors || {}),
              primary: primary ?? '',
              secondary: secondary ?? '',
              accent: primary ?? ''
            }
          }
        }, { kind: 'branch_presentation_style', source: 'company_settings' });
      }
    } catch(e) {}
    return { ok:true };
  }
  async function saveReportSettings({ general, customer }){
    const payload = {
      general: mergeGeneralReportSettings(general),
      customer: mergeCustomerReportSettings(customer)
    };
    const orgId = currentOrgId();
    if (orgId && window.PlatformAPI?.branches?.get && window.PlatformAPI?.branches?.save) {
      const branchId = currentBranchId();
      const branchResp = await window.PlatformAPI.branches.get(orgId, branchId).catch(() => null);
      const branch = branchResp?.document?.data || branchResp?.data || {};
      await window.PlatformAPI.branches.save(orgId, branchId, {
        ...branch,
        report_settings: payload
      }, { source: 'company_report_settings' });
    } else {
      const { data } = await postAction('org_update_my_report_settings', {
        report_settings_json: JSON.stringify(payload)
      });
      if (!data || !data.success) return { ok:false, error: data?.error || 'Save failed' };
    }
    return { ok:true };
  }
  async function uploadLogo(file){
    const APP = window.Portal.cfg || {};
    const fd = new FormData();
    fd.append('action', 'org_upload_logo_my');
    fd.append('actor_email', window.__APP?.userEmail || '');
    fd.append('actor_name', window.__APP?.userName || '');
    fd.append('actor_org_id', window.__APP?.userOrgId || '');
    fd.append('logo', file);
    const res = await fetch(APP.serverEndpoint, { method:'POST', body: fd });
    const data = await res.json().catch(()=>null);
    if (!data || !data.success) return { ok:false, error: data?.error || 'Upload failed' };
    return { ok:true, logo: data.logo || null };
  }
  async function uploadUserAvatar({ userId, file }){
    const APP = window.Portal.cfg || {};
    const fd = new FormData();
    fd.append('action', 'org_users_upload_avatar_my');
    fd.append('actor_email', window.__APP?.userEmail || '');
    fd.append('actor_name', window.__APP?.userName || '');
    fd.append('actor_org_id', window.__APP?.userOrgId || '');
    fd.append('user_id', userId || '');
    fd.append('avatar', file);
    const res = await fetch(APP.serverEndpoint, { method:'POST', body:fd });
    const data = await res.json().catch(()=>null);
    if (!data || !data.success) return { ok:false, error: data?.error || 'Upload failed' };
    return { ok:true, avatar_url: data.avatar_url || '', user: data.user || null };
  }
  // Billing actions (server hooks you'll add)
  async function billingStartSetup(){
    const { data } = await postAction('billing_autotopup_setup_start', {});
    if (!data || !data.success || !data.url) return { ok:false, error: data?.error || 'Could not start card setup' };
    return { ok:true, url: data.url };
  }
  async function billingSaveAutoTopup({ enabled, threshold_dollars, topup_dollars }){
    const billingPatch = {
      auto_topup: {
        enabled: !!enabled,
        threshold_dollars: clampMoney(threshold_dollars, BILL_MIN),
        topup_dollars: clampMoney(topup_dollars, BILL_MIN)
      }
    };
    const orgId = currentOrgId();
    if (orgId && window.PlatformAPI?.orgs?.patchGlobal) {
      const global = await window.PlatformAPI.orgs.getGlobal(orgId).catch(() => null);
      const currentBilling = global?.document?.data?.billing || {};
      await window.PlatformAPI.orgs.patchGlobal(orgId, {
        billing: {
          ...currentBilling,
          auto_topup: {
            ...(currentBilling.auto_topup || {}),
            ...billingPatch.auto_topup
          }
        }
      });
      return { ok:true, billing: { ...currentBilling, auto_topup: { ...(currentBilling.auto_topup || {}), ...billingPatch.auto_topup } } };
    }
    const { data } = await postAction('org_update_my_billing', {
      billing_json: JSON.stringify(billingPatch)
    });
    if (!data || !data.success) return { ok:false, error: data?.error || 'Save failed' };
    return { ok:true, billing: data.billing || null };
  }
  // **** Users API ----
  async function usersList(){
    const orgId = currentOrgId();
    if (orgId && window.PlatformAPI?.users?.list) {
      const result = await window.PlatformAPI.users.list(orgId);
      return { ok:true, users: result.users || [] };
    }
    const { data } = await postAction('org_users_list_my');
    if (!data || !data.success) return { ok:false, error: data?.error || 'List failed' };
    return { ok:true, users: data.users || [] };
  }
  async function userAdd({ email, name, permLevel, permItems }){
    const orgId = currentOrgId();
    if (orgId && window.PlatformAPI?.users?.create) {
      const result = await window.PlatformAPI.users.create(orgId, {
        email: email || '',
        name: name || '',
        role: permLevel || 'viewer',
        status: 'invited',
        permissions: permItems || {},
        account_type: 'customer'
      });
      return {
        ok:true,
        user: platformUserFromDocument(result.document || {}),
        emailed: !!(result.emailed || result.email_sent),
        activate_url: result.activate_url || result.invite?.activate_url || null,
        error: result.invite?.error || ''
      };
    }
    const { data } = await postAction('org_users_add_my', {
      email: email || '',
      name: name || '',
      perm_level: permLevel || 'viewer',
      perm_items_json: JSON.stringify(permItems || {})
    });
    if (!data || !data.success) return { ok:false, error: data?.error || 'Add failed' };
    return { ok:true, user: data.user || null, emailed: !!data.emailed, activate_url: data.activate_url || null };
  }
  async function userSetDisabled({ userId, disabled }){
    const orgId = currentOrgId();
    if (orgId && window.PlatformAPI?.users?.setDisabled) {
      const result = await window.PlatformAPI.users.setDisabled(orgId, userId || '', !!disabled);
      return { ok:true, user: platformUserFromDocument(result.document || {}) };
    }
    const { data } = await postAction('org_users_set_disabled_my', {
      user_id: userId || '',
      disabled: disabled ? 'true' : 'false'
    });
    if (!data || !data.success) return { ok:false, error: data?.error || 'Update failed' };
    return { ok:true, user: data.user || null };
  }
  async function userResendInvite({ userId }){
    const orgId = currentOrgId();
    if (orgId && window.PlatformAPI?.users?.resendInvite) {
      const result = await window.PlatformAPI.users.resendInvite(orgId, userId || '');
      return {
        ok: !!(result.ok || result.success || result.emailed || result.email_sent),
        emailed: !!(result.emailed || result.email_sent || result.ok),
        activate_url: result.activate_url || '',
        error: result.error || result.message || ''
      };
    }
    return { ok:false, error:'Invite resend is unavailable.' };
  }
  async function userUpdate({ userId, email, name }){
    const orgId = currentOrgId();
    if (orgId && window.PlatformAPI?.users?.patch) {
      const result = await window.PlatformAPI.users.patch(orgId, userId || '', {
        email: String(email || '').trim().toLowerCase(),
        name: name || ''
      }, { source: 'org_users_update' });
      return { ok:true, user: platformUserFromDocument(result.document || {}), sessionUpdated:false };
    }
    const { data } = await postAction('org_users_update_my', {
      user_id: userId || '',
      email: email || '',
      name: name || ''
    });
    if (!data || !data.success) return { ok:false, error: data?.error || 'Update failed' };
    return { ok:true, user: data.user || null, sessionUpdated: !!data.session_updated };
  }
  async function userSoftDelete({ userId }){
    const orgId = currentOrgId();
    if (orgId && window.PlatformAPI?.users?.remove) {
      await window.PlatformAPI.users.remove(orgId, userId || '');
      return { ok:true };
    }
    const { data } = await postAction('org_users_delete_my', { user_id: userId || '' });
    if (!data || !data.success) return { ok:false, error: data?.error || 'Delete failed' };
    return { ok:true };
  }
  async function userSetPerms({ userId, permLevel, permItems }){
    const orgId = currentOrgId();
    if (orgId && window.PlatformAPI?.users?.setPermissions) {
      const result = await window.PlatformAPI.users.setPermissions(orgId, userId || '', permLevel || 'viewer', permItems || {});
      return { ok:true, user: platformUserFromDocument(result.document || {}) };
    }
    const { data } = await postAction('org_users_set_perms_my', {
      user_id: userId || '',
      perm_level: permLevel || 'viewer',
      perm_items_json: JSON.stringify(permItems || {})
    });
    if (!data || !data.success) return { ok:false, error: data?.error || 'Update failed' };
    return { ok:true, user: data.user || null };
  }
  function logoKey(url){ return (url && String(url).trim()) ? String(url).trim() : ''; }
  function makeToggleBtn({ key, label, value }){
    return `
      <button class="rp-toggle ${value ? 'on' : 'off'}" data-key="${escapeHtml(key)}" data-val="${value ? '1' : '0'}" type="button">
        <span class="rp-dot"></span>
        <span class="rp-label">${escapeHtml(label)}</span>
        <span class="rp-state">${value ? 'On' : 'Off'}</span>
      </button>
    `;
  }
  const DEFAULT_VISIBLE_APP_FLAGS = {
    platform: [],
    email: [],
    canvassing: [],
    calls: [],
    firstmeasure: ['report_orders', 'report_cancellations'],
    lead_forms: []
  };
  const FRONTEND_APP_FLAG_DEFINITIONS = [
    {
      key: 'platform.user_modals',
      group: 'platform',
      flag: 'user_modals',
      defaultValue: false,
      label: 'User Modals',
      description: 'Enable clickable user profile modals with uploaded-photo views.'
    },
    {
      key: 'platform.user_activity',
      group: 'platform',
      flag: 'user_activity',
      defaultValue: false,
      label: 'User Activity',
      description: 'Show activity streams in user profile modals.'
    },
    {
      key: 'platform.storage_limits',
      group: 'platform',
      flag: 'storage_limits',
      defaultValue: false,
      label: 'Storage Limits',
      description: 'Show storage usage and enforce media upload limits.'
    },
    {
      key: 'platform.purchasable_storage',
      group: 'platform',
      flag: 'purchasable_storage',
      defaultValue: false,
      label: 'Purchasable Storage',
      description: 'Show Get More Storage buttons and checkout entry points.'
    },
    {
      key: 'platform.free_storage_gb',
      group: 'platform',
      flag: 'free_storage_gb',
      type: 'number',
      min: 0,
      step: 0.25,
      defaultValue: 1,
      label: 'Free Storage GB',
      description: 'Included media storage in gigabytes before upload limits apply.'
    },
    {
      key: 'platform.proposals',
      group: 'platform',
      flag: 'proposals',
      defaultValue: false,
      label: 'Proposals',
      description: 'Enables proposal creation, proposal tabs, and proposal settings.'
    },
    {
      key: 'platform.project_docs',
      group: 'platform',
      flag: 'project_docs',
      defaultValue: false,
      label: 'Project Docs',
      description: 'Enables project document storage, required documents, and document markup workflows.'
    },
    {
      key: 'platform.crew_management',
      group: 'platform',
      flag: 'crew_management',
      defaultValue: false,
      label: 'Crew Management',
      description: 'Enables crew setup, labor compensation plans, and crew-aware scheduling.',
      requires: ['platform.scheduling']
    },
    {
      key: 'platform.left_column_todo_list',
      group: 'platform',
      flag: 'left_column_todo_list',
      defaultValue: false,
      label: 'Left Column To Do List',
      description: "Show the Apps/To Do switcher and today's action-item list in the portal left column."
    },
    {
      key: 'platform.cobrand_sidebar_logo',
      group: 'platform',
      flag: 'cobrand_sidebar_logo',
      defaultValue: false,
      label: 'Co-Branded Sidebar Logo',
      description: 'Show the FirstMate logo in the org primary color before the company logo in the portal sidebar.'
    },
    {
      key: 'platform.new_button_mode',
      group: 'platform',
      flag: 'new_button_mode',
      type: 'select',
      defaultValue: 'report',
      label: 'New Button Mode',
      description: 'Choose whether the sidebar New button opens the selector or directly starts one workflow.',
      options: [
        ['selector', 'Selector menu'],
        ['project', 'New Project'],
        ['contact', 'New Contact'],
        ['report', 'New Report'],
        ['proposal', 'New Proposal'],
        ['appointment', 'New Appointment']
      ]
    },
    {
      key: 'platform.proposal_agent',
      group: 'platform',
      flag: 'proposal_agent',
      defaultValue: false,
      label: 'Proposal Agent',
      description: 'Show the AI prompt panel inside the proposal builder.'
    },
    {
      key: 'calls.app',
      group: 'calls',
      flag: 'app',
      defaultValue: false,
      label: 'Calls',
      description: 'Enables the Calls tab and call workflow settings.'
    },
    {
      key: 'firstmeasure.report_orders',
      group: 'firstmeasure',
      flag: 'report_orders',
      defaultValue: true,
      label: 'Report Orders',
      description: 'Enables ordering FirstMeasure roof measurement reports.'
    },
    {
      key: 'firstmeasure.gutter_reports',
      group: 'firstmeasure',
      flag: 'gutter_reports',
      defaultValue: false,
      label: 'Gutter Reports',
      description: 'Enables roof and gutter measurement report options.',
      requires: ['firstmeasure.report_orders']
    },
    {
      key: 'firstmeasure.weather_reports',
      group: 'firstmeasure',
      flag: 'weather_reports',
      defaultValue: false,
      label: 'Historical Weather Reports',
      description: 'Enables historical severe-weather report ordering and project report tabs.',
      requires: ['firstmeasure.report_orders']
    },
    {
      key: 'firstmeasure.measurement_report_summary',
      group: 'firstmeasure',
      flag: 'measurement_report_summary',
      defaultValue: false,
      label: 'Measurement Report Summary',
      description: 'Enables the gated roof report summary sub-tab in project reports.',
      requires: ['firstmeasure.report_orders']
    },
    {
      key: 'firstmeasure.report_expedite_options',
      group: 'firstmeasure',
      flag: 'report_expedite_options',
      defaultValue: false,
      label: 'Report Expedite Options',
      description: 'Enables customer-facing turnaround choices and after-the-fact expediting for report orders.',
      requires: ['firstmeasure.report_orders']
    },
    {
      key: 'firstmeasure.report_cancellations',
      group: 'firstmeasure',
      flag: 'report_cancellations',
      defaultValue: true,
      label: 'Report Cancellations',
      description: 'Enables customer cancellation of report orders during the grace period.',
      requires: ['firstmeasure.report_orders']
    },
    {
      key: 'firstmeasure.report_followup',
      group: 'firstmeasure',
      flag: 'report_followup',
      defaultValue: false,
      label: 'Report Follow-up',
      description: 'Enables customer issue reports, correction requests, additional structure requests, and the Changes Pending tab.',
      requires: ['firstmeasure.report_orders']
    },
    {
      key: 'firstmeasure.instant_reports',
      group: 'firstmeasure',
      flag: 'instant_reports',
      defaultValue: false,
      label: 'Instant Reports',
      description: 'Enables FirstMeasure instant report options.',
      requires: ['firstmeasure.report_orders']
    },
    {
      key: 'firstmeasure.referral_program_banner',
      group: 'firstmeasure',
      flag: 'referral_program_banner',
      defaultValue: false,
      label: 'Referral Program Banner',
      description: 'Enables the customer referral banner.'
    }
  ];
  let appFlagsLoadAttempted = false;
  let permissionsLoadAttempted = false;
  function appFlag(group, flag){
    if (appFlagsLoaded()) {
      if (window.PlatformAPI?.appFlags?.has?.(group, flag)) return true;
      const value = window.PlatformAPI?.appFlags?.value?.(group, flag, undefined);
      return typeof value === 'boolean' ? value : (DEFAULT_VISIBLE_APP_FLAGS[group] || []).includes(flag);
    }
    return (DEFAULT_VISIBLE_APP_FLAGS[group] || []).includes(flag);
  }
  function appFlagValue(group, flag, fallback = null){
    if (appFlagsLoaded()) return window.PlatformAPI?.appFlags?.value?.(group, flag, fallback) ?? fallback;
    return fallback;
  }
  function storageLimitsEnabled(){ return appFlag('platform', 'storage_limits'); }
  function purchasableStorageEnabled(){ return appFlag('platform', 'purchasable_storage'); }
  function freeStorageGB(){ return Math.max(0, Number(appFlagValue('platform', 'free_storage_gb', 1) || 1)); }
  function storageLimitBytes(){ return window.PlatformAPI?.mediaStorage?.bytesFromGB?.(freeStorageGB()) || freeStorageGB() * 1024 * 1024 * 1024; }
  function formatStorageBytes(bytes){ return window.PlatformAPI?.mediaStorage?.formatBytes?.(bytes) || `${Math.round(Number(bytes || 0) / (1024 * 1024))} MB`; }
  function leadImportFlagState(){
    const leadImport = appFlag('platform', 'lead_import');
    const inboundEmail = appFlag('email', 'inbound_lead_import');
    const email = inboundEmail || (leadImport && inboundEmail);
    const website = appFlag('platform', 'website_embed_import');
    const canvassing = appFlag('canvassing', 'app');
    const contactForm = website && appFlag('lead_forms', 'contact_form');
    const appointmentForm = website && appFlag('lead_forms', 'appointment_form');
    const instantEstimate = website && appFlag('lead_forms', 'instant_estimate');
    const forms = contactForm || appointmentForm || instantEstimate;
    return {
      email,
      website: website || forms,
      canvassing,
      contactForm,
      appointmentForm,
      instantEstimate,
      forms,
      any: email || website || forms || canvassing
    };
  }
  function appFlagsLoaded(){
    return !!window.PlatformAPI?.appFlags?.current?.();
  }
  function permissionsLoaded(){
    const perms = window.Portal?.currentUser?.permissions;
    return !!(perms && typeof perms === 'object' && Object.keys(perms).length);
  }
  function waitForPermissions(panel){
    if (permissionsLoaded() || permissionsLoadAttempted) return false;
    permissionsLoadAttempted = true;
    panel.innerHTML = `<div style="padding:20px; color:#666; font-weight:850;">Loading settings...</div>`;
    window.Portal?.credits?.refreshCredits?.().then(() => mount(panel)).catch(() => mount(panel));
    return true;
  }
  function waitForAppFlags(panel){
    if (!window.PlatformAPI?.appFlags?.load || appFlagsLoaded() || appFlagsLoadAttempted) return false;
    appFlagsLoadAttempted = true;
    panel.innerHTML = `<div style="padding:20px; color:#666; font-weight:850;">Loading settings...</div>`;
    window.Portal?.appFlags?.load?.().then(() => mount(panel)).catch(() => mount(panel));
    return true;
  }
  // --- MOUNT ---
  function mount(panel){
    if (waitForPermissions(panel)) return;
    if (waitForAppFlags(panel)) return;
    panel.dataset.companySettingsMounted = '1';
    // PERMISSIONS: check what sub-tabs to show
    const canCompany = hasPerm('manage_company_settings');
    const canUsers   = hasPerm('manage_company_users') || hasPerm('manage_company_user_permissions');
    const canReports = hasPerm('manage_report_settings');
    const canBilling = hasPerm('manage_billing');
    const leadFlags = leadImportFlagState();
    const canForms = canCompany && (leadFlags.forms || leadFlags.email);
    const canPricebook = canCompany && appFlag('platform', 'pricebook');
    const canProposalSettings = canCompany && appFlag('platform', 'proposals');
    const canDocuments = canCompany && appFlag('platform', 'project_docs');
    const canConfiguration = canCompany && appFlag('platform', 'configuration');
    const canScheduling = canCompany && appFlag('platform', 'scheduling');
    const canCrews = canCompany && appFlag('platform', 'crew_management');
    const canCallWorkflows = canCompany && appFlag('calls', 'app');
    const canStorage = canCompany && storageLimitsEnabled();
    const canAppFlags = canCompany && window.Portal?.appFlags?.current?.()?.test_admin === true;
    let floatingMenu = null;
    if (!canCompany && !canUsers && !canReports && !canBilling && !canForms && !canPricebook && !canProposalSettings && !canDocuments && !canConfiguration && !canScheduling && !canCrews && !canCallWorkflows && !canStorage && !canAppFlags) {
      panel.innerHTML = `<div style="padding:20px; text-align:center; color:#666; font-weight:800;">Access Denied</div>`;
      return;
    }
    const defaultActiveTab = [
      [canCompany, 'company'],
      [canUsers, 'users'],
      [canReports, 'reports'],
      [canDocuments, 'documents'],
      [canBilling, 'billing'],
      [canScheduling, 'scheduling'],
      [canCrews, 'crews'],
      [canCallWorkflows, 'call_workflows'],
      [canStorage, 'storage'],
      [canAppFlags, 'app_flags'],
      [canForms, 'forms'],
      [canPricebook, 'pricebook'],
      [canProposalSettings, 'proposals'],
      [canConfiguration, 'configuration']
    ].find(([allowed]) => allowed)?.[1] || 'company';
    if (viewState.activeTab === 'lead_import') viewState.activeTab = 'forms';
    const tabAllowed = (tab) => (tab === 'company' && canCompany) || (tab === 'users' && canUsers) || (tab === 'reports' && canReports) || (tab === 'documents' && canDocuments) || (tab === 'billing' && canBilling) || (tab === 'forms' && canForms) || (tab === 'pricebook' && canPricebook) || (tab === 'proposals' && canProposalSettings) || (tab === 'configuration' && canConfiguration) || (tab === 'scheduling' && canScheduling) || (tab === 'crews' && canCrews) || (tab === 'call_workflows' && canCallWorkflows) || (tab === 'storage' && canStorage) || (tab === 'app_flags' && canAppFlags);
    let activeTab = tabAllowed(viewState.activeTab) ? viewState.activeTab : defaultActiveTab;
    viewState.activeTab = activeTab;
    const liveTheme = currentThemeSnapshot();
    state = {
      id:null,
      // The authenticated session carries the organization name. Theme names
      // can be branch labels, so they must not seed the Company name field.
      name:String(window.__APP?.userCompany || '').trim(),
      logo:liveTheme?.logo || null,
      primary:liveTheme?.primary || DEFAULT_PRIMARY,
      secondary:liveTheme?.secondary || DEFAULT_SECONDARY,
      company_email:'',
      company_phone:'',
      company_address:'',
      report_general: mergeGeneralReportSettings(null),
      report_customer: mergeCustomerReportSettings(null),
      billing: {
        auto_topup: {
          enabled: false,
          threshold_dollars: BILL_DEFAULT_THRESHOLD,
          topup_dollars: BILL_DEFAULT_TOPUP
        },
        stripe: {
          has_payment_method: false,
          brand: '',
          last4: '',
          exp_month: '',
          exp_year: ''
        }
      }
    };
    usersState = {
      list: [],
      itemsById: {},
      showPerms: true,
      superAdmins: [],
      openMenuUserId: null,
    };
    let usersRefreshSeq = 0;
    msState = {
      month: new Date().getMonth() + 1,
      year: new Date().getFullYear(),
      loading: false,
      data: null,
      cache: {},
    };
    injectCSS('company_settings', `
      @import url('https://fonts.googleapis.com/css2?family=Inter:wght@400;600;700;800;900&family=Lato:wght@400;700;900&family=Montserrat:wght@400;600;700;800;900&family=Open+Sans:wght@400;700;800&family=Poppins:wght@400;600;700;800;900&family=Roboto:wght@400;700;900&family=Source+Sans+3:wght@400;700;900&display=swap');
      .cs-wrap{ max-width:none; width:100%; margin:0; padding:12px 6px; box-sizing:border-box; }
      .cs-wrap.pricebook-wide{max-width:none}
      .cs-wrap.forms-wide{max-width:none;width:100%;height:100%;min-height:0;margin:0;padding:0;display:flex;flex-direction:column}
      .cs-wrap.forms-wide > .cs-card{flex:1;min-height:0;max-height:100%;overflow:hidden;display:flex;flex-direction:column;box-sizing:border-box}
      .cs-wrap.forms-wide .cs-pane.active{min-height:0;flex:1;display:block}
      .cs-wrap.forms-wide .li-panel.active{height:100%;min-height:0}
      .cs-title{ font-size: 22px; font-weight: 1000; letter-spacing: -.4px; margin:0; }
      .cs-sub{ font-size: 13px; font-weight: 800; color:#666; margin:6px 0 0; }
      .cs-tabs{ display:flex; gap:10px; margin-top:12px; flex-wrap:wrap; }
      @media(max-width:820px){body:has(.mobile-topbar.has-tab-title) .cs-title,body:has(.mobile-topbar.has-tab-title) .cs-sub{display:none}body:has(.mobile-topbar.has-tab-title) .cs-tabs{margin-top:0}}
      .cfg-options{display:grid;grid-template-columns:repeat(auto-fit,minmax(210px,1fr));gap:10px;margin-top:12px}
      .cfg-option{border:1px solid #d8dde6;background:#fff;border-radius:14px;padding:14px;text-align:left;cursor:pointer;display:grid;gap:6px;transition:.14s ease;color:#111827}
      .cfg-option:hover{border-color:rgba(var(--primary-rgb,217,48,37),.35);box-shadow:0 10px 24px rgba(15,23,42,.06)}
      .cfg-option.active{border-color:var(--primary,#d93025);background:rgba(var(--primary-rgb,217,48,37),.06);box-shadow:0 0 0 3px rgba(var(--primary-rgb,217,48,37),.08)}
      .cfg-option strong{font-size:13px;font-weight:1000}
      .cfg-option span{font-size:12px;font-weight:800;color:#667085;line-height:1.45}
      .cfg-actions{display:flex;align-items:center;gap:10px;margin-top:14px}
      .li-emailBox{ display:flex; flex-direction:column; gap:9px; padding:14px; border:1px solid var(--border,#dadce0); border-radius:14px; background:#f8fafc; }
      .li-emailCopyBox{ display:grid; grid-template-columns:1fr 44px; align-items:stretch; border:1px solid #d1d5db; border-radius:10px; background:#fff; overflow:hidden; }
      .li-emailText{ font-size:18px; font-weight:1000; color:#111827; overflow-wrap:anywhere; }
      .li-copyIcon{ border:0; border-left:1px solid #e5e7eb; background:#fff; color:#344054; display:grid; place-items:center; cursor:pointer; font-size:15px; }
      .li-copyIcon:hover{ background:#f8fafc; color:var(--primary-readable,var(--primary,#d93025)); }
      .li-emailCopyBox .li-emailText{ padding:12px 13px; font-size:15px; line-height:1.25; }
      .li-muted{ color:#6b7280; font-size:12px; font-weight:800; line-height:1.45; }
      .li-actions{ display:flex; gap:8px; flex-wrap:wrap; margin-top:12px; }
      .storage-card{display:grid;gap:18px}
      .storage-hero{border:1px solid #eaecf0;border-radius:16px;background:#fff;padding:18px;display:grid;gap:14px}
      .storage-row{display:flex;align-items:flex-start;justify-content:space-between;gap:16px;flex-wrap:wrap}
      .storage-total{font-size:28px;font-weight:1000;color:#101828;line-height:1}.storage-total span{font-size:13px;color:#667085;font-weight:850}
      .storage-bar{height:14px;border-radius:999px;background:#eef2f7;overflow:hidden;border:1px solid #e4e7ec}
      .storage-bar-fill{height:100%;width:0;background:var(--primary,#d93025);border-radius:999px;transition:width .2s ease}
      .storage-meta{display:flex;align-items:center;justify-content:space-between;gap:12px;color:#667085;font-size:12px;font-weight:850;flex-wrap:wrap}
      .storage-trash{border:1px solid #eaecf0;border-radius:14px;background:#f8fafc;padding:14px;display:flex;align-items:center;justify-content:space-between;gap:12px;flex-wrap:wrap}.storage-trash strong{display:block;color:#101828;font-size:14px}.storage-trash span{display:block;margin-top:3px;color:#667085;font-size:12px;font-weight:850}
      .storage-checkout-backdrop{position:fixed;inset:0;z-index:2147483300;background:rgba(15,23,42,.42);backdrop-filter:blur(5px);display:flex;align-items:center;justify-content:center;padding:18px}
      .storage-checkout-modal{width:min(560px,calc(100vw - 36px));min-height:280px;background:#fff;border:1px solid rgba(15,23,42,.1);border-radius:20px;box-shadow:0 28px 80px rgba(15,23,42,.28);display:flex;flex-direction:column;overflow:hidden}
      .storage-checkout-head{display:flex;justify-content:space-between;align-items:flex-start;gap:16px;padding:18px 18px 12px;border-bottom:1px solid #eaecf0}
      .storage-checkout-head strong{font-size:18px;font-weight:1000;color:#101828}.storage-checkout-head span{display:block;margin-top:4px;font-size:13px;font-weight:800;color:#667085;line-height:1.45}
      .storage-checkout-close{width:38px;height:38px;border-radius:13px;border:1px solid #d0d5dd;background:#fff;color:#475467;cursor:pointer}
      .storage-checkout-body{flex:1;display:flex;align-items:center;justify-content:center;padding:24px;color:#98a2b3;font-size:13px;font-weight:900;text-align:center}
      .li-subtabs{display:flex;gap:8px;flex-wrap:wrap;margin:2px 0 14px}
      .li-subtab{border:1px solid #d8dde6;background:#fff;border-radius:999px;padding:8px 11px;font-size:12px;font-weight:1000;cursor:pointer;color:#344054}
      .li-subtab.active{background:#111827;border-color:#111827;color:#fff}
      .li-panel{display:none}.li-panel.active{display:block}
      .li-split{display:grid;grid-template-columns:minmax(220px,300px) 1fr;gap:14px;align-items:start}
      .li-forms-stack{display:grid;grid-template-rows:auto minmax(0,1fr);gap:14px;height:100%;min-height:0}
      .li-list{border:1px solid #e5e7eb;border-radius:12px;background:#fff;overflow:hidden}
      .li-list.horizontal{display:grid;grid-template-columns:repeat(auto-fit,minmax(220px,1fr));gap:0}
      .li-list button{width:100%;border:0;border-bottom:1px solid #eef2f7;background:#fff;text-align:left;padding:11px 12px;cursor:pointer;font-weight:900;color:#111827}
      .li-list button.active{background:#f3f4f6}
      .li-list small{display:block;margin-top:3px;color:#667085;font-size:11px;font-weight:800}
      .li-list .li-instance-add{display:flex;align-items:center;justify-content:center;gap:8px;color:var(--primary-readable,var(--primary,#d93025));border-left:1px solid #eef2f7}
      .li-editor{display:grid;grid-template-columns:minmax(380px,420px) minmax(420px,1fr);gap:14px;align-items:stretch;height:100%;min-height:0;overflow:hidden}
      .li-editor > .cs-card{height:100%;min-height:0;max-height:100%;overflow-y:auto;overflow-x:hidden;overscroll-behavior:contain;display:grid;align-content:start;gap:14px}
      .li-editor .cs-in,.li-editor textarea,.li-editor select{width:100%;max-width:100%;min-width:0;box-sizing:border-box}
      .li-editor .cs-lbl{font-size:9px;letter-spacing:.35px}
      .li-editor .cs-in{font-size:12px;padding:8px 10px;border-radius:10px;font-weight:500}
      .li-formgrid{display:grid;grid-template-columns:minmax(0,1fr) minmax(0,1fr);gap:10px;min-width:0}
      .li-formgrid .wide{grid-column:1/-1}
      .li-preview{border:1px solid #e5e7eb;border-radius:12px;background:#f8fafc;padding:14px;min-height:0;overflow:auto}
      .li-preview-toolbar{display:flex;align-items:center;justify-content:space-between;gap:12px;margin-bottom:12px;flex-wrap:wrap}
      .li-device-toggle{display:inline-flex;border:1px solid #d1d5db;border-radius:10px;overflow:hidden;background:#fff}
      .li-device-toggle button{border:0;border-right:1px solid #e5e7eb;background:#fff;padding:8px 10px;font-size:12px;font-weight:1000;color:#344054;cursor:pointer}
      .li-device-toggle button:last-child{border-right:0}
      .li-device-toggle button.active{background:#111827;color:#fff}
      .li-preview-frame{margin:0 auto;transition:max-width .18s ease}
      .li-preview-frame.desktop{max-width:920px}
      .li-preview-frame.tablet{max-width:680px}
      .li-preview-frame.mobile{max-width:390px;min-height:720px}
      .li-preview-card{border-radius:12px;border:1px solid rgba(15,23,42,.12);background:#fff;box-shadow:0 12px 28px rgba(15,23,42,.10);overflow:hidden}
      .li-preview-head{padding:28px 32px 18px;display:flex;align-items:center;gap:18px}
      .li-preview-head img{height:58px;width:auto;max-width:190px;object-fit:contain;flex:0 0 auto}
      .li-preview-headText{display:grid;gap:7px;min-width:0}
      .li-preview-head h3{margin:0;font-size:30px;font-weight:1000;letter-spacing:0;line-height:1.05}
      .li-preview-head p{margin:0;font-size:14px;font-weight:800;color:#667085;line-height:1.35}
      .li-preview-body{padding:0 32px 30px;display:grid;grid-template-columns:1fr 1fr;gap:14px}
      .li-preview-body .wide{grid-column:1/-1}
      .li-preview-field{border:1px solid #d1d5db;border-radius:8px;padding:10px 11px;color:#111827;font-size:12px;font-weight:800;background:#fff}
      .li-preview-field::placeholder{color:#98a2b3}
      .li-preview-submit{display:block;width:auto;min-width:150px;margin:18px auto 0;border:0;border-radius:8px;padding:10px 18px;background:var(--primary,#d93025);color:#fff;font-weight:1000}
      .li-preview-contact{grid-column:1/-1;display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:14px}
      .li-preview-booking{grid-column:1/-1;display:grid;grid-template-columns:minmax(260px,1.35fr) minmax(150px,.65fr);gap:18px}
      .li-preview-calendar,.li-preview-timepanel{border:1px solid #e5e7eb;border-radius:10px;background:#fff;padding:16px}
      .li-preview-month{font-size:13px;font-weight:1000;color:#111827;margin-bottom:14px}
      .li-preview-calgrid{display:grid;grid-template-columns:repeat(7,1fr);gap:4px}
      .li-preview-dow{text-align:center;font-size:10px;font-weight:1000;color:#667085}
      .li-preview-day{border:0;background:#fff;border-radius:7px;padding:7px 0;text-align:center;font-size:12px;font-weight:950;color:#111827;cursor:pointer}
      .li-preview-day.muted{color:#c1c7d0}
      .li-preview-day.active{background:var(--primary,#d93025);color:#fff}
      .li-preview-mobile-days{display:none;grid-column:1/-1;gap:8px;overflow-x:auto;padding:2px calc(50% - 36px) 8px;scroll-snap-type:x proximity;scroll-behavior:smooth;mask-image:linear-gradient(to right,transparent,#000 14%,#000 86%,transparent);-webkit-mask-image:linear-gradient(to right,transparent,#000 14%,#000 86%,transparent)}
      .li-preview-daypill{border:1px solid #d1d5db;background:#fff;border-radius:10px;min-width:72px;padding:9px 10px;display:grid;gap:3px;text-align:left;scroll-snap-align:start;color:#111827;font-weight:1000}
      .li-preview-daypill span{font-size:11px;color:#667085}.li-preview-daypill b{font-size:18px;line-height:1}
      .li-preview-daypill.active{background:var(--primary,#d93025);border-color:var(--primary,#d93025);color:#fff}.li-preview-daypill.active span{color:#fff}
      .li-preview-time-title{font-size:12px;font-weight:1000;color:#111827;margin-bottom:13px;text-align:center}
      .li-preview-slots{height:218px;overflow-y:auto;display:flex;flex-direction:column;gap:8px;padding:86px 6px;scroll-snap-type:y proximity;scroll-behavior:smooth;mask-image:linear-gradient(to bottom,transparent,#000 18%,#000 82%,transparent);-webkit-mask-image:linear-gradient(to bottom,transparent,#000 18%,#000 82%,transparent)}
      .li-preview-slot{border:1px solid #d1d5db;border-radius:8px;background:#fff;padding:10px;font-size:12px;font-weight:950;color:#111827;text-align:center;scroll-snap-align:center;cursor:pointer}
      .li-preview-slot.active{background:var(--primary,#d93025);border-color:var(--primary,#d93025);color:#fff}
      .li-preview-slot[disabled]{opacity:.54;cursor:not-allowed}
      .li-preview-note{min-height:8px;margin-top:12px;font-size:11px;font-weight:800;color:#667085;line-height:1.35}
      .li-form-section{border:1px solid #e5e7eb;border-radius:12px;background:#fff;padding:14px;display:grid;gap:12px}
      .li-form-section.disabled{opacity:.52;filter:grayscale(.18)}
      .li-section-head{display:flex;justify-content:space-between;align-items:center;gap:12px}
      .li-section-title{font-size:13px;font-weight:1000;color:#111827}
      .li-switch-row{display:flex;align-items:center;justify-content:flex-start;gap:10px}
      .li-style-custom{display:none;grid-template-columns:1fr 1fr;gap:10px;grid-column:1/-1}
      .li-style-custom.active{display:grid}
      .li-font-row{max-width:220px}
      .li-embed-row{display:grid;grid-template-columns:minmax(0,1fr) auto;gap:8px;align-items:start}
      .li-editor .li-embed-row{grid-template-columns:1fr}
      .li-inline-feedback{display:inline-flex;align-items:center;gap:7px}
      .li-day-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(108px,1fr));gap:8px}
      .li-day-button{border:1px solid #d1d5db;border-radius:10px;background:#fff;padding:10px;font-size:12px;font-weight:950;color:#344054;display:flex;align-items:center;justify-content:center;gap:8px;cursor:pointer}
      .li-day-button.active{background:var(--primary-readable,var(--primary,#d93025));border-color:var(--primary-readable,var(--primary,#d93025));color:#fff}
      .li-day-specific{display:none;border:1px solid #e5e7eb;border-radius:12px;background:#f8fafc;padding:12px;margin-top:10px;gap:8px}
      .li-day-specific.active{display:grid}
      .li-day-row{display:grid;grid-template-columns:minmax(110px,1fr) minmax(120px,.8fr) minmax(120px,.8fr);gap:8px;align-items:center}
      .li-day-row.disabled{opacity:.48}
      .li-day-row-title{font-size:12px;font-weight:1000;color:#111827}
      .li-schedule-settings{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:10px;align-items:end;margin-bottom:12px}
      .li-schedule-window{display:grid;grid-template-columns:minmax(170px,.85fr) minmax(220px,1.15fr);gap:12px;align-items:stretch;margin-bottom:12px}
      .li-schedule-stack{display:grid;gap:10px}
      .li-code{font-family:ui-monospace,SFMono-Regular,Consolas,monospace;border:1px solid #d1d5db;border-radius:8px;background:#0f172a;color:#e2e8f0;padding:10px;min-height:94px;font-size:11px;line-height:1.45;resize:vertical;box-sizing:border-box;width:100%;max-width:100%}
      .li-toggleRow{display:flex;align-items:center;justify-content:space-between;gap:14px;border:1px solid #e5e7eb;border-radius:12px;background:#fff;padding:14px}
      .li-switch{position:relative;display:inline-flex;align-items:center;width:48px;height:28px}
      .li-switch input{opacity:0;width:0;height:0}
      .li-slider{position:absolute;cursor:pointer;inset:0;background:#cbd5e1;border-radius:999px;transition:.16s}
      .li-slider:before{content:"";position:absolute;width:22px;height:22px;left:3px;top:3px;background:#fff;border-radius:50%;transition:.16s;box-shadow:0 1px 4px rgba(0,0,0,.25)}
      .li-switch input:checked + .li-slider{background:var(--primary,#d93025)}
      .li-switch input:checked + .li-slider:before{transform:translateX(20px)}
      .li-preview-frame.mobile .li-preview-head{display:grid;gap:10px;padding:22px 20px 14px}
      .li-preview-frame.mobile .li-preview-head img{height:48px;width:auto;max-width:160px}
      .li-preview-frame.mobile .li-preview-body{grid-template-columns:1fr;padding:0 20px 22px}
      .li-preview-frame.mobile .li-preview-contact,.li-preview-frame.mobile .li-preview-booking{grid-template-columns:1fr}
      .li-preview-frame.mobile .li-preview-calendar{display:none}
      .li-preview-frame.mobile .li-preview-mobile-days{display:flex}
      .li-preview-frame.mobile .li-preview-slots{height:210px}
      .li-preview-frame.mobile .li-preview-head h3{font-size:24px}
      .li-preview-frame.tablet .li-estimate-card{min-height:560px;margin:10px;padding:26px 28px}
      .li-preview-frame.tablet .li-estimate-grid{grid-template-columns:repeat(2,minmax(0,1fr))}
      .li-preview-frame.tablet .li-estimate-image-grid{grid-template-columns:repeat(2,minmax(0,1fr))}
      .li-preview-frame.tablet .li-estimate-results{grid-template-columns:1fr}
      .li-preview-frame.tablet .li-estimate-addressbar{left:18px;right:18px;top:18px}
      .li-preview-frame.mobile .li-estimate-shell{border-radius:12px}
      .li-preview-frame.mobile .li-estimate-shell{min-height:720px}
      .li-preview-frame.mobile .li-estimate-card{min-height:720px;margin:0;padding:20px 18px;border-radius:12px}
      .li-preview-frame.mobile .li-estimate-card:before{width:160px;height:160px;right:-70px;bottom:-80px}
      .li-preview-frame.mobile .li-estimate-brand{min-height:640px;gap:14px}
      .li-preview-frame.mobile .li-estimate-brand img{max-height:46px;max-width:170px}
      .li-preview-frame.mobile .li-estimate-brand h3,.li-preview-frame.mobile .li-estimate-title{font-size:23px;line-height:1.12}
      .li-preview-frame.mobile .li-estimate-brand p,.li-preview-frame.mobile .li-estimate-sub{font-size:13px;line-height:1.45}
      .li-preview-frame.mobile .li-estimate-primary{width:100%;min-width:0;padding:12px 16px}
      .li-preview-frame.mobile .li-estimate-body{gap:15px}
      .li-preview-frame.mobile .li-estimate-grid{grid-template-columns:1fr;gap:9px}
      .li-preview-frame.mobile .li-estimate-choice{min-height:82px;padding:13px 14px;grid-template-columns:auto 1fr;align-items:center;align-content:center}
      .li-preview-frame.mobile .li-estimate-choice i{margin:0;font-size:18px}
      .li-preview-frame.mobile .li-estimate-choice b{font-size:14px}
      .li-preview-frame.mobile .li-estimate-choice span{grid-column:2;font-size:11px}
      .li-preview-frame.mobile .li-estimate-image-grid{grid-template-columns:1fr;gap:9px}
      .li-preview-frame.mobile .li-estimate-image-choice{height:112px}
      .li-preview-frame.mobile .li-estimate-map-wrap{height:520px}
      .li-preview-frame.mobile .li-estimate-addressbar{left:12px;right:12px;top:12px;grid-template-columns:1fr;gap:8px}
      .li-preview-frame.mobile .li-estimate-addressbar input{padding:12px;font-size:13px}
      .li-preview-frame.mobile .li-estimate-mask-preview span{font-size:12px;padding:10px 12px}
      .li-preview-frame.mobile .li-estimate-form,.li-preview-frame.mobile .li-estimate-results{grid-template-columns:1fr}
      .li-preview-frame.mobile .li-estimate-result-card,.li-preview-frame.mobile .li-estimate-summary{padding:14px}
      .li-preview-frame.mobile .li-estimate-price{font-size:23px}
      .li-preview-frame.mobile .li-estimate-top{margin-bottom:12px}
      .li-preview-frame.mobile .li-estimate-progress{margin-bottom:14px}
      .li-preview-card,.li-estimate-shell{font-family:var(--li-preview-font,Montserrat,Arial,sans-serif)}
      .li-preview-card :where(input,textarea,button,select,h3,p,div,span,b,label),.li-estimate-shell :where(input,textarea,button,select,h3,p,div,span,b,label){font-family:inherit}
      .li-preview-card :where(input,textarea,p,div,span,label),.li-estimate-shell :where(input,textarea,p,div,span,label){font-weight:400!important}
      .li-preview-card :where(h3,b),.li-estimate-shell :where(h3,b){font-weight:500!important}
      .li-preview-card :where(button),.li-estimate-shell :where(button){font-weight:500!important}
      .li-estimate-shell{--ie-primary:var(--primary-readable,var(--primary,#d93025));--ie-text:#111827;--ie-muted:#667085;color:var(--ie-text);background:#f6f7f9;border:1px solid #e5e7eb;border-radius:14px;overflow:hidden}
      .li-estimate-card{min-height:610px;background:#fff;border-radius:14px;margin:14px;padding:30px 42px;position:relative;overflow:hidden}
      .li-estimate-card:before{content:"";position:absolute;inset:auto -80px -120px auto;width:270px;height:270px;border-radius:50%;background:color-mix(in srgb,var(--ie-primary) 13%,transparent);pointer-events:none}
      .li-estimate-top{display:flex;align-items:center;gap:10px;margin-bottom:18px;position:relative;z-index:1}
      .li-estimate-back{width:32px;height:32px;border:0;border-radius:9px;background:#f3f4f6;color:#111827;display:grid;place-items:center;cursor:pointer}
      .li-estimate-step{font-size:13px;font-weight:950;color:#5f6b7a}
      .li-estimate-brand{display:grid;place-items:center;gap:18px;text-align:center;min-height:500px;position:relative;z-index:1}
      .li-estimate-brand img{max-height:58px;max-width:220px;object-fit:contain}
      .li-estimate-brand h3,.li-estimate-title{margin:0;font-size:30px;line-height:1.08;font-weight:1000;letter-spacing:0;color:var(--ie-text)}
      .li-estimate-brand p,.li-estimate-sub{margin:0;color:var(--ie-muted);font-size:15px;font-weight:800;line-height:1.5;max-width:520px}
      .li-estimate-primary{border:0;border-radius:999px;background:var(--ie-primary);color:#fff;padding:13px 32px;font-weight:1000;font-size:14px;cursor:pointer;display:inline-flex;gap:10px;align-items:center;justify-content:center;min-width:190px}
      .li-estimate-primary.ghost{background:#fff;color:var(--ie-primary);border:2px solid var(--ie-primary)}
      .li-estimate-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(170px,1fr));gap:12px;position:relative;z-index:1}
      .li-estimate-choice{border:1px solid #dfe3e8;border-radius:10px;background:#fff;min-height:132px;padding:18px;text-align:left;display:grid;align-content:center;gap:7px;cursor:pointer;color:#111827;transition:.15s ease}
      .li-estimate-choice:hover,.li-estimate-choice.active{border-color:var(--ie-primary);box-shadow:0 0 0 3px color-mix(in srgb,var(--ie-primary) 14%,transparent)}
      .li-estimate-choice i{font-size:21px;color:var(--ie-primary);margin-bottom:8px}
      .li-estimate-choice b{font-size:17px;font-weight:1000}
      .li-estimate-choice span{font-size:12px;font-weight:800;color:#5f6b7a;line-height:1.4}
      .li-estimate-image-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(190px,1fr));gap:12px}
      .li-estimate-image-choice{height:150px;border:0;border-radius:10px;background-size:cover;background-position:center;overflow:hidden;position:relative;color:#fff;text-align:left;cursor:pointer}
      .li-estimate-image-choice:after{content:"";position:absolute;inset:0;background:linear-gradient(180deg,rgba(0,0,0,.05),rgba(0,0,0,.68))}
      .li-estimate-image-choice b{position:absolute;left:18px;bottom:16px;z-index:1;font-size:18px;font-weight:1000;text-shadow:0 1px 2px rgba(0,0,0,.28)}
      .li-estimate-map-wrap{height:430px;border-radius:10px;overflow:hidden;position:relative;background:#dfe7ef;border:1px solid #e5e7eb}
      .li-estimate-map{position:absolute;inset:0}
      .li-estimate-mask-preview{position:absolute;inset:0;display:grid;place-items:center;background:#eef2f7}
      .li-estimate-mask-preview img{position:absolute;inset:0;width:100%;height:100%;object-fit:cover}
      .li-estimate-mask-preview .mask{opacity:.56;mix-blend-mode:multiply}
      .li-estimate-mask-preview span{position:relative;z-index:1;margin:18px;padding:12px 14px;border-radius:9px;background:rgba(255,255,255,.92);font-size:13px;font-weight:950;color:#111827;text-align:center;box-shadow:0 8px 20px rgba(15,23,42,.08)}
      .li-estimate-addressbar{position:absolute;z-index:2;left:24px;right:24px;top:24px;display:grid;grid-template-columns:1fr auto;gap:12px}
      .li-estimate-addressbar input{border:1px solid #d1d5db;border-radius:9px;padding:14px 15px;font-size:14px;font-weight:850;box-shadow:0 10px 24px rgba(15,23,42,.08)}
      .li-estimate-body{display:grid;gap:22px;position:relative;z-index:1}
      .li-estimate-form{display:grid;grid-template-columns:1fr 1fr;gap:12px}
      .li-estimate-form .wide{grid-column:1/-1}
      .li-estimate-input{border:1px solid #d1d5db;border-radius:9px;padding:13px 14px;font-size:14px;font-weight:850}
      .li-estimate-results{display:grid;grid-template-columns:1fr 1fr;gap:14px;align-items:start}
      .li-estimate-result-card{border:1px solid #e5e7eb;border-radius:12px;background:#fff;padding:18px;box-shadow:0 12px 28px rgba(15,23,42,.06)}
      .li-estimate-price{font-size:28px;font-weight:1000;color:var(--ie-primary);margin:8px 0}
      .li-estimate-summary{border:1px solid #e5e7eb;border-radius:12px;background:#f8fafc;padding:18px;display:grid;gap:10px;font-size:13px;font-weight:850;color:#344054}
      .li-estimate-summary div{display:flex;justify-content:space-between;gap:10px}
      .li-estimate-progress{height:7px;background:#eef2f7;border-radius:999px;overflow:hidden;margin:0 0 18px}
      .li-estimate-progress span{display:block;height:100%;background:var(--ie-primary);border-radius:inherit;transition:width .18s ease}
      .li-estimate-note{font-size:12px;font-weight:800;color:#667085;line-height:1.45}
      .li-estimate-config{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:10px}
      .li-pricing-table{display:grid;gap:6px;min-width:0}
      .li-pricing-row{display:grid;grid-template-columns:minmax(0,1.15fr) minmax(0,.9fr) minmax(0,.7fr) minmax(0,.7fr);gap:6px;align-items:center;min-width:0}
      .li-pricing-row.head,.li-option-row.head{align-items:center;color:#667085;font-size:10px;font-weight:1000;letter-spacing:.4px;text-transform:uppercase}
      .li-pricing-row.head div,.li-option-row.head div{padding:0 2px}
      .li-pricing-row .cs-in,.li-option-row .cs-in{padding:8px 9px;border-radius:9px;font-size:12px}
      .li-page-builder{display:grid;gap:10px}
      .li-page-nav{display:flex;align-items:center;gap:5px;border:1px solid #e5e7eb;border-radius:10px;background:#fff;padding:5px;min-width:0}
      .li-page-nav-main{display:flex;align-items:center;gap:1px;flex:1;min-width:0;overflow:hidden}
      .li-page-arrow,.li-page-num{border:0;background:transparent;color:#344054;font-size:12px;font-weight:1000;cursor:pointer;flex:0 0 auto;border-radius:6px}
      .li-page-arrow{width:24px;height:24px;display:grid;place-items:center}
      .li-page-num{min-width:22px;height:24px;padding:0 4px}
      .li-page-num.active{background:var(--primary,#d93025);color:#fff}
      .li-page-num:disabled,.li-page-nav button:disabled{opacity:.45;cursor:not-allowed}
      .li-page-editor{border:1px solid #e5e7eb;border-radius:12px;background:#f8fafc;padding:12px;display:grid;gap:10px;min-height:390px;align-content:start}
      .li-page-editor-head{display:flex;align-items:center;justify-content:space-between;gap:10px}
      .li-page-editor-title{font-size:12px;font-weight:1000;color:#111827}
      .li-option-grid{display:grid;gap:6px;min-width:0}
      .li-option-row{display:grid;grid-template-columns:minmax(0,.9fr) minmax(0,1.2fr);gap:6px;align-items:center;min-width:0}
      .li-option-row.image{grid-template-columns:84px minmax(0,.9fr) minmax(0,1.15fr) auto}
      .li-option-thumb{width:40px;height:34px;border-radius:8px;background:#e5e7eb center/cover no-repeat;border:1px solid #d1d5db}
      .li-option-upload{position:relative;overflow:hidden;white-space:nowrap}
      .li-option-upload input{position:absolute;inset:0;opacity:0;cursor:pointer}
      .li-option-enabled{display:flex;align-items:center;gap:5px;font-size:11px;color:#667085}
      @media(max-width:900px){.li-estimate-card{padding:24px 20px;margin:10px;min-height:560px}.li-estimate-addressbar,.li-estimate-results,.li-estimate-form{grid-template-columns:1fr}.li-estimate-title,.li-estimate-brand h3{font-size:25px}.li-estimate-map-wrap{height:390px}}
      @media(max-width:1200px){.cs-wrap.forms-wide{height:auto}.cs-wrap.forms-wide > .cs-card{height:auto;min-height:0;overflow:visible}.li-forms-stack,.li-editor{height:auto}.li-editor{grid-template-columns:1fr}.li-editor > .cs-card{overflow:visible}}
      @media(max-width:900px){.li-split,.li-schedule-settings,.li-schedule-window,.li-preview-body,.li-preview-contact,.li-preview-booking,.li-style-custom,.li-embed-row{grid-template-columns:1fr}.li-preview{position:static}.li-formgrid{grid-template-columns:1fr}.li-preview-head h3{font-size:24px}}
      .cs-tab{
        border:1px solid rgba(0,0,0,0.14);
        background:#fff;
        padding:10px 12px;
        border-radius:999px;
        font-weight:1000;
        cursor:pointer;
        transition:.14s ease;
        display:inline-flex; align-items:center; gap:8px;
      }
      .cs-tab.active{ border-color:var(--primary-readable, var(--primary,#d93025)); color:var(--primary-readable, var(--primary,#d93025)); box-shadow: 0 10px 24px rgba(0,0,0,0.06); }
      .cs-card{ background:#fff; border:1px solid rgba(0,0,0,0.08); border-radius:18px; box-shadow:0 14px 34px rgba(0,0,0,0.06); padding:16px; margin-top:12px; }
      .cs-pane{ display:none; } .cs-pane.active{ display:block; }
      .cs-section-head{display:flex;align-items:flex-start;justify-content:space-between;gap:14px;flex-wrap:wrap;margin-bottom:12px}
      .cs-section-head h3{margin:0;font-size:18px;font-weight:1000;color:#101828;letter-spacing:0}
      .cs-section-head p{margin:4px 0 0;color:#667085;font-size:13px;font-weight:800;line-height:1.4}
      .cs-subcard{border:1px solid #e4e7ec;border-radius:14px;background:#fff;padding:14px;box-shadow:0 10px 24px rgba(15,23,42,.04)}
      .cs-field{display:grid;gap:6px;min-width:0;color:#667085;font-size:10px;font-weight:1000;letter-spacing:.04em;text-transform:uppercase}
      .cs-field span{display:block;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
      .cs-field input,.cs-field select,.cs-field textarea{width:100%;min-width:0;max-width:100%;box-sizing:border-box;border:1px solid #d0d5dd;border-radius:10px;background:#fff;color:#101828;font-size:13px;font-weight:850;letter-spacing:0;text-transform:none;outline:none}
      .cs-field input,.cs-field select{height:38px;padding:0 10px}
      .cs-field textarea{padding:10px;resize:vertical;min-height:72px;line-height:1.35}
      .cs-field input:focus,.cs-field select:focus,.cs-field textarea:focus{border-color:rgba(var(--primary-rgb,217,48,37),.42);box-shadow:0 0 0 4px rgba(var(--primary-rgb,217,48,37),.09)}
      .cs-field.compact{max-width:220px}
      .cs-btn.icon{width:34px;height:34px;padding:0;border-radius:10px;align-items:center;justify-content:center;background:#fff;border:1px solid #d0d5dd;color:#475467;box-shadow:none}
      .crew-settings-card{margin-top:14px;display:grid;gap:12px}
      .crew-settings-card.archived{opacity:.72}
      .crew-card-main{display:grid;grid-template-columns:minmax(220px,1fr) minmax(180px,220px);gap:10px;align-items:end}
      .crew-rate-grid{display:grid;grid-template-columns:minmax(170px,.9fr) minmax(110px,.55fr) minmax(110px,.55fr) minmax(170px,1fr);gap:8px;align-items:end}
      .crew-member-head{display:flex;align-items:center;justify-content:space-between;gap:10px;margin-bottom:8px}
      .crew-member-head strong{font-size:13px;font-weight:1000;color:#101828}
      .crew-member-row{display:grid;grid-template-columns:minmax(130px,1.05fr) minmax(150px,1.1fr) minmax(100px,.8fr) minmax(112px,.85fr) minmax(86px,.6fr) minmax(86px,.6fr) 34px;gap:8px;align-items:end;margin-top:8px}
      .crew-card-actions{display:flex;gap:8px;justify-content:flex-end;align-items:center;flex-wrap:wrap}
      #csPaneCrews h4{font-size:13px;font-weight:1000;color:#667085;text-transform:uppercase;letter-spacing:.04em}
      @media(max-width:1180px){.crew-member-row{grid-template-columns:repeat(2,minmax(0,1fr)) 34px}.crew-member-row .cs-btn.icon{align-self:end}.crew-rate-grid{grid-template-columns:repeat(2,minmax(0,1fr))}}
      @media(max-width:760px){.crew-card-main,.crew-rate-grid,.crew-member-row{grid-template-columns:1fr}.cs-field.compact{max-width:none}.crew-member-row .cs-btn.icon{width:100%}.crew-card-actions{justify-content:stretch}.crew-card-actions .cs-btn{justify-content:center;flex:1}}
      .cs-grid{ display:grid; grid-template-columns: 1.2fr 0.8fr; gap: 14px; }
      @media (max-width: 860px){ .cs-grid{ grid-template-columns: 1fr; } }
      .cs-row{ display:flex; flex-direction:column; gap:8px; margin-bottom: 12px; }
      .cs-lbl{ font-size:11px; font-weight:950; color:#777; letter-spacing:.5px; text-transform:uppercase; }
      .cs-in{ border: 1px solid rgba(0,0,0,0.14); border-radius: 14px; padding: 12px 12px; font-weight: 850; font-size: 14px; outline:none; box-sizing:border-box; max-width:100%; }
      .cs-in:focus{ border-var(--primary-readable, var(--primary,#d93025)); box-shadow:0 0 0 3px rgba(var(--primary-rgb,217,48,37),0.12); }
      .cs-colorline{ display:flex; align-items:center; gap: 12px; }
      .cs-color{ width:46px; height:36px; border-radius:12px; border:1px solid rgba(0,0,0,0.18); background:#fff; padding:0; cursor:pointer; }
      .cs-chip{
        border:1px solid rgba(0,0,0,0.10);
        border-radius:999px;
        padding:8px 10px;
        font-weight:950;
        font-size:12px;
        background:#fff;
        display:inline-flex;
        align-items:center;
        cursor:text;
        user-select:text;
      }
      .cs-chip .hash{ opacity:.9; user-select:none; }
      .cs-chip input{
        border:0; outline:none; background:transparent;
        padding:0; margin:0;
        width: 6.2ch;
        font: inherit; font-weight: inherit; font-size: inherit;
        color: inherit;
        user-select:text;
        text-transform: uppercase;
      }
      .cs-previewWrap{
        border-radius:16px;
        padding:12px;
        border:1px dashed rgba(0,0,0,0.22);
        background: rgba(0,0,0,0.02);
      }
      .cs-page{
        width: 100%;
        aspect-ratio: 8.5 / 11;
        border-radius: 10px;
        overflow:hidden;
        background:#fff;
        position:relative;
        box-shadow: 0 18px 44px rgba(0,0,0,0.08);
      }
      .cs-barPrimary{ position:absolute; left:0; top:0; bottom:0; width: 16px; background: var(--primary,#d93025); }
      .cs-barSecondary{ position:absolute; left:16px; top:0; bottom:0; width: 3px; background: var(--secondary,#960000); }
      .cs-pageInner{ position:absolute; left: 19px; right: 0; top: 0; bottom: 0; background:#fff; }
      .cs-pageLogo{ position:absolute; left: 10px; top: 10px; width: 180px; max-height: 46px; }
      .cs-pageLogo img{ display:block; max-width:100%; max-height: 35px; }
      .cs-pageLogo.default-firstmeasure-logo{ height: 35px; }
      .cs-pageLogo.default-firstmeasure-logo img{ display:none; }
      .cs-pageLogo.default-firstmeasure-logo::before{
        content:"";
        display:block;
        width:100%;
        height:35px;
        background:var(--primary,#d93025);
        -webkit-mask:url("/images/logo_red.png") left center / contain no-repeat;
        mask:url("/images/logo_red.png") left center / contain no-repeat;
      }
      .cs-centerZone{ position:absolute; inset:0; display:flex; align-items:center; justify-content:center; padding: 18px; }
      .cs-centerZone img{ display:block; width:90%; height:auto; opacity: 0.98; }
      .cs-actions{ margin-top:12px; display:flex; gap:10px; flex-wrap:wrap; }
      .cs-btn{ border:none; border-radius:999px; padding:12px 14px; font-weight:1000; cursor:pointer; display:inline-flex; align-items:center; gap:8px; transition:.16s ease; }
      
      .cs-btn.primary{ background:var(--primary,#d93025); color:var(--on-primary, #fff); box-shadow:0 12px 26px rgba(var(--primary-rgb,217,48,37),0.22); }
      .cs-btn.ghost{ background:#fff; border:1px solid rgba(0,0,0,0.14); color:#333; }
      .cs-btn.ghost:hover{ border-var(--primary-readable, var(--primary,#d93025)); var(--primary-readable, var(--primary,#d93025)); }
      .cs-btn.danger{ background:#111; color:#fff; }
      .cs-note{ font-size:12px; font-weight:800; color:#777; line-height:1.4; margin-top:8px; }
      .cs-file input[type="file"]{ display:none; }
      /* Reports */
      .rp-wrap{ max-width: 980px; margin:0 auto; }
      .rp-card{
        border:1px solid rgba(0,0,0,0.10);
        border-radius:18px;
        padding:14px;
        background:#fff;
        box-shadow:0 14px 34px rgba(0,0,0,0.05);
      }
      .rp-h{ font-weight:1000; font-size:16px; margin:0; }
      .rp-divider{ height:1px; background:rgba(0,0,0,0.08); margin:14px 0; }
      .rp-inline{ display:flex; gap:12px; align-items:center; flex-wrap:wrap; margin-top:10px; }
      .rp-pill{
        display:inline-flex; align-items:center; gap:8px;
        border:1px solid rgba(0,0,0,0.10);
        border-radius:999px;
        padding:8px 10px;
        font-weight:950; font-size:12px;
        background:#fff;
        color:#444;
      }
      .rp-num{ width:180px; }
      .rp-sections{
        margin-top:12px;
        display:grid;
        gap:0;
      }
      .rp-section{
        padding:14px 0;
        border-top:1px solid rgba(0,0,0,0.08);
      }
      .rp-section:first-child{
        border-top:0;
        padding-top:0;
      }
      .rp-section:last-child{
        padding-bottom:0;
      }
      .rp-sectionHead{
        margin-bottom:10px;
      }
      .rp-sectionTitle{
        font-size:13px;
        font-weight:1000;
        color:#222;
        line-height:1.2;
      }
      .rp-sectionSub{
        margin-top:4px;
        font-size:12px;
        font-weight:800;
        color:#777;
        line-height:1.35;
      }
      .rp-tgrid{
        margin-top: 12px;
        display:grid;
        grid-template-columns: 1fr;
        gap:10px;
      }
      @media (min-width: 900px){
        .rp-tgrid{ grid-template-columns: 1fr 1fr; }
      }
      .rp-toggle{
        width:100%;
        border-radius:16px;
        border:1px solid rgba(0,0,0,0.12);
        background:#fff;
        padding:12px 12px;
        font-weight:1000;
        cursor:pointer;
        display:flex;
        align-items:center;
        justify-content:space-between;
        gap:12px;
        transition:.16s ease;
        user-select:none;
      }
      .rp-toggle:hover{ border-color: rgba(var(--primary-rgb,217,48,37),0.35); }
      .rp-toggle .rp-dot{
        width:10px; height:10px; border-radius:999px;
        background:rgba(0,0,0,0.18);
        box-shadow:0 6px 16px rgba(0,0,0,0.08);
        flex:0 0 auto;
      }
      .rp-toggle .rp-label{
        text-align:left;
        font-size:13px;
        font-weight:1000;
        color:#333;
        flex:1 1 auto;
      }
      .rp-toggle .rp-state{
        font-size:12px;
        font-weight:1000;
        color:#999;
        flex:0 0 auto;
      }
      .rp-toggle.on{
        border-color: rgba(var(--primary-rgb,217,48,37),0.45);
        box-shadow:0 12px 26px rgba(var(--primary-rgb,217,48,37),0.16);
      }
      .rp-toggle.on .rp-dot{ background: var(--primary,#d93025); }
      .rp-toggle.on .rp-state{ var(--primary-readable, var(--primary,#d93025)); }
      .rp-toggle.off:hover .rp-state{ var(--primary-readable, var(--primary,#d93025)); }
      .app-flags-grid{
        column-count:2;
        column-gap:14px;
      }
      .app-flag-group{
        min-width:0;
        display:inline-flex;
        width:100%;
        box-sizing:border-box;
        break-inside:avoid;
        page-break-inside:avoid;
        margin:0 0 14px;
      }
      .app-flag-list{
        display:grid;
        gap:10px;
      }
      /* Billing */
      
      .bl-wrap{ max-width: 980px; margin:0 auto; }
      .bl-card{
        border:1px solid rgba(0,0,0,0.10);
        border-radius:18px;
        padding:14px;
        background:#fff;
        box-shadow:0 14px 34px rgba(0,0,0,0.05);
      }
      .bl-h{ font-weight:1000; font-size:16px; margin:0; }
      .bl-sub{ font-size:12px; font-weight:850; color:#666; margin-top:6px; line-height:1.35; }
      .bl-summary{ font-size:12px; font-weight:500; color:rgba(0,0,0,0.42); margin-top:12px; line-height:1.45; }
      .bl-divider{ height:1px; background:rgba(0,0,0,0.08); margin:14px 0; }
      .bl-row{ display:flex; align-items:center; justify-content:space-between; gap:12px; flex-wrap:wrap; margin-top:12px; }
      .bl-left{ display:flex; align-items:center; gap:10px; flex-wrap:wrap; }
      .bl-pill{
        display:inline-flex; align-items:center; gap:8px;
        border:1px solid rgba(0,0,0,0.10);
        border-radius:999px;
        padding:8px 10px;
        font-weight:950; font-size:12px;
        background:#fff;
        color:#444;
      }
      .bl-ctrl{ display:flex; align-items:center; gap:8px; flex-wrap:wrap; }
      .bl-stepBtn{
        border:1px solid rgba(0,0,0,0.14);
        background:#fff;
        border-radius:12px;
        padding:10px 12px;
        cursor:pointer;
        font-weight:1000;
        transition:.14s ease;
      }
      .bl-stepBtn:hover{ border-var(--primary-readable, var(--primary,#d93025)); var(--primary-readable, var(--primary,#d93025)); }
      .bl-stepBtn:disabled{ opacity:.45; cursor:not-allowed; }
      .bl-money{
        width: 100px;
        padding-left: 20px;
        position: relative;
      }
      .bl-moneyWrap{ position:relative; display:inline-flex; align-items:center; }
      .bl-moneyWrap .usd{
        position:absolute; left: 14px;
        font-weight:1000; color:#666; font-size:13px;
        pointer-events:none;
      }
      .bl-toggleLine{
        display:flex; align-items:center; justify-content:space-between; gap:12px; flex-wrap:wrap;
        padding:12px; border:1px solid rgba(0,0,0,0.10); border-radius:16px;
        background: rgba(0,0,0,0.01);
        margin-top: 12px;
      }
      .bl-switch{
        border:1px solid rgba(0,0,0,0.12);
        background:#fff;
        border-radius:999px;
        padding:10px 12px;
        font-weight:1000;
        cursor:pointer;
        display:inline-flex;
        align-items:center;
        gap:10px;
        user-select:none;
        transition:.14s ease;
      }
      .bl-switch .dot{
        width:10px; height:10px; border-radius:999px; background: rgba(0,0,0,0.18);
      }
      .bl-switch.on{
        border-color: rgba(var(--primary-rgb,217,48,37),0.45);
        box-shadow: 0 12px 26px rgba(var(--primary-rgb,217,48,37),0.14);
        var(--primary-readable, var(--primary,#d93025));
      }
      .bl-switch.on .dot{ background: var(--primary,#d93025); }
      .bl-disabled{
        opacity:.55;
        filter: grayscale(0.2);
        pointer-events:none;
      }
      /* Billing split layout */
      .bl-grid{
        display:grid;
        grid-template-columns: 1.05fr 0.95fr;
        gap: 14px;
      }
      @media (max-width: 980px){
        .bl-grid{ grid-template-columns: 1fr; }
      }
      /* Billing History - chronological ledger */
      .bh-card{
        border:1px solid rgba(0,0,0,0.10);
        border-radius:18px;
        padding:14px;
        background:#fff;
        box-shadow:0 14px 34px rgba(0,0,0,0.05);
        overflow:hidden;
      }
      .bh-top{
        display:flex;
        align-items:flex-start;
        justify-content:space-between;
        gap:10px;
      }
      .bh-h{ font-weight:1000; font-size:16px; margin:0; }
      .bh-sub{ font-size:12px; font-weight:850; color:#666; margin-top:6px; line-height:1.35; }
      .bh-btn{ padding:10px 12px; }
      .bh-list{
        margin-top:12px;
        border:1px solid rgba(0,0,0,0.08);
        border-radius:14px;
        background: rgba(0,0,0,0.01);
        max-height: 560px;
        overflow:auto;
      }
      /* header row (sticky) */
      .bh-head{
        position: sticky;
        top: 0;
        z-index: 2;
        display:grid;
        grid-template-columns: 86px 1fr minmax(0, max-content) minmax(0, max-content);
        gap:10px;
        padding:10px 12px;
        background:#fff;
        border-bottom:1px solid rgba(0,0,0,0.08);
        font-size:11px;
        font-weight:950;
        color:#777;
        letter-spacing:.5px;
        text-transform:uppercase;
      }
      /* each entry */
      .bh-row{
        display:grid;
        grid-template-columns: 86px 1fr minmax(0, max-content) minmax(0, max-content);
        gap:10px;
        padding:12px 12px;
        border-top:1px solid rgba(0,0,0,0.06);
        background:#fff;
        align-items:start;
      }
      .bh-row:first-child{ border-top:0; }
      .bh-delta, .bh-balance{
        justify-self:end;
        text-align:right;
        font-size:12px;
        font-weight:1000;
        color:#222;
        white-space:nowrap;
        font-variant-numeric: tabular-nums;
      }
      .bh-left{ }
      .bh-date{
        font-size:12px;
        font-weight:1000;
        color:#444;
        line-height:1.05;
      }
      .bh-time{
        margin-top:6px;
        font-size:11px;
        font-weight:900;
        color:#888;
        line-height:1.05;
        white-space:nowrap;
      }
      .bh-mid{ min-width:0; }
      .bh-title{
        font-weight:1000;
        font-size:13px;
        color:#111;
        line-height:1.2;
      }
      .bh-subline{
        margin-top:6px;
        font-size:12px;
        font-weight:850;
        color:#666;
        line-height:1.25;
        word-break:break-word;
      }
      .bh-delta.neg{ color:#111; opacity:.9; }
      .bh-delta.pos{ var(--primary-readable, var(--primary,#d93025)); }
      .bh-balance{ color:#444; font-weight:950; }
      .bh-empty{
        padding:14px 12px;
        font-size:12px;
        font-weight:850;
        color:#777;
      }
      
      .bh-pill{
        display:inline-flex;
        align-items:center;
        gap:8px;
        border:1px solid rgba(0,0,0,0.10);
        border-radius:999px;
        padding:6px 9px;
        font-weight:950;
        font-size:12px;
        background:#fff;
        color:#444;
        white-space:nowrap;
      }
      .bh-pill.good{
        border-color: rgba(var(--primary-rgb,217,48,37),0.35);
        background: rgba(var(--primary-rgb,217,48,37),0.06);
        var(--primary-readable, var(--primary,#d93025));
      }
      .bh-pill.bad{
        border-color: rgba(0,0,0,0.18);
        background: rgba(0,0,0,0.04);
        color:#333;
      }
      .bh-pill.muted{
        opacity:.75;
      }
      /* Monthly Statement */
      .ms-card{
        border:1px solid rgba(0,0,0,0.10);
        border-radius:18px;
        padding:14px;
        background:#fff;
        box-shadow:0 14px 34px rgba(0,0,0,0.05);
        margin-top:14px;
      }
      .ms-top{
        display:flex;
        align-items:center;
        justify-content:space-between;
        gap:12px;
        flex-wrap:wrap;
      }
      .ms-h{ font-weight:1000; font-size:16px; margin:0; }
      .ms-sub{ font-size:12px; font-weight:850; color:#666; margin-top:6px; line-height:1.35; }
      .ms-nav{
        display:flex;
        align-items:center;
        gap:8px;
      }
      .ms-navBtn{
        border:1px solid rgba(0,0,0,0.14);
        background:#fff;
        border-radius:12px;
        padding:9px 11px;
        cursor:pointer;
        font-weight:1000;
        transition:.14s ease;
        display:inline-flex;
        align-items:center;
      }
      .ms-navBtn:hover{ border-var(--primary-readable, var(--primary,#d93025)); var(--primary-readable, var(--primary,#d93025)); }
      .ms-navBtn:disabled{ opacity:.4; cursor:not-allowed; }
      .ms-monthLabel{
        font-weight:1000;
        font-size:14px;
        min-width:140px;
        text-align:center;
      }
      .ms-summary{
        display:flex;
        gap:10px;
        flex-wrap:wrap;
        margin-top:14px;
      }
      .ms-stat{
        border:1px solid rgba(0,0,0,0.10);
        border-radius:14px;
        padding:14px 16px;
        background:rgba(0,0,0,0.01);
        flex:1 1 140px;
        min-width:140px;
      }
      .ms-statLabel{
        font-size:11px;
        font-weight:950;
        color:#777;
        letter-spacing:.5px;
        text-transform:uppercase;
      }
      .ms-statVal{
        font-size:22px;
        font-weight:1000;
        color:#111;
        margin-top:6px;
        font-variant-numeric: tabular-nums;
      }
      .ms-actions{
        display:flex;
        gap:10px;
        flex-wrap:wrap;
        margin-top:14px;
      }
      .ms-loading{
        padding:14px 0;
        font-size:13px;
        font-weight:850;
        color:#777;
      }
      /* Statement modal */
      .ms-modalBack{
        position:fixed; inset:0;
        background:rgba(0,0,0,0.42);
        display:flex; align-items:center; justify-content:center;
        z-index:9999; padding:14px;
      }
      .ms-modal{
        width:min(780px, 100%);
        max-height: calc(100vh - 40px);
        background:#fff;
        border-radius:18px;
        border:1px solid rgba(0,0,0,0.10);
        box-shadow: 0 22px 70px rgba(0,0,0,0.22);
        overflow:hidden;
        display:flex;
        flex-direction:column;
      }
      .ms-mHeader{
        padding:16px 16px;
        display:flex;
        align-items:center;
        justify-content:space-between;
        gap:10px;
        border-bottom:1px solid rgba(0,0,0,0.08);
        flex:0 0 auto;
      }
      .ms-mTitle{ font-weight:1000; font-size:16px; }
      .ms-mClose{
        border:1px solid rgba(0,0,0,0.14);
        background:#fff;
        border-radius:12px;
        padding:8px 10px;
        cursor:pointer;
        font-weight:1000;
      }
      .ms-mClose:hover{ border-var(--primary-readable, var(--primary,#d93025)); var(--primary-readable, var(--primary,#d93025)); }
      .ms-mBody{
        flex:1 1 auto;
        overflow:auto;
        padding:0;
      }
      .ms-mFooter{
        padding:14px 16px;
        border-top:1px solid rgba(0,0,0,0.08);
        display:flex;
        gap:10px;
        justify-content:space-between;
        align-items:center;
        flex-wrap:wrap;
        flex:0 0 auto;
      }
      .ms-mFooterLeft{
        font-size:13px;
        font-weight:1000;
        color:#333;
      }
      .ms-table{
        width:100%;
        border-collapse:collapse;
        font-size:13px;
      }
      .ms-table th{
        position:sticky;
        top:0;
        z-index:2;
        background:#fff;
        padding:12px 14px;
        text-align:left;
        font-weight:1000;
        font-size:11px;
        color:#777;
        letter-spacing:.5px;
        text-transform:uppercase;
        border-bottom:1px solid rgba(0,0,0,0.08);
      }
      .ms-table th.right{ text-align:right; }
      .ms-table td{
        padding:12px 14px;
        border-top:1px solid rgba(0,0,0,0.05);
        vertical-align:top;
      }
      .ms-table tr:first-child td{ border-top:0; }
      .ms-table td.right{
        text-align:right;
        font-weight:1000;
        font-variant-numeric:tabular-nums;
      }
      .ms-table .ms-addr{
        font-weight:1000;
        color:#111;
        line-height:1.2;
      }
      .ms-table .ms-issuer{
        font-size:12px;
        font-weight:800;
        color:#666;
        margin-top:4px;
      }
      .ms-table .ms-typePill{
        display:inline-flex;
        align-items:center;
        gap:6px;
        border:1px solid rgba(0,0,0,0.10);
        border-radius:999px;
        padding:5px 9px;
        font-weight:950;
        font-size:11px;
        background:#fff;
        color:#444;
        text-transform:capitalize;
      }
      .ms-table .ms-statusPill{
        display:inline-flex;
        align-items:center;
        gap:6px;
        border:1px solid rgba(0,0,0,0.10);
        border-radius:999px;
        padding:5px 9px;
        font-weight:950;
        font-size:11px;
        background:#fff;
        color:#444;
      }
      .ms-table .ms-statusPill.completed{
        border-color: rgba(var(--primary-rgb,217,48,37),0.35);
        var(--primary-readable, var(--primary,#d93025));
      }
      .ms-table .ms-statusPill.rejected{
        opacity:.6;
      }
      .ms-table .ms-cost{
        font-weight:1000;
        font-variant-numeric: tabular-nums;
      }
      .ms-table .ms-cost.zero{ opacity:.45; }
      .ms-mEmpty{
        padding:40px 14px;
        text-align:center;
        font-size:13px;
        font-weight:850;
        color:#777;
      }
      /* Users */
      .cu-top{ display:flex; align-items:flex-end; justify-content:space-between; gap:12px; margin-bottom:12px; flex-wrap:wrap; }
      .cu-title{ font-weight:1000; font-size:16px; }
      .cu-actions{ display:flex; gap:10px; flex-wrap:wrap; align-items:center; }
      .cu-btn{
        border:1px solid rgba(0,0,0,0.14);
        background:#fff;
        border-radius:999px;
        padding:10px 12px;
        font-weight:1000;
        cursor:pointer;
        transition:.14s ease;
        display:inline-flex; align-items:center; gap:8px;
        user-select:none;
      }
      .cu-btn:hover{ border-var(--primary-readable, var(--primary,#d93025)); var(--primary-readable, var(--primary,#d93025)); }
      .cu-btn.toggle.on{
        border-color: rgba(var(--primary-rgb,217,48,37),0.45);
        var(--primary-readable, var(--primary,#d93025));
        box-shadow:0 12px 26px rgba(var(--primary-rgb,217,48,37),0.12);
      }
      .cu-table{ width:100%; border-collapse:separate; border-spacing:0; overflow:hidden; border-radius:16px; border:1px solid rgba(0,0,0,0.10); }
      .cu-th, .cu-td{ padding:12px 12px; font-size:13px; vertical-align:top; }
      .cu-th{ background:rgba(0,0,0,0.02); font-weight:1000; color:#444; border-bottom:1px solid rgba(0,0,0,0.08); }
      .cu-trMain .cu-td{ border-top:1px solid rgba(0,0,0,0.06); }
      .cu-trMain:first-child .cu-td{ border-top:0; }
      .cu-trMain.me .cu-td{
        background:linear-gradient(180deg, rgba(var(--primary-rgb,217,48,37),0.08), rgba(var(--primary-rgb,217,48,37),0.03));
      }
      .cu-trMain.me .cu-td:first-child{
        box-shadow: inset 4px 0 0 var(--primary-readable, var(--primary,#d93025));
      }
      .cu-trPerm.me .cu-permShell{
        background:rgba(var(--primary-rgb,217,48,37),0.035);
      }
      .cu-userCell{ display:flex; align-items:center; gap:8px; width:100%; min-width:0; }
      .cu-userAvatar{
        position:relative;
        width:40px; height:40px;
        border-radius:12px;
        border:1px solid rgba(0,0,0,0.08);
        background:rgba(0,0,0,0.06);
        display:flex; align-items:center; justify-content:center;
        overflow:hidden;
        flex:0 0 auto;
        padding:0;
        color:rgba(0,0,0,0.45);
        font-size:16px;
        font-weight:800;
      }
      button.cu-userAvatar{
        cursor:pointer;
        transition:.15s ease;
      }
      button.cu-userAvatar:hover{
        border-color:rgba(0,0,0,0.16);
        background:rgba(0,0,0,0.08);
      }
      .cu-userAvatar img{
        width:100%; height:100%;
        object-fit:cover;
        display:block;
      }
      .cu-userAvatarEdit{
        position:absolute;
        right:2px; bottom:2px;
        width:16px; height:16px;
        border-radius:999px;
        background:#fff;
        border:1px solid rgba(0,0,0,0.12);
        display:flex; align-items:center; justify-content:center;
        font-size:8px;
        color:#555;
      }
      .cu-userAvatarStatic .cu-userAvatarEdit{ display:none; }
      .cu-fileInput{ display:none !important; }
      .cu-userText{ flex:0 1 auto; min-width:0; }
      .cu-userName{ font-weight:1000; line-height:1.15; }
      button.cu-userName{border:0;background:transparent;padding:0;color:#101828;font:inherit;font-weight:1000;line-height:1.15;text-align:left;cursor:pointer}
      button.cu-userName:hover{color:var(--primary-readable,var(--primary,#d93025));text-decoration:underline}
      .cu-userEmail{ margin-top:4px; font-size:12px; font-weight:800; color:#666; line-height:1.15; }
      .cu-userCell .cu-tag.you{ flex:0 0 auto; white-space:nowrap; }
      .cu-centerCell{ text-align:center; }
      .cu-centerCell .cu-pill{ margin: 0 auto; }
      .cu-th.userHead{ text-align:left; }
      .cu-tag{
        display:inline-flex; align-items:center; gap:8px;
        border:1px solid rgba(0,0,0,0.10);
        border-radius:999px;
        padding:6px 9px;
        font-weight:950; font-size:12px;
        background:#fff;
        color:#444;
      }
      .cu-tag.you{
        border-color: rgba(var(--primary-rgb,217,48,37),0.30);
        background: rgba(var(--primary-rgb,217,48,37),0.12);
        color: var(--primary-readable, var(--primary,#d93025));
        box-shadow: 0 8px 18px rgba(var(--primary-rgb,217,48,37),0.12);
      }
      .cu-pill{
        display:inline-flex; align-items:center; gap:8px;
        border:1px solid rgba(0,0,0,0.10);
        border-radius:999px;
        padding:7px 10px;
        font-weight:950; font-size:12px;
        background:#fff;
        color:#444;
      }
      .cu-pill.active{ }
      .cu-pill.never{ border-color: rgba(var(--primary-rgb,217,48,37),0.35); var(--primary-readable, var(--primary,#d93025)); background: rgba(var(--primary-rgb,217,48,37),0.06); }
      .cu-pill.off{ opacity:.60; }
      .cu-pill.level{ border-color: rgba(0,0,0,0.14); background: rgba(0,0,0,0.02); }
      .cu-actionsCell{ width: 52px; padding-right: 10px; text-align:right; }
      .cu-kebab{
        border:1px solid rgba(0,0,0,0.14);
        background:#fff;
        border-radius:12px;
        padding:8px 10px;
        cursor:pointer;
        font-weight:1000;
        transition:.14s ease;
      }
      .cu-kebab:hover{ border-var(--primary-readable, var(--primary,#d93025)); var(--primary-readable, var(--primary,#d93025)); }
      .cu-fmenu{
        position:fixed;
        min-width: 200px;
        background:#fff;
        border:1px solid rgba(0,0,0,0.10);
        border-radius:14px;
        box-shadow: 0 18px 55px rgba(0,0,0,0.18);
        overflow:hidden;
        z-index: 99999;
        display:none;
      }
      .cu-fmenu.open{ display:block; }
      .cu-mi{
        width:100%;
        text-align:left;
        border:0;
        background:#fff;
        padding:12px 12px;
        font-weight:1000;
        cursor:pointer;
        display:flex;
        align-items:center;
        justify-content:space-between;
        gap:10px;
      }
      .cu-mi:hover{ background: rgba(0,0,0,0.03); }
      .cu-mi.disabled{ opacity:.45; cursor:not-allowed; }
      .cu-mi.disabled:hover{ background:#fff; }
      .cu-trPerm td{ padding:0; border-top:0; }
      .cu-permShell{ border-top:1px solid rgba(0,0,0,0.06); background: rgba(0,0,0,0.015); }
      .cu-permWrap{
        overflow:hidden;
        max-height:0;
        opacity:0;
        transform:translateY(-4px);
        transition:max-height .18s ease, opacity .18s ease, transform .18s ease;
      }
      .cu-permWrap.open{
        max-height:340px;
        opacity:1;
        transform:none;
      }
      .cu-permInner{ padding: 10px 12px 12px; display:flex; flex-direction:column; gap:8px; }
      .cu-permTop{ display:flex; align-items:center; gap:8px; flex-wrap:wrap; }
      .cu-rolePresets{
        display:flex;
        flex-wrap:wrap;
        gap:6px;
        flex:1 1 auto;
      }
      .cu-roleBtn{
        border:1px solid rgba(0,0,0,0.10);
        background:#fff;
        border-radius:10px;
        padding:6px 10px;
        font-weight:800;
        font-size:11px;
        color:rgba(0,0,0,0.45);
        cursor:pointer;
        display:inline-flex;
        align-items:center;
        gap:6px;
        line-height:1.2;
        transition:.15s ease;
      }
      .cu-roleBtn:hover{
        border-color:rgba(0,0,0,0.20);
        color:rgba(0,0,0,0.65);
      }
      .cu-roleBtn.active{
        border-color:var(--primary-readable, var(--primary,#d93025));
        background:rgba(var(--primary-readable-rgb, var(--primary-rgb,217,48,37)),0.08);
        color:var(--primary-readable, var(--primary,#d93025));
      }
      .cu-roleBtn.custom{
        border-style:dashed;
      }
      .cu-roleBtn:disabled{
        opacity:.55;
        cursor:not-allowed;
      }
      .cu-roleBtn:disabled:hover{
        border-color:rgba(0,0,0,0.10);
        color:rgba(0,0,0,0.45);
      }
      .cu-permHint{
        flex:1 1 220px;
        margin-left:auto;
        font-size:11px;
        font-weight:700;
        color:rgba(0,0,0,0.45);
        text-align:right;
      }
      .cu-permHint:empty{ display:none; }
      .cu-permGrid{
        display:flex;
        flex-wrap:wrap;
        gap:6px;
        padding-top:10px;
        border-top:1px dashed rgba(0,0,0,0.08);
      }
      .cu-permLabel{
        width:100%;
        font-size:10px;
        font-weight:700;
        letter-spacing:.5px;
        text-transform:uppercase;
        color:rgba(0,0,0,0.25);
        margin-bottom:2px;
      }
      .cu-pbtn{
        border:1px solid rgba(0,0,0,0.06);
        background:rgba(0,0,0,0.02);
        border-radius:8px;
        padding:5px 10px;
        font-weight:700;
        font-size:10px;
        cursor:pointer;
        transition:.15s ease;
        user-select:none;
        display:inline-flex;
        align-items:center;
        gap:5px;
        color:rgba(0,0,0,0.35);
        line-height:1.2;
      }
      .cu-pbtn:hover{
        border-color:rgba(0,0,0,0.15);
        color:rgba(0,0,0,0.5);
        background:rgba(0,0,0,0.03);
      }
      .cu-pbtn.on{
        border-color:var(--primary-readable, var(--primary,#d93025));
        background:rgba(var(--primary-readable-rgb, var(--primary-rgb,217,48,37)),0.08);
        color:var(--primary-readable, var(--primary,#d93025));
      }
      .cu-pbtn.on .dot{ background: var(--primary-readable, var(--primary,#d93025)); }
      .cu-pbtn .dot{
        width:7px; height:7px; border-radius:999px;
        background: rgba(0,0,0,0.12);
      }
      .cu-pbtn.ro{ cursor:not-allowed; opacity:0.8; }
      .cu-pbtn.ro:hover{
        border-color: rgba(0,0,0,0.06);
        color:rgba(0,0,0,0.35);
        background:rgba(0,0,0,0.02);
      }
      .cu-modalBack{ position:fixed; inset:0; background:rgba(0,0,0,0.42); display:flex; align-items:center; justify-content:center; z-index:9999; padding:14px; }
      .cu-modal{ width:min(560px, 100%); background:#fff; border-radius:18px; border:1px solid rgba(0,0,0,0.10); box-shadow: 0 22px 70px rgba(0,0,0,0.22); overflow:hidden; }
      .cu-mh{ padding:14px 14px; display:flex; align-items:center; justify-content:space-between; gap:10px; border-bottom:1px solid rgba(0,0,0,0.08); }
      .cu-mt{ font-weight:1000; font-size:15px; }
      .cu-mx{ border:1px solid rgba(0,0,0,0.14); background:#fff; border-radius:12px; padding:8px 10px; cursor:pointer; font-weight:1000; }
      .cu-mx:hover{ border-var(--primary-readable, var(--primary,#d93025)); var(--primary-readable, var(--primary,#d93025)); }
      .cu-mb{ padding:14px; }
      .cu-msub{ font-size:12px; font-weight:850; color:#666; margin-top:4px; }
      .cu-rows{ display:grid; gap:10px; margin-top:12px; }
      .cu-row{ display:flex; flex-direction:column; gap:6px; }
      .cu-lbl{ font-size:11px; font-weight:950; color:#777; letter-spacing:.5px; text-transform:uppercase; }
      .cu-mactions{ padding:14px; border-top:1px solid rgba(0,0,0,0.08); display:flex; gap:10px; justify-content:flex-end; flex-wrap:wrap; }
      .cu-newAvatarRow{
        display:flex;
        justify-content:center;
        margin-bottom:2px;
      }
      .cu-newAvatarWrap{
        display:flex;
        flex-direction:column;
        align-items:center;
        gap:8px;
      }
      .cu-newAvatarNote{
        font-size:11px;
        font-weight:700;
        color:rgba(0,0,0,0.42);
        text-align:center;
      }

      /* ==========================================================
         MOBILE RESPONSIVE - max-width: 820px
         All mobile overrides below. Desktop is completely unaffected.
         ========================================================== */
      @media (max-width: 820px){

        /* --- Page wrapper --- */
        .cs-wrap{ padding:8px 2px; }
        .cs-title{ font-size:18px; }
        .cs-sub{ font-size:12px; }

        /* --- Tabs: horizontal scroll, no wrap --- */
        .cs-tabs{
          flex-wrap:nowrap;
          overflow-x:auto;
          -webkit-overflow-scrolling:touch;
          scrollbar-width:none;
          -ms-overflow-style:none;
          gap:8px;
          padding-bottom:2px;
        }
        .cs-tabs::-webkit-scrollbar{display:none}
        .cs-tab{
          flex-shrink:0;
          padding:9px 11px;
          font-size:13px;
          white-space:nowrap;
        }

        /* --- Card: tighter padding --- */
        .cs-card{
          padding:12px;
          border-radius:14px;
        }

        /* --- Company grid: always single column on mobile --- */
        .cs-grid{
          grid-template-columns:1fr !important;
        }

        /* --- Preview section: smaller on mobile --- */
        .cs-previewWrap{ padding:8px; }
        .cs-page{ max-height:320px; }

        /* --- Color line: wrap nicely --- */
        .cs-colorline{ flex-wrap:wrap; gap:8px; }

        /* --- Actions: full-width buttons --- */
        .cs-actions{
          flex-direction:column;
          gap:8px;
        }
        .cs-actions .cs-btn{
          width:100%;
          justify-content:center;
        }

        /* --- Inputs: larger touch targets --- */
        .cs-in{
          padding:14px 12px;
          font-size:16px; /* prevents iOS zoom */
          border-radius:12px;
        }

        /* **** USERS TABLE: card layout on mobile **** */
        .cu-top{
          flex-direction:column;
          align-items:stretch;
          gap:10px;
        }
        .cu-actions{
          justify-content:flex-start;
        }
        .cu-table{
          border-radius:14px;
        }
        .cu-th{
          display:none;
        }
        thead{
          display:none;
        }
        .cu-trMain{
          display:flex !important;
          flex-wrap:wrap;
          align-items:center;
          gap:6px 8px;
          padding:12px 44px 12px 12px;
          border-top:1px solid rgba(0,0,0,0.06);
          position:relative;
        }
        .cu-trMain:first-child{border-top:0}
        .cu-trMain .cu-td{
          padding:0;
          border-top:0 !important;
          display:flex;
          align-items:center;
          gap:8px;
        }
        /* User info cell: full width row */
        .cu-trMain .cu-td:first-child{
          flex:1 1 100%;
          min-width:0;
        }
        /* Level pill & status pill: inline, side by side */
        .cu-centerCell{
          flex:0 0 auto;
          text-align:left;
        }
        .cu-centerCell .cu-pill{
          margin:0;
          font-size:11px;
          padding:4px 8px;
        }
        /* Kebab: pinned top-right of card */
        .cu-actionsCell{
          position:absolute !important;
          top:12px;
          right:8px;
          width:auto;
          padding:0;
        }
        .cu-trPerm{
          display:block !important;
        }
        .cu-trPerm td{
          display:block !important;
        }
        .cu-permWrap.open{
          max-height:520px;
        }
        .cu-permInner{
          padding:10px 8px 12px;
        }
        .cu-permTop{
          flex-direction:column;
          align-items:stretch;
          gap:8px;
        }
        .cu-rolePresets{
          width:100%;
        }
        .cu-roleBtn{
          justify-content:center;
          flex:1 1 calc(50% - 6px);
        }
        .cu-roleBtn.custom{
          flex-basis:100%;
        }
        .cu-permHint{
          margin-left:0;
          text-align:left;
        }
        .cu-permGrid{
          gap:6px;
        }
        .cu-pbtn{
          font-size:11px;
          padding:8px 8px;
        }

        /* --- Floating menu: bottom sheet style on mobile --- */
        .cu-fmenu{
          left:8px !important;
          right:8px !important;
          bottom:8px !important;
          top:auto !important;
          width:auto !important;
          min-width:0;
          border-radius:16px;
        }
        .cu-mi{
          padding:14px 14px;
          font-size:14px;
        }

        /* --- User modals: near full-screen --- */
        .cu-modalBack{
          padding:8px;
          align-items:flex-end;
        }
        .cu-modal{
          width:100%;
          max-height:92vh;
          border-radius:16px 16px 0 0;
        }
        .cu-mb{
          padding:12px;
        }
        .cu-mb .cs-in{
          font-size:16px;
        }
        .cu-mactions{
          padding:12px;
          flex-direction:column;
        }
        .cu-mactions .cs-btn{
          width:100%;
          justify-content:center;
        }

        /* **** REPORTS **** */
        .rp-wrap{ padding:0; }
        .rp-card{ padding:12px; border-radius:14px; }
        .rp-h{ font-size:15px; }
        .rp-inline{ flex-direction:column; align-items:stretch; gap:8px; }
        .rp-num{ width:100%; }
        .rp-section{ padding:12px 0; }
        .rp-tgrid{
          grid-template-columns:1fr !important;
          gap:8px;
        }
        .rp-toggle{
          padding:10px;
          border-radius:14px;
          gap:8px;
        }
        .rp-toggle .rp-label{
          font-size:12px;
        }
        .app-flags-grid{
          column-count:1;
          column-gap:0;
        }

        /* **** BILLING **** */
        .bl-wrap{ padding:0; }
        .bl-grid{
          grid-template-columns:1fr !important;
        }
        .bl-card{ padding:12px; border-radius:14px; }
        .bl-h{ font-size:15px; }

        /* --- Billing rows: stack vertically --- */
        .bl-row{
          flex-direction:column;
          align-items:stretch;
          gap:8px;
        }
        .bl-left{
          justify-content:space-between;
        }
        .bl-ctrl{
          justify-content:center;
        }
        .bl-toggleLine{
          flex-direction:column;
          align-items:stretch;
          gap:8px;
          padding:10px;
        }
        .bl-money{
          width:80px;
        }
        .bl-stepBtn{
          padding:12px 14px;
        }

        /* --- Billing history --- */
        .bh-card{ padding:12px; border-radius:14px; }
        .bh-top{
          flex-direction:column;
          gap:8px;
        }
        .bh-list{
          max-height:400px;
          border-radius:12px;
        }
        .bh-head{
          grid-template-columns:60px 1fr max-content !important;
          gap:6px;
          padding:8px 10px;
          font-size:10px;
        }
        .bh-row{
          grid-template-columns:60px 1fr max-content !important;
          gap:6px;
          padding:10px 10px;
        }
        .bh-date{ font-size:11px; }
        .bh-time{ font-size:10px; margin-top:3px; }
        .bh-title{ font-size:12px; }
        .bh-subline{ font-size:11px; margin-top:3px; }
        .bh-delta{ font-size:11px; }

        /* --- Monthly Statement --- */
        .ms-card{ padding:12px; border-radius:14px; }
        .ms-top{
          flex-direction:column;
          align-items:stretch;
          gap:8px;
        }
        .ms-nav{
          justify-content:center;
        }
        .ms-monthLabel{
          min-width:110px;
          font-size:13px;
        }
        .ms-summary{
          flex-direction:column;
          gap:8px;
        }
        .ms-stat{
          min-width:0;
          padding:12px;
          border-radius:12px;
        }
        .ms-statVal{ font-size:18px; }
        .ms-actions{
          flex-direction:column;
        }
        .ms-actions .cs-btn{
          width:100%;
          justify-content:center;
        }

        /* --- Statement modal: full-screen on mobile --- */
        .ms-modalBack{
          padding:0;
          align-items:flex-end;
        }
        .ms-modal{
          width:100vw;
          max-height:100vh;
          border-radius:16px 16px 0 0;
        }
        .ms-mHeader{
          padding:12px 14px;
        }
        .ms-mTitle{ font-size:14px; }
        .ms-mBody{
          -webkit-overflow-scrolling:touch;
        }
        /* Statement table: responsive card rows */
        .ms-table th{
          padding:10px 10px;
          font-size:10px;
        }
        .ms-table td{
          padding:10px 10px;
          font-size:12px;
        }
        /* Hide # and Type columns on small screens */
        .ms-table th:nth-child(1),
        .ms-table td:nth-child(1),
        .ms-table th:nth-child(4),
        .ms-table td:nth-child(4){
          display:none;
        }
        .ms-mFooter{
          padding:10px 14px;
          flex-direction:column;
          gap:8px;
        }
        .ms-mFooter > div{
          width:100%;
        }
        .ms-mFooter > div:last-child{
          display:flex;
          flex-direction:column;
          gap:8px;
        }
        .ms-mFooter .cs-btn{
          width:100%;
          justify-content:center;
        }

        /* --- Mobile polish pass for Users + Billing --- */
        .cs-wrap{
          width:100%;
          min-width:0;
          overflow-x:hidden;
        }
        .cs-card,
        .cs-pane,
        .bl-wrap,
        .bl-card,
        .bh-card,
        .ms-card,
        .cu-table{
          min-width:0;
          max-width:100%;
          box-sizing:border-box;
        }
        .cu-actions{
          display:grid;
          grid-template-columns:repeat(2,minmax(0,1fr));
          gap:7px;
        }
        .cu-actions .cu-btn{
          min-width:0;
          width:100%;
          justify-content:center;
          padding:9px 8px;
          font-size:11px;
          gap:6px;
          white-space:nowrap;
        }
        .cu-actions .cu-btn:nth-child(3){
          grid-column:1/-1;
        }
        .cu-actions .cu-btn:first-child:last-child{
          grid-column:1/-1;
        }
        .cu-table,
        .cu-table tbody,
        .cu-trMain,
        .cu-trPerm{
          display:block;
          width:100%;
        }
        .cu-table{
          border:0;
          border-radius:0;
          overflow:visible;
          background:transparent;
        }
        .cu-trMain{
          margin:0 0 8px;
          border:1px solid rgba(0,0,0,0.08);
          border-radius:14px;
          background:#fff;
          box-shadow:0 8px 18px rgba(15,23,42,.04);
        }
        .cu-trMain.me{
          border-color:rgba(var(--primary-rgb,217,48,37),.18);
          box-shadow:0 0 0 3px rgba(var(--primary-rgb,217,48,37),.06);
        }
        .cu-userCell{
          align-items:flex-start;
          gap:9px;
        }
        .cu-userAvatar{
          width:34px;
          height:34px;
          border-radius:11px;
          font-size:14px;
        }
        .cu-userText{
          flex:1 1 auto;
          overflow:hidden;
        }
        .cu-userName,
        button.cu-userName,
        .cu-userEmail{
          max-width:100%;
          overflow:hidden;
          text-overflow:ellipsis;
          white-space:nowrap;
        }
        .cu-userName,
        button.cu-userName{
          font-size:13px;
        }
        .cu-userEmail{
          font-size:11px;
          margin-top:3px;
        }
        .cu-userCell .cu-tag.you{
          position:absolute;
          top:11px;
          right:43px;
          padding:4px 7px;
          font-size:10px;
          gap:4px;
        }
        .cu-centerCell{
          max-width:calc(50% - 4px);
        }
        .cu-centerCell .cu-pill{
          max-width:100%;
          overflow:hidden;
          text-overflow:ellipsis;
          white-space:nowrap;
        }
        .cu-kebab{
          width:32px;
          height:32px;
          padding:0;
          display:grid;
          place-items:center;
          border-radius:10px;
        }
        .cu-permShell{
          margin:-8px 0 10px;
          border:1px solid rgba(0,0,0,0.08);
          border-top:0;
          border-radius:0 0 14px 14px;
          background:#fbfcfe;
          overflow:hidden;
        }
        .cu-permWrap.open{
          max-height:none;
        }
        .cu-permInner{
          gap:9px;
        }
        .cu-rolePresets{
          display:grid;
          grid-template-columns:repeat(2,minmax(0,1fr));
          gap:6px;
        }
        .cu-roleBtn,
        .cu-roleBtn.custom{
          min-width:0;
          flex-basis:auto;
          padding:7px 6px;
          font-size:10.5px;
          gap:4px;
        }
        .cu-roleBtn.custom{
          grid-column:1/-1;
        }
        .cu-permGrid{
          display:grid;
          grid-template-columns:repeat(2,minmax(0,1fr));
        }
        .cu-permLabel{
          grid-column:1/-1;
        }
        .cu-pbtn{
          justify-content:flex-start;
          min-width:0;
          overflow:hidden;
        }
        .cu-pbtn span:last-child{
          min-width:0;
          overflow:hidden;
          text-overflow:ellipsis;
          white-space:nowrap;
        }
        .cu-fmenu{
          bottom:calc(8px + var(--referral-mobile-inset,0px)) !important;
          max-height:calc(100dvh - 24px - var(--referral-mobile-inset,0px));
          overflow:auto;
        }
        .cu-modalBack,
        .ms-modalBack{
          bottom:var(--referral-mobile-inset,0px);
        }
        .cu-modal{
          max-height:calc(100dvh - 16px - var(--referral-mobile-inset,0px));
          display:flex;
          flex-direction:column;
        }
        .cu-mb{
          overflow:auto;
          -webkit-overflow-scrolling:touch;
        }
        .bl-card[style*="margin-bottom"]{
          margin-bottom:10px!important;
        }
        .bl-row{
          margin-top:10px;
        }
        .bl-row[style*="align-items:center"]{
          align-items:stretch!important;
        }
        .bl-left{
          width:100%;
          min-width:0;
          align-items:flex-start;
          gap:6px;
        }
        .bl-pill{
          max-width:100%;
          padding:6px 8px;
          font-size:11px;
          gap:6px;
          white-space:normal;
          line-height:1.2;
        }
        .bl-ctrl{
          width:100%;
          display:grid;
          grid-template-columns:38px minmax(0,1fr) 38px;
          gap:6px;
          align-items:center;
        }
        .bl-card > .bl-row:first-child .bl-ctrl{
          grid-template-columns:minmax(0,1fr) auto;
          justify-content:stretch;
        }
        .bl-card > .bl-row:first-child .credits-value{
          font-size:22px!important;
          align-self:center;
        }
        .bl-card > .bl-row:first-child .cs-btn{
          min-height:36px;
          padding:9px 10px;
          white-space:nowrap;
        }
        .bl-toggleLine{
          gap:8px;
          padding:9px;
        }
        .bl-toggleLine .bl-left{
          flex-direction:row;
          align-items:center;
          justify-content:space-between;
        }
        .bl-switch{
          width:100%;
          justify-content:center;
          min-height:36px;
          padding:8px 10px;
        }
        .bl-stepBtn{
          width:38px;
          height:38px;
          padding:0;
          display:grid;
          place-items:center;
        }
        .bl-moneyWrap{
          width:100%;
        }
        .bl-money{
          width:100%;
          min-width:0;
          height:38px;
          text-align:center;
          padding:8px 12px 8px 24px;
        }
        .bl-summary{
          margin-top:10px;
          font-size:11.5px;
        }
        .bl-card .cs-actions{
          display:grid;
          grid-template-columns:1fr 1fr;
          gap:8px;
        }
        .bl-card .cs-actions .cs-btn{
          width:100%;
          justify-content:center;
          min-height:38px;
          padding:9px 10px;
          font-size:12px;
        }
        .bh-card,
        .ms-card{
          margin-top:10px;
        }
        .bh-top .bh-btn{
          width:100%;
          justify-content:center;
          min-height:36px;
          padding:8px 10px;
        }
        .bh-list{
          max-height:none;
          overflow:visible;
          border:0;
          background:transparent;
        }
        .bh-head{
          display:none;
        }
        .bh-row{
          grid-template-columns:minmax(58px,.7fr) minmax(0,1.5fr) minmax(68px,.8fr) !important;
          border:1px solid rgba(0,0,0,0.08);
          border-radius:12px;
          margin-bottom:8px;
          padding:9px;
        }
        .bh-balance{
          display:none;
        }
        .bh-delta{
          align-self:center;
        }
        .ms-nav{
          width:100%;
          display:grid;
          grid-template-columns:36px minmax(0,1fr) 36px;
        }
        .ms-navBtn{
          min-height:36px;
          justify-content:center;
          padding:0;
        }
        .ms-monthLabel{
          min-width:0;
          overflow:hidden;
          text-overflow:ellipsis;
          white-space:nowrap;
        }
        .ms-summary{
          display:grid;
          grid-template-columns:1fr;
        }
        .ms-modal{
          max-height:calc(100dvh - var(--referral-mobile-inset,0px));
        }
        .ms-table,
        .ms-table tbody,
        .ms-table tr,
        .ms-table td{
          display:block;
          width:100%;
        }
        .ms-table thead{
          display:none;
        }
        .ms-table tr{
          border:1px solid rgba(0,0,0,0.08);
          border-radius:12px;
          margin:10px;
          overflow:hidden;
          background:#fff;
        }
        .ms-table td,
        .ms-table td.right{
          display:block;
          text-align:left;
          border-top:0;
          padding:8px 10px;
          font-size:11.5px;
        }
      }

      /* Extra small phones */
      @media (max-width: 380px){
        .cs-tab{
          padding:8px 9px;
          font-size:12px;
        }
        .cu-pbtn{
          font-size:10px;
          padding:6px 6px;
        }
        .bl-money{
          width:70px;
        }
        /* Statement table: hide Date column too on tiny screens */
        .ms-table th:nth-child(3),
        .ms-table td:nth-child(3){
          display:none;
        }
      }
    `);
    // Dynamically build headers
    let headerHtml = `
      <div class="cs-wrap ${activeTab === 'pricebook' ? 'pricebook-wide' : ''} ${activeTab === 'forms' ? 'forms-wide' : ''}">
        <h2 class="cs-title">Settings</h2>
        <p class="cs-sub">Manage your company profile, users, report defaults, configuration, pricebook, forms, leads, and billing.</p>
        <div class="cs-tabs">
    `;
    if (canCompany) headerHtml += `<button class="cs-tab ${activeTab==='company'?'active':''}" id="csTabCompany"><i class="fas fa-building"></i> Company</button>`;
    if (canUsers)   headerHtml += `<button class="cs-tab ${activeTab==='users'?'active':''}" id="csTabUsers"><i class="fas fa-users"></i> Users</button>`;
    if (canReports) headerHtml += `<button class="cs-tab ${activeTab==='reports'?'active':''}" id="csTabReports"><i class="fas fa-file-lines"></i> Reports</button>`;
    if (canDocuments) headerHtml += `<button class="cs-tab ${activeTab==='documents'?'active':''}" id="csTabDocuments"><i class="fas fa-folder-open"></i> Documents</button>`;
    if (canConfiguration) headerHtml += `<button class="cs-tab ${activeTab==='configuration'?'active':''}" id="csTabConfiguration"><i class="fas fa-sliders"></i> Configuration</button>`;
    if (canScheduling) headerHtml += `<button class="cs-tab ${activeTab==='scheduling'?'active':''}" id="csTabScheduling"><i class="fas fa-calendar-days"></i> Scheduling</button>`;
    if (canCrews) headerHtml += `<button class="cs-tab ${activeTab==='crews'?'active':''}" id="csTabCrews"><i class="fas fa-helmet-safety"></i> Crews and Laborers</button>`;
    if (canCallWorkflows) headerHtml += `<button class="cs-tab ${activeTab==='call_workflows'?'active':''}" id="csTabCallWorkflows"><i class="fas fa-phone"></i> Call Workflows</button>`;
    if (canStorage) headerHtml += `<button class="cs-tab ${activeTab==='storage'?'active':''}" id="csTabStorage"><i class="fas fa-hard-drive"></i> Storage</button>`;
    if (canAppFlags) headerHtml += `<button class="cs-tab ${activeTab==='app_flags'?'active':''}" id="csTabAppFlags"><i class="fas fa-flask"></i> Feature Flags</button>`;
    if (canPricebook) headerHtml += `<button class="cs-tab ${activeTab==='pricebook'?'active':''}" id="csTabPricebook"><i class="fas fa-book"></i> Pricebook</button>`;
    if (canProposalSettings) headerHtml += `<button class="cs-tab ${activeTab==='proposals'?'active':''}" id="csTabProposals"><i class="fas fa-file-signature"></i> Proposals</button>`;
    if (canForms) headerHtml += `<button class="cs-tab ${activeTab==='forms'?'active':''}" id="csTabForms"><i class="fas fa-clipboard-list"></i> Forms and Leads</button>`;
    if (canBilling) headerHtml += `<button class="cs-tab ${activeTab==='billing'?'active':''}" id="csTabBilling"><i class="fas fa-credit-card"></i> Billing</button>`;
    headerHtml += `</div><div class="cs-card">`;
    if (canCompany) headerHtml += `<div class="cs-pane ${activeTab==='company'?'active':''}" id="csPaneCompany"></div>`;
    if (canUsers)   headerHtml += `<div class="cs-pane ${activeTab==='users'?'active':''}" id="csPaneUsers"></div>`;
    if (canReports) headerHtml += `<div class="cs-pane ${activeTab==='reports'?'active':''}" id="csPaneReports"></div>`;
    if (canDocuments) headerHtml += `<div class="cs-pane ${activeTab==='documents'?'active':''}" id="csPaneDocuments"></div>`;
    if (canConfiguration) headerHtml += `<div class="cs-pane ${activeTab==='configuration'?'active':''}" id="csPaneConfiguration"></div>`;
    if (canScheduling) headerHtml += `<div class="cs-pane ${activeTab==='scheduling'?'active':''}" id="csPaneScheduling"></div>`;
    if (canCrews) headerHtml += `<div class="cs-pane ${activeTab==='crews'?'active':''}" id="csPaneCrews"></div>`;
    if (canCallWorkflows) headerHtml += `<div class="cs-pane ${activeTab==='call_workflows'?'active':''}" id="csPaneCallWorkflows"></div>`;
    if (canStorage) headerHtml += `<div class="cs-pane ${activeTab==='storage'?'active':''}" id="csPaneStorage"></div>`;
    if (canAppFlags) headerHtml += `<div class="cs-pane ${activeTab==='app_flags'?'active':''}" id="csPaneAppFlags"></div>`;
    if (canPricebook) headerHtml += `<div class="cs-pane ${activeTab==='pricebook'?'active':''}" id="csPanePricebook"></div>`;
    if (canProposalSettings) headerHtml += `<div class="cs-pane ${activeTab==='proposals'?'active':''}" id="csPaneProposals"></div>`;
    if (canForms) headerHtml += `<div class="cs-pane ${activeTab==='forms'?'active':''}" id="csPaneForms"></div>`;
    if (canBilling) headerHtml += `<div class="cs-pane ${activeTab==='billing'?'active':''}" id="csPaneBilling"></div>`;
    headerHtml += `</div></div>`;
    panel.innerHTML = headerHtml;
    // Grab references
    const paneCompany = $('#csPaneCompany', panel);
    const paneUsers   = $('#csPaneUsers', panel);
    const paneReports = $('#csPaneReports', panel);
    const paneDocuments = $('#csPaneDocuments', panel);
    const paneConfiguration = $('#csPaneConfiguration', panel);
    const paneScheduling = $('#csPaneScheduling', panel);
    const paneCrews = $('#csPaneCrews', panel);
    const paneCallWorkflows = $('#csPaneCallWorkflows', panel);
    const paneStorage = $('#csPaneStorage', panel);
    const paneAppFlags = $('#csPaneAppFlags', panel);
    const panePricebook = $('#csPanePricebook', panel);
    const paneProposals = $('#csPaneProposals', panel);
    const paneForms = $('#csPaneForms', panel);
    const paneBilling = $('#csPaneBilling', panel);
    const tabCompany  = $('#csTabCompany', panel);
    const tabUsers    = $('#csTabUsers', panel);
    const tabReports  = $('#csTabReports', panel);
    const tabDocuments = $('#csTabDocuments', panel);
    const tabConfiguration = $('#csTabConfiguration', panel);
    const tabScheduling = $('#csTabScheduling', panel);
    const tabCrews = $('#csTabCrews', panel);
    const tabCallWorkflows = $('#csTabCallWorkflows', panel);
    const tabStorage = $('#csTabStorage', panel);
    const tabAppFlags = $('#csTabAppFlags', panel);
    const tabPricebook = $('#csTabPricebook', panel);
    const tabProposals = $('#csTabProposals', panel);
    const tabForms = $('#csTabForms', panel);
    const tabBilling  = $('#csTabBilling', panel);
    const settingsWrap = $('.cs-wrap', panel);
    function formatPhoneUS(raw){
      const d = String(raw || '').replace(/\D/g, '').slice(0, 10);
      if (d.length <= 3) return d;
      if (d.length <= 6) return `(${d.slice(0,3)}) ${d.slice(3)}`;
      return `(${d.slice(0,3)}) ${d.slice(3,6)}-${d.slice(6)}`;
    }
    function renderPricebook(){
      if (!panePricebook) return;
      const pricebook = window.FirstMatePricebook || window.Portal?.modules?.pricebook;
      if (!pricebook?.mount) {
        panePricebook.innerHTML = `<div class="cs-note">Pricebook library is unavailable.</div>`;
        return;
      }
      pricebook.mount(panePricebook, {
        title: 'Pricebook',
        subtitle: 'Centralized branch pricing items and proposal formulas.',
      });
    }
    async function renderProposalSettings(){
      if (!paneProposals) return;
      registerSettingsPages();
      if (!window.FirstMateSettingsPages?.mount) {
        paneProposals.innerHTML = `<div class="cs-note">Proposal settings library is unavailable.</div>`;
        return;
      }
      window.FirstMateSettingsPages.mount(paneProposals, 'proposals', {
        orgId: currentOrgId(),
        branchId: currentBranchId(),
        source: 'company_settings_proposals',
        embedded: false
      });
    }
    async function renderDocumentSettings(){
      if (!paneDocuments) return;
      const orgId = currentOrgId();
      const branchId = currentBranchId();
      const moduleId = 'document_settings';
      const normalize = (input = {}) => ({
        required_documents: (Array.isArray(input?.required_documents) ? input.required_documents : [])
          .map((item, index) => {
            const label = String(item?.label || item?.name || 'Required Document').trim() || 'Required Document';
            return {
              key: String(item?.key || item?.id || label || `required_${index + 1}`).trim().toLowerCase().replace(/[^a-z0-9_-]+/g, '_').replace(/^_+|_+$/g, '') || `required_${index + 1}`,
              label,
              document_type: String(item?.document_type || item?.type || 'required').trim() || 'required',
              enabled: item?.enabled !== false
            };
          })
      });
      paneDocuments.innerHTML = `<div class="cs-section"><h3>Document Settings</h3><p class="cs-note">Loading required document settings...</p></div>`;
      let settings = normalize({});
      try {
        if (orgId && window.PlatformAPI?.branchModules?.get) {
          const result = await window.PlatformAPI.branchModules.get(orgId, branchId, moduleId);
          settings = normalize(result?.module?.data || result?.data || {});
        }
      } catch (error) {
        if (Number(error?.status || 0) !== 404) {
          paneDocuments.innerHTML = `<div class="cs-note">${escapeHtml(error?.message || 'Could not load document settings.')}</div>`;
          return;
        }
      }
      const renderRows = (statusText = '') => {
        paneDocuments.innerHTML = `
          <div class="cs-section">
            <h3>Document Settings</h3>
            <p class="cs-note">Define branch-level required documents. Missing enabled items appear as required placeholders in each project's Docs tab.</p>
            <div class="cfg-actions"><button class="cs-btn" id="docReqAdd" type="button"><i class="fas fa-plus"></i> Add Required Document</button></div>
            <div class="cs-grid" id="docReqRows">
              ${settings.required_documents.map((item, index) => `
                <div class="li-switch-row" data-doc-req-row="${index}">
                  <div class="cs-grid" style="flex:1;grid-template-columns:minmax(180px,1fr) 150px;gap:10px">
                    <div class="cs-row"><div class="cs-lbl">Label</div><input class="cs-in" data-doc-req-label value="${escapeHtml(item.label)}"></div>
                    <div class="cs-row"><div class="cs-lbl">Type</div><input class="cs-in" data-doc-req-type value="${escapeHtml(item.document_type)}"></div>
                  </div>
                  <span class="li-switch"><input data-doc-req-enabled type="checkbox" ${item.enabled ? 'checked' : ''}><span class="li-slider"></span></span>
                </div>
              `).join('') || '<p class="cs-note">No required documents configured.</p>'}
            </div>
            <div class="li-actions">
              <button class="cs-btn primary" id="docReqSave" type="button"><i class="fas fa-save"></i> Save Document Settings</button>
              <span class="cs-note" id="docReqStatus">${escapeHtml(statusText)}</span>
            </div>
          </div>`;
        paneDocuments.querySelector('#docReqAdd')?.addEventListener('click', () => {
          settings.required_documents.push({ key: `required_${settings.required_documents.length + 1}`, label: 'Required Document', document_type: 'required', enabled: true });
          renderRows();
        });
        paneDocuments.querySelector('#docReqSave')?.addEventListener('click', async () => {
          const rows = [...paneDocuments.querySelectorAll('[data-doc-req-row]')];
          settings = normalize({
            required_documents: rows.map((row, index) => {
              const label = String(row.querySelector('[data-doc-req-label]')?.value || 'Required Document').trim() || 'Required Document';
              return {
                key: label.toLowerCase().replace(/[^a-z0-9_-]+/g, '_').replace(/^_+|_+$/g, '') || `required_${index + 1}`,
                label,
                document_type: String(row.querySelector('[data-doc-req-type]')?.value || 'required').trim() || 'required',
                enabled: !!row.querySelector('[data-doc-req-enabled]')?.checked
              };
            })
          });
          const status = paneDocuments.querySelector('#docReqStatus');
          try {
            status.textContent = 'Saving...';
            if (!orgId || !window.PlatformAPI?.branchModules?.save) throw new Error('Platform API is unavailable.');
            await window.PlatformAPI.branchModules.save(orgId, branchId, moduleId, settings, { kind: 'branch_document_settings', source: 'company_settings' });
            window.dispatchEvent(new CustomEvent('fm:document-settings:updated', { detail: settings }));
            showToast('Saved', 'Document settings updated.', true);
            renderRows('Saved.');
          } catch (error) {
            status.textContent = error?.message || 'Could not save document settings.';
            showToast('Save failed', status.textContent, false);
          }
        });
      };
      renderRows();
    }
    async function renderCrewSettings(){
      if (!paneCrews) return;
      const orgId = currentOrgId();
      const branchId = currentBranchId() || 'default';
      const money = (cents) => {
        const value = Number(cents || 0) / 100;
        return value ? value.toFixed(2) : '';
      };
      const cents = (value) => Math.max(0, Math.round(Number(value || 0) * 100));
      const uid = (prefix) => `${prefix}_${Date.now().toString(36)}${Math.random().toString(16).slice(2, 8)}`;
      const planFromCard = (root, scope = '') => ({
        type: root.querySelector(`[data-${scope}pay-type]`)?.value || 'hourly',
        hourly_rate_cents: cents(root.querySelector(`[data-${scope}hourly]`)?.value),
        salary_rate_cents: cents(root.querySelector(`[data-${scope}salary]`)?.value),
        salary_period: 'week',
        piece_rates: [],
        notes: root.querySelector(`[data-${scope}pay-notes]`)?.value || ''
      });
      const renderMemberRow = (member = {}) => `
        <div class="crew-member-row" data-member-id="${escapeHtml(member.id || uid('member'))}">
          <label class="cs-field"><span>Name</span><input data-member-name value="${escapeHtml(member.name || '')}" placeholder="Name"></label>
          <label class="cs-field"><span>Email</span><input data-member-email value="${escapeHtml(member.email || '')}" placeholder="email@company.com"></label>
          <label class="cs-field"><span>Role</span><input data-member-role value="${escapeHtml(member.role || 'laborer')}"></label>
          <label class="cs-field"><span>Pay</span><select data-member-pay-type>
            ${['hourly','piece_rate','salary','hybrid'].map((type) => `<option value="${type}" ${String(member.compensation_plan?.type || 'hourly') === type ? 'selected' : ''}>${type.replace('_', ' ')}</option>`).join('')}
          </select></label>
          <label class="cs-field"><span>Hourly</span><input data-member-hourly type="number" step="0.01" value="${escapeHtml(money(member.compensation_plan?.hourly_rate_cents))}"></label>
          <label class="cs-field"><span>Salary</span><input data-member-salary type="number" step="0.01" value="${escapeHtml(money(member.compensation_plan?.salary_rate_cents))}"></label>
          <button type="button" class="cs-btn icon" data-remove-member title="Remove member"><i class="fas fa-xmark"></i></button>
        </div>`;
      const collectCrew = (card, existing = {}) => {
        const members = Array.from(card.querySelectorAll('.crew-member-row')).map((row) => ({
          id: row.dataset.memberId || uid('member'),
          name: row.querySelector('[data-member-name]')?.value || 'Crew member',
          email: row.querySelector('[data-member-email]')?.value || '',
          role: row.querySelector('[data-member-role]')?.value || 'laborer',
          active: true,
          compensation_plan: {
            type: row.querySelector('[data-member-pay-type]')?.value || 'hourly',
            hourly_rate_cents: cents(row.querySelector('[data-member-hourly]')?.value),
            salary_rate_cents: cents(row.querySelector('[data-member-salary]')?.value),
            salary_period: 'week',
            piece_rates: []
          }
        }));
        const foremanId = card.querySelector('[data-crew-foreman]')?.value || '';
        return {
          ...existing,
          id: existing.id || card.dataset.crewId || uid('crew'),
          name: card.querySelector('[data-crew-name]')?.value || 'Crew',
          status: existing.status || 'active',
          archived_at: existing.archived_at || '',
          foreman_member_id: foremanId,
          default_contact_member_id: foremanId,
          project_types: String(card.querySelector('[data-project-types]')?.value || '').split(',').map((item) => item.trim()).filter(Boolean),
          compensation_plan: planFromCard(card, 'crew-'),
          notes: card.querySelector('[data-crew-notes]')?.value || '',
          members
        };
      };
      const render = (settings = {}, statusText = '') => {
        const crews = Array.isArray(settings.crews) ? settings.crews : [];
        const activeCrews = crews.filter((crew) => String(crew.status || 'active') !== 'archived' && !crew.archived_at);
        const archivedCrews = crews.filter((crew) => String(crew.status || 'active') === 'archived' || crew.archived_at);
        const crewCard = (crew = {}) => {
          const members = Array.isArray(crew.members) ? crew.members : [];
          const foreman = crew.foreman_member_id || crew.default_contact_member_id || members.find((member) => member.is_foreman)?.id || '';
          return `<section class="cs-subcard crew-settings-card ${crew.archived_at || crew.status === 'archived' ? 'archived' : ''}" data-crew-id="${escapeHtml(crew.id || '')}">
            <div class="crew-card-main">
              <label class="cs-field"><span>Crew name</span><input data-crew-name value="${escapeHtml(crew.name || '')}" placeholder="Install Crew A"></label>
              <label class="cs-field compact"><span>Foreman</span><select data-crew-foreman>
                <option value="">No foreman</option>
                ${members.map((member) => `<option value="${escapeHtml(member.id)}" ${String(member.id) === String(foreman) ? 'selected' : ''}>${escapeHtml(member.name || member.email || 'Member')}</option>`).join('')}
              </select></label>
            </div>
            <label class="cs-field"><span>Project types</span><input data-project-types value="${escapeHtml((crew.project_types || []).join(', '))}" placeholder="roofing, gutters, siding"></label>
            <div class="crew-rate-grid">
              <label class="cs-field"><span>Compensation plan</span><select data-crew-pay-type>
                ${['hourly','piece_rate','salary','hybrid'].map((type) => `<option value="${type}" ${String(crew.compensation_plan?.type || 'hourly') === type ? 'selected' : ''}>${type.replace('_', ' ')}</option>`).join('')}
              </select></label>
              <label class="cs-field"><span>Hourly</span><input data-crew-hourly type="number" step="0.01" value="${escapeHtml(money(crew.compensation_plan?.hourly_rate_cents))}"></label>
              <label class="cs-field"><span>Salary</span><input data-crew-salary type="number" step="0.01" value="${escapeHtml(money(crew.compensation_plan?.salary_rate_cents))}"></label>
              <label class="cs-field"><span>Notes</span><input data-crew-pay-notes value="${escapeHtml(crew.compensation_plan?.notes || '')}"></label>
            </div>
            <div>
              <div class="crew-member-head">
                <strong>Laborers</strong>
                <button type="button" class="cs-btn ghost" data-add-member><i class="fas fa-user-plus"></i> Add member</button>
              </div>
              <div data-member-list>${members.map(renderMemberRow).join('') || '<div class="cs-note" style="margin-top:8px;">No laborers on this crew yet.</div>'}</div>
            </div>
            <label class="cs-field"><span>Crew notes</span><textarea data-crew-notes rows="2">${escapeHtml(crew.notes || '')}</textarea></label>
            <div class="crew-card-actions">
              ${crew.archived_at || crew.status === 'archived'
                ? '<button type="button" class="cs-btn ghost" data-restore-crew><i class="fas fa-rotate-left"></i> Restore</button>'
                : '<button type="button" class="cs-btn ghost" data-archive-crew><i class="fas fa-box-archive"></i> Archive</button>'}
              <button type="button" class="cs-btn primary" data-save-crew><i class="fas fa-save"></i> Save crew</button>
            </div>
          </section>`;
        };
        paneCrews.innerHTML = `<div class="cs-section-head">
            <div><h3>Crews and Laborers</h3><p>Manage crews, foremen, project capabilities, and compensation plans.</p></div>
            <div style="display:flex;gap:8px;"><button type="button" class="cs-btn ghost" id="crewsReload"><i class="fas fa-rotate"></i> Reload</button><button type="button" class="cs-btn primary" id="crewsAdd"><i class="fas fa-plus"></i> New crew</button></div>
          </div>
          <div class="cs-note">Crews are archived instead of deleted, so historical assignments and labor rates stay intact.</div>
          <div id="crewsStatus" class="li-muted" style="margin-top:8px;">${escapeHtml(statusText)}</div>
          ${activeCrews.map(crewCard).join('') || '<div class="cs-note" style="margin-top:14px;">No active crews yet.</div>'}
          ${archivedCrews.length ? `<h4 style="margin:22px 0 0;">Archived crews</h4>${archivedCrews.map(crewCard).join('')}` : ''}`;
        const status = $('#crewsStatus', paneCrews);
        $('#crewsReload', paneCrews)?.addEventListener('click', () => load(true));
        $('#crewsAdd', paneCrews)?.addEventListener('click', async () => {
          if (status) status.textContent = 'Creating crew...';
          try {
            const result = await window.PlatformAPI.labor.upsertCrew(orgId, branchId, { name: 'New Crew', members: [] });
            window.dispatchEvent(new CustomEvent('fm:labor-crews:updated', { detail: { settings: result.settings } }));
            render(result.settings, 'Crew created.');
          } catch (error) {
            if (status) status.textContent = error?.message || 'Could not create crew.';
          }
        });
        paneCrews.querySelectorAll('.crew-settings-card').forEach((card) => {
          const existing = crews.find((crew) => String(crew.id || '') === String(card.dataset.crewId || '')) || {};
          card.querySelector('[data-add-member]')?.addEventListener('click', () => {
            const list = card.querySelector('[data-member-list]');
            if (!list) return;
            const note = list.querySelector('.cs-note');
            if (note) note.remove();
            list.insertAdjacentHTML('beforeend', renderMemberRow({ id: uid('member'), name: 'Crew member' }));
            list.lastElementChild?.querySelector('[data-remove-member]')?.addEventListener('click', (event) => event.currentTarget.closest('.crew-member-row')?.remove());
          });
          card.querySelectorAll('[data-remove-member]').forEach((btn) => btn.addEventListener('click', () => btn.closest('.crew-member-row')?.remove()));
          card.querySelector('[data-save-crew]')?.addEventListener('click', async () => {
            if (status) status.textContent = 'Saving crew...';
            try {
              const crew = collectCrew(card, existing);
              const result = await window.PlatformAPI.labor.upsertCrew(orgId, branchId, crew);
              window.dispatchEvent(new CustomEvent('fm:labor-crews:updated', { detail: { settings: result.settings } }));
              render(result.settings, 'Crew saved.');
            } catch (error) {
              if (status) status.textContent = error?.message || 'Could not save crew.';
            }
          });
          card.querySelector('[data-archive-crew]')?.addEventListener('click', async () => {
            if (!existing.id) return;
            if (status) status.textContent = 'Archiving crew...';
            try {
              const result = await window.PlatformAPI.labor.archiveCrew(orgId, branchId, existing.id);
              window.dispatchEvent(new CustomEvent('fm:labor-crews:updated', { detail: { settings: result.settings } }));
              render(result.settings, 'Crew archived.');
            } catch (error) {
              if (status) status.textContent = error?.message || 'Could not archive crew.';
            }
          });
          card.querySelector('[data-restore-crew]')?.addEventListener('click', async () => {
            if (status) status.textContent = 'Restoring crew...';
            try {
              const crew = { ...collectCrew(card, existing), status: 'active', archived_at: '', archived_by: '' };
              const result = await window.PlatformAPI.labor.upsertCrew(orgId, branchId, crew);
              window.dispatchEvent(new CustomEvent('fm:labor-crews:updated', { detail: { settings: result.settings } }));
              render(result.settings, 'Crew restored.');
            } catch (error) {
              if (status) status.textContent = error?.message || 'Could not restore crew.';
            }
          });
        });
      };
      const load = async (refresh = false) => {
        paneCrews.innerHTML = `<div class="cs-note">Loading crews...</div>`;
        try {
          if (!orgId || !window.PlatformAPI?.labor?.crews) throw new Error('Labor API is unavailable.');
          const result = await window.PlatformAPI.labor.crews(orgId, branchId);
          render(result.settings || {}, refresh ? 'Crew settings reloaded.' : '');
        } catch (error) {
          paneCrews.innerHTML = `<div class="cs-note">Crew management is unavailable. ${escapeHtml(error?.message || '')}</div>`;
        }
      };
      await load(false);
    }
    async function renderConfiguration(){
      if (!paneConfiguration) return;
      const orgId = String(window.__APP?.userOrgId || '').trim();
      const branchId = String(window.Portal?.branchModules?.currentBranchId?.() || window.__APP?.userBranchId || 'default').trim() || 'default';
      const moduleId = 'project_configuration';
      const normalize = (config) => {
        const mode = String(config?.title_mode || 'customer_name').trim();
        const celebrationMode = String(config?.celebrations_mode || config?.celebrations?.mode || 'on').trim();
        return {
          ...(config && typeof config === 'object' ? config : {}),
          title_mode: ['customer_name', 'address', 'manual'].includes(mode) ? mode : 'customer_name',
          celebrations_mode: ['on', 'small_only', 'off'].includes(celebrationMode) ? celebrationMode : 'on'
        };
      };
      let config = normalize(null);
      paneConfiguration.innerHTML = `<div class="cs-note">Loading configuration...</div>`;
      try {
        if (!orgId || !window.PlatformAPI?.branchModules?.get || !window.PlatformAPI?.branchModules?.save) throw new Error('Platform API is unavailable.');
        const doc = await window.PlatformAPI.branchModules.get(orgId, branchId, moduleId);
        config = normalize(doc?.data || doc || {});
      } catch (e) {
        if (Number(e?.status || 0) !== 404) {
          paneConfiguration.innerHTML = `<div class="cs-note">Configuration could not be loaded.</div>`;
          return;
        }
      }
      const render = (saving = false) => {
        const options = [
          ['customer_name', 'Customer name', 'Use the primary contact name. Falls back to address when no name is available.'],
          ['address', 'Property address', 'Use the property address. Falls back to primary contact name when no address is available.'],
          ['manual', 'Manual title', 'Show an editable project title field and keep saved overrides.']
        ];
        const celebrationOptions = [
          ['on', 'On', 'Allow small and large celebrations.'],
          ['small_only', 'Small only', 'Demote large celebrations to the small ding.'],
          ['off', 'Off', 'Suppress trigger-driven celebrations.']
        ];
        paneConfiguration.innerHTML = `
          <div class="cs-section">
            <h3>Project Titles</h3>
            <p class="cs-note">Choose how project titles render across this branch. Customer name is the default for new branches.</p>
            <div class="cfg-options">
              ${options.map(([value, label, description]) => `
                <button type="button" class="cfg-option ${config.title_mode === value ? 'active' : ''}" data-title-mode="${escapeHtml(value)}">
                  <strong>${escapeHtml(label)}</strong>
                  <span>${escapeHtml(description)}</span>
                </button>
              `).join('')}
            </div>
            <h3 style="margin-top:22px">Celebrations</h3>
            <p class="cs-note">Control celebratory sounds and effects for this branch. Trigger-driven celebrations respect this setting.</p>
            <div class="cfg-options">
              ${celebrationOptions.map(([value, label, description]) => `
                <button type="button" class="cfg-option ${config.celebrations_mode === value ? 'active' : ''}" data-celebrations-mode="${escapeHtml(value)}">
                  <strong>${escapeHtml(label)}</strong>
                  <span>${escapeHtml(description)}</span>
                </button>
              `).join('')}
            </div>
            <div class="cfg-actions">
              <button type="button" class="cs-btn" id="cfgTestSmallCelebration"><i class="fas fa-music"></i> Test Small</button>
              <button type="button" class="cs-btn" id="cfgTestLargeCelebration"><i class="fas fa-wand-magic-sparkles"></i> Test Large</button>
            </div>
            <div class="cfg-actions">
              <button type="button" class="cs-btn primary" id="cfgSaveTitleMode" ${saving ? 'disabled' : ''}>${saving ? '<i class="fas fa-spinner fa-spin"></i> Saving...' : '<i class="fas fa-save"></i> Save Configuration'}</button>
              <span class="cs-note" id="cfgStatus"></span>
            </div>
          </div>
        `;
        paneConfiguration.querySelectorAll('[data-title-mode]').forEach((button) => {
          button.addEventListener('click', () => {
            config.title_mode = button.dataset.titleMode || 'customer_name';
            render(false);
          });
        });
        paneConfiguration.querySelectorAll('[data-celebrations-mode]').forEach((button) => {
          button.addEventListener('click', () => {
            config.celebrations_mode = button.dataset.celebrationsMode || 'on';
            window.PlatformCelebrations?.configure?.({ mode: config.celebrations_mode });
            render(false);
          });
        });
        $('#cfgTestSmallCelebration', paneConfiguration)?.addEventListener('click', () => window.PlatformCelebrations?.small?.({ force: true, text: 'Small celebration preview' }));
        $('#cfgTestLargeCelebration', paneConfiguration)?.addEventListener('click', () => window.PlatformCelebrations?.large?.({ force: true, text: 'Large celebration preview' }));
        $('#cfgSaveTitleMode', paneConfiguration)?.addEventListener('click', async () => {
          render(true);
          try {
            await window.PlatformAPI.branchModules.save(orgId, branchId, moduleId, config, { kind: 'branch_project_configuration', source: 'company_settings' });
            window.dispatchEvent(new CustomEvent('fm:project-config:updated', { detail: config }));
            window.PlatformCelebrations?.configure?.({ mode: config.celebrations_mode });
            render(false);
            const status = $('#cfgStatus', paneConfiguration);
            if (status) status.textContent = 'Saved.';
          } catch (e) {
            render(false);
            showToast('Save failed', e?.message || 'Could not save configuration.', false);
          }
        });
      };
      render(false);
    }
    async function renderSchedulingSettings(){
      if (!paneScheduling) return;
      const orgId = String(window.__APP?.userOrgId || '').trim();
      const branchId = String(window.Portal?.branchModules?.currentBranchId?.() || window.__APP?.userBranchId || 'default').trim() || 'default';
      const dayLabels = [
        ['0', 'Sunday'],
        ['1', 'Monday'],
        ['2', 'Tuesday'],
        ['3', 'Wednesday'],
        ['4', 'Thursday'],
        ['5', 'Friday'],
        ['6', 'Saturday']
      ];
      const arrayOrDefault = (value, fallback) => Array.isArray(value) && value.length ? value : fallback;
      const normalizeTime = (value, fallback) => {
        const text = String(value || '').trim();
        return /^\d{2}:\d{2}$/.test(text) ? text : fallback;
      };
      const schedulingDefaultsFromConfig = (config) => {
        const current = config?.scheduling || {};
        const eventType = current.event_types?.sales_appointment || config?.event_types?.sales_appointment || {};
        const availability = current.availability || config?.availability || {};
        return {
          duration: Math.max(15, Number(eventType.duration_minutes || availability.sales_appointment_duration_minutes || 60) || 60),
          slot: Math.max(5, Number(eventType.slot_minutes || availability.sales_appointment_slot_minutes || 30) || 30),
          buffer: Math.max(0, Number(eventType.buffer_minutes || availability.sales_appointment_buffer_minutes || 30) || 30)
        };
      };
      const schedulingAvailabilityFromConfig = (config) => {
        const current = config?.scheduling || {};
        const availability = current.availability || config?.availability || {};
        const globalStart = normalizeTime(availability.sales_appointment_start_time, '09:00');
        const globalEnd = normalizeTime(availability.sales_appointment_end_time, '17:00');
        const workingHours = Array.isArray(availability.working_hours) ? availability.working_hours : [];
        const perDay = {};
        dayLabels.forEach(([value]) => {
          const day = Number(value);
          const hit = workingHours.find((entry) => Array.isArray(entry?.days) && entry.days.map(Number).includes(day));
          perDay[day] = {
            enabled: !!hit,
            start: normalizeTime(hit?.start || hit?.start_time, globalStart),
            end: normalizeTime(hit?.end || hit?.end_time, globalEnd)
          };
        });
        const activeDays = Object.entries(perDay).filter(([, entry]) => entry.enabled).map(([day]) => Number(day));
        return {
          start: globalStart,
          end: globalEnd,
          activeDays: activeDays.length ? activeDays : [1, 2, 3, 4, 5],
          perDay,
          useDaySpecificHours: availability.use_day_specific_hours === true || workingHours.some((entry) => Array.isArray(entry?.days) && entry.days.length === 1 && (normalizeTime(entry.start || entry.start_time, globalStart) !== globalStart || normalizeTime(entry.end || entry.end_time, globalEnd) !== globalEnd)),
          applyLimitsToInternalUsers: availability.apply_limits_to_internal_users === true
        };
      };
      let schedulingConfig = null;
      paneScheduling.innerHTML = `<div class="cs-note">Loading scheduling settings...</div>`;
      try {
        if (!orgId || !window.PlatformScheduling?.loadBranchConfig || !window.PlatformAPI?.branchModules?.save) throw new Error('Scheduling API is unavailable.');
        schedulingConfig = await window.PlatformScheduling.loadBranchConfig(orgId, branchId);
      } catch (e) {
        paneScheduling.innerHTML = `<div class="cs-note">${escapeHtml(e?.message || 'Could not load scheduling settings.')}</div>`;
        return;
      }
      const saveSchedulingWindow = async ({ start, end, days = [1, 2, 3, 4, 5], duration = 60, slot = 30, buffer = 30, useDaySpecificHours = false, perDay = {}, applyLimitsToInternalUsers = false } = {}) => {
        const current = schedulingConfig?.scheduling || {};
        const safeDays = (Array.isArray(days) ? days : []).map(Number).filter((day) => day >= 0 && day <= 6);
        const selectedDays = safeDays.length ? safeDays : [1, 2, 3, 4, 5];
        const workingHours = useDaySpecificHours
          ? selectedDays.map((day) => ({ days: [day], start: normalizeTime(perDay[day]?.start, start), end: normalizeTime(perDay[day]?.end, end) }))
          : [{ days: selectedDays, start, end }];
        const currentSalesEvent = (current.event_types || {}).sales_appointment || {};
        const eventTypes = {
          ...(current.event_types || {}),
          sales_appointment: {
            ...currentSalesEvent,
            id: 'sales_appointment',
            required_role_ids: arrayOrDefault(currentSalesEvent.required_role_ids, ['sales_appointments']),
            allowed_role_ids: arrayOrDefault(currentSalesEvent.allowed_role_ids, ['sales_appointments']),
            role_ids: arrayOrDefault(currentSalesEvent.role_ids, ['sales_appointments']),
            duration_minutes: Math.max(15, Number(duration) || 60),
            slot_minutes: Math.max(5, Number(slot) || 30),
            buffer_minutes: Math.max(0, Number(buffer) || 30),
            allow_unassigned: true,
            color: currentSalesEvent.color || '#2563eb',
            status: currentSalesEvent.status || 'active'
          }
        };
        const availability = {
          ...(current.availability || {}),
          sales_appointment_start_time: normalizeTime(start, '09:00'),
          sales_appointment_end_time: normalizeTime(end, '17:00'),
          sales_appointment_duration_minutes: Math.max(15, Number(duration) || 60),
          sales_appointment_slot_minutes: Math.max(5, Number(slot) || 30),
          sales_appointment_buffer_minutes: Math.max(0, Number(buffer) || 30),
          apply_limits_to_internal_users: !!applyLimitsToInternalUsers,
          use_day_specific_hours: !!useDaySpecificHours,
          working_hours: workingHours
        };
        const next = { ...current, event_types: eventTypes, availability };
        await window.PlatformAPI.branchModules.save(orgId, branchId, 'scheduling', next, { kind: 'branch_scheduling', source: 'company_settings' });
        schedulingConfig = window.PlatformScheduling?.refreshBranchConfig
          ? await window.PlatformScheduling.refreshBranchConfig(orgId, branchId)
          : { ...(schedulingConfig || {}), scheduling: next, availability };
        window.dispatchEvent(new CustomEvent('fm:dashboard:refresh'));
        window.dispatchEvent(new CustomEvent('fm:calendar:refresh'));
      };
      const schedulingButtonFeedback = (button, html, delay = 1200) => {
        if (!button) return;
        const previous = button.innerHTML;
        button.innerHTML = html;
        button.disabled = true;
        setTimeout(() => {
          button.innerHTML = previous;
          button.disabled = false;
        }, delay);
      };
      const render = () => {
        const schedule = schedulingAvailabilityFromConfig(schedulingConfig);
        const defaults = schedulingDefaultsFromConfig(schedulingConfig);
        paneScheduling.innerHTML = `
          <div class="cs-section">
            <h3>Scheduling</h3>
            <p class="cs-note">These branch hours control sales appointment availability in website booking forms and internal project scheduling when internal limits are enabled.</p>
            <div class="li-schedule-settings">
              <div class="cs-row"><div class="cs-lbl">Appointment Duration</div><input class="cs-in" id="liSalesDuration" type="number" min="15" step="15" value="${escapeHtml(defaults.duration)}"></div>
              <div class="cs-row"><div class="cs-lbl">Scheduling Increments</div><input class="cs-in" id="liSalesSlot" type="number" min="5" step="5" value="${escapeHtml(defaults.slot)}"></div>
              <div class="cs-row"><div class="cs-lbl">Time Between Appointments <span class="fm-ui-help" tabindex="0" data-fm-tooltip="This is reserved travel/setup time around each salesperson's appointment, so customers cannot book back-to-back appointments for the same person.">?</span></div><input class="cs-in" id="liSalesBuffer" type="number" min="0" step="5" value="${escapeHtml(defaults.buffer)}"></div>
            </div>
            <div class="li-schedule-window">
              <div class="li-schedule-stack">
                <div class="cs-row"><div class="cs-lbl">Earliest Appointment</div><input class="cs-in" id="liSalesStart" type="time" value="${escapeHtml(schedule.start || '09:00')}"></div>
                <div class="cs-row"><div class="cs-lbl">Latest Appointment</div><input class="cs-in" id="liSalesEnd" type="time" value="${escapeHtml(schedule.end || '17:00')}"></div>
              </div>
              <div class="li-schedule-stack">
                <div class="li-switch-row">
                  <div class="cs-lbl">Apply Limits Internally <span class="fm-ui-help" tabindex="0" data-fm-tooltip="Off means your team can book internal appointments outside these public customer-facing hours.">?</span></div>
                  <label class="li-switch"><input id="liApplyInternalLimits" type="checkbox" ${schedule.applyLimitsToInternalUsers ? 'checked' : ''}><span class="li-slider"></span></label>
                </div>
                <div class="li-switch-row">
                  <div class="cs-lbl">Specific Times By Day <span class="fm-ui-help" tabindex="0" data-fm-tooltip="Use different earliest/latest appointment times for selected days. New day rows default to the global earliest/latest times.">?</span></div>
                  <label class="li-switch"><input id="liUseDaySpecificHours" type="checkbox" ${schedule.useDaySpecificHours ? 'checked' : ''}><span class="li-slider"></span></label>
                </div>
              </div>
            </div>
            <div class="cs-row">
              <div class="cs-lbl">Available Days</div>
              <div class="li-day-grid">
                ${dayLabels.map(([value, label]) => `<button type="button" class="li-day-button ${schedule.activeDays.includes(Number(value)) ? 'active' : ''}" data-li-day="${value}">${escapeHtml(label)}</button>`).join('')}
              </div>
              <div class="li-day-specific ${schedule.useDaySpecificHours ? 'active' : ''}" id="liDaySpecificHours">
                ${dayLabels.map(([value, label]) => {
                  const day = Number(value);
                  const active = schedule.activeDays.includes(day);
                  const dayData = schedule.perDay[day] || { start: schedule.start, end: schedule.end };
                  return `<div class="li-day-row ${active ? '' : 'disabled'}" data-li-day-row="${value}">
                    <div class="li-day-row-title">${escapeHtml(label)}</div>
                    <input class="cs-in" type="time" data-li-day-start="${value}" value="${escapeHtml(dayData.start || schedule.start || '09:00')}" ${active ? '' : 'disabled'}>
                    <input class="cs-in" type="time" data-li-day-end="${value}" value="${escapeHtml(dayData.end || schedule.end || '17:00')}" ${active ? '' : 'disabled'}>
                  </div>`;
                }).join('')}
              </div>
            </div>
            <div class="li-actions"><button class="cs-btn primary" id="liSaveScheduling" type="button"><i class="fas fa-save"></i> Save Settings</button></div>
            <div class="cs-note" id="liSchedulingStatus"></div>
          </div>
        `;
        const syncDayRows = () => {
          const globalStart = $('#liSalesStart', paneScheduling)?.value || '09:00';
          const globalEnd = $('#liSalesEnd', paneScheduling)?.value || '17:00';
          paneScheduling.querySelectorAll('[data-li-day-row]').forEach((row) => {
            const day = row.getAttribute('data-li-day-row') || '';
            const active = !!paneScheduling.querySelector(`.li-day-button.active[data-li-day="${day}"]`);
            row.classList.toggle('disabled', !active);
            const startInput = row.querySelector(`[data-li-day-start="${day}"]`);
            const endInput = row.querySelector(`[data-li-day-end="${day}"]`);
            if (startInput) {
              startInput.disabled = !active;
              if (!startInput.value) startInput.value = globalStart;
            }
            if (endInput) {
              endInput.disabled = !active;
              if (!endInput.value) endInput.value = globalEnd;
            }
          });
        };
        paneScheduling.querySelectorAll('.li-day-button[data-li-day]').forEach((button) => {
          button.addEventListener('click', () => {
            const wasActive = button.classList.contains('active');
            button.classList.toggle('active', !wasActive);
            const day = button.dataset.liDay || '';
            const startInput = paneScheduling.querySelector(`[data-li-day-start="${day}"]`);
            const endInput = paneScheduling.querySelector(`[data-li-day-end="${day}"]`);
            if (!wasActive) {
              if (startInput && !startInput.value) startInput.value = $('#liSalesStart', paneScheduling)?.value || '09:00';
              if (endInput && !endInput.value) endInput.value = $('#liSalesEnd', paneScheduling)?.value || '17:00';
            }
            syncDayRows();
          });
        });
        $('#liUseDaySpecificHours', paneScheduling)?.addEventListener('change', (event) => {
          $('#liDaySpecificHours', paneScheduling)?.classList.toggle('active', !!event.currentTarget.checked);
          syncDayRows();
        });
        ['liSalesStart', 'liSalesEnd'].forEach((id) => {
          $(`#${id}`, paneScheduling)?.addEventListener('change', () => {
            paneScheduling.querySelectorAll(`[data-li-day-${id === 'liSalesStart' ? 'start' : 'end'}]`).forEach((input) => {
              if (!input.dataset.customized) input.value = $(`#${id}`, paneScheduling)?.value || input.value;
            });
          });
        });
        paneScheduling.querySelectorAll('[data-li-day-start],[data-li-day-end]').forEach((input) => {
          input.addEventListener('input', () => { input.dataset.customized = '1'; });
        });
        $('#liSaveScheduling', paneScheduling)?.addEventListener('click', async () => {
          const button = $('#liSaveScheduling', paneScheduling);
          const status = $('#liSchedulingStatus', paneScheduling);
          const start = normalizeTime($('#liSalesStart', paneScheduling)?.value, '09:00');
          const end = normalizeTime($('#liSalesEnd', paneScheduling)?.value, '17:00');
          const duration = Number($('#liSalesDuration', paneScheduling)?.value || 60);
          const slot = Number($('#liSalesSlot', paneScheduling)?.value || 30);
          const buffer = Number($('#liSalesBuffer', paneScheduling)?.value || 30);
          const days = Array.from(paneScheduling.querySelectorAll('.li-day-button.active[data-li-day]')).map((dayButton) => Number(dayButton.dataset.liDay));
          const perDay = {};
          dayLabels.forEach(([value]) => {
            perDay[Number(value)] = {
              start: normalizeTime(paneScheduling.querySelector(`[data-li-day-start="${value}"]`)?.value, start),
              end: normalizeTime(paneScheduling.querySelector(`[data-li-day-end="${value}"]`)?.value, end)
            };
          });
          try {
            if (button) button.disabled = true;
            if (status) status.textContent = 'Saving...';
            await saveSchedulingWindow({
              start,
              end,
              days,
              duration,
              slot,
              buffer,
              perDay,
              useDaySpecificHours: !!$('#liUseDaySpecificHours', paneScheduling)?.checked,
              applyLimitsToInternalUsers: !!$('#liApplyInternalLimits', paneScheduling)?.checked
            });
            render();
            schedulingButtonFeedback($('#liSaveScheduling', paneScheduling), '<i class="fas fa-check"></i> Saved');
            const nextStatus = $('#liSchedulingStatus', paneScheduling);
            if (nextStatus) nextStatus.textContent = 'Saved.';
            showToast('Saved', 'Scheduling settings updated.', true);
          } catch(e) {
            if (button) button.disabled = false;
            if (status) status.textContent = '';
            showToast('Save failed', e?.message || 'Could not save scheduling settings.', false);
          }
        });
        syncDayRows();
      };
      render();
    }
    function renderCallWorkflows(){
      if (!paneCallWorkflows) return;
      paneCallWorkflows.innerHTML = `
        <div class="cs-section">
          <h3>Call Workflows</h3>
          <div class="cfg-options">
            <button class="cfg-option active" type="button">
              <strong>New lead calls</strong>
              <span>Queue uncalled leads as soon as they arrive.</span>
            </button>
            <button class="cfg-option active" type="button">
              <strong>Follow-up calls</strong>
              <span>Queue follow-ups scheduled for today.</span>
            </button>
            <button class="cfg-option active" type="button">
              <strong>New customer calls</strong>
              <span>Queue signed customers for welcome calls.</span>
            </button>
          </div>
          <div class="cs-grid" style="margin-top:16px">
            <div>
              <div class="cs-row">
                <div class="cs-lbl">New Lead SLA</div>
                <select class="cs-in" id="cwLeadSla">
                  <option value="15">15 minutes</option>
                  <option value="30" selected>30 minutes</option>
                  <option value="60">1 hour</option>
                  <option value="240">4 hours</option>
                </select>
              </div>
              <div class="cs-row">
                <div class="cs-lbl">Follow-up Window</div>
                <select class="cs-in" id="cwFollowupWindow">
                  <option value="start">Start of business day</option>
                  <option value="due" selected>Scheduled due time</option>
                  <option value="end">End of business day</option>
                </select>
              </div>
              <div class="cs-row">
                <div class="cs-lbl">Welcome Call Timing</div>
                <select class="cs-in" id="cwWelcomeTiming">
                  <option value="same_day" selected>Same day as signed</option>
                  <option value="next_business_day">Next business day</option>
                  <option value="project_created">When project is created</option>
                </select>
              </div>
            </div>
            <div>
              <div class="cs-row">
                <div class="cs-lbl">Default Owner</div>
                <select class="cs-in" id="cwDefaultOwner">
                  <option value="inside_sales" selected>Inside sales</option>
                  <option value="sales_rep">Assigned sales rep</option>
                  <option value="project_owner">Project owner</option>
                </select>
              </div>
              <div class="cs-row">
                <div class="cs-lbl">Completion Status</div>
                <input class="cs-in" id="cwCompletionStatus" value="Called">
              </div>
              <div class="cs-row">
                <div class="cs-lbl">Missed Call Status</div>
                <input class="cs-in" id="cwMissedStatus" value="Left voicemail">
              </div>
            </div>
          </div>
          <div class="li-actions" style="margin-top:14px">
            <button class="cs-btn primary" id="cwSaveDraft" type="button"><i class="fas fa-save"></i> Save Draft</button>
            <button class="cs-btn ghost" id="cwOpenCalls" type="button"><i class="fas fa-phone"></i> Open Calls</button>
          </div>
          <div class="li-muted" id="cwStatus"></div>
        </div>
      `;
      paneCallWorkflows.querySelectorAll('.cfg-option').forEach((button) => {
        button.addEventListener('click', () => button.classList.toggle('active'));
      });
      $('#cwSaveDraft', paneCallWorkflows)?.addEventListener('click', () => {
        const status = $('#cwStatus', paneCallWorkflows);
        if (status) status.textContent = 'Draft call workflow settings saved in this browser session.';
        showToast('Draft saved', 'Call workflow settings are ready for the data hookup.', true);
      });
      $('#cwOpenCalls', paneCallWorkflows)?.addEventListener('click', () => {
        window.Portal?.tabs?.activateTab?.('calls');
      });
    }
    function openStorageCheckoutModal(){
      document.getElementById('storageCheckoutModal')?.remove();
      const back = document.createElement('div');
      back.id = 'storageCheckoutModal';
      back.className = 'storage-checkout-backdrop';
      back.innerHTML = `
        <div class="storage-checkout-modal" role="dialog" aria-modal="true" aria-labelledby="storageCheckoutTitle">
          <div class="storage-checkout-head">
            <div>
              <strong id="storageCheckoutTitle">Get More Storage</strong>
              <span>Storage checkout options will appear here.</span>
            </div>
            <button type="button" class="storage-checkout-close" data-storage-checkout-close aria-label="Close"><i class="fas fa-times"></i></button>
          </div>
          <div class="storage-checkout-body">Checkout placeholder</div>
      </div>`;
      document.body.appendChild(back);
      let modalHandle = null;
      const close = () => {
        modalHandle?.unregister?.();
        modalHandle = null;
        back.remove();
      };
      back.querySelector('[data-storage-checkout-close]')?.addEventListener('click', close);
      modalHandle = window.Portal?.modals?.register?.(back, {
        id: 'company-storage-checkout',
        closeOnEscape: true,
        closeOnBackdrop: true,
        onClose: close
      }) || null;
    }
    async function renderStorage(){
      if (!paneStorage) return;
      const orgId = String(window.__APP?.userOrgId || '').trim();
      const limitBytes = storageLimitBytes();
      const purchasable = purchasableStorageEnabled();
      paneStorage.innerHTML = `<div class="cs-section"><h3>Storage</h3><p class="cs-note">Loading media storage usage...</p></div>`;
      let usage = null;
      try {
        usage = await window.PlatformAPI?.mediaStorage?.get?.(orgId, { refresh: true });
      } catch (_) {
        usage = window.PlatformAPI?.mediaStorage?.current?.(orgId) || { used_bytes: 0 };
      }
      const usedBytes = Number(usage?.used_bytes || 0);
      const trash = window.Portal?.PhotoFeed?.trashStats
        ? await window.Portal.PhotoFeed.trashStats().catch(() => ({ count: 0, bytes: 0 }))
        : { count: 0, bytes: 0 };
      const pctRaw = limitBytes > 0 ? (usedBytes / limitBytes) * 100 : 0;
      const pct = Math.max(0, Math.min(100, pctRaw));
      paneStorage.innerHTML = `
        <div class="cs-section storage-card">
          <div>
            <h3>Storage</h3>
          </div>
          <div class="storage-hero">
            <div class="storage-row">
              <div>
                <div class="storage-total">${escapeHtml(formatStorageBytes(usedBytes))} <span>used</span></div>
                <div class="cs-note">Limit: ${escapeHtml(formatStorageBytes(limitBytes))} (${escapeHtml(String(freeStorageGB()))} GB included)</div>
              </div>
              <div class="li-actions" style="margin-top:0">
                <button class="cs-btn ghost" id="storageRefresh" type="button"><i class="fas fa-rotate"></i> Refresh</button>
                ${purchasable ? `<button class="cs-btn primary" id="storageBuy" type="button"><i class="fas fa-plus"></i> Get More Storage</button>` : ''}
              </div>
            </div>
            <div class="storage-bar" aria-label="Storage usage"><div class="storage-bar-fill" style="width:${pct}%"></div></div>
            <div class="storage-meta">
              <span>${escapeHtml(pctRaw.toFixed(pctRaw >= 10 ? 0 : 1))}% used</span>
              <span>${escapeHtml(formatStorageBytes(Math.max(0, limitBytes - usedBytes)))} available</span>
            </div>
            <div class="storage-trash">
              <div>
                <strong>Trash</strong>
                <span>${escapeHtml(String(trash.count || 0))} media item${Number(trash.count || 0) === 1 ? '' : 's'} still using ${escapeHtml(formatStorageBytes(trash.bytes || 0))}</span>
              </div>
              <div class="li-actions" style="margin-top:0">
                <button class="cs-btn ghost" id="storageOpenTrash" type="button"><i class="fas fa-trash"></i> Go to Trash</button>
                <button class="cs-btn danger" id="storageEmptyTrash" type="button"><i class="fas fa-trash-can"></i> Empty Trash</button>
              </div>
            </div>
          </div>
        </div>
      `;
      $('#storageRefresh', paneStorage)?.addEventListener('click', () => renderStorage());
      $('#storageBuy', paneStorage)?.addEventListener('click', openStorageCheckoutModal);
      $('#storageOpenTrash', paneStorage)?.addEventListener('click', () => window.Portal?.PhotoFeed?.openTrash?.());
      $('#storageEmptyTrash', paneStorage)?.addEventListener('click', async () => {
        await window.Portal?.PhotoFeed?.emptyTrash?.();
        renderStorage();
      });
    }
    function renderAppFlags(){
      if (!paneAppFlags) return;
      const state = window.Portal?.appFlags?.current?.() || {};
      const serverDefinitions = Array.isArray(state.definitions) ? state.definitions : [];
      const seenDefinitionKeys = new Set(serverDefinitions.map((definition) => String(definition.key || `${definition.group}.${definition.flag}`)));
      const definitions = [
        ...serverDefinitions,
        ...FRONTEND_APP_FLAG_DEFINITIONS.filter((definition) => !seenDefinitionKeys.has(definition.key))
      ];
      const raw = state.raw && typeof state.raw === 'object' ? JSON.parse(JSON.stringify(state.raw)) : {};
      const grouped = definitions.reduce((result, definition) => {
        const group = String(definition.group || '');
        if (!result[group]) result[group] = [];
        result[group].push(definition);
        return result;
      }, {});
      const groupLabel = (group) => ({
        platform: 'Platform',
        email: 'Email',
        canvassing: 'Canvassing',
        calls: 'Calls',
        lead_forms: 'Website Form Types',
        firstmeasure: 'FirstMeasure'
      }[group] || group);
      paneAppFlags.innerHTML = `
        <div class="cs-section">
          <h3>Experimental Feature Flags</h3>
          <p class="cs-note">These flags are only editable in configured admin test organizations. Dependencies are resolved by the server before Platform uses them.</p>
          <div class="app-flags-grid">
            ${Object.entries(grouped).map(([group, items]) => `
              <div class="cs-row wide app-flag-group">
                <div class="cs-lbl">${escapeHtml(groupLabel(group))}</div>
                <div class="app-flag-list">
                  ${items.map((definition) => {
                    const groupKey = String(definition.group || '');
                    const flagKey = String(definition.flag || '');
                    const isNumber = definition.type === 'number';
                    const isSelect = definition.type === 'select';
                    const rawValue = raw?.[groupKey]?.[flagKey];
                    const effectiveValue = state.effective?.[groupKey]?.[flagKey];
                    const defaultBool = definition.default ?? definition.defaultValue ?? true;
                    const value = isNumber || isSelect
                      ? (rawValue ?? effectiveValue ?? definition.defaultValue ?? 0)
                      : (typeof rawValue === 'boolean'
                          ? rawValue
                          : (typeof effectiveValue === 'boolean' ? effectiveValue : defaultBool !== false));
                    const reason = state.disabled_reasons?.[definition.key] || '';
                    if (isNumber) {
                      return `
                        <div class="cs-row wide app-flag-number" data-app-flag-number-row>
                          <div class="cs-lbl">
                            ${escapeHtml(definition.label || definition.key)}
                            <span style="display:block;font-size:11px;color:#667085;font-weight:750;margin-top:2px">${escapeHtml(definition.description || '')}</span>
                          </div>
                          <input class="cs-in" type="number" data-app-flag-number="${escapeHtml(definition.key)}" data-group="${escapeHtml(groupKey)}" data-flag="${escapeHtml(flagKey)}" min="${escapeHtml(definition.min ?? '')}" step="${escapeHtml(definition.step ?? '1')}" value="${escapeHtml(value)}">
                        </div>
                      `;
                    }
                    if (isSelect) {
                      const options = Array.isArray(definition.options) ? definition.options : [];
                      return `
                        <div class="cs-row wide app-flag-select" data-app-flag-select-row>
                          <div class="cs-lbl">
                            ${escapeHtml(definition.label || definition.key)}
                            <span style="display:block;font-size:11px;color:#667085;font-weight:750;margin-top:2px">${escapeHtml(definition.description || '')}</span>
                          </div>
                          <select class="cs-in" data-app-flag-select="${escapeHtml(definition.key)}" data-group="${escapeHtml(groupKey)}" data-flag="${escapeHtml(flagKey)}">
                            ${options.map((option) => {
                              const optValue = Array.isArray(option) ? option[0] : option;
                              const optLabel = Array.isArray(option) ? option[1] : option;
                              return `<option value="${escapeHtml(optValue)}" ${String(value) === String(optValue) ? 'selected' : ''}>${escapeHtml(optLabel)}</option>`;
                            }).join('')}
                          </select>
                        </div>
                      `;
                    }
                    return `
                      <label class="rp-toggle ${value ? 'on' : 'off'}" style="width:100%;justify-content:flex-start" data-app-flag-row>
                        <input type="checkbox" data-app-flag="${escapeHtml(definition.key)}" data-group="${escapeHtml(groupKey)}" data-flag="${escapeHtml(flagKey)}" ${value ? 'checked' : ''} style="display:none">
                        <span class="rp-dot"></span>
                        <span class="rp-label" style="display:flex;flex-direction:column;align-items:flex-start;gap:2px">
                          <span>${escapeHtml(definition.label || definition.key)}</span>
                          <span style="font-size:11px;color:#667085;font-weight:750">${escapeHtml(definition.description || '')}</span>
                          ${definition.requires?.length ? `<span style="font-size:11px;color:#8a6d00;font-weight:800">Requires ${escapeHtml(definition.requires.join(', '))}</span>` : ''}
                          ${reason ? `<span style="font-size:11px;color:#b42318;font-weight:850">Currently off: ${escapeHtml(reason)}</span>` : ''}
                        </span>
                        <span class="rp-state" style="margin-left:auto">${value ? 'On' : 'Off'}</span>
                      </label>
                    `;
                  }).join('')}
                </div>
              </div>
            `).join('')}
          </div>
          <div class="li-actions" style="margin-top:14px">
            <button class="cs-btn primary" id="appFlagsSave" type="button"><i class="fas fa-save"></i> Save Flags</button>
            <button class="cs-btn ghost" id="appFlagsReload" type="button"><i class="fas fa-rotate"></i> Reload</button>
          </div>
          <div class="li-muted" id="appFlagsStatus"></div>
        </div>
      `;
      paneAppFlags.querySelectorAll('[data-app-flag-row]').forEach((row) => {
        const input = row.querySelector('[data-app-flag]');
        row.addEventListener('click', (event) => {
          event.preventDefault();
          if (!input) return;
          input.checked = !input.checked;
          row.classList.toggle('on', input.checked);
          row.classList.toggle('off', !input.checked);
          const stateEl = row.querySelector('.rp-state');
          if (stateEl) stateEl.textContent = input.checked ? 'On' : 'Off';
        });
      });
      $('#appFlagsReload', paneAppFlags)?.addEventListener('click', async () => {
        const status = $('#appFlagsStatus', paneAppFlags);
        if (status) status.textContent = 'Reloading...';
        await window.Portal?.appFlags?.load?.({ refresh: true }).catch(() => null);
        renderAppFlags();
      });
      $('#appFlagsSave', paneAppFlags)?.addEventListener('click', async () => {
        const status = $('#appFlagsStatus', paneAppFlags);
        const next = {};
        paneAppFlags.querySelectorAll('[data-app-flag]').forEach((input) => {
          const group = input.dataset.group || '';
          const flag = input.dataset.flag || '';
          if (!group || !flag) return;
          if (!next[group]) next[group] = {};
          next[group][flag] = !!input.checked;
        });
        paneAppFlags.querySelectorAll('[data-app-flag-number]').forEach((input) => {
          const group = input.dataset.group || '';
          const flag = input.dataset.flag || '';
          if (!group || !flag) return;
          if (!next[group]) next[group] = {};
          next[group][flag] = Number(input.value || 0);
        });
        paneAppFlags.querySelectorAll('[data-app-flag-select]').forEach((input) => {
          const group = input.dataset.group || '';
          const flag = input.dataset.flag || '';
          if (!group || !flag) return;
          if (!next[group]) next[group] = {};
          next[group][flag] = String(input.value || '');
        });
        try {
          if (status) status.textContent = 'Saving...';
          await window.Portal?.appFlags?.update?.(next);
          await window.Portal?.appFlags?.load?.({ refresh: true }).catch(() => null);
          showToast('Saved', 'Feature flags updated.', true);
          renderAppFlags();
        } catch(e) {
          if (status) status.textContent = e?.message || 'Could not save feature flags.';
          showToast('Save failed', e?.message || 'Could not save feature flags.', false);
        }
      });
    }
    function setSubTab(which){
      activeTab = which;
      viewState.activeTab = which;
      if (settingsWrap) settingsWrap.classList.toggle('pricebook-wide', which === 'pricebook');
      if (settingsWrap) settingsWrap.classList.toggle('forms-wide', which === 'forms');
      if(tabCompany) tabCompany.classList.toggle('active', which === 'company');
      if(tabUsers)   tabUsers.classList.toggle('active', which === 'users');
      if(tabReports) tabReports.classList.toggle('active', which === 'reports');
      if(tabDocuments) tabDocuments.classList.toggle('active', which === 'documents');
      if(tabConfiguration) tabConfiguration.classList.toggle('active', which === 'configuration');
      if(tabScheduling) tabScheduling.classList.toggle('active', which === 'scheduling');
      if(tabCrews) tabCrews.classList.toggle('active', which === 'crews');
      if(tabCallWorkflows) tabCallWorkflows.classList.toggle('active', which === 'call_workflows');
      if(tabStorage) tabStorage.classList.toggle('active', which === 'storage');
      if(tabAppFlags) tabAppFlags.classList.toggle('active', which === 'app_flags');
      if(tabPricebook) tabPricebook.classList.toggle('active', which === 'pricebook');
      if(tabProposals) tabProposals.classList.toggle('active', which === 'proposals');
      if(tabForms) tabForms.classList.toggle('active', which === 'forms');
      if(tabBilling) tabBilling.classList.toggle('active', which === 'billing');
      if(paneCompany) paneCompany.classList.toggle('active', which === 'company');
      if(paneUsers)   paneUsers.classList.toggle('active', which === 'users');
      if(paneReports) paneReports.classList.toggle('active', which === 'reports');
      if(paneDocuments) paneDocuments.classList.toggle('active', which === 'documents');
      if(paneConfiguration) paneConfiguration.classList.toggle('active', which === 'configuration');
      if(paneScheduling) paneScheduling.classList.toggle('active', which === 'scheduling');
      if(paneCrews) paneCrews.classList.toggle('active', which === 'crews');
      if(paneCallWorkflows) paneCallWorkflows.classList.toggle('active', which === 'call_workflows');
      if(paneStorage) paneStorage.classList.toggle('active', which === 'storage');
      if(paneAppFlags) paneAppFlags.classList.toggle('active', which === 'app_flags');
      if(panePricebook) panePricebook.classList.toggle('active', which === 'pricebook');
      if(paneProposals) paneProposals.classList.toggle('active', which === 'proposals');
      if(paneForms) paneForms.classList.toggle('active', which === 'forms');
      if(paneBilling) paneBilling.classList.toggle('active', which === 'billing');
      if (which === 'users' && canUsers) refreshUsers();
      if (which === 'reports' && canReports) renderReports();
      if (which === 'documents' && canDocuments) renderDocumentSettings();
      if (which === 'configuration' && canConfiguration) renderConfiguration();
      if (which === 'scheduling' && canScheduling) renderSchedulingSettings();
      if (which === 'crews' && canCrews) renderCrewSettings();
      if (which === 'call_workflows' && canCallWorkflows) renderCallWorkflows();
      if (which === 'storage' && canStorage) renderStorage();
      if (which === 'app_flags' && canAppFlags) renderAppFlags();
      if (which === 'pricebook' && canPricebook) renderPricebook();
      if (which === 'proposals' && canProposalSettings) renderProposalSettings();
      if (which === 'forms' && canForms) renderForms();
      if (which === 'billing' && canBilling) renderBilling();
    }
    if(tabCompany) tabCompany.addEventListener('click', ()=>setSubTab('company'));
    if(tabUsers)   tabUsers.addEventListener('click', ()=>setSubTab('users'));
    if(tabReports) tabReports.addEventListener('click', ()=>setSubTab('reports'));
    if(tabDocuments) tabDocuments.addEventListener('click', ()=>setSubTab('documents'));
    if(tabConfiguration) tabConfiguration.addEventListener('click', ()=>setSubTab('configuration'));
    if(tabScheduling) tabScheduling.addEventListener('click', ()=>setSubTab('scheduling'));
    if(tabCrews) tabCrews.addEventListener('click', ()=>setSubTab('crews'));
    if(tabCallWorkflows) tabCallWorkflows.addEventListener('click', ()=>setSubTab('call_workflows'));
    if(tabStorage) tabStorage.addEventListener('click', ()=>setSubTab('storage'));
    if(tabAppFlags) tabAppFlags.addEventListener('click', ()=>setSubTab('app_flags'));
    if(tabPricebook) tabPricebook.addEventListener('click', ()=>setSubTab('pricebook'));
    if(tabProposals) tabProposals.addEventListener('click', ()=>setSubTab('proposals'));
    if(tabForms) tabForms.addEventListener('click', ()=>setSubTab('forms'));
    if(tabBilling) tabBilling.addEventListener('click', ()=>setSubTab('billing'));

    async function renderForms(){
      viewState.activeFormKind = 'instant_estimate';
      return renderLeadImport({ target: paneForms });
    }
    async function renderLeadImport(options = {}){
      const leadPane = options.target;
      if (!leadPane) return;
      const orgId = String(window.__APP?.userOrgId || '').trim();
      const branchId = String(window.Portal?.branchModules?.currentBranchId?.() || window.__APP?.userBranchId || 'default').trim() || 'default';
      const flags = { ...leadImportFlagState() };
      flags.website = !!flags.forms;
      flags.canvassing = false;
      const firstPane = flags.website ? 'website' : (flags.email ? 'email' : '');
      if (!orgId || !firstPane || ((flags.email && !window.EmailAPI?.leadImport) || (flags.website && !window.LeadIntakeAPI?.settings))) {
        leadPane.innerHTML = `<div class="li-muted">Lead import settings are unavailable.</div>`;
        return;
      }
      const fontOptions = ['Montserrat','Inter','Roboto','Open Sans','Lato','Poppins','Source Sans 3'];
      const fontStack = (font) => `"${String(font || 'Montserrat').replace(/["\\]/g, '')}",Arial,sans-serif`;
      const plainText = (value, fallback = '', seen = new Set()) => {
        if (value == null) return fallback;
        if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
          const text = String(value);
          return text === '[object Object]' ? fallback : text;
        }
        if (Array.isArray(value)) {
          for (const item of value) {
            const text = plainText(item, '', seen).trim();
            if (text) return text;
          }
          return fallback;
        }
        if (typeof value === 'object') {
          if (seen.has(value)) return fallback;
          seen.add(value);
          const keys = ['formatted_address','address','message','title','detail','error','errors','reason','statusText','url','src','href','image_url','mask_url','rgb_url','label','description','name','value'];
          for (const key of keys) {
            const text = plainText(value[key], '', seen).trim();
            if (text && text !== '[object Object]') return text;
          }
          for (const nested of Object.values(value)) {
            const text = plainText(nested, '', seen).trim();
            if (text && text !== '[object Object]') return text;
          }
          return fallback;
        }
        return fallback;
      };
      const pickUrl = (...values) => {
        for (const value of values) {
          const text = plainText(value, '').trim();
          if (text && text !== '[object Object]') return text;
        }
        return '';
      };
      const slugLabel = (label) => String(label || 'option').trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'option';
      const normalizeEstimatePreviewResult = (data) => {
        const source = (data && typeof data === 'object') ? data : {};
        const preview = source.preview || source.image || source.assets || {};
        const measurement = source.measurement || source.measurements || {};
        const estimate = source.estimate || {};
        return {
          ...source,
          formatted_address: plainText(source.formatted_address || source.address || preview.formatted_address || ''),
          error: plainText(source.error || source.message || ''),
          estimate: {
            ...estimate,
            roof_area_sqft: Number(estimate.roof_area_sqft || measurement.roof_area_sqft || 0) || 0,
            low: Number(estimate.low || estimate.low_price || 0) || 0,
            high: Number(estimate.high || estimate.high_price || 0) || 0
          },
          measurement: {
            ...measurement,
            roof_area_sqft: Number(measurement.roof_area_sqft || estimate.roof_area_sqft || 0) || 0,
            error: plainText(measurement.error || '')
          },
          preview: {
            ...(preview && typeof preview === 'object' ? preview : {}),
            formatted_address: plainText(preview.formatted_address || source.formatted_address || source.address || ''),
            image: pickUrl(preview, preview.image, preview.image_url, preview.rgb_url, preview.rgb, preview.url, source.preview, source.image_url, source.rgb_url),
            mask: pickUrl(preview.mask, preview.mask_url, preview.maskUrl, preview.assets?.mask_url, source.mask, source.mask_url, source.assets?.mask_url),
            error: plainText(preview.error || '')
          }
        };
      };
      let leadSettings = null;
      let schedulingConfig = null;
      let activeFormKind = viewState.activeFormKind || 'instant_estimate';
      const savedLeadPaneAllowed = (viewState.activeLeadPane === 'email' && flags.email) || (viewState.activeLeadPane === 'website' && flags.website);
      let activeLeadPane = savedLeadPaneAllowed ? viewState.activeLeadPane : firstPane;
      viewState.activeLeadPane = activeLeadPane;
      let selectedFormId = '';
      let previewMode = viewState.previewMode || 'desktop';
      const rememberEditorScroll = () => {
        const scroller = panelWebsite?.querySelector?.('.li-editor > .cs-card');
        if (scroller) viewState.formsEditorScrollTop = scroller.scrollTop;
      };
      const restoreEditorScroll = () => {
        const top = Number(viewState.formsEditorScrollTop || 0);
        requestAnimationFrame(() => {
          const scroller = panelWebsite?.querySelector?.('.li-editor > .cs-card');
          if (scroller) scroller.scrollTop = top;
        });
      };

      const uid = (prefix) => `${prefix}_${Date.now().toString(36)}${Math.random().toString(16).slice(2, 10)}`;
      const cssVar = (name, fallback) => getComputedStyle(document.documentElement).getPropertyValue(name).trim() || fallback;
      const defaultForm = () => ({
        id: uid('form'),
        enabled: true,
        name: 'Website Appointment Form',
        tracking_key: 'website-appointment',
        mode: 'appointment',
        copy: {
          headline: 'Schedule an appointment',
          subheadline: 'Tell us where to reach you and we will confirm the next step.',
          submit_label: 'Request Appointment',
          fine_print: 'By submitting, you agree to be contacted about your request.',
          success_title: 'Request received',
          success_body: 'We have your information and will follow up shortly.'
        },
        style: {
          primary_color: cssVar('--primary-readable', cssVar('--primary', DEFAULT_PRIMARY)),
          secondary_color: cssVar('--secondary', DEFAULT_SECONDARY),
          background_color: '#ffffff',
          text_color: '#111827',
          font_family: 'Montserrat',
          logo_enabled: !!state.logo,
          logo_url: state.logo || ''
        },
        scheduling: {
          event_type_default_id: 'sales_appointment',
          duration_minutes: 60,
          slot_minutes: 30,
          min_notice_minutes: 120,
          available_days: [1,2,3,4,5],
          start_time: '09:00',
          end_time: '17:00',
          required_role_ids: [],
          allowed_role_ids: ['sales_appointments']
        }
      });
      const defaultEstimateForm = () => {
        const primary = cssVar('--primary-readable', cssVar('--primary', DEFAULT_PRIMARY));
        const secondary = cssVar('--secondary', DEFAULT_SECONDARY);
        return {
          ...defaultForm(),
          id: uid('estimate_form'),
          name: 'Instant Estimate Form',
          tracking_key: 'instant-estimate',
          mode: 'instant_estimate',
          copy: {
            headline: 'Get a free instant estimate',
            subheadline: 'Use satellite imagery to preview your roof replacement options in minutes.',
            submit_label: 'Get my estimate',
            fine_print: 'This is a preliminary estimate. Final pricing may change after inspection, measurements, materials, and scope review.',
            success_title: 'Estimate ready',
            success_body: 'Review your estimated range and request the next step.'
          },
          style: {
            primary_color: primary,
            secondary_color: secondary,
            background_color: '#ffffff',
            text_color: '#111827',
            font_family: 'Montserrat',
            logo_enabled: !!state.logo,
            logo_url: state.logo || '',
            use_company_colors: true
          },
          estimate: {
            low_price_sqft: 6.75,
            high_price_sqft: 11.5,
            pricing_matrix: DEFAULT_ESTIMATE_PRICING.map((row) => ({ ...row })),
            default_sqft: 2200,
            map_zoom: 19,
            waste_factor_percent: 0,
            min_price: 0,
            send_customer_email: true,
            email_subject: 'Your instant roof estimate',
            email_intro: 'Thanks. Based on your submission, here is your preliminary project range.',
            email_cta_label: 'Schedule the next step',
            email_cta_url: '',
            disclaimer: 'This is a preliminary estimate. Final pricing may change after inspection, measurements, materials, and scope review.',
            steps: ['welcome','address','slope','current_material','roof_age','damage','desired_material','timeline','financing','contact','results'],
            pages: defaultEstimatePages()
          }
        };
      };
      const defaultSubmitForm = () => ({
        ...defaultForm(),
        id: uid('submit_form'),
        name: 'Contact Form',
        tracking_key: 'contact-form',
        mode: 'submit_form',
        copy: {
          headline: 'Tell us about your project',
          subheadline: 'Send your information and our team will follow up with the right next step.',
          submit_label: 'Submit request',
          fine_print: 'By submitting, you agree to be contacted about your request.',
          success_title: 'Request received',
          success_body: 'We have your information and will follow up shortly.'
        },
        fields: [
          { id: 'name', label: 'Name', type: 'text', required: true, placeholder: 'Enter your full name' },
          { id: 'email', label: 'Email', type: 'email', required: true, placeholder: 'Enter your email' },
          { id: 'phone', label: 'Phone', type: 'tel', required: true, placeholder: 'Enter your phone number' },
          { id: 'address', label: 'Address', type: 'text', required: false, placeholder: 'Project address' },
          { id: 'message', label: 'Project details', type: 'textarea', required: false, placeholder: 'What can we help with?' }
        ]
      });
      const forms = () => {
        const serverForms = Array.isArray(leadSettings?.website_forms) ? leadSettings.website_forms : [];
        return serverForms;
      };
      const formKindFor = (form) => form?.mode === 'instant_estimate' ? 'instant_estimate' : (form?.mode === 'submit_form' ? 'submit_form' : 'appointment');
      const formKindMeta = {
        instant_estimate: { label: 'Instant Estimate', icon: 'fa-calculator', createLabel: 'Add Instant Estimate' },
        appointment: { label: 'Appointment Form', icon: 'fa-calendar-check', createLabel: 'Add Appointment Form' },
        submit_form: { label: 'Contact Form', icon: 'fa-address-card', createLabel: 'Add Contact Form' }
      };
      const formKindFlag = {
        instant_estimate: ['lead_forms', 'instant_estimate'],
        appointment: ['lead_forms', 'appointment_form'],
        submit_form: ['lead_forms', 'contact_form']
      };
      const formKindAllowed = (kind) => {
        const pair = formKindFlag[kind];
        return !pair || appFlag(pair[0], pair[1]);
      };
      const allowedFormKindMeta = () => Object.fromEntries(Object.entries(formKindMeta).filter(([key]) => formKindAllowed(key)));
      const allowedForms = () => forms().filter((form) => formKindAllowed(formKindFor(form)));
      const currentForm = () => allowedForms().find((form) => form.id === selectedFormId) || allowedForms()[0] || null;
      const embedSrc = () => `${location.origin}/libraries/lead-embed/firstmate-lead-embed.js`;
      const embedCode = (form) => form?.mode === 'instant_estimate'
        ? `<div id="firstmate-instant-estimate-${form.id}"></div>`
        : `<div id="firstmate-lead-${form.id}"></div>\n<script src="${embedSrc()}" data-form-id="${form.id}" data-target="#firstmate-lead-${form.id}"></script>`;
      const slugify = (value) => String(value || '')
        .trim()
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-+|-+$/g, '') || 'website-form';
      const uniqueTrackingKey = (name, currentId = '') => {
        const base = slugify(name);
        const used = new Set(forms()
          .filter((item) => String(item.id || '') !== String(currentId || ''))
          .map((item) => String(item.tracking_key || '').trim())
          .filter(Boolean));
        let key = base;
        let index = 1;
        while (used.has(key)) {
          key = `${base}-${index}`;
          index += 1;
        }
        return key;
      };
      const feedbackButton = (button, html, delay = 1200) => {
        if (!button) return;
        const previous = button.dataset.defaultHtml || button.innerHTML;
        button.innerHTML = html;
        button.classList.add('li-inline-feedback');
        button.disabled = false;
        window.setTimeout(() => {
          button.innerHTML = previous;
          button.classList.remove('li-inline-feedback');
        }, delay);
      };
      const normalizedColor = (value, fallback) => clampHex(value, fallback);
      const colorControl = (id, value) => {
        const hex = normalizedColor(value, DEFAULT_PRIMARY);
        return `
          <div class="cs-colorline">
            <input type="color" class="cs-color" id="${escapeHtml(id)}" value="${escapeHtml(hex)}">
            <span class="cs-chip"><span class="hash">#</span><input id="${escapeHtml(id)}Hex" maxlength="6" autocomplete="off" spellcheck="false" value="${escapeHtml(hex.replace('#', ''))}"></span>
          </div>
        `;
      };
      const bindColorControl = (root, id, onChange) => {
        const color = $(`#${id}`, root);
        const hex = $(`#${id}Hex`, root);
        const sync = (value, fromHex = false) => {
          const next = normalizedColor(fromHex ? `#${value}` : value, id.includes('Text') ? '#111827' : DEFAULT_PRIMARY);
          if (color) color.value = next;
          if (hex) hex.value = next.replace('#', '');
          onChange?.(next);
        };
        color?.addEventListener('input', () => sync(color.value, false));
        hex?.addEventListener('input', () => sync(hex.value, true));
      };
      const localDateText = (date = new Date()) => {
        const d = date instanceof Date ? date : new Date(date);
        return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
      };
      const dateFromText = (value) => {
        const [year, month, day] = String(value || localDateText()).split('-').map(Number);
        const date = new Date(year || new Date().getFullYear(), (month || 1) - 1, day || 1);
        date.setHours(12, 0, 0, 0);
        return date;
      };
      const addDays = (date, days) => {
        const next = new Date(date.getTime());
        next.setDate(next.getDate() + Number(days || 0));
        return next;
      };
      const calendarDays = (selectedDate) => {
        const selected = dateFromText(selectedDate);
        const first = new Date(selected.getFullYear(), selected.getMonth(), 1);
        first.setHours(12, 0, 0, 0);
        const start = addDays(first, -first.getDay());
        return Array.from({ length: 42 }, (_, index) => addDays(start, index));
      };
      const upcomingDays = (count = 21) => {
        const today = new Date();
        today.setHours(12, 0, 0, 0);
        return Array.from({ length: count }, (_, index) => addDays(today, index));
      };
      const previewState = viewState.websitePreviewState || (viewState.websitePreviewState = {});
      const formPreviewState = (form) => {
        const id = String(form?.id || 'new');
        if (!previewState[id]) previewState[id] = { selectedDate: localDateText(), selectedStart: '', submitted: false };
        return previewState[id];
      };
      const centerInScroller = (scroller, item, axis = 'x', behavior = 'smooth') => {
        if (!scroller || !item) return;
        const scrollerRect = scroller.getBoundingClientRect();
        const itemRect = item.getBoundingClientRect();
        if (axis === 'y') {
          const delta = (itemRect.top + itemRect.height / 2) - (scrollerRect.top + scrollerRect.height / 2);
          scroller.scrollTo({ top: Math.max(0, scroller.scrollTop + delta), behavior });
          return;
        }
        const delta = (itemRect.left + itemRect.width / 2) - (scrollerRect.left + scrollerRect.width / 2);
        scroller.scrollTo({ left: Math.max(0, scroller.scrollLeft + delta), behavior });
      };
      const restoreHorizontalScroll = (scroller, left) => {
        if (!scroller) return;
        const previousBehavior = scroller.style.scrollBehavior;
        scroller.style.scrollBehavior = 'auto';
        scroller.scrollLeft = left;
        void scroller.offsetWidth;
        scroller.style.scrollBehavior = previousBehavior;
      };
      const centerPreviewDate = (behavior = 'smooth') => {
        const scroller = $('#liLivePreview .li-preview-mobile-days', panelWebsite);
        requestAnimationFrame(() => requestAnimationFrame(() => centerInScroller(scroller, scroller?.querySelector('.li-preview-daypill.active'), 'x', behavior)));
      };
      const centerPreviewTime = (behavior = 'smooth') => {
        const scroller = $('#liLivePreview .li-preview-slots', panelWebsite);
        requestAnimationFrame(() => centerInScroller(scroller, scroller?.querySelector('.li-preview-slot.active'), 'y', behavior));
      };

      const formKindTabs = Object.entries(allowedFormKindMeta());
      leadPane.innerHTML = `
        <div class="li-subtabs">
          ${flags.website ? formKindTabs.map(([key, meta]) => `<button class="li-subtab ${activeLeadPane === 'website' && activeFormKind === key ? 'active' : ''}" data-form-kind="${escapeHtml(key)}" type="button"><i class="fas ${escapeHtml(meta.icon)}"></i> ${escapeHtml(meta.label)}</button>`).join('') : ''}
          ${flags.email ? `<button class="li-subtab ${activeLeadPane === 'email' ? 'active' : ''}" data-li-pane="email" type="button"><i class="fas fa-envelope"></i> Lead Import</button>` : ''}
        </div>
        ${flags.website ? `<div class="li-panel ${activeLeadPane === 'website' ? 'active' : ''}" id="liPanelWebsite"></div>` : ''}
        ${flags.email ? `<div class="li-panel ${activeLeadPane === 'email' ? 'active' : ''}" id="liPanelEmail"></div>` : ''}
      `;
      const panelEmail = $('#liPanelEmail', leadPane);
      const panelWebsite = $('#liPanelWebsite', leadPane);

      const setLeadPane = (pane) => {
        activeLeadPane = pane;
        viewState.activeLeadPane = pane;
        leadPane.querySelectorAll('[data-li-pane]').forEach((button) => button.classList.toggle('active', button.dataset.liPane === pane));
        leadPane.querySelectorAll('[data-form-kind]').forEach((button) => button.classList.toggle('active', pane === 'website' && button.dataset.formKind === activeFormKind));
        if (panelEmail) panelEmail.classList.toggle('active', pane === 'email');
        if (panelWebsite) panelWebsite.classList.toggle('active', pane === 'website');
      };
      leadPane.querySelectorAll('[data-li-pane]').forEach((button) => button.addEventListener('click', () => setLeadPane(button.dataset.liPane || 'email')));
      leadPane.querySelectorAll('[data-form-kind]').forEach((button) => button.addEventListener('click', () => {
        activeFormKind = button.dataset.formKind || 'instant_estimate';
        viewState.activeFormKind = activeFormKind;
        selectedFormId = '';
        setLeadPane('website');
        renderWebsite();
      }));

      const loadLeadSettings = async () => {
        if (!flags.email && !flags.website) {
          leadSettings = {};
          return leadSettings;
        }
        const [emailResult, intakeResult] = await Promise.all([
          flags.email ? window.EmailAPI.leadImport.get(orgId, branchId).catch((error) => ({ ok:false, error })) : Promise.resolve(null),
          flags.website ? window.LeadIntakeAPI.settings.get(orgId, branchId).catch((error) => ({ ok:false, error })) : Promise.resolve(null)
        ]);
        if (emailResult?.error && !intakeResult?.settings) throw emailResult.error;
        if (intakeResult?.error && !emailResult?.settings) throw intakeResult.error;
        const emailSettings = emailResult?.settings || {};
        const intakeSettings = intakeResult?.settings || {};
        leadSettings = {
          ...emailSettings,
          lead_intake: intakeSettings,
          website_forms: Array.isArray(intakeSettings.forms) ? intakeSettings.forms : []
        };
        if (!selectedFormId && forms().length) selectedFormId = forms()[0].id;
        return leadSettings;
      };
      const saveLeadSettings = async (patch) => {
        const requestedPatch = patch && typeof patch === 'object' ? patch : {};
        const previous = leadSettings && typeof leadSettings === 'object' ? leadSettings : {};
        let emailReturned = {};
        let intakeReturned = {};
        if (Array.isArray(requestedPatch.website_forms)) {
          const result = await window.LeadIntakeAPI.settings.patch(orgId, branchId, { forms: requestedPatch.website_forms });
          intakeReturned = result?.settings && typeof result.settings === 'object' ? result.settings : {};
        }
        const emailPatch = { ...requestedPatch };
        delete emailPatch.website_forms;
        if (Object.keys(emailPatch).length) {
          const result = await window.EmailAPI.leadImport.patch(orgId, branchId, emailPatch || {});
          emailReturned = result?.settings && typeof result.settings === 'object' ? result.settings : {};
        }
        leadSettings = {
          ...previous,
          ...emailReturned,
          lead_intake: { ...(previous.lead_intake || {}), ...intakeReturned },
          website_forms: Array.isArray(intakeReturned.forms)
            ? intakeReturned.forms
            : Array.isArray(requestedPatch.website_forms)
              ? requestedPatch.website_forms
              : previous.website_forms
        };
        if (!selectedFormId && forms().length) selectedFormId = forms()[0].id;
        renderAll();
        return leadSettings;
      };
      const copyText = async (value, label = 'Copied') => {
        const text = String(value || '').trim();
        if (!text || text === 'Unavailable') return;
        try {
          await navigator.clipboard.writeText(text);
          showToast(label, text, true);
        } catch(e) {
          showToast('Copy failed', text, false);
        }
      };
      const loadScheduling = async () => {
        if (!appFlag('platform', 'scheduling')) return null;
        if (!window.PlatformScheduling?.loadBranchConfig) return null;
        schedulingConfig = await window.PlatformScheduling.loadBranchConfig(orgId, branchId);
        return schedulingConfig;
      };
      const schedulingWindow = (date = new Date().toISOString().slice(0, 10)) => (
        window.PlatformScheduling?.availabilityWindow
          ? window.PlatformScheduling.availabilityWindow(schedulingConfig, date, 'sales_appointment')
          : { start: '09:00', end: '17:00' }
      );
      const schedulingDefaultsFromConfig = () => {
        const current = schedulingConfig?.scheduling || {};
        const eventType = current.event_types?.sales_appointment || schedulingConfig?.event_types?.sales_appointment || {};
        const availability = current.availability || schedulingConfig?.availability || {};
        return {
          duration: Math.max(15, Number(eventType.duration_minutes || availability.sales_appointment_duration_minutes || 60) || 60),
          slot: Math.max(5, Number(eventType.slot_minutes || availability.sales_appointment_slot_minutes || 30) || 30),
          buffer: Math.max(0, Number(eventType.buffer_minutes || availability.sales_appointment_buffer_minutes || 30) || 30)
        };
      };
      const renderEmail = () => {
        if (!panelEmail) return;
        const email = leadSettings?.inbound_email || 'Unavailable';
        panelEmail.innerHTML = `
          <div class="cs-row">
            <div class="cs-lbl">Unique Lead Inbox</div>
            <div class="li-emailBox">
              <div class="li-emailCopyBox">
                <div class="li-emailText" id="liInboundEmail">${escapeHtml(email)}</div>
                <button class="li-copyIcon" id="liCopyEmail" type="button" data-fm-tooltip="Copy lead inbox email"><i class="fas fa-copy"></i></button>
              </div>
              <div class="li-muted">Give this unique inbox to lead providers. Any provider email sent here is imported as a new lead for this branch.</div>
            </div>
            <div class="li-actions">
              <button class="cs-btn ghost" id="liRefresh" type="button"><i class="fas fa-rotate"></i> Refresh</button>
              <button class="cs-btn ghost" id="liRegenerate" type="button"><i class="fas fa-arrows-rotate"></i> Regenerate</button>
            </div>
            <div class="li-muted" id="liStatus">${leadSettings?.enabled === false ? 'Email lead import is disabled.' : ''}</div>
          </div>
        `;
        $('#liCopyEmail', panelEmail)?.addEventListener('click', async () => {
          const button = $('#liCopyEmail', panelEmail);
          try {
            await navigator.clipboard.writeText(String(leadSettings?.inbound_email || ''));
            feedbackButton(button, '<i class="fas fa-check"></i>', 1000);
          } catch(e) {
            feedbackButton(button, '<i class="fas fa-triangle-exclamation"></i>', 1200);
          }
        });
        $('#liRefresh', panelEmail)?.addEventListener('click', async () => {
          try { await loadLeadSettings(); renderAll(); showToast('Reloaded', 'Lead import settings refreshed.', true); }
          catch(e) { showToast('Reload failed', e?.message || 'Could not refresh lead settings.', false); }
        });
        $('#liRegenerate', panelEmail)?.addEventListener('click', async () => {
          if (!(await (window.PlatformUI?.confirm?.('Regenerate this branch lead inbox? Existing lead providers will need the new address.', { title: 'Regenerate inbox', okLabel: 'Regenerate' }) || Promise.resolve(confirm('Regenerate this branch lead inbox? Existing lead providers will need the new address.'))))) return;
          try {
            await saveLeadSettings({ regenerate: true });
            showToast('Updated', 'Lead inbox regenerated.', true);
          } catch(e) {
            showToast('Save failed', e?.message || 'Could not regenerate lead inbox.', false);
          }
        });
      };
      const estimatePreviewState = viewState.estimatePreviewState || (viewState.estimatePreviewState = {});
      const estimateEditorState = viewState.estimateEditorState || (viewState.estimateEditorState = {});
      const estimateStateForForm = (form) => {
        const id = String(form?.id || 'new-estimate');
        if (!estimatePreviewState[id]) estimatePreviewState[id] = {
          step: 0,
          address: '',
          place: null,
          preview: null,
          previewLoading: false,
          previewError: '',
          answers: {
            slope: '',
            currentMaterial: '',
            roofAge: '',
            damage: '',
            desiredMaterial: '',
            timeline: '',
            financing: '',
            projectInfo: ''
          }
        };
        return estimatePreviewState[id];
      };
      const estimateEditorStateForForm = (form, totalPages = 1) => {
        const id = String(form?.id || 'new-estimate');
        if (!estimateEditorState[id]) estimateEditorState[id] = { page: 0 };
        estimateEditorState[id].page = Math.max(0, Math.min(Math.max(0, totalPages - 1), Number(estimateEditorState[id].page || 0)));
        return estimateEditorState[id];
      };
      const estimateMaterialImages = {
        asphalt: 'https://commons.wikimedia.org/wiki/Special:FilePath/Bitumenschindeln_sj_01.jpg?width=900',
        metal: 'https://commons.wikimedia.org/wiki/Special:FilePath/Standing_seam_metal_roof_curved.jpg?width=900',
        tile: 'https://commons.wikimedia.org/wiki/Special:FilePath/Terracotta_clay_tile_%28Unsplash%29.jpg?width=900',
        cedar: 'https://commons.wikimedia.org/wiki/Special:FilePath/Damaged_Cedar_Shingles_on_Historic_Dungeness_Structures_%28e60bbeda-655b-4876-99cb-468fa162fdbd%29.jpg?width=900'
      };
      const isDefaultMaterialImageCandidate = (url = '') => {
        const text = String(url || '');
        return !text
          || text.includes('images.unsplash.com')
          || text.includes('Special:Redirect/file')
          || text.includes('MNF_StuartPavilion')
          || text.includes('Bitumenschindeln_sj_01')
          || text.includes('Standing_seam_metal_roof')
          || text.includes('Terracotta_clay_tile')
          || text.includes('Damaged_Cedar_Shingles');
      };
      const materialImageKey = (option = {}) => {
        const key = slugLabel(option.value || option.label || '');
        if (key.includes('asphalt')) return 'asphalt';
        if (key.includes('metal')) return 'metal';
        if (key.includes('tile')) return 'tile';
        if (key.includes('cedar') || key.includes('shake')) return 'cedar';
        return key;
      };
      const estimateSteps = [
        { key:'welcome', title:'Get a free instant estimate' },
        { key:'address', title:"What's your address?" },
        { key:'slope', title:'How steep is your roof?' },
        { key:'current_material', title:'What is currently on your roof?' },
        { key:'roof_age', title:'How old is your main roof?' },
        { key:'damage', title:'Does your roof have leaks or damage?' },
        { key:'desired_material', title:'What type of roof would you like?' },
        { key:'timeline', title:'When would you like to start your project?' },
        { key:'financing', title:'Are you interested in financing?' },
        { key:'project_info', title:'Tell us about your project' },
        { key:'contact', title:'Where should we send your estimates?' },
        { key:'results', title:'Your instant estimate preview' }
      ];
      const defaultEstimatePages = () => ([
        { key:'slope', title:'How steep is your roof?', type:'choice', options:[
          { value:'flat', label:'Flat', description:'No peak', icon:'fa-layer-group' },
          { value:'low', label:'Low', description:'Easily walked on', icon:'fa-house' },
          { value:'moderate', label:'Moderate', description:'Not easily walked on', icon:'fa-mountain' },
          { value:'steep', label:'Steep', description:"Can't be walked on", icon:'fa-person-hiking' }
        ]},
        { key:'current_material', title:'What is currently on your roof?', type:'image', options:[
          { value:'asphalt', label:'Asphalt', image:estimateMaterialImages.asphalt },
          { value:'metal', label:'Metal', image:estimateMaterialImages.metal },
          { value:'tile', label:'Tile', image:estimateMaterialImages.tile },
          { value:'cedar', label:'Cedar Shake', image:estimateMaterialImages.cedar }
        ]},
        { key:'roof_age', title:'How old is your main roof?', subtitle:'If there are multiple buildings, what is the age of the largest roof?', type:'choice', options:[
          { value:'0-10', label:'0-10 years', description:'My roof is relatively new', icon:'fa-calendar-check' },
          { value:'10+', label:'10+ years', description:'My roof is over a decade old', icon:'fa-calendar-days' },
          { value:'unknown', label:'Not sure', description:'I am unsure about the age of my roof', icon:'fa-circle-question' }
        ]},
        { key:'damage', title:'Does your roof have leaks or damage?', type:'choice', options:[
          { value:'yes', label:'Yes', icon:'fa-triangle-exclamation' },
          { value:'no', label:'No', icon:'fa-shield-halved' }
        ]},
        { key:'desired_material', title:'What type of roof would you like?', type:'image', options:[
          { value:'asphalt', label:'Asphalt', image:estimateMaterialImages.asphalt },
          { value:'metal', label:'Metal', image:estimateMaterialImages.metal },
          { value:'tile', label:'Tile', image:estimateMaterialImages.tile, enabled:false },
          { value:'cedar', label:'Cedar Shake', image:estimateMaterialImages.cedar, enabled:false }
        ]},
        { key:'timeline', title:'When would you like to start your project?', type:'choice', options:[
          { value:'no-timeline', label:'No timeline', description:'I do not have a timeline in mind yet', icon:'fa-clock' },
          { value:'1-3', label:'In 1-3 months', description:'Not urgent, but I would like to start soon', icon:'fa-calendar' },
          { value:'now', label:'Now', description:'I would like to start immediately', icon:'fa-bolt' }
        ]},
        { key:'financing', title:'Are you interested in financing?', type:'choice', options:[
          { value:'yes', label:'Yes', description:'I am interested in financing', icon:'fa-hand-holding-dollar' },
          { value:'no', label:'No', description:'I am not interested in financing', icon:'fa-ban' },
          { value:'maybe', label:'Maybe', description:'I would like to learn more', icon:'fa-comments-dollar' }
        ]}
      ]);
      const estimatePagesFor = (form) => {
        const pages = Array.isArray(form?.estimate?.pages) && form.estimate.pages.length ? form.estimate.pages : defaultEstimatePages();
        return pages.map((page, index) => ({
          key: page.key || `custom_${index + 1}`,
          title: page.title || 'Question',
          subtitle: page.subtitle || '',
          type: page.type === 'image' ? 'image' : 'choice',
          options: Array.isArray(page.options) && page.options.length ? page.options.map((option) => ({
            ...option,
            image: ['current_material','desired_material'].includes(String(page.key || '')) && estimateMaterialImages[materialImageKey(option)] && isDefaultMaterialImageCandidate(option.image)
              ? estimateMaterialImages[materialImageKey(option)]
              : (option.image || ''),
            enabled: option.enabled !== false
          })) : [{ value:'option', label:'Option', description:'', icon:'fa-circle', image:'', enabled:true }]
        }));
      };
      const estimatePricingRowsFor = (form) => {
        const rows = Array.isArray(form?.estimate?.pricing_matrix) && form.estimate.pricing_matrix.length
          ? form.estimate.pricing_matrix
          : DEFAULT_ESTIMATE_PRICING;
        return rows.map((row, index) => ({
          roof_type: String(row.roof_type || row.roofType || DEFAULT_ESTIMATE_PRICING[index]?.roof_type || 'Asphalt'),
          pitch: String(row.pitch || DEFAULT_ESTIMATE_PRICING[index]?.pitch || 'Moderate'),
          low_price_sqft: Math.max(1, Number(row.low_price_sqft ?? row.lowPriceSqft ?? DEFAULT_ESTIMATE_PRICING[index]?.low_price_sqft ?? 6.75) || 6.75),
          high_price_sqft: Math.max(1, Number(row.high_price_sqft ?? row.highPriceSqft ?? DEFAULT_ESTIMATE_PRICING[index]?.high_price_sqft ?? 11.5) || 11.5)
        }));
      };
      const collectEstimatePricingRows = (root, form) => estimatePricingRowsFor(form).map((row, index) => ({
        roof_type: root.querySelector(`[data-pricing-roof="${index}"]`)?.value || row.roof_type,
        pitch: root.querySelector(`[data-pricing-pitch="${index}"]`)?.value || row.pitch,
        low_price_sqft: Math.max(1, Number(root.querySelector(`[data-pricing-low="${index}"]`)?.value || row.low_price_sqft) || row.low_price_sqft),
        high_price_sqft: Math.max(1, Number(root.querySelector(`[data-pricing-high="${index}"]`)?.value || row.high_price_sqft) || row.high_price_sqft)
      }));
      const pricingRoofOptions = ['Asphalt', 'Metal', 'Tile', 'Cedar', 'Flat'];
      const pricingPitchOptions = ['Low', 'Moderate', 'Steep'];
      const pricingSelect = (attr, index, value, options) => `
        <select class="cs-in" ${attr}="${index}">
          ${options.map((option) => `<option value="${escapeHtml(option)}" ${String(value) === option ? 'selected' : ''}>${escapeHtml(option)}</option>`).join('')}
        </select>
      `;
      const estimateEditorPagesFor = (form) => {
        const questionPages = estimatePagesFor(form);
        return [
          { kind:'welcome', label:'Start', title:'Start page' },
          { kind:'address', label:'Address', title:'Address page' },
          ...questionPages.map((page, questionIndex) => ({ kind:'question', label:String(questionIndex + 1), title: page.title || `Question ${questionIndex + 1}`, questionIndex, page })),
          { kind:'contact', label:'Contact', title:'Contact page' },
          { kind:'results', label:'Results', title:'Results page' }
        ];
      };
      const estimateFlowStepsFor = (form) => ([
        { key:'welcome', title:'Get a free instant estimate' },
        { key:'address', title:"What's your address?" },
        ...estimatePagesFor(form).map((page) => ({ key: page.key, title: page.title, customQuestion: true })),
        { key:'contact', title:'Where should we send your estimates?' },
        { key:'results', title:'Your instant estimate preview' }
      ]);
      const estimatePageByKey = (form, key) => estimatePagesFor(form).find((page) => page.key === key);
      const isMaterialPage = (page) => ['current_material','desired_material'].includes(String(page?.key || ''));
      const enabledOptions = (page) => (page?.options || []).filter((opt) => opt.enabled !== false);
      const estimateChoice = (field, value, title, subtitle, icon = 'fa-circle') => `
        <button type="button" class="li-estimate-choice" data-estimate-answer="${escapeHtml(field)}" data-estimate-value="${escapeHtml(value)}">
          <i class="fas ${escapeHtml(icon)}"></i>
          <b>${escapeHtml(title)}</b>
          ${subtitle ? `<span>${escapeHtml(subtitle)}</span>` : ''}
        </button>
      `;
      const estimateImageChoice = (field, value, title, imageUrl = '') => `
        <button type="button" class="li-estimate-image-choice" data-estimate-answer="${escapeHtml(field)}" data-estimate-value="${escapeHtml(value)}" style="background-image:url('${escapeHtml(imageUrl || estimateMaterialImages[value] || estimateMaterialImages.asphalt)}')">
          <b>${escapeHtml(title)} <i class="fas fa-arrow-right"></i></b>
        </button>
      `;
      const renderEstimatePreview = (form) => {
        const style = form.style || {};
        const copy = form.copy || {};
        const estimate = form.estimate || {};
        const st = estimateStateForForm(form);
        const questionPages = estimatePagesFor(form);
        const flowSteps = estimateFlowStepsFor(form);
        const stepIndex = Math.max(0, Math.min(flowSteps.length - 1, Number(st.step || 0)));
        const step = flowSteps[stepIndex];
        const logoEnabled = style.logo_enabled !== false;
        const logoUrl = logoEnabled ? portalAssetUrl(state.logo || style.logo_url || '') : '';
        const logo = logoUrl ? `<img src="${escapeHtml(logoUrl)}" alt="">` : '';
        const primary = style.primary_color || DEFAULT_PRIMARY;
        const textColor = style.text_color || '#111827';
        const progress = Math.round(((stepIndex + 1) / flowSteps.length) * 100);
        const previewResult = st.preview ? normalizeEstimatePreviewResult(st.preview) : null;
        const previewEstimate = previewResult?.estimate || null;
        const previewMeasurement = previewResult?.measurement || null;
        const previewImage = previewResult?.preview || previewResult?.image || previewResult?.assets || null;
        const sqft = Number(previewEstimate?.roof_area_sqft || previewMeasurement?.roof_area_sqft || 0);
        const low = Number(previewEstimate?.low || previewEstimate?.low_price || 0);
        const high = Number(previewEstimate?.high || previewEstimate?.high_price || 0);
        const previewUnavailable = plainText(st.previewError || previewResult?.error || previewResult?.message || previewMeasurement?.error || previewImage?.error || '');
        const addressText = plainText(previewImage?.formatted_address || previewResult?.formatted_address || previewResult?.address || st.address || '', '');
        const baseImageUrl = pickUrl(previewImage, previewImage?.image, previewImage?.image_url, previewImage?.rgb_url, previewImage?.rgb, previewImage?.url, previewResult?.preview, previewResult?.image_url, previewResult?.rgb_url);
        const maskUrl = pickUrl(previewImage?.mask, previewImage?.mask_url, previewImage?.maskUrl, previewImage?.assets?.mask_url, previewResult?.mask, previewResult?.mask_url, previewResult?.assets?.mask_url);
        const maskImageHtml = baseImageUrl && maskUrl
          ? `<div class="li-estimate-mask-preview" id="liEstimateMaskPreview"><img src="${escapeHtml(baseImageUrl)}" alt=""><img class="mask" src="${escapeHtml(maskUrl)}" alt=""></div>`
          : '';
        const body = (() => {
          const configuredPage = estimatePageByKey(form, step.key);
          if (configuredPage) {
            const field = step.key === 'current_material' ? 'currentMaterial' : (step.key === 'desired_material' ? 'desiredMaterial' : step.key.replace(/_([a-z])/g, (_, c) => c.toUpperCase()));
            const options = enabledOptions(configuredPage);
            return options.some((opt) => opt.image)
              ? `<div class="li-estimate-body"><h3 class="li-estimate-title">${escapeHtml(configuredPage.title || step.title)}</h3><div class="li-estimate-image-grid">${options.map((opt) => estimateImageChoice(field, opt.value || slugLabel(opt.label), opt.label || opt.value, opt.image || estimateMaterialImages[opt.value] || estimateMaterialImages.asphalt)).join('')}</div></div>`
              : `<div class="li-estimate-body"><h3 class="li-estimate-title">${escapeHtml(configuredPage.title || step.title)}</h3><div class="li-estimate-grid">${options.map((opt) => estimateChoice(field, opt.value || slugLabel(opt.label), opt.label || opt.value, opt.description || '', opt.icon || 'fa-circle')).join('')}</div></div>`;
          }
          switch(step.key) {
            case 'welcome':
              return `<div class="li-estimate-brand">${logo}<div><h3>${escapeHtml(copy.headline || step.title)}</h3><p>${escapeHtml(copy.subheadline || '')}</p></div><button type="button" class="li-estimate-primary" data-estimate-next>${escapeHtml(copy.start_label || 'Get started')} <i class="fas fa-arrow-right"></i></button></div>`;
            case 'address':
              return `<div class="li-estimate-body"><h3 class="li-estimate-title">${escapeHtml(step.title)}</h3><div class="li-estimate-map-wrap"><div class="li-estimate-map" id="liEstimateMap"></div>${maskImageHtml}<div class="li-estimate-addressbar"><input id="liEstimateAddress" value="${escapeHtml(addressText)}" placeholder="Enter your street address" autocomplete="off"><button type="button" class="li-estimate-primary ghost" data-estimate-next>${escapeHtml(st.previewLoading ? 'Loading...' : 'Continue')}</button></div></div>${previewUnavailable ? `<div class="li-estimate-note">${escapeHtml(previewUnavailable)}</div>` : ''}</div>`;
            case 'slope':
            case 'roof_age':
            case 'damage':
            case 'timeline':
            case 'financing': {
              const page = estimatePageByKey(form, step.key) || { title: step.title, subtitle: '', options: [] };
              const options = enabledOptions(page);
              return `<div class="li-estimate-body"><h3 class="li-estimate-title">${escapeHtml(page.title || step.title)}</h3><div class="li-estimate-grid">${options.map((opt) => estimateChoice(step.key === 'slope' ? 'slope' : step.key.replace(/_([a-z])/g, (_, c) => c.toUpperCase()), opt.value || slugLabel(opt.label), opt.label || opt.value, opt.description || '', opt.icon || 'fa-circle')).join('')}</div></div>`;
            }
            case 'current_material':
            case 'desired_material': {
              const page = estimatePageByKey(form, step.key) || { title: step.title, subtitle: '', options: [] };
              const field = step.key === 'current_material' ? 'currentMaterial' : 'desiredMaterial';
              const options = enabledOptions(page);
              return `<div class="li-estimate-body"><h3 class="li-estimate-title">${escapeHtml(page.title || step.title)}</h3><div class="li-estimate-image-grid">${options.map((opt) => estimateImageChoice(field, opt.value || slugLabel(opt.label), opt.label || opt.value, opt.image || estimateMaterialImages[opt.value] || estimateMaterialImages.asphalt)).join('')}</div></div>`;
            }
            case 'project_info':
              return `<div class="li-estimate-body"><h3 class="li-estimate-title">${escapeHtml(step.title)} <span style="font-weight:800;color:#667085">(optional)</span></h3><textarea class="li-estimate-input wide" id="liEstimateProjectInfo" rows="7" placeholder="Provide any additional details which will help us prepare your roofing estimate">${escapeHtml(st.answers.projectInfo || '')}</textarea><button type="button" class="li-estimate-primary" data-estimate-next>Continue</button></div>`;
            case 'contact':
              return `<div class="li-estimate-body"><h3 class="li-estimate-title">${escapeHtml(step.title)}</h3><div class="li-estimate-form"><input class="li-estimate-input wide" placeholder="Enter your full name"><input class="li-estimate-input" placeholder="Enter your email"><input class="li-estimate-input" placeholder="Enter your phone number"><label class="li-estimate-note wide"><input type="checkbox"> I agree to be contacted about my roofing estimate.</label></div><button type="button" class="li-estimate-primary" data-estimate-next>${escapeHtml(copy.submit_label || 'Get my estimate')}</button></div>`;
            default:
              return `<div class="li-estimate-body"><h3 class="li-estimate-title">${escapeHtml(step.title)}</h3><div class="li-estimate-results"><div class="li-estimate-result-card"><div class="li-estimate-note">Estimated replacement range</div><div class="li-estimate-price">${low && high ? `$${low.toLocaleString()} - $${high.toLocaleString()}` : 'Preview unavailable'}</div><p class="li-estimate-sub">${escapeHtml(previewUnavailable || 'A project specialist can confirm materials, measurements, and final pricing.')}</p><button type="button" class="li-estimate-primary">Request proposal</button></div><div class="li-estimate-summary"><div><span>Address</span><b>${escapeHtml(addressText || 'Selected address')}</b></div><div><span>Roof area</span><b>${sqft ? `${sqft.toLocaleString()} sq ft` : 'Unavailable'}</b></div></div></div></div>`;
          }
        })();
        return `
          <div class="li-estimate-shell" style="--ie-primary:${escapeHtml(primary)};--ie-text:${escapeHtml(textColor)};--li-preview-font:${escapeHtml(fontStack(style.font_family))}">
            <div class="li-estimate-card">
              ${stepIndex > 0 ? `<div class="li-estimate-top"><button type="button" class="li-estimate-back" data-estimate-back><i class="fas fa-chevron-left"></i></button><div class="li-estimate-step">Step ${stepIndex + 1} of ${flowSteps.length}</div></div><div class="li-estimate-progress"><span style="width:${progress}%"></span></div>` : ''}
              ${body}
            </div>
          </div>
        `;
      };
      const ensureGoogleMaps = () => new Promise((resolve, reject) => {
        if (window.google?.maps?.places) { resolve(window.google.maps); return; }
        const existing = Array.from(document.scripts).find((script) => String(script.src || '').includes('maps.googleapis.com/maps/api/js'));
        if (existing) {
          let attempts = 0;
          const timer = window.setInterval(() => {
            attempts += 1;
            if (window.google?.maps?.places) { window.clearInterval(timer); resolve(window.google.maps); }
            else if (attempts > 80) { window.clearInterval(timer); reject(new Error('Google Maps did not finish loading.')); }
          }, 150);
          return;
        }
        reject(new Error('Google Maps script is not available on this page.'));
      });
      const hydrateEstimatePreview = async (form) => {
        if (!panelWebsite || form?.mode !== 'instant_estimate') return;
        const st = estimateStateForForm(form);
        const rerender = () => {
          const preview = $('#liLivePreview', panelWebsite);
          if (preview) preview.innerHTML = renderEstimatePreview(form);
          hydrateEstimatePreview(form);
        };
        const loadRealEstimatePreview = async () => {
          const input = $('#liEstimateAddress', panelWebsite);
          st.address = plainText(input?.value || st.address || '').trim();
          if (!st.address) {
            st.previewError = 'Enter an address to continue.';
            rerender();
            return false;
          }
          if (!window.LeadIntakeAPI?.forms?.instantEstimatePreview) {
            st.previewError = 'Lead Intake preview API is unavailable.';
            rerender();
            return false;
          }
          st.previewLoading = true;
          st.previewError = '';
          rerender();
          try {
            st.preview = normalizeEstimatePreviewResult(await window.LeadIntakeAPI.forms.instantEstimatePreview(orgId, branchId, form.id, {
              address: st.address,
              latitude: st.place?.location?.lat,
              longitude: st.place?.location?.lng,
              tint: form.style?.primary_color || DEFAULT_PRIMARY
            }));
            st.previewError = '';
            return true;
          } catch(e) {
            st.preview = null;
            st.previewError = plainText(e?.message, 'Could not load preview for this address.');
            return false;
          } finally {
            st.previewLoading = false;
            rerender();
          }
        };
        panelWebsite.querySelectorAll('[data-estimate-next]').forEach((button) => button.addEventListener('click', async () => {
          const info = $('#liEstimateProjectInfo', panelWebsite);
          if (info) st.answers.projectInfo = info.value || '';
          const flowSteps = estimateFlowStepsFor(form);
          const activeStep = (flowSteps[Math.max(0, Math.min(flowSteps.length - 1, Number(st.step || 0)))] || {}).key;
          if (activeStep === 'address' && !st.preview && !st.previewLoading) {
            const input = $('#liEstimateAddress', panelWebsite);
            st.address = plainText(input?.value || st.address || '').trim();
            if (st.address) loadRealEstimatePreview().catch(() => {});
          }
          st.step = Math.min(flowSteps.length - 1, Number(st.step || 0) + 1);
          rerender();
        }));
        panelWebsite.querySelector('[data-estimate-back]')?.addEventListener('click', () => {
          st.step = Math.max(0, Number(st.step || 0) - 1);
          rerender();
        });
        panelWebsite.querySelectorAll('[data-estimate-answer]').forEach((button) => button.addEventListener('click', () => {
          const field = button.dataset.estimateAnswer || '';
          if (field) st.answers[field] = button.dataset.estimateValue || '';
          const flowSteps = estimateFlowStepsFor(form);
          st.step = Math.min(flowSteps.length - 1, Number(st.step || 0) + 1);
          rerender();
        }));
        const mapEl = $('#liEstimateMap', panelWebsite);
        const input = $('#liEstimateAddress', panelWebsite);
        if (!mapEl || !input) return;
        try {
          await ensureGoogleMaps();
          const fallback = { lat: 39.8283, lng: -98.5795 };
          const center = st.place?.location || fallback;
          const map = new google.maps.Map(mapEl, {
            center,
            zoom: st.place ? Number(form.estimate?.map_zoom || 19) : 4,
            mapTypeId: 'satellite',
            tilt: 0,
            heading: 0,
            disableDefaultUI: false,
            streetViewControl: false,
            mapTypeControl: false,
            fullscreenControl: false
          });
          if (typeof map.setTilt === 'function') map.setTilt(0);
          if (typeof map.setHeading === 'function') map.setHeading(0);
          const marker = new google.maps.Marker({ map, position: center, visible: !!st.place });
          const ac = new google.maps.places.Autocomplete(input, {
            fields: ['formatted_address', 'geometry', 'address_components'],
            types: ['address']
          });
          ac.addListener('place_changed', () => {
            const place = ac.getPlace();
            const loc = place?.geometry?.location;
            if (!loc) return;
            const position = { lat: loc.lat(), lng: loc.lng() };
            st.address = plainText(place.formatted_address || input.value || '');
            st.place = { location: position, address_components: place.address_components || [] };
            st.preview = null;
            st.previewError = '';
            marker.setPosition(position);
            marker.setVisible(true);
            map.setCenter(position);
            map.setZoom(Number(form.estimate?.map_zoom || 19));
          });
          input.addEventListener('input', () => {
            st.address = plainText(input.value || '');
            st.preview = null;
            st.previewError = '';
          });
        } catch(e) {
          mapEl.innerHTML = `<div class="li-muted" style="padding:22px;background:#fff;margin:18px;border-radius:10px">${escapeHtml(plainText(e?.message || e, 'Google Maps is unavailable.'))}</div>`;
        }
      };
      const renderPreview = (form) => {
        if (form?.mode === 'instant_estimate') return renderEstimatePreview(form);
        if (form?.mode === 'submit_form') {
          const style = form.style || {};
          const copy = form.copy || {};
          const logoUrl = style.logo_enabled ? portalAssetUrl(state.logo || style.logo_url || '') : '';
          const logo = logoUrl ? `<img src="${escapeHtml(logoUrl)}" alt="">` : '';
          const fields = Array.isArray(form.fields) && form.fields.length ? form.fields : defaultSubmitForm().fields;
          return `
            <div class="li-preview-card" style="--li-preview-font:${escapeHtml(fontStack(style.font_family))};background:${escapeHtml(style.background_color || '#fff')};color:${escapeHtml(style.text_color || '#111827')}">
              <div class="li-preview-head">
                ${logo}
                <div class="li-preview-headText">
                  <h3>${escapeHtml(copy.headline || 'Tell us about your project')}</h3>
                  <p>${escapeHtml(copy.subheadline || '')}</p>
                </div>
              </div>
              <div class="li-preview-body">
                ${fields.map((field) => field.type === 'textarea'
                  ? `<textarea class="li-preview-field wide" rows="4" placeholder="${escapeHtml(field.placeholder || field.label || '')}"></textarea>`
                  : `<input class="li-preview-field ${field.id === 'address' ? 'wide' : ''}" placeholder="${escapeHtml(field.placeholder || field.label || '')}" aria-label="${escapeHtml(field.label || '')}">`
                ).join('')}
                <button type="button" class="li-preview-submit wide" style="background:${escapeHtml(style.primary_color || DEFAULT_PRIMARY)}">${escapeHtml(copy.submit_label || 'Submit request')}</button>
                <div class="li-muted wide">${escapeHtml(copy.fine_print || '')}</div>
              </div>
            </div>
          `;
        }
        const style = form.style || {};
        const copy = form.copy || {};
        const stateForForm = formPreviewState(form);
        const logoUrl = style.logo_enabled ? portalAssetUrl(state.logo || style.logo_url || '') : '';
        const logo = logoUrl ? `<img src="${escapeHtml(logoUrl)}" alt="">` : '';
        const selected = dateFromText(stateForForm.selectedDate);
        const monthLabel = selected.toLocaleDateString([], { month: 'long', year: 'numeric' });
        const daysHeader = ['S','M','T','W','T','F','S'].map((day) => `<div class="li-preview-dow">${day}</div>`).join('');
        const sampleDays = calendarDays(stateForForm.selectedDate).map((date) => {
          const value = localDateText(date);
          return `<button type="button" class="li-preview-day ${date.getMonth() !== selected.getMonth() ? 'muted' : ''} ${value === stateForForm.selectedDate ? 'active' : ''}" data-preview-date="${escapeHtml(value)}">${date.getDate()}</button>`;
        }).join('');
        const mobileDays = upcomingDays(21).map((date) => {
          const value = localDateText(date);
          return `<button type="button" class="li-preview-daypill ${value === stateForForm.selectedDate ? 'active' : ''}" data-preview-date="${escapeHtml(value)}"><span>${escapeHtml(date.toLocaleDateString([], { weekday:'short' }))}</span><b>${date.getDate()}</b></button>`;
        }).join('');
        return `
          <div class="li-preview-card" style="--li-preview-font:${escapeHtml(fontStack(style.font_family))};background:${escapeHtml(style.background_color || '#fff')};color:${escapeHtml(style.text_color || '#111827')}">
            <div class="li-preview-head">
              ${logo}
              <div class="li-preview-headText">
                <h3>${escapeHtml(copy.headline || 'Schedule an appointment')}</h3>
                <p>${escapeHtml(copy.subheadline || '')}</p>
              </div>
            </div>
            <div class="li-preview-body">
              <div class="li-preview-contact">
                <input class="li-preview-field" value="Jane Homeowner" aria-label="Name">
                <input class="li-preview-field" value="(555) 123-4567" aria-label="Phone">
                <input class="li-preview-field" value="jane@example.com" aria-label="Email">
              </div>
              <input class="li-preview-field wide" value="123 Main Street" aria-label="Address">
              <div class="li-preview-booking">
                <div class="li-preview-mobile-days">${mobileDays}</div>
                <div class="li-preview-calendar">
                  <div class="li-preview-month">${escapeHtml(monthLabel)}</div>
                  <div class="li-preview-calgrid">${daysHeader}${sampleDays}</div>
                </div>
                <div class="li-preview-timepanel">
                  <div class="li-preview-time-title">${escapeHtml(selected.toLocaleDateString([], { weekday:'long', month:'long', day:'numeric' }))}</div>
                  <div class="li-preview-slots" data-preview-slots="${escapeHtml(form.id || '')}"><div class="li-preview-slot">Loading</div></div>
                  <div class="li-preview-note" data-preview-note></div>
                  <button type="button" class="li-preview-submit wide" data-preview-submit style="background:${escapeHtml(style.primary_color || DEFAULT_PRIMARY)}">${stateForForm.submitted ? 'Preview submitted' : escapeHtml(copy.submit_label || 'Submit')}</button>
                </div>
              </div>
              <div class="li-muted wide">${escapeHtml(copy.fine_print || '')}</div>
            </div>
          </div>
        `;
      };
      const hydratePreviewBooking = async (form) => {
        const stateForForm = formPreviewState(form);
        const slotsEl = $('#liLivePreview [data-preview-slots]', panelWebsite);
        const noteEl = $('#liLivePreview [data-preview-note]', panelWebsite);
        panelWebsite?.querySelectorAll('[data-preview-date]').forEach((button) => {
          button.addEventListener('click', () => {
            const dayScroller = $('#liLivePreview .li-preview-mobile-days', panelWebsite);
            const previousDayScroll = dayScroller ? dayScroller.scrollLeft : 0;
            stateForForm.selectedDate = button.dataset.previewDate || stateForForm.selectedDate;
            stateForForm.selectedStart = '';
            stateForForm.submitted = false;
            const preview = $('#liLivePreview', panelWebsite);
            if (preview) preview.innerHTML = renderPreview(form);
            const nextDayScroller = $('#liLivePreview .li-preview-mobile-days', panelWebsite);
            restoreHorizontalScroll(nextDayScroller, previousDayScroll);
            hydratePreviewBooking(form);
            centerPreviewDate('smooth');
          });
        });
        panelWebsite?.querySelector('[data-preview-submit]')?.addEventListener('click', (event) => {
          if (!stateForForm.selectedStart) {
            if (noteEl) noteEl.textContent = 'Choose a time first.';
            return;
          }
          stateForForm.submitted = true;
          event.currentTarget.innerHTML = '<i class="fas fa-check"></i> Preview submitted';
          if (noteEl) noteEl.textContent = '';
        });
        if (!slotsEl || !window.LeadIntakeAPI?.forms?.availability || !form?.id) return;
        let date = stateForForm.selectedDate || localDateText();
        try {
          let data = await window.LeadIntakeAPI.forms.availability(form.id, date);
          let slots = (Array.isArray(data?.slots) ? data.slots : []).filter((slot) => slot.available || slot.hasAvailability);
          if (!slots.length) {
            for (let offset = 1; offset <= 14; offset += 1) {
              const nextDate = new Date();
              nextDate.setDate(nextDate.getDate() + offset);
              const nextDateText = localDateText(nextDate);
              const nextData = await window.LeadIntakeAPI.forms.availability(form.id, nextDateText);
              const nextSlots = (Array.isArray(nextData?.slots) ? nextData.slots : []).filter((slot) => slot.available || slot.hasAvailability);
              if (nextSlots.length) {
                date = nextDateText;
                stateForForm.selectedDate = nextDateText;
                data = nextData;
                slots = nextSlots;
                break;
              }
            }
          }
          slotsEl.innerHTML = slots.length
            ? slots.map((slot, index) => {
              const active = stateForForm.selectedStart ? stateForForm.selectedStart === slot.start : index === 0;
              if (!stateForForm.selectedStart && index === 0) stateForForm.selectedStart = slot.start;
              return `<button type="button" class="li-preview-slot ${active ? 'active' : ''}" data-preview-start="${escapeHtml(slot.start)}">${escapeHtml(slot.label || slot.time || '')}</button>`;
            }).join('')
            : '<button type="button" class="li-preview-slot" disabled>No times</button>';
          if (noteEl) noteEl.textContent = slots.length
            ? ''
            : 'No appointment times are open in the next two weeks.';
          slotsEl.querySelectorAll('[data-preview-start]').forEach((button) => {
            button.addEventListener('click', () => {
              stateForForm.selectedStart = button.dataset.previewStart || '';
              stateForForm.submitted = false;
              slotsEl.querySelectorAll('[data-preview-start]').forEach((slotButton) => slotButton.classList.toggle('active', slotButton === button));
              centerPreviewTime('smooth');
              if (noteEl) noteEl.textContent = '';
            });
          });
          centerPreviewDate('smooth');
          centerPreviewTime('smooth');
        } catch(e) {
          const win = schedulingWindow(date);
          slotsEl.innerHTML = [win.start, win.end].map((time, index) => `<button type="button" class="li-preview-slot ${index === 0 ? 'active' : ''}" data-preview-start="${escapeHtml(time)}">${escapeHtml(time)}</button>`).join('');
          if (noteEl) noteEl.textContent = 'Availability preview will use the saved calendar once this form is saved.';
          centerPreviewDate('smooth');
          centerPreviewTime('smooth');
        }
      };
      const renderEstimatePageBuilder = (form) => {
        const pages = estimatePagesFor(form);
        const editorPages = estimateEditorPagesFor(form);
        const editorState = estimateEditorStateForForm(form, editorPages.length);
        const activeIndex = editorState.page;
        const active = editorPages[activeIndex] || editorPages[0];
        const page = active?.page || null;
        const copy = form.copy || {};
        const nav = `
          <div class="li-page-nav">
            <button class="li-page-arrow" type="button" data-page-go="${activeIndex - 1}" ${activeIndex <= 0 ? 'disabled' : ''} data-fm-tooltip="Previous page"><i class="fas fa-chevron-left"></i></button>
            <div class="li-page-nav-main">
              ${editorPages.map((item, index) => `<button class="li-page-num ${index === activeIndex ? 'active' : ''}" type="button" data-page-go="${index}" data-fm-tooltip="${escapeHtml(item.title || `Page ${index + 1}`)}">${index + 1}</button>`).join('')}
            </div>
            <button class="li-page-arrow" type="button" data-page-go="${activeIndex + 1}" ${activeIndex >= editorPages.length - 1 ? 'disabled' : ''} data-fm-tooltip="Next page"><i class="fas fa-chevron-right"></i></button>
          </div>
        `;
        const activeEditor = (() => {
          if (active?.kind === 'welcome') {
            return `
              <div class="li-page-editor" data-page-kind="welcome">
                <div class="li-page-editor-head">
                  <div class="li-page-editor-title">Start page</div>
                </div>
                <div class="li-formgrid">
                  <div class="cs-row wide"><div class="cs-lbl">Headline</div><input class="cs-in" id="liEstimateHeadline" value="${escapeHtml(copy.headline || 'Get a free instant estimate')}"></div>
                  <div class="cs-row wide"><div class="cs-lbl">Subheadline</div><textarea class="cs-in" id="liEstimateSubheadline" rows="3">${escapeHtml(copy.subheadline || '')}</textarea></div>
                  <div class="cs-row"><div class="cs-lbl">Start Button Text</div><input class="cs-in" id="liEstimateStart" value="${escapeHtml(copy.start_label || 'Get started')}"></div>
                </div>
              </div>
            `;
          }
          if (active?.kind === 'address') {
            return `
              <div class="li-page-editor" data-page-kind="address">
                <div class="li-page-editor-head"><div class="li-page-editor-title">Address page</div></div>
                <div class="li-muted">This page asks for the customer's address and shows the satellite map preview.</div>
              </div>
            `;
          }
          if (active?.kind === 'project_info') {
            return `
              <div class="li-page-editor" data-page-kind="project_info">
                <div class="li-page-editor-head"><div class="li-page-editor-title">Project details page</div></div>
                <div class="li-muted">This optional page collects any extra project notes before contact information.</div>
              </div>
            `;
          }
          if (active?.kind === 'contact') {
            return `
              <div class="li-page-editor" data-page-kind="contact">
                <div class="li-page-editor-head"><div class="li-page-editor-title">Contact page</div></div>
                <div class="li-formgrid">
                  <div class="cs-row"><div class="cs-lbl">Submit Button Text</div><input class="cs-in" id="liEstimateSubmit" value="${escapeHtml(copy.submit_label || 'Get my estimate')}"></div>
                  <div class="cs-row wide"><div class="cs-lbl">Fine Print</div><textarea class="cs-in" id="liEstimateFine" rows="3">${escapeHtml(copy.fine_print || '')}</textarea></div>
                </div>
              </div>
            `;
          }
          if (active?.kind === 'results') {
            return `
              <div class="li-page-editor" data-page-kind="results">
                <div class="li-page-editor-head"><div class="li-page-editor-title">Results page</div></div>
                <div class="li-muted">This page shows the estimated replacement range from the pricing table.</div>
              </div>
            `;
          }
          const pageIndex = active?.questionIndex ?? 0;
          const materialPage = isMaterialPage(page);
          return `
            <div class="li-page-editor" data-page-index="${pageIndex}">
              <div class="li-page-editor-head">
                <div class="li-page-editor-title">${escapeHtml(page?.title || `Question ${pageIndex + 1}`)}</div>
                <button class="cs-btn ghost" type="button" data-page-remove="${pageIndex}" ${pages.length <= 1 ? 'disabled' : ''}><i class="fas fa-trash"></i></button>
              </div>
              <div class="li-formgrid">
                <div class="cs-row wide"><div class="cs-lbl">Question</div><input class="cs-in" data-page-title="${pageIndex}" value="${escapeHtml(page?.title || '')}"></div>
              </div>
              <div class="li-option-grid">
                <div class="li-option-row head ${materialPage ? 'image' : ''}">
                  ${materialPage ? '<div>Image</div>' : ''}
                  <div>Label</div>
                  <div>Description</div>
                  ${materialPage ? '<div>Use</div>' : ''}
                </div>
                ${(page?.options || []).map((opt, optIndex) => `
                  <div class="li-option-row ${materialPage ? 'image' : ''}" data-option-row>
                    ${materialPage ? `<div style="display:flex;align-items:center;gap:6px"><div class="li-option-thumb" style="background-image:url('${escapeHtml(opt.image || estimateMaterialImages[opt.value] || '')}')"></div><input type="hidden" data-option-image="${pageIndex}:${optIndex}" value="${escapeHtml(opt.image || '')}"><label class="cs-btn ghost li-option-upload" data-fm-tooltip="Upload image"><i class="fas fa-image"></i><input type="file" accept="image/*" data-option-upload="${pageIndex}:${optIndex}"></label></div>` : ''}
                    <input class="cs-in" data-option-label="${pageIndex}:${optIndex}" value="${escapeHtml(opt.label || '')}">
                    <input class="cs-in" data-option-description="${pageIndex}:${optIndex}" value="${escapeHtml(opt.description || '')}">
                    ${materialPage
                      ? `<label class="li-option-enabled"><input type="checkbox" data-option-enabled="${pageIndex}:${optIndex}" ${opt.enabled !== false ? 'checked' : ''}><span>On</span></label>`
                      : ''}
                  </div>
                `).join('')}
              </div>
              <button class="cs-btn ghost" type="button" data-option-add="${pageIndex}"><i class="fas fa-plus"></i> Add custom option</button>
            </div>
          `;
        })();
        return `
          <div class="li-page-builder" id="liEstimatePageBuilder">
            ${activeEditor}
            ${nav}
            <button class="cs-btn ghost" type="button" id="liAddEstimatePage"><i class="fas fa-plus"></i> Add question page</button>
          </div>
        `;
      };
      const collectEstimatePages = (root, form) => {
        const current = estimatePagesFor(form);
        return current.map((page, pageIndex) => ({
          ...page,
          title: root.querySelector(`[data-page-title="${pageIndex}"]`)?.value || page.title,
          subtitle: '',
          type: isMaterialPage(page) ? 'image' : 'choice',
          options: page.options.map((opt, optIndex) => {
            const key = `${pageIndex}:${optIndex}`;
            const label = root.querySelector(`[data-option-label="${key}"]`)?.value || opt.label || '';
            return {
              ...opt,
              value: slugLabel(label || opt.value || `option-${optIndex + 1}`),
              label,
              description: root.querySelector(`[data-option-description="${key}"]`)?.value || opt.description || '',
              image: root.querySelector(`[data-option-image="${key}"]`)?.value || opt.image || '',
              enabled: root.querySelector(`[data-option-enabled="${key}"]`) ? !!root.querySelector(`[data-option-enabled="${key}"]`)?.checked : opt.enabled !== false
            };
          })
        }));
      };
      const renderWebsite = () => {
        if (!panelWebsite) return;
        const availableKinds = Object.keys(allowedFormKindMeta());
        if (!availableKinds.length) {
          panelWebsite.innerHTML = `<div class="li-muted">No website form types are enabled for this organization.</div>`;
          return;
        }
        if (!formKindMeta[activeFormKind] || !formKindAllowed(activeFormKind)) activeFormKind = availableKinds[0];
        viewState.activeFormKind = activeFormKind;
        const allForms = forms();
        const list = allowedForms().filter((item) => formKindFor(item) === activeFormKind);
        const form = list.find((item) => item.id === selectedFormId) || list[0] || null;
        const createWebsiteForm = async (button = null, mode = 'appointment') => {
          if (!formKindAllowed(mode)) {
            showToast('Feature disabled', `${formKindMeta[mode]?.label || 'This form'} is not enabled for this organization.`, false);
            return;
          }
          const next = mode === 'instant_estimate' ? defaultEstimateForm() : (mode === 'submit_form' ? defaultSubmitForm() : defaultForm());
          const win = schedulingWindow();
          if (next.scheduling) {
            next.scheduling.start_time = win.start || next.scheduling.start_time;
            next.scheduling.end_time = win.end || next.scheduling.end_time;
          }
          next.name = mode === 'instant_estimate'
            ? (list.length ? `Instant Estimate Form ${list.length + 1}` : 'Instant Estimate Form')
            : (mode === 'submit_form'
              ? (list.length ? `Contact Form ${list.length + 1}` : 'Contact Form')
              : (list.length ? `Appointment Form ${list.length + 1}` : 'Website Appointment Form'));
          next.tracking_key = uniqueTrackingKey(next.name);
          const previousText = button?.innerHTML || '';
          if (button) {
            button.disabled = true;
            button.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Creating...';
          }
          try {
            activeLeadPane = 'website';
            selectedFormId = next.id;
            await saveLeadSettings({ website_forms: [...forms(), next] });
            showToast('Form created', next.name, true);
          } catch(e) {
            selectedFormId = form?.id || '';
            showToast('Create failed', e?.message || 'Could not create website form.', false);
            if (button) {
              button.disabled = false;
              button.innerHTML = previousText;
            }
          }
        };
        if (!form) {
          panelWebsite.innerHTML = `<div class="li-muted">Creating ${escapeHtml((formKindMeta[activeFormKind]?.label || 'form').toLowerCase())}...</div>`;
          createWebsiteForm(null, activeFormKind).catch((e) => {
            panelWebsite.innerHTML = `<div class="li-muted">${escapeHtml(e?.message || 'Could not create form instance.')}</div>`;
          });
          return;
        }
        const style = form.style || (form.style = {});
        const copy = form.copy || (form.copy = {});
        const scheduling = form.scheduling || (form.scheduling = {});
        if (!form.tracking_key) form.tracking_key = uniqueTrackingKey(form.name || form.id, form.id);
        if (style.use_company_colors !== false) style.use_company_colors = true;
        if (style.use_company_colors) {
          style.primary_color = cssVar('--primary-readable', cssVar('--primary', DEFAULT_PRIMARY));
          style.text_color = '#111827';
        }
        panelWebsite.innerHTML = `
          <div class="li-forms-stack">
            <div class="cs-card" style="margin-top:0">
              <div class="li-list horizontal">
                ${list.map((item) => `<button type="button" data-form-id="${escapeHtml(item.id)}" class="${item.id === form.id ? 'active' : ''}">${escapeHtml(item.name || item.id)}<small>${escapeHtml(formKindMeta[formKindFor(item)]?.label || item.mode || 'appointment')}</small></button>`).join('')}
                <button type="button" class="li-instance-add" id="liNewForm"><i class="fas fa-plus"></i> ${escapeHtml(formKindMeta[activeFormKind].createLabel)}</button>
              </div>
            </div>
            <div class="li-editor">
              <div class="cs-card" style="margin-top:0">
                <div class="li-form-section ${form.enabled === false ? 'disabled' : ''}">
                  <div class="li-section-head">
                    <div class="li-section-title">Form</div>
                    <label class="li-switch" data-fm-tooltip="Turn this embedded form on or off">
                      <input id="liFormEnabled" type="checkbox" ${form.enabled !== false ? 'checked' : ''}>
                      <span class="li-slider"></span>
                    </label>
                  </div>
                  <div class="li-formgrid">
                    <div class="cs-row wide">
                      <div class="cs-lbl">Form Name</div>
                      <input class="cs-in" id="liFormName" value="${escapeHtml(form.name || '')}">
                    </div>
                  </div>
                </div>
                <div class="li-form-section" style="${form.mode === 'instant_estimate' ? 'display:none' : ''}">
                  <div class="li-section-title">Content</div>
                  <div class="li-formgrid">
                    <div class="cs-row"><div class="cs-lbl">Headline</div><input class="cs-in" id="liFormHeadline" value="${escapeHtml(copy.headline || '')}"></div>
                    <div class="cs-row wide"><div class="cs-lbl">Subheadline</div><textarea class="cs-in" id="liFormSubheadline" rows="3">${escapeHtml(copy.subheadline || '')}</textarea></div>
                    <div class="cs-row"><div class="cs-lbl">Submit Button Text</div><input class="cs-in" id="liFormSubmit" value="${escapeHtml(copy.submit_label || '')}"></div>
                    <div class="cs-row wide"><div class="cs-lbl">Fine Print</div><textarea class="cs-in" id="liFormFine" rows="3">${escapeHtml(copy.fine_print || '')}</textarea></div>
                  </div>
                </div>
                <div class="li-form-section">
                  <div class="li-section-title">Styling</div>
                  <div class="li-formgrid">
                    <div class="li-switch-row">
                      <div class="cs-lbl">Show Logo</div>
                      <label class="li-switch"><input id="liFormLogoEnabled" type="checkbox" ${style.logo_enabled !== false ? 'checked' : ''}><span class="li-slider"></span></label>
                    </div>
                    <div class="li-switch-row">
                      <div class="cs-lbl">Use Company Colors</div>
                      <label class="li-switch"><input id="liUseCompanyColors" type="checkbox" ${style.use_company_colors !== false ? 'checked' : ''}><span class="li-slider"></span></label>
                    </div>
                    <div class="li-style-custom ${style.use_company_colors === false ? 'active' : ''}" id="liCustomColors">
                      <div class="cs-row"><div class="cs-lbl">Primary Color</div>${colorControl('liFormPrimary', style.primary_color || DEFAULT_PRIMARY)}</div>
                      <div class="cs-row"><div class="cs-lbl">Text Color</div>${colorControl('liFormText', style.text_color || '#111827')}</div>
                    </div>
                    <div class="cs-row li-font-row"><div class="cs-lbl">Font</div><select class="cs-in" id="liFormFont">${fontOptions.map((font) => `<option value="${escapeHtml(font)}" ${style.font_family === font ? 'selected' : ''}>${escapeHtml(font)}</option>`).join('')}</select></div>
                  </div>
                </div>
                <div class="li-form-section li-estimate-only" id="liEstimateSettings" style="${form.mode === 'instant_estimate' ? '' : 'display:none'}">
                  <div class="li-section-title">Question Pages</div>
                  ${renderEstimatePageBuilder(form)}
                </div>
                <div class="li-form-section li-estimate-only" style="${form.mode === 'instant_estimate' ? '' : 'display:none'}">
                  <div class="li-section-title">Pricing</div>
                  <div class="li-pricing-table">
                    <div class="li-pricing-row head"><div>Roof Type</div><div>Pitch</div><div>Low $/Sq Ft</div><div>High $/Sq Ft</div></div>
                    ${estimatePricingRowsFor(form).map((row, index) => `
                      <div class="li-pricing-row">
                        ${pricingSelect('data-pricing-roof', index, row.roof_type, pricingRoofOptions)}
                        ${pricingSelect('data-pricing-pitch', index, row.pitch, pricingPitchOptions)}
                        <input class="cs-in" data-pricing-low="${index}" type="number" min="1" step="0.25" value="${escapeHtml(String(row.low_price_sqft))}">
                        <input class="cs-in" data-pricing-high="${index}" type="number" min="1" step="0.25" value="${escapeHtml(String(row.high_price_sqft))}">
                      </div>
                    `).join('')}
                  </div>
                </div>
                <div class="li-form-section">
                  <div class="li-section-title">Embed</div>
                  <div class="li-embed-row">
                    <textarea class="li-code" id="liEmbedCode" readonly>${escapeHtml(embedCode(form))}</textarea>
                    <button class="cs-btn ghost" id="liCopyEmbed" type="button"><i class="fas fa-copy"></i> Copy Embed</button>
                  </div>
                </div>
                <div class="li-actions">
                  <button class="cs-btn" id="liSaveForm" type="button"><i class="fas fa-save"></i> Save Form</button>
                  <button class="cs-btn ghost" id="liDeleteForm" type="button"><i class="fas fa-trash"></i> Delete</button>
                </div>
              </div>
              <div class="li-preview">
                <div class="li-preview-toolbar">
                  <div class="cs-lbl">Preview</div>
                  <div class="li-device-toggle" aria-label="Preview size">
                    ${['desktop','tablet','mobile'].map((mode) => `<button type="button" data-preview-mode="${mode}" class="${previewMode === mode ? 'active' : ''}">${mode === 'desktop' ? 'Desktop' : (mode === 'tablet' ? 'Tablet' : 'Phone')}</button>`).join('')}
                  </div>
                </div>
                <div class="li-preview-frame ${escapeHtml(previewMode)}"><div id="liLivePreview">${renderPreview(form)}</div></div>
              </div>
            </div>
          </div>
        `;
        restoreEditorScroll();
        panelWebsite.querySelector('.li-editor > .cs-card')?.addEventListener('scroll', rememberEditorScroll);
        if (form.mode === 'instant_estimate') hydrateEstimatePreview(form);
        else hydratePreviewBooking(form);
        panelWebsite.querySelectorAll('[data-form-id]').forEach((button) => button.addEventListener('click', () => { selectedFormId = button.dataset.formId || ''; renderWebsite(); }));
        panelWebsite.querySelectorAll('[data-preview-mode]').forEach((button) => button.addEventListener('click', () => { previewMode = button.dataset.previewMode || 'desktop'; viewState.previewMode = previewMode; renderWebsite(); }));
        panelWebsite.querySelectorAll('[data-page-go]').forEach((button) => button.addEventListener('click', () => {
          rememberEditorScroll();
          const pages = collectEstimatePages(panelWebsite, form);
          const editorPages = estimateEditorPagesFor(form);
          const target = Math.max(0, Math.min(editorPages.length - 1, Number(button.dataset.pageGo || 0)));
          form.estimate = { ...(form.estimate || {}), pages };
          form.copy = {
            ...(form.copy || {}),
            headline: $('#liEstimateHeadline', panelWebsite)?.value ?? form.copy?.headline ?? '',
            subheadline: $('#liEstimateSubheadline', panelWebsite)?.value ?? form.copy?.subheadline ?? '',
            start_label: $('#liEstimateStart', panelWebsite)?.value ?? form.copy?.start_label ?? 'Get started',
            submit_label: $('#liEstimateSubmit', panelWebsite)?.value ?? form.copy?.submit_label ?? '',
            fine_print: $('#liEstimateFine', panelWebsite)?.value ?? form.copy?.fine_print ?? ''
          };
          estimateEditorStateForForm(form, editorPages.length).page = target;
          renderWebsite();
        }));
        panelWebsite.querySelectorAll('[data-option-upload]').forEach((input) => input.addEventListener('change', () => {
          const file = input.files?.[0];
          if (!file) return;
          const key = input.dataset.optionUpload || '';
          const reader = new FileReader();
          reader.addEventListener('load', () => {
            const value = String(reader.result || '');
            const hidden = panelWebsite.querySelector(`[data-option-image="${key}"]`);
            if (hidden) hidden.value = value;
            const thumb = input.closest('.li-option-row')?.querySelector('.li-option-thumb');
            if (thumb) thumb.style.backgroundImage = `url('${value.replaceAll("'", "%27")}')`;
            const pages = collectEstimatePages(panelWebsite, form);
            form.estimate = { ...(form.estimate || {}), pages };
            refreshPreview();
          });
          reader.readAsDataURL(file);
        }));
        panelWebsite.querySelectorAll('[data-option-add]').forEach((button) => button.addEventListener('click', () => {
          rememberEditorScroll();
          const pages = collectEstimatePages(panelWebsite, form);
          const index = Number(button.dataset.optionAdd);
          if (pages[index]) pages[index].options.push({ value: `option-${pages[index].options.length + 1}`, label: 'New option', description: '', icon: 'fa-circle', image: '', enabled:true });
          form.estimate = { ...(form.estimate || {}), pages };
          renderWebsite();
        }));
        panelWebsite.querySelectorAll('[data-page-remove]').forEach((button) => button.addEventListener('click', () => {
          rememberEditorScroll();
          const pages = collectEstimatePages(panelWebsite, form);
          const index = Number(button.dataset.pageRemove);
          if (pages.length > 1) pages.splice(index, 1);
          form.estimate = { ...(form.estimate || {}), pages };
          const editorPages = estimateEditorPagesFor(form);
          estimateEditorStateForForm(form, editorPages.length).page = Math.max(0, Math.min(editorPages.length - 1, Number(estimateEditorStateForForm(form, editorPages.length).page || 0) - 1));
          renderWebsite();
        }));
        $('#liAddEstimatePage', panelWebsite)?.addEventListener('click', () => {
          rememberEditorScroll();
          const pages = collectEstimatePages(panelWebsite, form);
          const index = pages.length + 1;
          pages.push({ key: `custom_${index}`, title: 'Additional question', subtitle: '', type: 'choice', options: [{ value:'yes', label:'Yes', description:'', icon:'fa-circle' }, { value:'no', label:'No', description:'', icon:'fa-circle' }] });
          form.estimate = { ...(form.estimate || {}), pages };
          estimateEditorStateForForm(form, estimateEditorPagesFor(form).length).page = index + 1;
          renderWebsite();
        });
        $('#liNewForm', panelWebsite)?.addEventListener('click', async () => {
          await createWebsiteForm($('#liNewForm', panelWebsite), activeFormKind);
        });
        const collect = () => {
          form.name = $('#liFormName', panelWebsite)?.value || form.name;
          form.tracking_key = uniqueTrackingKey(form.name, form.id);
          form.mode = form.mode || (activeFormKind === 'instant_estimate' ? 'instant_estimate' : (activeFormKind === 'submit_form' ? 'submit_form' : 'appointment'));
          form.enabled = !!$('#liFormEnabled', panelWebsite)?.checked;
          if (form.mode === 'instant_estimate') {
            form.copy = {
              ...copy,
              headline: $('#liEstimateHeadline', panelWebsite)?.value ?? copy.headline ?? '',
              subheadline: $('#liEstimateSubheadline', panelWebsite)?.value ?? copy.subheadline ?? '',
              start_label: $('#liEstimateStart', panelWebsite)?.value ?? copy.start_label ?? 'Get started',
              submit_label: $('#liEstimateSubmit', panelWebsite)?.value ?? copy.submit_label ?? '',
              fine_print: $('#liEstimateFine', panelWebsite)?.value ?? copy.fine_print ?? ''
            };
          } else {
            form.copy = {
              ...copy,
              headline: $('#liFormHeadline', panelWebsite)?.value || '',
              subheadline: $('#liFormSubheadline', panelWebsite)?.value || '',
              submit_label: $('#liFormSubmit', panelWebsite)?.value || '',
              fine_print: $('#liFormFine', panelWebsite)?.value || ''
            };
          }
          const useCompanyColors = !!$('#liUseCompanyColors', panelWebsite)?.checked;
          form.style = {
            ...style,
            use_company_colors: useCompanyColors,
            primary_color: useCompanyColors ? cssVar('--primary-readable', cssVar('--primary', DEFAULT_PRIMARY)) : ($('#liFormPrimary', panelWebsite)?.value || DEFAULT_PRIMARY),
            text_color: useCompanyColors ? '#111827' : ($('#liFormText', panelWebsite)?.value || '#111827'),
            font_family: $('#liFormFont', panelWebsite)?.value || 'Montserrat',
            logo_enabled: !!$('#liFormLogoEnabled', panelWebsite)?.checked,
            logo_url: state.logo || ''
          };
          if (form.mode === 'instant_estimate') {
            const pricingRows = collectEstimatePricingRows(panelWebsite, form);
            const fallbackPricing = pricingRows[0] || {};
            form.estimate = {
              ...(form.estimate || {}),
              low_price_sqft: Math.max(1, Number(fallbackPricing.low_price_sqft || form.estimate?.low_price_sqft || 6.75) || 6.75),
              high_price_sqft: Math.max(1, Number(fallbackPricing.high_price_sqft || form.estimate?.high_price_sqft || 11.5) || 11.5),
              pricing_matrix: pricingRows,
              default_sqft: Math.max(500, Number(form.estimate?.default_sqft || 2200) || 2200),
              map_zoom: Number(form.estimate?.map_zoom || 19),
              steps: Array.isArray(form.estimate?.steps) ? form.estimate.steps : defaultEstimateForm().estimate.steps,
              pages: collectEstimatePages(panelWebsite, form)
            };
          }
          const scheduleDefaults = schedulingDefaultsFromConfig();
          if (form.mode === 'instant_estimate') {
            form.scheduling = { ...(scheduling || {}), event_type_default_id: 'estimate_followup', allowed_role_ids: ['sales_appointments'] };
          } else if (form.mode === 'submit_form') {
            form.scheduling = { ...(scheduling || {}), event_type_default_id: 'form_followup', allowed_role_ids: ['inside_sales'] };
          } else {
            form.scheduling = {
              ...scheduling,
              event_type_default_id: form.mode === 'call' ? 'contact_call' : 'sales_appointment',
              allowed_role_ids: [form.mode === 'call' ? 'inside_sales' : 'sales_appointments'],
              duration_minutes: scheduleDefaults.duration,
              slot_minutes: scheduleDefaults.slot,
              buffer_minutes: scheduleDefaults.buffer
            };
          }
          return form;
        };
        const refreshPreview = () => {
          const updated = collect();
          const customColors = $('#liCustomColors', panelWebsite);
          if (customColors) customColors.classList.toggle('active', updated.style.use_company_colors === false);
          panelWebsite.querySelectorAll('.li-estimate-only').forEach((section) => {
            section.style.display = updated.mode === 'instant_estimate' ? '' : 'none';
          });
          panelWebsite.querySelector('.li-form-section')?.classList.toggle('disabled', updated.enabled === false);
          const preview = $('#liLivePreview', panelWebsite);
          if (preview) preview.innerHTML = renderPreview(updated);
          if (updated.mode === 'instant_estimate') hydrateEstimatePreview(updated);
          else hydratePreviewBooking(updated);
          const code = $('#liEmbedCode', panelWebsite);
          if (code) code.value = embedCode(updated);
        };
        panelWebsite.querySelectorAll('input,select,textarea').forEach((input) => input.addEventListener('input', refreshPreview));
        panelWebsite.querySelectorAll('select').forEach((select) => select.addEventListener('change', refreshPreview));
        panelWebsite.querySelectorAll('input[type="checkbox"]').forEach((input) => input.addEventListener('change', refreshPreview));
        $('#liFormFont', panelWebsite)?.addEventListener('change', refreshPreview);
        $('#liUseCompanyColors', panelWebsite)?.addEventListener('change', refreshPreview);
        $('#liFormLogoEnabled', panelWebsite)?.addEventListener('change', refreshPreview);
        bindColorControl(panelWebsite, 'liFormPrimary', refreshPreview);
        bindColorControl(panelWebsite, 'liFormText', refreshPreview);
        $('#liSaveForm', panelWebsite)?.addEventListener('click', async () => {
          const button = $('#liSaveForm', panelWebsite);
          if (button) {
            button.dataset.defaultHtml = '<i class="fas fa-save"></i> Save Form';
            button.disabled = true;
            button.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Saving...';
          }
          const updated = collect();
          try {
            await saveLeadSettings({ website_forms: allForms.map((item) => item.id === updated.id ? updated : item) });
            feedbackButton(button, '<i class="fas fa-check"></i> Saved');
          } catch(e) {
            if (button) {
              button.disabled = false;
              button.innerHTML = '<i class="fas fa-save"></i> Save Form';
            }
            showToast('Save failed', e?.message || 'Could not save website form.', false);
          }
        });
        $('#liCopyEmbed', panelWebsite)?.addEventListener('click', async () => {
          const button = $('#liCopyEmbed', panelWebsite);
          const value = $('#liEmbedCode', panelWebsite)?.value || '';
          try {
            await navigator.clipboard.writeText(value);
            feedbackButton(button, '<i class="fas fa-check"></i> Copied');
          } catch(e) {
            feedbackButton(button, '<i class="fas fa-triangle-exclamation"></i> Copy failed');
          }
        });
        $('#liDeleteForm', panelWebsite)?.addEventListener('click', async () => {
          if (!(await (window.PlatformUI?.confirm?.('Delete this website lead form? Existing embeds using it will stop working.', { title: 'Delete website form', okLabel: 'Delete', danger: true }) || Promise.resolve(confirm('Delete this website lead form? Existing embeds using it will stop working.'))))) return;
          const next = allForms.filter((item) => item.id !== form.id);
          selectedFormId = next[0]?.id || '';
          await saveLeadSettings({ website_forms: next });
          showToast('Deleted', 'Website form deleted.', true);
        });
      };
      const renderAll = () => {
        renderEmail();
        renderWebsite();
        setLeadPane(activeLeadPane);
      };
      try {
        await Promise.all([loadLeadSettings(), loadScheduling().catch(() => null)]);
        renderAll();
      } catch(e) {
        leadPane.innerHTML = `<div class="li-muted">${escapeHtml(e?.message || 'Could not load lead import settings.')}</div>`;
      }
    }

    // **** Company pane ----
    if (canCompany && paneCompany) {
      paneCompany.innerHTML = `
        <div class="cs-grid">
          <div>
            <div class="cs-row">
              <div class="cs-lbl">Company name</div>
              <input class="cs-in" id="csName" placeholder="Your company name" />
            </div>
            <div class="cs-row">
              <div class="cs-lbl">Company email</div>
              <input class="cs-in" id="csCompanyEmail" placeholder="billing@company.com" inputmode="email" />
            </div>
            <div class="cs-row">
              <div class="cs-lbl">Company phone</div>
              <input class="cs-in" id="csCompanyPhone" placeholder="(555) 123-4567" inputmode="tel" autocomplete="tel" />
            </div>
            <div class="cs-row">
              <div class="cs-lbl">Company address</div>
              <textarea class="cs-in" id="csCompanyAddress" placeholder="Street, City, State ZIP" style="min-height:84px; resize:vertical;"></textarea>
            </div>
            <div class="cs-row">
              <div class="cs-lbl">Primary color</div>
              <div class="cs-colorline">
                <input type="color" class="cs-color" id="csPrimary" />
                <span class="cs-chip" id="csPrimaryChip"><span class="hash">#</span><input id="csPrimaryHex" maxlength="6" autocomplete="off" spellcheck="false"></span>
              </div>
            </div>
            <div class="cs-row">
              <div class="cs-lbl">Secondary color</div>
              <div class="cs-colorline">
                <input type="color" class="cs-color" id="csSecondary" />
                <span class="cs-chip" id="csSecondaryChip"><span class="hash">#</span><input id="csSecondaryHex" maxlength="6" autocomplete="off" spellcheck="false"></span>
              </div>
            </div>
            <div class="cs-row">
              <div class="cs-lbl">Logo</div>
              <div class="cs-file">
                <label class="cs-btn ghost" for="csLogoFile"><i class="fas fa-upload"></i> Choose image</label>
                <input type="file" id="csLogoFile" accept="image/*" />
              </div>
            </div>
            <div class="cs-actions">
              <button class="cs-btn primary" id="csSave"><i class="fas fa-save"></i> Save</button>
              <button class="cs-btn ghost" id="csRefresh"><i class="fas fa-rotate"></i> Reload</button>
            </div>
            <div class="cs-note" id="csStatus"></div>
          </div>
          <div>
            <div class="cs-lbl" style="margin-bottom:8px;">Preview</div>
            <div class="cs-previewWrap">
              <div class="cs-page" id="csPage">
                <div class="cs-barPrimary"></div>
                <div class="cs-barSecondary"></div>
                <div class="cs-pageInner">
                  <div class="cs-pageLogo"><img id="csPrevLogoImg" alt="Logo"></div>
                  <div class="cs-centerZone"><img id="csSampleDiagram" alt="Sample diagram"></div>
                </div>
              </div>
            </div>
          </div>
        </div>
      `;
    }
    // **** Users pane ----
    const canAddDelete = hasPerm('manage_company_users');
    const canManagePerms = hasPerm('manage_company_user_permissions');
    if (canUsers && paneUsers) {
      paneUsers.innerHTML = `
        <div class="cu-top">
          <div>
            <div class="cu-title">Users</div>
            <div class="cs-note">Invite users, manage access, and edit permissions.</div>
          </div>
          <div class="cu-actions">
            ${canAddDelete ? `<button class="cu-btn" id="cuAdd"><i class="fas fa-user-plus"></i> Add user</button>` : ''}
            <button class="cu-btn toggle ${usersState.showPerms ? 'on' : ''}" id="cuPerms" type="button" aria-pressed="${usersState.showPerms ? 'true' : 'false'}"><i class="fas ${usersState.showPerms ? 'fa-toggle-on' : 'fa-toggle-off'}"></i> Show permissions</button>
            <button class="cu-btn" id="cuReload"><i class="fas fa-rotate"></i> Reload</button>
          </div>
        </div>
        <div id="cuMsg" class="cs-note"></div>
        <table class="cu-table">
          <thead><tr>
            <th class="cu-th userHead">User</th>
            <th class="cu-th">Permission Level</th>
            <th class="cu-th">Status</th>
            <th class="cu-th" style="width:56px;"></th>
          </tr></thead>
          <tbody id="cuBody"></tbody>
        </table>
      `;
    }
    // **** Reports pane ----
    if (canReports && paneReports) {
      paneReports.innerHTML = `
        <div class="rp-wrap">
          <div class="rp-card">
            <h3 class="rp-h">Customer Report Settings</h3>
            <div class="rp-tgrid" id="rpToggles"></div>
            <div class="cs-actions" style="margin-top:14px;">
              <button class="cs-btn primary" id="rpSave"><i class="fas fa-save"></i> Save</button>
              <button class="cs-btn ghost" id="rpReset"><i class="fas fa-rotate-left"></i> Reset</button>
            </div>
            <div class="cs-note" id="rpStatus"></div>
          </div>
        </div>
      `;
    }
    // **** Billing pane ----
    if (canBilling && paneBilling) {
      paneBilling.innerHTML = `
        <div class="bl-wrap">
          <div class="bl-card" style="margin-bottom:16px;">
            <div class="bl-row" style="align-items:center;">
              <div class="bl-left">
                <span class="bl-pill"><i class="fas fa-ruler-combined"></i> Measurement credit</span>
                <span class="cs-note credits-sub-target" style="margin:0;">Available balance for measurement orders.</span>
              </div>
              <div class="bl-ctrl" style="gap:14px;">
                <div class="credits-value" style="font-size:28px; line-height:1;"><span class="credits-val-target">-</span></div>
                <button class="cs-btn primary" type="button" data-buy-credits="settings_billing"><i class="fas fa-credit-card"></i> Add Credit</button>
              </div>
            </div>
          </div>
          <div class="bl-grid">
            <!-- LEFT: existing controls -->
            <div class="bl-card">
              <h3 class="bl-h">Auto Top-Up</h3>
              <div class="bl-sub" id="blSubCopy">Use the card on file to keep your account funded automatically.</div>
              <div class="bl-toggleLine">
                <div class="bl-left">
                  <span class="bl-pill"><i class="fas fa-bolt"></i> Auto top-up</span>
                  <span class="cs-note" id="blEnabledNote" style="margin:0;">Off</span>
                </div>
                <button class="bl-switch" id="blEnableToggle" type="button">
                  <span class="dot"></span>
                  <span id="blEnableText">Disabled</span>
                </button>
              </div>
              <div class="bl-divider"></div>
              <div id="blControls">
                <div class="cs-note" id="blMinimumNote" style="margin:0 0 12px 0;">
                  Minimum auto top-up values are $${BILL_MIN}.
                </div>
                <div class="bl-row">
                  <div class="bl-left">
                    <span class="bl-pill"><i class="fas fa-arrow-down"></i> Top up when below</span>
                    <span class="cs-note" style="margin:0;">Minimum $${BILL_MIN}</span>
                  </div>
                  <div class="bl-ctrl">
                    <button class="bl-stepBtn" id="blThMinus" type="button"><i class="fas fa-minus"></i></button>
                    <div class="bl-moneyWrap">
                      <span class="usd">$</span>
                      <input class="cs-in bl-money" id="blThreshold" inputmode="numeric" placeholder="${BILL_MIN}">
                    </div>
                    <button class="bl-stepBtn" id="blThPlus" type="button"><i class="fas fa-plus"></i></button>
                  </div>
                </div>
                <div class="bl-row">
                  <div class="bl-left">
                    <span class="bl-pill"><i class="fas fa-cart-plus"></i> Auto top-up amount</span>
                    <span class="cs-note" style="margin:0;">Minimum $${BILL_MIN}</span>
                  </div>
                  <div class="bl-ctrl">
                    <button class="bl-stepBtn" id="blAmtMinus" type="button"><i class="fas fa-minus"></i></button>
                    <div class="bl-moneyWrap">
                      <span class="usd">$</span>
                      <input class="cs-in bl-money" id="blTopup" inputmode="numeric" placeholder="${BILL_MIN}">
                    </div>
                    <button class="bl-stepBtn" id="blAmtPlus" type="button"><i class="fas fa-plus"></i></button>
                  </div>
                </div>
                <div class="bl-summary" id="blSummary"></div>
              </div>
              <div class="bl-divider"></div>
              <div class="bl-row">
                <div class="bl-left">
                  <span class="bl-pill"><i class="fas fa-credit-card"></i> Payment method</span>
                  <span class="cs-note" id="blCardNote" style="margin:0;">Not set</span>
                </div>
                <div class="bl-ctrl">
                  <button class="cs-btn ghost" id="blUpdateCard" type="button"><i class="fas fa-credit-card"></i> Add card</button>
                </div>
              </div>
              <div class="cs-actions" style="margin-top:14px;">
                <button class="cs-btn primary" id="blSave"><i class="fas fa-save"></i> Save</button>
                <button class="cs-btn ghost" id="blReload"><i class="fas fa-rotate"></i> Reload</button>
              </div>
              <div class="cs-note" id="blStatus"></div>
            </div>
            <!-- RIGHT: billing history -->
            <div class="bh-card">
              <div class="bh-top">
                <div>
                  <div class="bh-h">Billing history</div>
                  <div class="bh-sub">Recent billing + top-up events for this organization.</div>
                </div>
                <button class="cs-btn ghost bh-btn" id="bhReload" type="button"><i class="fas fa-rotate"></i> Reload</button>
              </div>
              <div class="bh-list" id="bhList">
                <div class="bh-empty">Loading...</div>
              </div>
              <div class="cs-note" id="bhStatus" style="margin-top:10px;"></div>
            </div>
          </div>
          <!-- Monthly Statement -->
          <div class="ms-card" id="msCard">
            <div class="ms-top">
              <div>
                <div class="ms-h"><i class="fas fa-file-invoice-dollar"></i> Monthly Statement</div>
                <div class="ms-sub">Monthly billing ledger with payments, orders, credits, and refunds.</div>
              </div>
              <div class="ms-nav">
                <button class="ms-navBtn" id="msPrev" type="button"><i class="fas fa-chevron-left"></i></button>
                <span class="ms-monthLabel" id="msMonthLabel">-</span>
                <button class="ms-navBtn" id="msNext" type="button"><i class="fas fa-chevron-right"></i></button>
              </div>
            </div>
            <div class="ms-summary" id="msSummary">
              <div class="ms-loading">Loading...</div>
            </div>
            <div class="ms-actions" id="msActions" style="display:none;">
              <button class="cs-btn ghost" id="msViewDetail" type="button"><i class="fas fa-list"></i> View Details</button>
              <button class="cs-btn ghost" id="msExportCsv" type="button"><i class="fas fa-download"></i> Export CSV</button>
            </div>
          </div>
        </div>
      `;
    }
    // **** Floating menu element (users) ----
    floatingMenu = document.createElement('div');
    floatingMenu.className = 'cu-fmenu';
    document.body.appendChild(floatingMenu);
    function closeFloatingMenu(){
      if (!floatingMenu) return;
      floatingMenu.classList.remove('open');
      floatingMenu.style.display = 'none';
      floatingMenu.innerHTML = '';
      usersState.openMenuUserId = null;
    }
    document.addEventListener('click', (e)=>{
      if (paneUsers && !paneUsers.classList.contains('active')) return;
      const t = e.target;
      if (!t) return;
      if (t.closest && t.closest('.cu-fmenu')) return;
      if (t.closest && t.closest('button[data-act="kebab"]')) return;
      closeFloatingMenu();
    });
    document.addEventListener('keydown', (e)=>{
      if (paneUsers && !paneUsers.classList.contains('active')) return;
      if (e.key === 'Escape') closeFloatingMenu();
    });
    let lastSidebarLogoKey = null;
    let lastPreviewLogoKey = null;
    function updateSidebarLogoIfNeeded(force){
      const img = document.getElementById('companyLogoImg');
      if (!img) return;
      const key = logoKey(state.logo || DEFAULT_LOGO);
      if (!force && key === lastSidebarLogoKey) return;
      lastSidebarLogoKey = key;
      setImgSmart(img, key, { forceBust: force, bustKey: Date.now() });
    }
    function updatePreviewLogoIfNeeded(force){
      if(!paneCompany) return;
      const img = $('#csPrevLogoImg', paneCompany);
      if (!img) return;
      const wrap = img.closest('.cs-pageLogo');
      const customerLogo = logoKey(state.logo);
      if (!customerLogo) {
        if (wrap) wrap.classList.add('default-firstmeasure-logo');
        img.removeAttribute('src');
        img.style.display = 'none';
        lastPreviewLogoKey = 'default-firstmeasure-colorized';
        return;
      }
      if (wrap) wrap.classList.remove('default-firstmeasure-logo');
      img.style.display = '';
      const key = customerLogo;
      if (!force && key === lastPreviewLogoKey) return;
      lastPreviewLogoKey = key;
      setImgSmart(img, key, { forceBust: force, bustKey: Date.now() });
    }
    function persistTheme(){
      const theme = {
        name: state.name,
        logo: state.logo,
        primary: state.primary,
        secondary: state.secondary
      };
      cacheTheme(theme);
      if (window.__applyTheme) window.__applyTheme(theme);
      else {
        window.__APP = window.__APP || {};
        window.__APP.theme = theme;
        window.Portal = window.Portal || {};
        window.Portal.currentTheme = theme;
        window.dispatchEvent(new CustomEvent('fm:theme:updated', { detail: theme }));
      }
    }
    function renderCompany({ writeInputs=false, forceLogo=false, publish=true } = {}){
      if (!canCompany) return;
      const csName = $('#csName', paneCompany);
      const csPrimary = $('#csPrimary', paneCompany);
      const csSecondary = $('#csSecondary', paneCompany);
      const csPrimaryHex = $('#csPrimaryHex', paneCompany);
      const csSecondaryHex = $('#csSecondaryHex', paneCompany);
      const csCompanyEmail = $('#csCompanyEmail', paneCompany);
      const csCompanyPhone = $('#csCompanyPhone', paneCompany);
      const csCompanyAddress = $('#csCompanyAddress', paneCompany);
      if (writeInputs){
        if(csName) csName.value = state.name;
        if(csPrimary) csPrimary.value = clampHex(state.primary, DEFAULT_PRIMARY);
        if(csSecondary) csSecondary.value = clampHex(state.secondary, DEFAULT_SECONDARY);
        if(csPrimaryHex) csPrimaryHex.value = clampHex(csPrimary.value, DEFAULT_PRIMARY).slice(1);
        if(csSecondaryHex) csSecondaryHex.value = clampHex(csSecondary.value, DEFAULT_SECONDARY).slice(1);
        if (csCompanyEmail) csCompanyEmail.value = state.company_email || '';
        if (csCompanyPhone) csCompanyPhone.value = state.company_phone || '';
        if (csCompanyAddress) csCompanyAddress.value = state.company_address || '';
      }
      if (publish) {
        applyCssVars(state.primary, state.secondary);
        persistTheme();
        updateSidebarLogoIfNeeded(forceLogo);
      }
      updatePreviewLogoIfNeeded(forceLogo);
    }
    function renderReports(){
      if (!canReports) return;
      // --- Insert disclaimer once ---
      try{
        const card = paneReports ? paneReports.querySelector('.rp-card') : null;
        if (card && !card.querySelector('#rpDisclaimer')){
          const div = document.createElement('div');
          div.id = 'rpDisclaimer';
          div.className = 'cs-note';
          div.style.marginTop = '10px';
          div.style.marginBottom = '12px';
          div.innerHTML = `
            Changing report settings only applies to <b>future</b> measurement reports.
            It does <b>not</b> change reports that have already been ordered.
          `;
          const h3 = card.querySelector('h3.rp-h');
          if (h3 && h3.parentNode){
            if (h3.nextSibling) h3.parentNode.insertBefore(div, h3.nextSibling);
            else h3.parentNode.appendChild(div);
          } else {
            card.insertBefore(div, card.firstChild);
          }
        }
      }catch(e){ /* ignore */ }
      const sections = [
        {
          title: 'Cover',
          subtitle: 'Choose which measurement variables and customer details appear on the cover page.',
          items: [
            { key:'cover_show_customer',  label:'Customer info' },
            { key:'cover_show_squares',   label:'Total squares' },
            { key:'cover_show_waste',     label:'Waste' },
            { key:'cover_show_breakdown', label:'Breakdown' },
            { key:'cover_show_pitch',     label:'Pitch' },
            { key:'cover_show_facets',    label:'Facet count' }
          ]
        },
        {
          title: 'Pages',
          subtitle: 'Choose the standard report pages included in every future customer PDF.',
          items: [
            { key:'page_top_view',     label:'Top View Page' },
            { key:'page_elevations',   label:'Elevations Page' },
            { key:'page_3d',           label:'3D Page' },
            { key:'page_pitch',        label:'Pitch Page' },
            { key:'page_area',         label:'Area Page' },
            { key:'page_layers',       label:'Layers Page' },
            { key:'page_summary',      label:'Summary Page' },
            { key:'page_materials',    label:'Materials Page' },
            { key:'page_ventilation',  label:'Ventilation Page' },
            { key:'page_notes',        label:'Customer Notes Page' }
          ]
        },
        {
          title: 'Add-ons',
          subtitle: 'When add-ons are ordered, choose whether their pages should be included in the customer PDF.',
          items: [
            { key:'page_gutters', label:'Include gutters page when gutters are ordered' }
          ]
        }
      ];
      const wrap = $('#rpToggles', paneReports);
      if (wrap) {
        wrap.className = 'rp-sections';
        wrap.innerHTML = sections.map(section => `
          <section class="rp-section">
            <div class="rp-sectionHead">
              <div class="rp-sectionTitle">${escapeHtml(section.title)}</div>
              <div class="rp-sectionSub">${escapeHtml(section.subtitle)}</div>
            </div>
            <div class="rp-tgrid">
              ${section.items.map(it => makeToggleBtn({
                key: it.key,
                label: it.label,
                value: !!state.report_customer[it.key]
              })).join('')}
            </div>
          </section>
        `).join('');
        wrap.querySelectorAll('.rp-toggle').forEach(btn=>{
          btn.addEventListener('click', ()=>{
            const k = btn.getAttribute('data-key');
            if (!k) return;
            const next = !state.report_customer[k];
            state.report_customer[k] = next;
            btn.classList.toggle('on', next);
            btn.classList.toggle('off', !next);
            btn.setAttribute('data-val', next ? '1' : '0');
            const st = btn.querySelector('.rp-state');
            if (st) st.textContent = next ? 'On' : 'Off';
          });
        });
      }
    }
    // =========================================================================
    //  MONTHLY STATEMENT
    // =========================================================================
    function msCacheKey(m, y){ return `${y}-${String(m).padStart(2,'0')}`; }
    function msIsCurrentMonth(m, y){
      const now = new Date();
      return m === (now.getMonth()+1) && y === now.getFullYear();
    }
    function msIsFutureMonth(m, y){
      const now = new Date();
      const nowKey = now.getFullYear() * 100 + (now.getMonth()+1);
      const testKey = y * 100 + m;
      return testKey > nowKey;
    }
    function msFormatDate(iso){
      if (!iso) return '-';
      const d = new Date(iso);
      if (!isFinite(d.getTime())) return iso;
      return d.toLocaleDateString(undefined, { month:'short', day:'numeric', year:'numeric' });
    }
    function msStatusLabel(st){
      const s = String(st || '').toLowerCase().trim();
      if (s === 'completed') return 'Completed';
      if (s === 'rejected' || s === 'rejected_no_coverage') return 'Rejected';
      return 'Processing';
    }
    function msStatusClass(st){
      const s = String(st || '').toLowerCase().trim();
      if (s === 'completed') return 'completed';
      if (s === 'rejected' || s === 'rejected_no_coverage') return 'rejected';
      return '';
    }
    function msMoney(v){
      const n = Number(String(v ?? '').replace(/[^0-9.\-]/g, ''));
      return Number.isFinite(n) ? n : 0;
    }
    function msMoneyText(v){
      const amount = Math.round(msMoney(v) * 100) / 100;
      return amount % 1 === 0 ? String(amount.toFixed(0)) : amount.toFixed(2);
    }
    function msReason(row){
      return String(row?.reason || '').toLowerCase().trim();
    }
    function msLedgerMeta(row){
      return (row?.meta && typeof row.meta === 'object') ? row.meta : {};
    }
    function msLedgerRequestType(row){
      const meta = msLedgerMeta(row);
      return String(
        row?.request_type
        || row?.report_request_type
        || row?.followup_type
        || meta.request_type
        || meta.report_request_type
        || meta.followup_type
        || meta.type
        || ''
      ).toLowerCase().trim();
    }
    function msLedgerStructureCount(row){
      const meta = msLedgerMeta(row);
      const direct = Number(row?.structure_count ?? row?.additional_structure_count ?? meta.structure_count ?? meta.additional_structure_count ?? 0) || 0;
      if (direct > 0) return direct;
      const pins = Array.isArray(row?.pins) ? row.pins : (Array.isArray(meta.pins) ? meta.pins : []);
      return pins.length;
    }
    function msIsAdditionalStructureLedger(row){
      const r = msReason(row);
      const meta = msLedgerMeta(row);
      if (msLedgerRequestType(row) === 'additional_structure') return true;
      if ([
        'additional_structure',
        'additional_structure_request',
        'additional_structure_request_refund',
        'report_additional_structure',
        'report_additional_structure_request',
        'report_additional_structure_request_refund',
        'report_rework_additional_structure',
        'firstmeasure_additional_structure',
        'firstmeasure_report_additional_structure'
      ].includes(r)) return true;
      const haystack = [
        row?.label,
        row?.description,
        row?.memo,
        meta.label,
        meta.description,
        meta.memo,
        meta.notes,
        meta.billing_label,
        meta.billing_description,
        meta.billing_reason
      ].map((value) => String(value || '').toLowerCase()).join(' ');
      return haystack.includes('additional structure');
    }
    function msIsAdditionalStructureRefund(row){
      return msIsAdditionalStructureLedger(row) && msReason(row).includes('refund');
    }
    function msLedgerReasonLabel(row){
      if (msIsAdditionalStructureRefund(row)) return 'additional_structure_refund';
      if (msIsAdditionalStructureLedger(row)) return 'additional_structure';
      return msReason(row) || 'adjustment';
    }
    function msLedgerTitle(row){
      const r = msReason(row);
      if (msIsAdditionalStructureRefund(row)) return 'Additional structure refund';
      if (msIsAdditionalStructureLedger(row)) return 'Additional structure request';
      if (r === 'order_submitted') return 'Report ordered';
      if (r === 'stripe_checkout_paid') return 'Payment received';
      if (r === 'stripe_auto_topup') return 'Auto top-up';
      if (r === 'coupon_redeem') return 'Promo credit applied';
      if (r === 'cancellation_refund') return 'Cancellation refund';
      if (r === 'firstmeasure_expedite_missed_promise_refund') return 'Expedite refund';
      if (r.indexOf('refund') !== -1) return 'Refund';
      if (r.indexOf('stripe') === 0) return 'Payment received';
      return 'Credit adjustment';
    }
    function msLedgerSub(row){
      const meta = msLedgerMeta(row);
      const r = msReason(row);
      const parts = [];
      const address = String(meta.address || row?.address || '').trim();
      const projectType = String(meta.project_type || '').trim();
      const reportMode = String(meta.report_mode || '').trim();
      const by = String(row?.applied_for_user_email || row?.by_email || meta.by_email || '').trim();
      const sid = String(meta.session_id || row?.session_id || '').trim();
      if (msIsAdditionalStructureLedger(row)) {
        const count = msLedgerStructureCount(row);
        if (address) parts.push(address);
        parts.push(msIsAdditionalStructureRefund(row)
          ? 'Additional structure request refund'
          : (count > 0 ? `${count} additional structure${count === 1 ? '' : 's'}` : 'Additional structure added to report'));
        if (projectType) parts.push(projectType);
        if (by) parts.push(by);
        if (sid) parts.push(`Ref ${sid.slice(-8)}`);
        return parts.join(' - ');
      }
      if (address) parts.push(address);
      if (projectType && r === 'order_submitted') parts.push(projectType);
      if (reportMode && r === 'order_submitted') parts.push(reportMode);
      if (sid) parts.push(`Ref ${sid.slice(-8)}`);
      if (by) parts.push(by);
      return parts.join(' - ');
    }
    function msLedgerAmountText(row){
      const delta = msMoney(row?.delta);
      if (delta > 0) return `+$${msMoneyText(delta)}`;
      if (delta < 0) return `-$${msMoneyText(Math.abs(delta))}`;
      return '$0';
    }
    function msCsvCell(value){
      return `"${String(value ?? '').replace(/"/g, '""')}"`;
    }
    function msTransactions(){
      const d = msState.data || {};
      return Array.isArray(d.transactions) ? d.transactions : (Array.isArray(d.ledger) ? d.ledger : []);
    }
    async function msLoadMonth(month, year, forceRefresh){
      if (!canBilling || !paneBilling) return;
      const key = msCacheKey(month, year);
      const summaryEl = $('#msSummary', paneBilling);
      const actionsEl = $('#msActions', paneBilling);
      const labelEl   = $('#msMonthLabel', paneBilling);
      const prevBtn   = $('#msPrev', paneBilling);
      const nextBtn   = $('#msNext', paneBilling);
      // Update label
      if (labelEl) labelEl.textContent = `${MONTH_NAMES[month-1]} ${year}`;
      // Disable forward past current month
      if (nextBtn) nextBtn.disabled = msIsCurrentMonth(month, year);
      // Check cache (skip for current month to stay fresh, unless explicitly cached)
      if (!forceRefresh && msState.cache[key] && !msIsCurrentMonth(month, year)){
        msState.data = msState.cache[key];
        msRenderSummary();
        return;
      }
      // Loading state
      msState.loading = true;
      if (summaryEl) summaryEl.innerHTML = `<div class="ms-loading">Loading...</div>`;
      if (actionsEl) actionsEl.style.display = 'none';
      const result = await fetchMonthlyStatement(month, year);
      msState.loading = false;
      if (!result.ok){
        if (summaryEl) summaryEl.innerHTML = `<div class="ms-loading">Could not load statement.</div>`;
        return;
      }
      msState.data = result;
      msState.cache[key] = result;
      msRenderSummary();
    }
    function msRenderSummary(){
      if (!canBilling || !paneBilling) return;
      const d = msState.data;
      const summaryEl = $('#msSummary', paneBilling);
      const actionsEl = $('#msActions', paneBilling);
      if (!d){
        if (summaryEl) summaryEl.innerHTML = `<div class="ms-loading">No data.</div>`;
        if (actionsEl) actionsEl.style.display = 'none';
        return;
      }
      const transactions = msTransactions();
      const totalIn = msMoney(d.total_in);
      const totalOut = msMoney(d.total_out ?? d.total_spent);
      const net = msMoney(d.net_change);
      const orderCount = d.total_orders || transactions.filter(t => msReason(t) === 'order_submitted').length;
      const paymentCount = d.total_payments || transactions.filter(t => msMoney(t?.delta) > 0).length;

      if (summaryEl){
        summaryEl.innerHTML = `
          <div class="ms-stat">
            <div class="ms-statLabel">Transactions</div>
            <div class="ms-statVal">${transactions.length}</div>
          </div>
          <div class="ms-stat">
            <div class="ms-statLabel">Payments In</div>
            <div class="ms-statVal">+$${msMoneyText(totalIn)}</div>
          </div>
          <div class="ms-stat">
            <div class="ms-statLabel">Orders / Debits</div>
            <div class="ms-statVal">$${msMoneyText(totalOut)}</div>
          </div>
          <div class="ms-stat">
            <div class="ms-statLabel">Net Change</div>
            <div class="ms-statVal">${net >= 0 ? '+' : '-'}$${msMoneyText(Math.abs(net))}</div>
          </div>
          <div class="ms-stat">
            <div class="ms-statLabel">Order Count</div>
            <div class="ms-statVal">${orderCount}</div>
          </div>
          <div class="ms-stat">
            <div class="ms-statLabel">Payment Count</div>
            <div class="ms-statVal">${paymentCount}</div>
          </div>
        `;
      }
      if (actionsEl) actionsEl.style.display = transactions.length ? 'flex' : 'none';
    }

    function msOpenDetailModal(){
      const d = msState.data;
      if (!d) return;
      const orders = d.orders || [];
      const monthLabel = d.month_label || `${MONTH_NAMES[(msState.month||1)-1]} ${msState.year}`;
      const total = d.total_spent || 0;

      // --- Compute reimbursement total ---
      let totalReimbursed = 0;
      for (const o of orders){
        if (o.rejected){
          totalReimbursed += parseFloat(o.reimbursed_amount ?? o.cost ?? 0) || 0;
        }
      }

      const back = document.createElement('div');
      back.className = 'ms-modalBack';

      let tableHtml = '';
      if (!orders.length){
        tableHtml = `<div class="ms-mEmpty"><i class="fas fa-inbox"></i> No reports ordered this month.</div>`;
      } else {
        const rows = orders.map((o, idx) => {
          const stCls = msStatusClass(o.status);
          const costTxt = o.rejected ? '<span style="opacity:.45;">$0</span>' : `$${o.cost || 0}`;

          // Reimbursement cell: show amount for rejected orders, dash for others
          const reimb = o.rejected ? (parseFloat(o.reimbursed_amount ?? o.cost ?? 0) || 0) : 0;
          const reimbTxt = o.rejected
            ? `<span style="color:#1e7e34; font-weight:1000;">+$${reimb}</span>`
            : '<span style="opacity:.3;">-</span>';

          // Optional rejection reason sub-line under address
          const reasonHtml = (o.rejected && (o.rejection_reason || o.rejection_note))
            ? `<div style="margin-top:4px; font-size:11px; font-weight:800; color:#b0261e;"><i class="fas fa-circle-info"></i> ${escapeHtml(o.rejection_note || o.rejection_reason || '')}</div>`
            : '';

          // Optional reimbursed-at date under reimbursement amount
          const reimbDateHtml = (o.rejected && o.reimbursed_at)
            ? `<div style="margin-top:3px; font-size:10px; font-weight:800; color:#888;">${msFormatDate(o.reimbursed_at)}</div>`
            : '';

          return `
            <tr>
              <td style="font-variant-numeric:tabular-nums; color:#777; font-weight:950;">${idx+1}</td>
              <td>
                <div class="ms-addr">${escapeHtml(o.address || '-')}</div>
                ${o.issuer_name ? `<div class="ms-issuer">${escapeHtml(o.issuer_name)}${o.issuer_email ? ` (${escapeHtml(o.issuer_email)})` : ''}</div>` : ''}
                ${reasonHtml}
              </td>
              <td>${msFormatDate(o.created_at)}</td>
              <td><span class="ms-typePill">${escapeHtml(o.project_type || 'residential')}</span></td>
              <td><span class="ms-statusPill ${stCls}">${escapeHtml(msStatusLabel(o.status))}</span></td>
              <td class="right"><span class="ms-cost ${o.rejected ? 'zero' : ''}">${costTxt}</span></td>
              <td class="right">${reimbTxt}${reimbDateHtml}</td>
            </tr>
          `;
        }).join('');

        tableHtml = `
          <table class="ms-table">
            <thead><tr>
              <th style="width:40px;">#</th>
              <th>Address</th>
              <th>Date</th>
              <th>Type</th>
              <th>Status</th>
              <th class="right">Cost</th>
              <th class="right">Reimbursed</th>
            </tr></thead>
            <tbody>${rows}</tbody>
          </table>
        `;
      }

      // Footer: show total + reimbursement summary
      const reimbFooter = totalReimbursed > 0
        ? ` &nbsp;&middot;&nbsp; Reimbursed: <b style="color:#1e7e34;">+$${totalReimbursed}</b>`
        : '';

      back.innerHTML = `
        <div class="ms-modal">
          <div class="ms-mHeader">
            <div class="ms-mTitle"><i class="fas fa-file-invoice-dollar"></i> Statement - ${escapeHtml(monthLabel)}</div>
            <button class="ms-mClose" type="button"><i class="fas fa-xmark"></i></button>
          </div>
          <div class="ms-mBody">${tableHtml}</div>
          <div class="ms-mFooter">
            <div class="ms-mFooterLeft">${orders.length} report${orders.length !== 1 ? 's' : ''} - Total: <b>$${total}</b>${reimbFooter}</div>
            <div style="display:flex; gap:10px; flex-wrap:wrap;">
              <button class="cs-btn ghost" id="msModalExport" type="button"><i class="fas fa-download"></i> Export CSV</button>
              <button class="cs-btn ghost" id="msModalClose" type="button">Close</button>
            </div>
          </div>
        </div>
      `;

      const close = ()=> back.remove();
      let downOnBackdrop = false;
      back.addEventListener('mousedown', (e)=>{ downOnBackdrop = (e.target === back); });
      back.addEventListener('mouseup', (e)=>{ if (downOnBackdrop && e.target === back) close(); downOnBackdrop = false; });
      back.querySelector('.ms-mClose').addEventListener('click', close);
      back.querySelector('#msModalClose').addEventListener('click', close);
      back.querySelector('#msModalExport').addEventListener('click', ()=> msExportCsv());
      document.body.appendChild(back);
    }

    function msExportCsv(){
      const d = msState.data;
      if (!d) return;
      const orders = d.orders || [];
      const monthLabel = d.month_label || `${MONTH_NAMES[(msState.month||1)-1]} ${msState.year}`;

      // --- Compute reimbursement total ---
      let totalReimbursed = 0;

      // Build CSV - added "Reimbursed" as the last column
      const headers = ['#','Address','Ordered By','Date Ordered','Project Type','Status','Cost','Reimbursed'];
      const rows = orders.map((o, idx) => {
        const reimb = o.rejected ? (parseFloat(o.reimbursed_amount ?? o.cost ?? 0) || 0) : 0;
        totalReimbursed += reimb;
        return [
          idx + 1,
          `"${String(o.address || '').replace(/"/g, '""')}"`,
          `"${String(o.issuer_name || '').replace(/"/g, '""')}${o.issuer_email ? ' (' + o.issuer_email + ')' : ''}"`,
          o.created_at || '',
          o.project_type || 'residential',
          msStatusLabel(o.status),
          o.rejected ? 0 : (o.cost || 0),
          reimb || 0,
        ];
      });

      // Add totals row - includes reimbursement total
      rows.push(['', '', '', '', '', 'TOTAL', d.total_spent || 0, totalReimbursed]);

      const csvContent = [
        headers.join(','),
        ...rows.map(r => r.join(','))
      ].join('\n');

      // Trigger download
      const blob = new Blob([csvContent], { type: 'text/csv;charset=utf-8;' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `statement_${monthLabel.replace(/\s+/g, '_')}.csv`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
      showToast('Exported', `CSV downloaded for ${monthLabel}.`, true);
    }

    function msOpenDetailModal(){
      const d = msState.data;
      if (!d) return;
      const transactions = msTransactions();
      const monthLabel = d.month_label || `${MONTH_NAMES[(msState.month||1)-1]} ${msState.year}`;

      const back = document.createElement('div');
      back.className = 'ms-modalBack';

      let tableHtml = '';
      if (!transactions.length){
        tableHtml = `<div class="ms-mEmpty"><i class="fas fa-inbox"></i> No billing transactions this month.</div>`;
      } else {
        const rows = transactions.map((row, idx) => {
          const amount = msLedgerAmountText(row);
          const isPos = amount.startsWith('+');
          return `
            <tr>
              <td style="font-variant-numeric:tabular-nums; color:#777; font-weight:950;">${idx+1}</td>
              <td>
                <div class="ms-addr">${escapeHtml(msLedgerTitle(row))}</div>
                ${msLedgerSub(row) ? `<div class="ms-issuer">${escapeHtml(msLedgerSub(row))}</div>` : ''}
              </td>
              <td>${msFormatDate(row.ts || row.ts_utc || row.created_at)}</td>
              <td><span class="ms-typePill">${escapeHtml(msLedgerReasonLabel(row))}</span></td>
              <td class="right"><span class="ms-cost ${isPos ? 'zero' : ''}" style="${isPos ? 'color:#1e7e34;' : ''}">${escapeHtml(amount)}</span></td>
            </tr>
          `;
        }).join('');

        tableHtml = `
          <table class="ms-table">
            <thead><tr>
              <th style="width:40px;">#</th>
              <th>Transaction</th>
              <th>Date</th>
              <th>Reason</th>
              <th class="right">Amount</th>
            </tr></thead>
            <tbody>${rows}</tbody>
          </table>
        `;
      }

      const net = msMoney(d.net_change);
      back.innerHTML = `
        <div class="ms-modal">
          <div class="ms-mHeader">
            <div class="ms-mTitle"><i class="fas fa-file-invoice-dollar"></i> Statement - ${escapeHtml(monthLabel)}</div>
            <button class="ms-mClose" type="button"><i class="fas fa-xmark"></i></button>
          </div>
          <div class="ms-mBody">${tableHtml}</div>
          <div class="ms-mFooter">
            <div class="ms-mFooterLeft">${transactions.length} transaction${transactions.length !== 1 ? 's' : ''} - Net: <b>${net >= 0 ? '+' : '-'}$${msMoneyText(Math.abs(net))}</b></div>
            <div style="display:flex; gap:10px; flex-wrap:wrap;">
              <button class="cs-btn ghost" id="msModalExport" type="button"><i class="fas fa-download"></i> Export CSV</button>
              <button class="cs-btn ghost" id="msModalClose" type="button">Close</button>
            </div>
          </div>
        </div>
      `;

      const close = ()=> back.remove();
      let downOnBackdrop = false;
      back.addEventListener('mousedown', (e)=>{ downOnBackdrop = (e.target === back); });
      back.addEventListener('mouseup', (e)=>{ if (downOnBackdrop && e.target === back) close(); downOnBackdrop = false; });
      back.querySelector('.ms-mClose').addEventListener('click', close);
      back.querySelector('#msModalClose').addEventListener('click', close);
      back.querySelector('#msModalExport').addEventListener('click', ()=> msExportCsv());
      document.body.appendChild(back);
    }

    function msExportCsv(){
      const d = msState.data;
      if (!d) return;
      const transactions = msTransactions();
      const monthLabel = d.month_label || `${MONTH_NAMES[(msState.month||1)-1]} ${msState.year}`;
      const headers = ['#','Date','Transaction','Details','Reason','Amount','Balance After'];
      const rows = transactions.map((row, idx) => [
        idx + 1,
        msCsvCell(row.ts || row.ts_utc || row.created_at || ''),
        msCsvCell(msLedgerTitle(row)),
        msCsvCell(msLedgerSub(row)),
        msCsvCell(msLedgerReasonLabel(row)),
        msMoney(row?.delta),
        row?.balance_after == null ? '' : msMoney(row.balance_after),
      ]);

      rows.push([
        '',
        '',
        msCsvCell('TOTAL'),
        '',
        '',
        msMoney(d.net_change),
        '',
      ]);

      const csvContent = [
        headers.join(','),
        ...rows.map(r => r.join(','))
      ].join('\n');

      const blob = new Blob([csvContent], { type: 'text/csv;charset=utf-8;' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `statement_${monthLabel.replace(/\s+/g, '_')}.csv`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
      showToast('Exported', `CSV downloaded for ${monthLabel}.`, true);
    }

    function wireStatementControls(){
      if (!canBilling || !paneBilling) return;
      const prevBtn = $('#msPrev', paneBilling);
      const nextBtn = $('#msNext', paneBilling);
      const viewBtn = $('#msViewDetail', paneBilling);
      const exportBtn = $('#msExportCsv', paneBilling);
      if (prevBtn && !prevBtn.__wired){
        prevBtn.__wired = true;
        prevBtn.addEventListener('click', ()=>{
          msState.month--;
          if (msState.month < 1){ msState.month = 12; msState.year--; }
          msLoadMonth(msState.month, msState.year, false);
        });
      }
      if (nextBtn && !nextBtn.__wired){
        nextBtn.__wired = true;
        nextBtn.addEventListener('click', ()=>{
          if (msIsCurrentMonth(msState.month, msState.year)) return;
          msState.month++;
          if (msState.month > 12){ msState.month = 1; msState.year++; }
          if (msIsFutureMonth(msState.month, msState.year)){
            // snap back
            const now = new Date();
            msState.month = now.getMonth()+1;
            msState.year = now.getFullYear();
          }
          msLoadMonth(msState.month, msState.year, false);
        });
      }
      if (viewBtn && !viewBtn.__wired){
        viewBtn.__wired = true;
        viewBtn.addEventListener('click', ()=> msOpenDetailModal());
      }
      if (exportBtn && !exportBtn.__wired){
        exportBtn.__wired = true;
        exportBtn.addEventListener('click', ()=> msExportCsv());
      }
    }
    // =========================================================================
    //  RENDER BILLING (original + statement wiring)
    // =========================================================================
    function renderBilling(){
      if (!canBilling || !paneBilling) return;
      try { window.Portal?.credits?.refreshCredits?.(); } catch(e) {}
      if (!renderBilling._hist) {
        renderBilling._hist = {
          loading:false,
          loaded:false,
          lastLoadMs:0,
          events:[],
          ledger:[]
        };
      }
      const H = renderBilling._hist;
      // ---------- LEFT SIDE ----------
      const enabled = !!state.billing?.auto_topup?.enabled;
      const th = clampMoney(state.billing?.auto_topup?.threshold_dollars ?? BILL_MIN, BILL_MIN);
      const amt = clampMoney(state.billing?.auto_topup?.topup_dollars ?? BILL_MIN, BILL_MIN);
      const elToggle = $('#blEnableToggle', paneBilling);
      const elToggleText = $('#blEnableText', paneBilling);
      const elEnabledNote = $('#blEnabledNote', paneBilling);
      const elControls = $('#blControls', paneBilling);
      const elTh = $('#blThreshold', paneBilling);
      const elAmt = $('#blTopup', paneBilling);
      const elSubCopy = $('#blSubCopy', paneBilling);
      const elSummary = $('#blSummary', paneBilling);
      const btnThMinus = $('#blThMinus', paneBilling);
      const btnThPlus  = $('#blThPlus', paneBilling);
      const btnAmtMinus = $('#blAmtMinus', paneBilling);
      const btnAmtPlus  = $('#blAmtPlus', paneBilling);
      const blStatus = $('#blStatus', paneBilling);
      const blSave = $('#blSave', paneBilling);
      const blReload = $('#blReload', paneBilling);
      const blMinimumNote = $('#blMinimumNote', paneBilling);
      const stripe = state.billing?.stripe || {};
      const hasPM = !!stripe.has_payment_method;
      // Baseline snapshot (for "dirty" detection)
      if (!renderBilling._base) renderBilling._base = null;
      const baseNow = { enabled: !!enabled, th: th, amt: amt };
      if (!renderBilling._base || renderBilling._base._orgId !== state.id){
        renderBilling._base = { ...baseNow, _orgId: state.id };
      }
      function readUIValues(){
        const en = !!state.billing.auto_topup.enabled;
        const thNow = clampMoney(elTh?.value ?? state.billing.auto_topup.threshold_dollars, BILL_MIN);
        const amtNow = clampMoney(elAmt?.value ?? state.billing.auto_topup.topup_dollars, BILL_MIN);
        return { enabled: en, th: thNow, amt: amtNow };
      }
      function isDirty(){
        const b = renderBilling._base || baseNow;
        const v = readUIValues();
        return (v.enabled !== !!b.enabled) || (v.th !== b.th) || (v.amt !== b.amt);
      }
      function setMinimumMessage(text, isWarning){
        const nextText = text || `Minimum auto top-up values are $${BILL_MIN}.`;
        if (blMinimumNote) blMinimumNote.textContent = nextText;
        if (blStatus) blStatus.textContent = text || '';
        if (blStatus) blStatus.style.color = isWarning ? '#b26a00' : '';
      }
      function syncBillingCopy(){
        if (!elSubCopy) return;
        elSubCopy.textContent = hasPM
          ? 'Use the card on file to keep your account funded automatically.'
          : 'Use the card you add to keep your account funded automatically.';
      }
      function syncSummary(){
        if (!elSummary) return;
        const thNow = clampMoney(elTh?.value ?? state.billing.auto_topup.threshold_dollars, BILL_MIN);
        const amtNow = clampMoney(elAmt?.value ?? state.billing.auto_topup.topup_dollars, BILL_MIN);
        if (!state.billing.auto_topup.enabled) {
          elSummary.style.display = 'none';
          elSummary.textContent = '';
          return;
        }
        elSummary.style.display = '';
        elSummary.textContent = `If your balance falls below $${thNow}, we will automatically add $${amtNow} to your account.`;
      }
      // Payment method row behavior
      const cardNote = $('#blCardNote', paneBilling);
      const btnUpdateCard = $('#blUpdateCard', paneBilling);
      function findPaymentRow(){
        if (btnUpdateCard) return btnUpdateCard.closest('.bl-row');
        if (cardNote) return cardNote.closest('.bl-row');
        return null;
      }
      const paymentRow = findPaymentRow();
      if (hasPM){
        if (paymentRow) paymentRow.style.display = '';
        if (btnUpdateCard) btnUpdateCard.innerHTML = '<i class="fas fa-pen"></i> Update card';
        if (cardNote){
          if (stripe.last4){
            const exp = (stripe.exp_month && stripe.exp_year) ? ` - exp ${stripe.exp_month}/${String(stripe.exp_year).slice(-2)}` : '';
            const brand = stripe.brand ? String(stripe.brand) : 'Card';
            cardNote.textContent = `${brand} **** ${stripe.last4}${exp}`;
          } else {
            cardNote.textContent = 'Set';
          }
        }
        if (btnUpdateCard && !btnUpdateCard.__wired){
          btnUpdateCard.__wired = true;
          btnUpdateCard.addEventListener('click', async ()=>{
            if (blStatus) blStatus.textContent = 'Opening Stripe card setup...';
            const ret = await billingStartSetup();
            if (!ret.ok){
              if (blStatus) blStatus.textContent = '';
              showToast('Failed', ret.error || '-', false);
              return;
            }
            if (blStatus) blStatus.textContent = '';
            window.location.href = ret.url;
          });
        }
      } else {
        if (paymentRow) paymentRow.style.display = 'none';
        if (btnUpdateCard) btnUpdateCard.innerHTML = '<i class="fas fa-credit-card"></i> Add card';
      }
      syncBillingCopy();
      // Write clamped values to state + inputs
      state.billing.auto_topup.threshold_dollars = th;
      state.billing.auto_topup.topup_dollars = amt;
      if (elTh) elTh.value = String(th);
      if (elAmt) elAmt.value = String(amt);
      function ensureNoCardNote(){
        if (hasPM) {
          const old = $('#blNoCardNote', paneBilling);
          if (old) old.remove();
          return;
        }
        if (!elControls) return;
      }
      function ensureSavePlacement(){
        if (hasPM) {
          const row = $('#blSaveRow', paneBilling);
          if (row) row.remove();
          return;
        }
        if (!blSave || !elControls) return;
        let row = $('#blSaveRow', paneBilling);
        if (!row){
          row = document.createElement('div');
          row.id = 'blSaveRow';
          row.style.marginTop = '12px';
          row.style.display = 'flex';
          row.style.gap = '10px';
          row.style.flexWrap = 'wrap';
          row.style.alignItems = 'center';
          if (elControls.nextSibling) elControls.parentNode.insertBefore(row, elControls.nextSibling);
          else elControls.parentNode.appendChild(row);
        }
        if (blSave.parentNode !== row) row.appendChild(blSave);
      }
      function setEnabledUI(on){
        if (elToggle) elToggle.classList.toggle('on', !!on);
        if (elToggleText) elToggleText.textContent = on ? 'Enabled' : 'Disabled';
        if (elEnabledNote) elEnabledNote.textContent = on ? 'On' : 'Off';
        if (elControls) elControls.classList.toggle('bl-disabled', !on);
        const thVal = clampMoney(elTh?.value ?? th, BILL_MIN);
        const amtVal = clampMoney(elAmt?.value ?? amt, BILL_MIN);
        if (btnThMinus) btnThMinus.disabled = (!on) || (thVal <= BILL_MIN);
        if (btnAmtMinus) btnAmtMinus.disabled = (!on) || (amtVal <= BILL_MIN);
        if (btnThPlus) btnThPlus.disabled = !on;
        if (btnAmtPlus) btnAmtPlus.disabled = !on;
        if (elTh) elTh.disabled = !on;
        if (elAmt) elAmt.disabled = !on;
        syncSummary();
      }
      function updatePrimaryCta(){
        if (!blSave) return;
        if (hasPM){
          blSave.innerHTML = `<i class="fas fa-save"></i> Save`;
          blSave.dataset.mode = 'save_only';
          return;
        }
        const dirty = isDirty();
        blSave.innerHTML = dirty
          ? `<i class="fas fa-save"></i> Save and Add Card`
          : `<i class="fas fa-credit-card"></i> Add Card`;
        blSave.dataset.mode = dirty ? 'save_then_card' : 'card_only';
      }
      // Initial UI
      setEnabledUI(enabled);
      ensureNoCardNote();
      ensureSavePlacement();
      updatePrimaryCta();
      setMinimumMessage('', false);
      syncSummary();
      // Toggle wiring
      if (elToggle && !elToggle.__wired){
        elToggle.__wired = true;
        elToggle.addEventListener('click', ()=>{
          state.billing.auto_topup.enabled = !state.billing.auto_topup.enabled;
          setEnabledUI(state.billing.auto_topup.enabled);
          ensureNoCardNote();
          updatePrimaryCta();
        });
      }
      function wireMoneyInput(inputEl, path){
        if (!inputEl || inputEl.__wired) return;
        inputEl.__wired = true;
        inputEl.addEventListener('input', ()=>{
          inputEl.value = String(inputEl.value || '').replace(/[^\d]/g,'').slice(0, 6);
          const raw = safeInt(inputEl.value, 0);
          const n = safeInt(inputEl.value, BILL_MIN);
          const v = Math.max(BILL_MIN, n || BILL_MIN);
          if (path === 'threshold') state.billing.auto_topup.threshold_dollars = v;
          if (path === 'topup') state.billing.auto_topup.topup_dollars = v;
          if (raw > 0 && raw < BILL_MIN) setMinimumMessage(`Minimum auto top-up values are $${BILL_MIN}.`, true);
          else setMinimumMessage('', false);
          setEnabledUI(!!state.billing.auto_topup.enabled);
          syncSummary();
          updatePrimaryCta();
        });
        inputEl.addEventListener('blur', ()=>{
          const before = safeInt(inputEl.value, 0);
          const v = clampMoney(inputEl.value, BILL_MIN);
          inputEl.value = String(v);
          if (path === 'threshold') state.billing.auto_topup.threshold_dollars = v;
          if (path === 'topup') state.billing.auto_topup.topup_dollars = v;
          if (before > 0 && before < BILL_MIN) setMinimumMessage(`We updated that value to the $${BILL_MIN} minimum.`, true);
          else setMinimumMessage('', false);
          setEnabledUI(!!state.billing.auto_topup.enabled);
          syncSummary();
          updatePrimaryCta();
        });
      }
      wireMoneyInput(elTh, 'threshold');
      wireMoneyInput(elAmt, 'topup');
      function stepAdjust(inputEl, delta){
        const cur = clampMoney(inputEl?.value ?? BILL_MIN, BILL_MIN);
        const next = Math.max(BILL_MIN, cur + delta);
        if (inputEl) inputEl.value = String(next);
        if (inputEl === elTh) state.billing.auto_topup.threshold_dollars = next;
        if (inputEl === elAmt) state.billing.auto_topup.topup_dollars = next;
        setMinimumMessage('', false);
        setEnabledUI(!!state.billing.auto_topup.enabled);
        syncSummary();
        updatePrimaryCta();
      }
      if (btnThMinus && !btnThMinus.__wired){
        btnThMinus.__wired = true;
        btnThMinus.addEventListener('click', ()=>stepAdjust(elTh, -BILL_STEP));
      }
      if (btnThPlus && !btnThPlus.__wired){
        btnThPlus.__wired = true;
        btnThPlus.addEventListener('click', ()=>stepAdjust(elTh, +BILL_STEP));
      }
      if (btnAmtMinus && !btnAmtMinus.__wired){
        btnAmtMinus.__wired = true;
        btnAmtMinus.addEventListener('click', ()=>stepAdjust(elAmt, -BILL_STEP));
      }
      if (btnAmtPlus && !btnAmtPlus.__wired){
        btnAmtPlus.__wired = true;
        btnAmtPlus.addEventListener('click', ()=>stepAdjust(elAmt, +BILL_STEP));
      }
      // Save / Add Card behavior
      if (blSave && !blSave.__wired){
        blSave.__wired = true;
        blSave.addEventListener('click', async ()=>{
          const mode = blSave.dataset.mode || (hasPM ? 'save_only' : 'save_then_card');
          const v = readUIValues();
          const dirty = isDirty();
          if (hasPM){
            if (blStatus) blStatus.textContent = 'Saving...';
            const ret = await billingSaveAutoTopup({
              enabled: v.enabled,
              threshold_dollars: v.th,
              topup_dollars: v.amt
            });
            if (!ret.ok){
              if (blStatus) blStatus.textContent = '';
              showToast('Save failed', ret.error || '-', false);
              return;
            }
            renderBilling._base = { enabled: v.enabled, th: v.th, amt: v.amt, _orgId: state.id };
            state.billing.auto_topup.enabled = v.enabled;
            state.billing.auto_topup.threshold_dollars = v.th;
            state.billing.auto_topup.topup_dollars = v.amt;
            setMinimumMessage('', false);
            showToast('Saved', 'Auto top-up settings updated.', true);
            H.loaded = false; H.lastLoadMs = 0;
            void loadHistory(true);
            updatePrimaryCta();
            return;
          }
          blSave.disabled = true;
          try{
            if (dirty){
              if (blStatus) blStatus.textContent = 'Saving...';
              const ret = await billingSaveAutoTopup({
                enabled: v.enabled,
                threshold_dollars: v.th,
                topup_dollars: v.amt
              });
                if (!ret.ok){
                if (blStatus) blStatus.textContent = '';
                showToast('Save failed', ret.error || '-', false);
                return;
              }
              renderBilling._base = { enabled: v.enabled, th: v.th, amt: v.amt, _orgId: state.id };
              state.billing.auto_topup.enabled = v.enabled;
              state.billing.auto_topup.threshold_dollars = v.th;
              state.billing.auto_topup.topup_dollars = v.amt;
              setMinimumMessage('', false);
              showToast('Saved', 'Settings saved. Add a card to use auto top-up.', true);
            }
            if (blStatus) blStatus.textContent = 'Opening Stripe card setup...';
            const start = await billingStartSetup();
            if (!start.ok){
              if (blStatus) blStatus.textContent = '';
              showToast('Failed', start.error || 'Could not start card setup', false);
              return;
            }
            if (blStatus) blStatus.textContent = '';
            window.location.href = start.url;
          } finally {
            blSave.disabled = false;
            updatePrimaryCta();
          }
        });
      }
      // Reload
      if (blReload && !blReload.__wired){
        blReload.__wired = true;
        blReload.addEventListener('click', async ()=>{
          if (blStatus) blStatus.textContent = 'Reloading...';
          const o = await fetchOrg();
          if (!o){
            if (blStatus) blStatus.textContent = '';
            showToast('Reload failed', 'Could not fetch billing settings.', false);
            return;
          }
          state = o;
          const en = !!state.billing?.auto_topup?.enabled;
          const tth = clampMoney(state.billing?.auto_topup?.threshold_dollars ?? BILL_MIN, BILL_MIN);
          const taa = clampMoney(state.billing?.auto_topup?.topup_dollars ?? BILL_MIN, BILL_MIN);
          renderBilling._base = { enabled: en, th: tth, amt: taa, _orgId: state.id };
          if (blStatus) blStatus.textContent = '';
          showToast('Reloaded', 'Billing settings refreshed.', true);
          H.loaded = false; H.lastLoadMs = 0;
          void loadHistory(true);
          // Invalidate statement cache for current month and reload
          const curKey = msCacheKey(msState.month, msState.year);
          delete msState.cache[curKey];
          void msLoadMonth(msState.month, msState.year, true);
          renderBilling();
        });
      }
      // ---------- RIGHT SIDE: Billing History ----------
      const bhList = $('#bhList', paneBilling);
      const bhStatus = $('#bhStatus', paneBilling);
      const bhReload = $('#bhReload', paneBilling);
      if (!renderBilling.__css_patched){
        renderBilling.__css_patched = true;
        const style = document.createElement('style');
        style.textContent = `
          .bh-head{ grid-template-columns: 86px 1fr minmax(0, max-content) !important; }
          .bh-row{ grid-template-columns: 86px 1fr minmax(0, max-content) !important; }
          .bh-balance{ display:none !important; }
          @media (max-width: 820px){
            .bh-head{ display:none !important; }
            .bh-row{ grid-template-columns:minmax(58px,.7fr) minmax(0,1.5fr) minmax(68px,.8fr) !important; }
            .bh-balance{ display:none !important; }
          }
        `;
        document.head.appendChild(style);
      }
      function fmtDateParts(tsUtc){
        const d = new Date(tsUtc);
        if (!isFinite(d.getTime())) return { d:'', t:'' };
        const date = d.toLocaleDateString(undefined, { month:'short', day:'numeric' });
        const time = d.toLocaleTimeString(undefined, { hour:'numeric', minute:'2-digit' });
        return { d: date, t: time };
      }
      function nInt(v){
        const x = parseInt(String(v ?? '').replace(/[^\d\-]/g,''), 10);
        return Number.isFinite(x) ? x : null;
      }
      function normalizeReason(r){
        return String(r || '').toLowerCase().trim();
      }
      function pickByEmail(meta){
        if (!meta || typeof meta !== 'object') return '';
        return String(meta.by || meta.updated_by || meta.by_email || '').trim();
      }
      function isTransactionEvent(type){
        const t = normalizeReason(type);
        if (!t) return false;
        if (t === 'autotopup_success') return true;
        if (t === 'autotopup_payment_intent_failed') return true;
        return false;
      }
      function friendlyEvent(ev){
        const t = normalizeReason(ev?.type);
        const data = (ev?.data && typeof ev.data === 'object') ? ev.data : {};
        const by = pickByEmail(data);
        if (t === 'autotopup_payment_intent_failed'){
          return {
            kind: 'event',
            ts: ev.ts_utc,
            title: 'Auto top-up failed',
            sub: by ? `Triggered by ${by}` : 'Payment could not be processed',
            amountTxt: ''
          };
        }
        if (t === 'autotopup_success'){
          const topup = msMoney(data.topup_dollars);
          return {
            kind: 'event',
            ts: ev.ts_utc,
            title: 'Auto top-up completed',
            sub: by ? `Triggered by ${by}` : 'Payment processed',
            amountTxt: (topup > 0 ? `+$${msMoneyText(topup)}` : '')
          };
        }
        return null;
      }
      function friendlyLedger(row){
        const ts = row?.ts || null;
        const r = normalizeReason(row?.reason);
        const delta = msMoney(row?.delta);
        const meta = (row?.meta && typeof row.meta === 'object') ? row.meta : {};
        if (!ts || !Number.isFinite(delta) || !r) return null;
        const isPayment =
          r.indexOf('stripe_checkout_paid') === 0 ||
          r.indexOf('stripe_checkout_paid_return') === 0 ||
          r.indexOf('stripe_auto_topup') === 0 ||
          r.indexOf('stripe') === 0;
        const isPromo = (r === 'coupon_redeem');
        const isCancellationRefund = (r === 'cancellation_refund');
        const isExpeditePromiseRefund = (r === 'firstmeasure_expedite_missed_promise_refund');
        const isOrder = (r === 'order_submitted');
        const isAdditionalStructure = msIsAdditionalStructureLedger(row);
        if (!isPayment && !isPromo && !isCancellationRefund && !isOrder && !isAdditionalStructure && delta === 0) return null;
        let title = 'Payment';
        let sub = '';
        if (isOrder){
          title = 'Report ordered';
          const address = String(meta.address || '').trim();
          const projectType = String(meta.project_type || '').trim();
          const reportMode = String(meta.report_mode || '').trim();
          const by = String(row?.applied_for_user_email || row?.by_email || '').trim();
          if (address) sub = address;
          if (projectType) sub = sub ? `${sub} - ${projectType}` : projectType;
          if (reportMode) sub = sub ? `${sub} - ${reportMode}` : reportMode;
          if (by) sub = sub ? `${sub} - Ordered by ${by}` : `Ordered by ${by}`;
        } else if (isPayment){
          title = 'Payment received';
          const cents = nInt(row?.amount_total);
          if (cents != null && cents > 0) sub = `Charged $${msMoneyText(cents / 100)}`;
          const sid = row?.session_id ? String(row.session_id) : '';
          if (sid) sub = sub ? `${sub} - Ref ${sid.slice(-8)}` : `Ref ${sid.slice(-8)}`;
          const by = row?.by_email ? String(row.by_email) : '';
          if (by) sub = sub ? `${sub} - Triggered by ${by}` : `Triggered by ${by}`;
        } else if (isPromo){
          title = 'Promo credit applied';
          sub = 'Coupon credit added';
        } else if (isCancellationRefund){
          title = 'Cancellation refund';
          const address = String(meta.address || '').trim();
          const by = String(meta.cancelled_by_name || meta.cancelled_by_email || row?.by_email || '').trim();
          if (address) sub = address;
          if (by) sub = sub ? `${sub} - Handled by ${by}` : `Handled by ${by}`;
        } else if (isExpeditePromiseRefund){
          title = 'Expedite refund';
          const address = String(meta.address || '').trim();
          const due = String(meta.due_at || '').trim();
          if (address) sub = address;
          if (due) sub = sub ? `${sub} - Missed promised delivery window` : 'Missed promised delivery window';
        } else if (isAdditionalStructure){
          title = msLedgerTitle(row);
          sub = msLedgerSub(row);
        } else {
          title = msLedgerTitle(row);
          sub = msLedgerSub(row);
        }
        const amountTxt = msLedgerAmountText(row);
        return {
          kind: 'ledger',
          ts,
          title,
          sub,
          amountTxt,
          _delta: delta,
          _reason: msLedgerReasonLabel(row)
        };
      }
      function renderHistory(){
        if (!bhList) return;
        const items = [];
        const eventItems = [];
        for (const e of (Array.isArray(H.events) ? H.events : [])){
          if (!isTransactionEvent(e?.type)) continue;
          const it = friendlyEvent(e);
          if (!it) continue;
          eventItems.push({ ...it, _evType: normalizeReason(e?.type) });
        }
        const ledgerItems = [];
        for (const l of (Array.isArray(H.ledger) ? H.ledger : [])){
          const it = friendlyLedger(l);
          if (!it) continue;
          ledgerItems.push(it);
        }
        const parseTs = (s)=> (Date.parse(s || '') || 0);
        const ledgerUsed = new Set();
        const autoEvents = eventItems.filter(e => e._evType === 'autotopup_success');
        for (const ev of autoEvents){
          const evT = parseTs(ev.ts);
          let bestIdx = -1;
          let bestDist = Infinity;
          for (let i=0; i<ledgerItems.length; i++){
            if (ledgerUsed.has(i)) continue;
            const li = ledgerItems[i];
            if (li._reason !== 'stripe_auto_topup') continue;
            const lt = parseTs(li.ts);
            const dist = Math.abs(lt - evT);
            if (dist > 90*1000) continue;
            if (dist < bestDist){
              bestDist = dist;
              bestIdx = i;
            }
          }
          if (bestIdx >= 0){
            const li = ledgerItems[bestIdx];
            ledgerUsed.add(bestIdx);
            const extra = (li.sub || '').trim();
            if (extra){
              if (!ev.sub) ev.sub = extra;
              else if (ev.sub.indexOf(extra) === -1) ev.sub = ev.sub + ' - ' + extra;
            }
          }
        }
        items.push(...eventItems);
        ledgerItems.forEach((li, idx)=>{
          if (ledgerUsed.has(idx)) return;
          items.push(li);
        });
        items.sort((a,b)=> (parseTs(b.ts) - parseTs(a.ts)));
        const top = items.slice(0, 200);
        if (!top.length){
          bhList.innerHTML = `<div class="bh-empty">No billing transactions yet.</div>`;
          return;
        }
        const head = `
          <div class="bh-head">
            <div>When</div>
            <div>What happened</div>
            <div style="text-align:right;">Amount</div>
          </div>
        `;
        const rows = top.map(it=>{
          const { d, t } = fmtDateParts(it.ts);
          const amt = it.amountTxt || '-';
          const isNeg = amt.startsWith('-');
          const isPos = amt.startsWith('+');
          return `
            <div class="bh-row">
              <div class="bh-left">
                <div class="bh-date">${escapeHtml(d)}</div>
                <div class="bh-time">${escapeHtml(t)}</div>
              </div>
              <div class="bh-mid">
                <div class="bh-title">${escapeHtml(it.title || 'Update')}</div>
                ${it.sub ? `<div class="bh-subline">${escapeHtml(it.sub)}</div>` : ``}
              </div>
              <div class="bh-delta ${isNeg ? 'neg' : (isPos ? 'pos' : '')}">${escapeHtml(amt)}</div>
            </div>
          `;
        }).join('');
        bhList.innerHTML = head + rows;
      }
      async function loadHistory(force){
        if (!bhList) return;
        const now = Date.now();
        const stale = (now - (H.lastLoadMs || 0)) > 30_000;
        if (!force && H.loaded && !stale){
          renderHistory();
          return;
        }
        if (H.loading) return;
        H.loading = true;
        if (bhStatus) bhStatus.textContent = '';
        bhList.innerHTML = `<div class="bh-empty">Loading...</div>`;
        const ret = await billingFetchHistory(200);
        H.loading = false;
        if (!ret.ok){
          H.loaded = false;
          bhList.innerHTML = `<div class="bh-empty">Could not load billing history.</div>`;
          return;
        }
        H.events = ret.events || [];
        H.ledger = ret.ledger || [];
        H.loaded = true;
        H.lastLoadMs = Date.now();
        renderHistory();
      }
      if (bhReload && !bhReload.__wired){
        bhReload.__wired = true;
        bhReload.addEventListener('click', ()=>loadHistory(true));
      }
      void loadHistory(false);
      // ---------- MONTHLY STATEMENT wiring ----------
      wireStatementControls();
      void msLoadMonth(msState.month, msState.year, false);
    }
    // **** Company bindings ----
    if (canCompany) {
      const csName = $('#csName', paneCompany);
      const csPrimary = $('#csPrimary', paneCompany);
      const csSecondary = $('#csSecondary', paneCompany);
      const csPrimaryHex = $('#csPrimaryHex', paneCompany);
      const csSecondaryHex = $('#csSecondaryHex', paneCompany);
      const csPrimaryChip = $('#csPrimaryChip', paneCompany);
      const csSecondaryChip = $('#csSecondaryChip', paneCompany);
      const csSampleDiagram = $('#csSampleDiagram', paneCompany);
      const csLogoFile = $('#csLogoFile', paneCompany);
      const csStatus = $('#csStatus', paneCompany);
      const csCompanyEmail = $('#csCompanyEmail', paneCompany);
      const csCompanyPhone = $('#csCompanyPhone', paneCompany);
      const csCompanyAddress = $('#csCompanyAddress', paneCompany);
      if(csSampleDiagram) setImgSmart(csSampleDiagram, SAMPLE_DIAGRAM, { forceBust:false });
      function wireHexChip(chip, input){
        if (!chip || !input) return;
        chip.addEventListener('click', (e)=>{
          if (e.target === input) return;
          input.focus();
          input.select();
        });
      }
      wireHexChip(csPrimaryChip, csPrimaryHex);
      wireHexChip(csSecondaryChip, csSecondaryHex);
      if(csName) csName.addEventListener('input', ()=>{
        state.name = csName.value;
        persistTheme();
      });
      if (csCompanyEmail) csCompanyEmail.addEventListener('input', ()=>{
        state.company_email = String(csCompanyEmail.value || '').trim();
      });
      if (csCompanyPhone) {
        csCompanyPhone.addEventListener('input', ()=>{
          const formatted = formatPhoneUS(csCompanyPhone.value);
          csCompanyPhone.value = formatted;
          state.company_phone = formatted;
        });
      }
      if (csCompanyAddress) csCompanyAddress.addEventListener('input', ()=>{
        state.company_address = String(csCompanyAddress.value || '').trim();
      });
      function setPickersFromHexInputs(){
        const p = ('#' + String(csPrimaryHex.value||'').toUpperCase().replace(/[^0-9A-F]/g,'').slice(0,6));
        const s = ('#' + String(csSecondaryHex.value||'').toUpperCase().replace(/[^0-9A-F]/g,'').slice(0,6));
        if (/^#[0-9A-F]{6}$/.test(p)) csPrimary.value = p;
        if (/^#[0-9A-F]{6}$/.test(s)) csSecondary.value = s;
      }
      function onHexTyping(which){
        const el = which === 'p' ? csPrimaryHex : csSecondaryHex;
        el.value = String(el.value||'').toUpperCase().replace(/[^0-9A-F]/g,'').slice(0,6);
        setPickersFromHexInputs();
        if (el.value.length === 6){
          if (which === 'p') state.primary = csPrimary.value;
          else state.secondary = csSecondary.value;
          applyCssVars(state.primary, state.secondary);
          persistTheme();
        }
      }
      if(csPrimary) csPrimary.addEventListener('input', ()=>{
        csPrimaryHex.value = clampHex(csPrimary.value, DEFAULT_PRIMARY).slice(1);
        state.primary = csPrimary.value;
        applyCssVars(state.primary, state.secondary);
        persistTheme();
      });
      if(csSecondary) csSecondary.addEventListener('input', ()=>{
        csSecondaryHex.value = clampHex(csSecondary.value, DEFAULT_SECONDARY).slice(1);
        state.secondary = csSecondary.value;
        applyCssVars(state.primary, state.secondary);
        persistTheme();
      });
      if(csPrimaryHex) csPrimaryHex.addEventListener('input', ()=>onHexTyping('p'));
      if(csSecondaryHex) csSecondaryHex.addEventListener('input', ()=>onHexTyping('s'));
      $('#csRefresh', paneCompany).addEventListener('click', async ()=>{
        csStatus.textContent = 'Reloading...';
        const o = await fetchOrg();
        if (!o){
          csStatus.textContent = '';
          showToast('Reload failed', 'Could not fetch company settings.', false);
          return;
        }
        state = o;
        csStatus.textContent = '';
        lastSidebarLogoKey = null;
        lastPreviewLogoKey = null;
        renderCompany({ writeInputs:true, forceLogo:true });
        showToast('Reloaded', 'Company settings refreshed.', true);
      });
      $('#csSave', paneCompany).addEventListener('click', async ()=>{
        csStatus.textContent = 'Saving...';
        const toSaveName = String(csName.value || '').trim();
        state.primary = csPrimary.value;
        state.secondary = csSecondary.value;
        state.company_email = String(csCompanyEmail?.value || '').trim();
        state.company_phone = String(csCompanyPhone?.value || '').trim();
        state.company_address = String(csCompanyAddress?.value || '').trim();
        const ret = await saveOrg({
          name: toSaveName,
          primary: state.primary,
          secondary: state.secondary,
          company_email: state.company_email,
          company_phone: state.company_phone,
          company_address: state.company_address
        });
        if (!ret.ok){
          csStatus.textContent = '';
          showToast('Save failed', ret.error || '-', false);
          return;
        }
        state.name = toSaveName;
        csName.value = state.name;
        csStatus.textContent = '';
        renderCompany({ writeInputs:true, forceLogo:false });
        showToast('Saved', 'Company updated.', true);
      });
      if(csLogoFile) csLogoFile.addEventListener('change', async ()=>{
        const f = csLogoFile.files && csLogoFile.files[0];
        if (!f) return;
        try{
          const url = URL.createObjectURL(f);
          lastPreviewLogoKey = null;
          setImgSmart($('#csPrevLogoImg', paneCompany), url, { forceBust:false });
        }catch(e){}
        csStatus.textContent = 'Uploading logo...';
        const up = await uploadLogo(f);
        if (!up.ok){
          csStatus.textContent = '';
          showToast('Logo upload failed', up.error || '-', false);
          return;
        }
        state.logo = up.logo || null;
        csStatus.textContent = '';
        lastSidebarLogoKey = null;
        lastPreviewLogoKey = null;
        renderCompany({ writeInputs:false, forceLogo:true });
        showToast('Logo updated', 'Saved to your company profile.', true);
      });
    }
    // **** Users UI ----
    const cuMsg = $('#cuMsg', paneUsers);
    const cuBody = $('#cuBody', paneUsers);
    function getUsersMsgEl(){ return paneUsers ? $('#cuMsg', paneUsers) : null; }
    function getUsersBodyEl(){ return paneUsers ? $('#cuBody', paneUsers) : null; }
    function modal({ title, subtitle, bodyHtml, onClose }){
      const back = document.createElement('div');
      back.className = 'cu-modalBack';
      back.innerHTML = `
        <div class="cu-modal" role="dialog" aria-modal="true">
          <div class="cu-mh">
            <div>
              <div class="cu-mt">${escapeHtml(title || 'Modal')}</div>
              ${subtitle ? `<div class="cu-msub">${escapeHtml(subtitle)}</div>` : ''}
            </div>
            <button class="cu-mx" type="button"><i class="fas fa-xmark"></i></button>
          </div>
          <div class="cu-mb">${bodyHtml || ''}</div>
        </div>
      `;
      const close = ()=>{
        back.remove();
        if (typeof onClose === 'function') onClose();
      };
      let downOnBackdrop = false;
      back.addEventListener('mousedown', (e)=>{ downOnBackdrop = (e.target === back); });
      back.addEventListener('mouseup', (e)=>{ if (downOnBackdrop && e.target === back) close(); downOnBackdrop = false; });
      back.querySelector('.cu-mx').addEventListener('click', close);
      document.body.appendChild(back);
      return { el: back, close };
    }
    function computeSuperAdmins(users){
      const supers = [];
      for (const u of (users || [])){
        if (u?.deleted) continue;
        if (normLevel(u) === 'super_admin') supers.push(normEmail(u));
      }
      return supers;
    }
    function guardInfoForUser(u, superAdmins){
      const email = normEmail(u);
      const lvl = normLevel(u);
      const isMe = (ME_EMAIL && email === ME_EMAIL);
      const isSuper = (lvl === 'super_admin');
      const superCount = (superAdmins || []).length;
      const isLastSuper = isSuper && superCount === 1;
      return { isMe, isSuper, isLastSuper, superCount };
    }
    function pickStatus(u){
      if (u?.deleted)  return { t:'Deleted',   cls:'off', ico:'fa-trash' };
      if (u?.disabled) return { t:'Suspended', cls:'off', ico:'fa-pause' };
      const rawStatus = String(u?.status || '').trim().toLowerCase();
      const neverSignedIn = u?.never_signed_in === true || (!u?.last_login_at && ['invited', 'pending'].includes(rawStatus));
      if (neverSignedIn) return { t:'Never signed in', cls:'never', ico:'fa-envelope-open-text' };
      if (rawStatus === 'invited' || rawStatus === 'pending') return { t:'Invited', cls:'never', ico:'fa-paper-plane' };
      return { t:'Active', cls:'active', ico:'fa-circle-check' };
    }
    function openEditUserModal(u){
      const isMe = normEmail(u) === ME_EMAIL;
      const isSuperAdmin = normLevel(u) === 'super_admin';
      const lockedEmailMsg = "Super admin emails can't be edited to avoid account lockouts.";
      const m = modal({
        title: 'Edit user',
        subtitle: isSuperAdmin
          ? 'You can rename this super admin, but the email is locked.'
          : (isMe ? 'Update your displayed name or sign-in email.' : 'Rename the user or change their email.'),
        bodyHtml: `
          <div class="cu-rows">
            <div class="cu-row">
              <div class="cu-lbl">Name</div>
              <input class="cs-in" id="cuEditName" placeholder="Jane Doe" autocomplete="off" value="${escapeHtml(String(u?.name || ''))}">
            </div>
            <div class="cu-row">
              <div class="cu-lbl">Email</div>
              <input class="cs-in" id="cuEditEmail" placeholder="jane.doe@company.com" autocomplete="off" inputmode="email" value="${escapeHtml(String(u?.email || ''))}" ${isSuperAdmin ? 'readonly aria-readonly="true"' : ''}>
              ${isSuperAdmin ? `<div class="cs-note" style="margin-top:2px;">${escapeHtml(lockedEmailMsg)}</div>` : ''}
            </div>
          </div>
          <div class="cs-note" id="cuEditStatus" style="margin-top:10px;"></div>
        `
      });
      const footer = document.createElement('div');
      footer.className = 'cu-mactions';
      footer.innerHTML = `
        <button class="cs-btn ghost" type="button"><i class="fas fa-xmark"></i> Cancel</button>
        <button class="cs-btn primary" type="button"><i class="fas fa-save"></i> Save changes</button>
      `;
      m.el.querySelector('.cu-modal').appendChild(footer);
      const elName = m.el.querySelector('#cuEditName');
      const elEmail = m.el.querySelector('#cuEditEmail');
      const elStatus = m.el.querySelector('#cuEditStatus');
      const [btnCancel, btnSave] = footer.querySelectorAll('button');
      btnCancel.addEventListener('click', ()=>m.close());
      btnSave.addEventListener('click', async ()=>{
        const name = String(elName?.value || '').trim();
        const email = String(elEmail?.value || '').trim().toLowerCase();
        if (isSuperAdmin && email !== String(u?.email || '').trim().toLowerCase()){
          showToast('Not allowed', lockedEmailMsg, false);
          return;
        }
        if (!email || !email.includes('@')){
          showToast('Missing email', 'Please enter a valid email.', false);
          return;
        }
        btnSave.disabled = true;
        elStatus.textContent = 'Saving changes...';
        const ret = await userUpdate({ userId: u.id, email, name });
        btnSave.disabled = false;
        elStatus.textContent = '';
        if (!ret.ok){
          showToast('Save failed', ret.error || '-', false);
          return;
        }
        m.close();
        if (ret.sessionUpdated || isMe){
          showToast('Saved', 'Your profile was updated. Reloading settings...', true);
          setTimeout(()=>window.location.reload(), 120);
          return;
        }
        showToast('Saved', 'User updated.', true);
        refreshUsers();
      });
    }
    function renderActionsMenuForUser(u, anchorBtn){
      if (!floatingMenu) return;
      closeFloatingMenu();
      const superAdmins = usersState.superAdmins || [];
      const { isMe, isSuper } = guardInfoForUser(u, superAdmins);
      const canEdit = canAddDelete && !u?.deleted;
      const canResend = canAddDelete && !u?.deleted && !u?.disabled && !!normEmail(u);
      const canSuspend = canAddDelete && !(isMe || isSuper);
      const canDelete  = canAddDelete && !(isMe || isSuper);
      const suspendLabel = u?.disabled ? 'Unsuspend' : 'Suspend';
      const suspendIcon  = u?.disabled ? 'fa-play' : 'fa-pause';
      floatingMenu.innerHTML = `
        <button class="cu-mi ${canEdit ? '' : 'disabled'}" type="button" data-act="edit" ${canEdit ? '' : 'disabled'}>
          <span>Edit</span>
          <i class="fas fa-pen"></i>
        </button>
        <button class="cu-mi ${canResend ? '' : 'disabled'}" type="button" data-act="resend" ${canResend ? '' : 'disabled'}>
          <span>Resend invite</span>
          <i class="fas fa-paper-plane"></i>
        </button>
        <button class="cu-mi ${canSuspend ? '' : 'disabled'}" type="button" data-act="suspend" ${canSuspend ? '' : 'disabled'}>
          <span>${escapeHtml(suspendLabel)}</span>
          <i class="fas ${suspendIcon}"></i>
        </button>
        <button class="cu-mi ${canDelete ? '' : 'disabled'}" type="button" data-act="delete" ${canDelete ? '' : 'disabled'}>
          <span>Delete</span>
          <i class="fas fa-trash"></i>
        </button>
      `;
      const rect = anchorBtn.getBoundingClientRect();
      const pad = 8;
      floatingMenu.style.display = 'block';
      floatingMenu.classList.add('open');
      let left = Math.round(rect.right - 200);
      let top = Math.round(rect.bottom + pad);
      const mrect = floatingMenu.getBoundingClientRect();
      left = Math.max(pad, Math.min(left, window.innerWidth - mrect.width - pad));
      if (top + mrect.height + pad > window.innerHeight) {
        top = Math.max(pad, Math.round(rect.top - mrect.height - pad));
      }
      floatingMenu.style.left = left + 'px';
      floatingMenu.style.top = top + 'px';
      usersState.openMenuUserId = String(u?.id || '');
      const btnEdit = floatingMenu.querySelector('[data-act="edit"]');
      const btnResend = floatingMenu.querySelector('[data-act="resend"]');
      const btnSuspend = floatingMenu.querySelector('[data-act="suspend"]');
      const btnDelete  = floatingMenu.querySelector('[data-act="delete"]');
      if (btnEdit){
        btnEdit.addEventListener('click', ()=>{
          closeFloatingMenu();
          if (!canEdit){
            showToast('Not allowed', 'Deleted users cannot be edited.', false);
            return;
          }
          openEditUserModal(u);
        });
      }
      if (btnResend){
        btnResend.addEventListener('click', async ()=>{
          closeFloatingMenu();
          if (!canResend){
            showToast('Not allowed', 'This user cannot receive an invite email.', false);
            return;
          }
          showToast('Sending invite', 'Sending activation email...', true);
          const ret = await userResendInvite({ userId: u.id });
          if (!ret.ok){
            if (ret.activate_url) {
              try{ navigator.clipboard.writeText(ret.activate_url); }catch(e){}
            }
            showToast('Invite failed', ret.error || 'Could not send invite email.', false);
            return;
          }
          showToast('Invite sent', 'Activation email sent.', true);
          refreshUsers();
        });
      }
      if (btnSuspend){
        btnSuspend.addEventListener('click', async ()=>{
          closeFloatingMenu();
          if (!canSuspend){
            showToast('Not allowed', isMe ? "You can't suspend yourself." : "You can't suspend a Super Admin.", false);
            return;
          }
          const wantDisabled = !u.disabled;
          const ret = await userSetDisabled({ userId: u.id, disabled: wantDisabled });
          if (!ret.ok){
            showToast('Update failed', ret.error || '-', false);
            return;
          }
          showToast('Updated', wantDisabled ? 'User suspended.' : 'User unsuspended.', true);
          refreshUsers();
        });
      }
      if (btnDelete){
        btnDelete.addEventListener('click', async ()=>{
          closeFloatingMenu();
          if (!canDelete){
            showToast('Not allowed', isMe ? "You can't delete yourself." : "You can't delete a Super Admin.", false);
            return;
          }
          const label = `${u.name || u.email || 'User'} (${u.email || ''})`;
          const m = modal({
            title: 'Soft delete user?',
            subtitle: 'They will be blocked from logging in, hidden from your Users list, and their email will become available again.',
            bodyHtml: `
              <div class="cs-note" style="margin-top:0;">This is a soft delete. The account is archived for audit, and the email can be reused for a future invite or signup.</div>
              <div class="cs-note" style="margin-top:10px;">${escapeHtml(label)}</div>
            `
          });
          const footer = document.createElement('div');
          footer.className = 'cu-mactions';
          footer.innerHTML = `
            <button class="cs-btn ghost" type="button"><i class="fas fa-xmark"></i> Cancel</button>
            <button class="cs-btn primary" type="button"><i class="fas fa-trash"></i> Delete</button>
          `;
          m.el.querySelector('.cu-modal').appendChild(footer);
          const [btnCancel, btnDo] = footer.querySelectorAll('button');
          btnCancel.addEventListener('click', ()=>m.close());
          btnDo.addEventListener('click', async ()=>{
            btnDo.disabled = true;
            const ret = await userSoftDelete({ userId: u.id });
            btnDo.disabled = false;
            if (!ret.ok){
              showToast('Delete failed', ret.error || '-', false);
              return;
            }
            m.close();
            showToast('Deleted', 'User soft-deleted and email released.', true);
            refreshUsers();
          });
        });
      }
    }
    function renderUsersTable(){
      const msgEl = getUsersMsgEl();
      const bodyEl = getUsersBodyEl();
      const users = [...(usersState.list || [])].sort((a, b) => {
        const aMe = normEmail(a) === ME_EMAIL ? 1 : 0;
        const bMe = normEmail(b) === ME_EMAIL ? 1 : 0;
        if (aMe !== bMe) return bMe - aMe;
        const aName = String(a?.name || a?.email || '').toLowerCase();
        const bName = String(b?.name || b?.email || '').toLowerCase();
        return aName.localeCompare(bName);
      });
      const superAdmins = usersState.superAdmins || [];
      if (msgEl) msgEl.textContent = users.length ? '' : 'No users found.';
      const rows = [];
      for (const u of users){
        const id = String(u.id || '');
        const name = String(u.name || u.email || id);
        const email = String(u.email || '');
        const lvl = normLevel(u) || 'viewer';
        const { isMe, isLastSuper } = guardInfoForUser(u, superAdmins);
        const st = pickStatus(u);
        const levelText = levelLabel(lvl);
        const isDeleted = !!u?.deleted;
        const lockLevel = isDeleted || isLastSuper || isMe || !canManagePerms;
        const effectiveItems = effectiveOrLocalPermsForUser(u, id);
        const roleButtonsHtml = renderRolePresetButtons(lvl, lockLevel);
        const ro = isDeleted || lockLevel || !canManagePerms;
        const permBtns = renderPermissionButtons(effectiveItems, ro);
        const canShowKebab = canAddDelete && !isDeleted;
        const avatarUrl = userAvatarUrl(u);
        const avatarInitial = userInitial(name, email);
        const canUploadAvatar = canAddDelete && !isDeleted;
        const avatarHtml = avatarUrl
          ? `<img src="${escapeHtml(avatarUrl)}" alt="${escapeHtml(name)}">`
          : `<span>${escapeHtml(avatarInitial)}</span>`;
        const avatarControl = canUploadAvatar
          ? `<button class="cu-userAvatar" type="button" data-act="avatar" data-user-id="${escapeHtml(id)}" data-fm-tooltip="Upload profile picture">${avatarHtml}<span class="cu-userAvatarEdit"><i class="fas fa-camera"></i></span></button><input class="cu-fileInput" type="file" accept="image/png,image/jpeg,image/webp,image/svg+xml" data-act="avatar-input" data-user-id="${escapeHtml(id)}">`
          : `<button class="cu-userAvatar cu-userAvatarStatic" type="button" data-act="open-user" data-user-id="${escapeHtml(id)}" data-fm-tooltip="Open profile">${avatarHtml}</button>`;
        rows.push(`
          <tr class="cu-trMain ${isMe ? 'me' : ''}" data-user-id="${escapeHtml(id)}" style="${isDeleted ? 'opacity:.55;' : ''}">
            <td class="cu-td">
              <div class="cu-userCell">
                ${avatarControl}
                <div class="cu-userText">
                  <button class="cu-userName cu-userOpen" type="button" data-act="open-user" data-user-id="${escapeHtml(id)}"><span>${escapeHtml(name)}</span></button>
                  <div class="cu-userEmail">${escapeHtml(email)}</div>
                </div>
                ${isMe ? `<span class="cu-tag you"><i class="fas fa-user"></i> You</span>` : ''}
              </div>
            </td>
            <td class="cu-td cu-centerCell">
              <span class="cu-pill level"><i class="fas fa-shield-halved"></i> ${escapeHtml(levelText)}</span>
            </td>
            <td class="cu-td cu-centerCell">
              <span class="cu-pill ${st.cls}"><i class="fas ${st.ico}"></i> ${escapeHtml(st.t)}</span>
            </td>
            <td class="cu-td cu-actionsCell">
              ${canShowKebab ? `<button class="cu-kebab" type="button" data-act="kebab" aria-label="Actions"><i class="fas fa-ellipsis-vertical"></i></button>` : ''}
            </td>
          </tr>
          <tr class="cu-trPerm ${isMe ? 'me' : ''}" data-user-id="${escapeHtml(id)}" data-deleted="${isDeleted ? '1' : '0'}" style="${isDeleted || !usersState.showPerms ? 'display:none;' : ''}">
            <td colspan="4" class="cu-permShell">
              <div class="cu-permWrap ${usersState.showPerms ? 'open' : ''}">
                <div class="cu-permInner">
                  <div class="cu-permTop">
                    <div class="cu-rolePresets" data-rolepresets>
                      ${roleButtonsHtml}
                    </div>
                    <div class="cu-permHint">
                      ${isMe ? 'You cannot edit your own permissions here.' : permissionHintText(lvl, canManagePerms)}
                    </div>
                  </div>
                  <div class="cu-permGrid">
                    <div class="cu-permLabel">Permissions</div>
                    ${permBtns}
                  </div>
                </div>
              </div>
            </td>
          </tr>
        `);
      }
      if (bodyEl) {
        bodyEl.innerHTML = rows.join('');
        wireUsersTableHandlers();
      }
    }
    function syncUsersPermissionsUi(){
      if (paneUsers) {
        const btnPerms = $('#cuPerms', paneUsers);
        if (btnPerms){
          btnPerms.classList.toggle('on', usersState.showPerms);
          btnPerms.setAttribute('aria-pressed', usersState.showPerms ? 'true' : 'false');
          btnPerms.innerHTML = `<i class="fas ${usersState.showPerms ? 'fa-toggle-on' : 'fa-toggle-off'}"></i> Show permissions`;
        }
      }
      const bodyEl = getUsersBodyEl();
      if (!bodyEl) return;
      bodyEl.querySelectorAll('tr.cu-trPerm').forEach(tr=>{
        const isDeleted = tr.getAttribute('data-deleted') === '1';
        tr.style.display = (usersState.showPerms && !isDeleted) ? '' : 'none';
      });
      bodyEl.querySelectorAll('.cu-permWrap').forEach(w=>{
        w.classList.toggle('open', usersState.showPerms);
      });
    }
    function setPermControlsDisabled(tr, disabled){
      if (!tr) return;
      tr.querySelectorAll('button[data-role], button[data-perm]').forEach(btn=>{
        btn.disabled = !!disabled;
      });
    }
    function wireUsersTableHandlers(){
      const bodyEl = getUsersBodyEl();
      if(!bodyEl) return;
      const superAdmins = usersState.superAdmins || [];
      bodyEl.querySelectorAll('tr.cu-trMain').forEach(tr=>{
        const userId = tr.getAttribute('data-user-id') || '';
        const u = usersState.list.find(x => String(x?.id || '') === String(userId));
        if (!u) return;
        const kebab = tr.querySelector('button[data-act="kebab"]');
        const avatarBtn = tr.querySelector('button[data-act="avatar"]');
        const avatarInput = tr.querySelector('input[data-act="avatar-input"]');
        tr.querySelectorAll('button[data-act="open-user"]').forEach((btn) => {
          btn.addEventListener('click', (e) => {
            e.preventDefault();
            e.stopPropagation();
            window.Portal?.PhotoFeed?.openUserModal?.({
              id: u.id || userId,
              name: u.name || u.email || userId,
              email: u.email || '',
              avatar: userAvatarUrl(u),
              raw: u
            }, []);
          });
        });
        if (kebab){
          kebab.addEventListener('click', (e)=>{
            e.preventDefault();
            e.stopPropagation();
            renderActionsMenuForUser(u, kebab);
          });
        }
        if (avatarBtn && avatarInput){
          avatarBtn.addEventListener('click', ()=>{
            avatarInput.value = '';
            avatarInput.click();
          });
          avatarInput.addEventListener('change', async ()=>{
            const file = avatarInput.files && avatarInput.files[0];
            if (!file) return;
            showToast('Uploading', 'Saving profile picture...', true);
            const ret = await uploadUserAvatar({ userId, file });
            avatarInput.value = '';
            if (!ret.ok){
              showToast('Upload failed', ret.error || 'Could not save profile picture.', false);
              return;
            }
            showToast('Updated', 'Profile picture saved.', true);
            refreshUsers();
          });
        }
      });
      if (canManagePerms) {
        bodyEl.querySelectorAll('tr.cu-trPerm').forEach(tr=>{
          const userId = tr.getAttribute('data-user-id') || '';
          const u = usersState.list.find(x => String(x?.id || '') === String(userId));
          if (!u) return;
          const roleBtns = Array.from(tr.querySelectorAll('button[data-role]'));
          const permBtns = Array.from(tr.querySelectorAll('button[data-perm]'));
          const { isLastSuper } = guardInfoForUser(u, superAdmins);
          let saveInFlight = false;
          roleBtns.forEach(btn=>{
            btn.addEventListener('click', async ()=>{
              if (saveInFlight) return;
              const uNow = usersState.list.find(x => String(x?.id || '') === String(userId));
              if (!uNow) return;
              const next = String(btn.getAttribute('data-role') || 'viewer').toLowerCase().trim();
              const current = normLevel(uNow) || 'viewer';
              if (next === current) return;
              if (isLastSuper && next !== 'super_admin'){
                showToast('Not allowed', 'You must keep at least one Super Admin.', false);
                return;
              }
              if (current === 'super_admin' && next !== 'super_admin' && (usersState.superAdmins || []).length <= 1){
                showToast('Not allowed', 'You must keep at least one Super Admin.', false);
                return;
              }

              let permItems;
              if (next === 'custom') {
                permItems = effectiveOrLocalPermsForUser(uNow, userId);
                usersState.itemsById[userId] = Object.assign({}, permItems);
              } else {
                permItems = clonedLevelPerms(next);
                usersState.itemsById[userId] = Object.assign({}, permItems);
              }

              saveInFlight = true;
              setPermControlsDisabled(tr, true);
              const changedSelf = normEmail(uNow) === ME_EMAIL;
              try{
                const ret = await userSetPerms({ userId, permLevel: next, permItems });
                if (!ret.ok){
                showToast('Update failed', ret.error || '-', false);
                  return;
                }
                if (changedSelf){
                  try{ await window.Portal?.credits?.refreshCredits?.(); }catch(e){}
                  showToast('Saved', 'Your permissions changed. Reloading settings...', true);
                  setTimeout(()=>window.location.reload(), 120);
                  return;
                }
                showToast('Saved', 'Permission level updated.', true);
                refreshUsers();
              }catch(err){
                showToast('Update failed', err?.message || 'Unexpected error.', false);
              }finally{
                saveInFlight = false;
                setPermControlsDisabled(tr, false);
              }
            });
          });
          permBtns.forEach(btn=>{
            btn.addEventListener('click', async ()=>{
              if (saveInFlight) return;
              const uNow = usersState.list.find(x => String(x?.id || '') === String(userId));
              if (!uNow) return;
              const levelNow = normLevel(uNow) || 'viewer';
              if (isLastSuper) return;
              const key = btn.getAttribute('data-perm');
              if (!key) return;

              // If not already custom, seed items from effective permissions and switch to custom
              let items;
              if (levelNow !== 'custom') {
                const eff = effectivePerms(uNow);
                items = {};
                for (const pm of PERM_META) {
                  items[pm.k] = !!(eff['*'] || eff[pm.k]);
                }
                usersState.itemsById[userId] = items;
              } else {
                items = Object.assign({}, usersState.itemsById[userId] || asBoolMap(uNow?.org_permissions?.items || {}));
              }

              // Toggle the clicked permission
              items[key] = !items[key];
              usersState.itemsById[userId] = items;
              btn.classList.toggle('on', !!items[key]);
              btn.classList.toggle('off', !items[key]);

              roleBtns.forEach(x => {
                x.classList.toggle('active', x.getAttribute('data-role') === 'custom');
              });

              const changedSelf = normEmail(uNow) === ME_EMAIL;
              saveInFlight = true;
              setPermControlsDisabled(tr, true);
              try{
                const ret = await userSetPerms({ userId, permLevel: 'custom', permItems: items });
              if (!ret.ok){
                items[key] = !items[key];
                usersState.itemsById[userId] = items;
                btn.classList.toggle('on', !!items[key]);
                btn.classList.toggle('off', !items[key]);
                showToast('Save failed', ret.error || '-', false);
                  return;
                }
                if (changedSelf){
                  try{ await window.Portal?.credits?.refreshCredits?.(); }catch(e){}
                  showToast('Saved', 'Your permissions changed. Reloading settings...', true);
                  setTimeout(()=>window.location.reload(), 120);
                  return;
                }
                showToast('Saved', 'Permissions updated.', true);
                refreshUsers();
              }catch(err){
                items[key] = !items[key];
                usersState.itemsById[userId] = items;
                btn.classList.toggle('on', !!items[key]);
                btn.classList.toggle('off', !items[key]);
                showToast('Save failed', err?.message || 'Unexpected error.', false);
              }finally{
                saveInFlight = false;
                setPermControlsDisabled(tr, false);
              }
            });
          });
        });
      }
    }
    async function refreshUsers(){
      if (!paneUsers) return;
      const requestSeq = ++usersRefreshSeq;
      closeFloatingMenu();
      const tableEl = paneUsers.querySelector('.cu-table');
      let prevH = 0;
      if (tableEl) {
        prevH = Math.round(tableEl.getBoundingClientRect().height || 0);
        if (prevH > 0) tableEl.style.minHeight = prevH + 'px';
        tableEl.style.transition = 'opacity .12s ease';
      }
      const r = await usersList();
      if (requestSeq !== usersRefreshSeq) return;
      if (!r.ok){
        const msgEl = getUsersMsgEl();
        usersState.list = [];
        usersState.itemsById = {};
        usersState.superAdmins = [];
        renderUsersTable();
        if (msgEl) msgEl.textContent = r.error ? `Could not load users: ${r.error}` : 'Could not load users.';
        if (tableEl) tableEl.style.opacity = '1';
        if (tableEl) tableEl.style.minHeight = '';
        showToast('Users unavailable', r.error || '-', false);
        return;
      }
      const list = (r.users || []);
      const itemsById = Object.assign({}, usersState.itemsById || {});
      for (const u of list){
        const id = String(u?.id || '');
        if (!id) continue;
        if (!itemsById[id]) itemsById[id] = asBoolMap(u?.org_permissions?.items || {});
      }
      usersState.list = list;
      usersState.itemsById = itemsById;
      usersState.superAdmins = computeSuperAdmins(list);
      try{
        renderUsersTable();
        syncUsersPermissionsUi();
      }catch(err){
        const msgEl = getUsersMsgEl();
        if (msgEl) msgEl.textContent = `Could not render users: ${err?.message || 'Unknown error'}`;
        if (tableEl) tableEl.style.opacity = '1';
        requestAnimationFrame(()=>{ if (tableEl) tableEl.style.minHeight = ''; });
        showToast('Users render failed', err?.message || 'Unknown error', false);
        return;
      }
      if (tableEl) tableEl.style.opacity = '1';
      requestAnimationFrame(()=>{ if (tableEl) tableEl.style.minHeight = ''; });
    }
    if(paneUsers) {
      const rBtn = $('#cuReload', paneUsers);
      if(rBtn) rBtn.addEventListener('click', refreshUsers);
      const pBtn = $('#cuPerms', paneUsers);
      if (pBtn) {
        pBtn.addEventListener('click', ()=>{
          usersState.showPerms = !usersState.showPerms;
          syncUsersPermissionsUi();
        });
      }
    }
    if (canUsers && canAddDelete && paneUsers) {
      const addBtn = $('#cuAdd', paneUsers);
      if(addBtn) {
        addBtn.addEventListener('click', ()=>{
          const inviteState = {
            level: 'viewer',
            perms: clonedLevelPerms('viewer')
          };
          const avatarState = {
            file: null,
            previewUrl: ''
          };
          const m = modal({
            title: 'Add user',
            subtitle: 'They will receive a welcome email with an activation link.',
            bodyHtml: `
              <div class="cu-rows">
                <div class="cu-newAvatarRow">
                  <div class="cu-newAvatarWrap">
                    <button class="cu-userAvatar" type="button" id="cuNewAvatarBtn" data-fm-tooltip="Choose profile picture">
                      <span id="cuNewAvatarInitial">?</span>
                      <span class="cu-userAvatarEdit"><i class="fas fa-camera"></i></span>
                    </button>
                    <input class="cu-fileInput" type="file" accept="image/png,image/jpeg,image/webp,image/svg+xml" id="cuNewAvatarFile">
                    <div class="cu-newAvatarNote">Optional profile picture</div>
                  </div>
                </div>
                <div class="cu-row">
                  <div class="cu-lbl">Name</div>
                  <input class="cs-in" id="cuNewName" placeholder="Jane Doe" autocomplete="off">
                </div>
                <div class="cu-row">
                  <div class="cu-lbl">Email</div>
                  <input class="cs-in" id="cuNewEmail" placeholder="jane.doe@company.com" autocomplete="off" inputmode="email">
                </div>
                <div class="cu-row">
                  <div class="cu-lbl">Permission level</div>
                  <div class="cu-rolePresets" id="cuNewRolePresets">
                    ${renderRolePresetButtons(inviteState.level, false)}
                  </div>
                  <div class="cu-permHint" id="cuNewPermHint">${permissionHintText(inviteState.level, true)}</div>
                  <div class="cu-permGrid" id="cuNewPermGrid">
                    <div class="cu-permLabel">Permissions</div>
                    ${renderPermissionButtons(effectivePermsForLevel(inviteState.level, inviteState.perms), false)}
                  </div>
                </div>
              </div>
              <div class="cs-note" id="cuNewStatus" style="margin-top:10px;"></div>
            `
          });
          const footer = document.createElement('div');
          footer.className = 'cu-mactions';
          footer.innerHTML = `
            <button class="cs-btn ghost" type="button"><i class="fas fa-xmark"></i> Cancel</button>
            <button class="cs-btn primary" type="button"><i class="fas fa-paper-plane"></i> Send invite</button>
          `;
          m.el.querySelector('.cu-modal').appendChild(footer);
          const elName = m.el.querySelector('#cuNewName');
          const elEmail = m.el.querySelector('#cuNewEmail');
          const elStatus = m.el.querySelector('#cuNewStatus');
          const elRolePresets = m.el.querySelector('#cuNewRolePresets');
          const elPermGrid = m.el.querySelector('#cuNewPermGrid');
          const elPermHint = m.el.querySelector('#cuNewPermHint');
          const elAvatarBtn = m.el.querySelector('#cuNewAvatarBtn');
          const elAvatarFile = m.el.querySelector('#cuNewAvatarFile');
          const elAvatarInitial = m.el.querySelector('#cuNewAvatarInitial');
          const [btnCancel, btnSend] = footer.querySelectorAll('button');
          function refreshInviteAvatarUi(){
            const fallback = userInitial(elName?.value || '', elEmail?.value || '');
            if (elAvatarInitial) elAvatarInitial.textContent = fallback;
            if (!elAvatarBtn) return;
            if (avatarState.previewUrl){
              elAvatarBtn.innerHTML = `<img src="${escapeHtml(avatarState.previewUrl)}" alt="Profile picture"><span class="cu-userAvatarEdit"><i class="fas fa-camera"></i></span>`;
            } else {
              elAvatarBtn.innerHTML = `<span id="cuNewAvatarInitial">${escapeHtml(fallback)}</span><span class="cu-userAvatarEdit"><i class="fas fa-camera"></i></span>`;
            }
          }
          function refreshInvitePermUi(){
            if (elRolePresets) elRolePresets.innerHTML = renderRolePresetButtons(inviteState.level, false);
            if (elPermHint) elPermHint.textContent = permissionHintText(inviteState.level, true);
            if (elPermGrid) {
              elPermGrid.innerHTML = `<div class="cu-permLabel">Permissions</div>${renderPermissionButtons(effectivePermsForLevel(inviteState.level, inviteState.perms), false)}`;
            }
            elRolePresets?.querySelectorAll('button[data-role]').forEach(btn=>{
              btn.addEventListener('click', ()=>{
                const next = String(btn.getAttribute('data-role') || 'viewer').toLowerCase().trim();
                inviteState.level = next;
                if (next !== 'custom') inviteState.perms = clonedLevelPerms(next);
                refreshInvitePermUi();
              });
            });
            elPermGrid?.querySelectorAll('button[data-perm]').forEach(btn=>{
              btn.addEventListener('click', ()=>{
                const key = String(btn.getAttribute('data-perm') || '').trim();
                if (!key) return;
                if (inviteState.level !== 'custom') {
                  inviteState.perms = effectivePermsForLevel(inviteState.level, inviteState.perms);
                  inviteState.level = 'custom';
                }
                inviteState.perms[key] = !inviteState.perms[key];
                refreshInvitePermUi();
              });
            });
          }
          elAvatarBtn?.addEventListener('click', ()=>{
            elAvatarFile.value = '';
            elAvatarFile.click();
          });
          elAvatarFile?.addEventListener('change', ()=>{
            const file = elAvatarFile.files && elAvatarFile.files[0];
            if (!file) return;
            if (avatarState.previewUrl && avatarState.previewUrl.startsWith('blob:')) {
              try{ URL.revokeObjectURL(avatarState.previewUrl); }catch(e){}
            }
            avatarState.file = file;
            avatarState.previewUrl = URL.createObjectURL(file);
            refreshInviteAvatarUi();
          });
          elName?.addEventListener('input', refreshInviteAvatarUi);
          elEmail?.addEventListener('input', refreshInviteAvatarUi);
          refreshInviteAvatarUi();
          refreshInvitePermUi();
          btnCancel.addEventListener('click', ()=>m.close());
          btnSend.addEventListener('click', async ()=>{
            const name = String(elName.value || '').trim();
            const email = String(elEmail.value || '').trim().toLowerCase();
            const level = String(inviteState.level || 'viewer').trim().toLowerCase();
            if (!email || !email.includes('@')){
              showToast('Missing email', 'Please enter a valid email.', false);
              return;
            }
            elStatus.textContent = 'Creating user + sending email...';
            btnSend.disabled = true;
            const ret = await userAdd({
              email,
              name,
              permLevel: level,
              permItems: level === 'custom' ? inviteState.perms : {}
            });
            btnSend.disabled = false;
            if (!ret.ok){
              elStatus.textContent = '';
              showToast('Invite failed', ret.error || '-', false);
              return;
            }
            if (avatarState.file && ret.user?.id){
              elStatus.textContent = 'Saving profile picture...';
              const avatarRet = await uploadUserAvatar({ userId: ret.user.id, file: avatarState.file });
              if (!avatarRet.ok){
                elStatus.textContent = '';
                showToast('User added', 'Invite sent, but the profile picture could not be saved.', true);
                m.close();
                refreshUsers();
                if (!ret.emailed && ret.activate_url){
                  try{ navigator.clipboard.writeText(ret.activate_url); }catch(e){}
                }
                return;
              }
            }
            elStatus.textContent = '';
            if (avatarState.previewUrl && avatarState.previewUrl.startsWith('blob:')) {
              try{ URL.revokeObjectURL(avatarState.previewUrl); }catch(e){}
            }
            m.close();
            const msg = ret.emailed ? 'Invite email sent.' : 'User created, but email failed to send.';
            showToast('User added', msg, true);
            refreshUsers();
            if (!ret.emailed && ret.activate_url){
              try{ navigator.clipboard.writeText(ret.activate_url); }catch(e){}
            }
          });
        });
      }
    }
    // **** Reports bindings ----
    if (canReports && paneReports) {
      const rpStatus = $('#rpStatus', paneReports);
      const rRes = $('#rpReset', paneReports);
      if(rRes) {
        rRes.addEventListener('click', ()=>{
          state.report_general = mergeGeneralReportSettings(null);
          state.report_customer = mergeCustomerReportSettings(null);
          renderReports();
          showToast('Reset', 'Report settings reset (not saved yet).', true);
        });
      }
      const rSav = $('#rpSave', paneReports);
      if(rSav) {
        rSav.addEventListener('click', async ()=>{
          rpStatus.textContent = 'Saving...';
          const ret = await saveReportSettings({ general: state.report_general, customer: state.report_customer });
          if (!ret.ok){
            rpStatus.textContent = '';
            showToast('Save failed', ret.error || '-', false);
            return;
          }
          rpStatus.textContent = '';
          showToast('Saved', 'Report defaults updated.', true);
          const o = await fetchOrg();
          if (o){
            state = o;
            renderCompany({ writeInputs:true, forceLogo:false });
            renderReports();
            if (canBilling) renderBilling();
          }
        });
      }
    }
    // **** Boot: cached -> server ----
    (async ()=>{
      const cached = readCachedTheme();
      const bootTheme = currentThemeSnapshot() || cached;
      if (bootTheme){
        // Preserve the organization name seeded from the authenticated session.
        // A cached/current theme can legitimately be named "Default Branch".
        state.logo = (bootTheme.logo ?? null);
        state.primary = (bootTheme.primary || bootTheme.accent || DEFAULT_PRIMARY);
        state.secondary = (bootTheme.secondary || DEFAULT_SECONDARY);
        renderCompany({ writeInputs:true, forceLogo:false });
      } else {
        renderCompany({ writeInputs:true, forceLogo:false, publish:false });
      }
      if (canCompany || canReports || canBilling) {
        try{
          const url = new URL(window.location.href);
          const sessionId = url.searchParams.get('session_id');
          const setup = url.searchParams.get('setup');
          if (setup === '1' && sessionId) {
            await postAction('billing_autotopup_setup_finish', { session_id: sessionId });
            url.searchParams.delete('setup');
            url.searchParams.delete('session_id');
            window.history.replaceState({}, '', url.toString());
          }
        }catch(e){}
        const o = await fetchOrg();
        if (o){
          state = o;
          renderCompany({ writeInputs:true, forceLogo:false });
        } else {
          state.report_general = mergeGeneralReportSettings(state.report_general);
          state.report_customer = mergeCustomerReportSettings(state.report_customer);
        }
      } else {
        state.report_general = mergeGeneralReportSettings(state.report_general);
        state.report_customer = mergeCustomerReportSettings(state.report_customer);
      }
      if (canReports) renderReports();
      if (canDocuments && activeTab === 'documents') renderDocumentSettings();
      if (canConfiguration && activeTab === 'configuration') renderConfiguration();
      if (canScheduling && activeTab === 'scheduling') renderSchedulingSettings();
      if (canCrews && activeTab === 'crews') renderCrewSettings();
      if (canCallWorkflows && activeTab === 'call_workflows') renderCallWorkflows();
      if (canStorage && activeTab === 'storage') renderStorage();
      if (canAppFlags && activeTab === 'app_flags') renderAppFlags();
      if (canPricebook && activeTab === 'pricebook') renderPricebook();
      if (canProposalSettings && activeTab === 'proposals') renderProposalSettings();
      if (canForms && activeTab === 'forms') renderForms();
      if (canBilling) renderBilling();
      if (canUsers && activeTab === 'users') refreshUsers();
    })();
  }
  // --- TAB REGISTRATION & VISIBILITY CONTROL ---
  function updateSidebarVisibility() {
    const canCompany = hasPerm('manage_company_settings');
    const canUsers   = hasPerm('manage_company_users') || hasPerm('manage_company_user_permissions');
    const canReports = hasPerm('manage_report_settings');
    const canBilling = hasPerm('manage_billing');
    const leadFlags = leadImportFlagState();
    const canForms = canCompany && (leadFlags.forms || leadFlags.email);
    const canPricebook = canCompany && appFlag('platform', 'pricebook');
    const canProposalSettings = canCompany && appFlag('platform', 'proposals');
    const canConfiguration = canCompany && appFlag('platform', 'configuration');
    const canScheduling = canCompany && appFlag('platform', 'scheduling');
    const canCrews = canCompany && appFlag('platform', 'crew_management');
    const canCallWorkflows = canCompany && appFlag('calls', 'app');
    const canStorage = canCompany && storageLimitsEnabled();
    const canAppFlags = canCompany && window.Portal?.appFlags?.current?.()?.test_admin === true;
    const any = canCompany || canUsers || canReports || canBilling || canForms || canPricebook || canProposalSettings || canConfiguration || canScheduling || canCrews || canCallWorkflows || canStorage || canAppFlags;
    const link = document.querySelector('.fm-link[data-tab="company_settings"]');
    if (link) link.style.display = any ? 'flex' : 'none';
  }
  window.Portal.apps.registerPortalApp({
    id: 'portal.company_settings',
    tabId: 'company_settings',
    title: 'Settings',
    icon: 'fa-gear',
    order: 900,
    placement: 'bottom',
    mount
  });
  window.addEventListener('fm:perms:updated', updateSidebarVisibility);
  window.addEventListener('fm:app-flags:updated', () => {
    updateSidebarVisibility();
    const panel = document.getElementById('tab_company_settings');
    if (panel?.classList.contains('active')) {
      delete panel.dataset.companySettingsMounted;
      mount(panel);
    }
  });
  window.addEventListener('fm:open-storage-settings', () => {
    viewState.activeTab = 'storage';
    window.Portal?.tabs?.activateTab?.('company_settings');
    setTimeout(() => document.getElementById('csTabStorage')?.click(), 60);
  });
  window.addEventListener('fm:open-call-workflow-settings', () => {
    viewState.activeTab = 'call_workflows';
    window.Portal?.tabs?.activateTab?.('company_settings');
    setTimeout(() => document.getElementById('csTabCallWorkflows')?.click(), 60);
  });
  window.addEventListener('fm:open-proposal-settings', () => {
    viewState.activeTab = 'proposals';
    window.Portal?.tabs?.activateTab?.('company_settings');
    setTimeout(() => document.getElementById('csTabProposals')?.click(), 60);
  });
  window.addEventListener('fm:open-crew-settings', () => {
    viewState.activeTab = 'crews';
    window.Portal?.tabs?.activateTab?.('company_settings');
    setTimeout(() => document.getElementById('csTabCrews')?.click(), 60);
  });
  window.addEventListener('fm:perms:updated', () => {
    const panel = document.getElementById('tab_company_settings');
    if (panel?.classList.contains('active')) {
      delete panel.dataset.companySettingsMounted;
      mount(panel);
    }
  });
  document.addEventListener('DOMContentLoaded', () => setTimeout(updateSidebarVisibility, 50));
})();
