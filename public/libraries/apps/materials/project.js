/* public/libraries/apps/materials/project.js
 * Project modal Materials tab.
 */
(function(){
  const runtime = window.FirstMateEmbeddableApps;
  const Portal = window.Portal;
  const util = Portal?.util || {};
  const cfg = Portal?.cfg || window.__APP || {};
  const $ = util.$ || ((sel, root = document) => root.querySelector(sel));
  const fmUrl = util.fmUrl || ((path) => String(path || ''));
  const fmJson = util.fmJson || null;
  const escapeHtml = util.escapeHtml || ((value) => String(value ?? '').replace(/[&<>"']/g, (match) => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;'
  }[match])));
  const injectCSS = util.injectCSS || function(id, css){
    const styleId = `fm-style-${id}`;
    let style = document.getElementById(styleId);
    if (!style) {
      style = document.createElement('style');
      style.id = styleId;
      document.head.appendChild(style);
    }
    style.textContent = css || '';
    return style;
  };
  const showToast = Portal?.ui?.showToast || window.showToast || (() => {});
  const rootWindow = window;

  const SECTION_DEFS = [
    { key: 'shingles', title: 'Shingles', icon: 'fa-house-chimney' },
    { key: 'flat_roofing', title: 'Flat Roofing', icon: 'fa-layer-group' },
    { key: 'metal', title: 'Metal', icon: 'fa-grip-lines' },
    { key: 'underlayments', title: 'Underlayments', icon: 'fa-scroll' },
    { key: 'accessories', title: 'Accessories', icon: 'fa-screwdriver-wrench' }
  ];
  const CATEGORY_TO_SECTION = {
    shingle_roofs: 'shingles',
    flat_roofs: 'flat_roofing',
    flat_roof_accessories: 'flat_roofing',
    leak_barriers: 'underlayments',
    underlayments: 'underlayments',
    flashing: 'metal',
    accessories: 'accessories',
    gutters: 'accessories',
    disposal: 'accessories',
    misc: 'accessories'
  };
  const PRIMARY_LIST_TITLE = 'Materials';

  const state = {
    mounted: false,
    active: false,
    loading: false,
    saving: false,
    host: null,
    context: null,
    project: null,
    panelRoot: null,
    leftRoot: null,
    lists: [],
    activeListId: '',
    activeList: null,
    versions: [],
    orders: [],
    deliveriesByOrderId: {},
    pricebookItems: [],
    selectedStructureIds: new Set(),
    structuresConfirmed: false,
    activeStructureId: 'total',
    roofScope: 'full_roof',
    measurementOverrides: {},
    measurementExtraSource: {},
    measurementLoadingId: '',
    measurementLoadedId: '',
    measurementRefreshing: false,
    generatingMaterials: false,
    flashingColor: 'black',
    pricebookOpen: false,
    pricebookSearch: '',
    colorMenu: null,
    search: '',
    selectedSection: 'all',
    lastError: ''
  };
  let stylesInjected = false;
  let arrangeFrame = 0;
  let timingProbeInstalled = false;

  function timingEnabled(){
    try {
      return /(?:[?&])fmTiming=1(?:&|$)/.test(rootWindow.location?.search || '') || rootWindow.localStorage?.getItem?.('fm_materials_timing') === '1';
    } catch (_) {
      return false;
    }
  }

  function timingStore(){
    if (!timingEnabled()) return null;
    const store = rootWindow.FirstMateMaterialsTiming || {
      entries: [],
      lastClick: null,
      clear(){ this.entries = []; this.lastClick = null; },
      summary(){ return this.entries.slice(-80); }
    };
    rootWindow.FirstMateMaterialsTiming = store;
    return store;
  }

  function timingLabel(target){
    if (!target || target === document) return 'document';
    const el = target.closest?.('button,[data-mt-open-pricebook],[data-mt-add-custom],[data-mt-remove],[data-mt-generate-materials],[data-mt-item-option],[data-preview-tab],.r-preview-tab,.mt-btn,.mt-icon-btn');
    if (!el) return cleanText(target.textContent || target.tagName || 'unknown').slice(0, 80);
    const attrs = ['data-mt-open-pricebook', 'data-mt-add-custom', 'data-mt-remove', 'data-mt-generate-materials', 'data-preview-tab', 'data-panel'];
    const attr = attrs.find((name) => el.hasAttribute?.(name));
    const attrText = attr ? `${attr}=${el.getAttribute(attr) || '1'}` : '';
    const text = cleanText(el.textContent || el.getAttribute?.('title') || el.tagName || '');
    return [el.tagName?.toLowerCase?.() || 'node', attrText, text].filter(Boolean).join(' ');
  }

  function timingMark(name, detail = {}, start){
    const store = timingStore();
    if (!store) return null;
    const now = performance.now();
    const entry = {
      name,
      at: Math.round(now * 10) / 10,
      duration: start != null ? Math.round((now - start) * 10) / 10 : undefined,
      detail
    };
    store.entries.push(entry);
    if (store.entries.length > 300) store.entries.splice(0, store.entries.length - 300);
    try {
      let node = document.getElementById('fm-materials-timing-log');
      if (!node) {
        node = document.createElement('script');
        node.type = 'application/json';
        node.id = 'fm-materials-timing-log';
        document.head.appendChild(node);
      }
      node.textContent = JSON.stringify(store.entries.slice(-160));
    } catch (_) {}
    return entry;
  }

  function installTimingProbe(){
    if (timingProbeInstalled || !timingEnabled()) return;
    timingProbeInstalled = true;
    const store = timingStore();
    if (!store) return;
    document.addEventListener('pointerdown', (event) => {
      store.lastClick = { at: performance.now(), label: timingLabel(event.target), mutationLogged: false };
      timingMark('pointerdown', { target: store.lastClick.label });
    }, true);
    document.addEventListener('click', (event) => {
      const sincePointer = store.lastClick ? performance.now() - store.lastClick.at : null;
      timingMark('click', { target: timingLabel(event.target), sincePointer: sincePointer == null ? null : Math.round(sincePointer * 10) / 10 });
    }, true);
    try {
      const observer = new MutationObserver((mutations) => {
        if (!store.lastClick || store.lastClick.mutationLogged) return;
        store.lastClick.mutationLogged = true;
        timingMark('first-dom-mutation-after-click', {
          target: store.lastClick.label,
          sincePointer: Math.round((performance.now() - store.lastClick.at) * 10) / 10,
          mutations: mutations.length
        });
      });
      observer.observe(document.body, { childList: true, subtree: true, attributes: true });
    } catch (_) {}
    try {
      const longTaskObserver = new PerformanceObserver((list) => {
        list.getEntries().forEach((entry) => timingMark('longtask', { duration: Math.round(entry.duration * 10) / 10, start: Math.round(entry.startTime * 10) / 10 }));
      });
      longTaskObserver.observe({ entryTypes: ['longtask'] });
    } catch (_) {}
    timingMark('timing-probe-installed');
  }

  function cleanText(value){ return String(value ?? '').trim(); }
  function number(value, fallback = 0){
    const parsed = Number(String(value ?? '').replace(/[^0-9.-]/g, ''));
    return Number.isFinite(parsed) ? parsed : fallback;
  }
  function money(value){
    const parsed = number(value, 0);
    return `$${parsed.toLocaleString(undefined, { minimumFractionDigits: parsed % 1 ? 2 : 0, maximumFractionDigits: 2 })}`;
  }
  function titleFromKey(value){
    return cleanText(value).replace(/_/g, ' ').replace(/\b\w/g, (char) => char.toUpperCase());
  }
  function todayIso(){ return new Date().toISOString(); }
  function uid(prefix){
    return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
  }
  function orgId(){
    return cleanText(state.context?.orgId || cfg.userOrgId || cfg.orgId || window.__APP?.userOrgId || '');
  }
  function branchId(){
    return cleanText(state.context?.branchId || window.Portal?.branchModules?.currentBranchId?.() || cfg.userBranchId || window.__APP?.userBranchId || 'default') || 'default';
  }
  function projectId(){
    return cleanText(state.project?.id || state.context?.projectId || state.context?.entityId || '');
  }
  function apiReady(){
    return !!(window.MaterialsAPI?.projects && orgId() && projectId());
  }
  function pricebook(){
    return window.FirstMatePricebook || window.Portal?.modules?.pricebook || null;
  }
  function projectHost(){
    return state.context?.projectWorkspace || state.context?.host || state.host || {};
  }
  function callHost(name, ...args){
    const fn = projectHost()[name];
    return typeof fn === 'function' ? fn(...args) : undefined;
  }
  function projectFromContext(context = {}){
    return context.project || context.activeProject || context.projectModel?.state?.activeBaseProject || state.project || null;
  }

  function css(){
    return `
      .mt-app{height:100%;min-height:0;display:flex;flex-direction:column;background:#f7f8fb;color:#111827;font-family:Inter,system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif}
      .r-overlay.materials-workspace #rProposalSection.visible{min-height:0}
      .r-overlay.materials-workspace #rProposalList{min-height:0;gap:0}
      .mt-top{display:flex;align-items:center;justify-content:space-between;gap:12px;padding:14px 16px;border-bottom:1px solid rgba(15,23,42,.08);background:#fff}
      .mt-title{display:flex;align-items:center;gap:10px;min-width:0}
      .mt-title i{width:34px;height:34px;border-radius:8px;display:flex;align-items:center;justify-content:center;background:rgba(var(--primary-rgb,217,48,37),.10);color:var(--primary-readable,var(--primary,#d93025))}
      .mt-title strong{display:block;font-size:14px;color:#101828;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
      .mt-title span{display:block;font-size:11px;font-weight:800;color:#667085;margin-top:2px}
      .mt-actions{display:flex;align-items:center;gap:8px;flex-wrap:wrap;justify-content:flex-end}
      .mt-btn,.mt-icon-btn{border:1px solid rgba(15,23,42,.12);background:#fff;color:#344054;border-radius:8px;min-height:34px;font-size:12px;font-weight:900;display:inline-flex;align-items:center;justify-content:center;gap:7px;cursor:pointer;transition:.16s ease}
      .mt-btn{padding:8px 11px}.mt-icon-btn{width:34px;padding:0}
      .mt-btn:hover:not(:disabled),.mt-icon-btn:hover:not(:disabled){border-color:rgba(var(--primary-rgb,217,48,37),.28);color:var(--primary-readable,var(--primary,#d93025));box-shadow:0 6px 16px rgba(15,23,42,.08)}
      .mt-btn.primary{background:var(--primary,#d93025);border-color:var(--primary,#d93025);color:var(--on-primary,#fff);box-shadow:0 12px 24px rgba(var(--primary-rgb,217,48,37),.18)}
      .mt-btn.primary:hover:not(:disabled){background:var(--primary-dark,var(--primary,#d93025));border-color:var(--primary-dark,var(--primary,#d93025));color:var(--on-primary,#fff);box-shadow:0 14px 28px rgba(var(--primary-rgb,217,48,37),.22)}
      .mt-btn.success{background:#067647;border-color:#067647;color:#fff}
      .mt-btn.warn{background:#fffaeb;border-color:#fedf89;color:#93370d}
      .mt-btn:disabled,.mt-icon-btn:disabled{opacity:.55;cursor:not-allowed}
      .mt-body{flex:1;min-height:0;display:flex;overflow:hidden}
      .mt-status{display:inline-flex;align-items:center;width:max-content;gap:6px;padding:4px 7px;border-radius:999px;background:#f2f4f7;color:#344054;font-size:10px;font-weight:1000;text-transform:capitalize}
      .mt-status.ordered,.mt-status.scheduled{background:#eff8ff;color:#175cd3}.mt-status.delivered{background:#ecfdf3;color:#067647}.mt-status.planning{background:#fffaeb;color:#93370d}
      .mt-main{position:relative;flex:1;min-width:0;min-height:0;overflow:hidden;padding:14px;display:flex;flex-direction:column;gap:12px}
      .mt-toolbar{display:grid;grid-template-columns:minmax(180px,1fr) auto;gap:10px;align-items:center}
      .mt-search{width:100%;border:1px solid rgba(15,23,42,.12);border-radius:8px;padding:9px 11px;font-size:12px;font-weight:800;outline:none;background:#fff}
      .mt-search:focus,.mt-input:focus,.mt-select:focus{border-color:rgba(var(--primary-rgb,217,48,37),.36);box-shadow:0 0 0 4px rgba(var(--primary-rgb,217,48,37),.1)}
      .mt-section-tabs{display:flex;align-items:center;gap:7px;overflow:auto;scrollbar-width:none}
      .mt-section-tabs::-webkit-scrollbar{display:none}
      .mt-section-tab{border:1px solid transparent;background:transparent;color:#667085;min-height:32px;padding:6px 9px;border-radius:8px;font-size:11px;font-weight:950;display:inline-flex;align-items:center;gap:6px;white-space:nowrap;cursor:pointer}
      .mt-section-tab.active{background:#fff;border-color:rgba(15,23,42,.1);color:#101828;box-shadow:0 5px 14px rgba(15,23,42,.06)}
      .mt-material-grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:14px;align-items:start}
      .mt-material-scroll{flex:1;min-height:0;overflow:auto}
      .mt-material-column{display:flex;flex-direction:column;gap:14px;min-width:0}
      .mt-material-empty{grid-column:1/-1}
      .mt-section{background:#fff;border:1px solid rgba(15,23,42,.08);border-radius:8px;overflow:hidden}
      .mt-section.needs-data{border-color:#fedf89;background:#fffcf5}
      .mt-section-head{min-height:40px;padding:8px 10px;border-bottom:1px solid rgba(15,23,42,.08);display:flex;align-items:center;justify-content:space-between;gap:10px}
      .mt-section-head h3{margin:0;font-size:13px;color:#101828;display:flex;align-items:center;gap:8px}
      .mt-section-head span{font-size:11px;font-weight:900;color:#667085}.mt-section-head .mt-warn{color:#93370d;background:#fffaeb;border:1px solid #fedf89;border-radius:999px;padding:3px 7px}
      .mt-table{width:100%;border-collapse:collapse;table-layout:fixed}
      .mt-table th,.mt-table td{box-sizing:border-box;padding:7px 10px;border-bottom:1px solid rgba(15,23,42,.06);text-align:left;font-size:12px;vertical-align:middle}
      .mt-table th{font-size:10px;text-transform:uppercase;letter-spacing:0;color:#667085;background:#f9fafb;height:26px}
      .mt-table th:last-child,.mt-table td:last-child{padding-left:10px;padding-right:10px;text-align:center}
      .mt-table .mt-icon-btn{width:28px;min-width:28px;min-height:28px;border-radius:7px}
      .mt-table tr:last-child td{border-bottom:0}
      .mt-line-main{min-width:0;display:flex;flex-direction:column;gap:3px}.mt-line-main strong{display:block;font-size:12px;color:#101828;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.mt-line-main span{display:block;font-size:10px;font-weight:800;color:#667085;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
      .mt-input,.mt-select{width:100%;border:1px solid rgba(15,23,42,.12);border-radius:8px;padding:8px 9px;font-size:12px;font-weight:800;background:#fff;color:#101828;outline:none}
      .mt-cell-input{border:0;border-radius:0;background:transparent;padding:3px 2px;min-height:28px;box-shadow:none}
      .mt-cell-input:focus{border:0!important;box-shadow:inset 0 -2px 0 rgba(var(--primary-rgb,217,48,37),.32)!important;background:rgba(var(--primary-rgb,217,48,37),.035)}
      .mt-number{max-width:100%}.mt-qty-input{min-width:5ch;text-align:right}.mt-small{font-size:11px;color:#667085;font-weight:800}.mt-empty{padding:18px 12px;text-align:center;color:#667085;font-size:12px;font-weight:850}
      .mt-variant-select{width:min(100%,190px);border:0;background:transparent;color:#344054;font-size:11px;font-weight:900;outline:none;padding:0}
      .mt-color-trigger{border:0;background:transparent;padding:0;display:inline-flex;align-items:center;max-width:100%;cursor:pointer}
      .mt-color-current{display:inline-flex;align-items:center;gap:5px;max-width:100%}.mt-color-current em{font-style:normal;font-size:10px;font-weight:900;color:#344054;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:70px}.mt-color-trigger.rich .mt-color-current em{display:none}
      .mt-color-swatch{width:22px;height:22px;border-radius:7px;border:1px solid rgba(15,23,42,.18);box-shadow:inset 0 0 0 1px rgba(255,255,255,.45);display:inline-flex;background-size:cover;background-position:center}
      .mt-color-options{position:absolute;z-index:14;top:30px;left:0;display:flex;width:max-content;min-width:max-content;gap:8px;padding:8px;border-radius:10px;background:#fff;border:1px solid rgba(15,23,42,.12);box-shadow:0 14px 34px rgba(15,23,42,.18)}
      .mt-color-portal{position:fixed;z-index:2147482600}
      .mt-color-portal .mt-color-options{position:static;top:auto;left:auto}
      .mt-color-portal.rich .mt-color-options{display:grid;width:250px;min-width:250px;grid-template-columns:repeat(2,minmax(0,1fr));gap:7px}
      .mt-color-option{width:30px;height:30px;border-radius:8px;border:2px solid transparent;cursor:pointer;box-shadow:inset 0 0 0 1px rgba(255,255,255,.45),0 0 0 1px rgba(15,23,42,.12);background-size:cover;background-position:center}
      .mt-color-option.rich{width:100%;height:58px;display:flex;align-items:flex-end;justify-content:flex-start;padding:5px;text-align:left}.mt-color-option span{display:none}.mt-color-option.rich span{display:block;background:rgba(255,255,255,.9);border-radius:6px;padding:2px 5px;color:#101828;font-size:10px;font-weight:950;max-width:100%;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
      .mt-color-option.active{border-color:var(--primary,#d93025)}
      .mt-card{background:#fff;border:1px solid rgba(15,23,42,.08);border-radius:8px;padding:12px;display:flex;flex-direction:column;gap:10px}
      .mt-card h3{margin:0;font-size:13px;color:#101828;display:flex;align-items:center;gap:8px}.mt-card p{margin:0;color:#667085;font-size:12px;font-weight:800;line-height:1.45}
      dialog.mt-card:not([open]){display:none!important}
      dialog.mt-card[open]{display:flex}
      .mt-pricebook-panel{position:absolute;right:14px;top:6px;z-index:9;width:min(390px,calc(100% - 28px));max-height:calc(100% - 12px);background:#fff;border:1px solid rgba(15,23,42,.12);border-radius:8px;box-shadow:0 24px 70px rgba(15,23,42,.22);display:flex;flex-direction:column;overflow:hidden}
      .mt-pricebook-head{padding:10px 11px;border-bottom:1px solid rgba(15,23,42,.08);display:flex;align-items:center;justify-content:space-between;gap:10px}.mt-pricebook-head strong{font-size:13px;color:#101828}.mt-pricebook-body{padding:10px;display:flex;flex-direction:column;gap:9px;min-height:0}
      .mt-suggest-list{display:flex;flex-direction:column;gap:7px;max-height:420px;overflow:auto}
      .mt-suggest{border:1px solid rgba(15,23,42,.08);border-radius:8px;background:#fff;padding:9px;display:grid;grid-template-columns:minmax(0,1fr) auto;gap:8px;align-items:center}
      .mt-suggest strong{display:block;font-size:12px;color:#101828;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.mt-suggest span{font-size:10px;font-weight:800;color:#667085}
      .mt-summary-grid{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:8px}
      .mt-stat{border:1px solid rgba(15,23,42,.08);border-radius:8px;background:#fff;padding:10px}.mt-stat span{display:block;font-size:10px;text-transform:uppercase;letter-spacing:.04em;font-weight:1000;color:#667085}.mt-stat strong{display:block;margin-top:4px;font-size:15px;color:#101828}
      .mt-footer{flex:0 0 auto;background:rgba(255,255,255,.96);border:1px solid rgba(15,23,42,.08);border-radius:8px;padding:8px;box-shadow:0 14px 32px rgba(15,23,42,.10);backdrop-filter:blur(8px)}
      .mt-footer .mt-summary-grid{grid-template-columns:repeat(3,minmax(0,1fr));gap:6px}.mt-footer .mt-stat{padding:7px 9px}.mt-footer .mt-stat strong{font-size:13px}
      .mt-form-grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:8px}.mt-form-grid .wide{grid-column:1/-1}
      .mt-orders{display:flex;flex-direction:column;gap:8px}.mt-order{border:1px solid rgba(15,23,42,.08);border-radius:8px;background:#fff;padding:10px;display:flex;align-items:flex-start;justify-content:space-between;gap:10px}.mt-order strong{font-size:12px;color:#101828}.mt-order span{display:block;font-size:11px;font-weight:800;color:#667085;margin-top:3px}
      .mt-left{height:auto;min-height:0;background:#fff;display:flex;flex-direction:column;color:#101828}
      .mt-left-head{padding:0 0 8px;border-bottom:1px solid rgba(15,23,42,.08);display:flex;align-items:center;justify-content:space-between;gap:8px}
      .mt-left-head strong{font-size:14px}.mt-left-body{padding:10px 0 0;min-height:0;overflow:visible;display:flex;flex-direction:column;gap:10px}
      .mt-prompt{font-size:11px;font-weight:950;color:#344054;text-transform:uppercase;letter-spacing:0}.mt-toggle{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:6px}
      .mt-toggle button,.mt-structure{border:1px solid rgba(15,23,42,.12);background:#fff;border-radius:8px;min-height:32px;padding:6px;font-size:12px;font-weight:950;color:#344054;cursor:pointer;display:flex;align-items:center;justify-content:center;gap:6px}
      .mt-toggle button.active,.mt-structure.active{border-color:rgba(var(--primary-rgb,217,48,37),.3);background:rgba(var(--primary-rgb,217,48,37),.08);color:var(--primary-readable,var(--primary,#d93025))}
      .mt-structure-grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:8px}.mt-structure-grid.many{grid-template-columns:repeat(3,minmax(0,1fr))}
      .mt-structure-img{width:100%;aspect-ratio:4/3;border-radius:8px;object-fit:cover;background:#f2f4f7;border:1px solid rgba(15,23,42,.08)}
      .mt-measure-card{border:1px solid rgba(15,23,42,.08);border-radius:8px;background:#fff;padding:9px;display:flex;flex-direction:column;gap:8px}
      .mt-measure-card.loading{position:relative;overflow:hidden;border-color:rgba(var(--primary-rgb,217,48,37),.24);box-shadow:inset 0 0 0 1px rgba(var(--primary-rgb,217,48,37),.08)}
      .mt-measure-card.loading:after{content:"";position:absolute;left:0;right:0;top:0;height:3px;background:linear-gradient(90deg,transparent,var(--primary,#d93025),transparent);animation:mt-loadbar 1s linear infinite}
      .mt-measure-loading{position:absolute;inset:3px 0 0;background:rgba(255,255,255,.78);backdrop-filter:blur(1px);display:flex;align-items:center;justify-content:center;gap:8px;color:#344054;font-size:11px;font-weight:1000;z-index:2}
      .mt-spin{animation:mt-spin .75s linear infinite}
      @keyframes mt-spin{to{transform:rotate(360deg)}}@keyframes mt-loadbar{from{transform:translateX(-100%)}to{transform:translateX(100%)}}
      .mt-measure-head{display:flex;align-items:center;justify-content:space-between;gap:8px}.mt-measure-card h3{margin:0;font-size:12px;color:#101828;display:flex;align-items:center;gap:7px}.mt-measure-card p{margin:0;color:#667085;font-size:11px;font-weight:800;line-height:1.35}
      .mt-subtle-btn{border:0;background:transparent;color:#667085;width:28px;height:28px;border-radius:8px;display:inline-flex;align-items:center;justify-content:center;cursor:pointer}
      .mt-subtle-btn:hover{background:rgba(15,23,42,.05);color:#344054}
      .mt-measure-grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:7px}.mt-measure-lines{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:6px}
      .mt-measure-field{border:1px solid rgba(15,23,42,.08);border-radius:8px;background:#fff;padding:6px;display:flex;flex-direction:column;gap:3px}
      .mt-measure-field.missing{background:#fffaeb;border-color:#fedf89}.mt-measure-field label{font-size:10px;font-weight:1000;color:#667085;text-transform:uppercase;letter-spacing:0}
      .mt-measure-value{display:flex;align-items:center;gap:4px}.mt-measure-value input{width:100%;min-width:0;border:0;background:transparent;padding:0;font-size:15px;font-weight:950;color:#101828;outline:none}.mt-measure-value span{font-size:10px;font-weight:900;color:#667085}
      .mt-left .mt-btn{width:100%;min-height:32px}
      .mt-detail-card{border:1px solid rgba(15,23,42,.08);border-radius:8px;background:#fff;padding:9px;display:flex;flex-direction:column;gap:8px}.mt-choice-row{display:flex;align-items:center;justify-content:space-between;gap:8px}.mt-swatch-row{display:flex;gap:8px}.mt-swatch-btn{width:32px;height:32px;border-radius:8px;border:2px solid rgba(15,23,42,.12);cursor:pointer}.mt-swatch-btn.active{border-color:var(--primary,#d93025);box-shadow:0 0 0 3px rgba(var(--primary-rgb,217,48,37),.12)}
      @media (max-width:980px){.mt-material-grid{grid-template-columns:1fr}.mt-toolbar{grid-template-columns:1fr}.mt-summary-grid{grid-template-columns:1fr}.mt-form-grid{grid-template-columns:1fr}.mt-top{align-items:flex-start;flex-direction:column}.mt-actions{justify-content:flex-start}}
    `;
  }

  function panelHtml(){
    return '<div class="mt-app" data-materials-root><div class="mt-empty">Materials</div></div>';
  }

  function defaultSections(){
    return SECTION_DEFS.map((section) => ({ id: section.key, key: section.key, title: section.title }));
  }

  function structureName(structure, index){
    return cleanText(structure.name || structure.label || structure.title || structure.id || structure.structure_id) || `Structure ${index + 1}`;
  }

  function projectStructures(){
    const project = state.project || {};
    const direct = Array.isArray(project.structures) ? project.structures : [];
    const measurement = project.measurement_project || project.measurement || {};
    const measured = Array.isArray(measurement.structures) ? measurement.structures : [];
    const pins = Array.isArray(project.pins) ? project.pins : Array.isArray(project.markers) ? project.markers : [];
    const source = direct.length ? direct : (measured.length ? measured : pins);
    const normalized = source.map((entry, index) => ({
      ...(entry && typeof entry === 'object' ? entry : {}),
      id: cleanText(entry?.id || entry?.structure_id || entry?.pin_id || `structure_${index + 1}`),
      name: structureName(entry || {}, index),
      index
    }));
    if (normalized.length) return normalized;
    return [{ id: 'main', name: 'Main Structure', index: 0 }];
  }

  function structureImage(){
    const photos = Array.isArray(state.project?.photos) ? state.project.photos : [];
    const found = photos.find((photo) => photo?.is_top_down_thumbnail || photo?.designator === 'top_down_thumbnail')
      || photos.find((photo) => /structure|top|roof|map/i.test(`${photo?.label || ''} ${photo?.alt || ''} ${photo?.designator || ''}`))
      || photos[0];
    return cleanText(found?.src || found?.url || found?.thumb || found?.thumbnail || found?.media_url);
  }

  function measurementSource(){
    const project = state.project || {};
    const reportOrderState = state.host?.getReportOrderState?.() || state.context?.reportOrderState || {};
    const reportData = reportOrderState?.data && typeof reportOrderState.data === 'object' ? reportOrderState.data : {};
    const measurement = project.measurement && typeof project.measurement === 'object' ? project.measurement : {};
    const measurementProject = project.measurement_project && typeof project.measurement_project === 'object' ? project.measurement_project : {};
    const raw = {
      ...(reportData.raw && typeof reportData.raw === 'object' ? reportData.raw : {}),
      ...(measurement.raw && typeof measurement.raw === 'object' ? measurement.raw : {}),
      ...(measurementProject.raw && typeof measurementProject.raw === 'object' ? measurementProject.raw : {})
    };
    return {
      ...raw,
      ...reportData,
      ...measurement,
      ...measurementProject,
      measurement,
      measurement_project: measurementProject,
      raw,
      manifest: raw.manifest || measurementProject.manifest || measurement.manifest || reportData.manifest,
      report: measurement.report || measurementProject.report || reportData.report,
      result: measurement.result || measurementProject.result || reportData.result,
      results: measurement.results || measurementProject.results || reportData.results,
      data: measurement.data || measurementProject.data || reportData.data,
      measurements: measurement.measurements || measurementProject.measurements || reportData.measurements,
      summary: measurement.summary || measurementProject.summary || reportData.summary,
      insights: measurement.insights || measurementProject.insights || reportData.insights,
      ...(state.measurementExtraSource && typeof state.measurementExtraSource === 'object' ? state.measurementExtraSource : {}),
      project
    };
  }

  function measurementIdFromAssetUrl(...values){
    for (const value of values) {
      const text = cleanText(value);
      if (!text) continue;
      const match = text.match(/\/projects\/([^/?#]+)/i);
      if (match?.[1]) return decodeURIComponent(match[1]);
    }
    return '';
  }

  function activeMeasurementProjectId(){
    const project = state.project || {};
    const reportOrderState = state.host?.getReportOrderState?.() || state.context?.reportOrderState || {};
    const measurement = project.measurement_project || project.measurement || {};
    const raw = measurement?.raw && typeof measurement.raw === 'object' ? measurement.raw : {};
    return cleanText(
      measurement.id
      || measurement.project_id
      || measurement.folder
      || measurement.measurement_project_id
      || raw.folder
      || raw.id
      || raw.project_id
      || reportOrderState?.data?.folder
      || reportOrderState?.data?.project?.id
      || reportOrderState?.data?.project?.project_id
      || project.measurement_project_id
      || measurementIdFromAssetUrl(
        project.report_url,
        project.pdf_url,
        project.summary_url,
        project.xml_url,
        measurement.report_url,
        measurement.pdf_url,
        measurement.summary_url,
        measurement.xml_url,
        raw.report_url,
        raw.pdf_url,
        raw.summary_url,
        raw.xml_url,
        reportOrderState?.reportUrl,
        reportOrderState?.summaryUrl,
        reportOrderState?.xmlUrl
      )
    );
  }

  function numericValue(value){
    if (value == null || value === '') return NaN;
    if (typeof value === 'number') return Number.isFinite(value) ? value : NaN;
    if (typeof value === 'object') {
      for (const key of ['value', 'amount', 'total', 'measurement', 'quantity', 'number', 'area', 'length', 'count']) {
        const parsed = numericValue(value[key]);
        if (Number.isFinite(parsed)) return parsed;
      }
      return NaN;
    }
    const parsed = Number(String(value).replace(/[^0-9.-]/g, ''));
    return Number.isFinite(parsed) ? parsed : NaN;
  }

  function pitchRiseValue(value){
    if (value == null || value === '') return NaN;
    if (typeof value === 'number') return Number.isFinite(value) ? value : NaN;
    if (typeof value === 'object') {
      for (const key of ['pitchRise', 'pitch_rise', 'rise', 'value', 'pitch']) {
        const parsed = pitchRiseValue(value[key]);
        if (Number.isFinite(parsed)) return parsed;
      }
      return NaN;
    }
    const text = String(value).trim();
    const fraction = text.match(/(\d+(?:\.\d+)?)\s*\/\s*12/);
    if (fraction) return Number(fraction[1]);
    const degrees = text.match(/(\d+(?:\.\d+)?)\s*(?:deg|degree|degrees|°)/i);
    if (degrees) return pitchDegreesToRise12(Number(degrees[1]));
    const parsed = Number(text.replace(/[^0-9.-]/g, ''));
    return Number.isFinite(parsed) && parsed > 0 && parsed < 40 ? parsed : NaN;
  }

  function firstPitchRise(source){
    const keys = ['pitchRise', 'pitch_rise', 'dominantPitch', 'dominant_pitch', 'averagePitch', 'average_pitch', 'roofPitch', 'roof_pitch', 'pitch'];
    for (const key of keys) {
      const direct = key.split('.').reduce((item, part) => item && typeof item === 'object' ? item[part] : undefined, source);
      const parsed = pitchRiseValue(direct);
      if (Number.isFinite(parsed) && parsed > 0) return parsed;
    }
    return null;
  }

  function firstNumber(source, keys){
    const normalizeKey = (key) => String(key || '').toLowerCase().replace(/[^a-z0-9]/g, '');
    const aliases = new Set();
    keys.map(normalizeKey).filter(Boolean).forEach((key) => {
      aliases.add(key);
      aliases.add(`${key}sum`);
      aliases.add(`${key}total`);
      aliases.add(`${key}value`);
    });
    for (const key of keys) {
      const direct = String(key).split('.').reduce((item, part) => item && typeof item === 'object' ? item[part] : undefined, source);
      const parsed = numericValue(direct);
      if (Number.isFinite(parsed) && parsed > 0) return parsed;
    }
    const seen = new Set();
    const scan = (value) => {
      if (!value || typeof value !== 'object' || seen.has(value)) return null;
      seen.add(value);
      if (Array.isArray(value)) {
        for (const item of value) {
          const found = scan(item);
          if (found != null) return found;
        }
        return null;
      }
      for (const [key, item] of Object.entries(value)) {
        const normalized = normalizeKey(key);
        if (aliases.has(normalized)) {
          const parsed = numericValue(item);
          if (Number.isFinite(parsed) && parsed > 0) return parsed;
        }
      }
      const label = normalizeKey(value.key || value.name || value.label || value.title || value.type || value.field || value.metric);
      if (label && aliases.has(label)) {
        const parsed = numericValue(value);
        if (Number.isFinite(parsed) && parsed > 0) return parsed;
        for (const key of ['value', 'amount', 'total', 'measurement', 'quantity', 'number', 'area', 'length', 'count']) {
          const next = numericValue(value[key]);
          if (Number.isFinite(next) && next > 0) return next;
        }
      }
      for (const item of Object.values(value)) {
        const found = scan(item);
        if (found != null) return found;
      }
      return null;
    };
    return scan(source);
  }

  function sqftToSquares(value){
    const parsed = numericValue(value);
    return Number.isFinite(parsed) && parsed > 0 ? Math.round((parsed / 100) * 10) / 10 : null;
  }

  function meters2ToSquares(value){
    const parsed = numericValue(value);
    return Number.isFinite(parsed) && parsed > 0 ? Math.round(((parsed * 10.7639104167) / 100) * 10) / 10 : null;
  }

  function pitchDegreesToRise12(degrees){
    const parsed = numericValue(degrees);
    return Number.isFinite(parsed) ? Math.max(0, Math.round(Math.tan((parsed * Math.PI) / 180) * 12)) : null;
  }

  function pitchBucketForRise(rise){
    const parsed = numericValue(rise);
    if (!Number.isFinite(parsed)) return 'pitch4to6Squares';
    if (parsed <= 2) return 'flatRoofSquares';
    if (parsed <= 4) return 'pitch2to4Squares';
    if (parsed <= 6) return 'pitch4to6Squares';
    if (parsed <= 8) return 'pitch6to8Squares';
    if (parsed <= 12) return 'pitch9to12Squares';
    return 'pitch13PlusSquares';
  }

  function dominantPitchRiseFromBuckets(measurements = {}){
    const buckets = [
      ['pitch2to4Squares', 3],
      ['pitch4to6Squares', 5],
      ['pitch6to8Squares', 7],
      ['pitch9to12Squares', 10],
      ['pitch13PlusSquares', 13]
    ];
    const dominant = buckets
      .map(([key, rise]) => ({ rise, squares: number(measurements[key], 0) }))
      .sort((a, b) => b.squares - a.squares)[0];
    return dominant?.squares > 0 ? dominant.rise : 0;
  }

  function pitchLabel(measurements = {}){
    const rise = number(measurements.pitchRise, 0);
    if (rise > 0) return `${Math.round(rise)}/12`;
    return '-';
  }

  function measurementsFromRoofSegments(source){
    const found = [];
    const seen = new Set();
    const visit = (value) => {
      if (!value || typeof value !== 'object' || seen.has(value)) return;
      seen.add(value);
      if (Array.isArray(value)) {
        value.forEach(visit);
        return;
      }
      const areaMeters = numericValue(value.roof_area_meters2 ?? value.area_meters2 ?? value.area_m2 ?? value.roofAreaMeters2);
      const areaSqft = numericValue(value.roof_area_sqft ?? value.area_sqft ?? value.roofAreaSqft);
      const areaSquares = numericValue(value.roof_squares ?? value.squares ?? value.roofSquares);
      const pitchRise = numericValue(value.pitch_rise ?? value.pitchRise ?? value.pitch);
      const pitchDegrees = numericValue(value.pitch_degrees ?? value.pitchDegrees ?? value.slope_degrees);
      const squares = Number.isFinite(areaSquares) && areaSquares > 0
        ? areaSquares
        : (Number.isFinite(areaSqft) && areaSqft > 0 ? sqftToSquares(areaSqft) : meters2ToSquares(areaMeters));
      if (squares && (Number.isFinite(pitchRise) || Number.isFinite(pitchDegrees) || Number.isFinite(areaMeters) || Number.isFinite(areaSqft))) {
        found.push({ squares, rise: Number.isFinite(pitchRise) ? pitchRise : pitchDegreesToRise12(pitchDegrees) });
      }
      Object.values(value).forEach(visit);
    };
    visit(source);
    if (!found.length) return {};
    return found.reduce((totals, segment) => {
      const key = pitchBucketForRise(segment.rise);
      totals[key] = Math.round((number(totals[key], 0) + number(segment.squares, 0)) * 10) / 10;
      return totals;
    }, {});
  }

  function xmlTextToMeasurementObject(xmlText){
    const text = cleanText(xmlText);
    if (!text || typeof DOMParser === 'undefined') return {};
    try {
      const doc = new DOMParser().parseFromString(text, 'application/xml');
      if (doc.querySelector('parsererror')) return {};
      const out = {};
      const addValue = (key, value) => {
        const cleanKey = cleanText(key);
        const parsed = numericValue(value);
        if (!cleanKey || !Number.isFinite(parsed) || parsed <= 0) return;
        if (out[cleanKey] == null) out[cleanKey] = parsed;
        else out[`${cleanKey}_sum`] = number(out[`${cleanKey}_sum`] ?? out[cleanKey], 0) + parsed;
      };
      const walk = (el, path = []) => {
        if (!el || el.nodeType !== 1) return;
        const tag = el.tagName || '';
        const nextPath = [...path, tag].filter(Boolean);
        const children = Array.from(el.children || []);
        const rawText = children.length ? '' : cleanText(el.textContent);
        if (rawText) {
          addValue(tag, rawText);
          addValue(nextPath.join('_'), rawText);
        }
        const label = el.getAttribute?.('name') || el.getAttribute?.('label') || el.getAttribute?.('type') || el.getAttribute?.('key');
        if (label && rawText) addValue(label, rawText);
        Array.from(el.attributes || []).forEach((attr) => {
          addValue(`${tag}_${attr.name}`, attr.value);
          if (label) addValue(`${label}_${attr.name}`, attr.value);
        });
        children.forEach((child) => walk(child, nextPath));
      };
      walk(doc.documentElement);
      return out;
    } catch (error) {
      return {};
    }
  }

  async function fetchMeasurementArtifact(projectId, fileName, type = 'json'){
    if (!projectId || !fileName || !fmUrl) return null;
    try {
      const response = await fetch(fmUrl(`projects/${encodeURIComponent(projectId)}/artifacts/${encodeURIComponent(fileName)}`));
      if (!response.ok) return null;
      return type === 'text' ? response.text() : response.json();
    } catch (error) {
      return null;
    }
  }

  async function loadMeasurementArtifactSource(projectId){
    if (!projectId || !fmJson) return {};
    const data = await fmJson(`projects/${encodeURIComponent(projectId)}`).catch(() => null);
    const project = data?.project && typeof data.project === 'object' ? data.project : {};
    const manifest = project?.manifest && typeof project.manifest === 'object' ? project.manifest : {};
    const files = Array.isArray(project.files) ? project.files : [];
    const byLower = new Map(files.map((file) => [cleanText(file?.name).toLowerCase(), cleanText(file?.name)]));
    const artifactName = (name) => byLower.get(cleanText(name).toLowerCase()) || '';
    const source = { detail: data, firstmeasure_project: project, firstmeasure_manifest: manifest };
    const xmlName = artifactName('model_data.xml') || 'model_data.xml';
    if (xmlName) {
      const xml = await fetchMeasurementArtifact(projectId, xmlName, 'text');
      source.model_data_xml = xmlTextToMeasurementObject(xml);
    }
    for (const fileName of ['measurements.json', 'measurement.json', 'insights.json', 'instant-structures.json']) {
      const matchedName = artifactName(fileName) || fileName;
      if (!matchedName) continue;
      const json = await fetchMeasurementArtifact(projectId, matchedName, 'json');
      if (json) source[fileName.replace(/[^a-z0-9]/gi, '_')] = json;
    }
    return source;
  }

  function measurementsHaveValues(measurements = projectMeasurements()){
    return ['slopeSquares', 'shingleSquares', 'flatRoofSquares', 'roofSquares', 'eavesLf', 'rakesLf', 'hipsLf', 'ridgesLf', 'valleyLf']
      .some((key) => number(measurements[key], 0) > 0);
  }

  async function requestMeasurementHydration(force = false){
    const measurementId = activeMeasurementProjectId();
    if (!measurementId || state.measurementLoadingId === measurementId || (!force && state.measurementLoadedId === measurementId)) return null;
    if (!force && measurementsHaveValues(reportMeasurements())) return null;
    state.measurementLoadingId = measurementId;
    return loadMeasurementArtifactSource(measurementId).then((source) => {
      state.measurementLoadedId = measurementId;
      state.measurementLoadingId = '';
      if (!source || typeof source !== 'object') return;
      state.measurementExtraSource = source;
      if (state.active) {
        renderLeft();
        render();
      }
    }).catch(() => {
      state.measurementLoadedId = measurementId;
      state.measurementLoadingId = '';
      return null;
    });
  }

  async function regenerateMeasurementsFromReport(){
    state.measurementRefreshing = true;
    state.measurementOverrides = {};
    state.measurementExtraSource = {};
    state.measurementLoadedId = '';
    renderLeft();
    const minimumFeedback = new Promise((resolve) => setTimeout(resolve, 650));
    await Promise.all([requestMeasurementHydration(true), minimumFeedback]);
    state.measurementRefreshing = false;
    renderLeft();
    render({ preserveScroll: true });
  }

  function reportMeasurements(){
    const source = measurementSource();
    const squaresFromSqft = (keys) => {
      const value = firstNumber(source, keys);
      return value == null ? null : sqftToSquares(value);
    };
    const squaresFromMeters2 = (keys) => meters2ToSquares(firstNumber(source, keys));
    const segmentMeasurements = measurementsFromRoofSegments(source);
    const flatRoofSquares = firstNumber(source, ['flatRoofSquares', 'flat_roof_squares', 'flat_squares', 'flat', 'low_slope', 'low_slope_squares'])
      ?? squaresFromSqft(['flat_roof_sqft', 'flat_roof_area_sqft', 'flat_area_sqft'])
      ?? squaresFromMeters2(['flat_roof_meters2', 'flat_roof_area_meters2'])
      ?? segmentMeasurements.flatRoofSquares
      ?? 0;
    const pitch2to4Squares = firstNumber(source, ['pitch2to4Squares', 'pitch_2_4_squares', 'pitch_2to4_squares', '2_4_squares', '2to4', '2-4'])
      ?? squaresFromSqft(['pitch_2_4_sqft', 'pitch_2to4_sqft'])
      ?? segmentMeasurements.pitch2to4Squares
      ?? 0;
    const pitch4to6Squares = firstNumber(source, ['pitch4to6Squares', 'pitch_4_6_squares', 'pitch_4to6_squares', '4_6_squares', '4to6', '4-6'])
      ?? squaresFromSqft(['pitch_4_6_sqft', 'pitch_4to6_sqft'])
      ?? segmentMeasurements.pitch4to6Squares
      ?? 0;
    const pitch6to8Squares = firstNumber(source, ['pitch6to8Squares', 'pitch_6_8_squares', 'pitch_6to8_squares', '6_8_squares', '6to8', '6-8'])
      ?? squaresFromSqft(['pitch_6_8_sqft', 'pitch_6to8_sqft'])
      ?? segmentMeasurements.pitch6to8Squares
      ?? 0;
    const pitch9to12Squares = firstNumber(source, ['pitch9to12Squares', 'pitch_9_12_squares', 'pitch_9to12_squares', '9_12_squares', '9to12', '9-12'])
      ?? squaresFromSqft(['pitch_9_12_sqft', 'pitch_9to12_sqft'])
      ?? segmentMeasurements.pitch9to12Squares
      ?? 0;
    const pitch13PlusSquares = firstNumber(source, ['pitch13PlusSquares', 'pitch_13_plus_squares', 'pitch_13plus_squares', '13_plus_squares', '13plus', '13+'])
      ?? squaresFromSqft(['pitch_13_plus_sqft', 'pitch_13plus_sqft'])
      ?? segmentMeasurements.pitch13PlusSquares
      ?? 0;
    const pitchedSquares = Math.round((pitch2to4Squares + pitch4to6Squares + pitch6to8Squares + pitch9to12Squares + pitch13PlusSquares) * 10) / 10;
    const pitchRise = firstPitchRise(source) ?? dominantPitchRiseFromBuckets({
      pitch2to4Squares,
      pitch4to6Squares,
      pitch6to8Squares,
      pitch9to12Squares,
      pitch13PlusSquares
    });
    const totalSquares = firstNumber(source, ['roofSquares', 'roof_squares', 'totalSquares', 'total_squares', 'total_roof_squares'])
      ?? squaresFromSqft(['roof_sqft', 'roof_area_sqft', 'total_roof_area_sqft', 'total_roof_sqft', 'total_area_sqft', 'area_sqft', 'roof_area', 'roofarea', 'total_roof_area', 'total_area'])
      ?? squaresFromMeters2(['total_roof_area_meters2', 'whole_roof_area_meters2', 'roof_area_meters2']);
    const shingleSquares = firstNumber(source, ['shingleSquares', 'shingle_squares', 'slopeSquares', 'slope_squares', 'steep_slope_squares'])
      ?? (pitchedSquares > 0 ? pitchedSquares : null)
      ?? (totalSquares ? Math.max(0, Math.round((totalSquares - flatRoofSquares) * 10) / 10) : 0);
    const roofSquares = totalSquares || Math.round((shingleSquares + flatRoofSquares) * 10) / 10;
    return {
      roofSquares,
      slopeSquares: shingleSquares,
      shingleSquares,
      flatRoofSquares,
      pitch2to4Squares,
      pitch4to6Squares,
      pitch6to8Squares,
      pitch9to12Squares,
      pitch13PlusSquares,
      pitchRise,
      eavesLf: firstNumber(source, ['eavesLf', 'eaves_lf', 'eave_length']) || 0,
      rakesLf: firstNumber(source, ['rakesLf', 'rakes_lf', 'rake_length', 'rakes', 'rake']) || 0,
      hipsLf: firstNumber(source, ['hipsLf', 'hips_lf', 'hip_length', 'hips', 'hip']) || 0,
      ridgesLf: firstNumber(source, ['ridgesLf', 'ridges_lf', 'ridge_length', 'ridges', 'ridge']) || 0,
      valleyLf: firstNumber(source, ['valleyLf', 'valley_lf', 'valleys_lf', 'valley_length', 'valleys', 'valley']) || 0,
      wastePercent: firstNumber(source, ['wastePercent', 'waste_percent']) || 10,
      structures: projectStructures().length
    };
  }

  function projectMeasurements(){
    const base = reportMeasurements();
    const overrides = state.measurementOverrides || {};
    const merged = { ...base, ...overrides };
    const roundMeasurement = (value, fallback = 0) => Math.round(number(value, fallback));
    merged.slopeSquares = roundMeasurement(merged.slopeSquares ?? merged.shingleSquares, 0);
    merged.shingleSquares = merged.slopeSquares;
    merged.flatRoofSquares = roundMeasurement(merged.flatRoofSquares, 0);
    merged.eavesLf = roundMeasurement(merged.eavesLf, 0);
    merged.rakesLf = roundMeasurement(merged.rakesLf, 0);
    merged.hipsLf = roundMeasurement(merged.hipsLf, 0);
    merged.ridgesLf = roundMeasurement(merged.ridgesLf, 0);
    merged.valleyLf = roundMeasurement(merged.valleyLf, 0);
    merged.wastePercent = roundMeasurement(merged.wastePercent, 10);
    merged.pitchRise = roundMeasurement(merged.pitchRise || dominantPitchRiseFromBuckets(merged), 0);
    return merged;
  }

  function loadPricebookItems(){
    const pb = pricebook();
    if (!pb) {
      state.pricebookItems = [];
      return Promise.resolve([]);
    }
    return Promise.resolve(pb.loadState?.()).catch(() => null).then(() => {
      const items = Array.isArray(pb.getState?.().items) ? pb.getState().items : [];
      state.pricebookItems = items;
      return items;
    });
  }

  function pricebookId(){
    return cleanText(cfg.pricebookId || window.__APP?.pricebookId || 'branch_pricebook');
  }

  function defaultPricebookItemsForGeneration(){
    const pb = pricebook();
    if (typeof pb?.defaultItemsForGeneration === 'function') return uniqueGenerationCatalogItems(pb.defaultItemsForGeneration());
    const byType = new Map();
    state.pricebookItems.filter((item) => item.autoAdd).forEach((item) => {
      const typeId = cleanText(item.itemTypeId || item.item_type_id || item.id);
      const current = byType.get(typeId);
      if (!current || item.isDefaultVariant || (!current.isDefaultVariant && item.variantRole === 'generic')) byType.set(typeId, item);
    });
    return [...byType.values()];
  }

  function catalogItemTypeId(item){
    return cleanText(item?.itemTypeId || item?.item_type_id || item?.itemType?.id || item?.id);
  }

  function lineItemTypeId(item){
    const direct = cleanText(item?.item_type_id
      || item?.product_selection?.item_type_id
      || item?.pricebook_ref?.item_type_id
      || item?.pricebook_snapshot?.item_type?.id
      || item?.pricebook_snapshot?.item?.itemTypeId);
    if (direct) return direct;
    const catalog = variantCatalogItemForLine(item);
    if (catalogItemTypeId(catalog)) return catalogItemTypeId(catalog);
    return inferLineItemTypeId(item);
  }

  function linePricebookItemId(item){
    return cleanText(item?.pricebook_ref?.item_id || item?.pricebookItemId || item?.product_selection?.variant_item_id);
  }

  function inferLineItemTypeId(item){
    const text = `${item?.name || ''} ${item?.description || ''} ${item?.product_selection?.variant_name || ''} ${item?.pricebook_snapshot?.variant?.name || ''}`.toLowerCase();
    const category = cleanText(item?.category || item?.pricebook_snapshot?.item?.category);
    if (/ridge\s*vent/.test(text)) return 'ridge_vent';
    if (/ridge\s*cap/.test(text)) return 'ridge_cap';
    if (/starter/.test(text)) return 'starter';
    if (/underlayment|feltbuster|tiger\s*paw|shinglemate|roof deck protection/.test(text)) return 'underlayment';
    if (/ice\s*&?\s*water|weatherwatch|weatherlock|leak barrier|ice barrier/.test(text)) return 'leak_barrier';
    if (/drip\s*edge/.test(text)) return 'drip_edge';
    if (/valley/.test(text)) return 'valley_metal';
    if (/timberline|duration|malarkey|vista|architectural|3[-\s]?tab|presidential|shingle/.test(text)) return 'field_shingles';
    if (category === 'leak_barriers') return 'leak_barrier';
    if (category === 'underlayments') return 'underlayment';
    if (category === 'shingle_roofs') return 'field_shingles';
    if (category === 'flat_roofs') return 'flat_roof_membrane';
    return '';
  }

  function canonicalCategoryForType(typeId, fallback = ''){
    const id = cleanText(typeId);
    if (id === 'field_shingles' || id === 'starter' || id === 'ridge_cap' || id === 'steep_slope') return 'shingle_roofs';
    if (id === 'underlayment') return 'underlayments';
    if (id === 'leak_barrier') return 'leak_barriers';
    if (id === 'drip_edge' || id === 'valley_metal' || /flashing|metal/.test(id)) return 'flashing';
    if (id === 'flat_roof_membrane') return 'flat_roofs';
    return cleanText(fallback);
  }

  function sectionForMaterialType(typeId, fallbackCategory = '', fallbackSection = ''){
    const category = canonicalCategoryForType(typeId, fallbackCategory);
    return CATEGORY_TO_SECTION[category] || cleanText(fallbackSection) || 'accessories';
  }

  function lineSectionKey(item){
    const typeId = lineItemTypeId(item);
    if (typeId) return sectionForMaterialType(typeId, item?.category || item?.pricebook_snapshot?.item?.category, item?.section);
    return cleanText(item?.section || CATEGORY_TO_SECTION[item?.category] || 'accessories') || 'accessories';
  }

  function uniqueGenerationCatalogItems(items = []){
    const byType = new Map();
    (Array.isArray(items) ? items : []).filter(Boolean).forEach((item) => {
      const typeId = catalogItemTypeId(item);
      const key = typeId || cleanText(item.id);
      if (!key) return;
      const current = byType.get(key);
      if (!current
        || item.isDefaultVariant
        || (!current.isDefaultVariant && item.variantRole === 'generic')
        || (!current.isDefaultVariant && current.variantRole !== 'generic' && item.autoAdd)) {
        byType.set(key, item);
      }
    });
    return [...byType.values()];
  }

  function integerQuantity(value, fallback = 0){
    const parsed = number(value, fallback);
    if (!Number.isFinite(parsed) || parsed <= 0) return 0;
    return Math.ceil(parsed);
  }

  function optionDefinitionsForItem(item){
    const snapshot = item?.pricebook_snapshot || {};
    const catalogItem = variantCatalogItemForLine(item);
    const source = Array.isArray(item?.optionDefinitions) ? item.optionDefinitions
      : Array.isArray(snapshot.option_definitions) ? snapshot.option_definitions
        : Array.isArray(snapshot.item?.optionDefinitions) ? snapshot.item.optionDefinitions
          : Array.isArray(catalogItem?.optionDefinitions) ? catalogItem.optionDefinitions
          : [];
    return source;
  }

  function optionDefinition(item, optionId){
    return optionDefinitionsForItem(item).find((definition) => cleanText(definition.id) === optionId) || null;
  }

  function optionValues(definition){
    return Array.isArray(definition?.values) ? definition.values : [];
  }

  function colorForValue(value){
    const key = cleanText(value).toLowerCase();
    if (key === 'brown' || key === 'barkwood') return '#6b442e';
    if (key === 'charcoal' || key === 'black') return '#16181d';
    if (key === 'white') return '#f8fafc';
    if (key === 'tan') return '#c7a678';
    if (key === 'gray' || key === 'grey') return '#737b84';
    if (key === 'weathered_wood') return '#8a8175';
    if (key === 'shakewood') return '#a8794d';
    if (key === 'driftwood') return '#7d7468';
    return key || '#98a2b3';
  }

  function selectedOptionsFor(item){
    return {
      ...(item?.pricebook_snapshot?.selected_options || {}),
      ...(item?.product_selection?.selected_options || {}),
      ...(item?.selected_options || {})
    };
  }

  function variantCatalogItemForLine(item){
    const id = cleanText(item?.pricebook_ref?.item_id || item?.pricebookItemId || item?.product_selection?.variant_item_id);
    return state.pricebookItems.find((entry) => cleanText(entry.id) === id) || item?.pricebook_snapshot?.item || null;
  }

  function variantsForLine(item){
    const typeId = lineItemTypeId(item);
    if (!typeId) return [];
    return state.pricebookItems.filter((entry) => cleanText(entry.itemTypeId) === typeId);
  }

  function variantGroupName(variant){
    return cleanText(variant?.variantGroupName || variant?.variant_group_name || variant?.variantGroup?.name || variant?.product_selection?.variant_group_name)
      || titleFromKey(cleanText(variant?.manufacturer && variant.manufacturer !== 'generic' ? variant.manufacturer : ''))
      || (variant?.variantRole === 'generic' ? 'Unbranded' : 'Other');
  }

  function groupedVariantsForLine(item){
    const groups = new Map();
    variantsForLine(item).forEach((variant) => {
      const groupId = cleanText(variant.variantGroupId || variant.variant_group_id || variant.variantGroup?.id || variant.manufacturer || variant.variantRole || 'other');
      const groupName = variantGroupName(variant);
      const key = `${groupId}:${groupName}`;
      if (!groups.has(key)) groups.set(key, { id: groupId, name: groupName, variants: [] });
      groups.get(key).variants.push(variant);
    });
    return [...groups.values()];
  }

  function materialPrimaryName(item){
    return cleanText(item.product_selection?.item_type_name || item.pricebook_snapshot?.item_type?.name || item.item_type_name)
      || cleanText(item.name)
      || 'Material';
  }

  function materialSecondaryText(item, hasVariants){
    const parts = [];
    if (!hasVariants) {
      const variant = cleanText(item.product_selection?.variant_name || item.pricebook_snapshot?.variant?.name);
      if (variant && variant !== item.name && variant !== materialPrimaryName(item)) parts.push(variant);
    }
    if (item.code) parts.push(item.code);
    return parts.join(' / ');
  }

  function optionValueBackground(value){
    const image = cleanText(value?.metadata?.image || value?.metadata?.imageUrl || value?.metadata?.swatchImage || value?.image || value?.imageUrl);
    if (image) return `background-image:url('${image.replaceAll("'", "\\'")}')`;
    return `background:${colorForValue(value?.value)}`;
  }

  function richColorPicker(item){
    const typeId = lineItemTypeId(item);
    const category = cleanText(item?.category || item?.pricebook_snapshot?.item?.category);
    return ['field_shingles', 'ridge_cap', 'flat_roof_membrane'].includes(typeId) || ['shingle_roofs', 'flat_roofs'].includes(category);
  }

  function defaultOptionsForCatalogItem(item, overrides = {}){
    const options = { ...(item?.defaultOptions || {}) };
    const definition = Array.isArray(item?.optionDefinitions) ? item.optionDefinitions.find((entry) => cleanText(entry.id) === 'color') : null;
    if (definition && ['flashing', 'flat_roof_accessories'].includes(cleanText(item.category))) options.color = state.flashingColor || options.color || definition.defaultValue || 'black';
    const merged = { ...options, ...overrides };
    (Array.isArray(item?.optionDefinitions) ? item.optionDefinitions : []).forEach((option) => {
      if (!Array.isArray(option.values) || !option.values.length) return;
      const selected = cleanText(merged[option.id]);
      if (!option.values.some((value) => cleanText(value.value) === selected)) {
        merged[option.id] = cleanText(option.defaultValue || option.values[0]?.value);
      }
    });
    return merged;
  }

  function lineFromPricebookItem(item, overrides = {}){
    const measurements = { ...projectMeasurements(), ...(overrides.measurements || {}) };
    const pb = pricebook();
    const derived = pb?.lineItemFromPricebook?.(item.id, measurements) || null;
    const derivedQuantity = number(derived?.quantity, 0);
    const quantity = integerQuantity(overrides.quantity ?? (derivedQuantity > 0 ? derivedQuantity : defaultMaterialQuantity(item, measurements)), 0);
    const unitPrice = number(overrides.unitPrice ?? derived?.unitPrice ?? item.unitPrice, 0);
    const section = overrides.section || CATEGORY_TO_SECTION[item.category] || 'accessories';
    const selectedOptions = defaultOptionsForCatalogItem(item, overrides.selectedOptions || {});
    return {
      id: uid('material_item'),
      section,
      structure_id: state.activeStructureId !== 'total' ? state.activeStructureId : '',
      item_type_id: cleanText(item.itemTypeId),
      variant_id: cleanText(item.variantId),
      selected_options: selectedOptions,
      product_selection: {
        item_type_id: cleanText(item.itemTypeId),
        item_type_name: cleanText(item.itemTypeName),
        variant_group_id: cleanText(item.variantGroupId),
        variant_group_name: cleanText(item.variantGroupName),
        variant_item_id: item.id,
        variant_id: cleanText(item.variantId),
        variant_name: cleanText(item.variantName),
        selected_options: selectedOptions
      },
      pricebook_ref: {
        pricebook_id: pricebookId(),
        item_id: item.id,
        item_type_id: cleanText(item.itemTypeId),
        variant_id: cleanText(item.variantId),
        variant_group_id: cleanText(item.variantGroupId),
        selected_options: selectedOptions,
        source: 'materials_tab'
      },
      pricebook_snapshot: {
        pricebook_id: pricebookId(),
        captured_at: todayIso(),
        item: { ...item },
        item_type: {
          id: cleanText(item.itemTypeId),
          name: cleanText(item.itemTypeName),
          default_variant_item_id: item.isDefaultVariant ? item.id : ''
        },
        variant: {
          id: cleanText(item.variantId),
          name: cleanText(item.variantName),
          role: cleanText(item.variantRole),
          group_id: cleanText(item.variantGroupId),
          group_name: cleanText(item.variantGroupName),
          item_id: item.id,
          is_default: !!item.isDefaultVariant
        },
        option_definitions: Array.isArray(item.optionDefinitions) ? item.optionDefinitions : [],
        selected_options: selectedOptions,
        currency: 'USD'
      },
      name: cleanText(item.name || derived?.label) || 'Material',
      code: cleanText(item.code),
      category: cleanText(item.category),
      manufacturer: cleanText(item.manufacturer || 'generic'),
      segment: cleanText(item.segment || 'all'),
      description: cleanText(item.description),
      quantity,
      unit: cleanText(item.unit || derived?.unit || 'ea'),
      projected_unit_price: unitPrice,
      projected_total: Math.round(quantity * unitPrice * 100) / 100,
      currency: 'USD',
      measurements,
      metadata: overrides.metadata || undefined
    };
  }

  function measurementValueForFormula(key, measurements = projectMeasurements()){
    const direct = number(measurements[key], NaN);
    if (Number.isFinite(direct)) return direct;
    const slope = number(measurements.slopeSquares ?? measurements.shingleSquares, 0);
    const flat = number(measurements.flatRoofSquares, 0);
    const aliases = {
      shingleSquares: slope,
      slopeSquares: slope,
      steepSlopeSquares: slope,
      roofSquares: number(measurements.roofSquares, slope + flat),
      totalSquares: number(measurements.roofSquares, slope + flat),
      flatSquares: flat,
      flatRoofSquares: flat,
      eavesLf: number(measurements.eavesLf, 0),
      rakesLf: number(measurements.rakesLf, 0),
      hipsLf: number(measurements.hipsLf, 0),
      ridgesLf: number(measurements.ridgesLf, 0),
      valleyLf: number(measurements.valleyLf, 0),
      valleysLf: number(measurements.valleyLf, 0),
      structures: Math.max(1, number(measurements.structures, 1))
    };
    return number(aliases[key], 0);
  }

  function evaluateMaterialFormula(item, measurements){
    const config = item?.formulaConfig && typeof item.formulaConfig === 'object' ? item.formulaConfig : null;
    const tokens = Array.isArray(config?.tokens) ? config.tokens : [];
    if (!tokens.length) return 0;
    const expression = tokens.map((token) => {
      if (token.type === 'measurement') return String(measurementValueForFormula(token.value, measurements));
      if (token.type === 'number') return String(number(token.value, 0));
      if (token.type === 'operator' && /^[+\-*/]$/.test(token.value)) return token.value;
      if (token.type === 'paren' && /^[()]$/.test(token.value)) return token.value;
      return '';
    }).join(' ');
    if (!/^[\d\s.+\-*/()]+$/.test(expression)) return 0;
    try {
      const value = Number(new Function(`return Number(${expression}) || 0;`)());
      const waste = config.includeWaste ? 1 + (number(measurements.wastePercent, 10) / 100) : 1;
      return Number.isFinite(value) ? value * waste : 0;
    } catch (error) {
      return 0;
    }
  }

  function defaultMaterialQuantity(item, measurements = projectMeasurements()){
    const formulaQuantity = evaluateMaterialFormula(item, measurements);
    if (formulaQuantity > 0) return roundMaterialQuantity(formulaQuantity);
    const config = item?.formulaConfig && typeof item.formulaConfig === 'object' ? item.formulaConfig : null;
    if (Array.isArray(config?.tokens) && config.tokens.length) return 0;
    const category = cleanText(item?.category);
    const unit = cleanText(item?.unit);
    const name = `${item?.name || ''} ${item?.description || ''}`.toLowerCase();
    const slope = number(measurements.slopeSquares ?? measurements.shingleSquares, 0);
    const flat = number(measurements.flatRoofSquares, 0);
    const roof = number(measurements.roofSquares, slope + flat);
    const wasteFactor = 1 + (number(measurements.wastePercent, 10) / 100);
    let quantity = 0;
    if (unit === 'sq') {
      if (category === 'flat_roofs' || category === 'flat_roof_accessories') quantity = flat * wasteFactor;
      else if (category === 'disposal') quantity = roof;
      else if (category === 'shingle_roofs' || category === 'leak_barriers' || category === 'underlayments') quantity = slope * wasteFactor;
      else quantity = roof;
    } else if (unit === 'lf') {
      if (/ridge vent/.test(name)) quantity = number(measurements.ridgesLf, 0);
      else if (/ridge|cap/.test(name)) quantity = number(measurements.hipsLf, 0) + number(measurements.ridgesLf, 0);
      else if (/valley/.test(name)) quantity = number(measurements.valleyLf, 0);
      else if (/starter|drip|edge|perimeter/.test(name)) quantity = number(measurements.eavesLf, 0) + number(measurements.rakesLf, 0);
      else quantity = number(measurements.eavesLf, 0) + number(measurements.rakesLf, 0) + number(measurements.valleyLf, 0);
    } else if (unit === 'ea' && /structure|drain/.test(name)) {
      quantity = Math.max(1, number(measurements.structures, 1));
    }
    return roundMaterialQuantity(quantity);
  }

  function roundMaterialQuantity(value){
    return integerQuantity(value, 0);
  }

  function blankLine(section = 'accessories'){
    return {
      id: uid('material_item'),
      section,
      name: 'Custom material',
      quantity: 1,
      unit: 'ea',
      projected_unit_price: undefined,
      projected_total: undefined,
      currency: 'USD'
    };
  }

  function generatedBlankLine(section, name, quantity, unit){
    return {
      ...blankLine(section),
      name,
      quantity,
      unit,
      projected_unit_price: undefined,
      projected_total: undefined,
      metadata: { source: 'measurement_generation' }
    };
  }

  function listItems(list = state.activeList){
    return Array.isArray(list?.current_items) ? list.current_items : [];
  }

  function replaceActiveItems(items){
    if (!state.activeList) return;
    state.activeList = {
      ...state.activeList,
      current_items: Array.isArray(items) ? items : []
    };
    state.lists = state.lists.map((list) => list.id === state.activeList.id ? state.activeList : list);
  }

  function listTotals(list = state.activeList){
    const items = listItems(list);
    return items.reduce((totals, item) => {
      totals.projected += number(item.projected_total, 0);
      totals.quoted += number(item.quoted_total, 0);
      totals.paid += number(item.paid_total, 0);
      return totals;
    }, { projected: 0, quoted: 0, paid: 0 });
  }

  function primaryListFrom(lists = []){
    const usable = lists.filter(Boolean);
    return usable.find((list) => list.metadata?.primary === true || list.metadata?.role === 'primary_materials')
      || usable.find((list) => /^materials$/i.test(cleanText(list.title)))
      || usable.find((list) => /^roof materials$/i.test(cleanText(list.title)))
      || usable[0]
      || null;
  }

  function localFallbackList(){
    const items = defaultPricebookItemsForGeneration()
      .slice(0, 6)
      .map((item) => lineFromPricebookItem(item, { metadata: { source: 'measurement_generation' } }))
      .filter((item) => item && number(item.quantity, 0) > 0);
    if (!items.length) {
      items.push({
        ...blankLine('shingles'),
        metadata: { source: 'local_placeholder' }
      });
    }
    return {
      id: 'local_material_list',
      title: PRIMARY_LIST_TITLE,
      status: 'planning',
      delivery_status: 'unscheduled',
      revision: 1,
      sections: defaultSections(),
      current_items: items,
      version_number: 1,
      metadata: { primary: true, role: 'primary_materials', source: 'materials_tab' },
      local: true
    };
  }

  async function loadData(){
    const timingStart = performance.now();
    timingMark('loadData:start');
    if (!state.mounted) return;
    state.loading = true;
    state.lastError = '';
    render();
    await loadPricebookItems();
    try {
      if (!apiReady()) throw new Error('materials_api_unavailable');
      const result = await window.MaterialsAPI.projects.list(orgId(), projectId());
      state.lists = Array.isArray(result.material_lists) ? result.material_lists : [];
      if (!state.lists.length) {
        const created = await createInitialList();
        state.lists = created ? [created] : [];
      }
      const primaryList = primaryListFrom(state.lists);
      state.activeListId = cleanText(primaryList?.id);
      state.activeList = primaryList;
      await loadActiveListDetails();
    } catch (error) {
      state.lastError = error?.message === 'materials_api_unavailable' ? '' : (error?.message || 'Could not load materials.');
      const fallback = localFallbackList();
      state.lists = [fallback];
      state.activeListId = fallback.id;
      state.activeList = fallback;
      state.versions = [];
      state.orders = [];
      state.deliveriesByOrderId = {};
    } finally {
      state.loading = false;
      render();
      renderLeft();
      timingMark('loadData:end', { lists: state.lists.length, items: listItems().length }, timingStart);
    }
  }

  async function createInitialList(){
    const autoItems = defaultPricebookItemsForGeneration()
      .slice(0, 12)
      .map((item) => lineFromPricebookItem(item))
      .filter(Boolean);
    const items = autoItems.length ? autoItems : [];
    const payload = {
      title: PRIMARY_LIST_TITLE,
      branch_id: branchId(),
      sections: defaultSections(),
      items,
      resources: {
        proposal_ids: Array.isArray(state.project?.proposal_ids) ? state.project.proposal_ids : [],
        measurement_project_ids: [cleanText(state.project?.measurement_project?.id || state.project?.measurement?.id)].filter(Boolean)
      },
      metadata: { source: 'materials_tab', primary: true, role: 'primary_materials' }
    };
    const result = await window.MaterialsAPI.projects.create(orgId(), projectId(), payload);
    return result.material_list || null;
  }

  async function loadActiveListDetails(){
    if (!apiReady() || !state.activeListId || state.activeList?.local) return;
    const [versionsResult, ordersResult] = await Promise.all([
      window.MaterialsAPI.lists.versions(orgId(), state.activeListId).catch(() => ({ versions: [] })),
      window.MaterialsAPI.lists.orders(orgId(), state.activeListId).catch(() => ({ orders: [] }))
    ]);
    state.versions = Array.isArray(versionsResult.versions) ? versionsResult.versions : [];
    state.orders = Array.isArray(ordersResult.orders) ? ordersResult.orders : [];
    const deliveryPairs = await Promise.all(state.orders.map((order) => {
      return window.MaterialsAPI.orders.deliveries(orgId(), order.id)
        .then((result) => [order.id, Array.isArray(result.deliveries) ? result.deliveries : []])
        .catch(() => [order.id, []]);
    }));
    state.deliveriesByOrderId = Object.fromEntries(deliveryPairs);
  }

  async function persistVersion(payload, options = {}){
    const timingStart = performance.now();
    timingMark('persistVersion:start', { reason: payload?.reason || '', local: !apiReady() || !!state.activeList?.local });
    if (!state.activeList) return null;
    if (!apiReady() || state.activeList.local) {
      const nextItems = Array.isArray(payload.items) ? payload.items : applyLocalVersion(options.baseItems || listItems(), payload);
      state.activeList = {
        ...state.activeList,
        current_items: nextItems,
        revision: Number(state.activeList.revision || 0) + 1,
        version_number: Number(state.activeList.version_number || 0) + 1
      };
      state.lists = state.lists.map((list) => list.id === state.activeList.id ? state.activeList : list);
      const localResult = { material_list: state.activeList, version: { id: uid('local_version'), reason: payload.reason || 'manual' } };
      timingMark('persistVersion:end', { reason: payload?.reason || '', local: true, items: listItems().length }, timingStart);
      return localResult;
    }
    const result = await window.MaterialsAPI.lists.createVersion(orgId(), state.activeList.id, {
      expected_revision: state.activeList.revision,
      ...payload
    });
    state.activeList = result.material_list || state.activeList;
    state.lists = state.lists.map((list) => list.id === state.activeList.id ? state.activeList : list);
    await loadActiveListDetails();
    timingMark('persistVersion:end', { reason: payload?.reason || '', local: false, items: listItems().length }, timingStart);
    return result;
  }

  function applyLocalVersion(currentItems, payload){
    if (Array.isArray(payload.items)) return payload.items;
    const removed = new Set(Array.isArray(payload.remove_item_ids) ? payload.remove_item_ids : []);
    let next = currentItems.filter((item) => !removed.has(item.id));
    (Array.isArray(payload.update_items) ? payload.update_items : []).forEach((update) => {
      next = next.map((item) => item.id === update.id ? { ...item, ...update } : item);
    });
    (Array.isArray(payload.add_items) ? payload.add_items : []).forEach((item) => next.push(item));
    return next;
  }

  async function addItem(item){
    const timingStart = performance.now();
    timingMark('addItem:start', { pricebook: !!item?.id });
    const line = item?.id ? lineFromPricebookItem(item) : blankLine(state.selectedSection === 'all' ? 'accessories' : state.selectedSection);
    const baseItems = listItems();
    state.saving = true;
    replaceActiveItems([...baseItems, line]);
    render({ preserveScroll: true });
    try {
      await persistVersion({ reason: 'supplement', add_items: [line] }, { baseItems });
      showToast('Material added', line.name, true);
    } catch (error) {
      replaceActiveItems(baseItems);
      showToast('Could not add material', error?.message || 'Please try again.', false);
    } finally {
      state.saving = false;
      render({ preserveScroll: true });
      timingMark('addItem:end', { items: listItems().length }, timingStart);
    }
  }

  function markGenerateButtonLoading(button){
    if (!button) return;
    button.disabled = true;
    button.innerHTML = '<i class="fas fa-rotate mt-spin"></i> Generating Materials';
  }

  async function generateMaterialsFromMeasurements(){
    state.generatingMaterials = true;
    renderLeft();
    const minimumFeedback = new Promise((resolve) => setTimeout(resolve, 650));
    await nextPaint();
    if (!measurementsHaveValues(projectMeasurements())) {
      await requestMeasurementHydration(true);
    }
    const measures = projectMeasurements();
    const slopeSquares = number(measures.slopeSquares ?? measures.shingleSquares, 0);
    const flatSquares = number(measures.flatRoofSquares, 0);
    const existingItems = listItems();
    const existingByPricebookId = new Map(existingItems
      .map((item) => [linePricebookItemId(item), item])
      .filter(([id]) => id));
    const existingByTypeId = new Map();
    existingItems.forEach((item) => {
      const typeId = lineItemTypeId(item);
      if (typeId && !existingByTypeId.has(typeId)) existingByTypeId.set(typeId, item);
    });
    const existingIds = new Set(existingByPricebookId.keys());
    const candidates = uniqueGenerationCatalogItems(defaultPricebookItemsForGeneration())
      .filter((item) => {
        const section = CATEGORY_TO_SECTION[item.category] || 'accessories';
        if (section === 'shingles' && slopeSquares <= 0) return false;
        if (section === 'flat_roofing' && flatSquares <= 0) return false;
        return true;
      })
      .slice(0, 14);
    const candidateTypeIds = new Set(candidates.map((item) => catalogItemTypeId(item)).filter(Boolean));
    const candidateLines = candidates
      .map((item) => lineFromPricebookItem(item, { measurements: measures, metadata: { source: 'measurement_generation' } }))
      .filter((line) => number(line.quantity, 0) > 0)
      .reduce((lines, line) => {
        const typeId = lineItemTypeId(line);
        if (!typeId || !lines.some((existing) => lineItemTypeId(existing) === typeId)) lines.push(line);
        return lines;
      }, []);
    const generatedByPricebookId = new Map(candidateLines.map((line) => [linePricebookItemId(line), line]).filter(([id]) => id));
    const generatedByTypeId = new Map(candidateLines.map((line) => [lineItemTypeId(line), line]).filter(([id]) => id));
    const updateItems = candidateLines
      .map((line) => {
        const existing = existingByPricebookId.get(linePricebookItemId(line)) || existingByTypeId.get(lineItemTypeId(line));
        if (!existing) return null;
        return mergeGeneratedLineIntoExisting(existing, line, measures);
      })
      .filter(Boolean);
    const newCandidateLines = candidateLines.filter((line) => !existingIds.has(linePricebookItemId(line)) && !existingByTypeId.has(lineItemTypeId(line)));
    const fallback = [];
    if (!candidateLines.some((item) => item.section === 'shingles') && slopeSquares > 0) {
      fallback.push(generatedBlankLine('shingles', 'Slope roofing material', slopeSquares, 'sq'));
    }
    if (!candidateLines.some((item) => item.section === 'flat_roofing') && flatSquares > 0) {
      fallback.push(generatedBlankLine('flat_roofing', 'Flat roofing material', flatSquares, 'sq'));
    }
    if (!candidateLines.some((item) => item.section === 'underlayments') && slopeSquares > 0) {
      fallback.push(generatedBlankLine('underlayments', 'Underlayment', slopeSquares, 'sq'));
    }
    if (!candidateLines.some((item) => item.section === 'metal') && (number(measures.valleyLf, 0) || number(measures.ridgesLf, 0))) {
      fallback.push(generatedBlankLine('metal', 'Metal flashing', number(measures.valleyLf, 0) + number(measures.ridgesLf, 0), 'lf'));
    }
    const addItems = [...newCandidateLines, ...fallback];
    if (!addItems.length && !updateItems.length) {
      showToast('Nothing generated', 'No usable report measurements or price book mappings were found yet.', false);
      state.generatingMaterials = false;
      renderLeft();
      render({ preserveScroll: true });
      return;
    }
    const replacementItems = buildGeneratedMaterialList(existingItems, generatedByPricebookId, generatedByTypeId, addItems, measures, candidateTypeIds);
    applyOptimisticItems(replacementItems);
    state.saving = true;
    render({ preserveScroll: true });
    try {
      await persistVersion({ reason: 'measurement_import', items: replacementItems });
      applyOptimisticItems(mergeGeneratedItems(listItems(), replacementItems));
      const changed = addItems.length + updateItems.length;
      showToast('Materials generated', `${changed} line item${changed === 1 ? '' : 's'} updated.`, true);
    } catch (error) {
      applyOptimisticItems(replacementItems);
      showToast('Materials generated locally', 'The quantities were calculated, but the save did not finish. Try again after reviewing them.', false);
    } finally {
      await minimumFeedback;
      state.saving = false;
      state.generatingMaterials = false;
      render({ preserveScroll: true });
      renderLeft();
    }
  }

  function nextFrame(){
    return new Promise((resolve) => {
      if (typeof requestAnimationFrame === 'function') requestAnimationFrame(() => resolve());
      else setTimeout(resolve, 0);
    });
  }

  function nextPaint(){
    return new Promise((resolve) => {
      if (typeof requestAnimationFrame === 'function') {
        requestAnimationFrame(() => requestAnimationFrame(resolve));
      } else {
        setTimeout(resolve, 0);
      }
    });
  }

  function applyOptimisticItems(items){
    if (!state.activeList) return;
    state.activeList = { ...state.activeList, current_items: items };
    state.lists = state.lists.map((list) => list.id === state.activeList.id ? state.activeList : list);
  }

  function mergeGeneratedItems(currentItems, generatedItems){
    const currentById = new Map((currentItems || []).map((item) => [cleanText(item.id), item]).filter(([id]) => id));
    return (generatedItems || []).map((generated) => {
      const current = currentById.get(cleanText(generated.id));
      if (!current) return generated;
      if (number(current.quantity, 0) <= 0 && number(generated.quantity, 0) > 0) {
        return { ...current, quantity: generated.quantity, projected_total: generated.projected_total, measurements: generated.measurements };
      }
      return current;
    });
  }

  function mergeGeneratedLineIntoExisting(existing, generated, measurements){
    const quantity = number(generated.quantity, 0);
    const unitPrice = number(existing.projected_unit_price ?? existing.unit_price ?? generated.projected_unit_price, 0);
    const typeId = lineItemTypeId(generated) || lineItemTypeId(existing);
    const category = canonicalCategoryForType(typeId, generated.category || existing.category);
    const section = sectionForMaterialType(typeId, category, generated.section || existing.section);
    return {
      ...existing,
      quantity,
      unit: existing.unit || generated.unit,
      section,
      category,
      structure_id: existing.structure_id || generated.structure_id,
      item_type_id: existing.item_type_id || generated.item_type_id || typeId,
      projected_unit_price: unitPrice,
      projected_total: Math.round(quantity * unitPrice * 100) / 100,
      measurements,
      metadata: {
        ...(existing.metadata || {}),
        source: cleanText(existing.metadata?.source) || 'measurement_generation'
      }
    };
  }

  function buildGeneratedMaterialList(existingItems, generatedByPricebookId, generatedByTypeId, addItems, measurements, candidateTypeIds = new Set()){
    const generatedIds = new Set(generatedByPricebookId.keys());
    const generatedTypeIds = new Set(generatedByTypeId.keys());
    const keptTypeIds = new Set();
    const next = existingItems.map((item) => {
      const pricebookId = linePricebookItemId(item);
      const typeId = lineItemTypeId(item);
      const generated = generatedByPricebookId.get(pricebookId) || generatedByTypeId.get(typeId);
      if (typeId && (generatedTypeIds.has(typeId) || candidateTypeIds.has(typeId))) {
        if (keptTypeIds.has(typeId)) return null;
        if (!generated && candidateTypeIds.has(typeId)) return null;
        keptTypeIds.add(typeId);
      }
      if (!generated) return ensureGeneratedQuantity(item, measurements);
      return mergeGeneratedLineIntoExisting(item, generated, measurements);
    }).filter(Boolean);
    addItems.forEach((item) => {
      const pricebookId = linePricebookItemId(item);
      const typeId = lineItemTypeId(item);
      if (pricebookId && generatedIds.has(pricebookId) && next.some((existing) => linePricebookItemId(existing) === pricebookId)) return;
      if (typeId && generatedTypeIds.has(typeId) && next.some((existing) => lineItemTypeId(existing) === typeId)) return;
      next.push(item);
    });
    return next
      .map((item) => ensureGeneratedQuantity(item, measurements))
      .filter((item) => !isGenerationPlaceholder(item, generatedTypeIds))
      .filter((item) => !shouldPruneGeneratedSectionItem(item, measurements));
  }

  function isGenerationPlaceholder(item, generatedTypeIds = new Set()){
    if (!generatedTypeIds.size) return false;
    if (cleanText(item.metadata?.source) === 'local_placeholder') return true;
    return !linePricebookItemId(item)
      && !lineItemTypeId(item)
      && cleanText(item.name).toLowerCase() === 'custom material'
      && cleanText(item.unit) === 'ea'
      && number(item.quantity, 0) === 1;
  }

  function ensureGeneratedQuantity(item, measurements){
    if (number(item.quantity, 0) > 0) return item;
    const catalogItem = state.pricebookItems.find((entry) => cleanText(entry.id) === cleanText(item.pricebook_ref?.item_id || item.pricebookItemId))
      || { ...item, id: cleanText(item.pricebook_ref?.item_id || item.pricebookItemId), category: item.category, unit: item.unit, formulaConfig: item.pricebook_snapshot?.item?.formulaConfig };
    const quantity = defaultMaterialQuantity(catalogItem, measurements);
    if (quantity <= 0) return item;
    const unitPrice = number(item.projected_unit_price ?? item.unit_price ?? catalogItem.unitPrice, 0);
    return {
      ...item,
      quantity,
      projected_unit_price: unitPrice,
      projected_total: Math.round(quantity * unitPrice * 100) / 100,
      measurements
    };
  }

  function shouldPruneGeneratedSectionItem(item, measurements){
    const section = cleanText(item.section || CATEGORY_TO_SECTION[item.category] || 'accessories') || 'accessories';
    const isGenerated = cleanText(item.metadata?.source) === 'measurement_generation'
      || !!item.pricebook_ref?.item_id
      || !!item.pricebookItemId;
    if (!isGenerated || number(item.quantity, 0) > 0) return false;
    if (section === 'flat_roofing') return number(measurements.flatRoofSquares, 0) <= 0;
    if (section === 'shingles') return number(measurements.slopeSquares ?? measurements.shingleSquares, 0) <= 0;
    return false;
  }

  async function removeItem(itemId){
    const timingStart = performance.now();
    timingMark('removeItem:start', { itemId });
    const baseItems = listItems();
    state.saving = true;
    replaceActiveItems(baseItems.filter((item) => item.id !== itemId));
    render({ preserveScroll: true });
    try {
      await persistVersion({ reason: 'removal', remove_item_ids: [itemId] }, { baseItems });
      showToast('Material removed', 'The list was amended.', true);
    } catch (error) {
      replaceActiveItems(baseItems);
      showToast('Could not remove material', error?.message || 'Please try again.', false);
    } finally {
      state.saving = false;
      render({ preserveScroll: true });
      timingMark('removeItem:end', { items: listItems().length }, timingStart);
    }
  }

  async function updateItem(itemId, patch){
    const current = listItems().find((item) => item.id === itemId);
    if (!current) return;
    const quantity = patch.quantity != null ? integerQuantity(patch.quantity, current.quantity) : integerQuantity(current.quantity, 0);
    const unitPrice = patch.projected_unit_price != null ? number(patch.projected_unit_price, current.projected_unit_price) : number(current.projected_unit_price, NaN);
    const nextPatch = {
      ...patch,
      id: itemId,
      quantity,
      projected_unit_price: Number.isFinite(unitPrice) ? unitPrice : undefined,
      projected_total: Number.isFinite(unitPrice) ? Math.round(quantity * unitPrice * 100) / 100 : current.projected_total
    };
    await persistVersion({ reason: 'revision', update_items: [nextPatch] }).catch((error) => {
      showToast('Could not update material', error?.message || 'Please try again.', false);
    });
    render({ preserveScroll: true });
  }

  async function updateItemVariant(itemId, variantItemId){
    const current = listItems().find((item) => item.id === itemId);
    const catalogItem = state.pricebookItems.find((item) => item.id === variantItemId);
    if (!current || !catalogItem) return;
    const next = lineFromPricebookItem(catalogItem, {
      quantity: integerQuantity(current.quantity, 0),
      measurements: current.measurements || projectMeasurements(),
      selectedOptions: selectedOptionsFor(current)
    });
    await updateItem(itemId, {
      ...next,
      id: itemId,
      section: current.section || next.section,
      structure_id: current.structure_id || next.structure_id
    });
  }

  async function updateItemOption(itemId, optionId, value){
    const current = listItems().find((item) => item.id === itemId);
    if (!current) return;
    closeColorMenu();
    const selectedOptions = { ...selectedOptionsFor(current), [optionId]: value };
    await updateItem(itemId, {
      selected_options: selectedOptions,
      product_selection: {
        ...(current.product_selection || {}),
        selected_options: selectedOptions
      },
      pricebook_ref: {
        ...(current.pricebook_ref || {}),
        selected_options: selectedOptions
      },
      pricebook_snapshot: {
        ...(current.pricebook_snapshot || {}),
        selected_options: selectedOptions
      }
    });
  }

  async function createOrderFromForm(form){
    if (!state.activeList) return;
    const data = new FormData(form);
    const precision = cleanText(data.get('precision') || 'day');
    const scheduledWindow = {
      start_date: cleanText(data.get('start_date')),
      end_date: cleanText(data.get('end_date')),
      start_time: cleanText(data.get('start_time')),
      end_time: cleanText(data.get('end_time')),
      precision,
      timezone: Intl.DateTimeFormat().resolvedOptions().timeZone || ''
    };
    const quotedAmount = number(data.get('quoted_price'), NaN);
    const paidAmount = number(data.get('paid_price'), NaN);
    const payload = {
      title: cleanText(data.get('title')) || state.activeList.title || 'Material order',
      vendor: { name: cleanText(data.get('vendor')) },
      scheduled_window: scheduledWindow,
      delivery_status: 'scheduled',
      quoted_price: Number.isFinite(quotedAmount) ? { amount: quotedAmount, currency: 'USD' } : undefined,
      paid_price: Number.isFinite(paidAmount) ? { amount: paidAmount, currency: 'USD' } : undefined
    };
    state.saving = true;
    render();
    try {
      if (!apiReady() || state.activeList.local) {
        const order = { id: uid('local_order'), ...payload, delivery_status: 'scheduled', items: listItems(), created_at: todayIso(), revision: 1 };
        state.orders = [order, ...state.orders];
        state.activeList = { ...state.activeList, status: 'ordered', delivery_status: 'scheduled' };
      } else {
        const result = await window.MaterialsAPI.lists.createOrder(orgId(), state.activeList.id, {
          expected_revision: state.activeList.revision,
          ...payload
        });
        state.activeList = result.material_list || state.activeList;
        await loadActiveListDetails();
      }
      showToast('Order scheduled', payload.title, true);
    } catch (error) {
      showToast('Could not schedule order', error?.message || 'Please try again.', false);
    } finally {
      state.saving = false;
      render();
    }
  }

  async function recordDelivery(orderId){
    const deliveredAt = new Date().toISOString();
    state.saving = true;
    render();
    try {
      if (!apiReady()) {
        state.deliveriesByOrderId[orderId] = [{ id: uid('local_delivery'), status: 'delivered', actual_delivered_at: deliveredAt }];
        state.orders = state.orders.map((order) => order.id === orderId ? { ...order, delivery_status: 'delivered' } : order);
      } else {
        await window.MaterialsAPI.orders.recordDelivery(orgId(), orderId, {
          status: 'delivered',
          actual_delivered_at: deliveredAt
        });
        await loadActiveListDetails();
      }
      showToast('Delivery recorded', 'Materials marked delivered.', true);
    } catch (error) {
      showToast('Could not record delivery', error?.message || 'Please try again.', false);
    } finally {
      state.saving = false;
      render();
    }
  }

  function filteredItems(){
    const needle = state.search.toLowerCase();
    return listItems().filter((item) => {
      if (state.selectedSection !== 'all' && lineSectionKey(item) !== state.selectedSection) return false;
      if (state.activeStructureId !== 'total' && cleanText(item.structure_id) && cleanText(item.structure_id) !== state.activeStructureId) return false;
      if (!needle) return true;
      return `${item.name || ''} ${item.code || ''} ${item.category || ''} ${item.section || ''}`.toLowerCase().includes(needle);
    });
  }

  function sectionItems(sectionKey){
    return filteredItems().filter((item) => lineSectionKey(item) === sectionKey);
  }

  function sectionSuppressedByMeasurements(sectionKey){
    const measures = projectMeasurements();
    if (sectionKey === 'shingles') return number(measures.slopeSquares ?? measures.shingleSquares, 0) <= 0;
    if (sectionKey === 'flat_roofing') return number(measures.flatRoofSquares, 0) <= 0;
    return false;
  }

  function missingMeasurementKeys(){
    const measures = projectMeasurements();
    return [
      ['eavesLf', 'Eaves'],
      ['rakesLf', 'Rakes'],
      ['hipsLf', 'Hips'],
      ['ridgesLf', 'Ridges'],
      ['valleyLf', 'Valleys']
    ].filter(([key]) => number(measures[key], 0) <= 0).map(([, label]) => label);
  }

  function sectionNeedsMeasurements(sectionKey){
    if (sectionSuppressedByMeasurements(sectionKey)) return false;
    const missing = missingMeasurementKeys();
    if (!missing.length) return false;
    return ['metal', 'underlayments', 'accessories'].includes(sectionKey);
  }

  function suggestedItems(){
    const existing = new Set(listItems().map((item) => cleanText(item.pricebook_ref?.item_id || item.pricebookItemId)).filter(Boolean));
    const query = state.pricebookSearch.toLowerCase();
    return state.pricebookItems
      .filter((item) => !existing.has(cleanText(item.id)))
      .filter((item) => !query || `${item.name} ${item.category} ${item.description || ''}`.toLowerCase().includes(query))
      .slice(0, 24);
  }

  function statusClass(value){
    return cleanText(value).toLowerCase().replace(/[^a-z0-9_-]+/g, '_');
  }

  function ensureStyles(){
    if (stylesInjected) return;
    injectCSS('materials-tab', css());
    stylesInjected = true;
  }

  function scheduleArrange(root){
    if (!root || typeof requestAnimationFrame !== 'function') {
      arrangeMaterialColumns(root);
      return;
    }
    if (arrangeFrame) cancelAnimationFrame(arrangeFrame);
    arrangeFrame = requestAnimationFrame(() => {
      arrangeFrame = requestAnimationFrame(() => {
        arrangeFrame = 0;
        arrangeMaterialColumns(root);
      });
    });
  }

  function render(options = {}){
    const timingStart = performance.now();
    if (!state.panelRoot) return;
    const activeSelector = document.activeElement?.matches?.('[data-mt-pricebook-search]')
      ? '[data-mt-pricebook-search]'
      : '';
    const activeSelection = activeSelector ? {
      start: document.activeElement.selectionStart,
      end: document.activeElement.selectionEnd
    } : null;
    const previousScrollTop = options.preserveScroll
      ? number(state.panelRoot.querySelector('[data-materials-root] .mt-material-scroll')?.scrollTop, 0)
      : 0;
    ensureStyles();
    const root = state.panelRoot.querySelector('[data-materials-root]') || state.panelRoot;
    const list = state.activeList;
    const totals = listTotals(list);
    const htmlStart = performance.now();
    root.innerHTML = `
      <div class="mt-top">
        <div class="mt-title">
          <i class="fas fa-truck-ramp-box"></i>
          <div><strong>${escapeHtml(list?.title || 'Materials')}</strong><span>${escapeHtml(state.project?.address || state.project?.title || '')}</span></div>
        </div>
        <div class="mt-actions">
          <button type="button" class="mt-icon-btn" data-mt-refresh title="Refresh"><i class="fas fa-rotate"></i></button>
          <button type="button" class="mt-btn${state.pricebookOpen ? ' primary' : ''}" data-mt-open-pricebook><i class="fas fa-book"></i> Price Book</button>
          <button type="button" class="mt-btn" data-mt-add-custom><i class="fas fa-plus"></i> Material</button>
          <button type="button" class="mt-btn primary" data-mt-order ${!listItems().length || state.saving ? 'disabled' : ''}><i class="fas fa-calendar-plus"></i> Order</button>
        </div>
      </div>
      <div class="mt-body">
        <main class="mt-main">
          ${state.loading ? `<div class="mt-card"><p>Loading materials...</p></div>` : ''}
          ${state.lastError ? `<div class="mt-card"><p>${escapeHtml(state.lastError)}</p></div>` : ''}
          <div class="mt-material-scroll" data-mt-material-scroll>
            <div class="mt-material-grid" data-mt-material-grid>
              ${renderMaterialSections()}
            </div>
          </div>
          ${state.pricebookOpen ? renderPricebookPanel() : ''}
          <div class="mt-footer">
            <div class="mt-summary-grid">
              <div class="mt-stat"><span>Projected</span><strong>${money(totals.projected)}</strong></div>
              <div class="mt-stat"><span>Quoted</span><strong>${money(totals.quoted)}</strong></div>
              <div class="mt-stat"><span>Paid</span><strong>${money(totals.paid)}</strong></div>
            </div>
          </div>
        </main>
      </div>
      ${renderOrderDialog()}
    `;
    timingMark('render:innerHTML', { items: listItems().length, pricebookOpen: state.pricebookOpen, loading: state.loading }, htmlStart);
    const bindStart = performance.now();
    bindMain(root);
    timingMark('render:bindMain', { items: listItems().length }, bindStart);
    if (options.preserveScroll) {
      const scroller = root.querySelector('.mt-material-scroll');
      if (scroller) scroller.scrollTop = previousScrollTop;
    }
    if (activeSelector) {
      const input = root.querySelector(activeSelector);
      input?.focus?.();
      if (input?.setSelectionRange && activeSelection) input.setSelectionRange(activeSelection.start, activeSelection.end);
    }
    positionColorPortal(root);
    scheduleArrange(root);
    timingMark('render:end', { items: listItems().length, pricebookOpen: state.pricebookOpen, preserveScroll: !!options.preserveScroll }, timingStart);
  }

  function renderSectionTab(id, label, icon){
    return `<button type="button" class="mt-section-tab${state.selectedSection === id ? ' active' : ''}" data-mt-section="${escapeHtml(id)}"><i class="fas ${escapeHtml(icon)}"></i>${escapeHtml(label)}</button>`;
  }

  function materialSectionDefinitions(){
    const defs = [...SECTION_DEFS];
    const known = new Set(defs.map((section) => section.key));
    listItems().forEach((item) => {
      const key = lineSectionKey(item);
      if (known.has(key)) return;
      known.add(key);
      defs.push({ key, title: key.replace(/_/g, ' ').replace(/\b\w/g, (char) => char.toUpperCase()), icon: 'fa-box' });
    });
    return defs;
  }

  function renderMaterialSections(){
    const sections = materialSectionDefinitions()
      .filter((section) => !sectionSuppressedByMeasurements(section.key))
      .filter((section) => sectionItems(section.key).length);
    if (!sections.length) {
      return `<section class="mt-section mt-material-empty"><div class="mt-empty">No materials yet. Generate from measurements or add from the price book.</div></section>`;
    }
    const columns = [sections, []];
    return columns.map((column) => `
      <div class="mt-material-column">
        ${column.map((section) => {
      const items = sectionItems(section.key);
      return renderMaterialSection(section, items);
    }).join('')}
      </div>
    `).join('');
  }

  function renderMaterialSection(section, items = sectionItems(section.key)){
    const needsData = sectionNeedsMeasurements(section.key);
    return `
      <section class="mt-section${needsData ? ' needs-data' : ''}">
        <div class="mt-section-head"><h3><i class="fas ${escapeHtml(section.icon)}"></i>${escapeHtml(section.title)}</h3><span class="${needsData ? 'mt-warn' : ''}">${needsData ? 'Needs measurements' : `${items.length} items`}</span></div>
        <table class="mt-table">
          <colgroup><col><col style="width:86px"><col style="width:66px"><col style="width:48px"><col style="width:68px"><col style="width:52px"></colgroup>
          <thead><tr><th>Material</th><th>Color</th><th>Qty</th><th>Unit</th><th>Unit $</th><th></th></tr></thead>
          <tbody>${items.map(renderLineRow).join('')}</tbody>
        </table>
      </section>
    `;
  }

  function arrangeMaterialColumns(root){
    const timingStart = performance.now();
    const scroll = root.querySelector('[data-mt-material-scroll]');
    const grid = root.querySelector('[data-mt-material-grid]');
    if (!scroll || !grid) {
      positionColorPortal(root);
      return;
    }
    const columns = Array.from(grid.querySelectorAll('.mt-material-column'));
    if (columns.length < 2 || window.matchMedia?.('(max-width: 980px)')?.matches) {
      positionColorPortal(root);
      return;
    }
    const [left, right] = columns;
    const sections = [...left.children, ...right.children];
    if (sections.length <= 1) {
      positionColorPortal(root);
      return;
    }
    left.replaceChildren(...sections);
    right.replaceChildren();
    const gap = number(getComputedStyle(left).rowGap || getComputedStyle(left).gap, 14);
    const availableHeight = scroll.clientHeight;
    while (left.children.length > 1 && left.scrollHeight > availableHeight + 2) {
      const last = left.lastElementChild;
      if (!last) break;
      right.insertBefore(last, right.firstElementChild);
    }
    if (!right.children.length && left.children.length > 1 && left.scrollHeight + gap > availableHeight + 2) {
      right.insertBefore(left.lastElementChild, null);
    }
    positionColorPortal(root);
    timingMark('arrangeMaterialColumns', { sections: sections.length, availableHeight, leftHeight: left.scrollHeight, rightHeight: right.scrollHeight }, timingStart);
  }

  function renderLineRow(item){
    const quantity = integerQuantity(item.quantity, 0);
    const variants = variantsForLine(item);
    const secondary = materialSecondaryText(item, variants.length > 1);
    return `
      <tr data-mt-item-row="${escapeHtml(item.id)}">
        <td><div class="mt-line-main"><strong>${escapeHtml(materialPrimaryName(item))}</strong>${renderVariantControl(item, variants)}${secondary ? `<span>${escapeHtml(secondary)}</span>` : ''}</div></td>
        <td>${renderColorControl(item)}</td>
        <td><input class="mt-input mt-cell-input mt-number mt-qty-input" data-mt-item-qty="${escapeHtml(item.id)}" type="number" min="0" step="1" value="${escapeHtml(quantity || '')}" style="width:${Math.max(5, String(quantity || '').length + 2)}ch"></td>
        <td><input class="mt-input mt-cell-input" data-mt-item-unit="${escapeHtml(item.id)}" value="${escapeHtml(item.unit || '')}"></td>
        <td><input class="mt-input mt-cell-input mt-number" data-mt-item-price="${escapeHtml(item.id)}" type="number" min="0" step="0.01" value="${escapeHtml(item.projected_unit_price ?? '')}" title="${escapeHtml(item.projected_total != null ? `Total ${money(item.projected_total)}` : '')}"></td>
        <td><button type="button" class="mt-icon-btn" data-mt-remove="${escapeHtml(item.id)}" title="Remove"><i class="fas fa-trash"></i></button></td>
      </tr>
    `;
  }

  function renderVariantControl(item, variants = variantsForLine(item)){
    const currentId = cleanText(item.pricebook_ref?.item_id || item.product_selection?.variant_item_id || item.pricebookItemId);
    if (variants.length <= 1) {
      const variantName = cleanText(item.product_selection?.variant_name || item.pricebook_snapshot?.variant?.name);
      return variantName && variantName !== materialPrimaryName(item) ? `<span>${escapeHtml(variantName)}</span>` : '';
    }
    return `
      <select class="mt-variant-select" data-mt-item-variant="${escapeHtml(item.id)}">
        ${groupedVariantsForLine(item).map((group) => `
          <optgroup label="${escapeHtml(group.name)}">
            ${group.variants.map((variant) => `<option value="${escapeHtml(variant.id)}" ${variant.id === currentId ? 'selected' : ''}>${escapeHtml(variant.variantName || variant.name)}</option>`).join('')}
          </optgroup>
        `).join('')}
      </select>
    `;
  }

  function renderColorControl(item){
    const definition = optionDefinition(item, 'color');
    const values = optionValues(definition);
    if (!values.length) return '<span class="mt-small">-</span>';
    const selected = cleanText(selectedOptionsFor(item).color || definition.defaultValue || values[0]?.value);
    const selectedMeta = values.find((value) => cleanText(value.value) === selected) || values[0];
    const rich = richColorPicker(item);
    return `
      <button type="button" class="mt-color-trigger${rich ? ' rich' : ''}" data-mt-color-trigger="${escapeHtml(item.id)}" title="${escapeHtml(selectedMeta?.label || selected)}" aria-label="Choose color" aria-expanded="${state.colorMenu?.itemId === item.id ? 'true' : 'false'}">
        <span class="mt-color-current"><span class="mt-color-swatch" style="${escapeHtml(optionValueBackground(selectedMeta))}"></span>${selectedMeta?.label ? `<em>${escapeHtml(selectedMeta.label)}</em>` : ''}</span>
      </button>
    `;
  }

  function renderColorPortal(){
    const menu = state.colorMenu;
    if (!menu?.itemId) return '';
    const item = listItems().find((entry) => entry.id === menu.itemId);
    const definition = optionDefinition(item, 'color');
    const values = optionValues(definition);
    if (!item || !values.length) return '';
    const selected = cleanText(selectedOptionsFor(item).color || definition.defaultValue || values[0]?.value);
    const rich = richColorPicker(item);
    return `
      <div class="mt-color-portal${rich ? ' rich' : ''}" data-mt-color-portal style="left:${escapeHtml(menu.left)}px;top:${escapeHtml(menu.top)}px">
        <div class="mt-color-options">
          ${values.map((value) => `
            <button type="button" class="mt-color-option${rich ? ' rich' : ''}${cleanText(value.value) === selected ? ' active' : ''}" data-mt-item-option="${escapeHtml(item.id)}" data-mt-option-id="color" data-mt-option-value="${escapeHtml(value.value)}" title="${escapeHtml(value.label || value.value)}" style="${escapeHtml(optionValueBackground(value))}"><span>${escapeHtml(value.label || value.value)}</span></button>
          `).join('')}
        </div>
      </div>
    `;
  }

  function colorPortalHost(root = state.panelRoot){
    let node = root;
    let fixedHost = null;
    while (node && node !== document.body) {
      if (node.tagName === 'DIALOG' || node.getAttribute?.('aria-modal') === 'true') return node;
      const style = window.getComputedStyle?.(node);
      if (style?.position === 'fixed' && style.zIndex !== 'auto') fixedHost = node;
      node = node.parentElement;
    }
    return fixedHost || document.body;
  }

  function toggleColorMenu(itemId, trigger){
    if (state.colorMenu?.itemId === itemId) {
      closeColorMenu();
      return;
    }
    const item = listItems().find((entry) => entry.id === itemId);
    const values = optionValues(optionDefinition(item, 'color'));
    if (!item || !values.length || !trigger?.getBoundingClientRect) return;
    const rich = richColorPicker(item);
    const rect = trigger.getBoundingClientRect();
    const width = rich ? 250 : Math.max(72, Math.min(320, (values.length * 38) + 18));
    const rows = rich ? Math.ceil(values.length / 2) : 1;
    const height = rich ? (rows * 65) + 18 : 48;
    state.colorMenu = { itemId, ...colorMenuPosition(trigger, width, height) };
    const root = state.panelRoot?.querySelector?.('[data-materials-root]') || state.panelRoot;
    if (!root) return;
    document.querySelectorAll('[data-mt-color-portal]').forEach((node) => node.remove());
    const holder = document.createElement('div');
    holder.innerHTML = renderColorPortal();
    const portal = holder.firstElementChild;
    if (!portal) return;
    colorPortalHost(root).appendChild(portal);
    trigger.setAttribute('aria-expanded', 'true');
    positionColorPortal(root);
    if (typeof requestAnimationFrame === 'function') {
      requestAnimationFrame(() => positionColorPortal(root));
      requestAnimationFrame(() => requestAnimationFrame(() => positionColorPortal(root)));
    }
    window.setTimeout?.(() => positionColorPortal(root), 120);
    portal.querySelectorAll('[data-mt-item-option]').forEach((button) => {
      button.addEventListener('click', () => updateItemOption(button.dataset.mtItemOption, button.dataset.mtOptionId, button.dataset.mtOptionValue));
    });
    root.querySelector('[data-mt-material-scroll]')?.addEventListener('scroll', closeColorMenu, { once: true, passive: true });
  }

  function closeColorMenu(){
    state.colorMenu = null;
    const root = state.panelRoot?.querySelector?.('[data-materials-root]') || state.panelRoot;
    document.querySelectorAll?.('[data-mt-color-portal]')?.forEach((node) => node.remove());
    root?.querySelectorAll?.('[data-mt-color-trigger][aria-expanded="true"]')?.forEach((button) => button.setAttribute('aria-expanded', 'false'));
  }

  function colorMenuPosition(trigger, width, height){
    const rect = trigger.getBoundingClientRect();
    const maxLeft = Math.max(8, window.innerWidth - width - 8);
    const left = Math.max(8, Math.min(maxLeft, rect.left));
    let top = rect.bottom + 6;
    if (top + height > window.innerHeight - 8) top = Math.max(8, rect.top - height - 6);
    return { left: Math.round(left), top: Math.round(top) };
  }

  function positionColorPortal(root = state.panelRoot){
    const menu = state.colorMenu;
    if (!menu?.itemId || !root) return;
    const portal = document.querySelector?.('[data-mt-color-portal]');
    const trigger = Array.from(root.querySelectorAll?.('[data-mt-color-trigger]') || [])
      .find((button) => button.dataset.mtColorTrigger === menu.itemId);
    if (!portal || !trigger) return;
    const portalRect = portal.getBoundingClientRect();
    const position = colorMenuPosition(trigger, portalRect.width || 250, portalRect.height || 48);
    portal.style.left = `${position.left}px`;
    portal.style.top = `${position.top}px`;
    state.colorMenu = { ...menu, ...position };
  }

  function renderPricebookPanel(){
    const suggestions = suggestedItems();
    return `
      <div class="mt-pricebook-panel" data-mt-pricebook-panel>
        <div class="mt-pricebook-head">
          <strong><i class="fas fa-book"></i> Price Book</strong>
          <div class="mt-actions">
            <button type="button" class="mt-icon-btn" data-mt-expand-pricebook title="Open full price book"><i class="fas fa-up-right-and-down-left-from-center"></i></button>
            <button type="button" class="mt-icon-btn" data-mt-close-pricebook title="Close"><i class="fas fa-xmark"></i></button>
          </div>
        </div>
        <div class="mt-pricebook-body">
          <input class="mt-search" data-mt-pricebook-search value="${escapeHtml(state.pricebookSearch)}" placeholder="Search price book">
          <div class="mt-suggest-list">
            ${suggestions.map((item) => `
              <div class="mt-suggest">
                <div><strong>${escapeHtml(item.name)}</strong><span>${escapeHtml(item.category || '')} / ${money(item.unitPrice || 0)} per ${escapeHtml(item.unit || 'ea')}</span></div>
                <button type="button" class="mt-icon-btn" data-mt-add-pricebook="${escapeHtml(item.id)}" title="Add"><i class="fas fa-plus"></i></button>
              </div>
            `).join('') || '<div class="mt-empty">No price book items</div>'}
            </div>
        </div>
      </div>
    `;
  }

  function scheduleLabel(window = {}){
    const startDate = cleanText(window.start_date || window.date);
    const endDate = cleanText(window.end_date);
    const startTime = cleanText(window.start_time || window.time);
    const endTime = cleanText(window.end_time);
    return [startDate, endDate && endDate !== startDate ? endDate : '', startTime, endTime ? `-${endTime}` : ''].filter(Boolean).join(' ');
  }

  function renderOrders(){
    return `
      <div class="mt-card" style="margin-top:12px">
        <h3><i class="fas fa-truck"></i> Orders</h3>
        <div class="mt-orders">
          ${state.orders.map((order) => {
            const deliveries = state.deliveriesByOrderId[order.id] || [];
            const delivered = deliveries.some((delivery) => delivery.status === 'delivered') || order.delivery_status === 'delivered';
            return `
              <div class="mt-order">
                <div><strong>${escapeHtml(order.title || 'Material order')}</strong><span>${escapeHtml(scheduleLabel(order.scheduled_window) || order.ordered_at || '')}</span><em class="mt-status ${statusClass(order.delivery_status)}">${escapeHtml(order.delivery_status || 'scheduled')}</em></div>
                <button type="button" class="mt-icon-btn" data-mt-deliver="${escapeHtml(order.id)}" ${delivered ? 'disabled' : ''} title="Record delivery"><i class="fas fa-check"></i></button>
              </div>
            `;
          }).join('') || '<div class="mt-empty">No orders</div>'}
        </div>
      </div>
    `;
  }

  function renderOrderDialog(){
    return `
      <dialog class="mt-card" data-mt-order-dialog style="max-width:520px;width:calc(100vw - 36px);border:0;box-shadow:0 30px 90px rgba(15,23,42,.28)">
        <form method="dialog" data-mt-order-form>
          <h3><i class="fas fa-calendar-plus"></i> Material Order</h3>
          <div class="mt-form-grid">
            <label class="wide"><span class="mt-small">Title</span><input class="mt-input" name="title" value="${escapeHtml(state.activeList?.title || 'Material order')}"></label>
            <label><span class="mt-small">Vendor</span><input class="mt-input" name="vendor"></label>
            <label><span class="mt-small">Precision</span><select class="mt-select" name="precision"><option value="day">Day</option><option value="day_range">Day range</option><option value="time_range">Time range</option></select></label>
            <label><span class="mt-small">Start date</span><input class="mt-input" type="date" name="start_date"></label>
            <label><span class="mt-small">End date</span><input class="mt-input" type="date" name="end_date"></label>
            <label><span class="mt-small">Start time</span><input class="mt-input" type="time" name="start_time"></label>
            <label><span class="mt-small">End time</span><input class="mt-input" type="time" name="end_time"></label>
            <label><span class="mt-small">Quoted</span><input class="mt-input" type="number" min="0" step="0.01" name="quoted_price"></label>
            <label><span class="mt-small">Paid</span><input class="mt-input" type="number" min="0" step="0.01" name="paid_price"></label>
          </div>
          <div class="mt-actions" style="margin-top:12px">
            <button type="button" class="mt-btn" data-mt-close-order>Cancel</button>
            <button type="submit" class="mt-btn primary">Schedule</button>
          </div>
        </form>
      </dialog>
    `;
  }

  function bindMain(root){
    root.querySelector('[data-mt-refresh]')?.addEventListener('click', loadData);
    root.querySelector('[data-mt-add-custom]')?.addEventListener('click', () => addItem(null));
    root.querySelector('[data-mt-open-pricebook]')?.addEventListener('click', () => {
      state.pricebookOpen = !state.pricebookOpen;
      render({ preserveScroll: true });
    });
    root.querySelector('[data-mt-close-pricebook]')?.addEventListener('click', () => {
      state.pricebookOpen = false;
      render({ preserveScroll: true });
    });
    root.querySelector('[data-mt-pricebook-search]')?.addEventListener('input', (event) => {
      state.pricebookSearch = event.target.value || '';
      render({ preserveScroll: true });
    });
    root.querySelectorAll('[data-mt-add-pricebook]').forEach((button) => {
      button.addEventListener('click', () => addItem(state.pricebookItems.find((item) => item.id === button.dataset.mtAddPricebook)));
    });
    root.querySelector('[data-mt-expand-pricebook]')?.addEventListener('click', (event) => {
      const pb = pricebook();
      const originEl = event.currentTarget?.closest?.('[data-mt-pricebook-panel]') || event.currentTarget;
      const rect = originEl?.getBoundingClientRect?.();
      state.pricebookOpen = false;
      render({ preserveScroll: true });
      pb?.open?.({
        title: 'Price Book',
        subtitle: 'Edit material item types, variants, options, prices, and formulas.',
        originRect: rect ? {
          left: rect.left,
          top: rect.top,
          width: rect.width,
          height: rect.height
        } : null
      });
    });
    root.querySelectorAll('[data-mt-remove]').forEach((button) => {
      button.addEventListener('click', () => removeItem(button.dataset.mtRemove));
    });
    root.querySelectorAll('[data-mt-item-variant]').forEach((select) => {
      select.addEventListener('change', () => updateItemVariant(select.dataset.mtItemVariant, select.value));
    });
    root.querySelectorAll('[data-mt-color-trigger]').forEach((button) => {
      button.addEventListener('click', (event) => {
        event.stopPropagation();
        toggleColorMenu(button.dataset.mtColorTrigger, button);
      });
    });
    root.querySelectorAll('[data-mt-item-option]').forEach((button) => {
      button.addEventListener('click', () => updateItemOption(button.dataset.mtItemOption, button.dataset.mtOptionId, button.dataset.mtOptionValue));
    });
    if (state.colorMenu) {
      root.querySelector('[data-mt-material-scroll]')?.addEventListener('scroll', () => {
        closeColorMenu();
      }, { once: true, passive: true });
    }
    root.querySelectorAll('[data-mt-item-qty],[data-mt-item-unit],[data-mt-item-price]').forEach((input) => {
      input.addEventListener('change', () => {
        const itemId = input.dataset.mtItemQty || input.dataset.mtItemUnit || input.dataset.mtItemPrice;
        const patch = {};
        if (input.dataset.mtItemQty) patch.quantity = input.value;
        if (input.dataset.mtItemUnit) patch.unit = input.value;
        if (input.dataset.mtItemPrice) patch.projected_unit_price = input.value;
        updateItem(itemId, patch);
      });
    });
    root.querySelector('[data-mt-order]')?.addEventListener('click', () => root.querySelector('[data-mt-order-dialog]')?.showModal?.());
    root.querySelector('[data-mt-close-order]')?.addEventListener('click', () => root.querySelector('[data-mt-order-dialog]')?.close?.());
    root.querySelector('[data-mt-order-form]')?.addEventListener('submit', (event) => {
      event.preventDefault();
      root.querySelector('[data-mt-order-dialog]')?.close?.();
      createOrderFromForm(event.currentTarget);
    });
    root.querySelectorAll('[data-mt-deliver]').forEach((button) => {
      button.addEventListener('click', () => recordDelivery(button.dataset.mtDeliver));
    });
  }

  function renderLeft(){
    const timingStart = performance.now();
    if (!state.leftRoot || !state.active) return;
    const target = leftContentRoot();
    if (!target) return;
    state.leftRoot.classList.add('visible', 'mode-edit');
    state.leftRoot.classList.remove('mode-list', 'mode-send');
    const label = state.leftRoot.querySelector('#rProposalLabel');
    if (label) {
      label.textContent = 'Materials';
      label.hidden = true;
    }
    target.innerHTML = leftHtml();
    bindLeft(target);
    timingMark('renderLeft:end', { active: state.active }, timingStart);
  }

  function leftContentRoot(){
    if (!state.leftRoot) return null;
    let list = state.leftRoot.querySelector('#rProposalList');
    if (!list) {
      state.leftRoot.innerHTML = `
        <div class="r-step-shell" style="grid-template-rows:1fr"><div class="r-step-inner"><div class="r-step-body">
          <label id="rProposalLabel">Materials</label>
          <div class="r-proposal-listing" id="rProposalList"></div>
        </div></div></div>
      `;
      list = state.leftRoot.querySelector('#rProposalList');
    }
    return list;
  }

  function setWorkspaceChrome(active){
    const overlay = state.context?.overlayRoot || state.context?.roots?.overlay || $('#rOverlay');
    if (!overlay) return;
    const activeTab = state.host?.getActivePreviewTab?.() || state.context?.activeTab || '';
    const setLeftOverride = typeof state.host?.setLeftColumnOverride === 'function'
      ? state.host.setLeftColumnOverride
      : null;
    if (active) {
      overlay.classList.add('materials-workspace');
      if (setLeftOverride) setLeftOverride(true, 'materials');
      else {
        overlay.classList.add('left-override');
        overlay.dataset.leftOverrideTab = 'materials';
      }
      overlay.classList.toggle('proposal-workspace', activeTab === 'proposal');
      return;
    }
    overlay.classList.remove('materials-workspace');
    if (setLeftOverride && activeTab !== 'materials') setLeftOverride(false, 'materials');
    else if (!setLeftOverride && activeTab !== 'materials') {
      overlay.classList.remove('left-override');
      delete overlay.dataset.leftOverrideTab;
    }
    if (activeTab !== 'proposal') overlay.classList.remove('proposal-workspace');
  }

  function leftHtml(){
    const structures = projectStructures();
    const image = structureImage();
    if (!state.selectedStructureIds.size) structures.forEach((structure) => state.selectedStructureIds.add(structure.id));
    const confirmed = state.structuresConfirmed || structures.length <= 1;
    requestMeasurementHydration();
    const measures = projectMeasurements();
    const selectedStructures = structures.filter((structure) => state.selectedStructureIds.has(structure.id));
    const showStructureTabs = confirmed && structures.length > 1;
    const measurementsLoading = !!(state.measurementRefreshing || state.measurementLoadingId);
    const generatingMaterials = !!state.generatingMaterials;
    return `
      <div class="mt-left">
        <div class="mt-left-head"><strong>Materials</strong><em class="mt-status ${statusClass(state.activeList?.status)}">${escapeHtml(state.activeList?.status || 'planning')}</em></div>
        <div class="mt-left-body">
          <div class="mt-prompt">Scope</div>
          <div class="mt-toggle">
            ${scopeButton('full_roof', 'Full roof', 'fa-house')}
            ${scopeButton('partial', 'Partial', 'fa-pen-ruler')}
            ${scopeButton('repair', 'Repair', 'fa-screwdriver-wrench')}
          </div>
          ${structures.length > 1 ? `
            <div class="mt-prompt">Structures</div>
            <div class="mt-structure-grid${structures.length > 4 ? ' many' : ''}">
              ${structures.map((structure) => `
                <button type="button" class="mt-structure${state.selectedStructureIds.has(structure.id) ? ' active' : ''}" data-mt-structure="${escapeHtml(structure.id)}">
                  <i class="fas fa-${state.selectedStructureIds.has(structure.id) ? 'check' : 'plus'}"></i>${escapeHtml(structure.name)}
                </button>
              `).join('')}
            </div>
            ${!confirmed && image ? `<img class="mt-structure-img" src="${escapeHtml(image)}" alt="Structures">` : ''}
            <button type="button" class="mt-btn primary" data-mt-confirm-structures><i class="fas fa-check"></i> Confirm</button>
          ` : ''}
          ${confirmed ? `
            ${showStructureTabs ? `<div class="mt-section-tabs">
              ${selectedStructures.map((structure) => `
                <button type="button" class="mt-section-tab${state.activeStructureId === structure.id ? ' active' : ''}" data-mt-structure-tab="${escapeHtml(structure.id)}">${escapeHtml(structure.name)}</button>
              `).join('')}
              <button type="button" class="mt-section-tab${state.activeStructureId === 'total' ? ' active' : ''}" data-mt-structure-tab="total">Total</button>
            </div>` : ''}
            <div class="mt-measure-card${measurementsLoading ? ' loading' : ''}">
              ${measurementsLoading ? `<div class="mt-measure-loading"><i class="fas fa-rotate mt-spin"></i> Reloading measurements</div>` : ''}
              <div class="mt-measure-head">
                <h3><i class="fas fa-ruler-combined"></i> Measurements</h3>
                <button type="button" class="mt-subtle-btn" data-mt-refresh-measurements title="Regenerate from report" ${measurementsLoading ? 'disabled' : ''}><i class="fas fa-rotate${measurementsLoading ? ' mt-spin' : ''}"></i></button>
              </div>
              <div class="mt-measure-grid">
                ${measurementField('slopeSquares', 'Slope squares', measures.slopeSquares ?? measures.shingleSquares, 'sq', true)}
                ${measurementField('wastePercent', 'Waste', measures.wastePercent, '%')}
                ${measurementField('flatRoofSquares', 'Flat squares', measures.flatRoofSquares, 'sq', true)}
                ${measurementReadoutField('Pitch', pitchLabel(measures))}
              </div>
              <div>
                <div class="mt-prompt" style="margin-bottom:6px">Line measurements</div>
                <div class="mt-measure-lines">
                  ${measurementField('eavesLf', 'Eaves', measures.eavesLf, 'lf')}
                  ${measurementField('rakesLf', 'Rakes', measures.rakesLf, 'lf')}
                  ${measurementField('hipsLf', 'Hips', measures.hipsLf, 'lf')}
                  ${measurementField('ridgesLf', 'Ridges', measures.ridgesLf, 'lf')}
                  ${measurementField('valleyLf', 'Valleys', measures.valleyLf, 'lf')}
                </div>
              </div>
              ${renderDetailsSection()}
              <button type="button" class="mt-btn primary" data-mt-generate-materials ${state.saving || generatingMaterials ? 'disabled' : ''}><i class="fas ${generatingMaterials ? 'fa-rotate mt-spin' : 'fa-wand-magic-sparkles'}"></i> ${generatingMaterials ? 'Generating Materials' : 'Generate Materials'}</button>
              ${missingMeasurementKeys().length ? `<p>${escapeHtml(missingMeasurementKeys().join(', '))} still need roof-report values or manual entry.</p>` : ''}
            </div>
          ` : ''}
        </div>
      </div>
    `;
  }

  function scopeButton(value, label, icon){
    return `<button type="button" class="${state.roofScope === value ? 'active' : ''}" data-mt-scope="${escapeHtml(value)}"><i class="fas ${escapeHtml(icon)}"></i>${escapeHtml(label)}</button>`;
  }

  function renderDetailsSection(){
    return `
      <div class="mt-detail-card">
        <div class="mt-prompt">Details</div>
        <div class="mt-choice-row">
          <span class="mt-small">Flashing color</span>
          <div class="mt-swatch-row">
            ${['black', 'brown'].map((color) => `<button type="button" class="mt-swatch-btn${state.flashingColor === color ? ' active' : ''}" data-mt-flashing-color="${escapeHtml(color)}" title="${escapeHtml(color)}" style="background:${escapeHtml(colorForValue(color))}"></button>`).join('')}
          </div>
        </div>
      </div>
    `;
  }

  function measurementField(key, label, value, unit = '', allowZero = false){
    const parsed = number(value, 0);
    const missing = !allowZero && parsed <= 0;
    return `
      <div class="mt-measure-field${missing ? ' missing' : ''}">
        <label for="mt_${escapeHtml(key)}">${escapeHtml(label)}</label>
        <div class="mt-measure-value">
          <input id="mt_${escapeHtml(key)}" data-mt-measure="${escapeHtml(key)}" type="number" min="0" step="0.01" value="${escapeHtml(parsed)}">
          ${unit ? `<span>${escapeHtml(unit)}</span>` : ''}
        </div>
      </div>
    `;
  }

  function measurementReadoutField(label, value){
    const missing = !cleanText(value) || cleanText(value) === '-';
    return `
      <div class="mt-measure-field${missing ? ' missing' : ''}">
        <label>${escapeHtml(label)}</label>
        <div class="mt-measure-value">
          <input type="text" value="${escapeHtml(value || '-')}" readonly>
        </div>
      </div>
    `;
  }

  function bindLeft(root){
    root.querySelectorAll('[data-mt-scope]').forEach((button) => {
      button.addEventListener('click', () => {
        state.roofScope = button.dataset.mtScope || 'full_roof';
        renderLeft();
      });
    });
    root.querySelectorAll('[data-mt-measure]').forEach((input) => {
      const updateMeasurement = () => {
        const key = input.dataset.mtMeasure || '';
        state.measurementOverrides = {
          ...(state.measurementOverrides || {}),
          [key]: number(input.value, 0)
        };
      };
      const commitMeasurement = () => {
        updateMeasurement();
        renderLeft();
        render();
      };
      input.addEventListener('focus', () => input.select?.());
      input.addEventListener('input', updateMeasurement);
      input.addEventListener('change', commitMeasurement);
    });
    root.querySelector('[data-mt-generate-materials]')?.addEventListener('click', (event) => {
      markGenerateButtonLoading(event.currentTarget);
      setTimeout(() => generateMaterialsFromMeasurements(), 0);
    });
    root.querySelectorAll('[data-mt-flashing-color]').forEach((button) => {
      button.addEventListener('click', () => {
        state.flashingColor = button.dataset.mtFlashingColor || 'black';
        renderLeft();
      });
    });
    root.querySelector('[data-mt-refresh-measurements]')?.addEventListener('click', () => {
      regenerateMeasurementsFromReport();
    });
    root.querySelectorAll('[data-mt-structure]').forEach((button) => {
      button.addEventListener('click', () => {
        const id = button.dataset.mtStructure || '';
        if (state.selectedStructureIds.has(id)) state.selectedStructureIds.delete(id);
        else state.selectedStructureIds.add(id);
        if (!state.selectedStructureIds.size) state.selectedStructureIds.add(id);
        renderLeft();
      });
    });
    root.querySelector('[data-mt-confirm-structures]')?.addEventListener('click', () => {
      state.structuresConfirmed = true;
      renderLeft();
      render();
    });
    root.querySelectorAll('[data-mt-structure-tab]').forEach((button) => {
      button.addEventListener('click', () => {
        state.activeStructureId = button.dataset.mtStructureTab || 'total';
        renderLeft();
        render();
      });
    });
  }

  function mount(context = {}){
    installTimingProbe();
    const timingStart = performance.now();
    timingMark('mount:start', { active: context.active !== false });
    const nextProject = projectFromContext(context);
    const previousProjectId = cleanText(state.project?.id || state.context?.projectId || state.context?.entityId);
    const nextProjectId = cleanText(nextProject?.id || context.projectId || context.entityId);
    state.context = context;
    state.host = context.host || context.projectWorkspace || state.host;
    state.project = nextProject;
    if (previousProjectId && nextProjectId && previousProjectId !== nextProjectId) {
      state.measurementExtraSource = {};
      state.measurementLoadingId = '';
      state.measurementLoadedId = '';
      state.measurementOverrides = {};
    }
    state.panelRoot = context.panelRoot || context.roots?.main || context.root || state.panelRoot;
    state.leftRoot = context.leftRoot || context.roots?.left || state.leftRoot;
    state.active = context.active !== false;
    state.mounted = !!state.panelRoot;
    if (state.panelRoot && !state.panelRoot.querySelector('[data-materials-root]')) state.panelRoot.innerHTML = panelHtml();
    const structures = projectStructures();
    if (!state.selectedStructureIds.size) structures.forEach((structure) => state.selectedStructureIds.add(structure.id));
    setWorkspaceChrome(state.active);
    loadData().catch((error) => {
      state.loading = false;
      state.lastError = error?.message || 'Could not load materials.';
      render();
    });
    renderLeft();
    timingMark('mount:end', { active: state.active, mounted: state.mounted }, timingStart);
    return api;
  }

  function setActive(active){
    installTimingProbe();
    const timingStart = performance.now();
    timingMark('setActive:start', { active: !!active, lists: state.lists.length });
    state.active = !!active;
    setWorkspaceChrome(state.active);
    if (state.active) {
      renderLeft();
      if (!state.lists.length && !state.loading) loadData();
      else render();
    } else {
      state.leftRoot?.querySelector?.('#rProposalList .mt-left')?.remove();
      const activeTab = state.host?.getActivePreviewTab?.() || state.context?.activeTab || '';
      if (activeTab !== 'proposal') state.leftRoot?.classList?.remove('visible', 'mode-edit', 'mode-list', 'mode-send');
    }
    timingMark('setActive:end', { active: state.active, lists: state.lists.length, items: listItems().length }, timingStart);
  }

  function reset(){
    state.lists = [];
    state.activeListId = '';
    state.activeList = null;
    state.versions = [];
    state.orders = [];
    state.deliveriesByOrderId = {};
    state.selectedStructureIds = new Set();
    state.structuresConfirmed = false;
    state.activeStructureId = 'total';
    state.roofScope = 'full_roof';
    state.measurementOverrides = {};
    state.measurementExtraSource = {};
    state.measurementLoadingId = '';
    state.measurementLoadedId = '';
    state.measurementRefreshing = false;
    state.generatingMaterials = false;
    state.flashingColor = 'black';
    state.pricebookOpen = false;
    state.pricebookSearch = '';
    state.colorMenu = null;
    state.search = '';
    state.selectedSection = 'all';
  }

  function destroy(){
    if (arrangeFrame && typeof cancelAnimationFrame === 'function') cancelAnimationFrame(arrangeFrame);
    arrangeFrame = 0;
    state.leftRoot?.querySelector?.('#rProposalList .mt-left')?.remove();
    state.leftRoot?.classList?.remove('visible', 'mode-edit', 'mode-list', 'mode-send');
    reset();
    state.mounted = false;
    state.panelRoot = null;
    state.leftRoot = null;
  }

  function invoke(name, args = []){
    const fn = api[name];
    return typeof fn === 'function' ? fn(...(Array.isArray(args) ? args : [])) : undefined;
  }

  const api = {
    mount,
    setActive,
    activate: () => setActive(true),
    deactivate: () => setActive(false),
    render,
    renderAll: render,
    renderLeft,
    loadData,
    reset,
    destroy,
    unmount: destroy,
    invoke,
    debugTiming: () => rootWindow.FirstMateMaterialsTiming?.summary?.() || [],
    context: () => ({
      mounted: state.mounted,
      active: state.active,
      listCount: state.lists.length,
      activeListId: state.activeListId
    })
  };

  Portal.modules = Portal.modules || {};
  Portal.modules.materialsTab = api;
  Portal.MaterialsTab = api;

  runtime?.registerApp?.({
    id: 'project.materials',
    kind: 'project_modal_app',
    title: 'Materials',
    label: 'Materials',
    icon: 'fa-truck-ramp-box',
    order: 55,
    visible: true,
    surfaces: ['project_modal'],
    regions: ['main', 'left'],
    requiresContext: ['project'],
    dependencies: ['pricebook.bridge'],
    enabled: (context = {}) => context.materialsEnabled !== false,
    panelHtml,
    mount
  });
})();
