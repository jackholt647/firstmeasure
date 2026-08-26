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
    getModule: null,
    saveModule: null,
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
  let suppressRemoteSave = false;
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
    { value: 'sq', label: 'Per Square' },
    { value: 'lf', label: 'Per Linear Foot' },
    { value: 'ea', label: 'Each' },
    { value: 'bundle', label: 'Bundle' },
    { value: 'hour', label: 'Hour' },
  ];

  const MEASUREMENT_FIELDS = [
    { key: 'roofSquares', label: 'Roof Squares (Total)' },
    { key: 'shingleSquares', label: 'Shingle Squares' },
    { key: 'flatRoofSquares', label: 'Flat Roof Squares (2/12 and below)' },
    { key: 'pitch2to4Squares', label: 'Squares at 2/12 - 4/12' },
    { key: 'pitch4to6Squares', label: 'Squares at 4/12 - 6/12' },
    { key: 'pitch6to8Squares', label: 'Squares at 6/12 - 8/12' },
    { key: 'pitch9to12Squares', label: 'Squares at 9/12 - 12/12' },
    { key: 'pitch13PlusSquares', label: 'Squares at 13/12 and above' },
    { key: 'wastePercent', label: 'Waste %' },
    { key: 'eavesLf', label: 'Eaves' },
    { key: 'rakesLf', label: 'Rakes' },
    { key: 'hipsLf', label: 'Hips' },
    { key: 'ridgesLf', label: 'Ridges' },
    { key: 'valleyLf', label: 'Valleys' },
    { key: 'transitionsLf', label: 'Transitions' },
    { key: 'sideWallLf', label: 'Side Wall' },
    { key: 'headWallLf', label: 'Head Wall' },
    { key: 'gutterLf', label: 'Gutters' },
    { key: 'downspoutLf', label: 'Downspouts' },
    { key: 'structures', label: 'Structures' },
    { key: 'chimneysEa', label: 'Chimneys' },
    { key: 'skylightsEa', label: 'Skylights' },
  ];

  const OPERATOR_OPTIONS = ['+', '-', '*', '/'];
  const PAREN_OPTIONS = ['(', ')'];
  const CATEGORY_OPTIONS = [
    { value: 'misc', label: 'Miscellaneous' },
    { value: 'disposal', label: 'Disposal' },
    { value: 'shingle_roofs', label: 'Shingle Roofs' },
    { value: 'leak_barriers', label: 'Leak Barriers' },
    { value: 'underlayments', label: 'Underlayments' },
    { value: 'flashing', label: 'Flashing' },
    { value: 'accessories', label: 'Accessories' },
    { value: 'gutters', label: 'Gutters' },
    { value: 'flat_roofs', label: 'Flat Roofs' },
    { value: 'flat_roof_accessories', label: 'Flat Roof Accessories' },
  ];
  const BRAND_OPTIONS = [
    { value: 'all', label: 'All' },
    { value: 'generic', label: 'Generic' },
    { value: 'gaf', label: 'GAF' },
    { value: 'owens_corning', label: 'Owens Corning' },
    { value: 'malarkey', label: 'Malarkey' },
    { value: 'certainteed', label: 'CertainTeed' },
    { value: 'atlas', label: 'Atlas' },
    { value: 'iko', label: 'IKO' },
  ];
  const FLASHING_OPTIONS = [
    { value: 'all', label: 'All' },
    { value: 'sloped', label: 'Sloped' },
    { value: 'flat', label: 'Flat' },
    { value: 'other', label: 'Other' },
  ];

  const DEFAULT_STATE = { items: [] };

  const css = `
    .pb-overlay{position:fixed;inset:0;z-index:2147483400;background:rgba(7,10,17,.42);backdrop-filter:blur(6px);display:none;align-items:center;justify-content:center;opacity:0;transition:opacity .18s ease}
    .pb-overlay.active,.pb-overlay.closing,.pb-overlay.measuring{display:flex}
    .pb-overlay.active{opacity:1}
    .pb-overlay.closing,.pb-overlay.measuring{pointer-events:none}
    .pb-overlay.measuring{opacity:0}
    .pb-embed{width:100%;min-height:640px}
    .pb-win{width:min(1720px,96vw);height:min(1180px,92vh);background:#eef0f4;border-radius:28px;box-shadow:0 36px 120px rgba(15,23,42,.28);overflow:hidden;display:flex;flex-direction:column;transform-origin:var(--pb-origin-x,50%) var(--pb-origin-y,50%)}
    .pb-overlay.active .pb-win{animation:pb-modal-expand .24s cubic-bezier(.2,.88,.25,1)}
    .pb-overlay.closing .pb-win{animation:pb-modal-collapse .18s cubic-bezier(.4,0,1,1) forwards}
    .pb-embed .pb-win{width:100%;height:clamp(650px,calc(100vh - 260px),960px);border-radius:14px;border:1px solid rgba(15,23,42,.08);box-shadow:none}
    .pb-embed .pb-back{display:none}
    .pb-embed .pb-close{display:none}
    .pb-embed .pb-top{padding:14px 16px}
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
    .pb-main{padding:16px;overflow:auto;display:flex;flex-direction:column;gap:14px}
    .pb-card{background:#fff;border:1px solid rgba(15,23,42,.08);border-radius:20px;padding:16px;display:flex;flex-direction:column;gap:12px}
    .pb-card h3{margin:0;font-size:14px;color:#101828}
    .pb-card p{margin:0;font-size:12px;font-weight:800;color:#667085;line-height:1.5}
    .pb-fields{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:10px}
    .pb-field{display:flex;flex-direction:column;gap:6px}
    .pb-field.full{grid-column:1/-1}
    .pb-field label{font-size:11px;font-weight:1000;letter-spacing:.04em;text-transform:uppercase;color:#667085}
    .pb-field input,.pb-field textarea,.pb-field select{width:100%;padding:11px 12px;border-radius:14px;border:1px solid rgba(15,23,42,.12);background:#fff;font-size:13px;font-weight:900;outline:none}
    .pb-field textarea{min-height:72px;resize:vertical;line-height:1.45}
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
    @keyframes pb-modal-expand{0%{opacity:.35;transform:scale(.38) translateY(-8px)}64%{opacity:1;transform:scale(1.012)}100%{opacity:1;transform:scale(1)}}
    @keyframes pb-modal-collapse{0%{opacity:1;transform:scale(1)}100%{opacity:.05;transform:scale(.34) translateY(-8px)}}
    @media (max-width: 960px){
      .pb-win{width:100vw;height:100vh;border-radius:0}
      .pb-embed .pb-win{width:100%;height:760px;border-radius:12px}
      .pb-body{grid-template-columns:1fr}
      .pb-side{border-right:0;border-bottom:1px solid rgba(15,23,42,.08);max-height:38vh}
      .pb-fields{grid-template-columns:1fr}
      .pb-option-row{grid-template-columns:1fr}
    }
  `;

  function clone(value){
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
    if (typeof options.getModule === 'function') config.getModule = options.getModule;
    if (typeof options.saveModule === 'function') config.saveModule = options.saveModule;
    if (shouldReload) loadPromise = null;
    return api;
  }

  function currentBranchId(){
    if (typeof config.currentBranchId === 'function') return String(config.currentBranchId() || 'default').trim() || 'default';
    return String(root.Portal?.branchModules?.currentBranchId?.() || root.__APP?.userBranchId || 'default').trim() || 'default';
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
      label: 'Color',
      type: 'select',
      defaultValue: 'weathered_wood',
      values: [
        { value: 'weathered_wood', label: 'Weathered Wood' },
        { value: 'charcoal', label: 'Charcoal' },
        { value: 'barkwood', label: 'Barkwood' },
        { value: 'shakewood', label: 'Shakewood' },
        { value: 'driftwood', label: 'Driftwood' }
      ]
    },
    metal_color: {
      id: 'color',
      label: 'Color',
      type: 'select',
      defaultValue: 'black',
      values: [
        { value: 'black', label: 'Black' },
        { value: 'brown', label: 'Brown' }
      ]
    },
    membrane_color: {
      id: 'color',
      label: 'Color',
      type: 'select',
      defaultValue: 'white',
      values: [
        { value: 'white', label: 'White' },
        { value: 'tan', label: 'Tan' },
        { value: 'gray', label: 'Gray' }
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

  function getMeasurementLabel(key){
    return MEASUREMENT_FIELDS.find((field) => field.key === key)?.label || key;
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
      manufacturer: (category === 'shingle_roofs' || category === 'leak_barriers') ? 'generic' : 'generic',
      segment: category === 'flashing' ? 'sloped' : 'all',
      unit: 'ea',
      unitPrice: 0,
      formulaConfig: defaultFormulaConfig(),
      autoAdd: false,
      description: '',
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
      type: ['measurement', 'number', 'operator', 'paren'].includes(token?.type) ? token.type : 'number',
      value: String(token?.value ?? ''),
    })).filter((token) => {
      if (token.type === 'measurement') return MEASUREMENT_FIELDS.some((field) => field.key === token.value);
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
    const normalized = {
      id: item.id || `item_${index + 1}`,
      name: String(item.name || ''),
      category: CATEGORY_OPTIONS.some((option) => option.value === item.category) ? item.category : 'shingle_roofs',
      manufacturer: BRAND_OPTIONS.some((option) => option.value === item.manufacturer) ? item.manufacturer : 'generic',
      segment: FLASHING_OPTIONS.some((option) => option.value === item.segment) ? item.segment : 'all',
      unit: UNIT_OPTIONS.some((option) => option.value === item.unit) ? item.unit : 'ea',
      unitPrice: Number(item.unitPrice || 0),
      formulaConfig: inferFormulaConfig(item),
      autoAdd: !!item.autoAdd,
      description: String(item.description || ''),
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
      schemaVersion: Math.max(Number(raw.schemaVersion || 0), 4),
      variationSchemaVersion: 1,
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

  function pricebookSummary(){
    const categories = new Set((state.items || []).map((item) => item.category).filter(Boolean));
    const itemTypes = new Set((state.items || []).map((item) => item.itemTypeId || item.id).filter(Boolean));
    return {
      item_count: state.items.length,
      item_type_count: itemTypes.size,
      category_count: categories.size,
      branch_id: currentBranchId(),
    };
  }

  function pricebookStorageKey(){
    const branch = currentBranchId();
    return `${config.storageKey}:${branch}`;
  }

  async function saveBranchPricebook(){
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
        const remote = await loadBranchPricebook();
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

  function notify(){
    saveState();
    listeners.forEach((listener) => {
      try { listener(getState()); } catch (e) {}
    });
  }

  function formulaToExpression(formulaConfig){
    const config = inferFormulaConfig({ formulaConfig });
    const inner = config.tokens.map((token) => {
      if (token.type === 'measurement') return token.value;
      if (token.type === 'number') return String(Number(token.value || 0));
      return token.value;
    }).join(' ');
    const base = inner.trim() || '0';
    return config.includeWaste ? `( ${base} ) * ( 1 + (wastePercent / 100) )` : base;
  }

  function formulaToHumanText(formulaConfig){
    const config = inferFormulaConfig({ formulaConfig });
    const text = config.tokens.map((token) => {
      if (token.type === 'measurement') return getMeasurementLabel(token.value);
      if (token.type === 'number') return token.value || '0';
      return token.value;
    }).join(' ');
    return config.includeWaste ? `${text || 'Roof Squares'} + waste` : (text || 'Roof Squares');
  }

  function evaluateFormula(formulaConfig, measurements){
    const scope = { ...(measurements || {}) };
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
    const parts = [item.itemTypeName || displayUnit(item.unit)];
    if (item.variantName && item.variantName !== item.name) parts.push(item.variantName);
    else parts.push(displayUnit(item.unit));
    if (item.variantGroupName && !parts.includes(item.variantGroupName)) parts.push(item.variantGroupName);
    if (item.category === 'shingle_roofs' || item.category === 'leak_barriers') parts.push(getBrandLabel(item.manufacturer || 'generic'));
    if (item.category === 'flashing' && item.segment && item.segment !== 'all') parts.push(getFlashingLabel(item.segment));
    if (item.isDefaultVariant) parts.push('Default');
    parts.push(item.autoAdd ? 'Auto' : 'Manual');
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
        const hay = `${item.name} ${item.itemTypeName || ''} ${item.variantName || ''} ${item.variantGroupName || ''} ${item.description} ${item.unit} ${item.category} ${item.manufacturer || ''} ${item.segment || ''} ${formulaToHumanText(item.formulaConfig)}`.toLowerCase();
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
    const unitPrice = overrides.manualUnitPrice ? Number(overrides.unitPrice || 0) : Number(item.unitPrice || 0);
    return {
      pricebookItemId: item.id,
      label: overrides.label || item.name,
      category: item.category,
      manufacturer: item.manufacturer || 'generic',
      segment: item.segment || 'all',
      quantity: String(Math.max(0, Number(quantity.toFixed(2)))),
      unitPrice: `$${unitPrice.toFixed(2)}`,
      amount: `$${(Math.max(0, quantity) * unitPrice).toFixed(2)}`,
      unit: item.unit,
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

  function defaultLineItems(measurements){
    return defaultItemsForGeneration()
      .map((item) => lineItemFromPricebook(item.id, measurements))
      .filter((item) => item && Number(item.quantity || 0) > 0);
  }

  function getSuggestions(query){
    const needle = String(query || '').trim().toLowerCase();
    return state.items
      .map((item) => {
        const hay = `${item.name} ${item.itemTypeName || ''} ${item.variantName || ''} ${item.variantGroupName || ''} ${item.description} ${item.unit} ${item.category} ${item.manufacturer || ''} ${item.segment || ''} ${formulaToHumanText(item.formulaConfig)}`.toLowerCase();
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
    const title = options.title || 'Pricebook';
    const subtitle = options.subtitle || 'Edit branch formulas, defaults, and estimate items.';
    return `
      <div class="pb-win">
        <div class="pb-top">
          <button type="button" class="pb-back" id="pbBack"><i class="fas fa-arrow-left"></i> Back</button>
          <div class="pb-title">
            <strong>${escapeHtml(title)}</strong>
            <span>${escapeHtml(subtitle)}</span>
          </div>
          <div class="pb-top-actions">
            <button type="button" class="pb-close" id="pbClose" title="Close Price Book" aria-label="Close Price Book"><i class="fas fa-xmark"></i></button>
          </div>
        </div>
        <div class="pb-body">
          <div class="pb-side">
            <div class="pb-side-tools">
              <input id="pbSearch" class="pb-search" placeholder="Search pricebook items...">
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
    const title = options.title || 'Pricebook';
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

  function renderVariationBuilder(item){
    const definitions = normalizeOptionDefinitions(item.optionDefinitions || []);
    return `
      <div class="pb-card">
        <h3>Variation</h3>
        <p>Use item types for mutually exclusive material choices. Variants are the selectable products inside that type, and options are arbitrary choices like color or size.</p>
        <div class="pb-fields">
          <div class="pb-field"><label>Item Type</label><input id="pbItemTypeName" value="${escapeHtml(item.itemTypeName || '')}"></div>
          <div class="pb-field"><label>Type Key</label><input id="pbItemTypeId" value="${escapeHtml(item.itemTypeId || '')}"></div>
          <div class="pb-field"><label>Variant</label><input id="pbVariantName" value="${escapeHtml(item.variantName || '')}"></div>
          <div class="pb-field"><label>Variant Key</label><input id="pbVariantId" value="${escapeHtml(item.variantId || '')}"></div>
          <div class="pb-field"><label>Variant Group</label><input id="pbVariantGroupName" value="${escapeHtml(item.variantGroupName || '')}"></div>
          <div class="pb-field"><label>Group Key</label><input id="pbVariantGroupId" value="${escapeHtml(item.variantGroupId || '')}"></div>
          <div class="pb-field">
            <label>Default Variant</label>
            <label class="pb-inline-toggle">
              <span>Use when this type auto-generates</span>
              <input id="pbDefaultVariant" type="checkbox"${item.isDefaultVariant ? ' checked' : ''}>
              <span class="pb-waste-pill"></span>
            </label>
          </div>
          <div class="pb-field"><label>Variant Role</label><select id="pbVariantRole">
            ${['generic', 'branded', 'standard', 'custom'].map((role) => `<option value="${role}"${role === item.variantRole ? ' selected' : ''}>${escapeHtml(titleFromKey(role))}</option>`).join('')}
          </select></div>
        </div>
        <div class="pb-variation-options">
          ${definitions.map((definition, index) => `
            <div class="pb-option-row" data-pb-option-index="${index}">
              <input data-pb-option-field="id" value="${escapeHtml(definition.id)}" title="Option key">
              <input data-pb-option-field="label" value="${escapeHtml(definition.label)}" title="Option label">
              <select data-pb-option-field="type" title="Option type">
                ${['select', 'text', 'number', 'boolean'].map((type) => `<option value="${type}"${type === definition.type ? ' selected' : ''}>${escapeHtml(type)}</option>`).join('')}
              </select>
              <input data-pb-option-field="defaultValue" value="${escapeHtml(definition.defaultValue)}" title="Default value">
              <input data-pb-option-field="values" value="${escapeHtml(optionValuesText(definition))}" placeholder="value:Label, value2:Label" title="Select values">
              <button type="button" class="pb-option-remove" data-pb-option-remove="${index}" title="Remove option"><i class="fas fa-trash"></i></button>
            </div>
          `).join('') || '<p>No variant options yet.</p>'}
          <button type="button" class="pb-formula-add" id="pbAddOption"><i class="fas fa-plus"></i> Add Option</button>
        </div>
      </div>
    `;
  }

  function renderFormulaBuilder(item){
    const formulaConfig = inferFormulaConfig(item);
    return `
      <div class="pb-formula-builder">
        <div class="pb-formula-summary">
          <strong>Formula</strong>
          <div class="pb-formula-human">$${Number(item.unitPrice || 0).toFixed(2)} x (${escapeHtml(formulaToHumanText(formulaConfig))})</div>
          <label class="pb-waste-toggle">
            <input type="checkbox" id="pbIncludeWaste"${formulaConfig.includeWaste ? ' checked' : ''}>
            <span class="pb-waste-pill"></span>
            Waste
          </label>
        </div>
        <div class="pb-formula-row">
          ${formulaConfig.tokens.map((token, index) => {
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
          }).join('')}
        </div>
        <div class="pb-formula-actions">
          <button type="button" class="pb-formula-add" data-token-add="measurement"><i class="fas fa-ruler-combined"></i> Measurement</button>
          <button type="button" class="pb-formula-add" data-token-add="operator"><i class="fas fa-plus-minus"></i> Symbol</button>
          <button type="button" class="pb-formula-add" data-token-add="number"><i class="fas fa-hashtag"></i> Number</button>
          <button type="button" class="pb-formula-add" data-token-add="paren"><i class="fas fa-parentheses"></i> ( )</button>
        </div>
      </div>
    `;
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
        <section class="pb-cat${expandedCategories[category.value] !== false ? ' open' : ''}" data-pb-cat="${escapeHtml(category.value)}">
          <button type="button" class="pb-cat-head" data-pb-cat-toggle="${escapeHtml(category.value)}">
            <strong>${escapeHtml(category.label)}</strong>
            <div class="pb-cat-meta">
              ${usedCategories.has(category.value) ? '<span class="pb-cat-star">*</span>' : ''}
              <span class="pb-cat-count">${category.items.length}</span>
              <i class="fas fa-chevron-down pb-cat-angle"></i>
            </div>
          </button>
          <div class="pb-cat-body"${expandedCategories[category.value] === false ? ' style="display:none"' : ''}>
            ${filterOptions.length ? `
              <div class="pb-filter-row">
                ${filterOptions.map((option) => `
                  <button type="button" class="pb-filter${filters.includes(option.value) ? ' active' : ''}${option.value === 'all' || option.value === 'generic' ? ' is-meta' : ''}" data-pb-filter-cat="${escapeHtml(category.value)}" data-pb-filter="${escapeHtml(option.value)}">
                    <span class="pb-filter-logo">${escapeHtml(getFilterChipLabel(option))}${filterHasUsedItems(category.value, option.value, usedSubfilters) ? ' *' : ''}</span>
                  </button>
                `).join('')}
              </div>
            ` : ''}
            <div class="pb-tree">
              ${category.items.map((item) => `
                <button type="button" class="pb-item${item.id === activeItemId ? ' active' : ''}${usedItemIds.has(item.id) ? ' in-use' : ''}" data-pb-item="${escapeHtml(item.id)}">
                  <div class="pb-item-main">
                    <strong>${escapeHtml(item.name)}</strong>
                    <span>${escapeHtml(formatSidebarMeta(item))}</span>
                  </div>
                  <span class="pb-item-price">$${Number(item.unitPrice || 0).toFixed(2)}</span>
                </button>
              `).join('') || `<div class="pb-item-empty">No matching items</div>`}
              <button type="button" class="pb-cat-add" data-pb-add-cat="${escapeHtml(category.value)}"><i class="fas fa-plus"></i> New Item</button>
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
      main.innerHTML = `<div class="pb-card"><h3>No items yet</h3><p>Create a pricebook item to get started.</p></div>`;
      return;
    }

    const formulaConfig = inferFormulaConfig(activeItem);
    main.innerHTML = `
      <div class="pb-card">
        <h3>Item Settings</h3>
        <div class="pb-fields">
          <div class="pb-field"><label>Name</label><input id="pbName" value="${escapeHtml(activeItem.name)}"></div>
          <div class="pb-field">
            <label>Auto Add <span class="fm-ui-help" tabindex="0" data-fm-tooltip="When auto-adding, the estimate will use the formula below to calculate quantity.">?</span></label>
            <label class="pb-inline-toggle">
              <span>Add to new estimates</span>
              <input id="pbAutoAdd" type="checkbox"${activeItem.autoAdd ? ' checked' : ''}>
              <span class="pb-waste-pill"></span>
            </label>
          </div>
          <div class="pb-field"><label>Category</label><select id="pbCategory">${CATEGORY_OPTIONS.map((option) => `<option value="${option.value}"${option.value === activeItem.category ? ' selected' : ''}>${escapeHtml(option.label)}</option>`).join('')}</select></div>
          <div class="pb-field">${activeItem.category === 'shingle_roofs' || activeItem.category === 'leak_barriers'
            ? `<label>Manufacturer</label><select id="pbManufacturer">${BRAND_OPTIONS.filter((option) => option.value !== 'all').map((option) => `<option value="${option.value}"${option.value === activeItem.manufacturer ? ' selected' : ''}>${escapeHtml(option.label)}</option>`).join('')}</select>`
            : activeItem.category === 'flashing'
              ? `<label>Type</label><select id="pbSegment">${FLASHING_OPTIONS.filter((option) => option.value !== 'all').map((option) => `<option value="${option.value}"${option.value === (activeItem.segment || 'other') ? ' selected' : ''}>${escapeHtml(option.label)}</option>`).join('')}</select>`
              : `<label>Group</label><input value="${escapeHtml(getCategoryLabel(activeItem.category))}" disabled>`}
          </div>
          <div class="pb-field"><label>Unit Price</label><input id="pbUnitPrice" type="number" step="0.01" min="0" value="${Number(activeItem.unitPrice || 0)}"></div>
          <div class="pb-field"><label>Unit Type</label><select id="pbUnit">${UNIT_OPTIONS.map((option) => `<option value="${option.value}"${option.value === activeItem.unit ? ' selected' : ''}>${escapeHtml(option.label)}</option>`).join('')}</select></div>
          <div class="pb-field full"><label>Description</label><textarea id="pbDescription">${escapeHtml(activeItem.description || '')}</textarea></div>
        </div>
        <div class="pb-foot">
          <p>Final price is calculated as <strong>unit price x quantity formula</strong>.</p>
          <button type="button" class="pb-delete" id="pbDelete"${state.items.length <= 1 ? ' disabled' : ''}>Delete Item</button>
        </div>
      </div>
      ${renderVariationBuilder(activeItem)}
      <div class="pb-card">
        <h3>Formula</h3>
        <p>Pick measurements from the dropdowns and build the quantity with symbols.</p>
        ${renderFormulaBuilder(activeItem)}
      </div>
    `;

    main.querySelector('#pbName')?.addEventListener('input', (e) => patchItem(activeItem.id, { name: e.target.value }));
    main.querySelector('#pbCategory')?.addEventListener('change', (e) => {
      const category = e.target.value;
      patchItem(activeItem.id, {
        category,
        manufacturer: (category === 'shingle_roofs' || category === 'leak_barriers') ? (activeItem.manufacturer || 'generic') : 'generic',
        segment: category === 'flashing' ? (activeItem.segment && activeItem.segment !== 'all' ? activeItem.segment : 'sloped') : 'all',
      });
    });
    main.querySelector('#pbManufacturer')?.addEventListener('change', (e) => patchItem(activeItem.id, { manufacturer: e.target.value }));
    main.querySelector('#pbSegment')?.addEventListener('change', (e) => patchItem(activeItem.id, { segment: e.target.value }));
    main.querySelector('#pbUnit')?.addEventListener('change', (e) => patchItem(activeItem.id, { unit: e.target.value }));
    main.querySelector('#pbUnitPrice')?.addEventListener('input', (e) => patchItem(activeItem.id, { unitPrice: Number(e.target.value || 0) }));
    main.querySelector('#pbDescription')?.addEventListener('input', (e) => patchItem(activeItem.id, { description: e.target.value }));
    main.querySelector('#pbAutoAdd')?.addEventListener('change', (e) => {
      patchItemDeferred(activeItem.id, { autoAdd: e.target.checked });
    });
    main.querySelector('#pbItemTypeName')?.addEventListener('input', (e) => patchItem(activeItem.id, { itemTypeName: e.target.value }));
    main.querySelector('#pbItemTypeId')?.addEventListener('change', (e) => patchItem(activeItem.id, { itemTypeId: slug(e.target.value, activeItem.itemTypeId || activeItem.id) }));
    main.querySelector('#pbVariantName')?.addEventListener('input', (e) => patchItem(activeItem.id, { variantName: e.target.value }));
    main.querySelector('#pbVariantId')?.addEventListener('change', (e) => patchItem(activeItem.id, { variantId: slug(e.target.value, activeItem.variantId || 'generic') }));
    main.querySelector('#pbVariantGroupName')?.addEventListener('input', (e) => patchItem(activeItem.id, { variantGroupName: e.target.value }));
    main.querySelector('#pbVariantGroupId')?.addEventListener('change', (e) => patchItem(activeItem.id, { variantGroupId: slug(e.target.value, activeItem.variantGroupId || 'unbranded') }));
    main.querySelector('#pbVariantRole')?.addEventListener('change', (e) => patchItem(activeItem.id, { variantRole: e.target.value }));
    main.querySelector('#pbDefaultVariant')?.addEventListener('change', (e) => setDefaultVariant(activeItem.id, e.target.checked));
    main.querySelectorAll('[data-pb-option-field]').forEach((control) => {
      const updateOption = () => {
        const index = Number(control.closest('[data-pb-option-index]')?.dataset.pbOptionIndex || -1);
        if (index < 0) return;
        const definitions = normalizeOptionDefinitions(activeItem.optionDefinitions || []);
        const field = control.dataset.pbOptionField;
        if (field === 'values') definitions[index].values = parseOptionValues(control.value);
        else if (field === 'id') definitions[index].id = slug(control.value, definitions[index].id);
        else definitions[index][field] = control.value;
        if (field === 'values' && !definitions[index].defaultValue && definitions[index].values[0]) definitions[index].defaultValue = definitions[index].values[0].value;
        patchItem(activeItem.id, { optionDefinitions: definitions, defaultOptions: normalizeOptionSelections(activeItem.defaultOptions, definitions) });
      };
      control.addEventListener('change', updateOption);
      if (control.dataset.pbOptionField !== 'id') control.addEventListener('input', updateOption);
    });
    main.querySelectorAll('[data-pb-option-remove]').forEach((btn) => {
      btn.addEventListener('click', () => {
        const index = Number(btn.dataset.pbOptionRemove || -1);
        if (index < 0) return;
        const definitions = normalizeOptionDefinitions(activeItem.optionDefinitions || []).filter((_, optionIndex) => optionIndex !== index);
        patchItem(activeItem.id, { optionDefinitions: definitions, defaultOptions: normalizeOptionSelections(activeItem.defaultOptions, definitions) });
      });
    });
    main.querySelector('#pbAddOption')?.addEventListener('click', () => {
      const definitions = normalizeOptionDefinitions(activeItem.optionDefinitions || []);
      definitions.push({ id: `option_${definitions.length + 1}`, label: `Option ${definitions.length + 1}`, type: 'select', defaultValue: '', values: [], required: true, metadata: {} });
      patchItem(activeItem.id, { optionDefinitions: definitions, defaultOptions: normalizeOptionSelections(activeItem.defaultOptions, definitions) });
    });
    main.querySelector('#pbDelete')?.addEventListener('click', () => {
      if (state.items.length <= 1) return;
      state.items = state.items.filter((item) => item.id !== activeItem.id);
      activeItemId = state.items[0]?.id || null;
      notify();
      render();
    });
    main.querySelector('#pbIncludeWaste')?.addEventListener('change', (e) => {
      patchItemDeferred(activeItem.id, { formulaConfig: { ...formulaConfig, includeWaste: e.target.checked } });
    });
    main.querySelectorAll('[data-token-field]').forEach((control) => {
      const update = () => {
        const index = Number(control.closest('[data-token-index]')?.dataset.tokenIndex || -1);
        if (index < 0) return;
        const tokens = clone(formulaConfig.tokens);
        tokens[index].value = control.value;
        patchItem(activeItem.id, { formulaConfig: { ...formulaConfig, tokens } });
      };
      control.addEventListener('input', update);
      control.addEventListener('change', update);
      if (control.closest('.pb-token.number')) {
        control.addEventListener('blur', () => {
          if (control.value === '') {
            const index = Number(control.closest('[data-token-index]')?.dataset.tokenIndex || -1);
            if (index < 0) return;
            const tokens = clone(formulaConfig.tokens);
            tokens[index].value = '0';
            patchItem(activeItem.id, { formulaConfig: { ...formulaConfig, tokens } });
          }
        });
      }
    });
    main.querySelectorAll('[data-token-remove]').forEach((btn) => {
      btn.addEventListener('click', () => {
        const index = Number(btn.dataset.tokenRemove || -1);
        if (index < 0) return;
        const tokens = clone(formulaConfig.tokens).filter((_, tokenIndex) => tokenIndex !== index);
        patchItem(activeItem.id, { formulaConfig: { ...formulaConfig, tokens: normalizeTokens(tokens) } });
      });
    });
    main.querySelectorAll('[data-token-add]').forEach((btn) => {
      btn.addEventListener('click', () => {
        const type = btn.dataset.tokenAdd;
        const tokens = clone(formulaConfig.tokens);
        if (type === 'measurement') tokens.push({ type:'measurement', value:'roofSquares' });
        if (type === 'operator') tokens.push({ type:'operator', value:'+' });
        if (type === 'number') tokens.push({ type:'number', value:'1' });
        if (type === 'paren') tokens.push({ type:'paren', value:'(' });
        patchItem(activeItem.id, { formulaConfig: { ...formulaConfig, tokens } });
      });
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
    loadState().then(() => {
      render();
    });
  }

  function mount(container, options = {}){
    if (!container) return null;
    injectCSS('pricebook', css);
    activeOptions = options;
    expandedCategories = resolveExpandedCategories(options);
    container.innerHTML = `<div class="pb-embed">${shellMarkup({
      title: options.title || 'Pricebook',
      subtitle: options.subtitle || 'Centralized branch pricing items and formulas.',
    })}</div>`;
    embeddedRoot = container.querySelector('.pb-embed');
    activeRoot = embeddedRoot;
    bindShell(embeddedRoot);
    embeddedRoot.querySelector('#pbBack')?.addEventListener('click', () => options.onClose?.());
    loadState().then(() => {
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
    subscribe,
    getSuggestions,
    getItem,
    getItemTypes,
    defaultItems,
    defaultItemsForGeneration,
    evaluateFormula,
    lineItemFromPricebook,
    defaultLineItems,
    measurementFields: clone(MEASUREMENT_FIELDS),
    formulaToHumanText,
    loadState,
  };

  root.FirstMatePricebook = api;
  if (root.Portal) {
    root.Portal.modules = root.Portal.modules || {};
    root.Portal.modules.pricebook = api;
  }

  loadState();
})();
