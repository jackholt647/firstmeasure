(function(root){
  'use strict';

  const esc = (value) => String(value ?? '').replace(/[&<>"']/g, (char) => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[char]));
  const uid = (prefix) => `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2,8)}`;
  const clone = (value) => JSON.parse(JSON.stringify(value));
  const terminology = (key, fallback) => root.Portal?.terminology?.get?.(key, fallback) || fallback;
  const array = (value) => Array.isArray(value) ? value : [];
  const object = (value) => value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  const text = (...values) => String(values.find((value) => value != null && String(value).trim()) ?? '').trim();
  const uniqueIds = (value) => [...new Set(array(value).map((item) => text(item?.id, item)).filter(Boolean))];
  const records = (result, ...keys) => {
    for (const key of keys) {
      if (Array.isArray(result?.[key])) return result[key];
      if (Array.isArray(result?.data?.[key])) return result.data[key];
      if (Array.isArray(result?.configuration?.[key])) return result.configuration[key];
    }
    return Array.isArray(result) ? result : [];
  };

  function injectCss(){
    if (document.getElementById('fmCrmSettingsCss')) return;
    const style = document.createElement('style');
    style.id = 'fmCrmSettingsCss';
    style.textContent = `
      .crm-settings{color:#17212b;min-height:640px}.crm-subtabs{display:flex;gap:4px;border-bottom:1px solid #e3e7ec;margin:-4px 0 22px}.crm-subtab{appearance:none;border:0;border-bottom:3px solid transparent;background:transparent;padding:11px 14px 10px;font:900 13px/1 inherit;color:#697586;cursor:pointer}.crm-subtab.active{color:#18222d;border-bottom-color:var(--primary-readable,var(--primary,#d93025))}
      .crm-option-grid{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:9px}.crm-option{appearance:none;border:1px solid #d6dce3;border-radius:8px;background:#fff;padding:12px;text-align:left;display:flex;flex-direction:column;gap:4px;cursor:pointer;color:#263442}.crm-option strong{font-size:12px}.crm-option span{font-size:10.5px;line-height:1.35;color:#697586}.crm-option.active{border-color:var(--primary-readable,var(--primary,#d93025));background:rgba(var(--primary-rgb,217,48,37),.05);box-shadow:0 0 0 2px rgba(var(--primary-rgb,217,48,37),.10)}.crm-option.active strong{color:var(--primary-readable,var(--primary,#d93025))}.crm-pill-options{display:flex;flex-wrap:wrap;gap:8px}.crm-pill-option{appearance:none;border:1px solid #ccd4dd;border-radius:999px;background:#fff;color:#526171;padding:8px 11px;font:900 11px/1 inherit;cursor:pointer}.crm-pill-option.active{border-color:var(--primary-readable,var(--primary,#d93025));background:var(--primary-readable,var(--primary,#d93025));color:#fff}.crm-settings-block{border:1px solid #dde2e8;border-radius:8px;background:#fff;padding:18px;margin-bottom:14px}.crm-settings-block h4{font-size:16px;margin:0 0 5px}.crm-settings-block>p{font-size:12px;color:#697586;margin:0 0 14px;line-height:1.45}
      .crm-head{display:flex;align-items:flex-end;justify-content:space-between;gap:18px;margin-bottom:18px}.crm-head h3{font-size:22px;line-height:1.15;margin:0 0 5px}.crm-head p{margin:0;color:#697586;font-size:13px}.crm-head-actions{display:flex;align-items:center;gap:8px;flex-shrink:0}.crm-btn{appearance:none;border:1px solid #d6dce3;background:#fff;color:#263442;border-radius:7px;padding:9px 12px;font:900 12px/1 inherit;cursor:pointer}.crm-btn:hover{background:#f7f9fb}.crm-btn.primary{border-color:var(--primary-readable,var(--primary,#d93025));background:var(--primary-readable,var(--primary,#d93025));color:#fff}.crm-btn.danger{color:#b42318}.crm-icon{width:34px;height:34px;padding:0;display:inline-flex;align-items:center;justify-content:center}.crm-status{font-size:12px;font-weight:800;color:#697586;min-height:16px}
      .crm-board-fields{display:grid;grid-template-columns:minmax(220px,1fr) 72px minmax(280px,2fr);gap:12px;margin-bottom:18px}.crm-field{display:flex;flex-direction:column;gap:6px;min-width:0}.crm-field>span{font-size:11px;font-weight:950;color:#526171}.crm-input,.crm-select,.crm-textarea{box-sizing:border-box;width:100%;border:1px solid #ccd4dd;border-radius:6px;background:#fff;color:#18222d;padding:9px 10px;font:800 13px/1.3 inherit;outline:none}.crm-input:focus,.crm-select:focus,.crm-textarea:focus{border-color:var(--primary-readable,var(--primary,#d93025));box-shadow:0 0 0 2px rgba(var(--primary-rgb,217,48,37),.11)}.crm-textarea{min-height:72px;resize:vertical}.crm-color{width:100%;height:37px;padding:3px;border:1px solid #ccd4dd;border-radius:6px;background:#fff}
      .crm-workspace{display:grid;grid-template-columns:300px minmax(0,1fr);border:1px solid #dde2e8;min-height:500px;background:#fff}.crm-stage-rail{border-right:1px solid #dde2e8;background:#f5f7f9;display:flex;flex-direction:column;min-width:0}.crm-rail-head{display:flex;align-items:center;justify-content:space-between;padding:13px 14px;border-bottom:1px solid #dde2e8}.crm-rail-head strong{font-size:13px}.crm-stage-list{padding:7px;display:flex;flex-direction:column;gap:3px}.crm-stage{appearance:none;border:1px solid transparent;background:transparent;border-radius:6px;padding:10px;display:grid;grid-template-columns:5px minmax(0,1fr) auto;gap:10px;text-align:left;cursor:pointer}.crm-stage:hover{background:#fff}.crm-stage.active{background:#fff;border-color:#d8dee5;box-shadow:0 2px 7px rgba(15,23,42,.06)}.crm-stage-color{border-radius:4px;background:var(--stage-color)}.crm-stage-name{font-size:13px;font-weight:950;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.crm-stage-meta{font-size:10px;font-weight:800;color:#7b8794;margin-top:3px}.crm-stage-order{display:flex;gap:2px}.crm-stage-order button{border:0;background:transparent;width:24px;height:24px;color:#7b8794;cursor:pointer}.crm-stage-order button:hover{color:#17212b}
      .crm-editor{padding:20px;min-width:0}.crm-editor-top{display:flex;justify-content:space-between;gap:16px;margin-bottom:18px}.crm-editor-top h4{font-size:17px;margin:0}.crm-stage-fields{display:grid;grid-template-columns:minmax(200px,1fr) 72px;gap:12px;flex:1}.crm-section{border-top:1px solid #e4e8ed;padding-top:17px;margin-top:17px}.crm-section-head{display:flex;align-items:center;justify-content:space-between;margin-bottom:10px}.crm-section-head h5{font-size:14px;margin:0}.crm-section-head span{font-size:11px;color:#7b8794}.crm-row{border:1px solid #dde2e8;border-radius:6px;padding:11px;margin-bottom:8px;background:#fbfcfd}.crm-row-head{display:flex;align-items:center;gap:8px;margin-bottom:9px}.crm-row-head strong{font-size:12px;flex:1}.crm-grid-2{display:grid;grid-template-columns:1fr 1fr;gap:9px}.crm-grid-3{display:grid;grid-template-columns:1fr 1fr 110px;gap:9px}.crm-check{display:flex;align-items:center;gap:7px;font-size:11px;font-weight:850;color:#526171;padding-top:24px}.crm-empty{padding:22px;text-align:center;color:#7b8794;font-size:12px;border:1px dashed #ccd4dd;border-radius:6px}.crm-hint{font-size:10px;color:#7b8794;margin-top:6px}.crm-error{padding:28px;text-align:center;color:#b42318;font-weight:850}
      @media(max-width:900px){.crm-workspace{grid-template-columns:1fr}.crm-stage-rail{border-right:0;border-bottom:1px solid #dde2e8}.crm-stage-list{display:grid;grid-template-columns:repeat(2,minmax(0,1fr))}.crm-board-fields{grid-template-columns:1fr 70px}.crm-board-fields .crm-field:last-child{grid-column:1/-1}.crm-option-grid{grid-template-columns:1fr}}@media(max-width:620px){.crm-head{align-items:stretch;flex-direction:column}.crm-head-actions{justify-content:flex-end}.crm-stage-list,.crm-grid-2,.crm-grid-3,.crm-stage-fields{grid-template-columns:1fr}.crm-editor{padding:14px}.crm-board-fields{grid-template-columns:1fr}.crm-board-fields .crm-field:last-child{grid-column:auto}}
    `;
    style.textContent += `
      .crm-call-page{display:grid;gap:16px}.crm-call-page *{box-sizing:border-box}.crm-call-top{display:flex;align-items:flex-start;justify-content:space-between;gap:16px}.crm-call-kicker{margin-bottom:5px;color:#667085;font-size:10px;font-weight:950;letter-spacing:.08em;text-transform:uppercase}.crm-call-top h3{margin:0;font-size:24px;line-height:1.15;letter-spacing:-.02em}.crm-call-top p{max-width:700px;margin:6px 0 0;color:#667085;font-size:12px;line-height:1.5}.crm-call-actions{display:flex;gap:8px;flex-wrap:wrap;justify-content:flex-end}.crm-call-stats{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:9px}.crm-call-stat{position:relative;overflow:hidden;border:1px solid #e4e7ec;border-radius:11px;background:#fff;padding:13px 14px;box-shadow:0 1px 2px rgba(16,24,40,.03)}.crm-call-stat:before{content:'';position:absolute;inset:0 auto 0 0;width:3px;background:#98a2b3}.crm-call-stat.active:before{background:#12b76a}.crm-call-stat.waiting:before{background:#2e90fa}.crm-call-stat.routed:before{background:#7f56d9}.crm-call-stat span{display:block;color:#667085;font-size:10px;font-weight:850}.crm-call-stat strong{display:block;margin-top:5px;font-size:22px;line-height:1;font-weight:950;font-variant-numeric:tabular-nums}
      .crm-call-workspace{display:grid;grid-template-columns:minmax(280px,340px) minmax(0,1fr);min-height:570px;border:1px solid #e4e7ec;border-radius:13px;background:#fff;overflow:hidden;box-shadow:0 1px 3px rgba(16,24,40,.04)}.crm-call-rail{display:flex;min-width:0;flex-direction:column;border-right:1px solid #e4e7ec;background:#f8fafc}.crm-call-rail-head{display:grid;gap:9px;padding:13px;border-bottom:1px solid #e4e7ec}.crm-call-rail-title{display:flex;align-items:center;justify-content:space-between;gap:8px}.crm-call-rail-title strong{font-size:12px}.crm-call-rail-title span{color:#667085;font-size:10px;font-weight:850}.crm-call-search{position:relative;display:flex;align-items:center}.crm-call-search i{position:absolute;left:11px;color:#98a2b3;font-size:11px}.crm-call-search input{width:100%;height:36px;border:1px solid #d0d5dd;border-radius:9px;background:#fff;padding:0 10px 0 32px;color:#344054;font-size:11px;font-weight:750;outline:0}.crm-call-search input:focus{border-color:var(--primary-readable,var(--primary,#d93025));box-shadow:0 0 0 3px rgba(var(--primary-rgb,217,48,37),.09)}.crm-call-list{display:grid;gap:5px;padding:8px;overflow:auto;align-content:start}.crm-call-list-item{display:grid;grid-template-columns:36px minmax(0,1fr) auto;gap:9px;align-items:center;border:1px solid transparent;border-radius:10px;background:transparent;padding:9px;text-align:left;cursor:pointer}.crm-call-list-item:hover{border-color:#e4e7ec;background:#fff}.crm-call-list-item.active{border-color:#d0d5dd;background:#fff;box-shadow:0 1px 3px rgba(16,24,40,.08)}.crm-call-list-icon{display:grid;place-items:center;flex:0 0 auto;width:36px;height:36px;border-radius:9px;background:#eef4ff;color:#3538cd}.crm-call-list-item[data-tone="customer"] .crm-call-list-icon{background:#ecfdf3;color:#067647}.crm-call-list-item[data-tone="followup"] .crm-call-list-icon{background:#f4ebff;color:#6941c6}.crm-call-list-item[data-tone="production"] .crm-call-list-icon{background:#fff4ed;color:#c4320a}.crm-call-list-copy{min-width:0}.crm-call-list-copy strong{display:block;overflow:hidden;color:#344054;font-size:12px;text-overflow:ellipsis;white-space:nowrap}.crm-call-list-copy span{display:block;margin-top:3px;overflow:hidden;color:#667085;font-size:9px;font-weight:750;text-overflow:ellipsis;white-space:nowrap}.crm-call-count{display:grid;place-items:center;min-width:27px;height:23px;border-radius:999px;background:#eaecf0;padding:0 7px;color:#475467;font-size:9px;font-weight:950}.crm-call-count.has-calls{background:#eff8ff;color:#175cd3}
      .crm-call-editor{min-width:0;padding:20px;overflow:auto}.crm-call-empty{display:grid;place-items:center;min-height:430px;text-align:center;color:#667085}.crm-call-empty i{font-size:30px;color:#d0d5dd}.crm-call-empty strong{display:block;margin-top:11px;color:#344054;font-size:14px}.crm-call-empty span{display:block;max-width:380px;margin-top:5px;font-size:11px;line-height:1.45}.crm-call-editor-head{display:flex;align-items:flex-start;justify-content:space-between;gap:14px;padding-bottom:16px;border-bottom:1px solid #eaecf0}.crm-call-editor-title{display:flex;gap:11px;min-width:0}.crm-call-editor-title h4{margin:0;color:#101828;font-size:18px}.crm-call-editor-title p{margin:4px 0 0;color:#667085;font-size:10px;line-height:1.4}.crm-call-switch-row{display:flex;align-items:center;gap:9px;color:#475467;font-size:10px;font-weight:900}.crm-call-switch{position:relative;width:42px;height:24px;border:0;border-radius:999px;background:#d0d5dd;padding:0;cursor:pointer}.crm-call-switch:after{content:'';position:absolute;width:18px;height:18px;left:3px;top:3px;border-radius:50%;background:#fff;box-shadow:0 1px 3px rgba(15,23,42,.25);transition:.16s ease}.crm-call-switch.on{background:#12b76a}.crm-call-switch.on:after{transform:translateX(18px)}.crm-call-section{display:grid;gap:11px;padding:17px 0;border-bottom:1px solid #eaecf0}.crm-call-section-head{display:flex;align-items:flex-start;justify-content:space-between;gap:12px}.crm-call-section-head strong{display:block;color:#344054;font-size:12px}.crm-call-section-head span{display:block;margin-top:3px;color:#667085;font-size:9.5px;line-height:1.4}.crm-call-form-grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:10px}.crm-call-form-grid .wide{grid-column:1/-1}.crm-call-field{display:grid;gap:6px;min-width:0}.crm-call-field>span{color:#475467;font-size:10px;font-weight:900}.crm-call-field input,.crm-call-field select,.crm-call-field textarea{width:100%;border:1px solid #d0d5dd;border-radius:8px;background:#fff;padding:9px 10px;color:#344054;font:750 12px/1.4 inherit;outline:0}.crm-call-field input,.crm-call-field select{height:39px}.crm-call-field textarea{min-height:70px;resize:vertical}.crm-call-field input:focus,.crm-call-field select:focus,.crm-call-field textarea:focus{border-color:var(--primary-readable,var(--primary,#d93025));box-shadow:0 0 0 3px rgba(var(--primary-rgb,217,48,37),.09)}.crm-call-field input[readonly]{background:#f8fafc;color:#667085}
      .crm-call-visual-row{display:flex;align-items:center;gap:5px;flex-wrap:nowrap;min-height:36px}.crm-call-visual-option{position:relative;display:grid;place-items:center;flex:0 0 35px;width:35px;height:35px;border:1px solid #d0d5dd;border-radius:9px;background:#fff;color:#667085;font-size:13px;cursor:pointer}.crm-call-visual-option:hover{border-color:#98a2b3;color:#344054}.crm-call-visual-option.selected{border-color:var(--primary-readable,var(--primary,#d93025));background:rgba(var(--primary-rgb,217,48,37),.05);color:var(--primary-readable,var(--primary,#d93025));box-shadow:0 0 0 2px rgba(var(--primary-rgb,217,48,37),.10)}.crm-call-visual-option.tone{border-radius:999px;background:var(--call-tone);box-shadow:inset 0 0 0 3px #fff,0 0 0 1px #d0d5dd}.crm-call-visual-option.tone.selected{border-color:#fff;box-shadow:inset 0 0 0 3px #fff,0 0 0 3px var(--call-tone)}.crm-call-visual-option.tone.selected:after{content:'\f00c';color:#fff;font-family:'Font Awesome 6 Free';font-size:10px;font-weight:900;text-shadow:0 1px 2px rgba(0,0,0,.28)}
      .crm-call-modes{display:flex;gap:7px;flex-wrap:wrap}.crm-call-mode,.crm-call-chip{border:1px solid #d0d5dd;border-radius:999px;background:#fff;padding:7px 10px;color:#475467;font-size:9.5px;font-weight:900;cursor:pointer}.crm-call-mode.active,.crm-call-chip.selected{border-color:#84adff;background:#eef4ff;color:#3538cd;box-shadow:0 0 0 1px #d1e0ff}.crm-call-choice-group{display:grid;gap:7px}.crm-call-choice-label{color:#667085;font-size:9px;font-weight:950;text-transform:uppercase;letter-spacing:.04em}.crm-call-chips{display:flex;gap:6px;flex-wrap:wrap}.crm-call-origin{display:grid;grid-template-columns:36px minmax(0,1fr) auto;gap:10px;align-items:center;border:1px solid #e4e7ec;border-radius:10px;background:#f8fafc;padding:11px}.crm-call-origin>i{display:grid;place-items:center;width:36px;height:36px;border-radius:9px;background:#fff;color:#667085}.crm-call-origin strong{display:block;color:#344054;font-size:11px}.crm-call-origin span{display:block;margin-top:3px;color:#667085;font-size:9px;line-height:1.4}.crm-call-key{border:0;border-radius:6px;background:#eaecf0;padding:6px 8px;color:#475467;font:850 9px/1 monospace;cursor:pointer}.crm-call-flow{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:8px}.crm-call-flow-step{border:1px solid #e4e7ec;border-radius:9px;background:#fff;padding:10px}.crm-call-flow-step i{color:#667085}.crm-call-flow-step strong{display:block;margin-top:7px;color:#344054;font-size:10px}.crm-call-flow-step span{display:block;margin-top:3px;color:#667085;font-size:9px;line-height:1.4}.crm-call-editor-actions{display:flex;align-items:center;justify-content:space-between;gap:12px;padding-top:16px}.crm-call-status{min-height:15px;color:#667085;font-size:10px;font-weight:850}.crm-call-loading{display:grid;place-items:center;min-height:520px;color:#667085;font-size:12px;font-weight:850}.crm-call-error{border:1px solid #fecdca;border-radius:10px;background:#fef3f2;padding:12px;color:#b42318;font-size:11px}
      @media(max-width:980px){.crm-call-top{align-items:stretch;flex-direction:column}.crm-call-top>.crm-call-actions{width:100%;justify-content:flex-start}.crm-call-top>.crm-call-actions .crm-btn{flex:1}.crm-call-workspace{grid-template-columns:1fr}.crm-call-rail{max-height:310px;border-right:0;border-bottom:1px solid #e4e7ec}.crm-call-list{grid-template-columns:repeat(2,minmax(0,1fr))}.crm-call-stats{grid-template-columns:repeat(2,minmax(0,1fr))}}@media(max-width:680px){.crm-call-editor-head,.crm-call-editor-actions{align-items:stretch;flex-direction:column}.crm-call-actions{width:100%;justify-content:stretch}.crm-call-actions .crm-btn{flex:1}.crm-call-list,.crm-call-form-grid,.crm-call-flow{grid-template-columns:1fr}.crm-call-form-grid .wide{grid-column:auto}.crm-call-editor{padding:14px}.crm-call-switch-row{justify-content:space-between}.crm-call-editor-actions .crm-call-actions .crm-btn{flex:1}}
    `;
    document.head.appendChild(style);
  }

  function mount(host, options = {}){
    if (!host || host.dataset.crmMounted === '1') return;
    host.dataset.crmMounted = '1';
    injectCss();
    const allViews = ['stages','calls','projects','misc'];
    const allowedViews = Array.isArray(options.views) ? options.views.filter((view) => allViews.includes(view)) : allViews;
    const fixedView = allViews.includes(options.fixedView) ? options.fixedView : '';
    const defaultView = fixedView || allowedViews[0] || 'calls';
    const routeSub = String(options.routeSub || 'crm').trim() || 'crm';
    const routedView = String(root.Portal?.navigation?.read?.()?.settingsView || '').trim();
    const state = {
      config:null,
      followUps:null,
      projectConfig:null,
      selected:0,
      saving:false,
      subtab:fixedView || (allowedViews.includes(routedView) ? routedView : defaultView),
      callLists:[],
      callRoles:[],
      callUsers:[],
      callSelectedKey:'',
      callDraft:null,
      callSearch:'',
      callLoaded:false,
      callLoading:null,
      callSaving:false
    };
    host.innerHTML = `<div class="crm-settings"><div class="crm-error"><i class="fas fa-spinner fa-spin"></i>${(globalThis.PlatformLanguage?.text("settings","m_2bc82e9f77e1eb"," Loading settings") ?? " Loading settings")}</div></div>`;
    const orgId = options.orgId;
    const branchId = options.branchId || 'default';
    const toast = options.showToast || (() => {});
    function setSubtab(next, options = {}){
      const value = allowedViews.includes(next) ? next : defaultView;
      state.subtab = value;
      if (!fixedView && options.updateRoute !== false && !root.Portal?.navigation?.applying) {
        root.Portal?.navigation?.push?.({ tab:'company_settings', sub:routeSub, settingsView:value, settingsEntity:'' }, { source:'settings-view', ownedKeys:['settingsView'] });
      }
      render();
    }
    if (!fixedView && allowedViews.includes('calls')) root.addEventListener('fm:crm-settings:open-calls', () => setSubtab('calls'));

    const PROJECT_PILL_FIELDS = [
      ['scope_type','Scope type'], ['stage','Stage'], ['dollar_value','Dollar value'], ['start_date','Start date'],
      ['end_date','End date'], ['customer','Customer'], ['address','Address'], ['owner','Project owner'],
      ['project_type','Project type'], ['created_date','Created date'], ['updated_date','Last updated'], ['project_number','Project number']
    ];
    const DEFAULT_PROJECT_PILLS = ['scope_type','stage','dollar_value'];
    function normalizedProjectConfig(value = {}){
      const mode = String(value?.title_mode || 'customer_name');
      const celebrationMode = String(value?.celebrations_mode || value?.celebrations?.mode || 'on');
      return { ...(value || {}), title_mode:['customer_name','address','manual'].includes(mode) ? mode : 'customer_name', celebrations_mode:['on','small_only','off'].includes(celebrationMode) ? celebrationMode : 'on', project_header_pills:Array.isArray(value?.project_header_pills) ? value.project_header_pills.filter((item) => PROJECT_PILL_FIELDS.some(([id]) => id === item)) : [...DEFAULT_PROJECT_PILLS] };
    }
    function subTabs(){
      if (fixedView || allowedViews.length < 2) return '';
      const labels = { stages:terminology('crm.stages_view','Sales pipeline'), calls:'Calls', projects:terminology('crm.projects_view','Projects'), misc:'Celebrations' };
      return `<div class="crm-subtabs">${allowedViews.map((id) => `<button class="crm-subtab ${state.subtab===id?'active':''}" data-crm-subtab="${id}" type="button">${esc(labels[id])}</button>`).join('')}</div>`;
    }
    function bindSubTabs(){ host.querySelectorAll('[data-crm-subtab]').forEach(button => button.addEventListener('click', () => setSubtab(button.dataset.crmSubtab))); }

    function field(label, content){ return `<label class="crm-field"><span>${esc(label)}</span>${content}</label>`; }
    function callApiBase(){
      return String(root.Portal?.cfg?.endpoints?.crm || '/v1/internal/crm').replace(/\/$/, '');
    }
    async function callApi(path, options = {}){
      const csrf=document.cookie.match(/(?:^|;\s*)fm_platform_session_csrf=([^;]+)/)?.[1];
      const response = await fetch(`${callApiBase()}${path}`, {
        credentials:'include',
        ...options,
        headers:{ Accept:'application/json', ...(options.body ? { 'Content-Type':'application/json' } : {}), ...(csrf&&options.method&&options.method!=='GET'?{'X-Platform-CSRF':decodeURIComponent(csrf)}:{}),...(options.headers || {}) }
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok || data?.ok === false) throw new Error(data?.message || data?.error || 'Could not update call lists.');
      return data;
    }
    function callListDraft(value = {}){
      const source = object(value);
      return {
        ...clone(source),
        key:text(source.key),
        title:text(source.title),
        description:text(source.description),
        kind:text(source.kind, 'general'),
        icon:text(source.icon, 'fa-phone'),
        tone:text(source.tone, 'default'),
        status:text(source.status, 'active'),
        sort_order:Number(source.sort_order || 0),
        assigned_user_ids:uniqueIds(source.assigned_user_ids),
        assigned_role_ids:uniqueIds(source.assigned_role_ids),
        metadata:object(source.metadata)
      };
    }
    function callKindLabel(kind){
      return ({ lead:'Lead intake', follow_up:'Scheduled follow-up', signature:'Signed customer', production:'Production', customer:'Customer care', general:'General' })[text(kind)] || text(kind).replace(/[_-]+/g, ' ') || 'General';
    }
    function callAssignmentLabel(list){
      const users = array(list?.assigned_user_ids).length;
      const roles = array(list?.assigned_role_ids).length;
      if (!users && !roles) return 'Everyone with Calls access';
      return [roles ? `${roles} role${roles === 1 ? '' : 's'}` : '', users ? `${users} person${users === 1 ? '' : 's'}` : ''].filter(Boolean).join(' or ');
    }
    function flattenedRecord(value){ return { ...object(value?.data), ...object(value) }; }
    async function loadCallLists(options = {}){
      if (state.callLoaded && !options.refresh) return;
      if (state.callLoading && !options.refresh) return state.callLoading;
      state.callLoading = Promise.all([
        callApi(`/organizations/${encodeURIComponent(orgId)}/call-lists`),
        Promise.resolve(root.PlatformAPI?.workforce?.accessCatalog?.(orgId) || { roles:[] }).catch(() => ({ roles:[] })),
        Promise.resolve(root.PlatformAPI?.workforce?.users?.(orgId, branchId) || { users:[] }).catch(() => ({ users:[] }))
      ]).then(([listResult, roleResult, userResult]) => {
        state.callLists = records(listResult, 'call_lists').map(callListDraft);
        state.callRoles = records(roleResult, 'roles', 'access_roles').map(flattenedRecord).filter((role) => text(role.status, 'active') !== 'archived');
        state.callUsers = records(userResult, 'users', 'workforce_users', 'profiles').map(flattenedRecord).filter((user) => text(user.status).toLowerCase() !== 'disabled');
        state.callLoaded = true;
        const routeEntity = text(root.Portal?.navigation?.read?.()?.settingsEntity);
        const routeKey = routeEntity.startsWith('call-list:') ? routeEntity.slice(10) : '';
        if (routeKey === 'new') {
          state.callSelectedKey = '__new__';
          state.callDraft = callListDraft({ status:'active', kind:'general', icon:'fa-phone', tone:'default', sort_order:(state.callLists.length + 1) * 10, metadata:{ created_from:'crm_settings' } });
          return;
        }
        const selected = state.callLists.find((list) => list.key === (state.callSelectedKey || routeKey)) || state.callLists.find((list) => list.status === 'active') || state.callLists[0];
        state.callSelectedKey = selected?.key || '';
        state.callDraft = selected ? callListDraft(selected) : null;
      }).finally(() => { state.callLoading = null; });
      return state.callLoading;
    }
    function callRoleChoices(draft){
      return state.callRoles.map((role) => {
        const id = text(role.id, role.role_id);
        const label = text(role.label, role.name, role.title, id);
        return id ? `<button class="crm-call-chip ${draft.assigned_role_ids.includes(id) ? 'selected' : ''}" type="button" data-call-role="${esc(id)}">${esc(label)}</button>` : '';
      }).join('') || `<span class="crm-hint">${(globalThis.PlatformLanguage?.text("settings","m_a50a98dc11ce7c","No access roles are configured yet. Role IDs can still be entered below.") ?? "No access roles are configured yet. Role IDs can still be entered below.")}</span>`;
    }
    function callUserChoices(draft){
      return state.callUsers.slice(0, 60).map((user) => {
        const id = text(user.id, user.user_id);
        const label = text(user.name, user.display_name, user.full_name, user.email, id);
        return id ? `<button class="crm-call-chip ${draft.assigned_user_ids.includes(id) ? 'selected' : ''}" type="button" data-call-user="${esc(id)}" title="${esc(text(user.email))}">${esc(label)}</button>` : '';
      }).join('') || `<span class="crm-hint">${(globalThis.PlatformLanguage?.text("settings","m_f019015e9b8cac","No active people were found.") ?? "No active people were found.")}</span>`;
    }
    function callEditorMarkup(){
      const draft = state.callDraft;
      if (!draft) return `<div class="crm-call-empty"><div><i class="fas fa-list-check"></i><strong>${(globalThis.PlatformLanguage?.text("settings","m_0e77465d2df6c0","Select a call list") ?? "Select a call list")}</strong><span>${(globalThis.PlatformLanguage?.text("settings","m_463f28d47865a2","Choose a list to control who sees it and how it appears in Calls.") ?? "Choose a list to control who sees it and how it appears in Calls.")}</span></div></div>`;
      const isNew = state.callSelectedKey === '__new__';
      const managed = text(draft.metadata?.managed_by) === 'scope_automation' || text(draft.kind) === 'signature';
      const restricted = draft.assigned_role_ids.length || draft.assigned_user_ids.length;
      return `<div class="crm-call-editor-head"><div class="crm-call-editor-title"><span class="crm-call-list-icon"><i class="fas ${String(esc(draft.icon || 'fa-phone'))}"></i></span><div><h4>${String(esc(draft.title || 'New call list'))}</h4><p>${String(isNew ? 'Create an organization-wide queue.' : `${Number(draft.pending_count || 0)} pending call${Number(draft.pending_count || 0) === 1 ? '' : 's'} · ${esc(callAssignmentLabel(draft))}`)}</p></div></div><div class="crm-call-switch-row"><span>${String(draft.status === 'active' ? 'Active' : 'Inactive')}</span><button class="crm-call-switch ${String(draft.status === 'active' ? 'on' : '')}" type="button" data-call-active aria-label="${(globalThis.PlatformLanguage?.text("settings","m_058412d3e429ee","Toggle list status") ?? "Toggle list status")}" aria-pressed="${String(draft.status === 'active')}"></button></div></div>
        <section class="crm-call-section"><div class="crm-call-section-head"><div><strong>${(globalThis.PlatformLanguage?.text("settings","m_4939d2238bc1e0","List details") ?? "List details")}</strong><span>${(globalThis.PlatformLanguage?.text("settings","m_ab20966c7dc4ac","The name and appearance callers see in the Calls tab.") ?? "The name and appearance callers see in the Calls tab.")}</span></div></div><div class="crm-call-form-grid">
          <label class="crm-call-field"><span>${(globalThis.PlatformLanguage?.text("settings","m_48a52dec920f8b","List name") ?? "List name")}</span><input data-call-field="title" value="${String(esc(draft.title))}" placeholder="${(globalThis.PlatformLanguage?.text("settings","m_6c62aae02ca220","Mid-project check-ins") ?? "Mid-project check-ins")}"></label>
          <label class="crm-call-field"><span>${(globalThis.PlatformLanguage?.text("settings","m_cab566faf07d28","List key") ?? "List key")}</span><input data-call-field="key" value="${String(esc(draft.key))}" placeholder="${(globalThis.PlatformLanguage?.text("settings","m_999150047f9ffd","mid_project_checkins") ?? "mid_project_checkins")}" ${String(isNew ? '' : 'readonly')}></label>
          <label class="crm-call-field wide"><span>${(globalThis.PlatformLanguage?.text("settings","m_aa136ecb65672f","Description") ?? "Description")}</span><textarea data-call-field="description" placeholder="${(globalThis.PlatformLanguage?.text("settings","m_bc621d59c73e9f","Explain when a call belongs here.") ?? "Explain when a call belongs here.")}">${String(esc(draft.description))}</textarea></label>
          <label class="crm-call-field"><span>${(globalThis.PlatformLanguage?.text("settings","m_64d67127744574","Call type") ?? "Call type")}</span><select data-call-field="kind">${String([['lead','Lead intake'],['follow_up','Scheduled follow-up'],['signature','Signed customer'],['production','Production'],['customer','Customer care'],['general','General']].map(([value,label]) => `<option value="${value}" ${draft.kind === value ? 'selected' : ''}>${label}</option>`).join(''))}</select></label>
          <div class="crm-call-field"><span>${(globalThis.PlatformLanguage?.text("settings","m_444eb2577d10b1","Display icon") ?? "Display icon")}</span><div class="crm-call-visual-row">${String([['fa-phone','Phone'],['fa-phone-volume','Outgoing call'],['fa-clock','Clock'],['fa-handshake','Handshake'],['fa-helmet-safety','Production'],['fa-headset','Customer care'],['fa-list-check','Checklist']].map(([value,label]) => `<button class="crm-call-visual-option ${draft.icon === value ? 'selected' : ''}" type="button" data-call-icon="${value}" aria-label="${label}" title="${label}" aria-pressed="${draft.icon === value}"><i class="fas ${value}"></i></button>`).join(''))}</div></div>
          <div class="crm-call-field"><span>${(globalThis.PlatformLanguage?.text("settings","m_9faac7258df0a0","Color treatment") ?? "Color treatment")}</span><div class="crm-call-visual-row">${String([['default','Blue','#2563eb'],['lead','Lead blue','#3538cd'],['followup','Purple','#7f56d9'],['customer','Green','#079455'],['production','Orange','#c2410c']].map(([value,label,color]) => `<button class="crm-call-visual-option tone ${draft.tone === value ? 'selected' : ''}" style="--call-tone:${color}" type="button" data-call-tone="${value}" aria-label="${label}" title="${label}" aria-pressed="${draft.tone === value}"></button>`).join(''))}</div></div>
          <label class="crm-call-field"><span>${(globalThis.PlatformLanguage?.text("settings","m_0505c57e04e7ce","Display order") ?? "Display order")}</span><input type="number" data-call-field="sort_order" value="${String(Number(draft.sort_order || 0))}" min="0" step="10"></label>
        </div></section>
        <section class="crm-call-section"><div class="crm-call-section-head"><div><strong>${(globalThis.PlatformLanguage?.text("settings","m_dc49c965d875f0","Who handles these calls?") ?? "Who handles these calls?")}</strong><span>${(globalThis.PlatformLanguage?.text("settings","m_81d376e79d4d54","Leave the list open to everyone, or route it to specific roles and people.") ?? "Leave the list open to everyone, or route it to specific roles and people.")}</span></div><div class="crm-call-modes"><button class="crm-call-mode ${String(restricted ? '' : 'active')}" type="button" data-call-everyone><i class="fas fa-users"></i>${(globalThis.PlatformLanguage?.text("settings","m_7997fdde9802e5"," Everyone") ?? " Everyone")}</button><button class="crm-call-mode ${String(restricted ? 'active' : '')}" type="button" data-call-restricted><i class="fas fa-user-lock"></i>${(globalThis.PlatformLanguage?.text("settings","m_9102fddfe2fd7b"," Assigned only") ?? " Assigned only")}</button></div></div>
          <div class="crm-call-choice-group"><span class="crm-call-choice-label">${(globalThis.PlatformLanguage?.text("settings","m_0728ce1a29afca","Roles") ?? "Roles")}</span><div class="crm-call-chips">${String(callRoleChoices(draft))}</div><label class="crm-call-field"><span>${(globalThis.PlatformLanguage?.text("settings","m_88aa87a29a7174","Role IDs") ?? "Role IDs")}</span><input data-call-role-ids value="${String(esc(draft.assigned_role_ids.join(', ')))}" placeholder="${(globalThis.PlatformLanguage?.text("settings","m_8faa76bd574917","office, production") ?? "office, production")}"></label></div>
          <div class="crm-call-choice-group"><span class="crm-call-choice-label">${(globalThis.PlatformLanguage?.text("settings","m_290e094a10f572","Specific people") ?? "Specific people")}</span><div class="crm-call-chips">${String(callUserChoices(draft))}</div></div>
        </section>
        <section class="crm-call-section"><div class="crm-call-section-head"><div><strong>${(globalThis.PlatformLanguage?.text("settings","m_5cd547e56ead7c","Workflow connection") ?? "Workflow connection")}</strong><span>${(globalThis.PlatformLanguage?.text("settings","m_1067e5ca14f97a","Scopes and automations add work to this list by its stable key.") ?? "Scopes and automations add work to this list by its stable key.")}</span></div></div><div class="crm-call-origin"><i class="fas ${String(managed ? 'fa-wand-magic-sparkles' : 'fa-code-branch')}"></i><div><strong>${String(managed ? 'Connected to project scope work' : 'Ready for scopes and automations')}</strong><span>${String(managed ? 'The Roof welcome-call step publishes signed customers here and completes with the call.' : 'Use crm.callLists.add.v1 on a work node’s onReady hook.')}</span></div><button class="crm-call-key" type="button" data-call-copy title="${(globalThis.PlatformLanguage?.text("settings","m_b1d41127305f1f","Copy list key") ?? "Copy list key")}">${String(esc(draft.key || 'set_a_key'))}</button></div></section>
        <section class="crm-call-section"><div class="crm-call-section-head"><div><strong>${(globalThis.PlatformLanguage?.text("settings","m_265cb02467b2cb","Caller flow") ?? "Caller flow")}</strong><span>${(globalThis.PlatformLanguage?.text("settings","m_d8e127a0db34f6","Every list shares the same quick outcome flow.") ?? "Every list shares the same quick outcome flow.")}</span></div></div><div class="crm-call-flow"><div class="crm-call-flow-step"><i class="fas fa-phone"></i><strong>${(globalThis.PlatformLanguage?.text("settings","m_8d4eaa0da004be","Call") ?? "Call")}</strong><span>${(globalThis.PlatformLanguage?.text("settings","m_435c1044ae98b9","Work through one contact at a time.") ?? "Work through one contact at a time.")}</span></div><div class="crm-call-flow-step"><i class="fas fa-clipboard-check"></i><strong>${(globalThis.PlatformLanguage?.text("settings","m_f303d69f775dc0","Record outcome") ?? "Record outcome")}</strong><span>${(globalThis.PlatformLanguage?.text("settings","m_41fadcef284d5a","Answered, voicemail, no answer, or skip.") ?? "Answered, voicemail, no answer, or skip.")}</span></div><div class="crm-call-flow-step"><i class="fas fa-check-double"></i><strong>${(globalThis.PlatformLanguage?.text("settings","m_288a893aca6efa","Complete or follow up") ?? "Complete or follow up")}</strong><span>${(globalThis.PlatformLanguage?.text("settings","m_db3adb9e5481e3","Finish linked work or schedule the next call.") ?? "Finish linked work or schedule the next call.")}</span></div></div></section>
        <div class="crm-call-editor-actions"><span class="crm-call-status" id="crmCallStatus"></span><div class="crm-call-actions"><button class="crm-btn" type="button" data-call-reset>${(globalThis.PlatformLanguage?.text("settings","m_955ed36bc1820f","Discard changes") ?? "Discard changes")}</button><button class="crm-btn primary" type="button" data-call-save ${String(state.callSaving ? 'disabled' : '')}><i class="fas fa-floppy-disk"></i> ${String(state.callSaving ? 'Saving…' : isNew ? 'Create list' : 'Save list')}</button></div></div>`;
    }
    function followUpSettingsMarkup(){
      const config=state.followUps||{label:(globalThis.PlatformLanguage?.text("settings","m_cfc813aecc8dd9","Follow-up") ?? "Follow-up"),default_title:'Follow-up call',default_time:'',quick_options:[],outcomes:[]};
      const policy=config.retry_policy||(config.retry_policy={enabled:true,triggers:['voicemail','no_answer','manual_follow_up'],after_last:'repeat_last',steps:[]});
      const quick=(config.quick_options||[]).map((option,index)=>`<div class="crm-row" data-follow-quick="${String(index)}"><div class="crm-grid-3">${String(field('Button label',`<input class="crm-input" data-follow-quick-field="label" value="${esc(option.label)}">`))}${String(field('Amount',`<input class="crm-input" type="number" min="1" data-follow-quick-field="amount" value="${Number(option.amount)||1}">`))}${String(field('Unit',`<select class="crm-select" data-follow-quick-field="unit"><option value="days" ${option.unit==='days'?'selected':''}>Days</option><option value="weeks" ${option.unit==='weeks'?'selected':''}>Weeks</option><option value="months" ${option.unit==='months'?'selected':''}>Months</option></select>`))}</div><button class="crm-btn danger" type="button" data-follow-remove-quick="${String(index)}"><i class="fas fa-trash"></i>${(globalThis.PlatformLanguage?.text("settings","m_09a65903b3217c"," Remove") ?? " Remove")}</button></div>`).join('');
      const policySteps=(policy.steps||[]).map((step,index)=>`<div class="crm-row" data-follow-policy-step="${String(index)}"><div class="crm-row-head"><strong>${((v1) => globalThis.PlatformLanguage?.text("settings","m_37c9aa5403dd55",`Attempt ${v1}`,{v1}) ?? `Attempt ${v1}`)(index+1)}</strong><span><button class="crm-btn crm-icon" type="button" data-follow-policy-move="-1" ${String(index===0?'disabled':'')} title="${(globalThis.PlatformLanguage?.text("settings","m_0ef44a71d653fa","Move earlier") ?? "Move earlier")}"><i class="fas fa-arrow-up"></i></button><button class="crm-btn crm-icon" type="button" data-follow-policy-move="1" ${String(index===policy.steps.length-1?'disabled':'')} title="${(globalThis.PlatformLanguage?.text("settings","m_9613af4b86bae6","Move later") ?? "Move later")}"><i class="fas fa-arrow-down"></i></button><button class="crm-btn crm-icon danger" type="button" data-follow-policy-remove ${String(policy.steps.length<=1?'disabled':'')} title="${(globalThis.PlatformLanguage?.text("settings","m_26fe00c3c178fa","Remove attempt") ?? "Remove attempt")}"><i class="fas fa-trash"></i></button></span></div><div class="crm-grid-3">${String(field('Step label',`<input class="crm-input" data-follow-policy-field="label" value="${esc(step.label)}">`))}${String(field('Wait',`<input class="crm-input" type="number" min="1" data-follow-policy-field="amount" value="${Number(step.amount)||1}">`))}${String(field('Unit',`<select class="crm-select" data-follow-policy-field="unit"><option value="days" ${step.unit==='days'?'selected':''}>Days</option><option value="weeks" ${step.unit==='weeks'?'selected':''}>Weeks</option><option value="months" ${step.unit==='months'?'selected':''}>Months</option></select>`))}</div></div>`).join('');
      const behaviorLabels={reschedule:'Create another follow-up',scheduled:'Appointment scheduled',lost:'Mark lead lost'};
      const outcomes=(config.outcomes||[]).map((outcome,index)=>`<div class="crm-row" data-follow-outcome="${index}"><div class="crm-grid-2">${field('Outcome label',`<input class="crm-input" data-follow-outcome-field="label" value="${esc(outcome.label)}">`)}${field('Behavior',`<input class="crm-input" value="${esc(behaviorLabels[outcome.action]||outcome.action)}" readonly>`)}</div></div>`).join('');
      return `<section class="crm-settings-block"><div class="crm-section-head"><div><h5>${(globalThis.PlatformLanguage?.text("settings","m_a21f2cc9fc344e","Follow-up behavior") ?? "Follow-up behavior")}</h5><span>${(globalThis.PlatformLanguage?.text("settings","m_95effd0be90a6d","One tagged to-do workflow shared by Calls, Today, projects, and automations.") ?? "One tagged to-do workflow shared by Calls, Today, projects, and automations.")}</span></div><button class="crm-btn primary" type="button" data-follow-save><i class="fas fa-floppy-disk"></i>${(globalThis.PlatformLanguage?.text("settings","m_ea8389eb2db426"," Save follow-ups") ?? " Save follow-ups")}</button></div><div class="crm-grid-3">${String(field('Terminology',`<input class="crm-input" data-follow-field="label" value="${esc(config.label)}">`))}${String(field('Default to-do title',`<input class="crm-input" data-follow-field="default_title" value="${esc(config.default_title)}">`))}${String(field('Default time (optional)',`<input class="crm-input" type="time" data-follow-field="default_time" value="${esc(config.default_time||'')}">`))}</div><div class="crm-section"><div class="crm-section-head"><div><h5>${(globalThis.PlatformLanguage?.text("settings","m_3ec5146f36a2bd","Automatic contact cadence") ?? "Automatic contact cadence")}</h5><span>${(globalThis.PlatformLanguage?.text("settings","m_9d3e92d14f6c83","Create the next tagged follow-up automatically when a call does not connect.") ?? "Create the next tagged follow-up automatically when a call does not connect.")}</span></div><label class="crm-check"><input type="checkbox" data-follow-policy-enabled ${String(policy.enabled!==false?'checked':'')}>${(globalThis.PlatformLanguage?.text("settings","m_0f5e8a42aaeb75"," Enabled") ?? " Enabled")}</label></div><div class="crm-grid-2"><div class="crm-field"><span>${(globalThis.PlatformLanguage?.text("settings","m_27fcba5b5597e9","Apply when") ?? "Apply when")}</span><div class="crm-grid-3"><label class="crm-check"><input type="checkbox" data-follow-policy-trigger="voicemail" ${String((policy.triggers||[]).includes('voicemail')?'checked':'')}>${(globalThis.PlatformLanguage?.text("settings","m_4c0eae2f5118f3"," Voicemail") ?? " Voicemail")}</label><label class="crm-check"><input type="checkbox" data-follow-policy-trigger="no_answer" ${String((policy.triggers||[]).includes('no_answer')?'checked':'')}>${(globalThis.PlatformLanguage?.text("settings","m_734124f0fbebaf"," No answer") ?? " No answer")}</label><label class="crm-check"><input type="checkbox" data-follow-policy-trigger="manual_follow_up" ${String((policy.triggers||[]).includes('manual_follow_up')?'checked':'')}>${(globalThis.PlatformLanguage?.text("settings","m_ea7a68e0598230"," Follow-up button") ?? " Follow-up button")}</label></div></div>${String(field('After the final step',`<select class="crm-select" data-follow-policy-after><option value="repeat_last" ${policy.after_last==='repeat_last'?'selected':''}>Keep repeating the final interval</option><option value="stop" ${policy.after_last==='stop'?'selected':''}>Stop automatic attempts</option></select>`))}</div><div class="crm-section-head"><div><h5>${(globalThis.PlatformLanguage?.text("settings","m_1f1d499c46cd5a","Attempt sequence") ?? "Attempt sequence")}</h5><span>${(globalThis.PlatformLanguage?.text("settings","m_3414daa9d67f5e","Each wait starts when the previous call is completed.") ?? "Each wait starts when the previous call is completed.")}</span></div><button class="crm-btn" type="button" data-follow-policy-add><i class="fas fa-plus"></i>${(globalThis.PlatformLanguage?.text("settings","m_7c34adf4b56d61"," Add attempt") ?? " Add attempt")}</button></div>${String(policySteps||'<div class="crm-empty">Add at least one attempt interval.</div>')}</div><div class="crm-section"><div class="crm-section-head"><div><h5>${(globalThis.PlatformLanguage?.text("settings","m_7ce767912e8be5","Quick reschedule options") ?? "Quick reschedule options")}</h5><span>${(globalThis.PlatformLanguage?.text("settings","m_a2c722d8f538a1","Manual overrides shown alongside the suggested policy date.") ?? "Manual overrides shown alongside the suggested policy date.")}</span></div><button class="crm-btn" type="button" data-follow-add-quick><i class="fas fa-plus"></i>${(globalThis.PlatformLanguage?.text("settings","m_e7713012500e3b"," Add option") ?? " Add option")}</button></div>${String(quick||'<div class="crm-empty">Add at least one quick option.</div>')}</div><div class="crm-section"><div class="crm-section-head"><div><h5>${(globalThis.PlatformLanguage?.text("settings","m_a7635200c63f1a","Completion outcomes") ?? "Completion outcomes")}</h5><span>${(globalThis.PlatformLanguage?.text("settings","m_cfad848ad13467","Customize the wording while keeping the three standard behaviors. Pipeline movement is handled by the sales pipeline scope automatically.") ?? "Customize the wording while keeping the three standard behaviors. Pipeline movement is handled by the sales pipeline scope automatically.")}</span></div></div>${String(outcomes)}</div></section>`;
    }
    function renderCallWorkspace(){
      if (state.subtab !== 'calls') return;
      const lists = state.callLists;
      const query = state.callSearch.trim().toLowerCase();
      const filtered = lists.filter((list) => !query || `${list.title} ${list.key} ${list.kind}`.toLowerCase().includes(query));
      const activeCount = lists.filter((list) => list.status === 'active').length;
      const pendingCount = lists.reduce((sum, list) => sum + Number(list.pending_count || 0), 0);
      const routedCount = lists.filter((list) => list.assigned_user_ids.length || list.assigned_role_ids.length).length;
      const listMarkup = filtered.map((list) => `<div class="crm-call-list-item ${state.callSelectedKey === list.key ? 'active' : ''}" data-call-list="${esc(list.key)}" data-tone="${esc(list.tone)}" role="button" tabindex="0"><span class="crm-call-list-icon"><i class="fas ${esc(list.icon || 'fa-phone')}"></i></span><span class="crm-call-list-copy"><strong>${esc(list.title)}</strong><span>${esc(callKindLabel(list.kind))} · ${list.status === 'active' ? esc(callAssignmentLabel(list)) : 'Inactive'}</span></span><span class="crm-call-count ${Number(list.pending_count || 0) ? 'has-calls' : ''}">${Number(list.pending_count || 0)}</span></div>`).join('') || `<div class="crm-call-empty"><div><i class="fas fa-magnifying-glass"></i><strong>${(globalThis.PlatformLanguage?.text("settings","m_35c4be17ab5530","No matching lists") ?? "No matching lists")}</strong><span>${(globalThis.PlatformLanguage?.text("settings","m_c8284dfd7645f8","Try a different search or create a new list.") ?? "Try a different search or create a new list.")}</span></div></div>`;
      host.querySelector('.crm-settings').innerHTML = (String(subTabs()) + "<div class=\"crm-call-page\"><header class=\"crm-call-top\"><div><div class=\"crm-call-kicker\">" + (globalThis.PlatformLanguage?.text("settings","m_68f1423b4d6f83","CRM · Calls") ?? "CRM · Calls") + "</div><h3>" + (globalThis.PlatformLanguage?.text("settings","m_45e0ea42bd7f61","Call workflows") ?? "Call workflows") + "</h3><p>" + (globalThis.PlatformLanguage?.text("settings","m_0a72968c54b3ad","Organize calls into real lists, decide which team handles each one, and connect project scopes to the right queue.") ?? "Organize calls into real lists, decide which team handles each one, and connect project scopes to the right queue.") + "</p></div><div class=\"crm-call-actions\"><button class=\"crm-btn\" type=\"button\" data-call-refresh><i class=\"fas fa-rotate\"></i>" + (globalThis.PlatformLanguage?.text("settings","m_4f524800833039"," Refresh") ?? " Refresh") + "</button><button class=\"crm-btn\" type=\"button\" data-call-open><i class=\"fas fa-phone\"></i>" + (globalThis.PlatformLanguage?.text("settings","m_07e64910ede841"," Open Calls") ?? " Open Calls") + "</button><button class=\"crm-btn primary\" type=\"button\" data-call-new><i class=\"fas fa-plus\"></i>" + (globalThis.PlatformLanguage?.text("settings","m_9307f6f8b8e9f1"," New call list") ?? " New call list") + "</button></div></header>\n        <div class=\"crm-call-stats\"><div class=\"crm-call-stat\"><span>" + (globalThis.PlatformLanguage?.text("settings","m_cdce2be16f3cc8","Total lists") ?? "Total lists") + "</span><strong>" + String(lists.length) + "</strong></div><div class=\"crm-call-stat active\"><span>" + (globalThis.PlatformLanguage?.text("settings","m_3689c34b89cd39","Active lists") ?? "Active lists") + "</span><strong>" + String(activeCount) + "</strong></div><div class=\"crm-call-stat waiting\"><span>" + (globalThis.PlatformLanguage?.text("settings","m_dad4a2bcff697f","Calls waiting") ?? "Calls waiting") + "</span><strong>" + String(pendingCount) + "</strong></div><div class=\"crm-call-stat routed\"><span>" + (globalThis.PlatformLanguage?.text("settings","m_f6bf476d818cc0","Team-routed lists") ?? "Team-routed lists") + "</span><strong>" + String(routedCount) + "</strong></div></div>\n        " + String(followUpSettingsMarkup()) + "\n        <div class=\"crm-call-workspace\"><aside class=\"crm-call-rail\"><div class=\"crm-call-rail-head\"><div class=\"crm-call-rail-title\"><strong>" + (globalThis.PlatformLanguage?.text("settings","m_81df0d1019af98","Call lists") ?? "Call lists") + "</strong><span>" + ((v6) => globalThis.PlatformLanguage?.text("settings","m_2594ac3351cedd",`${v6} configured`,{v6}) ?? `${v6} configured`)(lists.length) + "</span></div><label class=\"crm-call-search\"><i class=\"fas fa-magnifying-glass\"></i><input value=\"" + String(esc(state.callSearch)) + "\" placeholder=\"" + (globalThis.PlatformLanguage?.text("settings","m_c28f246d7741d6","Find a list") ?? "Find a list") + "\" data-call-search></label></div><div class=\"crm-call-list\">" + String(listMarkup) + "</div></aside><main class=\"crm-call-editor\">" + String(callEditorMarkup()) + "</main></div></div>");
      bindCallWorkspace();
    }
    function routeCallList(key, replace = false){
      if (root.Portal?.navigation?.applying) return;
      const method = replace ? 'replace' : 'push';
      root.Portal?.navigation?.[method]?.({ tab:'company_settings', sub:routeSub, settingsView:fixedView ? '' : 'calls', settingsEntity:`call-list:${key}` }, { source:'calls-settings-list', ownedKeys:['settingsEntity'] });
    }
    function selectCallList(key, updateRoute = true){
      const selected = state.callLists.find((list) => list.key === key);
      if (!selected) return;
      state.callSelectedKey = selected.key;
      state.callDraft = callListDraft(selected);
      if (updateRoute) routeCallList(selected.key);
      renderCallWorkspace();
    }
    function bindCallWorkspace(){
      bindSubTabs();
      host.querySelectorAll('[data-call-list]').forEach((item) => {
        const select = () => selectCallList(item.dataset.callList);
        item.addEventListener('click', select);
        item.addEventListener('keydown', (event) => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); select(); } });
      });
      host.querySelector('[data-call-search]')?.addEventListener('input', (event) => { state.callSearch = event.target.value; renderCallWorkspace(); const search=host.querySelector('[data-call-search]');search?.focus();search?.setSelectionRange?.(state.callSearch.length,state.callSearch.length); });
      host.querySelector('[data-call-new]')?.addEventListener('click', () => { state.callSelectedKey='__new__';state.callDraft=callListDraft({status:'active',kind:'general',icon:'fa-phone',tone:'default',sort_order:(state.callLists.length+1)*10,metadata:{created_from:'crm_settings'}});routeCallList('new');renderCallWorkspace(); });
      host.querySelector('[data-call-refresh]')?.addEventListener('click', async () => { state.callLoaded=false;await renderCallWorkflows({refresh:true}); });
      host.querySelector('[data-call-open]')?.addEventListener('click', () => root.Portal?.navigation?.navigate?.({tab:'calls',sub:null,settingsView:null,settingsEntity:null,callQueue:null,callIndex:null,callStep:null},{source:'crm-call-workflows-open-calls',ownedKeys:['tab']}));
      host.querySelector('[data-call-active]')?.addEventListener('click', () => { state.callDraft.status=state.callDraft.status==='active'?'archived':'active';renderCallWorkspace(); });
      host.querySelectorAll('[data-call-icon]').forEach((button) => button.addEventListener('click', () => { state.callDraft.icon=button.dataset.callIcon;renderCallWorkspace(); }));
      host.querySelectorAll('[data-call-tone]').forEach((button) => button.addEventListener('click', () => { state.callDraft.tone=button.dataset.callTone;renderCallWorkspace(); }));
      host.querySelectorAll('[data-call-field]').forEach((input) => input.addEventListener(input.tagName === 'SELECT' ? 'change' : 'input', () => { const key=input.dataset.callField;let value=input.value;if(key==='key')value=value.toLowerCase().replace(/[^a-z0-9._-]+/g,'_').replace(/^_+|_+$/g,'');if(key==='sort_order')value=Number(value||0);state.callDraft[key]=value; }));
      host.querySelector('[data-call-everyone]')?.addEventListener('click', () => { state.callDraft.assigned_role_ids=[];state.callDraft.assigned_user_ids=[];renderCallWorkspace(); });
      host.querySelector('[data-call-restricted]')?.addEventListener('click', () => { if(!state.callDraft.assigned_role_ids.length&&!state.callDraft.assigned_user_ids.length){const id=text(state.callRoles[0]?.id,state.callRoles[0]?.role_id);if(id)state.callDraft.assigned_role_ids=[id];}renderCallWorkspace(); });
      host.querySelectorAll('[data-call-role]').forEach((button) => button.addEventListener('click', () => { const ids=new Set(state.callDraft.assigned_role_ids);ids.has(button.dataset.callRole)?ids.delete(button.dataset.callRole):ids.add(button.dataset.callRole);state.callDraft.assigned_role_ids=[...ids];renderCallWorkspace(); }));
      host.querySelectorAll('[data-call-user]').forEach((button) => button.addEventListener('click', () => { const ids=new Set(state.callDraft.assigned_user_ids);ids.has(button.dataset.callUser)?ids.delete(button.dataset.callUser):ids.add(button.dataset.callUser);state.callDraft.assigned_user_ids=[...ids];renderCallWorkspace(); }));
      host.querySelector('[data-call-role-ids]')?.addEventListener('input', (event) => { state.callDraft.assigned_role_ids=[...new Set(event.target.value.split(',').map((value)=>value.trim()).filter(Boolean))]; });
      host.querySelector('[data-call-copy]')?.addEventListener('click', async () => { const key=state.callDraft?.key;if(!key)return;await navigator.clipboard?.writeText?.(key).catch(()=>null);toast((globalThis.PlatformLanguage?.text("settings","m_16841202d17c7c","Copied") ?? "Copied"),(globalThis.PlatformLanguage?.text("settings","m_c034d862433eed","Call list key copied.") ?? "Call list key copied."),true); });
      host.querySelector('[data-call-reset]')?.addEventListener('click', () => { const current=state.callLists.find((list)=>list.key===state.callSelectedKey);state.callDraft=current?callListDraft(current):null;renderCallWorkspace(); });
      host.querySelector('[data-call-save]')?.addEventListener('click', saveCallList);
      host.querySelectorAll('[data-follow-field]').forEach((input)=>input.addEventListener('input',()=>{state.followUps[input.dataset.followField]=input.value;}));
      host.querySelectorAll('[data-follow-quick]').forEach((row)=>{const option=state.followUps.quick_options[Number(row.dataset.followQuick)];row.querySelectorAll('[data-follow-quick-field]').forEach((input)=>input.addEventListener(input.tagName==='SELECT'?'change':'input',()=>{option[input.dataset.followQuickField]=input.dataset.followQuickField==='amount'?Math.max(1,Number(input.value)||1):input.value;}));});
      host.querySelectorAll('[data-follow-outcome]').forEach((row)=>{const outcome=state.followUps.outcomes[Number(row.dataset.followOutcome)];row.querySelectorAll('[data-follow-outcome-field]').forEach((input)=>input.addEventListener('input',()=>{outcome[input.dataset.followOutcomeField]=input.value;}));});
      host.querySelector('[data-follow-policy-enabled]')?.addEventListener('change',(event)=>{state.followUps.retry_policy.enabled=event.target.checked;});
      host.querySelector('[data-follow-policy-after]')?.addEventListener('change',(event)=>{state.followUps.retry_policy.after_last=event.target.value;});
      host.querySelectorAll('[data-follow-policy-trigger]').forEach((input)=>input.addEventListener('change',()=>{const triggers=new Set(state.followUps.retry_policy.triggers||[]);input.checked?triggers.add(input.dataset.followPolicyTrigger):triggers.delete(input.dataset.followPolicyTrigger);state.followUps.retry_policy.triggers=[...triggers];}));
      host.querySelectorAll('[data-follow-policy-step]').forEach((row)=>{const index=Number(row.dataset.followPolicyStep),step=state.followUps.retry_policy.steps[index];row.querySelectorAll('[data-follow-policy-field]').forEach((input)=>input.addEventListener(input.tagName==='SELECT'?'change':'input',()=>{step[input.dataset.followPolicyField]=input.dataset.followPolicyField==='amount'?Math.max(1,Number(input.value)||1):input.value;}));row.querySelector('[data-follow-policy-remove]')?.addEventListener('click',()=>{if(state.followUps.retry_policy.steps.length<=1)return;state.followUps.retry_policy.steps.splice(index,1);renderCallWorkspace();});row.querySelectorAll('[data-follow-policy-move]').forEach((button)=>button.addEventListener('click',()=>{const target=index+Number(button.dataset.followPolicyMove);if(target<0||target>=state.followUps.retry_policy.steps.length)return;const [moved]=state.followUps.retry_policy.steps.splice(index,1);state.followUps.retry_policy.steps.splice(target,0,moved);renderCallWorkspace();}));});
      host.querySelector('[data-follow-policy-add]')?.addEventListener('click',()=>{state.followUps.retry_policy.steps.push({id:uid('attempt'),label:((v0) => globalThis.PlatformLanguage?.text("settings","m_2e13f0413cbfde",`Attempt ${v0}`,{v0}) ?? `Attempt ${v0}`)(state.followUps.retry_policy.steps.length+1),amount:1,unit:'days'});renderCallWorkspace();});
      host.querySelectorAll('[data-follow-remove-quick]').forEach((button)=>button.addEventListener('click',()=>{if(state.followUps.quick_options.length<=1)return;state.followUps.quick_options.splice(Number(button.dataset.followRemoveQuick),1);renderCallWorkspace();}));
      host.querySelector('[data-follow-add-quick]')?.addEventListener('click',()=>{state.followUps.quick_options.push({id:uid('quick'),label:(globalThis.PlatformLanguage?.text("settings","m_bf3c7b54516fb6","3 days") ?? "3 days"),amount:3,unit:'days'});renderCallWorkspace();});
      host.querySelector('[data-follow-save]')?.addEventListener('click',saveFollowUps);
    }
    async function saveFollowUps(){
      try{
        const result=await root.PlatformAPI.work.saveConfiguration(orgId,branchId,{expected_revision:state.config.revision,follow_ups:state.followUps});
        state.config=result.configuration;state.followUps=clone(result.configuration.follow_ups);toast((globalThis.PlatformLanguage?.text("settings","m_78a342b1f16dcd","Follow-ups saved") ?? "Follow-ups saved"),(globalThis.PlatformLanguage?.text("settings","m_5f181546c221d6","Calls and to-dos now use this follow-up workflow.") ?? "Calls and to-dos now use this follow-up workflow."),true);root.dispatchEvent(new CustomEvent('fm:work-configuration:updated',{detail:{orgId,branchId}}));renderCallWorkspace();
      }catch(error){toast((globalThis.PlatformLanguage?.text("settings","m_edd96ad5319780","Could not save follow-ups") ?? "Could not save follow-ups"),error?.message||'Please try again.',false);}
    }
    async function saveCallList(){
      if (state.callSaving || !state.callDraft) return;
      if (!text(state.callDraft.title) || !text(state.callDraft.key)) { const status=host.querySelector('#crmCallStatus');if(status)status.textContent=(globalThis.PlatformLanguage?.text("settings","m_b30ee3bbb8a121","A list name and key are required.") ?? "A list name and key are required.");return; }
      state.callSaving=true;renderCallWorkspace();
      try {
        const result=await callApi(`/organizations/${encodeURIComponent(orgId)}/call-lists`,{method:'POST',body:JSON.stringify(state.callDraft)});
        state.callSelectedKey=result.call_list.key;state.callLoaded=false;await loadCallLists({refresh:true});routeCallList(result.call_list.key,true);toast((globalThis.PlatformLanguage?.text("settings","m_adef2db5d83493","Call list saved") ?? "Call list saved"),((v0) => globalThis.PlatformLanguage?.text("settings","m_0d5404a8c66e1a",`${v0} is ready in Calls.`,{v0}) ?? `${v0} is ready in Calls.`)(result.call_list.title),true);
      } catch(error) { toast((globalThis.PlatformLanguage?.text("settings","m_ceb19c5e5f7aa9","Could not save call list") ?? "Could not save call list"),error?.message || 'Please try again.',false); }
      finally { state.callSaving=false;renderCallWorkspace(); }
    }
    async function renderCallWorkflows(options = {}){
      if (!state.callLoaded || options.refresh) {
        host.querySelector('.crm-settings').innerHTML = (String(subTabs()) + "<div class=\"crm-call-loading\"><span><i class=\"fas fa-spinner fa-spin\"></i>" + (globalThis.PlatformLanguage?.text("settings","m_74c4de2aa80926"," Loading call lists…") ?? " Loading call lists…") + "</span></div>");
        bindSubTabs();
        try { await loadCallLists({refresh:options.refresh === true}); }
        catch(error) { if(state.subtab==='calls')host.querySelector('.crm-settings').innerHTML=(String(subTabs()) + "<div class=\"crm-call-error\"><strong>" + (globalThis.PlatformLanguage?.text("settings","m_56fd06d812e322","Call workflows unavailable.") ?? "Call workflows unavailable.") + "</strong><br>" + String(esc(error?.message || 'Could not load call lists.')) + "</div>");return; }
      }
      renderCallWorkspace();
    }
    function renderProjects(){
      const config = state.projectConfig;
      const titleOptions = [
        ['customer_name','Customer name','Use the primary contact name, falling back to the address.'],
        ['address','Property address','Use the project property address, falling back to the contact name.'],
        ['manual','Manual title','Allow an editable project title and retain saved overrides.']
      ];
      host.querySelector('.crm-settings').innerHTML = (String(subTabs()) + "\n        <div class=\"crm-head\"><div><h3>" + (globalThis.PlatformLanguage?.text("settings","m_19156e80fc8a6e","Projects") ?? "Projects") + "</h3><p>" + (globalThis.PlatformLanguage?.text("settings","m_f52c3d83780786","Control project naming and the quick details shown beneath project titles.") ?? "Control project naming and the quick details shown beneath project titles.") + "</p></div><div class=\"crm-head-actions\"><span class=\"crm-status\" id=\"crmStatus\"></span><button class=\"crm-btn primary\" id=\"crmSaveProjectConfig\" type=\"button\"><i class=\"fas fa-floppy-disk\"></i>" + (globalThis.PlatformLanguage?.text("settings","m_bfcbd339764266"," Save changes") ?? " Save changes") + "</button></div></div>\n        <section class=\"crm-settings-block\"><h4>" + (globalThis.PlatformLanguage?.text("settings","m_67ac09b40d11f8","Project titles") ?? "Project titles") + "</h4><p>" + (globalThis.PlatformLanguage?.text("settings","m_d53f09731b34e7","Choose how project titles render across this branch.") ?? "Choose how project titles render across this branch.") + "</p><div class=\"crm-option-grid\">" + String(titleOptions.map(([id,label,description]) => `<button class="crm-option ${config.title_mode===id?'active':''}" data-title-mode="${id}" type="button"><strong>${label}</strong><span>${description}</span></button>`).join('')) + "</div></section>\n        <section class=\"crm-settings-block\"><h4>" + (globalThis.PlatformLanguage?.text("settings","m_5cd6838b3a4d24","Project header pills") ?? "Project header pills") + "</h4><p>" + (globalThis.PlatformLanguage?.text("settings","m_ce7214d000edda","Choose which project variables appear as pills in the My Projects project header. Click a variable to show or hide it.") ?? "Choose which project variables appear as pills in the My Projects project header. Click a variable to show or hide it.") + "</p><div class=\"crm-pill-options\">" + String(PROJECT_PILL_FIELDS.map(([id,label]) => `<button class="crm-pill-option ${config.project_header_pills.includes(id)?'active':''}" data-project-pill="${id}" type="button" aria-pressed="${config.project_header_pills.includes(id)}">${label}</button>`).join('')) + "</div></section>");
      bindSubTabs();
      host.querySelectorAll('[data-title-mode]').forEach((button) => button.addEventListener('click', () => { config.title_mode = button.dataset.titleMode; renderProjects(); }));
      host.querySelectorAll('[data-project-pill]').forEach((button) => button.addEventListener('click', () => { const id=button.dataset.projectPill; config.project_header_pills = config.project_header_pills.includes(id) ? config.project_header_pills.filter((item)=>item!==id) : [...config.project_header_pills,id]; renderProjects(); }));
      host.querySelector('#crmSaveProjectConfig')?.addEventListener('click', saveProjectConfig);
    }
    function renderMisc(){
      const config = state.projectConfig;
      const options = [['on','On','Allow small and large celebrations.'],['small_only','Small only','Demote large celebrations to the small ding.'],['off','Off','Suppress trigger-driven celebrations.']];
      host.querySelector('.crm-settings').innerHTML = (String(subTabs()) + "\n        <div class=\"crm-head\"><div><h3>" + (globalThis.PlatformLanguage?.text("settings","m_ef207345c8196c","Celebrations") ?? "Celebrations") + "</h3><p>" + (globalThis.PlatformLanguage?.text("settings","m_510e3636b7f8f9","Control celebratory sounds and effects for this branch.") ?? "Control celebratory sounds and effects for this branch.") + "</p></div><div class=\"crm-head-actions\"><span class=\"crm-status\" id=\"crmStatus\"></span><button class=\"crm-btn primary\" id=\"crmSaveProjectConfig\" type=\"button\"><i class=\"fas fa-floppy-disk\"></i>" + (globalThis.PlatformLanguage?.text("settings","m_bfcbd339764266"," Save changes") ?? " Save changes") + "</button></div></div>\n        <section class=\"crm-settings-block\"><h4>" + (globalThis.PlatformLanguage?.text("settings","m_ef207345c8196c","Celebrations") ?? "Celebrations") + "</h4><p>" + (globalThis.PlatformLanguage?.text("settings","m_510e3636b7f8f9","Control celebratory sounds and effects for this branch.") ?? "Control celebratory sounds and effects for this branch.") + "</p><div class=\"crm-option-grid\">" + String(options.map(([id,label,description]) => `<button class="crm-option ${config.celebrations_mode===id?'active':''}" data-celebrations-mode="${id}" type="button"><strong>${label}</strong><span>${description}</span></button>`).join('')) + "</div><div class=\"crm-head-actions\" style=\"margin-top:14px;justify-content:flex-start\"><button class=\"crm-btn\" id=\"crmTestSmall\" type=\"button\"><i class=\"fas fa-music\"></i>" + (globalThis.PlatformLanguage?.text("settings","m_4a1f95fa474201"," Test small") ?? " Test small") + "</button><button class=\"crm-btn\" id=\"crmTestLarge\" type=\"button\"><i class=\"fas fa-wand-magic-sparkles\"></i>" + (globalThis.PlatformLanguage?.text("settings","m_b6658bbe067b5f"," Test large") ?? " Test large") + "</button></div></section>");
      bindSubTabs();
      host.querySelectorAll('[data-celebrations-mode]').forEach((button) => button.addEventListener('click', () => { config.celebrations_mode=button.dataset.celebrationsMode; root.PlatformCelebrations?.configure?.({mode:config.celebrations_mode}); renderMisc(); }));
      host.querySelector('#crmTestSmall')?.addEventListener('click', () => root.PlatformCelebrations?.small?.({force:true,text:'Small celebration preview'}));
      host.querySelector('#crmTestLarge')?.addEventListener('click', () => root.PlatformCelebrations?.large?.({force:true,text:'Large celebration preview'}));
      host.querySelector('#crmSaveProjectConfig')?.addEventListener('click', saveProjectConfig);
    }
    async function saveProjectConfig(){
      const button=host.querySelector('#crmSaveProjectConfig'); const status=host.querySelector('#crmStatus');
      if(button) button.disabled=true; if(status) status.textContent=(globalThis.PlatformLanguage?.text("settings","m_b82c4e12389843","Saving...") ?? "Saving...");
      try { await root.PlatformAPI.branchModules.save(orgId,branchId,'project_configuration',state.projectConfig,{kind:'branch_project_configuration',source:'crm_settings'}); root.dispatchEvent(new CustomEvent('fm:project-config:updated',{detail:state.projectConfig})); root.PlatformCelebrations?.configure?.({mode:state.projectConfig.celebrations_mode}); if(status) status.textContent=(globalThis.PlatformLanguage?.text("settings","m_4bb4688766e904","Saved") ?? "Saved"); toast((globalThis.PlatformLanguage?.text("settings","m_4bb4688766e904","Saved") ?? "Saved"),(globalThis.PlatformLanguage?.text("settings","m_5d77d007688eaa","Project CRM settings updated.") ?? "Project CRM settings updated."),true); }
      catch(error){ if(status) status.textContent=error?.message||'Could not save'; toast((globalThis.PlatformLanguage?.text("settings","m_c8b7bd7ca69f49","Save failed") ?? "Save failed"),error?.message||'Could not save project settings.',false); }
      finally { if(button) button.disabled=false; }
    }
    function render(){
      if (state.subtab === 'calls') { renderCallWorkflows(); return; }
      if (state.subtab === 'projects') { renderProjects(); return; }
      if (state.subtab === 'misc') { renderMisc(); return; }
      renderPipeline();
    }

    function openScopeTemplates(entity){
      if (root.Portal?.navigation?.navigate) {
        root.Portal.navigation.navigate(
          entity
            ? { tab:'company_settings', sub:'project_scopes', settingsView:'editor', settingsEntity:`scope:${entity}`, scopeTemplateView:'details' }
            : { tab:'company_settings', sub:'project_scopes', settingsView:'', settingsEntity:'', scopeTemplateView:'' },
          { source:'crm-pipeline-redirect', ownedKeys:['sub','settingsView','settingsEntity','scopeTemplateView'] }
        );
        return;
      }
      document.getElementById('csTabScopeTemplates')?.click();
    }

    function renderPipeline(){
      host.querySelector('.crm-settings').innerHTML = `
        ${String(subTabs())}
        <div class="crm-head"><div><h3>${(globalThis.PlatformLanguage?.text("settings","m_01fbc71cf58163","Sales pipeline") ?? "Sales pipeline")}</h3><p>${(globalThis.PlatformLanguage?.text("settings","m_50c607375fb3cd","The pipeline your team works before a project moves into production.") ?? "The pipeline your team works before a project moves into production.")}</p></div></div>
        <section class="crm-settings-block">
          <h4>${(globalThis.PlatformLanguage?.text("settings","m_3fd795c25a0287","The sales pipeline is now a scope template") ?? "The sales pipeline is now a scope template")}</h4>
          <p>${(globalThis.PlatformLanguage?.text("settings","m_7f55880e2b0579","Stages, to-dos, and automations for the sales pipeline are managed in the ") ?? "Stages, to-dos, and automations for the sales pipeline are managed in the ")}<strong>${(globalThis.PlatformLanguage?.text("settings","m_e57c54f72522ff","Sales Pipeline") ?? "Sales Pipeline")}</strong>${(globalThis.PlatformLanguage?.text("settings","m_7ba4aeda049d30"," scope template — the same editor used for production scope templates. Changes there flow to the sales board, project stage pills, and pipeline automations. New projects are routed into a pipeline template by your intake routing rules.") ?? " scope template — the same editor used for production scope templates. Changes there flow to the sales board, project stage pills, and pipeline automations. New projects are routed into a pipeline template by your intake routing rules.")}</p>
          <div class="crm-head-actions" style="justify-content:flex-start">
            <button class="crm-btn primary" type="button" data-open-pipeline-template><i class="fas fa-layer-group"></i>${(globalThis.PlatformLanguage?.text("settings","m_eea7cb32c145a8"," Edit the Sales Pipeline template") ?? " Edit the Sales Pipeline template")}</button>
            <button class="crm-btn" type="button" data-open-scope-templates><i class="fas fa-list"></i>${(globalThis.PlatformLanguage?.text("settings","m_8ea067347f2e26"," Browse all scope templates") ?? " Browse all scope templates")}</button>
          </div>
        </section>`;
      bindSubTabs();
      host.querySelector('[data-open-pipeline-template]')?.addEventListener('click', () => openScopeTemplates('sales_pipeline'));
      host.querySelector('[data-open-scope-templates]')?.addEventListener('click', () => openScopeTemplates(''));
    }

    Promise.all([
      root.PlatformAPI.work.configuration(orgId, branchId),
      root.PlatformAPI.branchModules.get(orgId, branchId, 'project_configuration').catch((error) => Number(error?.status||0)===404 ? null : Promise.reject(error))
    ]).then(([result,projectDoc]) => {
      state.config=result.configuration;
      state.followUps=clone(result.configuration.follow_ups);
      state.projectConfig=normalizedProjectConfig(projectDoc?.data||projectDoc||{});
      render();
    }).catch((error) => { host.querySelector('.crm-settings').innerHTML=`<div class="crm-error">${esc(error?.message || 'Could not load CRM settings.')}</div>`; });

    root.Portal?.navigation?.registerHandler?.(`settings-view:${routeSub}:${fixedView || 'tabs'}`, {
      priority:450,
      apply:(route) => {
        if (route.tab !== 'company_settings' || route.sub !== routeSub) return;
        const next = fixedView || (allowedViews.includes(route.settingsView) ? route.settingsView : defaultView);
        if (next !== state.subtab) setSubtab(next, { updateRoute:false });
        if (next === 'calls' && state.callLoaded && route.settingsEntity?.startsWith('call-list:')) {
          const key = route.settingsEntity.slice(10);
          if (key === 'new') {
            state.callSelectedKey='__new__';
            state.callDraft=callListDraft({status:'active',kind:'general',icon:'fa-phone',tone:'default',sort_order:(state.callLists.length+1)*10,metadata:{created_from:'calls_settings'}});
            renderCallWorkspace();
          } else if (key && key !== state.callSelectedKey) selectCallList(key, false);
        }
      }
    });
  }

  root.FirstMateCrmSettings = { mount };
})(window);
