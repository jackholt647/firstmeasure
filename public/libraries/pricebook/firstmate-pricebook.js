/* libraries/pricebook/firstmate-pricebook.js
 * Shared pricebook editor, persistence, and pricing helpers.
 */
(function(){
  const root = window;
  if (root.FirstMatePricebook?.__initialized) return;
  const scriptBase = document.currentScript?.src ? new URL('.', document.currentScript.src).href : '';

  const portalUtil = root.Portal?.util || {};
  const injectCSS = portalUtil.injectCSS || function(id, cssText){
    const styleId = `fm-style-${id}`;
    if (document.getElementById(styleId)) return;
    const style = document.createElement('style');
    style.id = styleId;
    style.textContent = cssText;
    document.head.appendChild(style);
  };
  const escapeHtml = portalUtil.escapeHtml || function(value){
    return String(value ?? '')
      .replaceAll('&', '&amp;')
      .replaceAll('<', '&lt;')
      .replaceAll('>', '&gt;')
      .replaceAll('"', '&quot;')
      .replaceAll("'", '&#39;');
  };

  const STORAGE_KEY = 'fm_pricebook_v3';
  const DEFAULT_PRICEBOOK_PATH = scriptBase ? new URL('default-pricebook.json', scriptBase).href : 'scripts/Pricebook.json';
  const BRANCH_MODULE_ID = 'pricebook';
  const config = {
    storageKey: STORAGE_KEY,
    defaultPricebookPath: DEFAULT_PRICEBOOK_PATH,
    moduleId: BRANCH_MODULE_ID,
    currentBranchId: null,
    currentOrganizationId: null,
    getModule: null,
    saveModule: null,
    getOrganizationPricebook: null,
    saveOrganizationPricebook: null,
  };
  const listeners = new Set();
  let overlayBuilt = false;
  let activeRoot = null;
  let embeddedRoot = null;
  let activeItemId = null;
  let activeOptions = null;
  let loadPromise = null;
  let overlayModalHandle = null;
  let overlayCloseTimer = null;
  let remoteSaveTimer = null;
  let remoteRevision = 0;
  let remotePricebookId = '';
  let suppressRemoteSave = false;
  let remoteStorageLayer = 'local';
  let activeEditorTab = 'summary';
  const variantUiState = new Map();
  let expandedCategories = {
    misc: false,
    disposal: true,
    shingle_roofs: true,
    leak_barriers: true,
    flashing: true,
    accessories: true,
    gutters: true,
    flat_roofs: false,
    flat_roof_accessories: false,
  };
  let categoryFilters = {
    shingle_roofs: ['all'],
    leak_barriers: ['all'],
    flashing: ['all'],
  };

  const UNIT_OPTIONS = [
    { value: 'sq', label: (globalThis.PlatformLanguage?.text("pricebook","m_c5bfedc3eb7fc4","Per Square") ?? "Per Square") },
    { value: 'lf', label: (globalThis.PlatformLanguage?.text("pricebook","m_d023fd2b0d94f1","Per Linear Foot") ?? "Per Linear Foot") },
    { value: 'ea', label: (globalThis.PlatformLanguage?.text("pricebook","m_03a6f71f6603c5","Each") ?? "Each") },
    { value: 'bundle', label: (globalThis.PlatformLanguage?.text("pricebook","m_c32e7822c50350","Bundle") ?? "Bundle") },
    { value: 'hour', label: (globalThis.PlatformLanguage?.text("pricebook","m_7d95a748ead52d","Hour") ?? "Hour") },
  ];

  const MEASUREMENT_FIELDS = [
    { key: 'roofSquares', label: (globalThis.PlatformLanguage?.text("pricebook","m_279374e7361506","Roof Squares (Total)") ?? "Roof Squares (Total)") },
    { key: 'shingleSquares', label: (globalThis.PlatformLanguage?.text("pricebook","m_0479aefe1307f4","Shingle Squares") ?? "Shingle Squares") },
    { key: 'flatRoofSquares', label: (globalThis.PlatformLanguage?.text("pricebook","m_291526452322e7","Flat Roof Squares (2/12 and below)") ?? "Flat Roof Squares (2/12 and below)") },
    { key: 'pitch2to4Squares', label: (globalThis.PlatformLanguage?.text("pricebook","m_3dacfaa320818c","Squares at 2/12 - 4/12") ?? "Squares at 2/12 - 4/12") },
    { key: 'pitch4to6Squares', label: (globalThis.PlatformLanguage?.text("pricebook","m_66454cfe0c05c3","Squares at 4/12 - 6/12") ?? "Squares at 4/12 - 6/12") },
    { key: 'pitch6to8Squares', label: (globalThis.PlatformLanguage?.text("pricebook","m_95c89724494886","Squares at 6/12 - 8/12") ?? "Squares at 6/12 - 8/12") },
    { key: 'pitch9to12Squares', label: (globalThis.PlatformLanguage?.text("pricebook","m_71285dc704c5db","Squares at 9/12 - 12/12") ?? "Squares at 9/12 - 12/12") },
    { key: 'pitch13PlusSquares', label: (globalThis.PlatformLanguage?.text("pricebook","m_f80f7fe95f412f","Squares at 13/12 and above") ?? "Squares at 13/12 and above") },
    { key: 'wastePercent', label: (globalThis.PlatformLanguage?.text("pricebook","m_185415b1d2c50e","Waste %") ?? "Waste %") },
    { key: 'eavesLf', label: (globalThis.PlatformLanguage?.text("pricebook","m_f2baa3de1eb35b","Eaves") ?? "Eaves") },
    { key: 'rakesLf', label: (globalThis.PlatformLanguage?.text("pricebook","m_48029c2aaa37c6","Rakes") ?? "Rakes") },
    { key: 'hipsLf', label: (globalThis.PlatformLanguage?.text("pricebook","m_baa2f693c3883e","Hips") ?? "Hips") },
    { key: 'ridgesLf', label: (globalThis.PlatformLanguage?.text("pricebook","m_217bf30b990d24","Ridges") ?? "Ridges") },
    { key: 'valleyLf', label: (globalThis.PlatformLanguage?.text("pricebook","m_230a183ddb6e96","Valleys") ?? "Valleys") },
    { key: 'transitionsLf', label: (globalThis.PlatformLanguage?.text("pricebook","m_8ba24778829c38","Transitions") ?? "Transitions") },
    { key: 'sideWallLf', label: (globalThis.PlatformLanguage?.text("pricebook","m_9e0e4365cf6ca7","Side Wall") ?? "Side Wall") },
    { key: 'headWallLf', label: (globalThis.PlatformLanguage?.text("pricebook","m_8fa70d3d466eb2","Head Wall") ?? "Head Wall") },
    { key: 'gutterLf', label: (globalThis.PlatformLanguage?.text("pricebook","m_0b3666d6758ecd","Gutters") ?? "Gutters") },
    { key: 'downspoutLf', label: (globalThis.PlatformLanguage?.text("pricebook","m_56a31369985ac0","Downspouts") ?? "Downspouts") },
    { key: 'structures', label: (globalThis.PlatformLanguage?.text("pricebook","m_4169276a19a978","Structures") ?? "Structures") },
    { key: 'chimneysEa', label: (globalThis.PlatformLanguage?.text("pricebook","m_2586b5b0f04d70","Chimneys") ?? "Chimneys") },
    { key: 'skylightsEa', label: (globalThis.PlatformLanguage?.text("pricebook","m_f8cd783f0f9952","Skylights") ?? "Skylights") },
    { key: 'pipeBootsEa', label: (globalThis.PlatformLanguage?.text("pricebook","m_e3f935307ef27c","Pipe Boots") ?? "Pipe Boots") },
    { key: 'roofVentsEa', label: (globalThis.PlatformLanguage?.text("pricebook","m_684d328858cea9","Roof Vents") ?? "Roof Vents") },
    { key: 'ridgeVentLf', label: (globalThis.PlatformLanguage?.text("pricebook","m_8b892f884198c5","Ridge Vent") ?? "Ridge Vent") },
    { key: 'boxVentsEa', label: (globalThis.PlatformLanguage?.text("pricebook","m_0293b757a0a77c","Box Vents") ?? "Box Vents") },
  ];

  const OPERATOR_OPTIONS = ['+', '-', '*', '/'];
  const PAREN_OPTIONS = ['(', ')'];
  const CATEGORY_OPTIONS = [
    { value: 'misc', label: (globalThis.PlatformLanguage?.text("pricebook","m_fef30d6a630330","Miscellaneous") ?? "Miscellaneous") },
    { value: 'disposal', label: (globalThis.PlatformLanguage?.text("pricebook","m_988078b3382546","Disposal") ?? "Disposal") },
    { value: 'shingle_roofs', label: (globalThis.PlatformLanguage?.text("pricebook","m_93097f7fc3f433","Shingle Roofs") ?? "Shingle Roofs") },
    { value: 'leak_barriers', label: (globalThis.PlatformLanguage?.text("pricebook","m_a4d032b12ef4f7","Leak Barriers") ?? "Leak Barriers") },
    { value: 'underlayments', label: (globalThis.PlatformLanguage?.text("pricebook","m_e55a1d6e0abb11","Underlayments") ?? "Underlayments") },
    { value: 'flashing', label: (globalThis.PlatformLanguage?.text("pricebook","m_1c963ee373ad93","Flashing") ?? "Flashing") },
    { value: 'accessories', label: (globalThis.PlatformLanguage?.text("pricebook","m_9704d38f3e857e","Accessories") ?? "Accessories") },
    { value: 'gutters', label: (globalThis.PlatformLanguage?.text("pricebook","m_0b3666d6758ecd","Gutters") ?? "Gutters") },
    { value: 'flat_roofs', label: (globalThis.PlatformLanguage?.text("pricebook","m_1d73f1e75a2b2e","Flat Roofs") ?? "Flat Roofs") },
    { value: 'flat_roof_accessories', label: (globalThis.PlatformLanguage?.text("pricebook","m_bdd0c454a59fe9","Flat Roof Accessories") ?? "Flat Roof Accessories") },
  ];
  const BRAND_OPTIONS = [
    { value: 'all', label: (globalThis.PlatformLanguage?.text("pricebook","m_61df468d92e238","All") ?? "All") },
    { value: 'generic', label: (globalThis.PlatformLanguage?.text("pricebook","m_36f4d0e103592b","Generic") ?? "Generic") },
    { value: 'gaf', label: (globalThis.PlatformLanguage?.text("pricebook","m_65eec926194739","GAF") ?? "GAF") },
    { value: 'owens_corning', label: (globalThis.PlatformLanguage?.text("pricebook","m_b8503538b3f629","Owens Corning") ?? "Owens Corning") },
    { value: 'malarkey', label: (globalThis.PlatformLanguage?.text("pricebook","m_0c9a0cc17e7185","Malarkey") ?? "Malarkey") },
    { value: 'certainteed', label: (globalThis.PlatformLanguage?.text("pricebook","m_0a76afa6838ad6","CertainTeed") ?? "CertainTeed") },
    { value: 'atlas', label: (globalThis.PlatformLanguage?.text("pricebook","m_02b214c89b7c34","Atlas") ?? "Atlas") },
    { value: 'iko', label: (globalThis.PlatformLanguage?.text("pricebook","m_c6410b7b836711","IKO") ?? "IKO") },
  ];
  const FLASHING_OPTIONS = [
    { value: 'all', label: (globalThis.PlatformLanguage?.text("pricebook","m_61df468d92e238","All") ?? "All") },
    { value: 'sloped', label: (globalThis.PlatformLanguage?.text("pricebook","m_b45f12d86455d1","Sloped") ?? "Sloped") },
    { value: 'flat', label: (globalThis.PlatformLanguage?.text("pricebook","m_66667891b5d8d8","Flat") ?? "Flat") },
    { value: 'other', label: (globalThis.PlatformLanguage?.text("pricebook","m_4a04382820d2e1","Other") ?? "Other") },
  ];

  const DEFAULT_STATE = { items: [] };
  const DEFAULT_PRICING_POLICIES = [
    { id:'fixed_forever', label:(globalThis.PlatformLanguage?.text("pricebook","m_5bd1c024296f81","Fixed forever") ?? "Fixed forever"), mode:'fixed', source:'organization_pricebook', lock_on:['send'] },
    { id:'good_for_30_days', label:(globalThis.PlatformLanguage?.text("pricebook","m_5dcdcec280702c","Good for 30 days") ?? "Good for 30 days"), mode:'conditional', source:'organization_pricebook', lock_on:['signature'], expires_after:{ amount:30, unit:'days' } },
    { id:'cost_plus_until_signed', label:(globalThis.PlatformLanguage?.text("pricebook","m_579879f325793c","Cost plus until signed") ?? "Cost plus until signed"), mode:'live', source:'organization_pricebook', lock_on:['signature'] },
  ];

  const css = `
    .pb-overlay{position:fixed;inset:0;z-index:2147483400;background:rgba(7,10,17,.42);backdrop-filter:blur(6px);display:none;align-items:center;justify-content:center;opacity:0;transition:opacity .18s ease}
    .pb-overlay.active,.pb-overlay.closing,.pb-overlay.measuring{display:flex}
    .pb-overlay.active{opacity:1}
    .pb-overlay.closing,.pb-overlay.measuring{pointer-events:none}
    .pb-overlay.measuring{opacity:0}
    .pb-embed{width:100%;height:100%;min-height:0;display:flex;flex-direction:column}
    .pb-win{width:min(1720px,96vw);height:min(1180px,92vh);background:#eef0f4;border-radius:28px;box-shadow:0 36px 120px rgba(15,23,42,.28);overflow:hidden;display:flex;flex-direction:column;transform-origin:var(--pb-origin-x,50%) var(--pb-origin-y,50%)}
    .pb-overlay.active .pb-win{animation:pb-modal-expand .24s cubic-bezier(.2,.88,.25,1)}
    .pb-overlay.closing .pb-win{animation:pb-modal-collapse .18s cubic-bezier(.4,0,1,1) forwards}
    .pb-embed>.pb-win{width:100%;height:auto;min-height:640px;flex:1;border-radius:0;border:0;box-shadow:none}
    .pb-embed .pb-back{display:none}
    .pb-embed .pb-close{display:none}
    .pb-embed>.pb-win>.pb-top{display:none}
    .pb-top{display:flex;align-items:center;justify-content:space-between;gap:12px;padding:18px 20px;border-bottom:1px solid rgba(15,23,42,.08);background:rgba(255,255,255,.84)}
    .pb-back{display:inline-flex;align-items:center;gap:8px;padding:12px 16px;border-radius:16px;border:1px solid rgba(15,23,42,.12);background:#fff;color:#111827;font-size:13px;font-weight:1000;cursor:pointer}
    .pb-top-actions{width:94px;display:flex;align-items:center;justify-content:flex-end}
    .pb-close{width:40px;height:40px;border-radius:14px;border:1px solid rgba(15,23,42,.12);background:#fff;color:#344054;display:inline-flex;align-items:center;justify-content:center;cursor:pointer;font-size:16px;transition:background .16s ease,color .16s ease,transform .16s ease}
    .pb-close:hover{background:#f9fafb;color:#101828;transform:translateY(-1px)}
    .pb-title{display:flex;flex-direction:column;gap:4px}
    .pb-title strong{font-size:16px;color:#101828}
    .pb-title span{font-size:12px;font-weight:800;color:#667085}
    .pb-body{flex:1;min-height:0;display:grid;grid-template-columns:minmax(430px,34%) minmax(0,1fr)}
    .pb-side{background:#fff;border-right:1px solid rgba(15,23,42,.08);padding:16px 0 16px 16px;display:flex;flex-direction:column;gap:10px;min-height:0;overflow:hidden}
    .pb-side-tools{display:flex;flex-direction:column;gap:10px;padding-right:16px;flex-shrink:0}
    .pb-search{width:100%;padding:12px 14px;border-radius:14px;border:1px solid rgba(15,23,42,.12);font-size:13px;font-weight:900;outline:none}
    .pb-search:focus,.pb-field input:focus,.pb-field textarea:focus,.pb-field select:focus,.pb-token select:focus,.pb-token input:focus{border-color:rgba(var(--primary-rgb,217,48,37),.55);box-shadow:0 0 0 4px rgba(var(--primary-rgb,217,48,37),.12)}
    .pb-add{display:inline-flex;align-items:center;justify-content:center;gap:8px;padding:10px 12px;border-radius:14px;border:1px dashed rgba(15,23,42,.18);background:#fff;font-size:12px;font-weight:1000;color:#475467;cursor:pointer}
    .pb-list{flex:1;min-height:0;overflow:auto;display:flex;flex-direction:column;gap:14px;padding:2px 16px 2px 0}
    .pb-cat{display:flex;flex-direction:column;gap:6px}
    .pb-cat-head{width:100%;display:flex;align-items:center;justify-content:space-between;gap:10px;padding:0 0 6px;border:0;background:transparent;cursor:pointer;text-align:left;border-bottom:1px solid rgba(15,23,42,.08)}
    .pb-cat-head strong{font-size:12px;letter-spacing:.06em;text-transform:uppercase;color:#667085}
    .pb-cat-meta{display:flex;align-items:center;gap:8px;font-size:10px;font-weight:900;color:#667085}
    .pb-cat-star{color:#f59e0b;font-size:15px;font-weight:1000;line-height:1}
    .pb-cat-count{padding:2px 0}
    .pb-cat-angle{font-size:11px;color:#98a2b3;transition:.18s ease}
    .pb-cat:not(.open) .pb-cat-angle{transform:rotate(-90deg)}
    .pb-cat-body{display:flex;flex-direction:column;gap:8px}
    .pb-filter-row{display:flex;flex-wrap:wrap;gap:6px;padding:0}
    .pb-filter{display:inline-flex;align-items:center;justify-content:center;gap:6px;min-height:30px;padding:5px 10px;border-radius:10px;border:1px solid rgba(15,23,42,.08);background:#fff;color:#667085;font-size:10px;font-weight:1000;cursor:pointer;transition:.18s ease}
    .pb-filter.active{border-color:rgba(var(--primary-rgb,217,48,37),.32);background:rgba(var(--primary-rgb,217,48,37),.08);color:#111827}
    .pb-filter-logo{display:inline-flex;align-items:center;justify-content:center;min-width:22px;height:18px;padding:0 4px;border-radius:6px;background:#f2f4f7;color:#344054;font-size:9px;font-weight:1000;line-height:1}
    .pb-filter.is-meta .pb-filter-logo{min-width:auto;padding:0 6px;border-radius:999px;background:#fff3f2;color:var(--primary,#d93025)}
    .pb-tree{display:flex;flex-direction:column;gap:0}
    .pb-item{width:100%;padding:8px 0 8px 10px;border:0;border-left:2px solid transparent;background:transparent;cursor:pointer;display:grid;grid-template-columns:minmax(0,1fr) auto;gap:10px;align-items:center;transition:.16s ease;text-align:left}
    .pb-item:hover{background:rgba(15,23,42,.03)}
    .pb-item.active{border-left-color:var(--primary,#d93025);background:rgba(var(--primary-rgb,217,48,37),.06)}
    .pb-item.in-use{border-left-color:#f59e0b;background:rgba(245,158,11,.08)}
    .pb-item.active.in-use{box-shadow:inset 0 0 0 1px rgba(245,158,11,.2)}
    .pb-item-main{display:flex;flex-direction:column;gap:2px;min-width:0}
    .pb-item strong{font-size:12px;color:#101828;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
    .pb-item span{font-size:10px;font-weight:800;color:#667085;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
    .pb-item-price{font-size:10px;font-weight:1000;color:#101828;white-space:nowrap}
    .pb-item-empty{padding:8px 0 8px 10px;font-size:11px;font-weight:800;color:#98a2b3}
    .pb-cat-add{width:100%;display:flex;align-items:center;gap:8px;padding:9px 0 4px 10px;border:0;background:transparent;color:#667085;font-size:11px;font-weight:1000;cursor:pointer;text-align:left}
    .pb-cat-add i{color:var(--primary,#d93025)}
    .pb-main{padding:16px;overflow:hidden;min-height:0}
    .pb-card{background:#fff;border:1px solid rgba(15,23,42,.08);border-radius:20px;padding:16px;display:flex;flex-direction:column;gap:12px}
    .pb-card h3{margin:0;font-size:14px;color:#101828}
    .pb-card p{margin:0;font-size:12px;font-weight:800;color:#667085;line-height:1.5}
    .pb-fields{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:10px}
    .pb-field{display:flex;flex-direction:column;gap:5px}
    .pb-field.full{grid-column:1/-1}
    .pb-field label{font-size:11px;font-weight:1000;letter-spacing:.04em;text-transform:uppercase;color:#667085}
    .pb-field input,.pb-field textarea,.pb-field select{width:100%;padding:8px 10px;border-radius:11px;border:1px solid rgba(15,23,42,.12);background:#fff;font-size:12px;font-weight:900;outline:none}
    .pb-field textarea{min-height:58px;resize:vertical;line-height:1.4}
    .pb-toggle{display:inline-flex;align-items:center;gap:8px;font-size:12px;font-weight:900;color:#344054}
    .pb-inline-toggle{display:inline-flex;align-items:center;justify-content:space-between;gap:10px;padding:11px 12px;border-radius:14px;border:1px solid rgba(15,23,42,.12);background:#fff;font-size:12px;font-weight:900;color:#344054;min-height:46px}
    .pb-inline-toggle input{position:absolute;opacity:0;pointer-events:none}
    .pb-inline-toggle .pb-waste-pill{flex-shrink:0}
    .pb-foot{display:flex;justify-content:space-between;align-items:center;gap:12px}
    .pb-delete{padding:11px 14px;border-radius:14px;border:1px solid rgba(15,23,42,.12);background:#fff;color:#b42318;font-size:12px;font-weight:1000;cursor:pointer}
    .pb-delete[disabled]{opacity:.45;cursor:default}
    .pb-formula-builder{display:flex;flex-direction:column;gap:10px}
    .pb-formula-summary{display:flex;align-items:center;justify-content:space-between;gap:10px;padding:10px 12px;border-radius:14px;background:#f8fafc;border:1px solid rgba(15,23,42,.08)}
    .pb-formula-summary strong{font-size:11px;letter-spacing:.08em;text-transform:uppercase;color:#667085}
    .pb-formula-human{font-size:13px;font-weight:900;color:#101828;line-height:1.4;flex:1}
    .pb-waste-toggle{display:inline-flex;align-items:center;gap:8px;font-size:11px;font-weight:1000;color:#475467;white-space:nowrap}
    .pb-waste-toggle input{position:absolute;opacity:0;pointer-events:none}
    .pb-waste-pill{position:relative;width:38px;height:22px;border-radius:999px;background:rgba(15,23,42,.12);transition:.18s ease;display:inline-block}
    .pb-waste-pill::after{content:'';position:absolute;top:3px;left:3px;width:16px;height:16px;border-radius:999px;background:#fff;box-shadow:0 1px 3px rgba(15,23,42,.18);transition:.18s ease}
    .pb-inline-toggle input:checked + .pb-waste-pill{background:var(--primary,#d93025)}
    .pb-inline-toggle input:checked + .pb-waste-pill::after{transform:translateX(16px)}
    .pb-waste-toggle input:checked + .pb-waste-pill{background:var(--primary,#d93025)}
    .pb-waste-toggle input:checked + .pb-waste-pill::after{transform:translateX(16px)}
    .pb-formula-row{display:flex;flex-wrap:wrap;gap:6px;align-items:center;padding:10px;border-radius:16px;background:#f8fafc;border:1px solid rgba(15,23,42,.08);min-height:50px}
    .pb-token{display:inline-flex;align-items:center;gap:6px;padding:7px 9px;border-radius:14px;border:1px solid rgba(15,23,42,.1);background:#fff}
    .pb-token select,.pb-token input{border:0;outline:none;background:transparent;padding:0;font-size:12px;font-weight:900;color:#101828;min-width:0}
    .pb-token.measurement select{min-width:132px}
    .pb-token.operator select,.pb-token.paren select{min-width:52px;text-align:center}
    .pb-token.number input{width:62px}
    .pb-token-remove{width:22px;height:22px;border-radius:999px;border:1px solid rgba(15,23,42,.1);background:#fff;color:#98a2b3;display:flex;align-items:center;justify-content:center;cursor:pointer}
    .pb-formula-actions{display:flex;flex-wrap:wrap;gap:8px}
    .pb-formula-add{display:inline-flex;align-items:center;gap:6px;padding:8px 10px;border-radius:12px;border:1px dashed rgba(15,23,42,.16);background:#fff;color:#475467;font-size:11px;font-weight:1000;cursor:pointer}
    .pb-preview{display:flex;flex-direction:column;gap:10px}
    .pb-preview-row{display:flex;align-items:flex-start;justify-content:space-between;gap:12px;padding:12px 14px;border-radius:14px;background:#f8fafc;border:1px solid rgba(15,23,42,.08)}
    .pb-preview-row strong{font-size:13px;color:#101828}
    .pb-preview-row span{font-size:12px;font-weight:900;color:#475467;text-align:right}
    .pb-variation-options{display:flex;flex-direction:column;gap:8px}
    .pb-option-row{display:grid;grid-template-columns:minmax(92px,.8fr) minmax(100px,1fr) minmax(88px,.7fr) minmax(110px,1fr) minmax(0,1.4fr) 34px;gap:8px;align-items:center;padding:8px;border-radius:14px;background:#f8fafc;border:1px solid rgba(15,23,42,.08)}
    .pb-option-row input,.pb-option-row select{width:100%;padding:8px 9px;border-radius:10px;border:1px solid rgba(15,23,42,.12);background:#fff;font-size:12px;font-weight:900;outline:none}
    .pb-option-remove{width:30px;height:30px;border-radius:10px;border:1px solid rgba(15,23,42,.1);background:#fff;color:#b42318;display:flex;align-items:center;justify-content:center;cursor:pointer}
    .pb-editor-surface{height:100%;min-height:0;display:flex;flex-direction:column;overflow:hidden;background:#fff;border:1px solid rgba(15,23,42,.08);border-radius:20px}
    .pb-editor-surface,.pb-editor-surface *{box-sizing:border-box}
    .pb-editor-header{position:relative;z-index:8;flex:0 0 auto;min-height:50px;display:flex;align-items:stretch;justify-content:space-between;gap:12px;padding:0 14px;border-bottom:1px solid #eaecf0;background:#fff}
    .pb-editor-header-actions{display:flex;align-items:center}
    .pb-editor-scroll{flex:1;min-height:0;overflow:auto;padding:14px;display:flex;flex-direction:column;gap:14px;overscroll-behavior:contain}
    .pb-item-tabs{display:flex;align-items:stretch;gap:18px;background:transparent}
    .pb-item-tab{position:relative;border:0;border-bottom:2px solid transparent;background:transparent;color:#667085;padding:0 2px;font-size:12px;font-weight:1000;cursor:pointer}.pb-item-tab.active{border-bottom-color:var(--primary,#d93025);color:#101828}.pb-item-tab:hover{color:#101828}
    .pb-editor-scroll>.pb-summary-card,.pb-editor-scroll>.pb-variant-layout>.pb-dimensions-card{border:0;border-radius:0;padding:0}
    .pb-layer-card{display:grid;grid-template-columns:minmax(0,1fr) auto;gap:12px;align-items:center;padding:12px 14px;border-radius:16px;background:#f8fafc;border:1px solid rgba(15,23,42,.08)}.pb-layer-card strong{display:block;font-size:12px;color:#101828}.pb-layer-card span{display:block;margin-top:3px;font-size:11px;font-weight:800;color:#667085}.pb-layer-card select{padding:8px 10px;border-radius:10px;border:1px solid rgba(15,23,42,.12);background:#fff;font-size:11px;font-weight:900}
    .pb-price-compare{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:8px}.pb-price-stat{padding:10px 12px;border-radius:13px;background:#f8fafc;border:1px solid rgba(15,23,42,.08)}.pb-price-stat span{display:block;font-size:9px;font-weight:1000;letter-spacing:.06em;text-transform:uppercase;color:#98a2b3}.pb-price-stat strong{display:block;margin-top:4px;font-size:15px;color:#101828}
    .pb-summary-card{gap:18px}.pb-summary-section{display:flex;flex-direction:column;gap:12px;padding-top:18px;border-top:1px solid rgba(15,23,42,.08)}.pb-summary-section h3{font-size:12px;letter-spacing:.06em;text-transform:uppercase;color:#475467}.pb-select-with-add{display:grid;grid-template-columns:minmax(0,1fr) 38px;gap:7px}.pb-select-add{width:38px;border:1px solid rgba(15,23,42,.12);border-radius:12px;background:#fff;color:#475467;cursor:pointer;font-size:13px}.pb-select-add:hover{border-color:rgba(var(--primary-rgb,217,48,37),.35);color:var(--primary,#d93025)}
    .pb-global-details{border-top:1px solid rgba(15,23,42,.08);padding-top:4px}.pb-global-details summary{list-style:none;display:flex;align-items:center;justify-content:space-between;gap:12px;padding:11px 2px;cursor:pointer}.pb-global-details summary::-webkit-details-marker{display:none}.pb-global-details summary strong{display:block;font-size:11px;color:#475467}.pb-global-details summary small{display:block;margin-top:3px;color:#98a2b3;font-size:10px;font-weight:800}.pb-global-details summary i{color:#98a2b3;font-size:10px;transition:transform .16s ease}.pb-global-details[open] summary i{transform:rotate(180deg)}.pb-global-details-body{display:flex;flex-direction:column;gap:10px;padding:0 0 12px}.pb-summary-footer{display:flex;justify-content:flex-end;padding-top:2px}
    .pb-variant-layout,.pb-variant-detail{display:flex;flex-direction:column;gap:14px}.pb-variant-dimensions{display:grid;grid-template-columns:repeat(auto-fit,minmax(250px,1fr));gap:10px}.pb-dimension{border:1px solid rgba(15,23,42,.09);border-radius:16px;padding:12px;display:flex;flex-direction:column;gap:9px;background:#fff}.pb-dimension-head{display:grid;grid-template-columns:minmax(0,1fr) 104px auto;gap:7px;align-items:center}.pb-dimension-head input,.pb-dimension-head select{min-width:0;padding:8px;border:1px solid rgba(15,23,42,.12);border-radius:10px;font-size:11px;font-weight:900;background:#fff}.pb-dimension-values{display:flex;flex-direction:column;gap:6px}.pb-dimension-value{display:grid;grid-template-columns:26px minmax(0,1fr) minmax(68px,.8fr) 82px 76px 30px;gap:6px;align-items:center}.pb-dimension-value input,.pb-dimension-value select{min-width:0;width:100%;padding:7px;border:1px solid rgba(15,23,42,.12);border-radius:9px;font-size:10px;font-weight:850;background:#fff}.pb-dimension-value input[type=color]{height:30px;padding:2px}.pb-dimension-value.policy{grid-template-columns:minmax(0,1fr) 94px 100px 30px}.pb-dimension-value.no-color{grid-template-columns:minmax(0,1fr) minmax(68px,.8fr) 82px 76px 30px}.pb-mini-btn{border:1px solid rgba(15,23,42,.1);background:#fff;color:#475467;border-radius:9px;min-height:30px;padding:6px 8px;font-size:10px;font-weight:1000;cursor:pointer}.pb-mini-btn.danger{color:#b42318}
    .pb-matrix-tools{display:grid;grid-template-columns:repeat(2,minmax(130px,180px)) minmax(0,1fr);gap:8px;align-items:end}.pb-matrix-filters{display:flex;flex-wrap:wrap;gap:8px}.pb-matrix-filters .pb-field{min-width:130px}.pb-matrix-wrap{max-width:100%;overflow:auto;border:1px solid rgba(15,23,42,.1);border-radius:14px;background:#fff;max-height:370px}.pb-matrix{border-collapse:separate;border-spacing:0;min-width:100%;font-size:11px}.pb-matrix th,.pb-matrix td{padding:9px 10px;border-right:1px solid rgba(15,23,42,.07);border-bottom:1px solid rgba(15,23,42,.07);white-space:nowrap}.pb-matrix th{position:sticky;top:0;background:#f8fafc;z-index:2;text-align:left;color:#667085;font-size:10px}.pb-matrix th:first-child{left:0;z-index:3}.pb-matrix td:first-child{position:sticky;left:0;background:#fff;z-index:1;font-weight:1000}.pb-matrix-cell{width:100%;border:0;background:transparent;text-align:left;font-weight:1000;color:#101828;cursor:pointer;padding:0}.pb-matrix-cell small{display:block;color:#98a2b3;margin-top:2px}.pb-matrix-cell.active{color:var(--primary,#d93025)}
    .pb-combination-chips{display:flex;flex-wrap:wrap;gap:6px}.pb-combination-chip{padding:5px 8px;border-radius:999px;background:#eef2f6;color:#344054;font-size:10px;font-weight:1000}.pb-derived-note{padding:10px 12px;border-left:3px solid #f59e0b;background:#fffbeb;border-radius:10px;font-size:11px;font-weight:850;color:#7c2d12}.pb-bulk-bar{display:flex;flex-wrap:wrap;gap:8px;align-items:end;padding:10px;border-radius:13px;background:#f8fafc}.pb-bulk-bar input,.pb-bulk-bar select{padding:8px;border:1px solid rgba(15,23,42,.12);border-radius:9px;background:#fff;font-size:11px;font-weight:900}.pb-bulk-bar span{font-size:11px;font-weight:900;color:#667085;margin-right:auto}
    .pb-card-heading{display:flex;align-items:center;justify-content:space-between;gap:12px}.pb-card-heading h3{font-size:14px}.pb-card-heading span{display:block;margin-top:3px;color:#98a2b3;font-size:10px;font-weight:850}.pb-secondary-button,.pb-tertiary-button,.pb-primary-button{display:inline-flex;align-items:center;justify-content:center;gap:6px;min-height:34px;padding:8px 11px;border-radius:10px;font-size:10.5px;font-weight:950;cursor:pointer}.pb-secondary-button{border:1px solid #d8dde5;background:#fff;color:#344054}.pb-secondary-button:hover,.pb-secondary-button.active{border-color:rgba(var(--primary-rgb,217,48,37),.35);background:rgba(var(--primary-rgb,217,48,37),.06);color:var(--primary,#d93025)}.pb-tertiary-button{border:0;background:transparent;color:#667085}.pb-primary-button{border:1px solid var(--primary,#d93025);background:var(--primary,#d93025);color:#fff}.pb-icon-button{width:34px;height:34px;display:grid;place-items:center;border:1px solid #e4e7ec;border-radius:10px;background:#fff;color:#667085;cursor:pointer}.pb-icon-button.danger{color:#b42318}.pb-icon-button:disabled,.pb-text-danger:disabled{opacity:.35;cursor:default}
    .pb-dimensions-card{gap:12px}.pb-dimension-tabs{display:flex;gap:8px;overflow-x:auto;padding-bottom:2px}.pb-dimension-tab{min-width:150px;display:flex;align-items:center;gap:9px;padding:9px 11px;border:1px solid #e4e7ec;border-radius:12px;background:#fff;color:#475467;text-align:left;cursor:pointer}.pb-dimension-tab.active{border-color:rgba(var(--primary-rgb,217,48,37),.32);background:rgba(var(--primary-rgb,217,48,37),.055);color:#101828}.pb-dimension-tab-icon{width:30px;height:30px;display:grid;place-items:center;flex:0 0 auto;border-radius:9px;background:#f2f4f7;color:#667085}.pb-dimension-tab.active .pb-dimension-tab-icon{background:#fff;color:var(--primary,#d93025)}.pb-dimension-tab strong{display:block;font-size:11px}.pb-dimension-tab small{display:block;margin-top:2px;color:#98a2b3;font-size:9.5px;font-weight:800}
    .pb-dimension.pb-dimension-active{padding:14px 0 0;border:0;border-top:1px solid #eaecf0;border-radius:0;background:transparent}.pb-dimension-active .pb-dimension-head{display:grid;grid-template-columns:minmax(130px,1fr) 120px auto 34px;gap:8px}.pb-sku-state{display:inline-flex;align-items:center;justify-content:center;gap:6px;min-height:34px;padding:7px 10px;border:1px solid #e4e7ec;border-radius:10px;background:#fff;color:#667085;font-size:9.5px;font-weight:950;white-space:nowrap}.pb-sku-state.active{border-color:#c7d7fe;background:#eef4ff;color:#3538cd}.pb-sku-state.locked{border:0;background:#f2f4f7}.pb-value-list{display:flex;flex-direction:column;gap:6px}.pb-value-row{border:1px solid #e4e7ec;border-radius:12px;background:#fff;overflow:hidden}.pb-value-row>summary{list-style:none;display:grid;grid-template-columns:minmax(0,1fr) auto 14px;gap:10px;align-items:center;min-height:42px;padding:7px 11px;cursor:pointer}.pb-value-row>summary::-webkit-details-marker{display:none}.pb-value-leading{display:flex;align-items:center;gap:9px;min-width:0}.pb-value-leading strong{font-size:11px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.pb-value-swatch{width:24px;height:24px;flex:0 0 auto;border:1px solid rgba(15,23,42,.12);border-radius:8px;background:var(--swatch)}.pb-value-icon{width:24px;height:24px;display:grid;place-items:center;flex:0 0 auto;border-radius:8px;background:#f2f4f7;color:#667085;font-size:9px}.pb-value-summary{color:#667085;font-size:10px;font-weight:900;white-space:nowrap}.pb-value-chevron{color:#98a2b3;font-size:9px;transition:transform .15s ease}.pb-value-row[open] .pb-value-chevron{transform:rotate(180deg)}.pb-value-row[open]>summary{background:#f9fafb;border-bottom:1px solid #eaecf0}.pb-value-editor{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:10px;padding:12px}.pb-value-editor .pb-text-danger{grid-column:1/-1;justify-self:start}.pb-value-editor input[type=color]{height:40px;padding:3px}.pb-input-suffix{display:grid;grid-template-columns:minmax(0,1fr) auto;align-items:center;border:1px solid rgba(15,23,42,.12);border-radius:14px;background:#fff;overflow:hidden}.pb-input-suffix input{border:0!important;border-radius:0!important;box-shadow:none!important}.pb-input-suffix span{padding:0 11px;color:#98a2b3;font-size:10px;font-weight:900}.pb-text-danger{display:inline-flex;align-items:center;gap:6px;padding:6px 0;border:0;background:transparent;color:#b42318;font-size:10px;font-weight:950;cursor:pointer}.pb-dimension-actions{display:flex;align-items:center;justify-content:space-between;gap:8px}
    .pb-combination-picker{display:grid;grid-template-columns:repeat(auto-fit,minmax(135px,1fr));gap:8px}.pb-price-summary{display:grid;grid-template-columns:minmax(100px,.7fr) minmax(100px,.7fr) minmax(160px,1.4fr);gap:8px}.pb-price-summary>div{min-width:0;padding:11px 12px;border-radius:12px;background:#f8fafc;border:1px solid #eaecf0}.pb-price-summary span{display:block;color:#98a2b3;font-size:9px;font-weight:1000;letter-spacing:.05em;text-transform:uppercase}.pb-price-summary strong{display:block;margin-top:4px;color:#101828;font-size:16px}.pb-price-summary small{display:block;margin-top:2px;color:#98a2b3;font-size:9px;font-weight:800}.pb-price-summary .pb-sku-summary strong{font-size:10px;line-height:1.35;overflow-wrap:anywhere}.pb-status-pill{margin:0!important;padding:5px 8px;border-radius:999px;background:#f2f4f7;color:#667085!important;font-size:9px!important;font-weight:950!important}.pb-status-pill.override{background:#fffaeb;color:#b54708!important}.pb-override-details{border-top:1px solid #eaecf0}.pb-override-details>summary{list-style:none;display:flex;align-items:center;justify-content:space-between;padding:12px 2px 0;color:#475467;font-size:10.5px;font-weight:950;cursor:pointer}.pb-override-details>summary::-webkit-details-marker{display:none}.pb-override-details>summary span{display:flex;align-items:center;gap:7px}.pb-override-details>summary>i{color:#98a2b3;font-size:9px;transition:transform .15s}.pb-override-details[open]>summary>i{transform:rotate(180deg)}.pb-override-body{display:flex;flex-direction:column;gap:10px;padding-top:12px}
    .pb-matrix-panel{padding:0;overflow:hidden}.pb-matrix-panel>summary{list-style:none;display:flex;align-items:center;justify-content:space-between;gap:12px;padding:14px 16px;cursor:pointer}.pb-matrix-panel>summary::-webkit-details-marker{display:none}.pb-matrix-panel>summary strong{display:block;font-size:12px}.pb-matrix-panel>summary small{display:block;margin-top:3px;color:#98a2b3;font-size:9.5px;font-weight:800}.pb-matrix-panel>summary>i{color:#98a2b3;font-size:9px;transition:transform .15s}.pb-matrix-panel[open]>summary>i{transform:rotate(180deg)}.pb-matrix-panel-body{display:flex;flex-direction:column;gap:10px;padding:0 14px 14px;border-top:1px solid #eaecf0}.pb-matrix-header{display:flex;align-items:end;justify-content:space-between;gap:10px;padding-top:12px}.pb-matrix-tools{flex:1}.pb-matrix-cell{display:flex;flex-direction:column;align-items:flex-start;gap:2px;padding:3px!important;border-radius:7px}.pb-matrix-cell strong{font-size:11px}.pb-matrix-cell>i{color:#d0d5dd}.pb-matrix-cell.selected{background:#eef4ff;color:#3538cd}.pb-matrix-cell.selected>i{color:#3538cd}
    @keyframes pb-modal-expand{0%{opacity:.35;transform:scale(.38) translateY(-8px)}64%{opacity:1;transform:scale(1.012)}100%{opacity:1;transform:scale(1)}}
    @keyframes pb-modal-collapse{0%{opacity:1;transform:scale(1)}100%{opacity:.05;transform:scale(.34) translateY(-8px)}}
    .pb-value-list{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:6px}.pb-value-row{min-width:0}.pb-value-row[open]{grid-column:1/-1}.pb-value-row>summary{grid-template-columns:minmax(0,1fr) 12px;gap:7px;padding:6px 8px}.pb-value-leading{gap:7px}.pb-value-copy{display:flex;min-width:0;flex-direction:column;gap:1px}.pb-value-leading strong{font-size:10.5px}.pb-value-summary{font-size:8.5px;font-weight:850;overflow:hidden;text-overflow:ellipsis}.pb-value-summary:empty{display:none}.pb-value-editor{grid-template-columns:minmax(0,1.45fr) 42px 52px 32px;grid-template-rows:auto auto;gap:7px;padding:9px}.pb-value-editor .pb-field{min-width:0}.pb-value-editor .pb-value-name{grid-column:1;grid-row:1}.pb-value-editor .pb-value-color{grid-column:2;grid-row:1}.pb-value-editor .pb-value-image{grid-column:3;grid-row:1}.pb-value-editor .pb-value-remove{grid-column:4;grid-row:1;align-self:end;width:32px;height:32px;padding:0;display:grid;place-items:center;border:1px solid #e4e7ec;border-radius:9px;background:#fff}.pb-value-editor .pb-value-operation{grid-column:1/3;grid-row:2}.pb-value-editor .pb-value-amount{grid-column:3/5;grid-row:2}.pb-value-editor.pb-policy-editor{grid-template-columns:minmax(0,1.3fr) minmax(0,1fr) minmax(0,.8fr) 32px;grid-template-rows:auto}.pb-value-editor.pb-policy-editor .pb-value-name,.pb-value-editor.pb-policy-editor .pb-value-operation,.pb-value-editor.pb-policy-editor .pb-value-amount,.pb-value-editor.pb-policy-editor .pb-value-remove{grid-column:auto;grid-row:auto}.pb-color-picker{position:relative;display:block;width:42px;height:32px;border-radius:9px;background:var(--swatch);box-shadow:inset 0 0 0 1px rgba(15,23,42,.14);overflow:hidden;cursor:pointer}.pb-color-picker input{position:absolute!important;inset:0;width:100%!important;height:100%!important;padding:0!important;opacity:0;cursor:pointer}.pb-image-control{position:relative;display:flex;width:max-content;align-items:center}.pb-image-picker{position:relative;width:52px;height:32px;flex:0 0 auto;padding:0;border:1px dashed #cfd4dc;border-radius:9px;background:#f8fafc;color:#98a2b3;overflow:hidden;cursor:pointer}.pb-image-picker:hover{border-color:rgba(var(--primary-rgb,217,48,37),.4);color:var(--primary,#d93025)}.pb-image-picker input{position:absolute;inset:0;z-index:2;opacity:0;cursor:pointer}.pb-image-picker i{font-size:11px}.pb-image-picker img{position:absolute;max-width:none}.pb-image-crop-button{position:absolute;right:2px;top:2px;z-index:3;width:20px;height:20px;display:grid;place-items:center;padding:0;border:1px solid rgba(255,255,255,.75);border-radius:6px;background:rgba(255,255,255,.9);color:#475467;font-size:9px;cursor:pointer;box-shadow:0 1px 3px rgba(15,23,42,.15)}.pb-override-image .pb-image-picker{width:72px;height:48px}.pb-crop-overlay{position:fixed;inset:0;z-index:10080;display:grid;place-items:center;padding:24px;background:rgba(15,23,42,.64);backdrop-filter:blur(4px)}.pb-crop-dialog{width:min(720px,calc(100vw - 32px));border-radius:20px;background:#fff;box-shadow:0 28px 80px rgba(15,23,42,.3);overflow:hidden}.pb-crop-head,.pb-crop-foot{display:flex;align-items:center;justify-content:space-between;gap:12px;padding:14px 16px}.pb-crop-head{border-bottom:1px solid #eaecf0}.pb-crop-head strong{font-size:14px}.pb-crop-head span{display:block;margin-top:2px;font-size:10px;font-weight:800;color:#98a2b3}.pb-crop-stage{position:relative;height:430px;background:#1f2937;overflow:hidden;touch-action:none;user-select:none}.pb-crop-frame{position:absolute;left:50%;top:50%;width:min(68%,420px);aspect-ratio:4/3;transform:translate(-50%,-50%);overflow:hidden;box-shadow:0 0 0 9999px rgba(2,6,23,.56),0 0 0 2px #fff;z-index:2;pointer-events:none}.pb-crop-ghost,.pb-crop-solid{position:absolute;max-width:none;pointer-events:none;object-fit:fill}.pb-crop-ghost{opacity:.36;z-index:1}.pb-crop-solid{opacity:1}.pb-crop-image-box{position:absolute;z-index:3;border:1px dashed rgba(255,255,255,.75);cursor:grab;touch-action:none}.pb-crop-image-box:active{cursor:grabbing}.pb-crop-handle{position:absolute;width:14px;height:14px;border:2px solid #fff;border-radius:4px;background:var(--primary,#d93025);box-shadow:0 2px 5px rgba(15,23,42,.35)}.pb-crop-handle.nw{left:-7px;top:-7px;cursor:nwse-resize}.pb-crop-handle.ne{right:-7px;top:-7px;cursor:nesw-resize}.pb-crop-handle.se{right:-7px;bottom:-7px;cursor:nwse-resize}.pb-crop-handle.sw{left:-7px;bottom:-7px;cursor:nesw-resize}.pb-crop-foot{border-top:1px solid #eaecf0;justify-content:flex-end}.pb-crop-foot button{min-width:82px}
    .pb-value-color>label:first-child,.pb-value-image>label:first-child{position:absolute;width:1px;height:1px;padding:0;margin:-1px;overflow:hidden;clip:rect(0,0,0,0);white-space:nowrap;border:0}.pb-value-color,.pb-value-image{justify-content:flex-end}
    @media (max-width: 960px){
      .pb-win{width:100vw;height:100vh;border-radius:0}
      .pb-embed>.pb-win{width:100%;height:auto;min-height:760px;border-radius:0}
      .pb-body{grid-template-columns:1fr}
      .pb-side{border-right:0;border-bottom:1px solid rgba(15,23,42,.08);max-height:38vh}
      .pb-fields{grid-template-columns:1fr}
      .pb-option-row{grid-template-columns:1fr}
      .pb-value-list{grid-template-columns:repeat(2,minmax(0,1fr))}.pb-value-row[open]{grid-column:1/-1}
      .pb-dimension-active .pb-dimension-head{grid-template-columns:minmax(0,1fr) 110px}.pb-dimension-active .pb-sku-state,.pb-dimension-active .pb-icon-button{grid-row:2}.pb-price-summary{grid-template-columns:1fr}.pb-matrix-header{align-items:stretch;flex-direction:column}.pb-matrix-tools{width:100%}
    }
  `;

  function clone(value){
    if (value === undefined) return undefined;
    return JSON.parse(JSON.stringify(value));
  }

  function configure(options = {}){
    let shouldReload = false;
    if (options.storageKey && config.storageKey !== String(options.storageKey)) {
      config.storageKey = String(options.storageKey);
      shouldReload = true;
    }
    if (options.defaultPricebookPath && config.defaultPricebookPath !== String(options.defaultPricebookPath)) {
      config.defaultPricebookPath = String(options.defaultPricebookPath);
      shouldReload = true;
    }
    if (options.moduleId && config.moduleId !== String(options.moduleId)) {
      config.moduleId = String(options.moduleId);
      shouldReload = true;
    }
    if (typeof options.currentBranchId === 'function') config.currentBranchId = options.currentBranchId;
    if (typeof options.currentOrganizationId === 'function') config.currentOrganizationId = options.currentOrganizationId;
    if (typeof options.getModule === 'function') config.getModule = options.getModule;
    if (typeof options.saveModule === 'function') config.saveModule = options.saveModule;
    if (typeof options.getOrganizationPricebook === 'function') config.getOrganizationPricebook = options.getOrganizationPricebook;
    if (typeof options.saveOrganizationPricebook === 'function') config.saveOrganizationPricebook = options.saveOrganizationPricebook;
    if (shouldReload) loadPromise = null;
    return api;
  }

  function currentBranchId(){
    if (typeof config.currentBranchId === 'function') return String(config.currentBranchId() || 'default').trim() || 'default';
    return String(root.Portal?.branchModules?.currentBranchId?.() || root.__APP?.userBranchId || 'default').trim() || 'default';
  }

  function currentOrganizationId(){
    if (typeof config.currentOrganizationId === 'function') return cleanText(config.currentOrganizationId());
    return cleanText(root.__APP?.orgId || root.__APP?.organizationId || root.__APP?.organization_id || root.Portal?.state?.organizationId);
  }

  function uid(prefix){
    return `${prefix}_${Math.random().toString(36).slice(2, 9)}`;
  }

  function cleanText(value){
    return String(value ?? '').trim();
  }

  function objectValue(value){
    return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  }

  function normalizeImageCrop(value){
    const raw = objectValue(value);
    const x = Number(raw.x);
    const y = Number(raw.y);
    const w = Number(raw.w);
    const h = Number(raw.h);
    if (![x,y,w,h].every(Number.isFinite) || w <= 0 || h <= 0) return null;
    return { x, y, w, h };
  }

  function slug(value, fallback = 'item'){
    const text = cleanText(value).toLowerCase()
      .replace(/&/g, ' and ')
      .replace(/[^a-z0-9]+/g, '_')
      .replace(/^_+|_+$/g, '');
    return text || fallback;
  }

  function titleFromKey(value){
    return cleanText(value).replace(/_/g, ' ').replace(/\b\w/g, (char) => char.toUpperCase());
  }

  const OPTION_PRESETS = {
    shingle_color: {
      id: 'color',
      label: (globalThis.PlatformLanguage?.text("pricebook","m_db7002926d9977","Color") ?? "Color"),
      type: 'select',
      defaultValue: 'weathered_wood',
      values: [
        { value: 'weathered_wood', label: (globalThis.PlatformLanguage?.text("pricebook","m_eb63978deca3de","Weathered Wood") ?? "Weathered Wood") },
        { value: 'charcoal', label: (globalThis.PlatformLanguage?.text("pricebook","m_81a362b3060e14","Charcoal") ?? "Charcoal") },
        { value: 'barkwood', label: (globalThis.PlatformLanguage?.text("pricebook","m_799570661bf01a","Barkwood") ?? "Barkwood") },
        { value: 'shakewood', label: (globalThis.PlatformLanguage?.text("pricebook","m_391ae11219548f","Shakewood") ?? "Shakewood") },
        { value: 'driftwood', label: (globalThis.PlatformLanguage?.text("pricebook","m_54125272ba36af","Driftwood") ?? "Driftwood") }
      ]
    },
    metal_color: {
      id: 'color',
      label: (globalThis.PlatformLanguage?.text("pricebook","m_db7002926d9977","Color") ?? "Color"),
      type: 'select',
      defaultValue: 'black',
      values: [
        { value: 'black', label: (globalThis.PlatformLanguage?.text("pricebook","m_27b397de77a09d","Black") ?? "Black") },
        { value: 'brown', label: (globalThis.PlatformLanguage?.text("pricebook","m_e0c6fc2bca115e","Brown") ?? "Brown") }
      ]
    },
    membrane_color: {
      id: 'color',
      label: (globalThis.PlatformLanguage?.text("pricebook","m_db7002926d9977","Color") ?? "Color"),
      type: 'select',
      defaultValue: 'white',
      values: [
        { value: 'white', label: (globalThis.PlatformLanguage?.text("pricebook","m_2d9b75af657cfa","White") ?? "White") },
        { value: 'tan', label: (globalThis.PlatformLanguage?.text("pricebook","m_24c61700939783","Tan") ?? "Tan") },
        { value: 'gray', label: (globalThis.PlatformLanguage?.text("pricebook","m_637bac28a091f4","Gray") ?? "Gray") }
      ]
    }
  };

  const VARIATION_OVERRIDES = {
    laminated_shingles: { itemTypeId: 'field_shingles', itemTypeName: 'Shingles', variantId: 'generic_architectural', variantName: 'Architectural', variantGroupId: 'unbranded', variantGroupName: 'Unbranded', variantRole: 'generic', isDefaultVariant: true, optionPreset: 'shingle_color' },
    gaf_hd: { itemTypeId: 'field_shingles', itemTypeName: 'Shingles', variantId: 'gaf_timberline_hdz', variantName: 'Timberline HDZ', variantGroupId: 'gaf', variantGroupName: 'GAF', variantRole: 'branded', isDefaultVariant: false, optionPreset: 'shingle_color' },
    owens_duration: { itemTypeId: 'field_shingles', itemTypeName: 'Shingles', variantId: 'owens_corning_duration', variantName: 'Duration', variantGroupId: 'owens_corning', variantGroupName: 'Owens Corning', variantRole: 'branded', isDefaultVariant: false, optionPreset: 'shingle_color' },
    malarkey_vista: { itemTypeId: 'field_shingles', itemTypeName: 'Shingles', variantId: 'malarkey_vista', variantName: 'Vista', variantGroupId: 'malarkey', variantGroupName: 'Malarkey', variantRole: 'branded', isDefaultVariant: false, optionPreset: 'shingle_color' },
    starter: { itemTypeId: 'starter', itemTypeName: 'Starter Strip', variantId: 'generic', variantName: 'Starter Strip', variantGroupId: 'unbranded', variantGroupName: 'Unbranded', variantRole: 'generic', isDefaultVariant: true },
    ridge_cap: { itemTypeId: 'ridge_cap', itemTypeName: 'Ridge Cap', variantId: 'generic', variantName: 'Ridge Cap', variantGroupId: 'unbranded', variantGroupName: 'Unbranded', variantRole: 'generic', isDefaultVariant: true, optionPreset: 'shingle_color' },
    ice_water: { itemTypeId: 'leak_barrier', itemTypeName: 'Leak Barrier', variantId: 'generic', variantName: 'Ice & Water Shield', variantGroupId: 'unbranded', variantGroupName: 'Unbranded', variantRole: 'generic', isDefaultVariant: true },
    gaf_weatherwatch: { itemTypeId: 'leak_barrier', itemTypeName: 'Leak Barrier', variantId: 'gaf_weatherwatch', variantName: 'WeatherWatch', variantGroupId: 'gaf', variantGroupName: 'GAF', variantRole: 'branded', isDefaultVariant: false },
    owens_weatherlock: { itemTypeId: 'leak_barrier', itemTypeName: 'Leak Barrier', variantId: 'owens_corning_weatherlock', variantName: 'WeatherLock', variantGroupId: 'owens_corning', variantGroupName: 'Owens Corning', variantRole: 'branded', isDefaultVariant: false },
    underlayment: { itemTypeId: 'underlayment', itemTypeName: 'Underlayment', variantId: 'generic', variantName: 'Underlayment', variantGroupId: 'unbranded', variantGroupName: 'Unbranded', variantRole: 'generic', isDefaultVariant: true },
    gaf_shinglemate: { itemTypeId: 'underlayment', itemTypeName: 'Underlayment', variantId: 'gaf_shinglemate', variantName: 'ShingleMate', variantGroupId: 'gaf', variantGroupName: 'GAF', variantRole: 'branded', isDefaultVariant: false },
    gaf_feltbuster: { itemTypeId: 'underlayment', itemTypeName: 'Underlayment', variantId: 'gaf_feltbuster', variantName: 'FeltBuster', variantGroupId: 'gaf', variantGroupName: 'GAF', variantRole: 'branded', isDefaultVariant: false },
    gaf_tiger_paw: { itemTypeId: 'underlayment', itemTypeName: 'Underlayment', variantId: 'gaf_tiger_paw', variantName: 'Tiger Paw', variantGroupId: 'gaf', variantGroupName: 'GAF', variantRole: 'branded', isDefaultVariant: false },
    valley_metal: { itemTypeId: 'valley_metal', itemTypeName: 'Valley Metal', variantId: 'generic', variantName: 'Valley Metal', variantGroupId: 'unbranded', variantGroupName: 'Unbranded', variantRole: 'generic', isDefaultVariant: true, optionPreset: 'metal_color' },
    drip_edge: { itemTypeId: 'drip_edge', itemTypeName: 'Drip Edge', variantId: 'generic', variantName: 'Drip Edge', variantGroupId: 'unbranded', variantGroupName: 'Unbranded', variantRole: 'generic', isDefaultVariant: true, optionPreset: 'metal_color' },
    tpo_membrane: { itemTypeId: 'flat_roof_membrane', itemTypeName: 'Flat Roof Membrane', variantId: 'tpo_membrane', variantName: 'TPO Membrane', variantGroupId: 'single_ply', variantGroupName: 'Single Ply', variantRole: 'standard', isDefaultVariant: true, optionPreset: 'membrane_color' },
    torch_down: { itemTypeId: 'flat_roof_membrane', itemTypeName: 'Flat Roof Membrane', variantId: 'torch_down', variantName: 'Torch Down Roofing', variantGroupId: 'modified_bitumen', variantGroupName: 'Modified Bitumen', variantRole: 'standard', isDefaultVariant: false }
  };

  function customFormulaFields(){
    return root.FirstMateCustomFields?.formulaFields?.() || [];
  }

  function getMeasurementLabel(key){
    return [...MEASUREMENT_FIELDS, ...customFormulaFields()].find((field) => field.key === key)?.label || key;
  }

  function getCategoryLabel(key){
    return CATEGORY_OPTIONS.find((option) => option.value === key)?.label || key;
  }

  function getBrandLabel(key){
    return BRAND_OPTIONS.find((option) => option.value === key)?.label || key;
  }

  function getFlashingLabel(key){
    return FLASHING_OPTIONS.find((option) => option.value === key)?.label || key;
  }

  function defaultFormulaConfig(){
    return { tokens: [{ type:'measurement', value:'roofSquares' }], includeWaste: false };
  }

  function createItemForCategory(category = 'shingle_roofs'){
    return normalizeItem({
      id: uid('pb'),
      name: 'New Pricebook Item',
      category,
      type: getCategoryLabel(category),
      manufacturer: '',
      segment: category === 'flashing' ? 'sloped' : 'all',
      unit: 'ea',
      unitPrice: 0,
      internalCost: 0,
      formulaConfig: defaultFormulaConfig(),
      autoAdd: false,
      description: '',
      internalDescription: '',
      externalDescription: '',
      global_link_mode: 'local',
    }, 0);
  }

  function resolveExpandedCategories(options = {}){
    const next = { ...expandedCategories };
    const initial = options.initialExpandedCategories || {};
    Object.keys(initial).forEach((key) => {
      next[key] = !!initial[key];
    });
    return next;
  }

  function activeUsedItemIds(){
    return new Set(activeOptions?.usedItemIds || []);
  }

  function activeUsedCategories(){
    return new Set(activeOptions?.usedCategories || []);
  }

  function activeUsedSubfilters(){
    const usedIds = activeUsedItemIds();
    const brands = new Set();
    const flashing = new Set();
    state.items.forEach((item) => {
      if (!usedIds.has(item.id)) return;
      if ((item.category === 'shingle_roofs' || item.category === 'leak_barriers') && item.manufacturer) {
        brands.add(item.manufacturer);
      }
      if (item.category === 'flashing' && item.segment) {
        flashing.add(item.segment);
      }
    });
    return { brands, flashing };
  }

  function normalizeTokens(tokens){
    const source = Array.isArray(tokens) ? tokens : [];
    const normalized = source.map((token) => ({
      type: token?.type === 'measurement' && String(token?.value || '').startsWith('custom_')
        ? 'custom_field'
        : (['measurement', 'custom_field', 'number', 'operator', 'paren'].includes(token?.type) ? token.type : 'number'),
      value: String(token?.value ?? ''),
    })).filter((token) => {
      if (token.type === 'measurement') return MEASUREMENT_FIELDS.some((field) => field.key === token.value);
      if (token.type === 'custom_field') return /^custom_[a-z0-9_]+$/.test(token.value);
      if (token.type === 'operator') return OPERATOR_OPTIONS.includes(token.value);
      if (token.type === 'paren') return PAREN_OPTIONS.includes(token.value);
      return true;
    });
    return normalized.length ? normalized : defaultFormulaConfig().tokens;
  }

  function inferFormulaConfig(item){
    if (item?.formulaConfig) {
      return {
        tokens: normalizeTokens(item.formulaConfig.tokens),
        includeWaste: !!item.formulaConfig.includeWaste,
      };
    }
    const legacy = String(item?.formula || '').trim();
    const measurement = MEASUREMENT_FIELDS.find((field) => legacy.includes(field.key));
    return {
      tokens: measurement ? [{ type:'measurement', value:measurement.key }] : defaultFormulaConfig().tokens,
      includeWaste: /waste/i.test(legacy) || /1\.0\d/.test(legacy),
    };
  }

  function normalizeOrderPackaging(value){
    const raw = objectValue(value);
    const orderUnit = cleanText(raw.order_unit || raw.orderUnit);
    const unitsPerPackage = Number(raw.units_per_package ?? raw.unitsPerPackage ?? 0);
    const packagesPerUnit = Number(raw.packages_per_unit ?? raw.packagesPerUnit ?? 0);
    if (!orderUnit && !(unitsPerPackage > 0) && !(packagesPerUnit > 0)) return null;
    return {
      order_unit: orderUnit,
      order_unit_plural: cleanText(raw.order_unit_plural || raw.orderUnitPlural) || `${orderUnit}s`,
      units_per_package: unitsPerPackage > 0 ? unitsPerPackage : 0,
      packages_per_unit: packagesPerUnit > 0 ? packagesPerUnit : 0,
      description: cleanText(raw.description),
    };
  }

  function orderUnitLabel(packaging, count){
    if (!packaging) return '';
    return Number(count) === 1 ? packaging.order_unit : (packaging.order_unit_plural || `${packaging.order_unit}s`);
  }

  function computeOrderQuantity(packaging, quantity){
    const normalized = normalizeOrderPackaging(packaging);
    const measured = Math.max(0, Number(quantity) || 0);
    if (!normalized || !normalized.order_unit) return null;
    if (!(normalized.units_per_package > 0) && !(normalized.packages_per_unit > 0)) return null;
    // packages_per_unit wins so exact integer ratios (3 bundles per square) never
    // pick up float error from a stored reciprocal.
    const factor = normalized.packages_per_unit > 0 ? normalized.packages_per_unit : 1 / normalized.units_per_package;
    const orderQuantity = measured > 0 ? Math.ceil((measured * factor) - 1e-6) : 0;
    const coveredQuantity = normalized.packages_per_unit > 0
      ? orderQuantity / normalized.packages_per_unit
      : orderQuantity * normalized.units_per_package;
    return {
      order_quantity: orderQuantity,
      order_unit: orderUnitLabel(normalized, orderQuantity),
      covered_quantity: Math.round(coveredQuantity * 100) / 100,
      packaging: normalized,
    };
  }

  function orderInfoForItem(itemOrId, quantity){
    const item = typeof itemOrId === 'string' ? getItem(itemOrId) : itemOrId;
    if (!item) return null;
    return computeOrderQuantity(item.orderPackaging || item.order_packaging, quantity);
  }

  function normalizeOptionValue(value){
    if (value && typeof value === 'object') {
      const optionValue = slug(value.value || value.id || value.label, 'option');
      return {
        value: optionValue,
        label: cleanText(value.label || value.name || titleFromKey(optionValue)),
        metadata: objectValue(value.metadata)
      };
    }
    const optionValue = slug(value, 'option');
    return { value: optionValue, label: titleFromKey(optionValue), metadata: {} };
  }

  function normalizeOptionDefinitions(value){
    const source = Array.isArray(value) ? value : [];
    return source.map((entry, index) => {
      const raw = objectValue(entry);
      const id = slug(raw.id || raw.key || raw.name || `option_${index + 1}`, `option_${index + 1}`);
      const values = Array.isArray(raw.values) ? raw.values.map(normalizeOptionValue) : [];
      const defaultValue = cleanText(raw.defaultValue || raw.default_value || raw.default || values[0]?.value || '');
      return {
        id,
        label: cleanText(raw.label || raw.name || titleFromKey(id)),
        type: ['select', 'text', 'number', 'boolean'].includes(raw.type) ? raw.type : (values.length ? 'select' : 'text'),
        defaultValue,
        values,
        required: raw.required !== false,
        metadata: objectValue(raw.metadata)
      };
    });
  }

  function defaultOptionsFor(definitions){
    return normalizeOptionDefinitions(definitions).reduce((options, definition) => {
      if (definition.defaultValue !== '') options[definition.id] = definition.defaultValue;
      return options;
    }, {});
  }

  function normalizeOptionSelections(value, definitions = []){
    const raw = objectValue(value);
    const defaults = defaultOptionsFor(definitions);
    return { ...defaults, ...Object.fromEntries(Object.entries(raw).map(([key, optionValue]) => [slug(key, 'option'), cleanText(optionValue)])) };
  }

  function normalizePriceUpdateRule(value){
    const raw = objectValue(value);
    const mode = ['fixed', 'live', 'conditional'].includes(raw.mode) ? raw.mode : 'fixed';
    return {
      ...raw,
      id: cleanText(raw.id) || (mode === 'fixed' ? 'fixed_forever' : mode),
      label: cleanText(raw.label) || (mode === 'fixed' ? 'Fixed forever' : mode === 'live' ? 'Live price' : 'Conditional price'),
      mode,
      source: cleanText(raw.source) || 'organization_pricebook',
      lock_on: Array.isArray(raw.lock_on) ? raw.lock_on.map(String) : [],
      expires_after: raw.expires_after && typeof raw.expires_after === 'object' ? clone(raw.expires_after) : undefined,
      formula: raw.formula == null ? '' : String(raw.formula),
    };
  }

  function defaultPricingPolicies(){
    const configured = state?.settings?.default_pricing_policies;
    return (Array.isArray(configured) && configured.length ? configured : DEFAULT_PRICING_POLICIES).map(normalizePriceUpdateRule);
  }

  function colorForValue(value, index){
    const known = { charcoal:'#374151', weathered_wood:'#7c6f64', barkwood:'#725548', shakewood:'#9a7151', driftwood:'#8b8177', white:'#f8fafc', tan:'#d2b48c', gray:'#94a3b8', black:'#111827', brown:'#6b4423', red:'#b42318' };
    return known[slug(value, '')] || ['#64748b','#0f766e','#7c3aed','#c2410c','#0369a1'][index % 5];
  }

  function normalizeVariantAdjustment(value){
    const raw = objectValue(value);
    return {
      operation: ['none', 'add', 'multiply', 'divide', 'formula'].includes(raw.operation) ? raw.operation : 'none',
      value: Number.isFinite(Number(raw.value)) ? Number(raw.value) : 0,
      formula: cleanText(raw.formula),
      target: ['sell_price', 'internal_cost', 'both'].includes(raw.target) ? raw.target : 'sell_price',
    };
  }

  function normalizeVariantDimensions(value, optionDefinitions = []){
    let dimensions = Array.isArray(value) ? value.map((entry, index) => {
      const raw = objectValue(entry);
      const kind = ['color', 'option', 'pricing_policy'].includes(raw.kind) ? raw.kind : (slug(raw.id, '') === 'color' ? 'color' : 'option');
      return {
        id: slug(raw.id || raw.label || `dimension_${index + 1}`, `dimension_${index + 1}`),
        label: cleanText(raw.label || raw.name) || `Dimension ${index + 1}`,
        kind,
        affects_sku: kind === 'pricing_policy' ? false : raw.affects_sku !== false,
        values: (Array.isArray(raw.values) ? raw.values : []).map((entryValue, valueIndex) => {
          const variantValue = objectValue(entryValue);
          const id = slug(variantValue.id || variantValue.value || variantValue.label || `value_${valueIndex + 1}`, `value_${valueIndex + 1}`);
          return {
            ...variantValue,
            id,
            label: cleanText(variantValue.label || variantValue.name) || titleFromKey(id),
            hex: kind === 'color' ? cleanText(variantValue.hex) || colorForValue(id, valueIndex) : '',
            image: cleanText(variantValue.image),
            image_crop: normalizeImageCrop(variantValue.image_crop || variantValue.imageCrop),
            adjustment: normalizeVariantAdjustment(variantValue.adjustment),
            pricing_update_rule: kind === 'pricing_policy' ? normalizePriceUpdateRule(variantValue.pricing_update_rule || variantValue.pricingUpdateRule || variantValue) : undefined,
          };
        }),
      };
    }) : [];
    if (!dimensions.length) {
      dimensions = normalizeOptionDefinitions(optionDefinitions).filter((definition) => definition.values.length).map((definition) => ({
        id: definition.id,
        label: definition.label,
        kind: definition.id === 'color' ? 'color' : 'option',
        affects_sku: true,
        values: definition.values.map((entry, index) => ({
          id: entry.value,
          label: entry.label,
          hex: definition.id === 'color' ? colorForValue(entry.value, index) : '',
          image: '',
          adjustment: normalizeVariantAdjustment(),
        })),
      }));
    }
    if (!dimensions.some((dimension) => dimension.kind === 'pricing_policy')) {
      dimensions.push({
        id:'pricing_policy',
        label:(globalThis.PlatformLanguage?.text("pricebook","m_e73e7dc1b3fb1a","Price behavior") ?? "Price behavior"),
        kind:'pricing_policy',
        affects_sku:false,
        values:defaultPricingPolicies().map((rule) => ({ id:rule.id, label:rule.label, hex:'', image:'', adjustment:normalizeVariantAdjustment(), pricing_update_rule:rule })),
      });
    }
    return dimensions;
  }

  function normalizeVariantSelection(value, dimensions){
    const source = objectValue(value);
    return dimensions.reduce((selection, dimension) => {
      const requested = cleanText(source[dimension.id]);
      selection[dimension.id] = dimension.values.some((entry) => entry.id === requested) ? requested : (dimension.values[0]?.id || '');
      return selection;
    }, {});
  }

  function variantCombinationKey(dimensions, selection){
    return dimensions.map((dimension) => `${dimension.id}=${cleanText(selection?.[dimension.id])}`).filter((part) => !part.endsWith('=')).join('|');
  }

  function applyVariantAdjustment(current, adjustment, target){
    const rule = normalizeVariantAdjustment(adjustment);
    if (rule.target !== target && rule.target !== 'both') return current;
    if (rule.operation === 'add') return current + rule.value;
    if (rule.operation === 'multiply') return current * rule.value;
    if (rule.operation === 'divide') return rule.value === 0 ? current : current / rule.value;
    if (rule.operation === 'formula') return evaluateVariantArithmetic(rule.formula, current);
    return current;
  }

  function evaluateVariantArithmetic(formula, current){
    const source = cleanText(formula);
    if (!source) return current;
    const rawTokens = source.match(/[A-Za-z_][A-Za-z0-9_]*|(?:\d+\.?\d*|\.\d+)|[()+\-*/]/g) || [];
    if (rawTokens.join('') !== source.replace(/\s+/g, '')) return current;
    let index = 0;
    const factor = () => {
      const token = rawTokens[index++];
      if (token === '(') { const value = expression(); if (rawTokens[index++] !== ')') throw new Error('paren'); return value; }
      if (token === '-') return -factor();
      if (token === '+') return factor();
      if (['base','current','price','sell_price','cost','internal_cost'].includes(token)) return current;
      const value = Number(token);
      if (!Number.isFinite(value)) throw new Error('number');
      return value;
    };
    const term = () => { let value = factor(); while (['*','/'].includes(rawTokens[index])) { const operator = rawTokens[index++]; const right = factor(); value = operator === '*' ? value * right : (right === 0 ? value : value / right); } return value; };
    const expression = () => { let value = term(); while (['+','-'].includes(rawTokens[index])) { const operator = rawTokens[index++]; const right = term(); value = operator === '+' ? value + right : value - right; } return value; };
    try { const value = expression(); return index === rawTokens.length && Number.isFinite(value) ? value : current; } catch (error) { return current; }
  }

  function resolveVariant(item, selectionValue){
    const dimensions = normalizeVariantDimensions(item.variantDimensions || item.variant_dimensions, item.optionDefinitions);
    const selection = normalizeVariantSelection(selectionValue || item.defaultVariantSelection || item.default_variant_selection, dimensions);
    let computedPrice = Number(item.unitPrice || 0);
    let computedCost = Number(item.internalCost || item.internal_cost || 0);
    let pricingUpdateRule = normalizePriceUpdateRule(item.defaultPricingUpdateRule || item.default_pricing_update_rule);
    const skuParts = [];
    dimensions.forEach((dimension) => {
      const value = dimension.values.find((entry) => entry.id === selection[dimension.id]);
      if (!value) return;
      computedPrice = applyVariantAdjustment(computedPrice, value.adjustment, 'sell_price');
      computedCost = applyVariantAdjustment(computedCost, value.adjustment, 'internal_cost');
      if (dimension.kind === 'pricing_policy') pricingUpdateRule = normalizePriceUpdateRule(value.pricing_update_rule);
      if (dimension.affects_sku && dimension.kind !== 'pricing_policy') skuParts.push(`${dimension.id}:${value.id}`);
    });
    const key = variantCombinationKey(dimensions, selection);
    const override = objectValue((item.variantOverrides || item.variant_overrides || {})[key]);
    return {
      key,
      selection,
      dimensions,
      override,
      computedPrice,
      computedCost,
      unitPrice: Number(override.unit_price ?? override.unitPrice ?? computedPrice),
      internalCost: Number(override.internal_cost ?? override.internalCost ?? computedCost),
      unit: cleanText(override.unit || item.unit) || 'ea',
      internalDescription: cleanText(override.internal_description ?? override.internalDescription ?? item.internalDescription ?? item.internal_description),
      externalDescription: cleanText(override.external_description ?? override.externalDescription ?? item.externalDescription ?? item.external_description ?? item.description),
      image: cleanText(override.image),
      imageCrop: normalizeImageCrop(override.image_crop || override.imageCrop),
      pricingUpdateRule: normalizePriceUpdateRule(override.pricing_update_rule || override.pricingUpdateRule || pricingUpdateRule),
      skuKey: [cleanText(item.code || item.id), ...skuParts].filter(Boolean).join('/'),
    };
  }

  function variationOverride(item){
    const id = cleanText(item?.id);
    if (VARIATION_OVERRIDES[id]) return VARIATION_OVERRIDES[id];
    const typeId = slug(item?.itemTypeId || item?.item_type_id || item?.itemType?.id || item?.materialTypeId || item?.name || id, id || 'material');
    return {
      itemTypeId: typeId,
      itemTypeName: cleanText(item?.itemTypeName || item?.item_type_name || item?.itemType?.label || item?.itemType?.name || item?.name) || titleFromKey(typeId),
      variantId: slug(item?.variantId || item?.variant_id || item?.variant?.id || item?.manufacturer || 'generic', 'generic'),
      variantName: cleanText(item?.variantName || item?.variant_name || item?.variant?.label || item?.variant?.name || item?.name) || titleFromKey(typeId),
      variantGroupId: slug(item?.variantGroupId || item?.variant_group_id || item?.variantGroup?.id || item?.manufacturer || ((item?.manufacturer || 'generic') === 'generic' ? 'unbranded' : 'other'), 'unbranded'),
      variantGroupName: cleanText(item?.variantGroupName || item?.variant_group_name || item?.variantGroup?.label || item?.variantGroup?.name || getBrandLabel(item?.manufacturer || 'generic')) || 'Unbranded',
      variantRole: cleanText(item?.variantRole || item?.variant_role || item?.variant?.role || ((item?.manufacturer || 'generic') === 'generic' ? 'generic' : 'standard')) || 'standard',
      isDefaultVariant: item?.isDefaultVariant === true || item?.is_default_variant === true || item?.variant?.isDefault === true
    };
  }

  function normalizeVariationMetadata(item, normalized){
    const override = variationOverride({ ...item, ...normalized });
    const optionPreset = OPTION_PRESETS[override.optionPreset] ? [OPTION_PRESETS[override.optionPreset]] : [];
    const itemType = objectValue(item.itemType || item.item_type);
    const variant = objectValue(item.variant);
    const optionDefinitions = normalizeOptionDefinitions(
      item.optionDefinitions || item.option_definitions || item.optionsSchema || item.options_schema || itemType.optionDefinitions || itemType.options || optionPreset
    );
    const itemTypeId = slug(item.itemTypeId || item.item_type_id || itemType.id || override.itemTypeId || normalized.id, normalized.id);
    const variantId = slug(item.variantId || item.variant_id || variant.id || override.variantId || normalized.manufacturer || 'generic', 'generic');
    const variantGroupId = slug(item.variantGroupId || item.variant_group_id || variant.groupId || variant.group_id || variant.group?.id || override.variantGroupId || normalized.manufacturer || 'unbranded', 'unbranded');
    const isDefaultVariant = item.isDefaultVariant != null
      ? item.isDefaultVariant === true
      : item.is_default_variant != null
        ? item.is_default_variant === true
        : variant.isDefault != null
          ? variant.isDefault === true
          : !!override.isDefaultVariant;
    return {
      itemTypeId,
      itemTypeName: cleanText(item.itemTypeName || item.item_type_name || itemType.label || itemType.name || override.itemTypeName) || titleFromKey(itemTypeId),
      variantId,
      variantName: cleanText(item.variantName || item.variant_name || variant.label || variant.name || override.variantName) || normalized.name || titleFromKey(variantId),
      variantGroupId,
      variantGroupName: cleanText(item.variantGroupName || item.variant_group_name || variant.groupName || variant.group_name || variant.group?.label || variant.group?.name || override.variantGroupName) || titleFromKey(variantGroupId),
      variantRole: cleanText(item.variantRole || item.variant_role || variant.role || override.variantRole) || 'standard',
      isDefaultVariant,
      optionDefinitions,
      defaultOptions: normalizeOptionSelections(item.defaultOptions || item.default_options || variant.defaultOptions, optionDefinitions)
    };
  }

  function normalizeItem(item, index){
    const unitPrice = Number(item.unit_price ?? item.unitPrice ?? item.base_price ?? item.basePrice ?? 0);
    const category = cleanText(item.category) || 'shingle_roofs';
    const manufacturer = cleanText(item.manufacturer);
    const unit = cleanText(item.unit) || 'ea';
    const optionDefinitions = normalizeOptionDefinitions(item.optionDefinitions || item.option_definitions || item.options || []);
    const variantDimensions = normalizeVariantDimensions(item.variantDimensions || item.variant_dimensions, optionDefinitions);
    const normalized = {
      id: item.id || `item_${index + 1}`,
      kind: item.kind || (Array.isArray(item.components) && item.components.length ? 'assembly' : 'atomic'),
      name: String(item.name || ''),
      category,
      type: cleanText(item.type || item.product_type) || getCategoryLabel(category),
      manufacturer,
      segment: FLASHING_OPTIONS.some((option) => option.value === item.segment) ? item.segment : 'all',
      unit,
      unitPrice,
      unit_price: unitPrice,
      base_price: Number(item.base_price ?? item.basePrice ?? unitPrice) || 0,
      internalCost: Number(item.internal_cost ?? item.internalCost ?? 0) || 0,
      internal_cost: Number(item.internal_cost ?? item.internalCost ?? 0) || 0,
      formulaConfig: inferFormulaConfig(item),
      formula_config: item.formula_config || item.formulaConfig || inferFormulaConfig(item),
      autoAdd: !!item.autoAdd,
      auto_add: !!(item.auto_add ?? item.autoAdd),
      description: String(item.description || ''),
      internalDescription: String(item.internal_description ?? item.internalDescription ?? ''),
      internal_description: String(item.internal_description ?? item.internalDescription ?? ''),
      externalDescription: String(item.external_description ?? item.externalDescription ?? item.description ?? ''),
      external_description: String(item.external_description ?? item.externalDescription ?? item.description ?? ''),
      orderPackaging: normalizeOrderPackaging(item.orderPackaging || item.order_packaging),
      order_packaging: normalizeOrderPackaging(item.order_packaging || item.orderPackaging),
      variables: item.variables && typeof item.variables === 'object' ? { ...item.variables } : {},
      measurements: item.measurements && typeof item.measurements === 'object' ? { ...item.measurements } : {},
      media_refs: Array.isArray(item.media_refs || item.mediaRefs) ? clone(item.media_refs || item.mediaRefs) : [],
      variation_set_refs: Array.isArray(item.variation_set_refs || item.variationSetRefs) ? [...(item.variation_set_refs || item.variationSetRefs)].map(String) : [],
      variation_overrides: item.variation_overrides || item.variationOverrides || {},
      variations: Array.isArray(item.variations) ? clone(item.variations) : [],
      variantDimensions,
      variant_dimensions: clone(variantDimensions),
      variantOverrides: clone(item.variantOverrides || item.variant_overrides || {}),
      variant_overrides: clone(item.variant_overrides || item.variantOverrides || {}),
      defaultVariantSelection: normalizeVariantSelection(item.defaultVariantSelection || item.default_variant_selection, variantDimensions),
      default_variant_selection: normalizeVariantSelection(item.default_variant_selection || item.defaultVariantSelection, variantDimensions),
      defaultPricingUpdateRule: normalizePriceUpdateRule(item.defaultPricingUpdateRule || item.default_pricing_update_rule),
      default_pricing_update_rule: normalizePriceUpdateRule(item.default_pricing_update_rule || item.defaultPricingUpdateRule),
      globalItemRef: clone(item.globalItemRef || item.global_item_ref || {}),
      global_item_ref: clone(item.global_item_ref || item.globalItemRef || {}),
      globalLinkMode: ['live','snapshot','local'].includes(item.globalLinkMode || item.global_link_mode) ? (item.globalLinkMode || item.global_link_mode) : (item.global_item_ref || item.globalItemRef ? 'live' : 'local'),
      global_link_mode: ['live','snapshot','local'].includes(item.global_link_mode || item.globalLinkMode) ? (item.global_link_mode || item.globalLinkMode) : (item.global_item_ref || item.globalItemRef ? 'live' : 'local'),
      globalOverrides: clone(item.globalOverrides || item.global_overrides || {}),
      global_overrides: clone(item.global_overrides || item.globalOverrides || {}),
      globalMarketSnapshot: clone(item.globalMarketSnapshot || item.global_market_snapshot || {}),
      global_market_snapshot: clone(item.global_market_snapshot || item.globalMarketSnapshot || {}),
      selection: item.selection && typeof item.selection === 'object' ? clone(item.selection) : {},
      selection_groups: Array.isArray(item.selection_groups || item.selectionGroups) ? clone(item.selection_groups || item.selectionGroups) : [],
      components: Array.isArray(item.components) ? clone(item.components) : [],
      };
    if (normalized.id === 'tearoff') normalized.category = 'disposal';
    Object.assign(normalized, normalizeVariationMetadata(item || {}, normalized));
    if (normalized.itemTypeId === 'underlayment') normalized.category = 'underlayments';
    if (normalized.itemTypeId === 'leak_barrier') normalized.category = 'leak_barriers';
    if (normalized.itemTypeId === 'field_shingles') normalized.category = 'shingle_roofs';
    return normalized;
  }

  function normalizeState(raw){
    if (!raw || !Array.isArray(raw.items)) return clone(DEFAULT_STATE);
    return {
      ...objectValue(raw),
      schemaVersion: Math.max(Number(raw.schemaVersion || raw.schema_version || 0), 5),
      variationSchemaVersion: 1,
      pricebookLayer: cleanText(raw.pricebookLayer || raw.metadata?.pricebook_layer) || 'organization',
      settings: {
        ...objectValue(raw.settings),
        default_pricing_policies: (Array.isArray(raw.settings?.default_pricing_policies) && raw.settings.default_pricing_policies.length ? raw.settings.default_pricing_policies : DEFAULT_PRICING_POLICIES).map(normalizePriceUpdateRule),
      },
      variation_sets: Array.isArray(raw.variation_sets || raw.variationSets) ? clone(raw.variation_sets || raw.variationSets) : [],
      items: ensureDefaultVariants(raw.items.map(normalizeItem))
    };
  }

  function ensureDefaultVariants(items){
    const groups = new Map();
    items.forEach((item) => {
      const id = item.itemTypeId || item.id;
      if (!groups.has(id)) groups.set(id, []);
      groups.get(id).push(item);
    });
    groups.forEach((group) => {
      const preferred = group.find((item) => item.isDefaultVariant)
        || group.find((item) => item.variantRole === 'generic' || item.manufacturer === 'generic')
        || group[0];
      group.forEach((item) => { item.isDefaultVariant = item.id === preferred.id; });
    });
    return items;
  }

  function mergePricebookStates(baseState, overrideState){
    const baseItems = normalizeState(baseState).items;
    const overrideItems = normalizeState(overrideState).items;
    const merged = new Map(baseItems.map((item) => [item.id, item]));
    overrideItems.forEach((item) => merged.set(item.id, item));
    return normalizeState({ ...objectValue(baseState), ...objectValue(overrideState), items: [...merged.values()] });
  }

  function getItemTypes(){
    const groups = new Map();
    state.items.forEach((item) => {
      const id = item.itemTypeId || item.id;
      if (!groups.has(id)) {
        groups.set(id, {
          id,
          name: item.itemTypeName || titleFromKey(id),
          category: item.category,
          defaultItemId: '',
          variants: []
        });
      }
      const group = groups.get(id);
      group.variants.push(item);
      if (item.isDefaultVariant || !group.defaultItemId) group.defaultItemId = item.id;
    });
    return [...groups.values()].map((group) => ({
      ...group,
      defaultItem: group.variants.find((item) => item.id === group.defaultItemId) || group.variants[0] || null
    }));
  }

  function defaultItems(){
    return getItemTypes().map((type) => type.defaultItem).filter(Boolean);
  }

  function defaultItemsForGeneration(){
    return defaultItems().filter((item) => item.autoAdd);
  }

  function setDefaultVariant(itemId, isDefault = true){
    const target = getItem(itemId);
    if (!target) return;
    state.items = state.items.map((item) => {
      if (item.itemTypeId !== target.itemTypeId) return item;
      return { ...item, isDefaultVariant: isDefault ? item.id === itemId : (item.id === itemId ? false : item.isDefaultVariant) };
    });
    state.items = ensureDefaultVariants(state.items.map(normalizeItem));
    notify();
    render();
  }

  async function loadBranchPricebook(){
    const loader = config.getModule || root.Portal?.branchModules?.get;
    if (!loader) return null;
    try {
      const doc = await loader(config.moduleId);
      if (doc?.revision) remoteRevision = Number(doc.revision || 0);
      return doc?.data ? normalizeState(doc.data) : null;
    } catch (e) {
      if (Number(e?.status || 0) !== 404) console.warn('Unable to load branch pricebook module', e);
      return null;
    }
  }

  async function loadOrganizationPricebook(){
    const organizationId = currentOrganizationId();
    if (!organizationId) return null;
    const loader = config.getOrganizationPricebook;
    try {
      const result = loader
        ? await loader(organizationId)
        : await root.PlatformAPI?.request?.(`/pricebook/organizations/${encodeURIComponent(organizationId)}`);
      const pricebook = result?.pricebook || result;
      if (!pricebook?.catalog) return null;
      remoteRevision = Number(pricebook.manifest?.revision || 0);
      remotePricebookId = cleanText(pricebook.manifest?.id);
      remoteStorageLayer = 'organization';
      return normalizeState({
        ...pricebook.catalog,
        pricebookLayer:'organization',
        metadata:{ ...objectValue(pricebook.catalog.metadata), global_pricebook_ref:pricebook.manifest?.global_pricebook_ref || pricebook.overlay?.global_pricebook_ref || {} },
      });
    } catch (error) {
      console.warn('Unable to load organization pricebook; using the compatibility store.', error);
      return null;
    }
  }

  function pricebookSummary(){
    const categories = new Set((state.items || []).map((item) => item.category).filter(Boolean));
    const itemTypes = new Set((state.items || []).map((item) => item.itemTypeId || item.id).filter(Boolean));
    return {
      item_count: state.items.length,
      item_type_count: itemTypes.size,
      category_count: categories.size,
      organization_id: currentOrganizationId(),
      storage_layer: remoteStorageLayer,
    };
  }

  function pricebookStorageKey(){
    const organization = currentOrganizationId();
    return `${config.storageKey}:org:${organization || 'default'}`;
  }

  async function saveBranchPricebook(options = {}){
    const organizationId = currentOrganizationId();
    if (organizationId) {
      try {
        const saver = config.saveOrganizationPricebook;
        const payload = { catalog:normalizeState(state), ...(remoteRevision > 0 ? { expected_revision:remoteRevision } : {}) };
        const result = saver
          ? await saver(organizationId, payload.catalog, payload.expected_revision)
          : await root.PlatformAPI?.request?.(`/pricebook/organizations/${encodeURIComponent(organizationId)}/catalog`, { method:'PUT', body:payload });
        const pricebook = result?.pricebook || result;
        if (pricebook?.manifest?.revision) remoteRevision = Number(pricebook.manifest.revision);
        if (pricebook?.manifest?.id) remotePricebookId = cleanText(pricebook.manifest.id);
        if (pricebook?.catalog) state = normalizeState({ ...pricebook.catalog, pricebookLayer:'organization' });
        remoteStorageLayer = 'organization';
        return;
      } catch (error) {
        console.warn('Unable to save organization pricebook; using the compatibility store.', error);
        if (options.throwOnError) throw error;
      }
    }
    const saver = config.saveModule || root.Portal?.branchModules?.save;
    if (!saver) return;
    try {
      const doc = await saver(config.moduleId, normalizeState(state), {
        summary: pricebookSummary(),
        source: 'platform_pricebook_editor',
        previous_revision: remoteRevision || undefined,
      });
      if (doc?.revision) remoteRevision = Number(doc.revision || remoteRevision || 0);
    } catch (e) {
      console.warn('Unable to save branch pricebook module', e);
      if (options.throwOnError) throw e;
    }
  }

  function scheduleBranchPricebookSave(){
    if (suppressRemoteSave) return;
    clearTimeout(remoteSaveTimer);
    remoteSaveTimer = setTimeout(() => {
      saveBranchPricebook().catch(() => null);
    }, 500);
  }

  async function loadState(force = false){
    if (loadPromise && !force) return loadPromise;
    loadPromise = Promise.resolve().then(async () => {
      try {
        suppressRemoteSave = true;
        const raw = localStorage.getItem(pricebookStorageKey()) || localStorage.getItem(STORAGE_KEY);
        const response = await fetch(config.defaultPricebookPath, { cache: 'no-store' });
        if (!response.ok) throw new Error(`Pricebook load failed: ${response.status}`);
        const defaults = await response.json();
        const remote = await loadOrganizationPricebook() || await loadBranchPricebook();
        let nextState = remote ? mergePricebookStates(defaults, remote) : normalizeState(defaults);
        if (!remote && raw) {
          nextState = mergePricebookStates(nextState, JSON.parse(raw));
        }
        state = normalizeState(nextState);
        suppressRemoteSave = false;
        if (!remote && raw) {
          saveState();
        } else {
          try { localStorage.setItem(pricebookStorageKey(), JSON.stringify(state, null, 2)); } catch (e) {}
        }
      } catch (e) {
        try {
          suppressRemoteSave = true;
          const response = await fetch(config.defaultPricebookPath, { cache: 'no-store' });
          if (!response.ok) throw new Error(`Pricebook load failed: ${response.status}`);
          state = normalizeState(await response.json());
          suppressRemoteSave = false;
          saveState();
        } catch (inner) {
          state = clone(DEFAULT_STATE);
          suppressRemoteSave = false;
        }
      }
      if (!activeItemId || !state.items.some((item) => item.id === activeItemId)) {
        activeItemId = state.items[0]?.id || null;
      }
      return state;
    });
    return loadPromise;
  }

  let state = clone(DEFAULT_STATE);

  function saveState(){
    try { localStorage.setItem(pricebookStorageKey(), JSON.stringify(state, null, 2)); } catch (e) {}
    scheduleBranchPricebookSave();
  }

  function getState(){
    return clone(state);
  }

  async function resetToDefaults(){
    let defaults = null;
    if (currentOrganizationId() && root.PlatformAPI?.request) {
      try {
        const result = await root.PlatformAPI.request('/pricebook/global');
        defaults = (result?.pricebook || result)?.catalog || null;
      } catch (error) {}
    }
    if (!defaults) {
      const response = await fetch(config.defaultPricebookPath, { cache: 'no-store' });
      if (!response.ok) throw new Error(`Pricebook defaults load failed: ${response.status}`);
      defaults = await response.json();
    }
    suppressRemoteSave = true;
    try {
      state = normalizeState(defaults);
      activeItemId = state.items[0]?.id || null;
      try { localStorage.setItem(pricebookStorageKey(), JSON.stringify(state, null, 2)); } catch (e) {}
      await saveBranchPricebook({ throwOnError:true });
    } finally {
      suppressRemoteSave = false;
    }
    listeners.forEach((listener) => {
      try { listener(getState()); } catch (e) {}
    });
    render();
    return getState();
  }

  function importItems(items, options = {}){
    const incoming = Array.isArray(items) ? items.map(normalizeItem) : [];
    const mode = options.mode === 'replace' ? 'replace' : 'merge';
    state = normalizeState({
      ...state,
      items: mode === 'replace'
        ? incoming
        : [...new Map([...state.items, ...incoming].map((item) => [item.id, item])).values()]
    });
    activeItemId = incoming[0]?.id || state.items[0]?.id || null;
    notify();
    render();
    return getState();
  }

  function notify(){
    saveState();
    listeners.forEach((listener) => {
      try { listener(getState()); } catch (e) {}
    });
  }

  function formulaToExpression(formulaConfig){
    const config = inferFormulaConfig({ formulaConfig });
    const inner = config.tokens.map((token) => {
      if (token.type === 'measurement' || token.type === 'custom_field') return token.value;
      if (token.type === 'number') return String(Number(token.value || 0));
      return token.value;
    }).join(' ');
    const base = inner.trim() || '0';
    return config.includeWaste ? `( ${base} ) * ( 1 + (wastePercent / 100) )` : base;
  }

  function formulaToHumanText(formulaConfig){
    const config = inferFormulaConfig({ formulaConfig });
    const text = config.tokens.map((token) => {
      if (token.type === 'measurement' || token.type === 'custom_field') return getMeasurementLabel(token.value);
      if (token.type === 'number') return token.value || '0';
      return token.value;
    }).join(' ');
    return config.includeWaste ? `${text || 'Roof Squares'} + waste` : (text || 'Roof Squares');
  }

  function evaluateFormula(formulaConfig, measurements){
    const config = inferFormulaConfig({ formulaConfig });
    const scope = { ...(measurements || {}) };
    MEASUREMENT_FIELDS.forEach((field) => {
      if (scope[field.key] === undefined || scope[field.key] === null || scope[field.key] === '') scope[field.key] = 0;
    });
    config.tokens.forEach((token) => {
      if ((token.type === 'measurement' || token.type === 'custom_field') && (scope[token.value] === undefined || scope[token.value] === null || scope[token.value] === '')) {
        scope[token.value] = 0;
      }
    });
    const body = formulaToExpression(formulaConfig);
    try {
      const fn = new Function('m', `with (m) { return Number(${body}) || 0; }`);
      const value = Number(fn(scope));
      return Number.isFinite(value) ? value : 0;
    } catch (e) {
      return 0;
    }
  }

  function getItem(itemId){
    return state.items.find((item) => item.id === itemId) || null;
  }

  function displayUnit(unit){
    return UNIT_OPTIONS.find((option) => option.value === unit)?.label || unit;
  }

  function getCategoryFilterOptions(category){
    if (category === 'shingle_roofs' || category === 'leak_barriers') return BRAND_OPTIONS;
    if (category === 'flashing') return FLASHING_OPTIONS;
    return [];
  }

  function toggleCategoryFilter(category, value){
    const options = getCategoryFilterOptions(category).map((option) => option.value);
    if (!options.length) return;
    let next = Array.isArray(categoryFilters[category]) ? [...categoryFilters[category]] : ['all'];
    if (value === 'all') {
      next = ['all'];
    } else if (value === 'generic') {
      next = ['generic'];
    } else {
      next = next.filter((entry) => entry !== 'all' && entry !== 'generic');
      if (next.includes(value)) next = next.filter((entry) => entry !== value);
      else next.push(value);
      if (!next.length) next = ['all'];
    }
    categoryFilters = { ...categoryFilters, [category]: next };
  }

  function itemMatchesCategoryFilter(item, category){
    const selected = categoryFilters[category] || ['all'];
    if (selected.includes('all')) {
      return true;
    }
    if (selected.includes('generic')) {
      if (category === 'shingle_roofs' || category === 'leak_barriers') return (item.manufacturer || 'generic') === 'generic';
      return false;
    }
    if (category === 'shingle_roofs' || category === 'leak_barriers') return selected.includes(item.manufacturer || 'generic');
    if (category === 'flashing') return selected.includes(item.segment || 'other');
    return true;
  }

  function formatSidebarMeta(item){
    const parts = [item.type || item.itemTypeName || displayUnit(item.unit)];
    if (item.variantName && item.variantName !== item.name) parts.push(item.variantName);
    else parts.push(displayUnit(item.unit));
    if (item.variantGroupName && !parts.includes(item.variantGroupName)) parts.push(item.variantGroupName);
    if (item.category === 'shingle_roofs' || item.category === 'leak_barriers') parts.push(getBrandLabel(item.manufacturer || 'generic'));
    if (item.category === 'flashing' && item.segment && item.segment !== 'all') parts.push(getFlashingLabel(item.segment));
    if (item.isDefaultVariant) parts.push('Default');
    parts.push(item.globalLinkMode === 'live' ? 'Tracks market' : item.globalLinkMode === 'snapshot' ? 'Market snapshot' : 'Company item');
    return parts.join(' · ');
  }

  function getFilterChipLabel(option){
    if (option.value === 'all') return 'All';
    if (option.value === 'generic') return 'Generic';
    if (option.value === 'owens_corning') return 'OC';
    if (option.value === 'certainteed') return 'CT';
    if (option.value === 'malarkey') return 'M';
    return option.label;
  }

  function filterHasUsedItems(category, value, usedSubfilters){
    if (value === 'all') return false;
    if (category === 'shingle_roofs' || category === 'leak_barriers') {
      return usedSubfilters.brands.has(value);
    }
    if (category === 'flashing') {
      return usedSubfilters.flashing.has(value);
    }
    return false;
  }

  function getVisibleTree(search){
    const needle = String(search || '').trim().toLowerCase();
    return CATEGORY_OPTIONS.map((category) => {
      const items = state.items.filter((item) => {
        if (item.category !== category.value) return false;
        if (!itemMatchesCategoryFilter(item, category.value)) return false;
        if (!needle) return true;
        const hay = `${item.name} ${item.type || ''} ${item.itemTypeName || ''} ${item.variantName || ''} ${item.variantGroupName || ''} ${item.externalDescription || item.description} ${item.internalDescription || ''} ${item.unit} ${item.category} ${item.manufacturer || ''} ${item.segment || ''} ${formulaToHumanText(item.formulaConfig)}`.toLowerCase();
        return hay.includes(needle);
      });
      return { ...category, items };
    }).filter((category) => category.items.length || !needle);
  }

  function lineItemFromPricebook(itemId, measurements, overrides = {}){
    const item = getItem(itemId);
    if (!item) return null;
    const formulaConfig = overrides.formulaConfig || item.formulaConfig;
    const quantity = overrides.manualQuantity ? Number(overrides.quantity || 0) : evaluateFormula(formulaConfig, measurements);
    const variant = resolveVariant(item, overrides.selectedVariants || overrides.selected_variants);
    const unitPrice = overrides.manualUnitPrice ? Number(overrides.unitPrice || 0) : Number(variant.unitPrice || 0);
    const pricingUpdateRule = normalizePriceUpdateRule(overrides.pricingUpdateRule || overrides.pricing_update_rule || variant.pricingUpdateRule);
    const orderInfo = computeOrderQuantity(item.orderPackaging || item.order_packaging, quantity);
    const capturedAt = new Date().toISOString();
    return {
      pricebookItemId: item.id,
      pricebook_ref: {
        pricebook_layer:'organization',
        item_id:item.id,
        catalog_item_id:item.id,
        global_item_ref:clone(item.globalItemRef || item.global_item_ref || {}),
        selected_variants:clone(variant.selection),
        combination_key:variant.key,
      },
      label: overrides.label || item.name,
      description: overrides.description || variant.externalDescription,
      internalDescription: variant.internalDescription,
      category: item.category,
      manufacturer: item.manufacturer || 'generic',
      segment: item.segment || 'all',
      quantity: String(Math.max(0, Number(quantity.toFixed(2)))),
      unitPrice: `$${unitPrice.toFixed(2)}`,
      amount: `$${(Math.max(0, quantity) * unitPrice).toFixed(2)}`,
      unit: variant.unit,
      internalCost: variant.internalCost,
      skuKey: variant.skuKey,
      selectedVariants: clone(variant.selection),
      variantCombinationKey: variant.key,
      pricingUpdateRule: clone(pricingUpdateRule),
      pricing_update_rule: clone(pricingUpdateRule),
      pricebook_snapshot: {
        captured_at:capturedAt,
        item_id:item.id,
        name:item.name,
        unit:variant.unit,
        unit_price:unitPrice,
        internal_cost:variant.internalCost,
        selected_variants:clone(variant.selection),
        combination_key:variant.key,
        sku_key:variant.skuKey,
        pricing_update_rule:clone(pricingUpdateRule),
      },
      order_packaging: orderInfo ? clone(orderInfo.packaging) : null,
      order_quantity: orderInfo ? orderInfo.order_quantity : undefined,
      order_unit: orderInfo ? orderInfo.order_unit : undefined,
      order_covered_quantity: orderInfo ? orderInfo.covered_quantity : undefined,
      itemTypeId: item.itemTypeId,
      itemTypeName: item.itemTypeName,
      variantId: item.variantId,
      variantName: item.variantName,
      variantGroupId: item.variantGroupId,
      variantGroupName: item.variantGroupName,
      variantRole: item.variantRole,
      isDefaultVariant: !!item.isDefaultVariant,
      optionDefinitions: clone(item.optionDefinitions || []),
      defaultOptions: clone(item.defaultOptions || {}),
      formulaConfig: clone(formulaConfig),
      formula: formulaToHumanText(formulaConfig),
      autoDerived: !overrides.manualQuantity,
      manualQuantity: !!overrides.manualQuantity,
      manualUnitPrice: !!overrides.manualUnitPrice,
    };
  }

  function normalizeSelection(source = {}, fallback = { mode: 'fixed', selected: true, selectable_by: ['internal'] }){
    const selection = source && typeof source === 'object' ? source : {};
    return {
      ...fallback,
      ...selection,
      mode: ['fixed', 'optional', 'choice'].includes(selection.mode) ? selection.mode : (fallback.mode || 'fixed'),
      selected: selection.mode === 'fixed' ? true : selection.selected !== false,
      selectable_by: Array.isArray(selection.selectable_by) && selection.selectable_by.length ? selection.selectable_by : (fallback.selectable_by || ['internal'])
    };
  }

  function variationsForItem(item){
    const sets = new Map((state.variation_sets || state.variationSets || []).map((set) => [String(set.id || ''), set]));
    const fromSets = (item.variation_set_refs || item.variationSetRefs || [])
      .map((setId) => sets.get(String(setId || '')))
      .filter(Boolean)
      .flatMap((set) => (set.values || []).map((value) => ({
        id: String(value.id || value.value || ''),
        label: value.label || value.name || value.id,
        name: value.name || value.label || value.id,
        variation_set_id: set.id,
        overrides: {
          variables: { [set.variable_key || set.id]: value.id || value.value },
          ...((item.variation_overrides || item.variationOverrides || {})[value.id || value.value] || {}),
          ...(value.overrides || {})
        }
      })));
    const byId = new Map();
    [...fromSets, ...(item.variations || [])].forEach((variation) => {
      if (!variation?.id) return;
      byId.set(String(variation.id), { ...(byId.get(String(variation.id)) || {}), ...clone(variation) });
    });
    return [...byId.values()];
  }

  function scopeItemFromPricebook(itemId, measurements, overrides = {}, seen = new Set()){
    const item = getItem(itemId);
    if (!item || seen.has(item.id)) return null;
    const nextSeen = new Set(seen);
    nextSeen.add(item.id);
    const formulaConfig = overrides.formulaConfig || overrides.formula_config || item.formulaConfig || item.formula_config;
    const hasQuantityOverride = overrides.quantity !== undefined && overrides.quantity !== null && overrides.quantity !== '';
    const quantity = overrides.manualQuantity || hasQuantityOverride ? Number(overrides.quantity || 0) : evaluateFormula(formulaConfig, measurements || {});
    const variant = resolveVariant(item, overrides.selected_variants || overrides.selectedVariants);
    const unitPrice = Number(overrides.unit_price ?? overrides.unitPrice ?? variant.unitPrice ?? item.unit_price ?? item.unitPrice ?? item.base_price ?? item.basePrice ?? 0) || 0;
    const pricingUpdateRule = normalizePriceUpdateRule(overrides.pricing_update_rule || overrides.pricingUpdateRule || variant.pricingUpdateRule);
    const capturedAt = new Date().toISOString();
    const scopeItem = {
      id: overrides.scope_item_id || `scope_${item.id}_${Math.random().toString(36).slice(2, 8)}`,
      type: 'scope_item',
      pricebook_ref: {
        pricebook_layer:'organization',
        item_id:item.id,
        catalog_item_id:item.id,
        global_item_ref:clone(item.globalItemRef || item.global_item_ref || {}),
        selected_variants:clone(variant.selection),
        combination_key:variant.key,
      },
      name: overrides.name || item.name,
      display_name: overrides.display_name || overrides.displayName || item.display_name || item.displayName || item.name,
      description: overrides.description || variant.externalDescription || item.description || '',
      internal_description: variant.internalDescription,
      external_description: variant.externalDescription,
      unit: variant.unit || item.unit || 'ea',
      order_packaging: normalizeOrderPackaging(item.orderPackaging || item.order_packaging),
      quantity: String(Math.max(0, Number(quantity.toFixed ? quantity.toFixed(2) : quantity))),
      unit_price: unitPrice,
      internal_cost: variant.internalCost,
      sku_key: variant.skuKey,
      selected_variants: clone(variant.selection),
      variant_combination_key: variant.key,
      pricing_update_rule: clone(pricingUpdateRule),
      pricebook_snapshot: {
        captured_at:capturedAt,
        item_id:item.id,
        name:item.name,
        unit:variant.unit,
        unit_price:unitPrice,
        internal_cost:variant.internalCost,
        selected_variants:clone(variant.selection),
        combination_key:variant.key,
        sku_key:variant.skuKey,
        pricing_update_rule:clone(pricingUpdateRule),
      },
      base_price: Number(item.base_price ?? item.basePrice ?? unitPrice) || 0,
      included: overrides.included === true || item.included === true,
      price_driving: overrides.price_driving !== false && overrides.priceDriving !== false && item.price_driving !== false && item.priceDriving !== false,
      variables: { ...(item.variables || {}), ...(overrides.variables || {}) },
      measurements: { ...(item.measurements || {}), ...(overrides.measurements || {}) },
      formula: formulaToHumanText(formulaConfig),
      formula_config: clone(formulaConfig || { tokens: [{ type: 'number', value: '1' }] }),
      media_refs: clone(overrides.media_refs || item.media_refs || item.mediaRefs || item.images || []),
      selection: normalizeSelection(overrides.selection || item.selection),
      variation_selection: clone(overrides.variation_selection || overrides.variationSelection || item.variation_selection || item.variationSelection || {}),
      variations: variationsForItem(item),
      selection_groups: clone(overrides.selection_groups || overrides.selectionGroups || item.selection_groups || item.selectionGroups || []),
      children: []
    };
    scopeItem.children = (item.components || []).map((component) => {
      const ref = component.item_ref || component.itemRef || component.item_id || component.itemId;
      if (!ref) return null;
      return scopeItemFromPricebook(ref, measurements, {
        ...(component.overrides || {}),
        ...component,
        selection: component.selection || (component.overrides || {}).selection,
        variation_selection: component.variation_selection || component.variationSelection || (component.overrides || {}).variation_selection
      }, nextSeen);
    }).filter(Boolean);
    return scopeItem;
  }

  function defaultLineItems(measurements){
    return defaultItemsForGeneration()
      .map((item) => lineItemFromPricebook(item.id, measurements))
      .filter((item) => item && Number(item.quantity || 0) > 0);
  }

  function defaultScopeItems(measurements){
    return defaultItemsForGeneration()
      .map((item) => scopeItemFromPricebook(item.id, measurements))
      .filter((item) => item && (Number(item.quantity || 0) > 0 || item.children?.length));
  }

  function getSuggestions(query){
    const needle = String(query || '').trim().toLowerCase();
    return state.items
      .map((item) => {
        const hay = `${item.name} ${item.type || ''} ${item.itemTypeName || ''} ${item.variantName || ''} ${item.variantGroupName || ''} ${item.externalDescription || item.description} ${item.internalDescription || ''} ${item.unit} ${item.category} ${item.manufacturer || ''} ${item.segment || ''} ${formulaToHumanText(item.formulaConfig)}`.toLowerCase();
        const score = !needle ? 1 : hay.includes(needle) ? (item.name.toLowerCase().startsWith(needle) ? 4 : 2) : 0;
        return { item, score };
      })
      .filter((entry) => entry.score > 0)
      .sort((a, b) => b.score - a.score || a.item.name.localeCompare(b.item.name))
      .map((entry) => entry.item);
  }

  function patchItem(itemId, patch){
    state.items = state.items.map((item) => item.id === itemId ? normalizeItem({ ...item, ...patch }, 0) : item);
    notify();
    render();
  }

  function patchItemDeferred(itemId, patch, delay = 160){
    state.items = state.items.map((item) => item.id === itemId ? normalizeItem({ ...item, ...patch }, 0) : item);
    notify();
    window.setTimeout(() => {
      if (activeItemId === itemId) render();
    }, delay);
  }

  function shellMarkup(options = {}){
    const title = options.title || (globalThis.PlatformLanguage?.text("pricebook","m_5bdcd2418294b6","Organization Price Book") ?? "Organization Price Book");
    const subtitle = options.subtitle || 'Company pricing, global market references, and artifact line behavior.';
    return `
      <div class="pb-win">
        <div class="pb-top">
          <button type="button" class="pb-back" id="pbBack"><i class="fas fa-arrow-left"></i>${(globalThis.PlatformLanguage?.htmlText("pricebook","m_206d31a7c795c4"," Back") ?? " Back")}</button>
          <div class="pb-title">
            <strong>${String(escapeHtml(title))}</strong>
            <span>${String(escapeHtml(subtitle))}</span>
          </div>
          <div class="pb-top-actions">
            <button type="button" class="pb-close" id="pbClose" title="${(globalThis.PlatformLanguage?.htmlText("pricebook","m_3970e2850e1508","Close Price Book") ?? "Close Price Book")}" aria-label="${(globalThis.PlatformLanguage?.htmlText("pricebook","m_3970e2850e1508","Close Price Book") ?? "Close Price Book")}"><i class="fas fa-xmark"></i></button>
          </div>
        </div>
        <div class="pb-body">
          <div class="pb-side">
            <div class="pb-side-tools">
              <input id="pbSearch" class="pb-search" placeholder="${(globalThis.PlatformLanguage?.htmlText("pricebook","m_52f12bcee9c7f8","Search pricebook items...") ?? "Search pricebook items...")}">
            </div>
            <div class="pb-list" id="pbList"></div>
          </div>
          <div class="pb-main" id="pbMain"></div>
        </div>
      </div>
    `;
  }

  function bindShell(rootEl){
    rootEl.querySelector('#pbSearch')?.addEventListener('input', render);
  }

  function updateShellTitle(rootEl, options = {}){
    const title = options.title || (globalThis.PlatformLanguage?.text("pricebook","m_f574625863d5b7","Pricebook") ?? "Pricebook");
    const subtitle = options.subtitle || 'Edit branch formulas, defaults, and estimate items.';
    const titleEl = rootEl?.querySelector?.('.pb-title strong');
    const subtitleEl = rootEl?.querySelector?.('.pb-title span');
    if (titleEl) titleEl.textContent = title;
    if (subtitleEl) subtitleEl.textContent = subtitle;
  }

  function applyOverlayOrigin(overlay, originRect){
    const win = overlay?.querySelector?.('.pb-win');
    if (!overlay || !win) return;
    const fallback = { left: window.innerWidth / 2, top: window.innerHeight / 2, width: 0, height: 0 };
    const rect = originRect && Number.isFinite(originRect.left) ? originRect : fallback;
    overlay.classList.add('measuring');
    const winRect = win.getBoundingClientRect();
    const originX = (rect.left + (rect.width || 0) / 2) - winRect.left;
    const originY = (rect.top + (rect.height || 0) / 2) - winRect.top;
    win.style.setProperty('--pb-origin-x', `${Math.max(0, Math.min(winRect.width, originX))}px`);
    win.style.setProperty('--pb-origin-y', `${Math.max(0, Math.min(winRect.height, originY))}px`);
    overlay.classList.remove('measuring');
  }

  function ensureUi(){
    if (overlayBuilt) return;
    overlayBuilt = true;
    injectCSS('pricebook', css);
    const el = document.createElement('div');
    el.className = 'pb-overlay';
    el.id = 'pbOverlay';
    el.innerHTML = shellMarkup();
    document.body.appendChild(el);
    el.addEventListener('mousedown', (e) => { if (e.target === el) close(); });
    el.querySelector('#pbBack').addEventListener('click', close);
    el.querySelector('#pbClose')?.addEventListener('click', close);
    bindShell(el);
  }

  function optionValuesText(definition){
    return (Array.isArray(definition.values) ? definition.values : [])
      .map((value) => `${value.value}:${value.label}`)
      .join(', ');
  }

  function parseOptionValues(text){
    return cleanText(text).split(',')
      .map((part) => part.trim())
      .filter(Boolean)
      .map((part) => {
        const [value, ...labelParts] = part.split(':');
        const optionValue = slug(value, 'option');
        return {
          value: optionValue,
          label: cleanText(labelParts.join(':')) || titleFromKey(optionValue),
          metadata: {}
        };
      });
  }

  function variantUiFor(item){
    const dimensions = normalizeVariantDimensions(item.variantDimensions || item.variant_dimensions, item.optionDefinitions);
    const existing = variantUiState.get(item.id) || {};
    const axisX = dimensions.some((entry) => entry.id === existing.axisX) ? existing.axisX : dimensions[0]?.id || '';
    const axisY = dimensions.some((entry) => entry.id === existing.axisY && entry.id !== axisX) ? existing.axisY : dimensions.find((entry) => entry.id !== axisX)?.id || '';
    const activeDimensionId = dimensions.some((entry) => entry.id === existing.activeDimensionId) ? existing.activeDimensionId : dimensions[0]?.id || '';
    const selection = normalizeVariantSelection(existing.selection || item.defaultVariantSelection, dimensions);
    const ui = {
      axisX,
      axisY,
      activeDimensionId,
      selection,
      selectedKeys:new Set(existing.selectedKeys || []),
      expandedValues:new Set(existing.expandedValues || []),
      matrixOpen:existing.matrixOpen === true,
      bulkMode:existing.bulkMode === true,
      overrideOpen:existing.overrideOpen === true,
      scrollLeft:Number(existing.scrollLeft || 0),
      scrollTop:Number(existing.scrollTop || 0),
      editorScrollTop:Number(existing.editorScrollTop || 0),
    };
    variantUiState.set(item.id, ui);
    return ui;
  }

  function patchItemInput(itemId, patch){
    state.items = state.items.map((item) => item.id === itemId ? normalizeItem({ ...item, ...patch }, 0) : item);
    notify();
  }

  function adjustmentSummary(value){
    const adjustment = normalizeVariantAdjustment(value.adjustment);
    if (adjustment.operation === 'add') return `${Number(adjustment.value || 0) >= 0 ? '+' : '-'}$${Math.abs(Number(adjustment.value || 0)).toFixed(2)}`;
    if (adjustment.operation === 'multiply') return `× ${Number(adjustment.value || 0)}`;
    if (adjustment.operation === 'divide') return `÷ ${Number(adjustment.value || 0)}`;
    if (adjustment.operation === 'formula') return 'Formula';
    return '';
  }

  function policySummary(value){
    const rule = normalizePriceUpdateRule(value.pricing_update_rule);
    if (rule.mode === 'conditional') {
      const days = Number(rule.expires_after?.amount || 0);
      return days ? `${days} days` : 'Conditional';
    }
    return rule.mode === 'live' ? 'Live pricing' : 'Fixed price';
  }

  function croppedImageMarkup(image, crop){
    if (!cleanText(image)) return '<i class="fas fa-image"></i>';
    const normalized = normalizeImageCrop(crop);
    const style = normalized
      ? `left:${normalized.x * 100}%;top:${normalized.y * 100}%;width:${normalized.w * 100}%;height:${normalized.h * 100}%`
      : 'inset:0;width:100%;height:100%;object-fit:cover';
    return `<img src="${escapeHtml(image)}" alt="" style="${style}">`;
  }

  function renderImageUpload(image, crop, attributes = ''){
    return `<div class="pb-image-control">
      <label class="pb-image-picker" title="${image ? 'Replace image' : 'Upload image'}">
        ${croppedImageMarkup(image, crop)}
        <input type="file" accept="image/*" data-pb-image-input ${attributes} aria-label="${image ? 'Replace image' : 'Upload image'}">
      </label>
      ${image ? `<button type="button" class="pb-image-crop-button" data-pb-edit-crop data-pb-image-src="${String(escapeHtml(image))}" data-pb-image-crop="${String(escapeHtml(JSON.stringify(normalizeImageCrop(crop) || null)))}" ${String(attributes)} title="${(globalThis.PlatformLanguage?.htmlText("pricebook","m_768d2dfc006fb9","Adjust crop") ?? "Adjust crop")}" aria-label="${(globalThis.PlatformLanguage?.htmlText("pricebook","m_768d2dfc006fb9","Adjust crop") ?? "Adjust crop")}"><i class="fas fa-crop-simple"></i></button>` : ''}
    </div>`;
  }

  function readFileAsDataUrl(file){
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result || ''));
      reader.onerror = () => reject(reader.error || new Error('Unable to read image.'));
      reader.readAsDataURL(file);
    });
  }

  async function persistPricebookImage(file, dataUrl){
    if (!remotePricebookId || !root.PlatformAPI?.request) return dataUrl;
    const base64 = String(dataUrl).split(',')[1] || '';
    const result = await root.PlatformAPI.request(`/pricebook/pricebooks/${encodeURIComponent(remotePricebookId)}/assets`, {
      method:'POST',
      body:{
        file_name:file.name || `variant-${Date.now()}.png`,
        content_type:file.type || 'image/png',
        content_base64:base64,
        kind:'image',
        metadata:{ usage:'pricebook_variant' },
        ...(remoteRevision > 0 ? { expected_revision:remoteRevision } : {}),
      },
    });
    if (result?.manifest?.revision) remoteRevision = Number(result.manifest.revision);
    const assetId = cleanText(result?.asset?.id);
    if (result?.asset && assetId) {
      const assets = Array.isArray(state.assets) ? state.assets.filter((asset) => cleanText(asset?.id) !== assetId) : [];
      state = normalizeState({ ...state, assets:[...assets, result.asset] });
    }
    return assetId
      ? (root.PlatformAPI.url?.(`/pricebook/pricebooks/${encodeURIComponent(remotePricebookId)}/assets/${encodeURIComponent(assetId)}`) || dataUrl)
      : dataUrl;
  }

  function openImageCrop(imageSrc, initialCrop, onApply){
    document.querySelector('.pb-crop-overlay')?.remove();
    const overlay = document.createElement('div');
    overlay.className = 'pb-crop-overlay';
    overlay.innerHTML = `<div class="pb-crop-dialog" role="dialog" aria-modal="true" aria-label="${(globalThis.PlatformLanguage?.htmlText("pricebook","m_e5f0fab1dde345","Crop image") ?? "Crop image")}">
      <div class="pb-crop-head"><div><strong>${(globalThis.PlatformLanguage?.htmlText("pricebook","m_e5f0fab1dde345","Crop image") ?? "Crop image")}</strong><span>${(globalThis.PlatformLanguage?.htmlText("pricebook","m_8f05767ca298c4","Drag the image or resize it from a corner.") ?? "Drag the image or resize it from a corner.")}</span></div><button type="button" class="pb-icon-button" data-pb-crop-cancel aria-label="${(globalThis.PlatformLanguage?.htmlText("pricebook","m_3742924668fb10","Close") ?? "Close")}"><i class="fas fa-times"></i></button></div>
      <div class="pb-crop-stage">
        <img class="pb-crop-ghost" alt="">
        <div class="pb-crop-frame"><img class="pb-crop-solid" alt=""></div>
        <div class="pb-crop-image-box"><i class="pb-crop-handle nw" data-corner="nw"></i><i class="pb-crop-handle ne" data-corner="ne"></i><i class="pb-crop-handle se" data-corner="se"></i><i class="pb-crop-handle sw" data-corner="sw"></i></div>
      </div>
      <div class="pb-crop-foot"><button type="button" class="pb-secondary-button" data-pb-crop-cancel>${(globalThis.PlatformLanguage?.htmlText("pricebook","m_cbef679b21abb4","Cancel") ?? "Cancel")}</button><button type="button" class="pb-primary-button" data-pb-crop-apply>${(globalThis.PlatformLanguage?.htmlText("pricebook","m_dd1d3024d93c92","Apply crop") ?? "Apply crop")}</button></div>
    </div>`;
    document.body.appendChild(overlay);
    const stage = overlay.querySelector('.pb-crop-stage');
    const frame = overlay.querySelector('.pb-crop-frame');
    const ghost = overlay.querySelector('.pb-crop-ghost');
    const solid = overlay.querySelector('.pb-crop-solid');
    const box = overlay.querySelector('.pb-crop-image-box');
    const image = new Image();
    let placement = null;
    const close = () => overlay.remove();
    const metrics = () => {
      const stageRect = stage.getBoundingClientRect();
      const frameRect = frame.getBoundingClientRect();
      return { left:frameRect.left - stageRect.left, top:frameRect.top - stageRect.top, width:frameRect.width, height:frameRect.height };
    };
    const clampPlacement = (next) => {
      const frameMetrics = metrics();
      const minimum = Math.max(frameMetrics.width / next.w, frameMetrics.height / next.h, 1);
      if (minimum > 1) {
        next.w *= minimum;
        next.h *= minimum;
      }
      next.x = Math.min(0, Math.max(frameMetrics.width - next.w, next.x));
      next.y = Math.min(0, Math.max(frameMetrics.height - next.h, next.y));
      return next;
    };
    const paint = () => {
      if (!placement) return;
      const m = metrics();
      const common = { left:`${m.left + placement.x}px`, top:`${m.top + placement.y}px`, width:`${placement.w}px`, height:`${placement.h}px` };
      Object.assign(ghost.style, common);
      Object.assign(box.style, common);
      Object.assign(solid.style, { left:`${placement.x}px`, top:`${placement.y}px`, width:`${placement.w}px`, height:`${placement.h}px` });
    };
    image.onload = () => {
      const m = metrics();
      const saved = normalizeImageCrop(initialCrop);
      if (saved) placement = clampPlacement({ x:saved.x * m.width, y:saved.y * m.height, w:saved.w * m.width, h:saved.h * m.height });
      else {
        const scale = Math.max(m.width / image.naturalWidth, m.height / image.naturalHeight);
        const width = image.naturalWidth * scale;
        const height = image.naturalHeight * scale;
        placement = { x:(m.width - width) / 2, y:(m.height - height) / 2, w:width, h:height };
      }
      paint();
    };
    image.onerror = () => { close(); root.Portal?.ui?.showToast?.((globalThis.PlatformLanguage?.text("pricebook","m_18babb96cc83f3","Image unavailable") ?? "Image unavailable"), (globalThis.PlatformLanguage?.text("pricebook","m_13e930701250b5","Choose another image and try again.") ?? "Choose another image and try again."), false); };
    ghost.src = imageSrc;
    solid.src = imageSrc;
    image.src = imageSrc;
    const beginPointer = (event, corner = '') => {
      if (!placement) return;
      event.preventDefault();
      const start = { ...placement, clientX:event.clientX, clientY:event.clientY };
      const aspect = start.w / start.h;
      const move = (moveEvent) => {
        const dx = moveEvent.clientX - start.clientX;
        const dy = moveEvent.clientY - start.clientY;
        if (!corner) placement = clampPlacement({ ...start, x:start.x + dx, y:start.y + dy });
        else {
          const xSign = corner.includes('w') ? -1 : 1;
          const ySign = corner.includes('n') ? -1 : 1;
          const scale = Math.max(.1, 1 + ((dx * xSign / start.w) + (dy * ySign / start.h)) / 2);
          const width = start.w * scale;
          const height = width / aspect;
          const next = {
            x:corner.includes('w') ? start.x + start.w - width : start.x,
            y:corner.includes('n') ? start.y + start.h - height : start.y,
            w:width,
            h:height,
          };
          placement = clampPlacement(next);
        }
        paint();
      };
      const up = () => { window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', up); };
      window.addEventListener('pointermove', move);
      window.addEventListener('pointerup', up, { once:true });
    };
    box.addEventListener('pointerdown', (event) => {
      const corner = event.target?.dataset?.corner || '';
      beginPointer(event, corner);
    });
    overlay.querySelectorAll('[data-pb-crop-cancel]').forEach((button) => button.addEventListener('click', close));
    overlay.addEventListener('click', (event) => { if (event.target === overlay) close(); });
    overlay.querySelector('[data-pb-crop-apply]').addEventListener('click', () => {
      if (!placement) return;
      const m = metrics();
      onApply({ x:placement.x / m.width, y:placement.y / m.height, w:placement.w / m.width, h:placement.h / m.height });
      close();
    });
  }

  function renderDimensionEditor(item, dimension, dimensionIndex){
    const isPolicy = dimension.kind === 'pricing_policy';
    const ui = variantUiFor(item);
    return `
      <section class="pb-dimension pb-dimension-active" data-pb-dimension="${String(dimensionIndex)}">
        <div class="pb-dimension-head">
          <input data-pb-dimension-field="label" value="${String(escapeHtml(dimension.label))}" aria-label="${(globalThis.PlatformLanguage?.htmlText("pricebook","m_e7306d07587c06","Dimension label") ?? "Dimension label")}">
          <select data-pb-dimension-field="kind" aria-label="${(globalThis.PlatformLanguage?.htmlText("pricebook","m_d277c5a2d4b2a2","Dimension type") ?? "Dimension type")}">
            ${String([['option','Option'],['color','Color'],['pricing_policy','Price behavior']].map(([value,label]) => `<option value="${value}"${dimension.kind === value ? ' selected' : ''}>${label}</option>`).join(''))}
          </select>
          ${String(isPolicy
            ? `<span class="pb-sku-state locked"><i class="fas fa-link"></i>${(globalThis.PlatformLanguage?.htmlText("pricebook","m_649af0b3e6a287"," Shared SKU") ?? " Shared SKU")}</span>`
            : `<button type="button" class="pb-sku-state${dimension.affects_sku ? ' active' : ''}" data-pb-toggle-dimension-sku="${dimensionIndex}"><i class="fas fa-barcode"></i> ${dimension.affects_sku ? 'Creates SKUs' : 'Shared SKU'}</button>`)}
          <button type="button" class="pb-icon-button danger" data-pb-remove-dimension="${String(dimensionIndex)}"${String(isPolicy ? ' disabled title="Price behavior is required"' : '')} aria-label="${(globalThis.PlatformLanguage?.htmlText("pricebook","m_8f0a107fb3a10b","Delete dimension") ?? "Delete dimension")}"><i class="fas fa-trash"></i></button>
        </div>
        <div class="pb-value-list">
          ${String(dimension.values.map((value, valueIndex) => {
            const valueKey = `${dimension.id}:${value.id}`;
            const summary = isPolicy ? policySummary(value) : adjustmentSummary(value);
            return `<details class="pb-value-row" data-pb-value-details="${escapeHtml(valueKey)}"${ui.expandedValues.has(valueKey) ? ' open' : ''}>
              <summary>
                <span class="pb-value-leading">${dimension.kind === 'color' ? `<span class="pb-value-swatch" style="--swatch:${escapeHtml(value.hex || '#64748b')}"></span>` : `<span class="pb-value-icon"><i class="fas ${isPolicy ? 'fa-clock' : 'fa-layer-group'}"></i></span>`}<span class="pb-value-copy"><strong>${escapeHtml(value.label)}</strong><span class="pb-value-summary">${escapeHtml(summary)}</span></span></span>
                <i class="fas fa-chevron-down pb-value-chevron"></i>
              </summary>
              <div class="pb-value-editor${isPolicy ? ' pb-policy-editor' : ''}" data-pb-dimension-value="${valueIndex}">
                <div class="pb-field pb-value-name"><label>${(globalThis.PlatformLanguage?.htmlText("pricebook","m_8cf345002184e5","Name") ?? "Name")}</label><input data-pb-value-field="label" value="${escapeHtml(value.label)}" aria-label="${(globalThis.PlatformLanguage?.htmlText("pricebook","m_5891e83bec4041","Variant value") ?? "Variant value")}"></div>
                ${isPolicy ? `
                  <div class="pb-field pb-value-operation"><label>${(globalThis.PlatformLanguage?.htmlText("pricebook","m_e521f24b8e8450","Behavior") ?? "Behavior")}</label><select data-pb-value-field="policy_mode" aria-label="${(globalThis.PlatformLanguage?.htmlText("pricebook","m_268c68e00bc263","Policy mode") ?? "Policy mode")}">${[['fixed','Fixed price'],['conditional','Conditional'],['live','Live pricing']].map(([mode,label]) => `<option value="${mode}"${value.pricing_update_rule?.mode === mode ? ' selected' : ''}>${label}</option>`).join('')}</select></div>
                  <div class="pb-field pb-value-amount"><label>${(globalThis.PlatformLanguage?.htmlText("pricebook","m_fc695e7338eb0c","Valid for") ?? "Valid for")}</label><div class="pb-input-suffix"><input data-pb-value-field="policy_days" type="number" min="0" value="${Number(value.pricing_update_rule?.expires_after?.amount || 0) || ''}" placeholder="—" aria-label="${(globalThis.PlatformLanguage?.htmlText("pricebook","m_1ae2e36c490aad","Expiration days") ?? "Expiration days")}"><span>${(globalThis.PlatformLanguage?.htmlText("pricebook","m_d1521758bf5fc0","days") ?? "days")}</span></div></div>` : `
                  ${dimension.kind === 'color' ? `<div class="pb-field pb-value-color"><label>${(globalThis.PlatformLanguage?.htmlText("pricebook","m_db7002926d9977","Color") ?? "Color")}</label><label class="pb-color-picker" style="--swatch:${escapeHtml(value.hex || '#64748b')}" title="${(globalThis.PlatformLanguage?.htmlText("pricebook","m_d453ffba808085","Choose color") ?? "Choose color")}"><input type="color" data-pb-value-field="hex" value="${escapeHtml(value.hex || '#64748b')}" aria-label="${(globalThis.PlatformLanguage?.htmlText("pricebook","m_db7002926d9977","Color") ?? "Color")}"></label></div>` : '<span></span>'}
                  <div class="pb-field pb-value-image"><label>${(globalThis.PlatformLanguage?.htmlText("pricebook","m_54eb8e1b237591","Image") ?? "Image")}</label>${renderImageUpload(value.image, value.image_crop, 'data-pb-image-scope="value"')}</div>
                  <div class="pb-field pb-value-operation"><label>${(globalThis.PlatformLanguage?.htmlText("pricebook","m_2b4c8581905cea","Price adjustment") ?? "Price adjustment")}</label><select data-pb-value-field="operation" aria-label="${(globalThis.PlatformLanguage?.htmlText("pricebook","m_a5c134422e313c","Price operation") ?? "Price operation")}">${[['none','Use base price'],['add','Add amount'],['multiply','Multiply'],['divide','Divide'],['formula','Formula']].map(([operation,label]) => `<option value="${operation}"${value.adjustment?.operation === operation ? ' selected' : ''}>${label}</option>`).join('')}</select></div>
                  <div class="pb-field pb-value-amount"><label>${value.adjustment?.operation === 'formula' ? 'Formula' : 'Amount'}</label><input data-pb-value-field="adjustment_value" type="${value.adjustment?.operation === 'formula' ? 'text' : 'number'}" ${value.adjustment?.operation === 'formula' ? `value="${escapeHtml(value.adjustment?.formula || '')}" placeholder="base * 1.2"` : `step="0.01" value="${Number(value.adjustment?.value || 0)}"`} aria-label="${(globalThis.PlatformLanguage?.htmlText("pricebook","m_121e5e9145c2a4","Adjustment") ?? "Adjustment")}"></div>`}
                <button type="button" class="pb-text-danger pb-value-remove" data-pb-remove-value="${valueIndex}"${dimension.values.length <= 1 ? ' disabled' : ''} title="${(globalThis.PlatformLanguage?.htmlText("pricebook","m_f643f568915438","Remove") ?? "Remove")}" aria-label="${((v11) => globalThis.PlatformLanguage?.htmlText("pricebook","m_ac692197f53f04",`Remove ${v11}`,{v11}) ?? `Remove ${v11}`)(escapeHtml(value.label))}"><i class="fas fa-trash"></i></button>
              </div>
            </details>`;
          }).join(''))}
        </div>
        <div class="pb-dimension-actions">
          <button type="button" class="pb-secondary-button" data-pb-add-value="${String(dimensionIndex)}"><i class="fas fa-plus"></i>${((v8) => globalThis.PlatformLanguage?.htmlText("pricebook","m_6d1effb0629031",` Add ${v8}`,{v8}) ?? ` Add ${v8}`)(isPolicy ? 'behavior' : 'value')}</button>
          ${String(isPolicy ? `<button type="button" class="pb-tertiary-button" data-pb-save-policy-defaults="${dimensionIndex}">${(globalThis.PlatformLanguage?.htmlText("pricebook","m_4bb040d6eed43e","Use as organization defaults") ?? "Use as organization defaults")}</button>` : '')}
        </div>
      </section>`;
  }

  function renderVariantMatrix(item){
    const ui = variantUiFor(item);
    const dimensions = normalizeVariantDimensions(item.variantDimensions || item.variant_dimensions, item.optionDefinitions);
    const xDimension = dimensions.find((entry) => entry.id === ui.axisX) || dimensions[0];
    const yDimension = dimensions.find((entry) => entry.id === ui.axisY && entry.id !== xDimension?.id);
    const xValues = xDimension?.values?.length ? xDimension.values : [{ id:'base', label:(globalThis.PlatformLanguage?.text("pricebook","m_308419cd810563","Base") ?? "Base") }];
    const yValues = yDimension?.values?.length ? yDimension.values : [{ id:'__base', label:(globalThis.PlatformLanguage?.text("pricebook","m_308419cd810563","Base") ?? "Base") }];
    const otherDimensions = dimensions.filter((entry) => entry.id !== xDimension?.id && entry.id !== yDimension?.id);
    const activeVariant = resolveVariant(item, ui.selection);
    const combinationCount = dimensions.reduce((total, dimension) => total * Math.max(1, dimension.values.length), 1);
    return `
      ${String(renderVariantDetail(item, activeVariant))}
      <details class="pb-card pb-matrix-panel" data-pb-matrix-panel${String(ui.matrixOpen ? ' open' : '')}>
        <summary><span><strong>${(globalThis.PlatformLanguage?.htmlText("pricebook","m_0010932e963b6c","All combinations") ?? "All combinations")}</strong><small>${((v2) => globalThis.PlatformLanguage?.htmlText("pricebook","m_3c9367b65f29b2",`${v2} combinations · open for matrix and bulk editing`,{v2}) ?? `${v2} combinations · open for matrix and bulk editing`)(combinationCount)}</small></span><i class="fas fa-chevron-down"></i></summary>
        <div class="pb-matrix-panel-body">
          <div class="pb-matrix-header">
            <div class="pb-matrix-tools">
              <div class="pb-field"><label>${(globalThis.PlatformLanguage?.htmlText("pricebook","m_8abb9612e904f8","Columns") ?? "Columns")}</label><select data-pb-axis="x">${String(dimensions.map((dimension) => `<option value="${dimension.id}"${dimension.id === xDimension?.id ? ' selected' : ''}>${escapeHtml(dimension.label)}</option>`).join(''))}</select></div>
              <div class="pb-field"><label>${(globalThis.PlatformLanguage?.htmlText("pricebook","m_9fd01b24358153","Rows") ?? "Rows")}</label><select data-pb-axis="y"><option value="">${(globalThis.PlatformLanguage?.htmlText("pricebook","m_2d4ff8a83b1b5c","None") ?? "None")}</option>${String(dimensions.filter((dimension) => dimension.id !== xDimension?.id).map((dimension) => `<option value="${dimension.id}"${dimension.id === yDimension?.id ? ' selected' : ''}>${escapeHtml(dimension.label)}</option>`).join(''))}</select></div>
              <div class="pb-matrix-filters">${String(otherDimensions.map((dimension) => `<div class="pb-field"><label>${escapeHtml(dimension.label)}</label><select data-pb-variant-filter="${dimension.id}">${dimension.values.map((value) => `<option value="${value.id}"${ui.selection[dimension.id] === value.id ? ' selected' : ''}>${escapeHtml(value.label)}</option>`).join('')}</select></div>`).join(''))}</div>
            </div>
            <button type="button" class="pb-secondary-button${String(ui.bulkMode ? ' active' : '')}" data-pb-toggle-bulk><i class="fas fa-check-double"></i> ${String(ui.bulkMode ? 'Done selecting' : 'Select multiple')}</button>
          </div>
          <div class="pb-matrix-wrap" data-pb-matrix-scroll>
            <table class="pb-matrix"><thead><tr><th>${String(escapeHtml(yDimension?.label || ''))}</th>${String(xValues.map((value) => `<th>${escapeHtml(value.label)}</th>`).join(''))}</tr></thead><tbody>
              ${String(yValues.map((row) => `<tr><td>${escapeHtml(row.label)}</td>${xValues.map((column) => {
                const selection = { ...ui.selection, ...(xDimension ? { [xDimension.id]:column.id } : {}), ...(yDimension ? { [yDimension.id]:row.id } : {}) };
                const variant = resolveVariant(item, selection);
                const isSelected = ui.selectedKeys.has(variant.key);
                return `<td><button type="button" class="pb-matrix-cell${variant.key === activeVariant.key ? ' active' : ''}${isSelected ? ' selected' : ''}" data-pb-combination="${escapeHtml(variant.key)}" data-pb-selection="${escapeHtml(JSON.stringify(selection))}">${ui.bulkMode ? `<i class="fas ${isSelected ? 'fa-circle-check' : 'fa-circle'}"></i>` : ''}<strong>$${variant.unitPrice.toFixed(2)}</strong>${variant.override.unit_price != null || variant.override.unitPrice != null ? `<small>${((v0) => globalThis.PlatformLanguage?.htmlText("pricebook","m_30f7a1f6144a8b",`Override · $${v0} derived`,{v0}) ?? `Override · $${v0} derived`)(variant.computedPrice.toFixed(2))}</small>` : ''}</button></td>`;
              }).join('')}</tr>`).join(''))}
            </tbody></table>
          </div>
          ${String(ui.bulkMode ? `<div class="pb-bulk-bar"><span>${((v0) => globalThis.PlatformLanguage?.htmlText("pricebook","m_4b740d0b3ec319",`${v0} selected`,{v0}) ?? `${v0} selected`)(ui.selectedKeys.size)}</span><select data-pb-bulk-operation><option value="set">${(globalThis.PlatformLanguage?.htmlText("pricebook","m_f7d6b0ee8161ec","Set price") ?? "Set price")}</option><option value="add">${(globalThis.PlatformLanguage?.htmlText("pricebook","m_ab9800b8d9efcf","Add amount") ?? "Add amount")}</option><option value="multiply">${(globalThis.PlatformLanguage?.htmlText("pricebook","m_5ae7d1e0a7a5a7","Multiply") ?? "Multiply")}</option><option value="clear">${(globalThis.PlatformLanguage?.htmlText("pricebook","m_84ac5d6905b22c","Clear overrides") ?? "Clear overrides")}</option></select><input data-pb-bulk-value type="number" step="0.01" placeholder="${(globalThis.PlatformLanguage?.htmlText("pricebook","m_2b8c3448fa87a1","Amount") ?? "Amount")}"><button type="button" class="pb-primary-button" data-pb-apply-bulk>${(globalThis.PlatformLanguage?.htmlText("pricebook","m_9417f96a1856fa","Apply") ?? "Apply")}</button></div>` : '')}
        </div>
      </details>`;
  }

  function renderVariantDetail(item, variant){
    const hasPriceOverride = variant.override.unit_price != null || variant.override.unitPrice != null;
    const hasAnyOverride = Object.keys(objectValue(variant.override)).length > 0;
    const ui = variantUiFor(item);
    return `<div class="pb-card pb-variant-detail">
      <div class="pb-card-heading"><div><h3>${(globalThis.PlatformLanguage?.htmlText("pricebook","m_424bb936d6ddf4","Combination") ?? "Combination")}</h3><span>${(globalThis.PlatformLanguage?.htmlText("pricebook","m_e5708469c5e5e5","Preview and customize one variant") ?? "Preview and customize one variant")}</span></div><span class="pb-status-pill${String(hasAnyOverride ? ' override' : '')}">${String(hasAnyOverride ? 'Customized' : 'Inherited')}</span></div>
      <div class="pb-combination-picker">${String(variant.dimensions.map((dimension) => `<div class="pb-field"><label>${escapeHtml(dimension.label)}</label><select data-pb-combination-filter="${dimension.id}">${dimension.values.map((value) => `<option value="${value.id}"${variant.selection[dimension.id] === value.id ? ' selected' : ''}>${escapeHtml(value.label)}</option>`).join('')}</select></div>`).join(''))}</div>
      <div class="pb-price-summary">
        <div><span>${(globalThis.PlatformLanguage?.htmlText("pricebook","m_a6c1eb25d9952e","Sell price") ?? "Sell price")}</span><strong>$${String(variant.unitPrice.toFixed(2))}</strong>${String(hasPriceOverride ? `<small>${((v0) => globalThis.PlatformLanguage?.htmlText("pricebook","m_0c242b0aeb8983",`$${v0} calculated`,{v0}) ?? `$${v0} calculated`)(variant.computedPrice.toFixed(2))}</small>` : `<small>${(globalThis.PlatformLanguage?.htmlText("pricebook","m_e99357cd3f5464","Calculated") ?? "Calculated")}</small>`)}</div>
        <div><span>${(globalThis.PlatformLanguage?.htmlText("pricebook","m_4f60b799ec74c8","Internal cost") ?? "Internal cost")}</span><strong>$${String(variant.computedCost.toFixed(2))}</strong><small>${String(escapeHtml(item.unit))}</small></div>
        <div class="pb-sku-summary"><span>${(globalThis.PlatformLanguage?.htmlText("pricebook","m_2b79b6b3cc4e58","SKU") ?? "SKU")}</span><strong>${String(escapeHtml(variant.skuKey || item.id))}</strong></div>
      </div>
      <details class="pb-override-details" data-pb-override-details${String(ui.overrideOpen || hasAnyOverride ? ' open' : '')}>
        <summary><span><i class="fas fa-sliders"></i>${(globalThis.PlatformLanguage?.htmlText("pricebook","m_83ae1a63e741bb"," Customize this combination") ?? " Customize this combination")}</span><i class="fas fa-chevron-down"></i></summary>
        <div class="pb-override-body">
          <div class="pb-fields">
            <div class="pb-field"><label>${(globalThis.PlatformLanguage?.htmlText("pricebook","m_a6c1eb25d9952e","Sell price") ?? "Sell price")}</label><input data-pb-variant-override="unit_price" type="number" step="0.01" placeholder="${((v9) => globalThis.PlatformLanguage?.htmlText("pricebook","m_861b6b3f6f86e8",`$${v9} calculated`,{v9}) ?? `$${v9} calculated`)(variant.computedPrice.toFixed(2))}" value="${String(hasPriceOverride ? variant.unitPrice : '')}"></div>
            <div class="pb-field"><label>${(globalThis.PlatformLanguage?.htmlText("pricebook","m_4f60b799ec74c8","Internal cost") ?? "Internal cost")}</label><input data-pb-variant-override="internal_cost" type="number" step="0.01" placeholder="${((v11) => globalThis.PlatformLanguage?.htmlText("pricebook","m_7a080bab5baefb",`$${v11} calculated`,{v11}) ?? `$${v11} calculated`)(variant.computedCost.toFixed(2))}" value="${String(variant.override.internal_cost ?? '')}"></div>
            <div class="pb-field"><label>${(globalThis.PlatformLanguage?.htmlText("pricebook","m_7a0a25e4f3c53a","Unit type") ?? "Unit type")}</label><input data-pb-variant-override="unit" value="${String(escapeHtml(variant.override.unit || ''))}" placeholder="${String(escapeHtml(item.unit))}"></div>
            <div class="pb-field pb-override-image"><label>${(globalThis.PlatformLanguage?.htmlText("pricebook","m_54eb8e1b237591","Image") ?? "Image")}</label>${String(renderImageUpload(variant.override.image, variant.imageCrop, 'data-pb-image-scope="override"'))}</div>
            <div class="pb-field full"><label>${(globalThis.PlatformLanguage?.htmlText("pricebook","m_5e135f60489e3d","Customer description") ?? "Customer description")}</label><textarea data-pb-variant-override="external_description" placeholder="${(globalThis.PlatformLanguage?.htmlText("pricebook","m_f42dd4146911ec","Use base description") ?? "Use base description")}">${String(escapeHtml(variant.override.external_description || ''))}</textarea></div>
            <div class="pb-field full"><label>${(globalThis.PlatformLanguage?.htmlText("pricebook","m_2c00b4d4a808ce","Internal description") ?? "Internal description")}</label><textarea data-pb-variant-override="internal_description" placeholder="${(globalThis.PlatformLanguage?.htmlText("pricebook","m_018cdd14fe2bd5","Use base internal description") ?? "Use base internal description")}">${String(escapeHtml(variant.override.internal_description || ''))}</textarea></div>
            <div class="pb-field full"><label>${(globalThis.PlatformLanguage?.htmlText("pricebook","m_178f2690f8d672","Update rule") ?? "Update rule")}</label><textarea data-pb-update-formula placeholder="${(globalThis.PlatformLanguage?.htmlText("pricebook","m_2975b72b690b92","Optional condition") ?? "Optional condition")}">${String(escapeHtml(variant.pricingUpdateRule.formula || ''))}</textarea></div>
          </div>
          ${String(hasAnyOverride ? `<button type="button" class="pb-text-danger" data-pb-clear-variant><i class="fas fa-rotate-left"></i>${(globalThis.PlatformLanguage?.htmlText("pricebook","m_bfef4acac3e486"," Restore calculated values") ?? " Restore calculated values")}</button>` : '')}
        </div>
      </details>
    </div>`;
  }

  function renderVariationBuilder(item){
    const dimensions = normalizeVariantDimensions(item.variantDimensions || item.variant_dimensions, item.optionDefinitions);
    const ui = variantUiFor(item);
    const activeDimensionIndex = Math.max(0, dimensions.findIndex((dimension) => dimension.id === ui.activeDimensionId));
    const activeDimension = dimensions[activeDimensionIndex];
    return `<div class="pb-variant-layout">
      <div class="pb-card pb-dimensions-card">
        <div class="pb-dimension-tabs">${dimensions.map((dimension) => `<button type="button" class="pb-dimension-tab${dimension.id === activeDimension?.id ? ' active' : ''}" data-pb-open-dimension="${escapeHtml(dimension.id)}"><span class="pb-dimension-tab-icon"><i class="fas ${dimension.kind === 'color' ? 'fa-palette' : dimension.kind === 'pricing_policy' ? 'fa-clock' : 'fa-layer-group'}"></i></span><span><strong>${escapeHtml(dimension.label)}</strong><small>${dimension.values.length} ${dimension.values.length === 1 ? 'value' : 'values'}</small></span></button>`).join('')}</div>
        ${activeDimension ? renderDimensionEditor(item, activeDimension, activeDimensionIndex) : ''}
      </div>
      ${renderVariantMatrix(item)}
    </div>`;
  }

  function rememberVariantScroll(main, item){
    const ui = variantUiFor(item);
    const editorScroller = main.querySelector('.pb-editor-scroll');
    if (editorScroller) ui.editorScrollTop = editorScroller.scrollTop;
    const scroller = main.querySelector('[data-pb-matrix-scroll]');
    if (scroller) {
      ui.scrollLeft = scroller.scrollLeft;
      ui.scrollTop = scroller.scrollTop;
    }
  }

  function patchVariantDimensions(item, dimensions){
    const normalized = normalizeVariantDimensions(dimensions, []);
    patchItem(item.id, {
      variantDimensions:normalized,
      variant_dimensions:clone(normalized),
      defaultVariantSelection:normalizeVariantSelection(item.defaultVariantSelection, normalized),
      default_variant_selection:normalizeVariantSelection(item.defaultVariantSelection, normalized),
    });
  }

  function selectionFromCombinationKey(key){
    return cleanText(key).split('|').reduce((selection, part) => {
      const separator = part.indexOf('=');
      if (separator > 0) selection[part.slice(0, separator)] = part.slice(separator + 1);
      return selection;
    }, {});
  }

  function bindVariantEditor(main, item){
    main.querySelectorAll('[data-pb-dimension]').forEach((card) => {
      const dimensionIndex = Number(card.dataset.pbDimension);
      card.querySelectorAll('[data-pb-dimension-field]').forEach((control) => control.addEventListener('change', () => {
        const dimensions = clone(getItem(item.id)?.variantDimensions || []);
        const dimension = dimensions[dimensionIndex];
        if (!dimension) return;
        const field = control.dataset.pbDimensionField;
        dimension[field] = control.value;
        if (field === 'kind') dimension.affects_sku = control.value !== 'pricing_policy';
        patchVariantDimensions(item, dimensions);
      }));
      card.querySelector('[data-pb-toggle-dimension-sku]')?.addEventListener('click', () => {
        const dimensions = clone(getItem(item.id)?.variantDimensions || []);
        if (!dimensions[dimensionIndex]) return;
        dimensions[dimensionIndex].affects_sku = !dimensions[dimensionIndex].affects_sku;
        patchVariantDimensions(item, dimensions);
      });
      card.querySelectorAll('[data-pb-value-details]').forEach((details) => details.addEventListener('toggle', () => {
        const ui = variantUiFor(getItem(item.id));
        if (details.open) ui.expandedValues.add(details.dataset.pbValueDetails);
        else ui.expandedValues.delete(details.dataset.pbValueDetails);
      }));
      card.querySelectorAll('[data-pb-dimension-value]').forEach((row) => {
        const valueIndex = Number(row.dataset.pbDimensionValue);
        row.querySelectorAll('[data-pb-value-field]').forEach((control) => control.addEventListener('change', () => {
          const dimensions = clone(getItem(item.id)?.variantDimensions || []);
          const value = dimensions[dimensionIndex]?.values?.[valueIndex];
          if (!value) return;
          const field = control.dataset.pbValueField;
          if (field === 'label') {
            value.label = control.value;
            if (!value.id) value.id = slug(control.value, `value_${valueIndex + 1}`);
          } else if (field === 'hex') value.hex = control.value;
          else if (field === 'image') value.image = control.value;
          else if (field === 'operation') value.adjustment = { ...normalizeVariantAdjustment(value.adjustment), operation:control.value };
          else if (field === 'adjustment_value') value.adjustment = normalizeVariantAdjustment(value.adjustment).operation === 'formula'
            ? { ...normalizeVariantAdjustment(value.adjustment), formula:control.value }
            : { ...normalizeVariantAdjustment(value.adjustment), value:Number(control.value || 0) };
          else if (field === 'policy_mode') value.pricing_update_rule = { ...normalizePriceUpdateRule(value.pricing_update_rule), mode:control.value };
          else if (field === 'policy_days') value.pricing_update_rule = { ...normalizePriceUpdateRule(value.pricing_update_rule), expires_after:control.value ? { amount:Number(control.value), unit:'days' } : undefined };
          patchVariantDimensions(item, dimensions);
        }));
        const applyValueImage = async (source, crop, file = null) => {
          let storedSource = source;
          if (file) {
            try { storedSource = await persistPricebookImage(file, source); }
            catch (error) {
              console.warn('Unable to store price book image remotely; keeping the local image.', error);
              root.Portal?.ui?.showToast?.((globalThis.PlatformLanguage?.text("pricebook","m_7f665bbed3ce3c","Image saved locally") ?? "Image saved locally"), (globalThis.PlatformLanguage?.text("pricebook","m_bd5d131b9cd9d3","The organization asset service was unavailable.") ?? "The organization asset service was unavailable."), false);
            }
          }
          const dimensions = clone(getItem(item.id)?.variantDimensions || []);
          const value = dimensions[dimensionIndex]?.values?.[valueIndex];
          if (!value) return;
          value.image = storedSource;
          value.image_crop = normalizeImageCrop(crop);
          patchVariantDimensions(item, dimensions);
        };
        row.querySelector('[data-pb-image-input]')?.addEventListener('change', async (event) => {
          const file = event.target.files?.[0];
          if (!file) return;
          if (!String(file.type || '').startsWith('image/')) return root.Portal?.ui?.showToast?.((globalThis.PlatformLanguage?.text("pricebook","m_51cbbc64d8c99e","Choose an image file") ?? "Choose an image file"), '', false);
          if (file.size > 10 * 1024 * 1024) return root.Portal?.ui?.showToast?.((globalThis.PlatformLanguage?.text("pricebook","m_505c146137c800","Image is too large") ?? "Image is too large"), (globalThis.PlatformLanguage?.text("pricebook","m_75ad748d14cff0","Choose an image under 10 MB.") ?? "Choose an image under 10 MB."), false);
          try {
            const dataUrl = await readFileAsDataUrl(file);
            openImageCrop(dataUrl, null, (crop) => { void applyValueImage(dataUrl, crop, file); });
          } catch (error) {
            root.Portal?.ui?.showToast?.((globalThis.PlatformLanguage?.text("pricebook","m_66cae9018ee9fd","Unable to open image") ?? "Unable to open image"), (globalThis.PlatformLanguage?.text("pricebook","m_b7a7f8daf76c5d","Choose another file and try again.") ?? "Choose another file and try again."), false);
          }
        });
        row.querySelector('[data-pb-edit-crop]')?.addEventListener('click', (event) => {
          const currentValue = getItem(item.id)?.variantDimensions?.[dimensionIndex]?.values?.[valueIndex];
          const source = currentValue?.image || event.currentTarget.dataset.pbImageSrc;
          let crop = currentValue?.image_crop;
          if (!crop) { try { crop = JSON.parse(event.currentTarget.dataset.pbImageCrop || 'null'); } catch (error) {} }
          if (source) openImageCrop(source, crop, (nextCrop) => { void applyValueImage(source, nextCrop); });
        });
        row.querySelector('[data-pb-remove-value]')?.addEventListener('click', () => {
          const dimensions = clone(getItem(item.id)?.variantDimensions || []);
          if ((dimensions[dimensionIndex]?.values?.length || 0) <= 1) return;
          dimensions[dimensionIndex].values.splice(valueIndex, 1);
          patchVariantDimensions(item, dimensions);
        });
      });
    });
    main.querySelectorAll('[data-pb-open-dimension]').forEach((button) => button.addEventListener('click', () => {
      variantUiFor(getItem(item.id)).activeDimensionId = button.dataset.pbOpenDimension;
      render();
    }));
    main.querySelectorAll('[data-pb-add-value]').forEach((button) => button.addEventListener('click', () => {
      const dimensionIndex = Number(button.dataset.pbAddValue);
      const dimensions = clone(getItem(item.id)?.variantDimensions || []);
      const dimension = dimensions[dimensionIndex];
      if (!dimension) return;
      const index = dimension.values.length + 1;
      dimension.values.push(dimension.kind === 'pricing_policy'
        ? { id:`custom_policy_${index}`, label:((v0) => globalThis.PlatformLanguage?.text("pricebook","m_19a0e891882bec",`Custom behavior ${v0}`,{v0}) ?? `Custom behavior ${v0}`)(index), adjustment:normalizeVariantAdjustment(), pricing_update_rule:normalizePriceUpdateRule({ id:`custom_policy_${index}`, label:((v0) => globalThis.PlatformLanguage?.text("pricebook","m_19a0e891882bec",`Custom behavior ${v0}`,{v0}) ?? `Custom behavior ${v0}`)(index), mode:'conditional' }) }
        : { id:`value_${index}`, label:((v0) => globalThis.PlatformLanguage?.text("pricebook","m_19a001357d27c9",`Value ${v0}`,{v0}) ?? `Value ${v0}`)(index), hex:colorForValue(`value_${index}`, index), image:'', adjustment:normalizeVariantAdjustment() });
      patchVariantDimensions(item, dimensions);
    }));
    main.querySelector('[data-pb-save-policy-defaults]')?.addEventListener('click', (event) => {
      const index = Number(event.currentTarget.dataset.pbSavePolicyDefaults);
      const dimension = getItem(item.id)?.variantDimensions?.[index];
      if (!dimension || dimension.kind !== 'pricing_policy') return;
      state = normalizeState({
        ...state,
        settings:{ ...objectValue(state.settings), default_pricing_policies:dimension.values.map((value) => normalizePriceUpdateRule({ ...value.pricing_update_rule, id:value.id, label:value.label })) },
      });
      notify();
      root.Portal?.ui?.showToast?.((globalThis.PlatformLanguage?.text("pricebook","m_752929e8b8805b","Price behavior defaults saved") ?? "Price behavior defaults saved"), (globalThis.PlatformLanguage?.text("pricebook","m_1f30bb434b6b98","New price book items will start with these commercial variants.") ?? "New price book items will start with these commercial variants."), true);
    });
    main.querySelectorAll('[data-pb-remove-dimension]').forEach((button) => button.addEventListener('click', () => {
      const dimensions = clone(getItem(item.id)?.variantDimensions || []);
      const index = Number(button.dataset.pbRemoveDimension);
      if (dimensions[index]?.kind === 'pricing_policy') return;
      dimensions.splice(index, 1);
      patchVariantDimensions(item, dimensions);
    }));
    main.querySelector('[data-pb-add-dimension]')?.addEventListener('click', () => {
      const dimensions = clone(getItem(item.id)?.variantDimensions || []);
      const index = dimensions.length + 1;
      dimensions.splice(Math.max(0, dimensions.length - 1), 0, { id:`dimension_${index}`, label:((v0) => globalThis.PlatformLanguage?.text("pricebook","m_d2e5c90ba79995",`Dimension ${v0}`,{v0}) ?? `Dimension ${v0}`)(index), kind:'option', affects_sku:true, values:[{ id:'standard', label:(globalThis.PlatformLanguage?.text("pricebook","m_00f3e8b60aebc9","Standard") ?? "Standard"), image:'', adjustment:normalizeVariantAdjustment() }] });
      patchVariantDimensions(item, dimensions);
    });
    main.querySelectorAll('[data-pb-axis]').forEach((select) => select.addEventListener('change', () => {
      rememberVariantScroll(main, item);
      const ui = variantUiFor(item);
      if (select.dataset.pbAxis === 'x') ui.axisX = select.value;
      else ui.axisY = select.value;
      render();
    }));
    main.querySelectorAll('[data-pb-variant-filter]').forEach((select) => select.addEventListener('change', () => {
      rememberVariantScroll(main, item);
      const ui = variantUiFor(item);
      ui.selection[select.dataset.pbVariantFilter] = select.value;
      render();
    }));
    main.querySelectorAll('[data-pb-combination-filter]').forEach((select) => select.addEventListener('change', () => {
      const current = getItem(item.id);
      const ui = variantUiFor(current);
      ui.selection[select.dataset.pbCombinationFilter] = select.value;
      render();
    }));
    main.querySelector('[data-pb-matrix-panel]')?.addEventListener('toggle', (event) => {
      variantUiFor(getItem(item.id)).matrixOpen = event.currentTarget.open;
    });
    main.querySelector('[data-pb-override-details]')?.addEventListener('toggle', (event) => {
      variantUiFor(getItem(item.id)).overrideOpen = event.currentTarget.open;
    });
    main.querySelector('[data-pb-toggle-bulk]')?.addEventListener('click', () => {
      const ui = variantUiFor(getItem(item.id));
      ui.bulkMode = !ui.bulkMode;
      if (!ui.bulkMode) ui.selectedKeys.clear();
      render();
    });
    main.querySelectorAll('[data-pb-combination]').forEach((button) => button.addEventListener('click', (event) => {
      event.preventDefault();
      rememberVariantScroll(main, item);
      const current = getItem(item.id);
      const ui = variantUiFor(current);
      if (ui.bulkMode) {
        if (ui.selectedKeys.has(button.dataset.pbCombination)) ui.selectedKeys.delete(button.dataset.pbCombination);
        else ui.selectedKeys.add(button.dataset.pbCombination);
      } else {
        try { ui.selection = normalizeVariantSelection(JSON.parse(button.dataset.pbSelection || '{}'), current.variantDimensions); } catch (error) {}
      }
      render();
    }));
    main.querySelectorAll('[data-pb-variant-override]').forEach((control) => control.addEventListener('change', () => {
      const current = getItem(item.id);
      const variant = resolveVariant(current, variantUiFor(current).selection);
      const overrides = clone(current.variantOverrides || {});
      const next = { ...objectValue(overrides[variant.key]) };
      const field = control.dataset.pbVariantOverride;
      if (control.value === '') delete next[field];
      else next[field] = ['unit_price','internal_cost'].includes(field) ? Number(control.value) : control.value;
      if (Object.keys(next).length) overrides[variant.key] = next;
      else delete overrides[variant.key];
      patchItem(item.id, { variantOverrides:overrides, variant_overrides:clone(overrides) });
    }));
    const applyOverrideImage = async (source, crop, file = null) => {
      let storedSource = source;
      if (file) {
        try { storedSource = await persistPricebookImage(file, source); }
        catch (error) {
          console.warn('Unable to store price book image remotely; keeping the local image.', error);
          root.Portal?.ui?.showToast?.((globalThis.PlatformLanguage?.text("pricebook","m_7f665bbed3ce3c","Image saved locally") ?? "Image saved locally"), (globalThis.PlatformLanguage?.text("pricebook","m_bd5d131b9cd9d3","The organization asset service was unavailable.") ?? "The organization asset service was unavailable."), false);
        }
      }
      const current = getItem(item.id);
      const variant = resolveVariant(current, variantUiFor(current).selection);
      const overrides = clone(current.variantOverrides || {});
      overrides[variant.key] = { ...objectValue(overrides[variant.key]), image:storedSource, image_crop:normalizeImageCrop(crop) };
      patchItem(item.id, { variantOverrides:overrides, variant_overrides:clone(overrides) });
    };
    main.querySelector('[data-pb-image-scope="override"][data-pb-image-input]')?.addEventListener('change', async (event) => {
      const file = event.target.files?.[0];
      if (!file) return;
      if (!String(file.type || '').startsWith('image/')) return root.Portal?.ui?.showToast?.((globalThis.PlatformLanguage?.text("pricebook","m_51cbbc64d8c99e","Choose an image file") ?? "Choose an image file"), '', false);
      if (file.size > 10 * 1024 * 1024) return root.Portal?.ui?.showToast?.((globalThis.PlatformLanguage?.text("pricebook","m_505c146137c800","Image is too large") ?? "Image is too large"), (globalThis.PlatformLanguage?.text("pricebook","m_75ad748d14cff0","Choose an image under 10 MB.") ?? "Choose an image under 10 MB."), false);
      try {
        const dataUrl = await readFileAsDataUrl(file);
        openImageCrop(dataUrl, null, (crop) => { void applyOverrideImage(dataUrl, crop, file); });
      } catch (error) {
        root.Portal?.ui?.showToast?.((globalThis.PlatformLanguage?.text("pricebook","m_66cae9018ee9fd","Unable to open image") ?? "Unable to open image"), (globalThis.PlatformLanguage?.text("pricebook","m_b7a7f8daf76c5d","Choose another file and try again.") ?? "Choose another file and try again."), false);
      }
    });
    main.querySelector('[data-pb-image-scope="override"][data-pb-edit-crop]')?.addEventListener('click', (event) => {
      const current = getItem(item.id);
      const variant = resolveVariant(current, variantUiFor(current).selection);
      const source = variant.override.image || event.currentTarget.dataset.pbImageSrc;
      if (source) openImageCrop(source, variant.imageCrop, (crop) => { void applyOverrideImage(source, crop); });
    });
    main.querySelector('[data-pb-update-formula]')?.addEventListener('change', (event) => {
      const current = getItem(item.id);
      const variant = resolveVariant(current, variantUiFor(current).selection);
      const overrides = clone(current.variantOverrides || {});
      const next = { ...objectValue(overrides[variant.key]) };
      next.pricing_update_rule = { ...variant.pricingUpdateRule, mode:event.target.value ? 'conditional' : variant.pricingUpdateRule.mode, formula:event.target.value };
      overrides[variant.key] = next;
      patchItem(item.id, { variantOverrides:overrides, variant_overrides:clone(overrides) });
    });
    main.querySelector('[data-pb-clear-variant]')?.addEventListener('click', () => {
      const current = getItem(item.id);
      const key = resolveVariant(current, variantUiFor(current).selection).key;
      const overrides = clone(current.variantOverrides || {});
      delete overrides[key];
      patchItem(item.id, { variantOverrides:overrides, variant_overrides:clone(overrides) });
    });
    main.querySelector('[data-pb-apply-bulk]')?.addEventListener('click', () => {
      const current = getItem(item.id);
      const ui = variantUiFor(current);
      const operation = main.querySelector('[data-pb-bulk-operation]')?.value || 'set';
      const amount = Number(main.querySelector('[data-pb-bulk-value]')?.value || 0);
      const overrides = clone(current.variantOverrides || {});
      ui.selectedKeys.forEach((key) => {
        if (operation === 'clear') return delete overrides[key];
        const variant = resolveVariant(current, selectionFromCombinationKey(key));
        const unitPrice = operation === 'add' ? variant.unitPrice + amount : operation === 'multiply' ? variant.unitPrice * amount : amount;
        overrides[key] = { ...objectValue(overrides[key]), unit_price:Number(unitPrice.toFixed(2)) };
      });
      patchItem(item.id, { variantOverrides:overrides, variant_overrides:clone(overrides) });
    });
  }

  function orderPackagingExample(item){
    const packaging = normalizeOrderPackaging(item.orderPackaging || item.order_packaging);
    const sample = item.unit === 'sq' ? 20 : item.unit === 'lf' ? 100 : 10;
    const info = computeOrderQuantity(packaging, sample);
    if (!info) return 'Set an order unit and a conversion to enable rounded ordering quantities.';
    const covered = info.covered_quantity !== sample ? ` (covers ${info.covered_quantity} ${displayUnit(item.unit)})` : '';
    return `Example: ${sample} ${displayUnit(item.unit)} orders as ${info.order_quantity} ${info.order_unit}${covered}.`;
  }

  function renderOrderingBuilder(item){
    const packaging = normalizeOrderPackaging(item.orderPackaging || item.order_packaging) || { order_unit: '', order_unit_plural: '', units_per_package: 0, packages_per_unit: 0, description: '' };
    const unitLabel = displayUnit(item.unit);
    return `
      <div class="pb-card">
        <h3>${(globalThis.PlatformLanguage?.htmlText("pricebook","m_932757e3f980c3","Ordering") ?? "Ordering")}</h3>
        <p>${(globalThis.PlatformLanguage?.htmlText("pricebook","m_64deeca555fbd1","Optional. Describe how this material is actually purchased (pieces, bundles, rolls). Material orders round up to whole order units.") ?? "Optional. Describe how this material is actually purchased (pieces, bundles, rolls). Material orders round up to whole order units.")}</p>
        <div class="pb-fields">
          <div class="pb-field"><label>${(globalThis.PlatformLanguage?.htmlText("pricebook","m_306d9c8f8dfb6d","Order Unit") ?? "Order Unit")}</label><input id="pbOrderUnit" value="${String(escapeHtml(packaging.order_unit))}" placeholder="${(globalThis.PlatformLanguage?.htmlText("pricebook","m_0f1ae000a1c9c5","piece, bundle, roll") ?? "piece, bundle, roll")}"></div>
          <div class="pb-field"><label>${(globalThis.PlatformLanguage?.htmlText("pricebook","m_59fbf2333d5fd8","Plural") ?? "Plural")}</label><input id="pbOrderUnitPlural" value="${String(escapeHtml(packaging.order_unit_plural))}" placeholder="${(globalThis.PlatformLanguage?.htmlText("pricebook","m_f8e2b4fdf26e4b","pieces, bundles, rolls") ?? "pieces, bundles, rolls")}"></div>
          <div class="pb-field"><label>${((v2) => globalThis.PlatformLanguage?.htmlText("pricebook","m_e2067739f20364",`${v2} per Order Unit`,{v2}) ?? `${v2} per Order Unit`)(escapeHtml(unitLabel))}</label><input id="pbUnitsPerPackage" type="number" step="0.01" min="0" value="${String(packaging.units_per_package || '')}" placeholder="${(globalThis.PlatformLanguage?.htmlText("pricebook","m_6a6f65bffead7e","e.g. 10 ft per piece") ?? "e.g. 10 ft per piece")}"></div>
          <div class="pb-field"><label>${((v4) => globalThis.PlatformLanguage?.htmlText("pricebook","m_8f8fd09009cb7b",`Order Units per ${v4}`,{v4}) ?? `Order Units per ${v4}`)(escapeHtml(unitLabel))}</label><input id="pbPackagesPerUnit" type="number" step="0.01" min="0" value="${String(packaging.packages_per_unit || '')}" placeholder="${(globalThis.PlatformLanguage?.htmlText("pricebook","m_9ab4ecf95176e5","e.g. 3 bundles per square") ?? "e.g. 3 bundles per square")}"></div>
          <div class="pb-field full"><label>${(globalThis.PlatformLanguage?.htmlText("pricebook","m_bfe2eb80e8dd93","Package Description") ?? "Package Description")}</label><input id="pbOrderDescription" value="${String(escapeHtml(packaging.description))}" placeholder="${(globalThis.PlatformLanguage?.htmlText("pricebook","m_962876a228fdcc","e.g. 10 ft piece, 2-square roll") ?? "e.g. 10 ft piece, 2-square roll")}"></div>
        </div>
        <div class="pb-preview-row"><strong>${(globalThis.PlatformLanguage?.htmlText("pricebook","m_8b3fbf31009c10","Order rounding") ?? "Order rounding")}</strong><span id="pbOrderExample">${String(escapeHtml(orderPackagingExample(item)))}</span></div>
      </div>
    `;
  }

  function renderFormulaBuilder(item){
    const formulaConfig = inferFormulaConfig(item);
    return `
      <div class="pb-formula-builder">
        <div class="pb-formula-summary">
          <strong>${(globalThis.PlatformLanguage?.htmlText("pricebook","m_f10e6b2e02d839","Formula") ?? "Formula")}</strong>
          <div class="pb-formula-human">$${String(Number(item.unitPrice || 0).toFixed(2))} x (${String(escapeHtml(formulaToHumanText(formulaConfig)))})</div>
          <label class="pb-waste-toggle">
            <input type="checkbox" id="pbIncludeWaste"${String(formulaConfig.includeWaste ? ' checked' : '')}>
            <span class="pb-waste-pill"></span>${(globalThis.PlatformLanguage?.htmlText("pricebook","m_ac64f3ef9d48b8","\n            Waste\n          ") ?? "\n            Waste\n          ")}</label>
        </div>
        <div class="pb-formula-row">
          ${String(formulaConfig.tokens.map((token, index) => {
            if (token.type === 'measurement') {
              return `
                <div class="pb-token measurement" data-token-index="${index}">
                  <select data-token-field="value">
                    ${MEASUREMENT_FIELDS.map((field) => `<option value="${field.key}"${field.key === token.value ? ' selected' : ''}>${escapeHtml(field.label)}</option>`).join('')}
                  </select>
                  <button type="button" class="pb-token-remove" data-token-remove="${index}"><i class="fas fa-times"></i></button>
                </div>
              `;
            }
            if (token.type === 'custom_field') {
              const customFields = customFormulaFields();
              return `
                <div class="pb-token measurement" data-token-index="${index}">
                  <select data-token-field="value">
                    ${customFields.length ? customFields.map((field) => `<option value="${field.key}"${field.key === token.value ? ' selected' : ''}>${escapeHtml(field.label)}</option>`).join('') : `<option value="${escapeHtml(token.value)}" selected>${escapeHtml(getMeasurementLabel(token.value))}</option>`}
                  </select>
                  <button type="button" class="pb-token-remove" data-token-remove="${index}"><i class="fas fa-times"></i></button>
                </div>
              `;
            }
            if (token.type === 'operator') {
              return `
                <div class="pb-token operator" data-token-index="${index}">
                  <select data-token-field="value">
                    ${OPERATOR_OPTIONS.map((option) => `<option value="${option}"${option === token.value ? ' selected' : ''}>${escapeHtml(option === '*' ? 'x' : option === '/' ? '/' : option)}</option>`).join('')}
                  </select>
                  <button type="button" class="pb-token-remove" data-token-remove="${index}"><i class="fas fa-times"></i></button>
                </div>
              `;
            }
            if (token.type === 'paren') {
              return `
                <div class="pb-token paren" data-token-index="${index}">
                  <select data-token-field="value">
                    ${PAREN_OPTIONS.map((option) => `<option value="${option}"${option === token.value ? ' selected' : ''}>${escapeHtml(option)}</option>`).join('')}
                  </select>
                  <button type="button" class="pb-token-remove" data-token-remove="${index}"><i class="fas fa-times"></i></button>
                </div>
              `;
            }
            return `
              <div class="pb-token number" data-token-index="${index}">
                <input type="number" step="0.01" value="${escapeHtml(token.value || '')}" data-token-field="value" placeholder="0">
                <button type="button" class="pb-token-remove" data-token-remove="${index}"><i class="fas fa-times"></i></button>
              </div>
            `;
          }).join(''))}
        </div>
        <div class="pb-formula-actions">
          <button type="button" class="pb-formula-add" data-token-add="measurement"><i class="fas fa-ruler-combined"></i>${(globalThis.PlatformLanguage?.htmlText("pricebook","m_af8e2a40a73f3a"," Measurement") ?? " Measurement")}</button>
          <button type="button" class="pb-formula-add" data-token-add="custom_field"${String(customFormulaFields().length ? '' : ' disabled')}><i class="fas fa-table-list"></i>${(globalThis.PlatformLanguage?.htmlText("pricebook","m_d9519ff7bc9252"," Custom Field") ?? " Custom Field")}</button>
          <button type="button" class="pb-formula-add" data-token-add="operator"><i class="fas fa-plus-minus"></i>${(globalThis.PlatformLanguage?.htmlText("pricebook","m_6fcdf04d427e1e"," Symbol") ?? " Symbol")}</button>
          <button type="button" class="pb-formula-add" data-token-add="number"><i class="fas fa-hashtag"></i>${(globalThis.PlatformLanguage?.htmlText("pricebook","m_35eb6989f6e97d"," Number") ?? " Number")}</button>
          <button type="button" class="pb-formula-add" data-token-add="paren"><i class="fas fa-parentheses"></i> ( )</button>
        </div>
      </div>
    `;
  }

  function renderSummaryEditor(item){
    const global = objectValue(item.globalMarketSnapshot || item.global_market_snapshot);
    const globalPrice = Number(global.unit_price ?? global.unitPrice ?? global.base_price ?? 0);
    const overrideCount = Object.keys(objectValue(item.globalOverrides || item.global_overrides)).length;
    const layerMode = item.globalLinkMode || 'local';
    const types = [...new Set(state.items.map((entry) => cleanText(entry.type || entry.itemTypeName)).filter(Boolean).concat(cleanText(item.type)).filter(Boolean))].sort((a, b) => a.localeCompare(b));
    const manufacturerLabel = (value) => BRAND_OPTIONS.find((option) => option.value === value)?.label || titleFromKey(value);
    const manufacturers = [...new Set(state.items.map((entry) => cleanText(entry.manufacturer)).filter(Boolean).concat(cleanText(item.manufacturer)).filter(Boolean))].sort((a, b) => manufacturerLabel(a).localeCompare(manufacturerLabel(b)));
    const units = [...new Set(UNIT_OPTIONS.map((option) => option.value).concat(state.items.map((entry) => cleanText(entry.unit))).concat(cleanText(item.unit)).filter(Boolean))];
    const typeOptions = types.map((value) => `<option value="${escapeHtml(value)}"${value === item.type ? ' selected' : ''}>${escapeHtml(titleFromKey(value))}</option>`).join('');
    const manufacturerOptions = manufacturers.map((value) => `<option value="${escapeHtml(value)}"${value === item.manufacturer ? ' selected' : ''}>${escapeHtml(manufacturerLabel(value))}</option>`).join('');
    const unitOptions = units.map((value) => `<option value="${escapeHtml(value)}"${value === item.unit ? ' selected' : ''}>${escapeHtml(UNIT_OPTIONS.find((option) => option.value === value)?.label || titleFromKey(value))}</option>`).join('');
    const globalSummary = layerMode === 'live'
      ? `Linked to FirstMate · ${overrideCount} organization override${overrideCount === 1 ? '' : 's'}`
      : layerMode === 'snapshot' ? 'FirstMate reference frozen at a saved revision' : 'Organization-only item';
    return `
      <div class="pb-card pb-summary-card">
        <div class="pb-fields">
          <div class="pb-field"><label>${(globalThis.PlatformLanguage?.htmlText("pricebook","m_8cf345002184e5","Name") ?? "Name")}</label><input id="pbName" value="${String(escapeHtml(item.name))}"></div>
          <div class="pb-field"><label>${(globalThis.PlatformLanguage?.htmlText("pricebook","m_2e88df13ca7101","Type") ?? "Type")}</label><div class="pb-select-with-add"><select id="pbType">${String(typeOptions)}</select><button type="button" class="pb-select-add" id="pbAddType" title="${(globalThis.PlatformLanguage?.htmlText("pricebook","m_9015ee6e65cb45","Add type") ?? "Add type")}" aria-label="${(globalThis.PlatformLanguage?.htmlText("pricebook","m_9015ee6e65cb45","Add type") ?? "Add type")}"><i class="fas fa-plus"></i></button></div></div>
          <div class="pb-field"><label>${(globalThis.PlatformLanguage?.htmlText("pricebook","m_d9f2c1e468ae43","Manufacturer") ?? "Manufacturer")}</label><div class="pb-select-with-add"><select id="pbManufacturer"><option value=""${String(item.manufacturer ? '' : ' selected')}>${(globalThis.PlatformLanguage?.htmlText("pricebook","m_2d4ff8a83b1b5c","None") ?? "None")}</option>${String(manufacturerOptions)}</select><button type="button" class="pb-select-add" id="pbAddManufacturer" title="${(globalThis.PlatformLanguage?.htmlText("pricebook","m_8c1ba47ec95f93","Add manufacturer") ?? "Add manufacturer")}" aria-label="${(globalThis.PlatformLanguage?.htmlText("pricebook","m_8c1ba47ec95f93","Add manufacturer") ?? "Add manufacturer")}"><i class="fas fa-plus"></i></button></div></div>
        </div>
        <div class="pb-summary-section">
          <h3>${(globalThis.PlatformLanguage?.htmlText("pricebook","m_ab0d24d9f5de5f","Base variant") ?? "Base variant")}</h3>
          <div class="pb-fields">
            <div class="pb-field"><label>${(globalThis.PlatformLanguage?.htmlText("pricebook","m_139b3692195c64","Base price") ?? "Base price")}</label><input id="pbUnitPrice" type="number" step="0.01" min="0" value="${String(Number(item.unitPrice || 0))}"></div>
            <div class="pb-field"><label>${(globalThis.PlatformLanguage?.htmlText("pricebook","m_5829f266947b88","Base cost") ?? "Base cost")}</label><input id="pbInternalCost" type="number" step="0.01" min="0" value="${String(Number(item.internalCost || 0))}"></div>
            <div class="pb-field"><label>${(globalThis.PlatformLanguage?.htmlText("pricebook","m_d58ba148334f31","Base unit type") ?? "Base unit type")}</label><div class="pb-select-with-add"><select id="pbUnit">${String(unitOptions)}</select><button type="button" class="pb-select-add" id="pbAddUnit" title="${(globalThis.PlatformLanguage?.htmlText("pricebook","m_ad42d595d416ff","Add unit type") ?? "Add unit type")}" aria-label="${(globalThis.PlatformLanguage?.htmlText("pricebook","m_ad42d595d416ff","Add unit type") ?? "Add unit type")}"><i class="fas fa-plus"></i></button></div></div>
            <div class="pb-field full"><label>${(globalThis.PlatformLanguage?.htmlText("pricebook","m_5e135f60489e3d","Customer description") ?? "Customer description")}</label><textarea id="pbExternalDescription">${String(escapeHtml(item.externalDescription || ''))}</textarea></div>
            <div class="pb-field full"><label>${(globalThis.PlatformLanguage?.htmlText("pricebook","m_2c00b4d4a808ce","Internal description") ?? "Internal description")}</label><textarea id="pbInternalDescription">${String(escapeHtml(item.internalDescription || ''))}</textarea></div>
          </div>
        </div>
        <details class="pb-global-details">
          <summary><span><strong>${(globalThis.PlatformLanguage?.htmlText("pricebook","m_f691c6f3ec1d1c","FirstMate global catalog") ?? "FirstMate global catalog")}</strong><small>${String(escapeHtml(globalSummary))}</small></span><i class="fas fa-chevron-down"></i></summary>
          <div class="pb-global-details-body">
            <div class="pb-layer-card">
              <div><strong>${String(layerMode === 'live' ? 'Following FirstMate updates' : layerMode === 'snapshot' ? 'Using a frozen FirstMate reference' : 'No FirstMate catalog link')}</strong><span>${String(layerMode === 'live' ? 'Fields without organization overrides update with the FirstMate catalog.' : layerMode === 'snapshot' ? 'FirstMate changes will not flow into this item while its reference is frozen.' : 'This item was created specifically for this organization.')}</span></div>
              ${String(layerMode !== 'local' ? `<select id="pbGlobalLinkMode"><option value="live"${layerMode === 'live' ? ' selected' : ''}>${(globalThis.PlatformLanguage?.htmlText("pricebook","m_2ab2275eebff83","Follow updates") ?? "Follow updates")}</option><option value="snapshot"${layerMode === 'snapshot' ? ' selected' : ''}>${(globalThis.PlatformLanguage?.htmlText("pricebook","m_e6201ff1d8fc60","Freeze reference") ?? "Freeze reference")}</option></select>` : '')}
            </div>
            ${String(Object.keys(global).length ? `<div class="pb-price-compare"><div class="pb-price-stat"><span>${(globalThis.PlatformLanguage?.htmlText("pricebook","m_5c4fb8df281140","FirstMate") ?? "FirstMate")}</span><strong>$${globalPrice.toFixed(2)}</strong></div><div class="pb-price-stat"><span>${(globalThis.PlatformLanguage?.htmlText("pricebook","m_84b7f792c9d048","Organization") ?? "Organization")}</span><strong>$${Number(item.unitPrice || 0).toFixed(2)}</strong></div><div class="pb-price-stat"><span>${(globalThis.PlatformLanguage?.htmlText("pricebook","m_a66599d9c29a1c","Difference") ?? "Difference")}</span><strong>${Number(item.unitPrice || 0) - globalPrice >= 0 ? '+' : '-'}$${Math.abs(Number(item.unitPrice || 0) - globalPrice).toFixed(2)}</strong></div></div>` : '')}
          </div>
        </details>
        <div class="pb-summary-footer"><button type="button" class="pb-delete" id="pbDelete"${String(state.items.length <= 1 ? ' disabled' : '')}>${(globalThis.PlatformLanguage?.htmlText("pricebook","m_aaf8dbee05f91a","Delete item") ?? "Delete item")}</button></div>
      </div>`;
  }

  function render(){
    const rootEl = activeRoot || document.getElementById('pbOverlay');
    if (!rootEl) return;
    const list = rootEl.querySelector('#pbList');
    const main = rootEl.querySelector('#pbMain');
    const search = rootEl.querySelector('#pbSearch')?.value || '';
    if (!list || !main) return;
    const visibleTree = getVisibleTree(search);
    const visibleItems = visibleTree.flatMap((category) => category.items);
    const usedItemIds = activeUsedItemIds();
    const usedCategories = activeUsedCategories();
    const usedSubfilters = activeUsedSubfilters();
    if (!activeItemId && visibleItems[0]) activeItemId = visibleItems[0].id;
    if (activeItemId && !state.items.some((item) => item.id === activeItemId)) activeItemId = state.items[0]?.id || null;
    const activeItem = getItem(activeItemId);

    list.innerHTML = visibleTree.map((category) => {
      const filterOptions = getCategoryFilterOptions(category.value);
      const filters = categoryFilters[category.value] || ['all'];
      return `
        <section class="pb-cat${String(expandedCategories[category.value] !== false ? ' open' : '')}" data-pb-cat="${String(escapeHtml(category.value))}">
          <button type="button" class="pb-cat-head" data-pb-cat-toggle="${String(escapeHtml(category.value))}">
            <strong>${String(escapeHtml(category.label))}</strong>
            <div class="pb-cat-meta">
              ${String(usedCategories.has(category.value) ? '<span class="pb-cat-star">*</span>' : '')}
              <span class="pb-cat-count">${String(category.items.length)}</span>
              <i class="fas fa-chevron-down pb-cat-angle"></i>
            </div>
          </button>
          <div class="pb-cat-body"${String(expandedCategories[category.value] === false ? ' style="display:none"' : '')}>
            ${String(filterOptions.length ? `
              <div class="pb-filter-row">
                ${filterOptions.map((option) => `
                  <button type="button" class="pb-filter${filters.includes(option.value) ? ' active' : ''}${option.value === 'all' || option.value === 'generic' ? ' is-meta' : ''}" data-pb-filter-cat="${escapeHtml(category.value)}" data-pb-filter="${escapeHtml(option.value)}">
                    <span class="pb-filter-logo">${escapeHtml(getFilterChipLabel(option))}${filterHasUsedItems(category.value, option.value, usedSubfilters) ? ' *' : ''}</span>
                  </button>
                `).join('')}
              </div>
            ` : '')}
            <div class="pb-tree">
              ${String(category.items.map((item) => `
                <button type="button" class="pb-item${item.id === activeItemId ? ' active' : ''}${usedItemIds.has(item.id) ? ' in-use' : ''}" data-pb-item="${escapeHtml(item.id)}">
                  <div class="pb-item-main">
                    <strong>${escapeHtml(item.name)}</strong>
                    <span>${escapeHtml(formatSidebarMeta(item))}</span>
                  </div>
                  <span class="pb-item-price">$${Number(item.unitPrice || 0).toFixed(2)}</span>
                </button>
              `).join('') || `<div class="pb-item-empty">${(globalThis.PlatformLanguage?.htmlText("pricebook","m_967cca6a8dadc5","No matching items") ?? "No matching items")}</div>`)}
              <button type="button" class="pb-cat-add" data-pb-add-cat="${String(escapeHtml(category.value))}"><i class="fas fa-plus"></i>${(globalThis.PlatformLanguage?.htmlText("pricebook","m_3ba3d8155c75f9"," New Item") ?? " New Item")}</button>
            </div>
          </div>
        </section>
      `;
    }).join('');
    list.querySelectorAll('[data-pb-cat-toggle]').forEach((btn) => {
      btn.addEventListener('click', () => {
        const category = btn.dataset.pbCatToggle;
        expandedCategories = { ...expandedCategories, [category]: expandedCategories[category] === false };
        render();
      });
    });
    list.querySelectorAll('[data-pb-filter-cat]').forEach((btn) => {
      btn.addEventListener('click', () => {
        toggleCategoryFilter(btn.dataset.pbFilterCat, btn.dataset.pbFilter);
        render();
      });
    });
    list.querySelectorAll('[data-pb-add-cat]').forEach((btn) => {
      btn.addEventListener('click', () => {
        const item = createItemForCategory(btn.dataset.pbAddCat);
        state.items = [...state.items, item];
        activeItemId = item.id;
        expandedCategories = { ...expandedCategories, [btn.dataset.pbAddCat]: true };
        notify();
        render();
      });
    });
    list.querySelectorAll('[data-pb-item]').forEach((btn) => {
      btn.addEventListener('click', () => {
        activeItemId = btn.dataset.pbItem;
        render();
      });
    });

    if (!activeItem) {
      main.innerHTML = `<div class="pb-card"><h3>${(globalThis.PlatformLanguage?.htmlText("pricebook","m_65b68c594dbb10","No items yet") ?? "No items yet")}</h3><p>${(globalThis.PlatformLanguage?.htmlText("pricebook","m_215424428557c7","Create a pricebook item to get started.") ?? "Create a pricebook item to get started.")}</p></div>`;
      return;
    }

    main.innerHTML = `<div class="pb-editor-surface">
      <div class="pb-editor-header">
        <div class="pb-item-tabs"><button type="button" class="pb-item-tab${String(activeEditorTab === 'summary' ? ' active' : '')}" data-pb-item-tab="summary">${(globalThis.PlatformLanguage?.htmlText("pricebook","m_9b03ccb29ba168","Summary") ?? "Summary")}</button><button type="button" class="pb-item-tab${String(activeEditorTab === 'variants' ? ' active' : '')}" data-pb-item-tab="variants">${(globalThis.PlatformLanguage?.htmlText("pricebook","m_70282f7c0969c2","Variants") ?? "Variants")}</button></div>
        ${String(activeEditorTab === 'variants' ? `<div class="pb-editor-header-actions"><button type="button" class="pb-secondary-button" data-pb-add-dimension><i class="fas fa-plus"></i>${(globalThis.PlatformLanguage?.htmlText("pricebook","m_8803dece55359d"," Add") ?? " Add")}</button></div>` : '')}
      </div>
      <div class="pb-editor-scroll">${String(activeEditorTab === 'variants' ? renderVariationBuilder(activeItem) : renderSummaryEditor(activeItem))}</div>
    </div>`;

    main.querySelectorAll('[data-pb-item-tab]').forEach((button) => button.addEventListener('click', () => {
      if (button.dataset.pbItemTab === activeEditorTab) return;
      if (activeEditorTab === 'variants') rememberVariantScroll(main, activeItem);
      activeEditorTab = button.dataset.pbItemTab;
      render();
    }));
    if (activeEditorTab === 'variants') {
      bindVariantEditor(main, activeItem);
      const ui = variantUiFor(activeItem);
      const editorScroller = main.querySelector('.pb-editor-scroll');
      if (editorScroller) {
        editorScroller.scrollTop = ui.editorScrollTop;
        editorScroller.addEventListener('scroll', () => { variantUiFor(getItem(activeItem.id)).editorScrollTop = editorScroller.scrollTop; }, { passive:true });
      }
      const scroller = main.querySelector('[data-pb-matrix-scroll]');
      if (scroller) { scroller.scrollLeft = ui.scrollLeft; scroller.scrollTop = ui.scrollTop; }
      return;
    }

    main.querySelector('#pbName')?.addEventListener('input', (e) => patchItemInput(activeItem.id, { name: e.target.value }));
    main.querySelector('#pbType')?.addEventListener('change', (e) => patchItemInput(activeItem.id, { type:e.target.value }));
    main.querySelector('#pbManufacturer')?.addEventListener('change', (e) => patchItemInput(activeItem.id, { manufacturer: e.target.value }));
    main.querySelector('#pbUnit')?.addEventListener('change', (e) => patchItemInput(activeItem.id, { unit: e.target.value }));
    const bindAddOption = (buttonSelector, label, patchForValue) => {
      main.querySelector(buttonSelector)?.addEventListener('click', () => {
        const value = cleanText(window.prompt(((v0) => globalThis.PlatformLanguage?.text("pricebook","m_eaf7ef3b5e4c26",`New ${v0}`,{v0}) ?? `New ${v0}`)(label), ''));
        if (value) patchItem(activeItem.id, patchForValue(value));
      });
    };
    bindAddOption('#pbAddType', 'type', (value) => ({ type:value }));
    bindAddOption('#pbAddManufacturer', 'manufacturer', (value) => ({ manufacturer:value }));
    bindAddOption('#pbAddUnit', 'unit type', (value) => ({ unit:value }));
    main.querySelector('#pbUnitPrice')?.addEventListener('input', (e) => patchItemInput(activeItem.id, { unitPrice: Number(e.target.value || 0), unit_price:Number(e.target.value || 0), base_price:Number(e.target.value || 0) }));
    main.querySelector('#pbInternalCost')?.addEventListener('input', (e) => patchItemInput(activeItem.id, { internalCost:Number(e.target.value || 0), internal_cost:Number(e.target.value || 0) }));
    main.querySelector('#pbExternalDescription')?.addEventListener('input', (e) => patchItemInput(activeItem.id, { description:e.target.value, externalDescription:e.target.value, external_description:e.target.value }));
    main.querySelector('#pbInternalDescription')?.addEventListener('input', (e) => patchItemInput(activeItem.id, { internalDescription:e.target.value, internal_description:e.target.value }));
    main.querySelector('#pbGlobalLinkMode')?.addEventListener('change', (e) => patchItem(activeItem.id, { globalLinkMode:e.target.value, global_link_mode:e.target.value }));
    main.querySelector('#pbDelete')?.addEventListener('click', () => {
      if (state.items.length <= 1) return;
      state.items = state.items.filter((item) => item.id !== activeItem.id);
      activeItemId = state.items[0]?.id || null;
      notify();
      render();
    });
  }

  function open(options = {}){
    ensureUi();
    if (overlayCloseTimer) {
      clearTimeout(overlayCloseTimer);
      overlayCloseTimer = null;
    }
    activeOptions = options;
    activeRoot = document.getElementById('pbOverlay');
    expandedCategories = resolveExpandedCategories(options);
    updateShellTitle(activeRoot, options);
    activeRoot?.classList.remove('active', 'closing', 'measuring');
    applyOverlayOrigin(activeRoot, options.originRect);
    void activeRoot?.offsetWidth;
    activeRoot?.classList.add('active');
    overlayModalHandle = root.Portal?.modals?.register?.(activeRoot, {
      id: 'pricebook-modal',
      closeOnEscape: true,
      closeOnBackdrop: false,
      onClose: () => close()
    }) || overlayModalHandle;
    overlayModalHandle?.bringToFront?.();
    Promise.all([loadState(), root.FirstMateCustomFields?.load?.().catch(() => null)]).then(() => {
      render();
    });
  }

  function mount(container, options = {}){
    if (!container) return null;
    injectCSS('pricebook', css);
    activeOptions = options;
    expandedCategories = resolveExpandedCategories(options);
    container.classList.add('pb-embed');
    container.innerHTML = shellMarkup({
      title: options.title || (globalThis.PlatformLanguage?.htmlText("pricebook","m_5bdcd2418294b6","Organization Price Book") ?? "Organization Price Book"),
      subtitle: options.subtitle || 'Company pricing, global market references, and artifact line behavior.',
    });
    embeddedRoot = container;
    activeRoot = embeddedRoot;
    bindShell(embeddedRoot);
    embeddedRoot.querySelector('#pbBack')?.addEventListener('click', () => options.onClose?.());
    Promise.all([loadState(), root.FirstMateCustomFields?.load?.().catch(() => null)]).then(() => {
      if (embeddedRoot && document.body.contains(embeddedRoot)) {
        activeRoot = embeddedRoot;
        render();
      }
    });
    return {
      refresh(){
        activeRoot = embeddedRoot;
        render();
      },
      destroy(){
        if (activeRoot === embeddedRoot) activeRoot = null;
        if (embeddedRoot && container.contains(embeddedRoot)) container.innerHTML = '';
        container.classList.remove('pb-embed');
        embeddedRoot = null;
      },
    };
  }

  function close(){
    const overlay = document.getElementById('pbOverlay');
    if (overlayCloseTimer) {
      clearTimeout(overlayCloseTimer);
      overlayCloseTimer = null;
    }
    overlay?.classList.remove('active', 'measuring');
    overlay?.classList.add('closing');
    overlayModalHandle?.unregister?.();
    overlayModalHandle = null;
    const onClose = activeOptions?.onClose;
    activeOptions = null;
    overlayCloseTimer = setTimeout(() => {
      overlay?.classList.remove('closing');
      overlayCloseTimer = null;
      onClose?.();
      if (embeddedRoot && document.body.contains(embeddedRoot)) {
        activeRoot = embeddedRoot;
        render();
      } else {
        activeRoot = null;
      }
    }, 190);
  }

  function subscribe(listener){
    listeners.add(listener);
    return () => listeners.delete(listener);
  }

  const api = {
    __initialized: true,
    configure,
    open,
    mount,
    close,
    getState,
    importItems,
    resetToDefaults,
    subscribe,
    getSuggestions,
    getItem,
    getItemTypes,
    defaultItems,
    defaultItemsForGeneration,
    evaluateFormula,
    normalizeOrderPackaging,
    computeOrderQuantity,
    orderInfoForItem,
    lineItemFromPricebook,
    scopeItemFromPricebook,
    defaultLineItems,
    defaultScopeItems,
    measurementFields: clone(MEASUREMENT_FIELDS),
    formulaFields: () => clone([...MEASUREMENT_FIELDS, ...customFormulaFields()]),
    formulaToHumanText,
    loadState,
  };

  root.FirstMatePricebook = api;
  if (root.Portal) {
    root.Portal.modules = root.Portal.modules || {};
    root.Portal.modules.pricebook = api;
  }

  root.addEventListener('fm:custom-fields:definitions-updated', () => {
    if (activeRoot?.isConnected) render();
  });

})();
