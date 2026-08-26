(function(){
  const cfg = () => window.Portal?.cfg || window.PORTAL_CFG || {};
  if (!window.Portal) return;

  const state = {
    initialized: false,
    loading: false,
    saving: false,
    error: '',
    activeTab: 'sms',
    settings: {
      sms_templates: [],
      email_templates: [],
      call_dispositions: [],
      tools_drawer: {
        fm_price_per_report: 7,
        providers: []
      }
    },
    permissions: {
      sms_templates: false,
      email_templates: false,
      call_dispositions: false,
      tools_drawer: false
    },
    testing: {
      enabled: false,
      gmail_signature_html: '',
      gmail_mailbox_email: '',
      calendar_primary_summary: '',
      calendar_timezone: '',
      ringcentral_extension_name: '',
      ringcentral_extension_email: '',
      ringcentral_default_sms_number: '',
      recent: {
        gmail: [],
        ringcentral_messages: [],
        ringcentral_calls: [],
        calendar_events: [],
        counts: { gmail: 0, ringcentral_messages: 0, ringcentral_calls: 0, calendar_events: 0 }
      }
    },
    canManage: false,
    ringcentral: {
      configured: false,
      connected: false,
      extension_name: '',
      extension_email: '',
      default_sms_number: '',
      resolved_from: '',
      users: [],
      extensions: [],
      mappings: {},
      canManage: false
    },
    gmail: {
      configured: false,
      connected: false,
      connected_email: '',
      signature_scope_granted: false,
      calendar_scope_granted: false
    }
  };

  function esc(value){
    return window.Portal.escapeHtml(value);
  }

  function tabPermissionKey(tab){
    if (tab === 'sms') return 'sms_templates';
    if (tab === 'email') return 'email_templates';
    if (tab === 'disposition') return 'call_dispositions';
    return '';
  }

  function canManageTab(tab){
    const key = tabPermissionKey(tab);
    if (!key) return state.canManage;
    return !!state.permissions[key];
  }

  function visibleTabs(){
    const tabs = [];
    if (state.permissions.sms_templates) tabs.push('sms');
    if (state.permissions.email_templates) tabs.push('email');
    if (state.permissions.call_dispositions) tabs.push('disposition');
    if (state.ringcentral.canManage || state.gmail.configured || state.gmail.connected) tabs.push('connection');
    if (state.canManage) tabs.push('testing');
    return tabs;
  }

  function ensureActiveTab(){
    const tabs = visibleTabs();
    if (!tabs.length) {
      state.activeTab = 'sms';
      return;
    }
    if (!tabs.includes(state.activeTab)) {
      state.activeTab = tabs[0];
    }
  }

  function isProtectedDisposition(row){
    return String(row?.label || '').trim().toLowerCase() === 'do not contact';
  }

  function isCoreToolsProvider(row){
    return ['eagleview', 'quickmeasure', 'roofr', 'roofscope', 'other', 'none'].includes(String(row?.id || '').trim().toLowerCase());
  }

  function ensureStyles(){
    if (document.getElementById('crmSettingsStyles')) return;
    const style = document.createElement('style');
    style.id = 'crmSettingsStyles';
    style.textContent = `
      .crm-settings-shell{display:grid;gap:18px;min-height:0}
      .crm-settings-head{display:flex;justify-content:space-between;align-items:flex-start;gap:12px;flex-wrap:wrap}
      .crm-settings-head-copy{display:grid;gap:6px}
      .crm-settings-head-copy h2{margin:0;font-size:26px;font-weight:900;color:#223040;letter-spacing:-.03em}
      .crm-settings-head-copy p{margin:0;font-size:13px;color:#667487;line-height:1.6;max-width:820px}
      .crm-settings-actions{display:flex;gap:8px;flex-wrap:wrap}
      .crm-settings-btn{border:none;border-radius:12px;padding:10px 14px;font-size:12px;font-weight:800;cursor:pointer}
      .crm-settings-btn.primary{background:#d93025;color:#fff}
      .crm-settings-btn.primary:disabled{opacity:.6;cursor:not-allowed}
      .crm-settings-btn.secondary{background:#fff;border:1px solid #d7dee9;color:#334155}
      .crm-settings-status{font-size:12px;font-weight:800;color:#667487}
      .crm-settings-status.error{color:#b42318}
      .crm-settings-tabs{display:flex;gap:8px;flex-wrap:wrap}
      .crm-settings-tab{border:1px solid #d7dee9;background:#fff;border-radius:999px;padding:9px 14px;font-size:12px;font-weight:800;color:#445366;cursor:pointer}
      .crm-settings-tab.active{background:#223040;border-color:#223040;color:#fff;box-shadow:0 10px 24px rgba(16,24,40,.12)}
      .crm-settings-workspace{background:#fff;border:1px solid #e6eaf0;border-radius:20px;overflow:hidden;box-shadow:0 12px 30px rgba(16,24,40,.04);display:grid;min-height:0}
      .crm-settings-card{background:#fff;border:1px solid #e6eaf0;border-radius:18px;overflow:hidden;box-shadow:0 12px 30px rgba(16,24,40,.04)}
      .crm-settings-card-head{display:flex;justify-content:space-between;align-items:flex-start;gap:12px;padding:16px 18px;border-bottom:1px solid #eef2f6;background:#fbfcfe}
      .crm-settings-card-head h3{margin:0;font-size:13px;font-weight:900;text-transform:uppercase;letter-spacing:.05em;color:#5f6b7d}
      .crm-settings-card-head p{margin:6px 0 0;font-size:12px;color:#6e7a8c;line-height:1.5}
      .crm-settings-workspace-head{display:flex;justify-content:space-between;align-items:flex-start;gap:12px;padding:18px 20px;border-bottom:1px solid #eef2f6;background:linear-gradient(180deg,#fcfdff,#f7f9fc)}
      .crm-settings-workspace-copy{display:grid;gap:6px}
      .crm-settings-workspace-copy h3{margin:0;font-size:18px;font-weight:900;color:#223040}
      .crm-settings-workspace-copy p{margin:0;font-size:13px;line-height:1.55;color:#667487;max-width:760px}
      .crm-settings-card-body{padding:18px 20px;display:grid;gap:12px}
      .crm-settings-empty{padding:24px 12px;border:1px dashed #d7dee9;border-radius:14px;text-align:center;color:#7b8797;font-weight:700;background:#fbfcfe}
      .crm-settings-row{border:1px solid #e6eaf0;border-radius:16px;padding:12px;background:#fff;display:grid;gap:10px}
      .crm-settings-row.slim{grid-template-columns:minmax(0,1fr) auto;align-items:center}
      .crm-settings-row.protected{border-color:#f1b7b2;background:linear-gradient(180deg,#fff8f7,#fff)}
      .crm-settings-row.protected .crm-settings-label{color:#b42318}
      .crm-settings-row-head{display:flex;justify-content:space-between;align-items:center;gap:10px;flex-wrap:wrap}
      .crm-settings-label{font-size:11px;font-weight:900;text-transform:uppercase;letter-spacing:.05em;color:#738095}
      .crm-settings-input,.crm-settings-textarea{width:100%;box-sizing:border-box;border:1px solid #d7dee9;border-radius:12px;padding:10px 12px;font:inherit;color:#223040;background:#fff}
      .crm-settings-textarea{min-height:118px;resize:vertical;line-height:1.5}
      .crm-settings-row-actions{display:flex;gap:6px;flex-wrap:wrap}
      .crm-settings-icon-btn{border:1px solid #d7dee9;background:#fff;border-radius:10px;padding:7px 10px;font-size:12px;font-weight:800;color:#445366;cursor:pointer}
      .crm-settings-icon-btn:disabled{opacity:.5;cursor:not-allowed}
      .crm-settings-icon-btn.danger{color:#b42318}
      .crm-settings-protected-pill{display:inline-flex;align-items:center;gap:6px;border-radius:999px;padding:5px 10px;background:#fce8e6;color:#b42318;font-size:10px;font-weight:900;text-transform:uppercase;letter-spacing:.05em}
      .crm-settings-foot{display:flex;justify-content:space-between;align-items:center;gap:10px;flex-wrap:wrap}
      .crm-settings-note{font-size:12px;color:#667487;line-height:1.55}
      .crm-settings-tab-panel{display:none}
      .crm-settings-tab-panel.active{display:block}
      .crm-settings-rc-grid{display:grid;grid-template-columns:minmax(260px,340px) minmax(0,1fr);gap:16px;align-items:start}
      .crm-settings-rc-summary{display:grid;gap:10px}
      .crm-settings-rc-metric{border:1px solid #e6eaf0;border-radius:16px;padding:14px;background:#fff}
      .crm-settings-rc-metric .k{font-size:10px;font-weight:900;text-transform:uppercase;letter-spacing:.05em;color:#738095}
      .crm-settings-rc-metric .v{margin-top:6px;font-size:15px;font-weight:900;color:#223040;word-break:break-word}
      .crm-settings-rc-metric .m{margin-top:4px;font-size:12px;color:#667487;line-height:1.45}
      .crm-settings-rc-status{display:inline-flex;align-items:center;gap:6px;border-radius:999px;padding:5px 10px;font-size:10px;font-weight:900;text-transform:uppercase;letter-spacing:.05em}
      .crm-settings-rc-status.ok{background:#e7f6ec;color:#157347}
      .crm-settings-rc-status.error{background:#fce8e6;color:#b42318}
      .crm-settings-rc-status.idle{background:#eef2f6;color:#667487}
      .crm-settings-rc-users{display:grid;gap:10px}
      .crm-settings-rc-user{border:1px solid #e6eaf0;border-radius:16px;padding:12px;background:#fff;display:grid;gap:10px}
      .crm-settings-rc-user-head{display:flex;justify-content:space-between;align-items:flex-start;gap:10px;flex-wrap:wrap}
      .crm-settings-rc-user-name{font-size:14px;font-weight:900;color:#223040}
      .crm-settings-rc-user-sub{font-size:12px;color:#667487}
      .crm-settings-rc-select{width:100%;box-sizing:border-box;border:1px solid #d7dee9;border-radius:12px;padding:10px 12px;font:inherit;background:#fff;color:#223040}
      .crm-settings-rc-help{font-size:12px;color:#667487;line-height:1.55}
      @media (max-width: 860px){
        .crm-settings-workspace-head{grid-template-columns:1fr;display:grid}
        .crm-settings-rc-grid{grid-template-columns:1fr}
      }
    `;
    document.head.appendChild(style);
  }

  function blankSmsTemplate(){
    return { id: '', name: '', body: '' };
  }

  function blankEmailTemplate(){
    return { id: '', name: '', subject: '', body: '' };
  }

  function blankDisposition(){
    return { id: '', label: '' };
  }

  function blankToolsComparisonRow(){
    return { feature: '', first_mate: '', provider: '' };
  }

  function blankToolsProvider(){
    return {
      id: '',
      name: '',
      short_label: '',
      default_price: '',
      comparison_heading: '',
      comparison_summary: '',
      comparison_rows: [blankToolsComparisonRow()]
    };
  }

  function normalizeToolsProvider(item){
    const rows = Array.isArray(item?.comparison_rows) ? item.comparison_rows : [];
    return {
      id: String(item?.id || ''),
      name: String(item?.name || ''),
      short_label: String(item?.short_label || ''),
      default_price: item?.default_price === '' || item?.default_price == null ? '' : String(item.default_price),
      comparison_heading: String(item?.comparison_heading || ''),
      comparison_summary: String(item?.comparison_summary || ''),
      comparison_rows: (rows.length ? rows : [blankToolsComparisonRow()]).map(row => ({
        feature: String(row?.feature || ''),
        first_mate: String(row?.first_mate || ''),
        provider: String(row?.provider || '')
      }))
    };
  }

  function normalizeSettings(raw){
    raw = raw && typeof raw === 'object' ? raw : {};
    return {
      sms_templates: Array.isArray(raw.sms_templates) ? raw.sms_templates.map(item => ({
        id: String(item?.id || ''),
        name: String(item?.name || ''),
        body: String(item?.body || '')
      })) : [],
      email_templates: Array.isArray(raw.email_templates) ? raw.email_templates.map(item => ({
        id: String(item?.id || ''),
        name: String(item?.name || ''),
        subject: String(item?.subject || ''),
        body: String(item?.body || '')
      })) : [],
      call_dispositions: Array.isArray(raw.call_dispositions) ? raw.call_dispositions.map(item => ({
        id: String(item?.id || ''),
        label: String(item?.label || '')
      })) : [],
      tools_drawer: {
        fm_price_per_report: raw?.tools_drawer?.fm_price_per_report === '' || raw?.tools_drawer?.fm_price_per_report == null
          ? 7
          : Number(raw.tools_drawer.fm_price_per_report || 0),
        providers: Array.isArray(raw?.tools_drawer?.providers)
          ? raw.tools_drawer.providers.map(normalizeToolsProvider)
          : []
      }
    };
  }

  function normalizeTesting(raw){
    raw = raw && typeof raw === 'object' ? raw : {};
    const recent = raw.recent && typeof raw.recent === 'object' ? raw.recent : {};
    const counts = recent.counts && typeof recent.counts === 'object' ? recent.counts : {};
    return {
      enabled: !!raw.enabled,
      gmail_signature_html: String(raw.gmail_signature_html || ''),
      gmail_mailbox_email: String(raw.gmail_mailbox_email || ''),
      calendar_primary_summary: String(raw.calendar_primary_summary || ''),
      calendar_timezone: String(raw.calendar_timezone || ''),
      ringcentral_extension_name: String(raw.ringcentral_extension_name || ''),
      ringcentral_extension_email: String(raw.ringcentral_extension_email || ''),
      ringcentral_default_sms_number: String(raw.ringcentral_default_sms_number || ''),
      recent: {
        gmail: Array.isArray(recent.gmail) ? recent.gmail : [],
        ringcentral_messages: Array.isArray(recent.ringcentral_messages) ? recent.ringcentral_messages : [],
        ringcentral_calls: Array.isArray(recent.ringcentral_calls) ? recent.ringcentral_calls : [],
        calendar_events: Array.isArray(recent.calendar_events) ? recent.calendar_events : [],
        counts: {
          gmail: Number(counts.gmail || 0),
          ringcentral_messages: Number(counts.ringcentral_messages || 0),
          ringcentral_calls: Number(counts.ringcentral_calls || 0),
          calendar_events: Number(counts.calendar_events || 0)
        }
      }
    };
  }

  function api(payload){
    return window.Portal.apiPost(cfg().endpoints?.server || window.Portal.internalLegacyEndpoint(), payload);
  }

  async function load(){
    state.loading = true;
    state.error = '';
    render();
    try {
      const [data, ringcentralData, testingData, gmailData] = await Promise.all([
        api({ action: 'crm_settings_get' }),
        api({ action: 'ringcentral_settings_snapshot' }).catch(err => ({ success: false, error: err?.message || 'Could not load RingCentral settings.' })),
        api({ action: 'mock_comms_settings_get' }).catch(err => ({ success: false, error: err?.message || 'Could not load testing settings.' })),
        api({ action: 'google_connection_status' }).catch(err => ({ success: false, error: err?.message || 'Could not load Google connection status.' }))
      ]);
      if (!data || data.success === false) {
        throw new Error(data?.error || 'Could not load CRM settings.');
      }
      const snapshot = data.settings || {};
      state.settings = normalizeSettings(snapshot);
      state.canManage = !!snapshot.can_manage;
      state.permissions = {
        sms_templates: !!snapshot.permissions?.sms_templates,
        email_templates: !!snapshot.permissions?.email_templates,
        call_dispositions: !!snapshot.permissions?.call_dispositions,
        tools_drawer: !!snapshot.permissions?.tools_drawer
      };
      if (ringcentralData && ringcentralData.success !== false) {
        state.ringcentral = {
          configured: !!ringcentralData.ringcentral?.configured,
          connected: !!ringcentralData.ringcentral?.connected,
          extension_name: String(ringcentralData.ringcentral?.extension_name || ''),
          extension_email: String(ringcentralData.ringcentral?.extension_email || ''),
          default_sms_number: String(ringcentralData.ringcentral?.default_sms_number || ''),
          resolved_from: String(ringcentralData.ringcentral?.resolved_from || ''),
          users: Array.isArray(ringcentralData.users) ? ringcentralData.users : [],
          extensions: Array.isArray(ringcentralData.extensions) ? ringcentralData.extensions : [],
          mappings: ringcentralData.mappings && typeof ringcentralData.mappings === 'object' ? ringcentralData.mappings : {},
          canManage: !!ringcentralData.can_manage
        };
      }
      if (testingData && testingData.success !== false) {
        state.testing = normalizeTesting({
          ...(testingData.settings || {}),
          recent: testingData.recent || {}
        });
      }
      if (gmailData && gmailData.success !== false) {
        state.gmail = {
          configured: !!gmailData.gmail?.configured,
          connected: !!gmailData.gmail?.connected,
          connected_email: String(gmailData.gmail?.connected_email || ''),
          signature_scope_granted: !!gmailData.gmail?.signature_scope_granted,
          calendar_scope_granted: !!gmailData.gmail?.calendar_scope_granted
        };
      }
    } catch (err) {
      state.error = err?.message || 'Could not load CRM settings.';
    } finally {
      ensureActiveTab();
      state.loading = false;
      render();
    }
  }

  async function save(){
    if (state.saving || !(canManageTab(state.activeTab) || (state.activeTab === 'connection' && state.ringcentral.canManage) || (state.activeTab === 'testing' && state.canManage))) return;
    state.saving = true;
    state.error = '';
    render();
    try {
      if (state.activeTab === 'connection') {
        const data = await api({
          action: 'ringcentral_settings_save_mappings',
          mappings_json: JSON.stringify(state.ringcentral.mappings || {})
        });
        if (!data || data.success === false) {
          throw new Error(data?.error || 'Could not save RingCentral mappings.');
        }
        state.ringcentral.mappings = data.mappings && typeof data.mappings === 'object' ? data.mappings : {};
      } else if (state.activeTab === 'testing') {
        const data = await api({
          action: 'mock_comms_settings_save',
          enabled: state.testing.enabled ? 1 : 0,
          gmail_signature_html: state.testing.gmail_signature_html,
          gmail_mailbox_email: state.testing.gmail_mailbox_email,
          calendar_primary_summary: state.testing.calendar_primary_summary,
          calendar_timezone: state.testing.calendar_timezone,
          ringcentral_extension_name: state.testing.ringcentral_extension_name,
          ringcentral_extension_email: state.testing.ringcentral_extension_email,
          ringcentral_default_sms_number: state.testing.ringcentral_default_sms_number
        });
        if (!data || data.success === false) {
          throw new Error(data?.error || 'Could not save testing settings.');
        }
        state.testing = normalizeTesting({
          ...(data.settings || {}),
          recent: data.recent || {}
        });
      } else {
        const data = await api({
          action: 'crm_settings_save',
          sms_templates_json: JSON.stringify(state.settings.sms_templates),
          email_templates_json: JSON.stringify(state.settings.email_templates),
          call_dispositions_json: JSON.stringify(state.settings.call_dispositions),
          tools_drawer_json: JSON.stringify(state.settings.tools_drawer || {})
        });
        if (!data || data.success === false) {
          throw new Error(data?.error || 'Could not save CRM settings.');
        }
        state.settings = normalizeSettings(data.settings || {});
        state.canManage = !!data.settings?.can_manage;
      }
    } catch (err) {
      state.error = err?.message || (
        state.activeTab === 'connection'
          ? 'Could not save RingCentral mappings.'
          : state.activeTab === 'testing'
            ? 'Could not save testing settings.'
            : 'Could not save CRM settings.'
      );
    } finally {
      state.saving = false;
      render();
    }
  }

  function addRow(section){
    if (!canManageTab(state.activeTab)) return;
    if (section === 'sms') state.settings.sms_templates.push(blankSmsTemplate());
    if (section === 'email') state.settings.email_templates.push(blankEmailTemplate());
    if (section === 'disposition') state.settings.call_dispositions.push(blankDisposition());
    if (section === 'tools') state.settings.tools_drawer.providers.push(blankToolsProvider());
    render();
  }

  function addToolsComparisonRow(providerIndex){
    if (!canManageTab('tools')) return;
    const provider = state.settings.tools_drawer?.providers?.[providerIndex];
    if (!provider) return;
    if (!Array.isArray(provider.comparison_rows)) provider.comparison_rows = [];
    provider.comparison_rows.push(blankToolsComparisonRow());
    render();
  }

  function removeToolsComparisonRow(providerIndex, rowIndex){
    if (!canManageTab('tools')) return;
    const provider = state.settings.tools_drawer?.providers?.[providerIndex];
    if (!provider || !Array.isArray(provider.comparison_rows)) return;
    provider.comparison_rows.splice(rowIndex, 1);
    if (!provider.comparison_rows.length) provider.comparison_rows.push(blankToolsComparisonRow());
    render();
  }

  function moveToolsComparisonRow(providerIndex, rowIndex, delta){
    if (!canManageTab('tools')) return;
    const provider = state.settings.tools_drawer?.providers?.[providerIndex];
    if (!provider || !Array.isArray(provider.comparison_rows)) return;
    const nextIndex = rowIndex + delta;
    if (nextIndex < 0 || nextIndex >= provider.comparison_rows.length) return;
    const temp = provider.comparison_rows[rowIndex];
    provider.comparison_rows[rowIndex] = provider.comparison_rows[nextIndex];
    provider.comparison_rows[nextIndex] = temp;
    render();
  }

  function updateRingCentralMapping(actorEmail, extensionKey){
    const email = String(actorEmail || '').trim().toLowerCase();
    if (!email) return;
    const next = { ...(state.ringcentral.mappings || {}) };
    const key = String(extensionKey || '').trim();
    if (!key) delete next[email];
    else next[email] = key;
    state.ringcentral.mappings = next;
  }

  function updateTestingField(field, value){
    if (!state.testing || typeof state.testing !== 'object') return;
    state.testing[field] = value;
  }

  async function triggerTestingAction(action){
    if (!canManageTab(state.activeTab) || state.saving) return;
    const form = document.querySelector('[data-crm-testing-form="' + action + '"]');
    const payload = { action };
    if (form) {
      form.querySelectorAll('[name]').forEach(field => {
        payload[field.name] = field.type === 'checkbox' ? (field.checked ? 1 : 0) : (field.value || '');
      });
    }
    state.saving = true;
    state.error = '';
    render();
    try {
      const data = await api(payload);
      if (!data || data.success === false) {
        throw new Error(data?.error || 'Could not complete the testing action.');
      }
      state.testing = normalizeTesting({
        ...(data.settings || state.testing),
        recent: data.recent || state.testing.recent
      });
      if (form) form.reset();
    } catch (err) {
      state.error = err?.message || 'Could not complete the testing action.';
    } finally {
      state.saving = false;
      render();
    }
  }

  function moveRow(section, index, delta){
    if (!canManageTab(section)) return;
    const list = section === 'sms'
      ? state.settings.sms_templates
      : section === 'email'
        ? state.settings.email_templates
        : section === 'disposition'
          ? state.settings.call_dispositions
          : state.settings.tools_drawer.providers;
    const nextIndex = index + delta;
    if (!Array.isArray(list) || nextIndex < 0 || nextIndex >= list.length) return;
    const temp = list[index];
    list[index] = list[nextIndex];
    list[nextIndex] = temp;
    render();
  }

  function removeRow(section, index){
    if (!canManageTab(section)) return;
    const list = section === 'sms'
      ? state.settings.sms_templates
      : section === 'email'
        ? state.settings.email_templates
        : section === 'disposition'
          ? state.settings.call_dispositions
          : state.settings.tools_drawer.providers;
    if (!Array.isArray(list)) return;
    list.splice(index, 1);
    render();
  }

  function updateField(section, index, field, value){
    if (section === 'tools_root') {
      if (!state.settings.tools_drawer) state.settings.tools_drawer = { fm_price_per_report: 7, providers: [] };
      state.settings.tools_drawer[field] = field === 'fm_price_per_report' ? Number(value || 0) : value;
      return;
    }
    if (section === 'tools_comp') {
      const provider = state.settings.tools_drawer?.providers?.[index];
      if (!provider || !Array.isArray(provider.comparison_rows)) return;
      const rowIndex = Number(field.split(':')[0] || -1);
      const rowField = String(field.split(':')[1] || '').trim();
      if (!provider.comparison_rows[rowIndex] || !rowField) return;
      provider.comparison_rows[rowIndex][rowField] = value;
      return;
    }
    const list = section === 'sms'
      ? state.settings.sms_templates
      : section === 'email'
        ? state.settings.email_templates
        : section === 'disposition'
          ? state.settings.call_dispositions
          : state.settings.tools_drawer.providers;
    if (!Array.isArray(list) || !list[index]) return;
    list[index][field] = field === 'default_price' ? value : value;
  }

  function bind(container){
    const refreshBtn = container.querySelector('[data-crm-settings-refresh]');
    if (refreshBtn && refreshBtn.dataset.wired !== 'true') {
      refreshBtn.dataset.wired = 'true';
      refreshBtn.addEventListener('click', () => load());
    }
    const saveBtn = container.querySelector('[data-crm-settings-save]');
    if (saveBtn && saveBtn.dataset.wired !== 'true') {
      saveBtn.dataset.wired = 'true';
      saveBtn.addEventListener('click', () => save());
    }
    container.querySelectorAll('[data-crm-settings-add]').forEach(btn => {
      if (btn.dataset.wired === 'true') return;
      btn.dataset.wired = 'true';
      btn.addEventListener('click', () => addRow(btn.getAttribute('data-crm-settings-add') || ''));
    });
    container.querySelectorAll('[data-crm-settings-move]').forEach(btn => {
      if (btn.dataset.wired === 'true') return;
      btn.dataset.wired = 'true';
      btn.addEventListener('click', () => {
        moveRow(
          btn.getAttribute('data-section') || '',
          Number(btn.getAttribute('data-index') || -1),
          Number(btn.getAttribute('data-crm-settings-move') || 0)
        );
      });
    });
    container.querySelectorAll('[data-crm-settings-delete]').forEach(btn => {
      if (btn.dataset.wired === 'true') return;
      btn.dataset.wired = 'true';
      btn.addEventListener('click', () => {
        removeRow(
          btn.getAttribute('data-section') || '',
          Number(btn.getAttribute('data-index') || -1)
        );
      });
    });
    container.querySelectorAll('[data-crm-tools-comp-add]').forEach(btn => {
      if (btn.dataset.wired === 'true') return;
      btn.dataset.wired = 'true';
      btn.addEventListener('click', () => addToolsComparisonRow(Number(btn.getAttribute('data-provider-index') || -1)));
    });
    container.querySelectorAll('[data-crm-tools-comp-delete]').forEach(btn => {
      if (btn.dataset.wired === 'true') return;
      btn.dataset.wired = 'true';
      btn.addEventListener('click', () => removeToolsComparisonRow(
        Number(btn.getAttribute('data-provider-index') || -1),
        Number(btn.getAttribute('data-row-index') || -1)
      ));
    });
    container.querySelectorAll('[data-crm-tools-comp-move]').forEach(btn => {
      if (btn.dataset.wired === 'true') return;
      btn.dataset.wired = 'true';
      btn.addEventListener('click', () => moveToolsComparisonRow(
        Number(btn.getAttribute('data-provider-index') || -1),
        Number(btn.getAttribute('data-row-index') || -1),
        Number(btn.getAttribute('data-crm-tools-comp-move') || 0)
      ));
    });
    container.querySelectorAll('[data-crm-settings-field]').forEach(field => {
      if (field.dataset.wired === 'true') return;
      field.dataset.wired = 'true';
      field.addEventListener('input', () => {
        updateField(
          field.getAttribute('data-section') || '',
          Number(field.getAttribute('data-index') || -1),
          field.getAttribute('data-field') || '',
          field.value || ''
        );
      });
    });
    container.querySelectorAll('[data-crm-settings-tab]').forEach(btn => {
      if (btn.dataset.wired === 'true') return;
      btn.dataset.wired = 'true';
      btn.addEventListener('click', () => {
        state.activeTab = btn.getAttribute('data-crm-settings-tab') || 'sms';
        ensureActiveTab();
        render();
      });
    });
    container.querySelectorAll('[data-crm-settings-rc-user]').forEach(field => {
      if (field.dataset.wired === 'true') return;
      field.dataset.wired = 'true';
      field.addEventListener('change', () => {
        updateRingCentralMapping(field.getAttribute('data-user-email') || '', field.value || '');
      });
    });
    container.querySelectorAll('[data-crm-testing-field]').forEach(field => {
      if (field.dataset.wired === 'true') return;
      field.dataset.wired = 'true';
      const eventName = field.type === 'checkbox' ? 'change' : 'input';
      field.addEventListener(eventName, () => {
        updateTestingField(field.getAttribute('data-crm-testing-field') || '', field.type === 'checkbox' ? !!field.checked : (field.value || ''));
      });
    });
    container.querySelectorAll('[data-crm-testing-action]').forEach(btn => {
      if (btn.dataset.wired === 'true') return;
      btn.dataset.wired = 'true';
      btn.addEventListener('click', () => triggerTestingAction(btn.getAttribute('data-crm-testing-action') || ''));
    });
    container.querySelectorAll('[data-crm-gmail-disconnect]').forEach(btn => {
      if (btn.dataset.wired === 'true') return;
      btn.dataset.wired = 'true';
      btn.addEventListener('click', async () => {
        if (state.saving) return;
        state.saving = true;
        state.error = '';
        render();
        try {
          const data = await api({ action: 'gmail_disconnect' });
          if (!data || data.success === false) {
            throw new Error(data?.error || 'Could not disconnect Gmail.');
          }
          state.gmail = {
            configured: !!data.gmail?.configured,
            connected: !!data.gmail?.connected,
            connected_email: String(data.gmail?.connected_email || ''),
            signature_scope_granted: !!data.gmail?.signature_scope_granted,
            calendar_scope_granted: !!data.gmail?.calendar_scope_granted
          };
        } catch (err) {
          state.error = err?.message || 'Could not disconnect Gmail.';
        } finally {
          state.saving = false;
          render();
        }
      });
    });
  }

  function openTab(tab){
    state.activeTab = tab || 'sms';
    ensureActiveTab();
    render();
  }

  function activeTabMeta(){
    const tabs = {
      sms: {
        title: 'SMS Templates',
        copy: 'These templates power the SMS composer in the lead view.',
        addLabel: 'Add SMS Template',
        addKey: 'sms'
      },
      email: {
        title: 'Email Templates',
        copy: 'These templates power the lead email composer template buttons.',
        addLabel: 'Add Email Template',
        addKey: 'email'
      },
      disposition: {
        title: 'Call Dispositions',
        copy: 'This is the shared company-wide list for RingCentral manual dispositions and Orum-aligned reporting.',
        addLabel: 'Add Disposition',
        addKey: 'disposition'
      },
      connection: {
        title: 'Connections',
        copy: 'Manage the shared integration connection surfaces used by the CRM. RingCentral routing is company-wide, while Gmail disconnect lives here instead of inside the lead email composer.',
        addLabel: 'Refresh Extensions',
        addKey: ''
      },
      testing: {
        title: 'Testing Mode',
        copy: 'Server-side test mode blocks all real Gmail and RingCentral sends and syncs, then routes those flows through the internal mock provider instead.',
        addLabel: '',
        addKey: ''
      }
    };
    return tabs[state.activeTab] || tabs.sms;
  }

  function renderSmsRows(){
    const editable = canManageTab('sms');
    const rows = state.settings.sms_templates || [];
    if (!rows.length) return '<div class="crm-settings-empty">No SMS templates yet.</div>';
    return rows.map((row, index) => `
      <div class="crm-settings-row">
        <div class="crm-settings-row-head">
          <div class="crm-settings-label">SMS Template ${index + 1}</div>
          <div class="crm-settings-row-actions">
            <button class="crm-settings-icon-btn" type="button" data-crm-settings-move="-1" data-section="sms" data-index="${index}" ${!editable || index === 0 ? 'disabled' : ''}>Up</button>
            <button class="crm-settings-icon-btn" type="button" data-crm-settings-move="1" data-section="sms" data-index="${index}" ${!editable || index === rows.length - 1 ? 'disabled' : ''}>Down</button>
            <button class="crm-settings-icon-btn danger" type="button" data-crm-settings-delete="1" data-section="sms" data-index="${index}" ${!editable ? 'disabled' : ''}>Delete</button>
          </div>
        </div>
        <div>
          <div class="crm-settings-label">Name</div>
          <input class="crm-settings-input" type="text" value="${esc(row.name || '')}" data-crm-settings-field data-section="sms" data-index="${index}" data-field="name" ${!editable ? 'disabled' : ''}>
        </div>
        <div>
          <div class="crm-settings-label">Message</div>
          <textarea class="crm-settings-textarea" data-crm-settings-field data-section="sms" data-index="${index}" data-field="body" ${!editable ? 'disabled' : ''}>${esc(row.body || '')}</textarea>
        </div>
      </div>
    `).join('');
  }

  function renderEmailRows(){
    const editable = canManageTab('email');
    const rows = state.settings.email_templates || [];
    if (!rows.length) return '<div class="crm-settings-empty">No email templates yet.</div>';
    return rows.map((row, index) => `
      <div class="crm-settings-row">
        <div class="crm-settings-row-head">
          <div class="crm-settings-label">Email Template ${index + 1}</div>
          <div class="crm-settings-row-actions">
            <button class="crm-settings-icon-btn" type="button" data-crm-settings-move="-1" data-section="email" data-index="${index}" ${!editable || index === 0 ? 'disabled' : ''}>Up</button>
            <button class="crm-settings-icon-btn" type="button" data-crm-settings-move="1" data-section="email" data-index="${index}" ${!editable || index === rows.length - 1 ? 'disabled' : ''}>Down</button>
            <button class="crm-settings-icon-btn danger" type="button" data-crm-settings-delete="1" data-section="email" data-index="${index}" ${!editable ? 'disabled' : ''}>Delete</button>
          </div>
        </div>
        <div>
          <div class="crm-settings-label">Name</div>
          <input class="crm-settings-input" type="text" value="${esc(row.name || '')}" data-crm-settings-field data-section="email" data-index="${index}" data-field="name" ${!editable ? 'disabled' : ''}>
        </div>
        <div>
          <div class="crm-settings-label">Subject</div>
          <input class="crm-settings-input" type="text" value="${esc(row.subject || '')}" data-crm-settings-field data-section="email" data-index="${index}" data-field="subject" ${!editable ? 'disabled' : ''}>
        </div>
        <div>
          <div class="crm-settings-label">Body</div>
          <textarea class="crm-settings-textarea" data-crm-settings-field data-section="email" data-index="${index}" data-field="body" ${!editable ? 'disabled' : ''}>${esc(row.body || '')}</textarea>
        </div>
      </div>
    `).join('');
  }

  function renderDispositionRows(){
    const editable = canManageTab('disposition');
    const rows = state.settings.call_dispositions || [];
    if (!rows.length) return '<div class="crm-settings-empty">No call dispositions yet.</div>';
    return rows.map((row, index) => `
      <div class="crm-settings-row slim ${isProtectedDisposition(row) ? 'protected' : ''}">
        <div>
          <div class="crm-settings-label">Disposition ${index + 1}</div>
          <input class="crm-settings-input" type="text" value="${esc(row.label || '')}" data-crm-settings-field data-section="disposition" data-index="${index}" data-field="label" ${!editable || isProtectedDisposition(row) ? 'disabled' : ''}>
        </div>
        <div class="crm-settings-row-actions">
          ${isProtectedDisposition(row) ? `<span class="crm-settings-protected-pill"><i class="fas fa-lock"></i> Protected</span>` : ``}
          <button class="crm-settings-icon-btn" type="button" data-crm-settings-move="-1" data-section="disposition" data-index="${index}" ${!editable || index === 0 ? 'disabled' : ''}>Up</button>
          <button class="crm-settings-icon-btn" type="button" data-crm-settings-move="1" data-section="disposition" data-index="${index}" ${!editable || index === rows.length - 1 ? 'disabled' : ''}>Down</button>
          <button class="crm-settings-icon-btn danger" type="button" data-crm-settings-delete="1" data-section="disposition" data-index="${index}" ${!editable || isProtectedDisposition(row) ? 'disabled' : ''}>Delete</button>
        </div>
      </div>
    `).join('');
  }

  function renderRcStatus(value, okLabel, idleLabel){
    const truthy = !!value;
    const tone = truthy ? 'ok' : 'idle';
    return `<span class="crm-settings-rc-status ${tone}">${esc(truthy ? okLabel : idleLabel)}</span>`;
  }

  function extensionOptionLabel(row){
    const parts = [];
    const label = String(row.extension_name || row.extension_email || row.extension_number || 'Extension').trim();
    if (label) parts.push(label);
    if (row.default_sms_number) parts.push(String(row.default_sms_number));
    return parts.join(' | ');
  }

  function renderRingCentralPanel(){
    const rc = state.ringcentral || {};
    const gmail = state.gmail || {};
    const mappings = rc.mappings || {};
    const users = Array.isArray(rc.users) ? rc.users : [];
    const extensions = Array.isArray(rc.extensions) ? rc.extensions : [];
    const extensionMap = {};
    extensions.forEach(row => { if (row?.extension_key) extensionMap[String(row.extension_key)] = row; });
    return `
      <div class="crm-settings-rc-grid">
      <div class="crm-settings-rc-summary">
          <div class="crm-settings-rc-metric">
            <div class="k">Google Connection</div>
            <div class="v">${renderRcStatus(gmail.connected, 'Connected', gmail.configured ? 'Not Connected' : 'Not Configured')}</div>
            <div class="m">${esc(gmail.connected ? (gmail.connected_email || 'Connected Google account') : (gmail.configured ? 'Connect Google from the CRM prompt when needed. Disconnect is managed here instead of in the lead email composer.' : 'Google integrations are not configured on this server.'))}</div>
          </div>
          <div class="crm-settings-rc-metric">
            <div class="k">Connection Status</div>
            <div class="v">${renderRcStatus(rc.connected, 'Connected', 'Disconnected')}</div>
            <div class="m">${esc(rc.configured ? 'RingCentral credentials are configured on this server.' : 'RingCentral credentials are not configured yet.')}</div>
          </div>
          <div class="crm-settings-rc-metric">
            <div class="k">Current Actor Route</div>
            <div class="v">${esc(rc.extension_name || rc.extension_email || 'No extension resolved')}</div>
            <div class="m">${esc(rc.default_sms_number || 'No SMS-enabled number available')} ${rc.resolved_from ? `| Resolved from ${esc(rc.resolved_from)}` : ''}</div>
          </div>
          <div class="crm-settings-rc-metric">
            <div class="k">Available Extensions</div>
            <div class="v">${esc(String(extensions.length))}</div>
            <div class="m">Managers can map SDRs to specific RingCentral extensions here so texting, call sync, and sender phone resolution all follow the assigned rep.</div>
          </div>
        </div>
        <div style="display:grid;gap:16px">
        <div class="crm-settings-card">
          <div class="crm-settings-card-head">
            <div>
              <h3>Google Mail & Calendar</h3>
              <p>The lead email composer only shows the connect prompt when Gmail is missing. Disconnecting Google lives here instead of inside the composer.</p>
            </div>
          </div>
          <div class="crm-settings-card-body">
            <div class="crm-settings-row slim">
              <div>
                <div class="crm-settings-label">Current Google Account</div>
                <div class="crm-settings-note">${esc(gmail.connected ? (gmail.connected_email || 'Connected') : 'Not connected')}</div>
              </div>
              ${gmail.connected ? `<button class="crm-settings-icon-btn danger" type="button" data-crm-gmail-disconnect>Disconnect Gmail</button>` : `<div class="crm-settings-note">Connect from the CRM Google prompt when needed.</div>`}
            </div>
          </div>
        </div>
        <div class="crm-settings-card">
          <div class="crm-settings-card-head">
            <div>
              <h3>SDR Extension Mapping</h3>
              <p>Choose which RingCentral extension each SDR should use. This controls SMS sends, RingCentral sync, and the sender phone used in CRM templates.</p>
            </div>
          </div>
          <div class="crm-settings-card-body">
            ${users.length ? `<div class="crm-settings-rc-users">
              ${users.map(user => {
                const email = String(user.email || '').trim().toLowerCase();
                const selected = String(mappings[email] || '');
                const assigned = selected ? extensionMap[selected] : null;
                return `
                  <div class="crm-settings-rc-user">
                    <div class="crm-settings-rc-user-head">
                      <div>
                        <div class="crm-settings-rc-user-name">${esc(user.name || email)}</div>
                        <div class="crm-settings-rc-user-sub">${esc(email)}${user.role ? ` | ${esc(user.role)}` : ''}</div>
                      </div>
                      ${renderRcStatus(assigned, assigned ? 'Mapped' : '', 'Unassigned')}
                    </div>
                    <select class="crm-settings-rc-select" data-crm-settings-rc-user data-user-email="${esc(email)}" ${!rc.canManage ? 'disabled' : ''}>
                      <option value="">No RingCentral extension assigned</option>
                      ${extensions.map(ext => `<option value="${esc(ext.extension_key || '')}" ${String(ext.extension_key || '') === selected ? 'selected' : ''}>${esc(extensionOptionLabel(ext))}</option>`).join('')}
                    </select>
                    <div class="crm-settings-rc-help">${assigned ? `Current route: ${esc(assigned.extension_name || assigned.extension_email || assigned.extension_number || 'Extension')} | ${esc(assigned.default_sms_number || 'No SMS-enabled number')}` : 'This SDR will fall back to the default connected extension until a specific mapping is assigned.'}</div>
                  </div>
                `;
              }).join('')}
            </div>` : `<div class="crm-settings-empty">No sales users were available for RingCentral mapping.</div>`}
          </div>
        </div>
        </div>
      </div>
    `;
  }

  function fmtTs(ts){
    const n = Number(ts || 0);
    if (!n) return '—';
    try {
      return new Date(n * 1000).toLocaleString();
    } catch (err) {
      return '—';
    }
  }

  function renderRecentTestingRows(rows, type){
    if (!rows.length) return '<div class="crm-settings-empty">No mock records yet.</div>';
    return rows.slice(0, 8).map(row => {
      if (type === 'gmail') {
        return `<div class="crm-settings-row slim"><div><div class="crm-settings-label">${esc((row.direction || '').toUpperCase() || 'EMAIL')}</div><div style="font-weight:800;color:#223040">${esc(row.subject || '(No subject)')}</div><div class="crm-settings-note">${esc((row.from_email || '') + ' | ' + (Array.isArray(row.to_emails) ? row.to_emails.join(', ') : ''))}</div></div><div class="crm-settings-note">${esc(fmtTs(row.happened_at))}</div></div>`;
      }
      if (type === 'sms') {
        return `<div class="crm-settings-row slim"><div><div class="crm-settings-label">${esc((row.direction || '').toUpperCase() || 'SMS')}</div><div style="font-weight:800;color:#223040">${esc(row.body_text || '(No message body)')}</div><div class="crm-settings-note">${esc((row.from_phone || '') + ' | ' + (Array.isArray(row.to_phones) ? row.to_phones.join(', ') : ''))}</div></div><div class="crm-settings-note">${esc(fmtTs(row.happened_at))}</div></div>`;
      }
      if (type === 'calendar') {
        const when = row?.start?.dateTime || row?.start?.date || '';
        return `<div class="crm-settings-row slim"><div><div class="crm-settings-label">${esc((row.status || 'calendar').toUpperCase())}</div><div style="font-weight:800;color:#223040">${esc(row.summary || '(Untitled event)')}</div><div class="crm-settings-note">${esc(String(when || ''))}${row.hangoutLink ? ' | Mock Meet' : ''}</div></div><div class="crm-settings-note">${esc(row.updated || row.created || '—')}</div></div>`;
      }
      return `<div class="crm-settings-row slim"><div><div class="crm-settings-label">${esc((row.direction || '').toUpperCase() || 'CALL')}</div><div style="font-weight:800;color:#223040">${esc((row.action || 'Call') + (row.result ? ' | ' + row.result : ''))}</div><div class="crm-settings-note">${esc((row.from_phone || '') + ' | ' + (Array.isArray(row.to_phones) ? row.to_phones.join(', ') : ''))}</div></div><div class="crm-settings-note">${esc(fmtTs(row.happened_at))}</div></div>`;
    }).join('');
  }

  function renderTestingPanel(){
    const testing = state.testing || {};
    const recent = testing.recent || {};
    const counts = recent.counts || {};
    return `
      <div class="crm-settings-rc-grid">
        <div class="crm-settings-rc-summary">
          <div class="crm-settings-rc-metric">
            <div class="k">Testing Mode</div>
            <div class="v">${testing.enabled ? '<span class="crm-settings-rc-status ok">Enabled</span>' : '<span class="crm-settings-rc-status idle">Disabled</span>'}</div>
            <div class="m">When enabled, real Gmail and RingCentral provider calls are blocked and all send/sync traffic is routed through the internal mock provider.</div>
          </div>
          <div class="crm-settings-rc-metric">
            <div class="k">Mock Counts</div>
            <div class="m">Emails: <strong>${esc(String(counts.gmail || 0))}</strong><br>Texts: <strong>${esc(String(counts.ringcentral_messages || 0))}</strong><br>Calls: <strong>${esc(String(counts.ringcentral_calls || 0))}</strong><br>Calendar Events: <strong>${esc(String(counts.calendar_events || 0))}</strong></div>
          </div>
        </div>
        <div class="crm-settings-card">
          <div class="crm-settings-card-head">
            <div>
              <h3>Mock Provider Settings</h3>
              <p>These settings define the server-wide mock Gmail and RingCentral identities used while testing mode is enabled.</p>
            </div>
          </div>
          <div class="crm-settings-card-body">
            <label class="crm-settings-row slim">
              <div>
                <div class="crm-settings-label">Enable Global Testing Mode</div>
                <div class="crm-settings-note">This makes real Gmail and RingCentral sends impossible until testing mode is turned off.</div>
              </div>
              <input type="checkbox" data-crm-testing-field="enabled" ${testing.enabled ? 'checked' : ''} ${!state.canManage ? 'disabled' : ''}>
            </label>
            <div class="crm-settings-row">
              <div class="crm-settings-label">Mock Gmail Mailbox</div>
              <input class="crm-settings-input" type="email" value="${esc(testing.gmail_mailbox_email || '')}" data-crm-testing-field="gmail_mailbox_email" ${!state.canManage ? 'disabled' : ''}>
            </div>
            <div class="crm-settings-row">
              <div class="crm-settings-label">Mock Calendar Summary</div>
              <input class="crm-settings-input" type="text" value="${esc(testing.calendar_primary_summary || '')}" data-crm-testing-field="calendar_primary_summary" ${!state.canManage ? 'disabled' : ''}>
            </div>
            <div class="crm-settings-row">
              <div class="crm-settings-label">Mock Calendar Timezone</div>
              <input class="crm-settings-input" type="text" value="${esc(testing.calendar_timezone || '')}" data-crm-testing-field="calendar_timezone" ${!state.canManage ? 'disabled' : ''}>
            </div>
            <div class="crm-settings-row">
              <div class="crm-settings-label">Mock Gmail Signature (HTML)</div>
              <textarea class="crm-settings-textarea" data-crm-testing-field="gmail_signature_html" ${!state.canManage ? 'disabled' : ''}>${esc(testing.gmail_signature_html || '')}</textarea>
            </div>
            <div class="crm-settings-row slim">
              <div>
                <div class="crm-settings-label">Mock RingCentral Route</div>
                <div class="crm-settings-note">Displayed in the CRM anywhere RingCentral connection state or sender identity is shown.</div>
              </div>
              <button class="crm-settings-icon-btn danger" type="button" data-crm-testing-action="mock_comms_reset" ${!state.canManage || state.saving ? 'disabled' : ''}>Reset Mock Data</button>
            </div>
            <div class="crm-settings-row">
              <div class="crm-settings-label">Extension Name</div>
              <input class="crm-settings-input" type="text" value="${esc(testing.ringcentral_extension_name || '')}" data-crm-testing-field="ringcentral_extension_name" ${!state.canManage ? 'disabled' : ''}>
            </div>
            <div class="crm-settings-row">
              <div class="crm-settings-label">Extension Email</div>
              <input class="crm-settings-input" type="email" value="${esc(testing.ringcentral_extension_email || '')}" data-crm-testing-field="ringcentral_extension_email" ${!state.canManage ? 'disabled' : ''}>
            </div>
            <div class="crm-settings-row">
              <div class="crm-settings-label">Default SMS Number</div>
              <input class="crm-settings-input" type="text" value="${esc(testing.ringcentral_default_sms_number || '')}" data-crm-testing-field="ringcentral_default_sms_number" ${!state.canManage ? 'disabled' : ''}>
            </div>
          </div>
        </div>
      </div>
      <div class="crm-settings-card" style="margin-top:16px">
        <div class="crm-settings-card-head"><div><h3>Inject Mock Gmail</h3><p>Create an inbound or outbound mock email, then let the normal CRM sync/association path process it.</p></div></div>
        <div class="crm-settings-card-body" data-crm-testing-form="mock_comms_inject_gmail">
          <input class="crm-settings-input" name="actor_email" type="email" placeholder="Mailbox actor email">
          <select class="crm-settings-rc-select" name="direction"><option value="in">Inbound</option><option value="out">Outbound</option></select>
          <input class="crm-settings-input" name="from_email" type="email" placeholder="From email">
          <input class="crm-settings-input" name="to_emails" type="text" placeholder="To email(s)">
          <input class="crm-settings-input" name="subject" type="text" placeholder="Subject">
          <textarea class="crm-settings-textarea" name="body_text" placeholder="Email body"></textarea>
          <div class="crm-settings-row-actions"><button class="crm-settings-icon-btn" type="button" data-crm-testing-action="mock_comms_inject_gmail" ${!state.canManage || state.saving ? 'disabled' : ''}>Inject Email</button></div>
        </div>
      </div>
      <div class="crm-settings-rc-grid" style="margin-top:16px">
        <div class="crm-settings-card">
          <div class="crm-settings-card-head"><div><h3>Inject Mock SMS</h3><p>Add a test RingCentral text and let the normal sync/matching pipeline pick it up.</p></div></div>
          <div class="crm-settings-card-body" data-crm-testing-form="mock_comms_inject_sms">
            <input class="crm-settings-input" name="actor_email" type="email" placeholder="Actor email">
            <select class="crm-settings-rc-select" name="direction"><option value="inbound">Inbound</option><option value="outbound">Outbound</option></select>
            <input class="crm-settings-input" name="from_phone" type="text" placeholder="From phone">
            <input class="crm-settings-input" name="to_phone" type="text" placeholder="To phone">
            <textarea class="crm-settings-textarea" name="body_text" placeholder="SMS body"></textarea>
            <div class="crm-settings-row-actions"><button class="crm-settings-icon-btn" type="button" data-crm-testing-action="mock_comms_inject_sms" ${!state.canManage || state.saving ? 'disabled' : ''}>Inject SMS</button></div>
          </div>
        </div>
        <div class="crm-settings-card">
          <div class="crm-settings-card-head"><div><h3>Inject Mock Call</h3><p>Create a RingCentral call record and let the lead association/disposition flow handle it normally.</p></div></div>
          <div class="crm-settings-card-body" data-crm-testing-form="mock_comms_inject_call">
            <input class="crm-settings-input" name="actor_email" type="email" placeholder="Actor email">
            <select class="crm-settings-rc-select" name="direction"><option value="inbound">Inbound</option><option value="outbound">Outbound</option></select>
            <input class="crm-settings-input" name="from_phone" type="text" placeholder="From phone">
            <input class="crm-settings-input" name="to_phone" type="text" placeholder="To phone">
            <input class="crm-settings-input" name="action" type="text" placeholder="Action" value="Phone Call">
            <input class="crm-settings-input" name="result" type="text" placeholder="Result" value="Connected">
            <input class="crm-settings-input" name="duration_seconds" type="number" placeholder="Duration seconds" value="0">
            <div class="crm-settings-row-actions"><button class="crm-settings-icon-btn" type="button" data-crm-testing-action="mock_comms_inject_call" ${!state.canManage || state.saving ? 'disabled' : ''}>Inject Call</button></div>
          </div>
        </div>
      </div>
      <div class="crm-settings-card" style="margin-top:16px">
        <div class="crm-settings-card-head"><div><h3>Inject Mock Calendar Event</h3><p>Create a mock Google Calendar event so lead scheduling, day-event loading, dashboard meetings, and cancellation sync can all be tested safely.</p></div></div>
        <div class="crm-settings-card-body" data-crm-testing-form="mock_comms_inject_calendar">
          <input class="crm-settings-input" name="actor_email" type="email" placeholder="Actor email">
          <input class="crm-settings-input" name="summary" type="text" placeholder="Event title" value="Mock Calendar Event">
          <textarea class="crm-settings-textarea" name="description" placeholder="Description"></textarea>
          <input class="crm-settings-input" name="attendees" type="text" placeholder="Attendee emails">
          <input class="crm-settings-input" name="timezone" type="text" placeholder="Timezone">
          <label class="crm-settings-row slim"><div><div class="crm-settings-label">All Day</div></div><input type="checkbox" name="all_day"></label>
          <input class="crm-settings-input" name="all_day_date" type="date">
          <input class="crm-settings-input" name="date" type="date">
          <input class="crm-settings-input" name="time" type="time" value="09:00">
          <input class="crm-settings-input" name="duration_minutes" type="number" value="30" min="15" max="480">
          <label class="crm-settings-row slim"><div><div class="crm-settings-label">Add Mock Meet Link</div></div><input type="checkbox" name="add_meet"></label>
          <div class="crm-settings-row-actions"><button class="crm-settings-icon-btn" type="button" data-crm-testing-action="mock_comms_inject_calendar" ${!state.canManage || state.saving ? 'disabled' : ''}>Inject Calendar Event</button></div>
        </div>
      </div>
      <div class="crm-settings-rc-grid" style="margin-top:16px">
        <div class="crm-settings-card"><div class="crm-settings-card-head"><div><h3>Recent Mock Emails</h3></div></div><div class="crm-settings-card-body">${renderRecentTestingRows(recent.gmail || [], 'gmail')}</div></div>
        <div class="crm-settings-card"><div class="crm-settings-card-head"><div><h3>Recent Mock Texts</h3></div></div><div class="crm-settings-card-body">${renderRecentTestingRows(recent.ringcentral_messages || [], 'sms')}</div></div>
      </div>
      <div class="crm-settings-rc-grid" style="margin-top:16px">
        <div class="crm-settings-card"><div class="crm-settings-card-head"><div><h3>Recent Mock Calls</h3></div></div><div class="crm-settings-card-body">${renderRecentTestingRows(recent.ringcentral_calls || [], 'call')}</div></div>
        <div class="crm-settings-card"><div class="crm-settings-card-head"><div><h3>Recent Mock Calendar Events</h3></div></div><div class="crm-settings-card-body">${renderRecentTestingRows(recent.calendar_events || [], 'calendar')}</div></div>
      </div>
    `;
  }

  function render(){
    const mount = document.getElementById('view-settings');
    if (!mount) return;
    ensureActiveTab();
    const tabs = visibleTabs();
    const currentTabEditable = canManageTab(state.activeTab);
    const canSaveCurrentTab = currentTabEditable || (state.activeTab === 'connection' && state.ringcentral.canManage) || (state.activeTab === 'testing' && state.canManage);
    if (state.loading) {
      mount.innerHTML = '<div class="crm-settings-empty" style="margin-top:12px">Loading CRM settings...</div>';
      return;
    }
    mount.innerHTML = `
      <div class="crm-settings-shell">
        <div class="crm-settings-head">
          <div class="crm-settings-head-copy">
            <h2>Settings</h2>
            <p>Manage the company-wide SMS templates, email templates, shared call disposition list, and RingCentral routing used throughout the CRM. Choosing <strong>Do Not Contact</strong> on a RingCentral call will flag that lead as DNC.</p>
          </div>
          <div class="crm-settings-actions">
            <button class="crm-settings-btn secondary" type="button" data-crm-settings-refresh>Refresh</button>
            <button class="crm-settings-btn primary" type="button" data-crm-settings-save ${(!canSaveCurrentTab || state.saving) ? 'disabled' : ''}>${state.saving ? 'Saving...' : 'Save Settings'}</button>
          </div>
        </div>
        ${state.error ? `<div class="crm-settings-status error">${esc(state.error)}</div>` : `<div class="crm-settings-status">${state.activeTab === 'connection' ? (state.ringcentral.canManage ? 'Manager mode: RingCentral mappings save company-wide. Gmail disconnect applies to your connected CRM account.' : 'Google connection controls for your CRM account.') : state.activeTab === 'testing' ? (state.canManage ? 'Manager mode: testing changes apply server-wide and block real Gmail and RingCentral sends.' : 'Read-only mode.') : (currentTabEditable ? 'Manager mode: changes save company-wide.' : 'Read-only mode.')}</div>`}
        <div class="crm-settings-tabs">
          ${tabs.includes('sms') ? `<button class="crm-settings-tab ${state.activeTab === 'sms' ? 'active' : ''}" type="button" data-crm-settings-tab="sms">SMS Templates</button>` : ''}
          ${tabs.includes('email') ? `<button class="crm-settings-tab ${state.activeTab === 'email' ? 'active' : ''}" type="button" data-crm-settings-tab="email">Email Templates</button>` : ''}
          ${tabs.includes('disposition') ? `<button class="crm-settings-tab ${state.activeTab === 'disposition' ? 'active' : ''}" type="button" data-crm-settings-tab="disposition">Call Dispositions</button>` : ''}
          ${tabs.includes('connection') ? `<button class="crm-settings-tab ${state.activeTab === 'connection' ? 'active' : ''}" type="button" data-crm-settings-tab="connection">Connections</button>` : ''}
          ${tabs.includes('testing') ? `<button class="crm-settings-tab ${state.activeTab === 'testing' ? 'active' : ''}" type="button" data-crm-settings-tab="testing">Testing</button>` : ''}
        </div>
        <section class="crm-settings-workspace">
          <div class="crm-settings-workspace-head">
            <div class="crm-settings-workspace-copy">
              <h3>${esc(activeTabMeta().title)}</h3>
              <p>${esc(activeTabMeta().copy)}</p>
            </div>
            ${activeTabMeta().addKey ? `<button class="crm-settings-icon-btn" type="button" data-crm-settings-add="${esc(activeTabMeta().addKey)}" ${!currentTabEditable ? 'disabled' : ''}>${esc(activeTabMeta().addLabel)}</button>` : `<button class="crm-settings-icon-btn" type="button" data-crm-settings-refresh>Refresh</button>`}
          </div>
          <div class="crm-settings-card-body">
            <div class="crm-settings-tab-panel ${state.activeTab === 'sms' ? 'active' : ''}">
              ${renderSmsRows()}
            </div>
            <div class="crm-settings-tab-panel ${state.activeTab === 'email' ? 'active' : ''}">
              ${renderEmailRows()}
            </div>
            <div class="crm-settings-tab-panel ${state.activeTab === 'disposition' ? 'active' : ''}">
              ${renderDispositionRows()}
              <div class="crm-settings-foot" style="margin-top:12px">
                <div class="crm-settings-note">RingCentral calls in lead history autosave the selected disposition and call notes. Choosing <strong>Do Not Contact</strong> marks the lead as DNC automatically.</div>
              </div>
            </div>
            <div class="crm-settings-tab-panel ${state.activeTab === 'connection' ? 'active' : ''}">
              ${renderRingCentralPanel()}
            </div>
            <div class="crm-settings-tab-panel ${state.activeTab === 'testing' ? 'active' : ''}">
              ${renderTestingPanel()}
            </div>
          </div>
        </section>
      </div>
    `;
    bind(mount);
  }

  window.CrmSettingsTab = {
    init(){
      if (state.initialized) return;
      state.initialized = true;
      ensureStyles();
      load();
    },
    openTab,
    getCurrentSettings(){
      return normalizeSettings(state.settings);
    },
    async onShow(){
      ensureStyles();
      if (!state.initialized) state.initialized = true;
      await load();
    }
  };

  window.addEventListener('firstmate-open-settings-tab', (event) => {
    const tab = event?.detail?.tab || 'sms';
    openTab(tab);
  });
})();
