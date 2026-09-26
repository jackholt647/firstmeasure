/* public/libraries/apps/equipment/app.js
 * Equipment — the global fleet registry. Fleet view (units, filters, drawer),
 * a types & categories manager, and the shared module settings view. Timeline,
 * Maintenance, and Utilization views arrive with their capability layers.
 */
(function(){
  const runtime = window.FirstMateEmbeddableApps;
  const Portal = window.Portal;
  if (!runtime || !Portal) return;

  const clean = (value) => String(value ?? '').trim();
  const arr = (value) => Array.isArray(value) ? value : [];
  const obj = (value) => value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  const esc = (value) => runtime.escapeHtml ? runtime.escapeHtml(value) : clean(value).replace(/[&<>"']/g, '');
  const orgId = (context = {}) => clean(context.orgId || window.__APP?.userOrgId || window.__APP?.orgId);
  const showToast = (title, message, ok = true) => Portal.ui?.showToast?.(title, message, ok);
  const statusError = (error, fallback) => clean(error?.data?.message || error?.message || fallback || 'Something went wrong.');
  const cssColor = (value) => /^(?:#[0-9a-f]{3,8}|[a-z]{3,20})$/i.test(clean(value)) ? clean(value) : '';
  const terminology = (key, fallback) => Portal.terminology?.get?.(key, fallback) || window.PlatformTerminology?.get?.(key, fallback) || fallback;
  const capabilityOn = (group, flag) => window.PlatformAPI?.appFlags?.has?.(group, flag) === true;

  const STATUS_META = {
    available: { label:(globalThis.PlatformLanguage?.text("equipment","m_f326bdcd77881a","Available") ?? "Available"), term:'equipment.available_status', color:'#12805c', bg:'#e3f8ec', icon:'fa-circle-check' },
    in_use: { label:(globalThis.PlatformLanguage?.text("equipment","m_4ece68045bcb8c","In Use") ?? "In Use"), term:'equipment.in_use_status', color:'#175cd3', bg:'#e8f0fe', icon:'fa-person-digging' },
    down: { label:(globalThis.PlatformLanguage?.text("equipment","m_fa478802aae7f9","Down") ?? "Down"), term:'equipment.down_status', color:'#b42318', bg:'#fef3f2', icon:'fa-triangle-exclamation' },
    reserved: { label:(globalThis.PlatformLanguage?.text("equipment","m_d1866b00e81821","Reserved") ?? "Reserved"), term:'equipment.reserved_status', color:'#93540c', bg:'#fffaeb', icon:'fa-clock' },
    retired: { label:(globalThis.PlatformLanguage?.text("equipment","m_77706675a65db9","Retired") ?? "Retired"), term:'equipment.retired_status', color:'#667085', bg:'#f2f4f7', icon:'fa-box-archive' }
  };
  const OWNERSHIPS = [['owned','Owned'],['leased','Leased'],['rented','Rented']];
  const DRIVER_REQUIREMENTS = [
    ['', 'None'],
    ['driver_license', "Valid driver's license"],
    ['cdl_a', 'CDL Class A'],
    ['cdl_b', 'CDL Class B'],
    ['cdl_c', 'CDL Class C'],
    ['certified_operator', 'Certified operator']
  ];

  /* ------------------------------------------------------------------ CSS */
  const css = `
    .eq-shell{height:100%;min-height:0;display:flex;flex-direction:column;background:#f7f8fb;color:#17212b;overflow:hidden}
    .eq-shell *{box-sizing:border-box}
    .eq-top{flex:none;display:flex;align-items:center;gap:14px;flex-wrap:wrap;padding:16px 20px 12px;background:#fff;border-bottom:1px solid #e7eaf0}
    .eq-title{display:flex;align-items:center;gap:11px;margin-right:auto}
    .eq-title-icon{width:38px;height:38px;border-radius:11px;display:grid;place-items:center;background:var(--primary-readable,var(--primary,#d93025));color:#fff;font-size:15px}
    .eq-title h2{margin:0;font-size:19px;letter-spacing:-.01em}
    .eq-title>div>span{display:block;margin-top:1px;color:#667085;font-size:11px;font-weight:750}
    .eq-views{display:inline-flex;gap:2px;border:1px solid #e4e7ec;border-radius:12px;background:#f4f6f9;padding:3px}
    .eq-views button{appearance:none;border:0;border-radius:9px;background:transparent;padding:8px 14px;color:#667085;font:850 12px/1 inherit;cursor:pointer;display:inline-flex;align-items:center;gap:7px}
    .eq-views button.on{background:#fff;color:#101828;box-shadow:0 1px 3px rgba(16,24,40,.12)}
    .eq-btn{appearance:none;border:1px solid #d0d5dd;border-radius:10px;background:#fff;color:#344054;padding:9px 14px;font:850 12px/1 inherit;cursor:pointer;display:inline-flex;align-items:center;gap:8px}
    .eq-btn.primary{background:var(--primary-readable,var(--primary,#d93025));border-color:transparent;color:#fff}.eq-btn.danger{background:#b42318;border-color:#b42318;color:#fff}
    .eq-btn:disabled{opacity:.5;cursor:not-allowed}
    .eq-body{flex:1;min-height:0;overflow:auto;padding:16px 20px 26px}
    .eq-filters{display:flex;align-items:center;gap:10px;flex-wrap:wrap;margin-bottom:14px}
    .eq-search{position:relative;flex:1;min-width:200px;max-width:340px}
    .eq-search i{position:absolute;left:11px;top:50%;transform:translateY(-50%);color:#98a2b3;font-size:12px}
    .eq-search input{width:100%;border:1px solid #d0d5dd;border-radius:10px;background:#fff;padding:9px 12px 9px 32px;color:#344054;font:700 12.5px/1.4 inherit;outline:0}
    .eq-search input:focus{border-color:var(--primary-readable,var(--primary,#d93025))}
    .eq-filter{border:1px solid #d0d5dd;border-radius:10px;background:#fff;padding:9px 10px;color:#344054;font:750 12px/1.2 inherit;outline:0;max-width:190px}
    .eq-count{color:#667085;font-size:11.5px;font-weight:800;margin-left:auto}
    .eq-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(330px,1fr));gap:13px}
    .eq-card{border:1px solid #e4e7ec;border-radius:14px;background:#fff;padding:0;display:grid;grid-template-columns:minmax(118px,38%) minmax(0,1fr);min-height:148px;overflow:hidden;cursor:pointer;text-align:left;font:inherit;color:inherit;box-shadow:0 1px 3px rgba(16,24,40,.04);transition:box-shadow .12s ease,transform .12s ease}
    .eq-card:hover{transform:translateY(-1px);box-shadow:0 6px 18px rgba(16,24,40,.08)}
    .eq-card-media{min-height:148px;background:#f2f4f7 center/cover no-repeat;border-right:1px solid #eef0f5;display:grid;place-items:center;color:var(--primary-readable,var(--primary,#d93025));font-size:28px}
    .eq-card-content{position:relative;min-width:0;padding:14px;display:grid;align-content:start;gap:10px}
    .eq-card-top{display:flex;align-items:center;gap:11px;padding-right:72px}
    .eq-card-icon{width:40px;height:40px;border-radius:11px;display:grid;place-items:center;background:rgba(var(--primary-rgb,217,48,37),.09);color:var(--primary-readable,var(--primary,#d93025));font-size:15px;flex:0 0 auto}
    .eq-card-name{min-width:0;flex:1}
    .eq-card-name strong{display:block;font-size:13.5px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
    .eq-card-name span{display:block;margin-top:2px;color:#667085;font-size:11px;font-weight:750;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
    .eq-chip{display:inline-flex;align-items:center;gap:6px;border-radius:999px;padding:4px 10px;font-size:10.5px;font-weight:900;flex:0 0 auto}
    .eq-card-status-wrap{position:absolute;top:8px;right:8px;width:70px;height:21px;border-radius:999px;display:block;overflow:hidden}
    .eq-card-status-wrap i{position:absolute;right:6px;top:50%;transform:translateY(-50%);font-size:7px;pointer-events:none;color:inherit}
    .eq-card-status{appearance:none!important;-webkit-appearance:none!important;width:100%!important;max-width:none!important;height:21px!important;min-height:0!important;margin:0!important;border:0!important;border-radius:999px!important;background:transparent!important;color:inherit!important;padding:1px 15px 1px 7px!important;font:800 8.5px/1 inherit!important;letter-spacing:0!important;cursor:pointer;outline:0;text-overflow:clip}
    .eq-card-status:focus{box-shadow:inset 0 0 0 1px currentColor}
    .eq-card-meta{display:grid;gap:5px}
    .eq-card-meta div{display:flex;align-items:center;gap:8px;color:#475467;font-size:11.5px;font-weight:700;min-width:0}
    .eq-card-meta i{width:14px;text-align:center;color:#98a2b3;font-size:11px}
    .eq-card-meta span{white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
    .eq-empty{border:1.5px dashed #d0d5dd;border-radius:16px;background:#fff;min-height:280px;display:grid;place-items:center;text-align:center;padding:30px}
    .eq-empty > div{display:grid;justify-items:center;gap:10px;max-width:420px}
    .eq-empty i{font-size:30px;color:#c2c9d6}
    .eq-empty .eq-btn.primary i{font-size:inherit;color:#fff}
    .eq-empty strong{font-size:14.5px;color:#344054}
    .eq-empty p{margin:0;color:#667085;font-size:12px;line-height:1.55;font-weight:650}
    .eq-loading{display:grid;place-items:center;min-height:280px;color:#667085;font-size:12px;font-weight:850}
    .eq-spinner{width:26px;height:26px;border:3px solid #e2e6f2;border-top-color:var(--primary-readable,var(--primary,#d93025));border-radius:999px;animation:eq-spin .75s linear infinite;margin:0 auto 10px}
    @keyframes eq-spin{to{transform:rotate(360deg)}}
    /* Drawer */
    .eq-drawer-back{position:fixed;inset:0;z-index:2147483500;background:rgba(16,22,42,.45);display:flex;justify-content:flex-end;animation:eq-fade .16s ease both}
    @keyframes eq-fade{from{opacity:0}to{opacity:1}}
    .eq-drawer{width:min(520px,100%);height:100%;background:#fff;box-shadow:-12px 0 40px rgba(16,24,40,.18);display:flex;flex-direction:column;animation:eq-slide .22s cubic-bezier(.22,1,.36,1) both}.eq-preserve-drawer .eq-drawer-back,.eq-preserve-drawer .eq-drawer{animation:none}
    @keyframes eq-slide{from{transform:translateX(40px);opacity:.4}to{transform:none;opacity:1}}
    .eq-drawer-head{flex:none;display:flex;align-items:flex-start;gap:12px;padding:18px 20px 14px;border-bottom:1px solid #eef0f5}
    .eq-drawer-head .eq-card-icon{width:44px;height:44px;font-size:17px}
    .eq-drawer-title{flex:1;min-width:0}
    .eq-drawer-title.single-line{align-self:stretch;display:flex;align-items:center}
    .eq-drawer-title h3{margin:0;font-size:17px}
    .eq-drawer-title span{display:block;margin-top:2px;color:#667085;font-size:11.5px;font-weight:750}
    .eq-drawer-close{appearance:none;border:0;border-radius:9px;background:#f2f4f7;color:#475467;width:34px;height:34px;display:grid;place-items:center;cursor:pointer;font-size:13px;flex:0 0 auto}
    .eq-drawer-body{flex:1;min-height:0;overflow:auto;padding:16px 20px 24px}
    .eq-form{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:12px}
    .eq-field{min-width:0}
    .eq-field.wide{grid-column:1/-1}
    .eq-field label{display:block;font-size:10px;font-weight:950;letter-spacing:.06em;text-transform:uppercase;color:#667085;margin-bottom:5px}
    .eq-field input,.eq-field select,.eq-field textarea{width:100%;border:1px solid #d0d5dd;border-radius:10px;background:#fff;padding:9px 11px;color:#344054;font:700 12.5px/1.45 inherit;outline:0;resize:vertical}
    .eq-field input:focus,.eq-field select:focus,.eq-field textarea:focus{border-color:var(--primary-readable,var(--primary,#d93025))}
    .eq-inline-view-form .eq-unit-identity{grid-template-columns:200px minmax(0,1fr)}
    .eq-inline-view-form .eq-field input:not(.eq-color-input),.eq-inline-view-form .eq-field select,.eq-inline-view-form .eq-field textarea{border-color:transparent;background:transparent;box-shadow:none;transition:border-color .14s ease,background .14s ease,box-shadow .14s ease}
    .eq-inline-view-form .eq-field:hover input:not(.eq-color-input),.eq-inline-view-form .eq-field:hover select,.eq-inline-view-form .eq-field:hover textarea{border-color:#d0d5dd;background:#fff}
    .eq-inline-view-form .eq-field input:focus,.eq-inline-view-form .eq-field select:focus,.eq-inline-view-form .eq-field textarea:focus{border-color:var(--primary-readable,var(--primary,#d93025));background:#fff;box-shadow:0 0 0 3px rgba(var(--primary-rgb,217,48,37),.08)}
    .eq-readonly-field{grid-column:1/-1}.eq-readonly-value{padding:8px 1px;color:#475467;font-size:12px;font-weight:700;line-height:1.5;white-space:pre-wrap}.eq-readonly-value i{margin-right:6px;color:#98a2b3;font-size:10px}
    .eq-inline-select select{width:100%}
    .eq-unit-identity{grid-column:1/-1;display:grid;grid-template-columns:152px minmax(0,1fr);gap:22px;align-items:stretch}
    .eq-photo-tile{appearance:none;border:1px solid #e4e7ec;border-radius:13px;background:#f3f5f8;aspect-ratio:4/3;overflow:hidden;padding:0;color:#667085;cursor:pointer;position:relative;display:grid;place-items:center;font:inherit;transition:border-color .14s ease,box-shadow .14s ease,transform .14s ease}.eq-photo-tile:hover{border-color:#aeb6c4;box-shadow:0 4px 14px rgba(16,24,40,.09);transform:translateY(-1px)}.eq-photo-tile img{position:absolute;inset:0;width:100%;height:100%;object-fit:cover}.eq-photo-tile-copy{position:relative;z-index:1;display:grid;justify-items:center;gap:7px;font-size:11px;font-weight:850}.eq-photo-tile-copy i{font-size:23px}.eq-photo-tile.has-photo .eq-photo-tile-copy{display:none}.eq-photo-crop{appearance:none;position:absolute;z-index:2;top:8px;right:8px;width:32px;height:32px;border:1px solid rgba(255,255,255,.7);border-radius:9px;background:rgba(17,24,39,.76);color:#fff;display:grid;place-items:center;cursor:pointer;opacity:0;transform:translateY(-3px);transition:opacity .14s ease,transform .14s ease,background .14s ease}.eq-photo-tile:hover .eq-photo-crop,.eq-photo-tile:focus-within .eq-photo-crop{opacity:1;transform:none}.eq-photo-crop:hover{background:rgba(17,24,39,.94)}
    .eq-identity-fields{display:grid;align-content:start;gap:12px}.eq-identity-color{width:76px}
    .eq-name-color{grid-column:1/-1;display:grid;grid-template-columns:minmax(0,1fr) 58px;gap:12px;align-items:end}
    .eq-color-input{display:block;width:58px!important;height:39px!important;padding:0!important;border:0!important;border-radius:10px!important;background:transparent!important;overflow:hidden;cursor:pointer}
    .eq-color-input::-webkit-color-swatch-wrapper{padding:0}.eq-color-input::-webkit-color-swatch{border:0;border-radius:10px}.eq-color-input::-moz-color-swatch{border:0;border-radius:10px}
    .eq-dynamic-panel{grid-column:1/-1;display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:12px;animation:eq-fields-in .22s cubic-bezier(.22,1,.36,1) both;transform-origin:top}
    @keyframes eq-fields-in{from{opacity:0;transform:translateY(-6px) scaleY(.97)}to{opacity:1;transform:none}}
    .eq-condition-list{grid-column:1/-1;display:grid;gap:8px}.eq-condition-note{display:flex;align-items:flex-start;gap:7px}.eq-condition-note textarea{flex:1}.eq-icon-remove{appearance:none;border:0;border-radius:8px;background:#fef3f2;color:#b42318;width:34px;height:34px;cursor:pointer;flex:0 0 auto}
    .eq-condition-media{grid-column:1/-1;display:grid;grid-template-columns:repeat(auto-fill,minmax(92px,1fr));gap:8px}.eq-condition-media-item{position:relative;aspect-ratio:4/3;border-radius:10px;overflow:hidden;background:#eef1f5}.eq-condition-media-item img,.eq-condition-media-item video{width:100%;height:100%;object-fit:cover;display:block}.eq-condition-media-item .eq-icon-remove{position:absolute;top:5px;right:5px;width:26px;height:26px;background:rgba(255,255,255,.92)}
    .eq-drawer-foot{flex:none;display:flex;align-items:center;gap:10px;padding:14px 20px calc(14px + env(safe-area-inset-bottom));border-top:1px solid #eef0f5;background:#fff}
    .eq-danger{color:#b42318;background:transparent;border:0;font:850 12px/1 inherit;cursor:pointer;margin-right:auto;padding:8px}
    .eq-section-label{grid-column:1/-1;margin:6px 0 -4px;font-size:10.5px;font-weight:950;letter-spacing:.07em;text-transform:uppercase;color:#98a2b3;display:flex;align-items:center;gap:8px}
    .eq-section-label:after{content:'';flex:1;height:1px;background:#eef0f5}
    /* Types manager */
    .eq-types-list{display:grid;gap:9px}
    .eq-type-row{border:1px solid #e4e7ec;border-radius:12px;background:#fff;padding:11px 13px;display:flex;align-items:center;gap:11px}
    .eq-type-row .eq-card-icon{width:34px;height:34px;font-size:13px;border-radius:9px}
    .eq-type-row-copy{flex:1;min-width:0}
    .eq-type-row-copy strong{display:block;font-size:12.5px}
    .eq-type-row-copy span{display:block;margin-top:1px;color:#667085;font-size:10.5px;font-weight:750}
    .eq-mini{appearance:none;border:1px solid #d0d5dd;border-radius:8px;background:#fff;color:#475467;padding:6px 10px;font:850 11px/1 inherit;cursor:pointer}
    .eq-placeholder{border:1.5px dashed #d0d5dd;border-radius:16px;background:#fff;min-height:320px;display:grid;place-items:center;text-align:center;padding:34px}
    .eq-crop-back{position:fixed;inset:0;z-index:2147483600;background:rgba(10,15,28,.78);display:grid;place-items:center;padding:20px}.eq-crop-modal{width:min(720px,100%);background:#fff;border-radius:16px;box-shadow:0 24px 70px rgba(0,0,0,.35);overflow:hidden}.eq-crop-head,.eq-crop-foot{display:flex;align-items:center;gap:10px;padding:14px 16px}.eq-crop-head{border-bottom:1px solid #e7eaf0}.eq-crop-head strong{flex:1}.eq-crop-body{padding:16px;background:#151922}.eq-crop-stage{width:min(640px,100%);aspect-ratio:4/3;margin:auto;overflow:hidden;cursor:grab;touch-action:none;background:#090b10}.eq-crop-stage:active{cursor:grabbing}.eq-crop-stage canvas{display:block;width:100%;height:100%}.eq-crop-tools{display:flex;align-items:center;gap:10px;padding:12px 16px;border-top:1px solid #e7eaf0;color:#667085;font-size:11px;font-weight:800}.eq-crop-tools input{flex:1}.eq-crop-foot{justify-content:flex-end;border-top:1px solid #e7eaf0}
    .eq-catalog-back{position:fixed;inset:0;z-index:2147483700;background:rgba(16,22,42,.5);display:grid;place-items:center;padding:18px;animation:eq-fade .16s ease both}.eq-catalog-modal{width:min(470px,100%);background:#fff;border-radius:16px;box-shadow:0 24px 70px rgba(16,24,40,.28);overflow:hidden;animation:eq-catalog-in .2s cubic-bezier(.22,1,.36,1) both}@keyframes eq-catalog-in{from{opacity:0;transform:translateY(10px) scale(.98)}to{opacity:1;transform:none}}.eq-catalog-body{padding:18px;display:grid;gap:14px}.eq-kind-options{display:grid;grid-template-columns:repeat(4,1fr);gap:7px}.eq-kind-options label{cursor:pointer}.eq-kind-options input{position:absolute;opacity:0;pointer-events:none}.eq-kind-options span{display:flex;flex-direction:column;align-items:center;justify-content:center;gap:7px;height:72px;border:1px solid #d0d5dd;border-radius:11px;color:#667085;font-size:10.5px;line-height:1.1;font-weight:850;text-align:center}.eq-kind-options span i{font-size:14px;line-height:1}.eq-kind-options input:checked+span{border-color:var(--primary-readable,var(--primary,#d93025));background:rgba(var(--primary-rgb,217,48,37),.07);color:var(--primary-readable,var(--primary,#d93025))}
    .eq-field.invalid input,.eq-field.invalid textarea{border-color:#d92d20!important;box-shadow:0 0 0 3px rgba(217,45,32,.1)!important}.eq-field-error{display:none;margin-top:6px;color:#b42318;font-size:11px;font-weight:800;align-items:center;gap:6px}.eq-field.invalid .eq-field-error,.eq-field-error.show{display:flex!important;animation:eq-error-in .22s cubic-bezier(.22,1,.36,1) both}@keyframes eq-error-in{0%{opacity:0;transform:translateY(-3px)}60%{transform:translateX(2px)}100%{opacity:1;transform:none}}.eq-catalog-modal.has-error{animation:eq-error-shake .26s ease both}@keyframes eq-error-shake{0%,100%{transform:none}25%{transform:translateX(-5px)}75%{transform:translateX(5px)}}.eq-foot-spacer{flex:1}.pac-container{z-index:2147483900!important}
    .eq-modal-error,.eq-form-error{display:none;border:1px solid #fda29b;border-radius:10px;background:#fef3f2;color:#b42318;padding:9px 11px;font-size:11px;font-weight:800;line-height:1.4;align-items:flex-start;gap:7px}.eq-modal-error.show,.eq-form-error.show{display:flex;animation:eq-error-in .22s ease both}.eq-form-error{grid-column:1/-1}
    @media(max-width:560px){.eq-grid{grid-template-columns:1fr}.eq-card{grid-template-columns:minmax(105px,35%) minmax(0,1fr)}.eq-unit-identity,.eq-inline-view-form .eq-unit-identity{grid-template-columns:120px minmax(0,1fr);gap:16px}.eq-form,.eq-dynamic-panel{grid-template-columns:1fr}.eq-field.wide,.eq-section-label,.eq-condition-list,.eq-condition-media{grid-column:1}.eq-name-color{grid-template-columns:minmax(0,1fr) 58px}.eq-kind-options{grid-template-columns:repeat(2,1fr)}}
  `;

  function injectCss(){
    if (document.getElementById('fmEquipmentAppCss')) return;
    const style = document.createElement('style');
    style.id = 'fmEquipmentAppCss';
    style.textContent = css;
    document.head.appendChild(style);
  }

  function statusChip(status){
    const meta = STATUS_META[clean(status)] || STATUS_META.available;
    return `<span class="eq-chip" style="background:${meta.bg};color:${meta.color}"><i class="fas ${meta.icon}"></i> ${esc(terminology(meta.term, meta.label))}</span>`;
  }

  function cardStatusSelect(unit){
    const current = clean(obj(unit).status) || 'available';
    const meta = STATUS_META[current] || STATUS_META.available;
    return `<span class="eq-card-status-wrap" style="background:${String(meta.bg)};color:${String(meta.color)}"><select class="eq-card-status" data-eq-card-status="${String(esc(obj(unit).id))}" aria-label="${((v3) => globalThis.PlatformLanguage?.htmlText("equipment","m_68e30b7c4cdf7c",`Status for ${v3}`,{v3}) ?? `Status for ${v3}`)(esc(obj(unit).name || 'unit'))}">${String(Object.entries(STATUS_META).filter(([key]) => key !== 'in_use' || current === 'in_use').map(([key, option]) => `<option value="${esc(key)}" ${current === key ? 'selected' : ''} ${key === 'in_use' ? 'disabled' : ''}>${esc(terminology(option.term, option.label))}</option>`).join(''))}</select><i class="fas fa-chevron-down"></i></span>`;
  }

  function mountEquipment(root, context = {}){
    injectCss();
    let destroyed = false;
    const organizationId = orgId(context);
    const costingOn = () => capabilityOn('equipment', 'costing');
    const state = {
      view:'fleet',
      units:null,
      types:null,
      categories:null,
      yards:null,
      loading:false,
      filters:{ query:'', typeId:'', categoryId:'', status:'' },
      drawer:null,       /* { mode:'view'|'edit'|'create', unit } */
      typesOpen:false,
      yardsOpen:false,
      typesShowArchived:false,
      yardsShowArchived:false,
      catalogEditor:null,
      archiveConfirm:null,
      photoClickTimer:null,
      crop:null,
      settingsHandle:null
    };

    const writeRoute = (history, patch, options = {}) => {
      if (Portal.navigation?.applying) return;
      Portal.navigation?.write?.({ tab:'equipment', ...patch }, { history, source:options.source || 'equipment', ownedKeys:options.ownedKeys || Object.keys(patch) });
    };

    const availableViews = () => {
      const views = [{ id:'fleet', icon:'fa-truck-pickup', label:terminology('equipment.fleet_view', 'Fleet') }];
      if (capabilityOn('equipment', 'scheduling')) views.push({ id:'timeline', icon:'fa-chart-gantt', label:terminology('equipment.timeline_view', 'Timeline') });
      if (capabilityOn('equipment', 'maintenance')) views.push({ id:'maintenance', icon:'fa-wrench', label:terminology('equipment.maintenance_view', 'Maintenance') });
      if (capabilityOn('equipment', 'costing')) views.push({ id:'utilization', icon:'fa-chart-column', label:terminology('equipment.utilization_view', 'Utilization') });
      views.push({ id:'settings', icon:'fa-gear', label:(globalThis.PlatformLanguage?.text("equipment","m_7d461dc7d355cc","Settings") ?? "Settings") });
      return views;
    };

    async function loadFleet(options = {}){
      if (state.loading && !options.force) return;
      state.loading = true;
      render();
      try {
        const [unitsResult, typesResult, categoriesResult, yardsResult] = await Promise.all([
          window.EquipmentAPI.units(organizationId, {
            typeId: state.filters.typeId,
            status: state.filters.status,
            query: state.filters.query
          }),
          state.types ? { types: state.types } : window.EquipmentAPI.types(organizationId),
          state.categories ? { categories: state.categories } : window.EquipmentAPI.categories(organizationId),
          state.yards ? { yards: state.yards } : window.EquipmentAPI.yards(organizationId)
        ]);
        if (destroyed) return;
        if (state.drawer && state.drawer.mode !== 'view') preserveDrawerDraft();
        state.units = arr(unitsResult.units);
        state.types = arr(typesResult.types);
        state.categories = arr(categoriesResult.categories);
        state.yards = arr(yardsResult.yards);
        if (state.filters.categoryId) {
          const typeIds = new Set(state.types.filter((type) => clean(type.category_id) === state.filters.categoryId).map((type) => clean(type.id)));
          state.units = state.units.filter((unit) => typeIds.has(clean(unit.type_id)));
        }
      } catch (error) {
        if (destroyed) return;
        state.units = [];
        showToast((globalThis.PlatformLanguage?.text("equipment","m_2813f320a63b94","Equipment") ?? "Equipment"), statusError(error, 'The fleet could not be loaded.'), false);
      }
      state.loading = false;
      render();
    }

    async function loadUtilization(){
      if (state.utilization?.loading) return;
      state.utilization = { loading:true };
      render();
      try {
        const result = await window.EquipmentAPI.utilization(organizationId);
        if (destroyed) return;
        state.utilization = { loading:false, ...result };
      } catch (error) {
        if (destroyed) return;
        state.utilization = { loading:false, error: statusError(error, 'Utilization could not be loaded.') };
      }
      render();
    }

    function utilizationHtml(){
      const data = state.utilization;
      if (!data || data.loading) return `<div class="eq-loading"><div><div class="eq-spinner"></div>${(globalThis.PlatformLanguage?.htmlText("equipment","m_a011562e78fc6c","Crunching utilization…") ?? "Crunching utilization…")}</div></div>`;
      if (data.error) return `<div class="eq-empty"><div><i class="fas fa-chart-column"></i><strong>${(globalThis.PlatformLanguage?.htmlText("equipment","m_df75f7ce73c51f","Utilization unavailable") ?? "Utilization unavailable")}</strong><p>${String(esc(data.error))}</p></div></div>`;
      const dollars = (cents) => `$${(Number(cents || 0) / 100).toLocaleString(undefined, { minimumFractionDigits: 2 })}`;
      const rows = arr(data.units);
      if (!rows.length) return `<div class="eq-empty"><div><i class="fas fa-chart-column"></i><strong>${(globalThis.PlatformLanguage?.htmlText("equipment","m_c180ae952a55b0","No utilization yet") ?? "No utilization yet")}</strong><p>${(globalThis.PlatformLanguage?.htmlText("equipment","m_807bcf642a7214","Book units on the schedule and this view compares booked vs. idle, costs, and rent-vs-own.") ?? "Book units on the schedule and this view compares booked vs. idle, costs, and rent-vs-own.")}</p></div></div>`;
      return `
        <div style="color:#667085;font-size:11.5px;font-weight:750;margin-bottom:10px">${((v0) => globalThis.PlatformLanguage?.htmlText("equipment","m_c3713163b695f1",`Last ${v0} days`,{v0}) ?? `Last ${v0} days`)(esc(String(data.window_days || 30)))}</div>
        <div style="border:1px solid #e4e7ec;border-radius:14px;background:#fff;overflow:auto">
          <table style="width:100%;border-collapse:collapse;font-size:12px">
            <thead><tr style="text-align:left;color:#667085;font-size:10.5px;text-transform:uppercase;letter-spacing:.05em">
              ${String(['Unit', 'Booked', 'Utilization', 'Downtime', 'Projected cost', 'Service', 'Fuel'].map((label) => `<th style="padding:11px 14px;border-bottom:1px solid #eef0f5">${esc(label)}</th>`).join(''))}
            </tr></thead>
            <tbody>
              ${String(rows.map((row) => `
                <tr>
                  <td style="padding:10px 14px;border-bottom:1px solid #f4f6f9;font-weight:850">${esc(row.name)}<div style="color:#98a2b3;font-size:10.5px;font-weight:750">${esc(row.type_name || '')}</div></td>
                  <td style="padding:10px 14px;border-bottom:1px solid #f4f6f9">${((v2,v3,v4) => globalThis.PlatformLanguage?.htmlText("equipment","m_9dcf532652aff4",`${v2} hrs · ${v3} booking${v4}`,{v2,v3,v4}) ?? `${v2} hrs · ${v3} booking${v4}`)(esc(String(row.booked_hours)),esc(String(row.bookings)),row.bookings === 1 ? '' : 's')}</td>
                  <td style="padding:10px 14px;border-bottom:1px solid #f4f6f9">
                    <div style="display:flex;align-items:center;gap:8px">
                      <div style="flex:0 0 90px;height:7px;border-radius:99px;background:#eef0f5;overflow:hidden"><i style="display:block;height:100%;width:${Math.min(100, Number(row.utilization_percent || 0))}%;background:var(--primary-readable,var(--primary,#d93025))"></i></div>
                      <span style="font-weight:850">${esc(String(row.utilization_percent))}%</span>
                    </div>
                  </td>
                  <td style="padding:10px 14px;border-bottom:1px solid #f4f6f9">${((v7) => globalThis.PlatformLanguage?.htmlText("equipment","m_c36ee4d32d5250",`${v7} hrs`,{v7}) ?? `${v7} hrs`)(esc(String(row.downtime_hours)))}</td>
                  <td style="padding:10px 14px;border-bottom:1px solid #f4f6f9">${esc(dollars(row.projected_cost_cents))}</td>
                  <td style="padding:10px 14px;border-bottom:1px solid #f4f6f9">${esc(dollars(row.service_cost_cents))}</td>
                  <td style="padding:10px 14px;border-bottom:1px solid #f4f6f9">${esc(dollars(row.fuel_cost_cents))}</td>
                </tr>`).join(''))}
            </tbody>
          </table>
        </div>`;
    }

    async function loadMaintenance(){
      if (state.maintenance?.loading) return;
      state.maintenance = { loading:true };
      render();
      try {
        const [due, orders, programs, unitsResult] = await Promise.all([
          window.EquipmentAPI.dueService(organizationId),
          window.EquipmentAPI.workOrders(organizationId),
          window.EquipmentAPI.servicePrograms(organizationId),
          state.units ? { units: state.units } : window.EquipmentAPI.units(organizationId)
        ]);
        if (destroyed) return;
        state.units = arr(unitsResult.units);
        state.maintenance = {
          loading:false,
          due: arr(due.due_service),
          orders: arr(orders.work_orders),
          programs: arr(programs.programs)
        };
      } catch (error) {
        if (destroyed) return;
        state.maintenance = { loading:false, error: statusError(error, 'Maintenance could not be loaded.') };
      }
      render();
    }

    function maintenanceHtml(){
      const data = state.maintenance;
      if (!data || data.loading) return `<div class="eq-loading"><div><div class="eq-spinner"></div>${(globalThis.PlatformLanguage?.htmlText("equipment","m_c8cddb1ba558cd","Loading maintenance…") ?? "Loading maintenance…")}</div></div>`;
      if (data.error) return `<div class="eq-empty"><div><i class="fas fa-wrench"></i><strong>${(globalThis.PlatformLanguage?.htmlText("equipment","m_ad03b2fb4f2eeb","Maintenance unavailable") ?? "Maintenance unavailable")}</strong><p>${String(esc(data.error))}</p></div></div>`;
      const unitName = (id) => clean(arr(state.units).find((unit) => clean(unit.id) === clean(id))?.name) || clean(id);
      const orderStatusChip = (status) => {
        const meta = {
          open: ['#93540c', '#fffaeb', 'Open'],
          scheduled: ['#175cd3', '#e8f0fe', 'Scheduled'],
          in_progress: ['#175cd3', '#e8f0fe', 'In progress'],
          completed: ['#12805c', '#e3f8ec', 'Completed'],
          canceled: ['#667085', '#f2f4f7', 'Canceled']
        }[clean(status)] || ['#667085', '#f2f4f7', clean(status) || 'Open'];
        return `<span class="eq-chip" style="color:${meta[0]};background:${meta[1]}">${esc(meta[2])}</span>`;
      };
      const activeOrders = arr(data.orders).filter((order) => !['completed', 'canceled'].includes(clean(order.status)));
      const closedOrders = arr(data.orders).filter((order) => ['completed', 'canceled'].includes(clean(order.status))).slice(0, 8);
      const orderRow = (order) => {
        const scheduling = clean(state.maintenanceSchedulingId) === clean(order.id);
        const actionable = !['completed', 'canceled'].includes(clean(order.status));
        return `
          <div class="eq-type-row" style="flex-wrap:wrap">
            <span class="eq-card-icon"><i class="fas ${clean(order.kind) === 'inspection' ? 'fa-clipboard-check' : 'fa-wrench'}"></i></span>
            <span class="eq-type-row-copy">
              <strong>${esc(order.title)}</strong>
              <span>${esc(unitName(order.unit_id))}${clean(order.scheduled_start_at) ? ` · ${esc(new Date(order.scheduled_start_at).toLocaleString([], { month:'short', day:'numeric', hour:'numeric', minute:'2-digit' }))}` : ''}</span>
            </span>
            ${orderStatusChip(order.status)}
            ${actionable ? `
              <button type="button" class="eq-mini" data-eq-wo-schedule="${String(esc(order.id))}"><i class="fas fa-calendar-plus"></i>${(globalThis.PlatformLanguage?.htmlText("equipment","m_80ce49ac8b6049"," Schedule") ?? " Schedule")}</button>
              <button type="button" class="eq-mini" data-eq-wo-complete="${String(esc(order.id))}"><i class="fas fa-check"></i>${(globalThis.PlatformLanguage?.htmlText("equipment","m_94c1150743bc9c"," Complete") ?? " Complete")}</button>
              <button type="button" class="eq-mini" data-eq-wo-cancel="${String(esc(order.id))}"><i class="fas fa-xmark"></i></button>` : ''}
            ${scheduling ? `
              <div style="flex-basis:100%;display:flex;gap:8px;align-items:center;margin-top:8px">
                <input type="datetime-local" class="eq-filter" data-eq-wo-start>
                <input type="datetime-local" class="eq-filter" data-eq-wo-end>
                <button type="button" class="eq-btn primary" data-eq-wo-schedule-save="${String(esc(order.id))}">${(globalThis.PlatformLanguage?.htmlText("equipment","m_5bab3e72de1ebf","Save") ?? "Save")}</button>
                <button type="button" class="eq-btn" data-eq-wo-schedule-cancel>${(globalThis.PlatformLanguage?.htmlText("equipment","m_cbef679b21abb4","Cancel") ?? "Cancel")}</button>
              </div>` : ''}
          </div>`;
      };
      return `
        <div style="display:grid;gap:16px">
          <div>
            <h3 style="margin:0 0 8px;font-size:14px"><i class="fas fa-bell" style="color:var(--primary-readable,var(--primary,#d93025))"></i>${(globalThis.PlatformLanguage?.htmlText("equipment","m_0cc9e4f8ed7068"," Due soon") ?? " Due soon")}</h3>
            <div class="eq-types-list">
              ${String(arr(data.due).map((entry) => `
                <div class="eq-type-row">
                  <span class="eq-card-icon" style="${entry.overdue ? 'background:#fef3f2;color:#b42318' : ''}"><i class="fas fa-triangle-exclamation"></i></span>
                  <span class="eq-type-row-copy">
                    <strong>${esc(entry.program_name)} — ${esc(entry.unit_name)}</strong>
                    <span>${esc(entry.detail)}</span>
                  </span>
                  <button type="button" class="eq-mini" data-eq-due-open="${esc(entry.unit_id)}::${esc(entry.program_id)}"><i class="fas fa-plus"></i> ${esc(terminology('equipment.work_order', 'Work Order'))}</button>
                </div>`).join('') || `<div class="eq-empty" style="min-height:100px"><div><strong>${(globalThis.PlatformLanguage?.htmlText("equipment","m_9dca7208c23ebd","Nothing due") ?? "Nothing due")}</strong><p>${(globalThis.PlatformLanguage?.htmlText("equipment","m_e7ed7f9a36d69f","Service programs surface here as units come due.") ?? "Service programs surface here as units come due.")}</p></div></div>`)}
            </div>
          </div>
          <div>
            <div style="display:flex;align-items:center;justify-content:space-between;margin:0 0 8px">
              <h3 style="margin:0;font-size:14px"><i class="fas fa-wrench" style="color:var(--primary-readable,var(--primary,#d93025))"></i> ${String(esc(terminology('equipment.work_orders', 'Work Orders')))}</h3>
              <button type="button" class="eq-btn" data-eq-wo-new><i class="fas fa-plus"></i>${(globalThis.PlatformLanguage?.htmlText("equipment","m_5fe01108f83039"," New") ?? " New")}</button>
            </div>
            <div class="eq-types-list">
              ${String(activeOrders.map(orderRow).join('') || `<div class="eq-empty" style="min-height:100px"><div><strong>${(globalThis.PlatformLanguage?.htmlText("equipment","m_e4c782cff2c193","No open work orders") ?? "No open work orders")}</strong><p>${(globalThis.PlatformLanguage?.htmlText("equipment","m_9e7d3c417a9f0a","Repairs and scheduled service live here.") ?? "Repairs and scheduled service live here.")}</p></div></div>`)}
              ${String(closedOrders.length ? `<div style="margin-top:6px;font-size:10.5px;font-weight:950;letter-spacing:.06em;text-transform:uppercase;color:#98a2b3">${(globalThis.PlatformLanguage?.htmlText("equipment","m_b062ab3bae8734","Recently closed") ?? "Recently closed")}</div>${closedOrders.map(orderRow).join('')}` : '')}
            </div>
          </div>
          <div>
            <div style="display:flex;align-items:center;justify-content:space-between;margin:0 0 8px">
              <h3 style="margin:0;font-size:14px"><i class="fas fa-arrows-rotate" style="color:var(--primary-readable,var(--primary,#d93025))"></i> ${String(esc(terminology('equipment.service_program', 'Service Program')))}s</h3>
              <button type="button" class="eq-btn" data-eq-program-new><i class="fas fa-plus"></i>${(globalThis.PlatformLanguage?.htmlText("equipment","m_5fe01108f83039"," New") ?? " New")}</button>
            </div>
            <div class="eq-types-list">
              ${String(arr(data.programs).map((program) => {
                const trigger = obj(program.trigger);
                const cadence = [trigger.every_days ? `every ${trigger.every_days} days` : '', trigger.every_meter_hours ? `every ${trigger.every_meter_hours} hrs` : '', trigger.every_meter_miles ? `every ${trigger.every_meter_miles} mi` : ''].filter(Boolean).join(' · ') || 'no trigger';
                return `
                  <div class="eq-type-row">
                    <span class="eq-card-icon"><i class="fas ${clean(program.kind) === 'inspection' ? 'fa-clipboard-check' : 'fa-arrows-rotate'}"></i></span>
                    <span class="eq-type-row-copy">
                      <strong>${esc(program.name)}</strong>
                      <span>${esc(cadence)}${clean(program.unit_id) ? ` · ${esc(unitName(program.unit_id))}` : (clean(program.type_id) ? ` · ${esc(clean(arr(state.types).find((type) => clean(type.id) === clean(program.type_id))?.name) || 'type')}` : ' · all units')}</span>
                    </span>
                    <button type="button" class="eq-mini" data-eq-program-archive="${esc(program.id)}"><i class="fas fa-box-archive"></i></button>
                  </div>`;
              }).join('') || `<div class="eq-empty" style="min-height:100px"><div><strong>${(globalThis.PlatformLanguage?.htmlText("equipment","m_64f0a4bd315670","No programs yet") ?? "No programs yet")}</strong><p>${(globalThis.PlatformLanguage?.htmlText("equipment","m_4ce644341d17a4","Programs generate due-service reminders by days or meter intervals.") ?? "Programs generate due-service reminders by days or meter intervals.")}</p></div></div>`)}
            </div>
          </div>
        </div>`;
    }

    function bindMaintenanceEvents(){
      root.querySelectorAll('[data-eq-due-open]').forEach((btn) => btn.addEventListener('click', async () => {
        const [unitId, programId] = String(btn.dataset.eqDueOpen || '').split('::');
        try {
          await window.EquipmentAPI.createWorkOrder(organizationId, { unit_id: clean(unitId), program_id: clean(programId) });
          showToast((globalThis.PlatformLanguage?.text("equipment","m_2813f320a63b94","Equipment") ?? "Equipment"), (globalThis.PlatformLanguage?.text("equipment","m_646cb6d45d3e4a","Work order opened.") ?? "Work order opened."), true);
          state.maintenance = null;
          void loadMaintenance();
        } catch (error) {
          showToast((globalThis.PlatformLanguage?.text("equipment","m_2813f320a63b94","Equipment") ?? "Equipment"), statusError(error, 'The work order could not be opened.'), false);
        }
      }));
      root.querySelector('[data-eq-wo-new]')?.addEventListener('click', async () => {
        const units = arr(state.units);
        if (!units.length) { showToast((globalThis.PlatformLanguage?.text("equipment","m_2813f320a63b94","Equipment") ?? "Equipment"), (globalThis.PlatformLanguage?.text("equipment","m_c04bcac4ab7f0a","Add a unit first.") ?? "Add a unit first."), false); return; }
        const name = clean(window.prompt(`Which unit needs work?\n${units.map((unit, index) => `${index + 1}. ${clean(unit.name)}`).join('\n')}\n\nEnter a number:`));
        const unit = units[Number(name) - 1];
        if (!unit) return;
        const title = clean(window.prompt((globalThis.PlatformLanguage?.text("equipment","m_44f3178d1bf5d9","Describe the work:") ?? "Describe the work:"), `Repair — ${clean(unit.name)}`));
        if (!title) return;
        try {
          await window.EquipmentAPI.createWorkOrder(organizationId, { unit_id: clean(unit.id), title });
          state.maintenance = null;
          void loadMaintenance();
        } catch (error) {
          showToast((globalThis.PlatformLanguage?.text("equipment","m_2813f320a63b94","Equipment") ?? "Equipment"), statusError(error, 'The work order could not be created.'), false);
        }
      });
      root.querySelectorAll('[data-eq-wo-schedule]').forEach((btn) => btn.addEventListener('click', () => {
        state.maintenanceSchedulingId = clean(state.maintenanceSchedulingId) === clean(btn.dataset.eqWoSchedule) ? '' : clean(btn.dataset.eqWoSchedule);
        render();
      }));
      root.querySelector('[data-eq-wo-schedule-cancel]')?.addEventListener('click', () => { state.maintenanceSchedulingId = ''; render(); });
      root.querySelectorAll('[data-eq-wo-schedule-save]').forEach((btn) => btn.addEventListener('click', async () => {
        const start = clean(root.querySelector('[data-eq-wo-start]')?.value);
        const end = clean(root.querySelector('[data-eq-wo-end]')?.value);
        if (!start || !end) { showToast((globalThis.PlatformLanguage?.text("equipment","m_2813f320a63b94","Equipment") ?? "Equipment"), (globalThis.PlatformLanguage?.text("equipment","m_257ca893b2d7f0","Pick a start and end.") ?? "Pick a start and end."), false); return; }
        try {
          await window.EquipmentAPI.scheduleWorkOrder(organizationId, btn.dataset.eqWoScheduleSave, {
            start_at: new Date(start).toISOString(),
            end_at: new Date(end).toISOString()
          });
          showToast((globalThis.PlatformLanguage?.text("equipment","m_2813f320a63b94","Equipment") ?? "Equipment"), (globalThis.PlatformLanguage?.text("equipment","m_742155863f91ab","Scheduled — the unit is blocked out for that window.") ?? "Scheduled — the unit is blocked out for that window."), true);
          state.maintenanceSchedulingId = '';
          state.maintenance = null;
          state.timeline = null;
          void loadMaintenance();
        } catch (error) {
          showToast((globalThis.PlatformLanguage?.text("equipment","m_2813f320a63b94","Equipment") ?? "Equipment"), statusError(error, 'The work order could not be scheduled.'), false);
        }
      }));
      root.querySelectorAll('[data-eq-wo-complete]').forEach((btn) => btn.addEventListener('click', async () => {
        const order = arr(state.maintenance?.orders).find((entry) => clean(entry.id) === clean(btn.dataset.eqWoComplete));
        if (!order) return;
        const hoursInput = clean(window.prompt((globalThis.PlatformLanguage?.text("equipment","m_f7dc0c58ee3d5a","Meter hours at service (leave blank to skip):") ?? "Meter hours at service (leave blank to skip):")));
        const hours = Number(hoursInput);
        try {
          const result = await window.EquipmentAPI.completeWorkOrder(organizationId, clean(order.id), {
            ...(hoursInput && Number.isFinite(hours) && hours > 0 ? { meter_at_service: { hours } } : {})
          });
          showToast((globalThis.PlatformLanguage?.text("equipment","m_2813f320a63b94","Equipment") ?? "Equipment"), result.repair_order ? 'Completed — a repair order was opened for failed items.' : 'Work order completed.', true);
          state.maintenance = null;
          state.timeline = null;
          void loadMaintenance();
        } catch (error) {
          showToast((globalThis.PlatformLanguage?.text("equipment","m_2813f320a63b94","Equipment") ?? "Equipment"), statusError(error, 'The work order could not be completed.'), false);
        }
      }));
      root.querySelectorAll('[data-eq-wo-cancel]').forEach((btn) => btn.addEventListener('click', async () => {
        if (!window.confirm((globalThis.PlatformLanguage?.text("equipment","m_0fb6684b7af2d9","Cancel this work order? Any downtime block is released.") ?? "Cancel this work order? Any downtime block is released."))) return;
        try {
          await window.EquipmentAPI.cancelWorkOrder(organizationId, btn.dataset.eqWoCancel);
          state.maintenance = null;
          state.timeline = null;
          void loadMaintenance();
        } catch (error) {
          showToast((globalThis.PlatformLanguage?.text("equipment","m_2813f320a63b94","Equipment") ?? "Equipment"), statusError(error, 'The work order could not be canceled.'), false);
        }
      }));
      root.querySelector('[data-eq-program-new]')?.addEventListener('click', async () => {
        const name = clean(window.prompt((globalThis.PlatformLanguage?.text("equipment","m_62881eb7330dbd","Name the service program (e.g. \"250-hour service\"):") ?? "Name the service program (e.g. \"250-hour service\"):")));
        if (!name) return;
        const days = Number(clean(window.prompt((globalThis.PlatformLanguage?.text("equipment","m_db0d33f8908760","Repeat every how many days? (blank for meter-based only)") ?? "Repeat every how many days? (blank for meter-based only)"))) || 0);
        const hours = Number(clean(window.prompt((globalThis.PlatformLanguage?.text("equipment","m_5c4b86fbc16685","Or every how many meter hours? (blank to skip)") ?? "Or every how many meter hours? (blank to skip)"))) || 0);
        try {
          await window.EquipmentAPI.createProgram(organizationId, {
            name,
            trigger: { ...(days > 0 ? { every_days: days } : {}), ...(hours > 0 ? { every_meter_hours: hours } : {}) }
          });
          state.maintenance = null;
          void loadMaintenance();
        } catch (error) {
          showToast((globalThis.PlatformLanguage?.text("equipment","m_2813f320a63b94","Equipment") ?? "Equipment"), statusError(error, 'The program could not be created.'), false);
        }
      });
      root.querySelectorAll('[data-eq-program-archive]').forEach((btn) => btn.addEventListener('click', async () => {
        const program = arr(state.maintenance?.programs).find((entry) => clean(entry.id) === clean(btn.dataset.eqProgramArchive));
        if (!program || !window.confirm(((v0) => globalThis.PlatformLanguage?.text("equipment","m_ec454a178a180b",`Archive "${v0}"?`,{v0}) ?? `Archive "${v0}"?`)(clean(program.name)))) return;
        try {
          await window.EquipmentAPI.saveProgram(organizationId, clean(program.id), { name: clean(program.name), status: 'archived', expected_revision: Number(program.revision || 0) || undefined });
          state.maintenance = null;
          void loadMaintenance();
        } catch (error) {
          showToast((globalThis.PlatformLanguage?.text("equipment","m_2813f320a63b94","Equipment") ?? "Equipment"), statusError(error, 'The program could not be archived.'), false);
        }
      }));
    }

    async function loadTimeline(){
      const Scheduling = window.PlatformScheduling;
      if (!Scheduling || state.timeline?.loading) return;
      state.timeline = { loading:true };
      render();
      try {
        const [config, unitsResult] = await Promise.all([
          Scheduling.loadBranchConfig ? Scheduling.loadBranchConfig(organizationId, 'default').catch(() => null) : null,
          state.units ? { units: state.units } : window.EquipmentAPI.units(organizationId)
        ]);
        const timelineProjects = await (Scheduling.listProjects ? Scheduling.listProjects(organizationId, config).catch(() => []) : []);
        if (destroyed) return;
        state.units = arr(unitsResult.units);
        const allEvents = Scheduling.eventsFromProjects ? Scheduling.eventsFromProjects(timelineProjects, config || {}) : [];
        state.timeline = {
          loading:false,
          config,
          projects: timelineProjects,
          events: allEvents.filter((event) => (Scheduling.eventEquipmentRefs?.(event) || []).length || clean(event.kind) === 'equipment_downtime')
        };
      } catch (error) {
        if (destroyed) return;
        state.timeline = { loading:false, error: statusError(error, 'The timeline could not be loaded.') };
      }
      render();
    }

    function mountTimeline(){
      const mountEl = root.querySelector('[data-eq-timeline]');
      const Scheduling = window.PlatformScheduling;
      const ScheduleView = window.PlatformScheduleView;
      if (!mountEl || !Scheduling || !ScheduleView?.renderGanttScheduler || !state.timeline || state.timeline.loading) return;
      ScheduleView.renderGanttScheduler(mountEl, {
        Scheduling,
        config: state.timeline.config,
        events: state.timeline.events || [],
        groupBy: 'resource',
        showEmptyResources: true,
        resources: arr(state.units).map((unit) => ({ kind:'equipment_unit', id:clean(unit.id), name:clean(unit.name), icon:clean(unit.type_icon) || 'fa-truck-pickup' })),
        resourceHeader: terminology('equipment.equipment_unit', 'Unit'),
        modeLabel: terminology('equipment.timeline_view', 'Timeline'),
        unassignedLabel: 'Unassigned equipment events',
        emptyLabel: 'No equipment on the schedule yet. Assign units to events from the schedulers, or add equipment to a scope.',
        onEventRangeChange(event, range){
          const project = arr(state.timeline.projects).find((item) => clean(item.id) === clean(event.project_id));
          if (!project) return;
          const next = { ...event, ...(Scheduling.updateProjectEventRange ? Scheduling.updateProjectEventRange(event, range) : range), status:'scheduled' };
          Scheduling.saveProjectEvent(organizationId, project, next, state.timeline.config)
            .then((saved) => {
              const conflicts = arr(saved?.equipment_conflicts);
              if (conflicts.length) showToast((globalThis.PlatformLanguage?.text("equipment","m_7ccde50eeb747e","Equipment conflict") ?? "Equipment conflict"), conflicts[0]?.message || 'This unit is booked elsewhere in that window.', false);
              return loadTimeline();
            })
            .catch((error) => {
              showToast((globalThis.PlatformLanguage?.text("equipment","m_2813f320a63b94","Equipment") ?? "Equipment"), statusError(error, 'The event could not be moved.'), false);
              void loadTimeline();
            });
        }
      });
    }

    async function openUnit(unitId, options = {}){
      const existing = arr(state.units).find((unit) => clean(unit.id) === clean(unitId));
      state.drawer = { mode: options.mode || 'view', unit: existing || null, loading: !existing };
      if (options.push) writeRoute('push', { equipmentItem: clean(unitId) }, { ownedKeys:['equipmentItem'] });
      render();
      try {
        const result = await window.EquipmentAPI.unit(organizationId, unitId);
        if (destroyed || !state.drawer) return;
        state.drawer.unit = { ...(existing || {}), ...obj(result.unit) };
        state.drawer.loading = false;
        render();
      } catch (error) {
        if (destroyed) return;
        state.drawer = null;
        render();
        showToast((globalThis.PlatformLanguage?.text("equipment","m_2813f320a63b94","Equipment") ?? "Equipment"), statusError(error, 'The unit could not be opened.'), false);
      }
    }

    function closeDrawer(options = {}){
      if (!state.drawer) return;
      state.drawer = null;
      if (options.route !== false) writeRoute('replace', { equipmentItem:'' }, { ownedKeys:['equipmentItem'] });
      render();
    }

    const mediaReferenceUrl = (reference, variant = 'original') => {
      const mediaId = clean(obj(reference).media_id || obj(reference).id);
      if (mediaId && window.PlatformAPI?.media?.fileUrl) return window.PlatformAPI.media.fileUrl(organizationId, mediaId, variant);
      return clean(obj(reference).src || obj(reference).url);
    };
    const primaryPhoto = (unit) => arr(obj(unit).photos)[0] || null;
    const driverRequirementId = (unit) => clean(arr(obj(unit).operator_tag_overrides)[0]?.tag_id);
    const driverRequirement = (id) => {
      const entry = DRIVER_REQUIREMENTS.find(([value]) => value === clean(id));
      return entry && entry[0] ? [{ tag_id:entry[0], label:entry[1] }] : [];
    };
    const moneyCents = (value) => {
      const dollars = Number(value);
      return Number.isFinite(dollars) && dollars > 0 ? Math.round(dollars * 100) : 0;
    };
    const yardLocation = (yardId) => {
      const yard = arr(state.yards).find((entry) => clean(entry.id) === clean(yardId));
      return yard ? { kind:'yard', yard_id:clean(yard.id), label:clean(yard.name), address:obj(yard.address) } : {};
    };

    function drawerFormValues(container){
      const read = (name) => clean(container.querySelector(`[data-eq-input="${name}"]`)?.value);
      const ownership = read('ownership') || 'owned';
      const yard = yardLocation(read('yard_id'));
      const currentUnit = obj(state.drawer?.unit);
      const currentAcquisition = obj(currentUnit.acquisition);
      const pickup = obj(currentAcquisition.pickup_condition);
      const acquisition = ownership === 'owned'
        ? { kind:'owned', procurement_date:read('procurement_date'), estimated_value_cents:moneyCents(read('estimated_value')) }
        : ownership === 'leased'
          ? { kind:'leased', procurement_date:read('procurement_date'), lease_term_months:Number(read('lease_term_months')) || 0, monthly_cost_cents:moneyCents(read('lease_monthly_cost')) }
          : {
              kind:'rented', rental_date:read('rental_date'), pickup_time:read('pickup_time'), return_date:read('return_date'), return_time:read('return_time'), rental_cost_cents:moneyCents(read('rental_cost')),
              pickup_condition:{
                date:read('rental_date'), time:read('pickup_time'), return_date:read('return_date'), return_time:read('return_time'),
                notes:[...container.querySelectorAll('[data-eq-pickup-note]')].map((input) => clean(input.value)).filter(Boolean),
                media:arr(pickup.media)
              }
            };
      const values = {
        name: read('name'),
        type_id: read('type_id'),
        identifier: read('identifier'),
        serial_number: read('serial_number'),
        license_plate: read('license_plate'),
        year: read('year'),
        make: read('make'),
        model: read('model'),
        vin: read('vin'),
        color: read('color'),
        ownership,
        acquisition,
        status: state.drawer?.mode === 'create' ? 'available' : (read('status') || clean(currentUnit.status) || 'available'),
        operator_tag_overrides:driverRequirement(read('driver_requirement')),
        photos:arr(currentUnit.photos),
        notes: read('notes'),
        location:Object.keys(yard).length ? yard : obj(currentUnit.location),
        home_location:Object.keys(yard).length ? yard : obj(currentUnit.home_location)
      };
      return values;
    }

    function preserveDrawerDraft(container = root){
      if (!state.drawer || state.drawer.loading) return;
      state.drawer.unit = { ...obj(state.drawer.unit), ...drawerFormValues(container) };
    }

    const activeRecords = (records) => arr(records).filter((entry) => clean(entry.status || 'active') !== 'archived');

    function clearCatalogFieldError(input){
      input?.closest('.eq-field')?.classList.remove('invalid');
      root.querySelector('.eq-catalog-modal')?.classList.remove('has-error');
      root.querySelector('[data-eq-catalog-save-error]')?.classList.remove('show');
    }

    function showCatalogFieldError(input, message){
      const field = input?.closest('.eq-field');
      if (!field) return;
      field.classList.add('invalid');
      const error = field.querySelector('[data-eq-field-error]');
      if (error) error.innerHTML = `<i class="fas fa-circle-exclamation"></i> ${esc(message)}`;
      const modal = root.querySelector('.eq-catalog-modal');
      modal?.classList.remove('has-error');
      void modal?.offsetWidth;
      modal?.classList.add('has-error');
      input.focus();
    }

    function showCatalogSaveError(message){
      const error = root.querySelector('[data-eq-catalog-save-error]');
      if (!error) return;
      error.innerHTML = `<i class="fas fa-circle-exclamation"></i><span>${esc(message)}</span>`;
      error.classList.add('show');
      const modal = root.querySelector('.eq-catalog-modal');
      modal?.classList.remove('has-error');
      void modal?.offsetWidth;
      modal?.classList.add('has-error');
    }

    function catalogAddressComponents(components){
      const parsed = { street_number:'', route:'', city:'', state:'', state_short:'', postal_code:'', country:'' };
      arr(components).forEach((part) => {
        const types = arr(part.types);
        if (types.includes('street_number')) parsed.street_number = clean(part.long_name);
        if (types.includes('route')) parsed.route = clean(part.long_name);
        if (types.includes('locality')) parsed.city = clean(part.long_name);
        if (types.includes('postal_town') && !parsed.city) parsed.city = clean(part.long_name);
        if (types.includes('administrative_area_level_1')) { parsed.state = clean(part.long_name); parsed.state_short = clean(part.short_name); }
        if (types.includes('postal_code')) parsed.postal_code = clean(part.long_name);
        if (types.includes('country')) parsed.country = clean(part.short_name || part.long_name);
      });
      return parsed;
    }

    function initCatalogAddressAutocomplete(attempt = 0){
      const editor = state.catalogEditor;
      const input = root.querySelector('[data-eq-catalog-address]');
      if (!editor || editor.kind !== 'yard' || !input) return;
      if (!window.google?.maps?.places?.Autocomplete) {
        if (attempt < 50) editor.googleTimer = window.setTimeout(() => initCatalogAddressAutocomplete(attempt + 1), 120);
        return;
      }
      editor.autocomplete = new window.google.maps.places.Autocomplete(input, {
        fields:['formatted_address', 'geometry', 'address_components'],
        strictBounds:false,
        types:['address']
      });
      editor.autocomplete.addListener('place_changed', () => {
        const place = editor.autocomplete.getPlace() || {};
        if (!place.geometry?.location || !clean(place.formatted_address)) {
          editor.addressSelected = false;
          showCatalogFieldError(input, 'Choose an address from the Google suggestions.');
          return;
        }
        const formatted = clean(place.formatted_address);
        input.value = formatted;
        editor.addressSelected = true;
        editor.address = {
          formatted,
          lat:Number(place.geometry.location.lat()),
          lng:Number(place.geometry.location.lng()),
          components:catalogAddressComponents(place.address_components)
        };
        clearCatalogFieldError(input);
      });
    }

    function closeCatalogEditor(){
      const editor = state.catalogEditor;
      if (!editor || editor.saving) return;
      if (editor.googleTimer) window.clearTimeout(editor.googleTimer);
      try { if (editor.autocomplete) window.google?.maps?.event?.clearInstanceListeners?.(editor.autocomplete); } catch (_) {}
      state.catalogEditor = null;
      root.querySelector('[data-eq-catalog-back]')?.remove();
    }

    function bindCatalogEditorEvents(){
      const catalogBack = root.querySelector('[data-eq-catalog-back]');
      catalogBack?.addEventListener('mousedown', (event) => { if (event.target === catalogBack) closeCatalogEditor(); });
      root.querySelectorAll('[data-eq-catalog-cancel]').forEach((button) => button.addEventListener('click', closeCatalogEditor));
      root.querySelector('[data-eq-catalog-save]')?.addEventListener('click', () => void saveCatalogEditor());
      root.querySelector('[data-eq-catalog-name]')?.addEventListener('input', (event) => clearCatalogFieldError(event.currentTarget));
      root.querySelector('[data-eq-catalog-name]')?.addEventListener('keydown', (event) => { if (event.key === 'Enter') { event.preventDefault(); void saveCatalogEditor(); } });
      root.querySelector('[data-eq-catalog-address]')?.addEventListener('input', (event) => {
        if (state.catalogEditor) { state.catalogEditor.addressSelected = false; state.catalogEditor.address = null; }
        clearCatalogFieldError(event.currentTarget);
      });
      if (state.catalogEditor?.kind === 'yard') initCatalogAddressAutocomplete();
    }

    function mountCatalogEditor(){
      root.querySelector('[data-eq-catalog-back]')?.remove();
      root.querySelector('.eq-shell')?.insertAdjacentHTML('beforeend', catalogEditorHtml());
      bindCatalogEditorEvents();
      root.querySelector('[data-eq-catalog-name]')?.focus();
    }

    function openCatalogEditor(kind, source, entity = null){
      if (source === 'drawer') preserveDrawerDraft();
      if (source === 'drawer' && state.drawer) {
        if (kind === 'type') {
          state.drawer.unit.type_id = clean(state.drawer.unit.type_id) === '__new__' ? '' : clean(state.drawer.unit.type_id);
          const select = root.querySelector('[data-eq-input="type_id"]'); if (select) select.value = clean(state.drawer.unit.type_id);
        } else {
          const selectedId = clean(obj(state.drawer.unit.home_location).yard_id || obj(state.drawer.unit.location).yard_id);
          const select = root.querySelector('[data-eq-input="yard_id"]'); if (select) select.value = selectedId;
        }
      }
      state.catalogEditor = { kind, source, entity:entity ? { ...entity } : null, saving:false, addressSelected:Boolean(clean(obj(entity?.address).formatted)), address:entity ? { ...obj(entity.address) } : null };
      mountCatalogEditor();
    }

    async function saveCatalogEditor(){
      const editor = state.catalogEditor;
      if (!editor || editor.saving) return;
      const nameInput = root.querySelector('[data-eq-catalog-name]');
      const name = clean(nameInput?.value);
      if (!name) { showCatalogFieldError(nameInput, 'Name is required.'); return; }
      const selectedKind = clean(root.querySelector('[data-eq-catalog-kind]:checked')?.value) || 'other';
      const addressInput = root.querySelector('[data-eq-catalog-address]');
      const formatted = clean(addressInput?.value);
      if (editor.kind === 'yard' && formatted && !editor.addressSelected) { showCatalogFieldError(addressInput, 'Choose an address from the Google suggestions.'); return; }
      const accessInstructions = clean(root.querySelector('[data-eq-catalog-access]')?.value);
      editor.name = name;
      editor.selectedKind = selectedKind;
      editor.formatted = formatted;
      editor.saving = true;
      const saveButton = root.querySelector('[data-eq-catalog-save]');
      if (saveButton) { saveButton.disabled = true; saveButton.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Saving…'; }
      let savedEntity = null;
      try {
        if (editor.kind === 'type') {
          const result = editor.entity
            ? await window.EquipmentAPI.saveType(organizationId, clean(editor.entity.id), { ...editor.entity, name, kind:selectedKind, expected_revision:Number(editor.entity.revision || 0) || undefined })
            : await window.EquipmentAPI.createType(organizationId, { name, kind:selectedKind });
          savedEntity = obj(result.type);
        } else {
          const address = formatted ? { ...obj(editor.address), formatted, access_instructions:accessInstructions } : (accessInstructions ? { access_instructions:accessInstructions } : {});
          const result = editor.entity
            ? await window.EquipmentAPI.saveYard(organizationId, clean(editor.entity.id), { name, address, expected_revision:Number(editor.entity.revision || 0) || undefined })
            : await window.EquipmentAPI.createYard(organizationId, { name, address });
          savedEntity = obj(result.yard);
        }
      } catch (error) {
        editor.saving = false;
        if (saveButton) { saveButton.disabled = false; saveButton.innerHTML = '<i class="fas fa-check"></i> Save'; }
        showCatalogSaveError(statusError(error, `The ${editor.kind === 'type' ? 'equipment type' : 'facility'} could not be saved.`));
        return;
      }

      try {
        if (editor.kind === 'type') {
          const type = savedEntity;
          state.types = editor.entity
            ? arr(state.types).map((entry) => clean(entry.id) === clean(type.id) ? type : entry)
            : [...arr(state.types), type];
          state.types.sort((a, b) => clean(a.name).localeCompare(clean(b.name)));
          if (editor.source === 'drawer' && state.drawer) state.drawer.unit.type_id = clean(type.id);
        } else {
          const yard = savedEntity;
          state.yards = editor.entity
            ? arr(state.yards).map((entry) => clean(entry.id) === clean(yard.id) ? yard : entry)
            : [...arr(state.yards), yard];
          state.yards.sort((a, b) => clean(a.name).localeCompare(clean(b.name)));
          if (editor.source === 'drawer' && state.drawer) {
            const location = yardLocation(yard.id);
            state.drawer.unit.location = location;
            state.drawer.unit.home_location = location;
          }
        }
        editor.saving = false;
        closeCatalogEditor();
        render();
      } catch (error) {
        // The server already accepted the save. Always close the editor so a
        // presentation refresh cannot make a successful save look unfinished.
        editor.saving = false;
        closeCatalogEditor();
        render();
        showToast((globalThis.PlatformLanguage?.text("equipment","m_2813f320a63b94","Equipment") ?? "Equipment"), (globalThis.PlatformLanguage?.text("equipment","m_cf448ec021a0be","Saved, but the list could not refresh cleanly. Reload to see the latest data.") ?? "Saved, but the list could not refresh cleanly. Reload to see the latest data."), false);
      }
    }

    async function uploadMediaFile(file, options = {}){
      if (!window.PlatformAPI?.media?.upload) throw new Error('The media library is unavailable.');
      const result = await window.PlatformAPI.media.upload(organizationId, file, {
        ownerType:'equipment_unit', ownerId:clean(state.drawer?.unit?.id) || 'new', collection:'equipment',
        slot:options.slot || 'unit_media', thumbnails:true,
        compression:file.type?.startsWith('image/') ? { quality:0.9, max_width:2400, max_height:2400 } : undefined,
        metadata:{ source:'equipment_unit_adder', role:options.role || 'attachment' }
      });
      return window.PlatformAPI.media.referenceFromUpload(result, { role:options.role || 'attachment' });
    }

    function chooseUnitPhoto(){
      preserveDrawerDraft();
      const picker = document.createElement('input');
      picker.type = 'file';
      picker.accept = 'image/*';
      picker.addEventListener('change', () => { const file = picker.files?.[0]; if (file) openPhotoCrop(file); });
      picker.click();
    }

    async function recropUnitPhoto(){
      const photo = primaryPhoto(state.drawer?.unit);
      const src = photo ? mediaReferenceUrl(photo, 'original') : '';
      if (!src) { chooseUnitPhoto(); return; }
      preserveDrawerDraft();
      try {
        const response = await fetch(src, { credentials:'same-origin' });
        if (!response.ok) throw new Error('The photo could not be loaded.');
        const blob = await response.blob();
        openPhotoCrop(new File([blob], clean(obj(photo).filename) || 'equipment-photo.jpg', { type:blob.type || 'image/jpeg' }));
      } catch (error) {
        showToast((globalThis.PlatformLanguage?.text("equipment","m_e1f0cb34a46b5b","Unit photo") ?? "Unit photo"), statusError(error, 'The photo could not be opened for cropping.'), false);
      }
    }

    function openPhotoCrop(file){
      if (!file || !clean(file.type).startsWith('image/')) return;
      if (state.crop?.url) URL.revokeObjectURL(state.crop.url);
      state.crop = { file, url:URL.createObjectURL(file), image:null, zoom:1, focusX:.5, focusY:.5, dragging:false, lastX:0, lastY:0, saving:false };
      render();
    }

    function closePhotoCrop(){
      if (state.crop?.url) URL.revokeObjectURL(state.crop.url);
      state.crop = null;
      render();
    }

    function drawPhotoCrop(){
      const crop = state.crop;
      const canvas = root.querySelector('[data-eq-crop-canvas]');
      if (!crop || !canvas) return;
      const context2d = canvas.getContext('2d');
      const paint = () => {
        if (!crop.image?.naturalWidth) return;
        const width = canvas.width;
        const height = canvas.height;
        const scale = Math.max(width / crop.image.naturalWidth, height / crop.image.naturalHeight) * crop.zoom;
        const drawWidth = crop.image.naturalWidth * scale;
        const drawHeight = crop.image.naturalHeight * scale;
        const x = (width - drawWidth) * crop.focusX;
        const y = (height - drawHeight) * crop.focusY;
        context2d.clearRect(0, 0, width, height);
        context2d.drawImage(crop.image, x, y, drawWidth, drawHeight);
      };
      if (crop.image) { paint(); return; }
      const image = new Image();
      image.onload = () => { crop.image = image; paint(); };
      image.src = crop.url;
    }

    async function applyPhotoCrop(){
      const crop = state.crop;
      const canvas = root.querySelector('[data-eq-crop-canvas]');
      if (!crop || !canvas || crop.saving) return;
      if (!crop.image?.naturalWidth) { showToast((globalThis.PlatformLanguage?.text("equipment","m_c4ed9ae29130ca","Equipment photo") ?? "Equipment photo"), (globalThis.PlatformLanguage?.text("equipment","m_33ac2016ac6198","The photo is still loading. Try again in a moment.") ?? "The photo is still loading. Try again in a moment."), false); return; }
      crop.saving = true;
      root.querySelector('[data-eq-crop-apply]')?.setAttribute('disabled', '');
      try {
        const blob = await new Promise((resolve, reject) => canvas.toBlob((value) => value ? resolve(value) : reject(new Error('Could not crop the image.')), 'image/jpeg', .9));
        const baseName = clean(crop.file.name).replace(/\.[^.]+$/, '') || 'equipment';
        const reference = await uploadMediaFile(new File([blob], `${baseName}-cropped.jpg`, { type:'image/jpeg' }), { slot:'unit_photo', role:'primary' });
        state.drawer.unit = { ...obj(state.drawer?.unit), photos:[reference] };
        if (crop.url) URL.revokeObjectURL(crop.url);
        state.crop = null;
        render();
      } catch (error) {
        crop.saving = false;
        showToast((globalThis.PlatformLanguage?.text("equipment","m_c4ed9ae29130ca","Equipment photo") ?? "Equipment photo"), statusError(error, 'The photo could not be uploaded.'), false);
        render();
      }
    }

    function cropHtml(){
      if (!state.crop) return '';
      return `<div class="eq-crop-back" data-eq-crop-back>
        <div class="eq-crop-modal" role="dialog" aria-modal="true" aria-label="${(globalThis.PlatformLanguage?.htmlText("equipment","m_b52de3b6c09007","Crop equipment photo") ?? "Crop equipment photo")}">
          <div class="eq-crop-head"><strong>${(globalThis.PlatformLanguage?.htmlText("equipment","m_9c6af7bfdf7c5a","Crop unit photo") ?? "Crop unit photo")}</strong><button type="button" class="eq-drawer-close" data-eq-crop-close><i class="fas fa-xmark"></i></button></div>
          <div class="eq-crop-body"><div class="eq-crop-stage" data-eq-crop-stage><canvas width="640" height="480" data-eq-crop-canvas></canvas></div></div>
          <div class="eq-crop-tools"><i class="fas fa-image"></i><input type="range" min="1" max="3" step="0.01" value="${String(Number(state.crop.zoom || 1))}" data-eq-crop-zoom><i class="fas fa-magnifying-glass-plus"></i><span>${(globalThis.PlatformLanguage?.htmlText("equipment","m_766e52b36ba38b","Drag to reposition") ?? "Drag to reposition")}</span></div>
          <div class="eq-crop-foot"><button type="button" class="eq-btn" data-eq-crop-close>${(globalThis.PlatformLanguage?.htmlText("equipment","m_cbef679b21abb4","Cancel") ?? "Cancel")}</button><button type="button" class="eq-btn primary" data-eq-crop-apply ${String(state.crop.saving ? 'disabled' : '')}><i class="fas ${String(state.crop.saving ? 'fa-circle-notch fa-spin' : 'fa-crop-simple')}"></i> ${String(state.crop.saving ? 'Uploading…' : 'Use photo')}</button></div>
        </div></div>`;
    }

    function clearUnitValidation(container){
      container.querySelectorAll('.eq-field.invalid').forEach((field) => field.classList.remove('invalid'));
      container.querySelectorAll('[data-eq-unit-field-error].show').forEach((error) => error.classList.remove('show'));
      container.querySelector('[data-eq-unit-form-error]')?.classList.remove('show');
    }

    function showUnitFieldError(container, name, message){
      const input = container.querySelector(`[data-eq-input="${name}"]`);
      const field = input?.closest('.eq-field');
      if (!input || !field) return;
      field.classList.add('invalid');
      const error = field.querySelector(`[data-eq-unit-field-error="${name}"]`);
      if (error) {
        error.innerHTML = `<i class="fas fa-circle-exclamation"></i> ${esc(message)}`;
        error.classList.add('show');
      }
      input.setAttribute('aria-invalid', 'true');
      input.scrollIntoView?.({ block:'center', behavior:'smooth' });
      input.focus();
    }

    function showUnitFormError(container, message){
      const error = container.querySelector('[data-eq-unit-form-error]');
      if (!error) return;
      error.innerHTML = `<i class="fas fa-circle-exclamation"></i><span>${esc(message)}</span>`;
      error.classList.add('show');
      error.scrollIntoView?.({ block:'center', behavior:'smooth' });
    }

    async function saveDrawer(container){
      const drawer = state.drawer;
      if (!drawer) return;
      clearUnitValidation(container);
      const values = drawerFormValues(container);
      if (!values.name) {
        showUnitFormError(container, 'Complete the required field below.');
        showUnitFieldError(container, 'name', 'Unit name is required.');
        return;
      }
      const saveButton = container.querySelector('[data-eq-drawer-save]');
      if (saveButton) { saveButton.disabled = true; saveButton.innerHTML = `<i class="fas fa-spinner fa-spin"></i> ${drawer.mode === 'create' ? 'Adding…' : 'Saving…'}`; }
      try {
        if (drawer.mode === 'create') {
          const created = await window.EquipmentAPI.createUnit(organizationId, values);
          showToast((globalThis.PlatformLanguage?.text("equipment","m_2813f320a63b94","Equipment") ?? "Equipment"), ((v0) => globalThis.PlatformLanguage?.text("equipment","m_c2086e15c86bc9",`"${v0}" was added to the fleet.`,{v0}) ?? `"${v0}" was added to the fleet.`)(clean(created.unit?.name)), true);
          state.drawer = null;
          writeRoute('replace', { equipmentItem:'' }, { ownedKeys:['equipmentItem'] });
          await loadFleet({ force:true });
        } else {
          const result = await window.EquipmentAPI.saveUnit(organizationId, clean(drawer.unit?.id), {
            ...values,
            expected_revision: Number(drawer.unit?.revision || 0) || undefined
          });
          const savedUnit = { ...obj(drawer.unit), ...obj(result.unit) };
          state.drawer.unit = savedUnit;
          state.drawer.mode = 'view';
          state.units = arr(state.units).map((unit) => clean(unit.id) === clean(savedUnit.id) ? { ...unit, ...savedUnit } : unit);
          showToast((globalThis.PlatformLanguage?.text("equipment","m_2813f320a63b94","Equipment") ?? "Equipment"), (globalThis.PlatformLanguage?.text("equipment","m_813887aa38f3e9","Unit saved.") ?? "Unit saved."), true);
          render();
        }
      } catch (error) {
        const message = statusError(error, 'The unit could not be saved.');
        if (saveButton) { saveButton.disabled = false; saveButton.innerHTML = `<i class="fas fa-check"></i> ${drawer.mode === 'create' ? 'Add unit' : 'Save changes'}`; }
        showUnitFormError(container, message);
        showToast((globalThis.PlatformLanguage?.text("equipment","m_2813f320a63b94","Equipment") ?? "Equipment"), message, false);
      }
    }

    async function updateCardStatus(unitId, status, select){
      const unit = arr(state.units).find((entry) => clean(entry.id) === clean(unitId));
      if (!unit || !STATUS_META[clean(status)] || clean(status) === 'in_use') return;
      const previous = clean(unit.status) || 'available';
      select.disabled = true;
      try {
        const result = await window.EquipmentAPI.saveUnit(organizationId, clean(unit.id), {
          status:clean(status),
          expected_revision:Number(unit.revision || 0) || undefined
        });
        const savedUnit = { ...unit, ...obj(result.unit), status:clean(status) };
        state.units = arr(state.units).map((entry) => clean(entry.id) === clean(unit.id) ? savedUnit : entry);
        if (clean(state.drawer?.unit?.id) === clean(unit.id)) state.drawer.unit = { ...obj(state.drawer.unit), ...savedUnit };
        showToast((globalThis.PlatformLanguage?.text("equipment","m_2813f320a63b94","Equipment") ?? "Equipment"), ((v0) => globalThis.PlatformLanguage?.text("equipment","m_6bb8d3f423b274",`Status changed to ${v0}.`,{v0}) ?? `Status changed to ${v0}.`)(clean(STATUS_META[clean(status)].label).toLowerCase()), true);
        render();
      } catch (error) {
        select.disabled = false;
        select.value = previous;
        showToast((globalThis.PlatformLanguage?.text("equipment","m_2813f320a63b94","Equipment") ?? "Equipment"), statusError(error, 'The status could not be changed.'), false);
      }
    }

    async function archiveDrawerUnit(){
      const unit = state.drawer?.unit;
      if (!unit) return;
      if (!window.confirm(((v0) => globalThis.PlatformLanguage?.text("equipment","m_5025cad385bee0",`Retire "${v0}"? It leaves the fleet list but its history is kept.`,{v0}) ?? `Retire "${v0}"? It leaves the fleet list but its history is kept.`)(clean(unit.name)))) return;
      try {
        await window.EquipmentAPI.archiveUnit(organizationId, clean(unit.id));
        showToast((globalThis.PlatformLanguage?.text("equipment","m_2813f320a63b94","Equipment") ?? "Equipment"), (globalThis.PlatformLanguage?.text("equipment","m_f99c0333027b2b","Unit retired.") ?? "Unit retired."), true);
        state.drawer = null;
        writeRoute('replace', { equipmentItem:'' }, { ownedKeys:['equipmentItem'] });
        await loadFleet({ force:true });
      } catch (error) {
        showToast((globalThis.PlatformLanguage?.text("equipment","m_2813f320a63b94","Equipment") ?? "Equipment"), statusError(error, 'The unit could not be retired.'), false);
      }
    }

    /* ---------------------------------------------------------- rendering */

    function unitCardHtml(unit){
      const icon = clean(unit.type_icon) || 'fa-truck-pickup';
      const photoUrl = primaryPhoto(unit) ? mediaReferenceUrl(primaryPhoto(unit), 'original') : '';
      const unitColor = cssColor(unit.color);
      const locationLabel = clean(obj(unit.location).label) || clean(obj(unit.home_location).label);
      const meter = obj(unit.current_meter);
      const meterText = [meter.hours ? `${Number(meter.hours).toLocaleString(globalThis.PlatformLanguage?.formatLocale?.())} hrs` : '', meter.miles ? `${Number(meter.miles).toLocaleString(globalThis.PlatformLanguage?.formatLocale?.())} mi` : ''].filter(Boolean).join(' · ');
      return `
        <article class="eq-card" data-eq-open="${String(esc(unit.id))}" role="button" tabindex="0" aria-label="${((v1) => globalThis.PlatformLanguage?.htmlText("equipment","m_ab0d5cb8a59853",`Open ${v1}`,{v1}) ?? `Open ${v1}`)(esc(unit.name || 'unit'))}"${String(unitColor ? ` style="border-left:4px solid ${esc(unitColor)}"` : '')}>
          <div class="eq-card-media" ${String(photoUrl ? `style="background-image:url('${esc(photoUrl)}')"` : '')}>${String(photoUrl ? '' : `<i class="fas ${esc(icon)}"${cssColor(unit.color) ? ` style="color:${esc(cssColor(unit.color))}"` : ''}></i>`)}</div>
          <div class="eq-card-content">
            <div class="eq-card-top">
              <span class="eq-card-name">
                <strong>${String(esc(unit.name))}</strong>
                <span>${String(esc([unit.type_name || 'No type', unit.identifier].filter(Boolean).join(' · ')))}</span>
              </span>
              ${String(cardStatusSelect(unit))}
            </div>
            <div class="eq-card-meta">
              ${String(locationLabel ? `<div><i class="fas fa-location-dot"></i><span>${esc(locationLabel)}</span></div>` : '')}
              ${String(meterText ? `<div><i class="fas fa-gauge-high"></i><span>${esc(meterText)}</span></div>` : '')}
              ${String(clean(unit.license_plate) ? `<div><i class="fas fa-rectangle-list"></i><span>${esc(unit.license_plate)}</span></div>` : '')}
              ${String(clean(unit.ownership) !== 'owned' ? `<div><i class="fas fa-file-contract"></i><span>${esc(clean(unit.ownership).replace(/^./, (char) => char.toUpperCase()))}</span></div>` : '')}
              ${String(clean(obj(unit.custody).user_id) ? `<div><i class="fas fa-hand-holding"></i><span>${((v0) => globalThis.PlatformLanguage?.htmlText("equipment","m_74ebb184b114fb",`Checked out${v0}`,{v0}) ?? `Checked out${v0}`)(clean(obj(unit.custody).user_name) ? ` to ${esc(obj(unit.custody).user_name)}` : '')}</span></div>` : '')}
            </div>
          </div>
        </article>`;
    }

    function fleetHtml(){
      if (state.loading && !state.units) return `<div class="eq-loading"><div><div class="eq-spinner"></div>${(globalThis.PlatformLanguage?.htmlText("equipment","m_baabdd88b91c20","Loading the fleet…") ?? "Loading the fleet…")}</div></div>`;
      const units = arr(state.units);
      const unitTerm = terminology('equipment.equipment_units', 'Units');
      const filterOptions = `
        <div class="eq-filters">
          <div class="eq-search"><i class="fas fa-magnifying-glass"></i><input type="search" placeholder="${(globalThis.PlatformLanguage?.htmlText("equipment","m_bf817b162b2c81","Search name, asset #, plate, VIN…") ?? "Search name, asset #, plate, VIN…")}" value="${String(esc(state.filters.query))}" data-eq-filter="query"></div>
          <select class="eq-filter" data-eq-filter="categoryId">
            <option value="">${(globalThis.PlatformLanguage?.htmlText("equipment","m_0abe1295afa55b","All categories") ?? "All categories")}</option>
            ${String(arr(state.categories).map((category) => `<option value="${esc(category.id)}" ${state.filters.categoryId === clean(category.id) ? 'selected' : ''}>${esc(category.name)}</option>`).join(''))}
          </select>
          <select class="eq-filter" data-eq-filter="typeId">
            <option value="">${(globalThis.PlatformLanguage?.htmlText("equipment","m_51faf42a72af3e","All types") ?? "All types")}</option>
            ${String(activeRecords(state.types).map((type) => `<option value="${esc(type.id)}" ${state.filters.typeId === clean(type.id) ? 'selected' : ''}>${esc(type.name)}</option>`).join(''))}
          </select>
          <select class="eq-filter" data-eq-filter="status">
            <option value="">${(globalThis.PlatformLanguage?.htmlText("equipment","m_ca4e6bcaf98610","Any status") ?? "Any status")}</option>
            ${String(Object.entries(STATUS_META).filter(([key]) => key !== 'in_use').map(([key, meta]) => `<option value="${esc(key)}" ${state.filters.status === key ? 'selected' : ''}>${esc(meta.label)}</option>`).join(''))}
          </select>
          <span class="eq-count">${String(units.length)} ${String(esc(unitTerm.toLowerCase()))}</span>
        </div>`;
      if (!units.length) {
        return (String(filterOptions) + "\n          <div class=\"eq-empty\"><div>\n            <i class=\"fas fa-truck-pickup\"></i>\n            <strong>" + (globalThis.PlatformLanguage?.text("equipment","m_ec81d12099a573","No equipment yet") ?? "No equipment yet") + "</strong>\n            <button type=\"button\" class=\"eq-btn primary\" data-eq-add-unit><i class=\"fas fa-plus\"></i>" + (globalThis.PlatformLanguage?.text("equipment","m_77273e1b20f93b"," Add your first unit") ?? " Add your first unit") + "</button>\n          </div></div>");
      }
      return `${filterOptions}<div class="eq-grid">${units.map(unitCardHtml).join('')}</div>`;
    }

    function drawerHtml(){
      const drawer = state.drawer;
      if (!drawer) return '';
      const unit = obj(drawer.unit);
      const existingUnit = drawer.mode !== 'create';
      const icon = drawer.mode === 'create' ? 'fa-truck' : (clean(unit.type_icon) || 'fa-truck-pickup');
      const headerPhotoUrl = primaryPhoto(unit) ? mediaReferenceUrl(primaryPhoto(unit), 'thumb_320') : '';
      const field = (label, name, value, options = {}) => `
        <div class="eq-field ${options.wide ? 'wide' : ''}">
          <label>${esc(label)}${options.required ? ' *' : ''}</label>
          ${options.select
            ? `<select data-eq-input="${esc(name)}">${options.select.map(([optionValue, optionLabel]) => `<option value="${esc(optionValue)}" ${clean(value) === optionValue ? 'selected' : ''}>${esc(optionLabel)}</option>`).join('')}</select>`
            : options.textarea
              ? `<textarea rows="3" data-eq-input="${esc(name)}">${esc(value)}</textarea>`
              : `<input type="${options.type || 'text'}" data-eq-input="${esc(name)}" value="${esc(value)}" ${options.step ? `step="${esc(options.step)}"` : ''} ${options.required ? 'required' : ''}>`}
          ${options.required ? `<span class="eq-field-error" data-eq-unit-field-error="${esc(name)}"></span>` : ''}
        </div>`;
      const selectedType = arr(state.types).find((type) => clean(type.id) === clean(unit.type_id));
      const selectableTypes = activeRecords(state.types);
      if (selectedType && clean(selectedType.status) === 'archived' && !selectableTypes.includes(selectedType)) selectableTypes.push(selectedType);
      const typeOptions = [['', 'No type'], ...selectableTypes.map((type) => [clean(type.id), `${clean(type.name)}${clean(type.status) === 'archived' ? ' (Archived)' : ''}`])];
      const vehicleType = ['vehicle','trailer'].includes(clean(selectedType?.kind));
      const selectedYardId = clean(obj(unit.home_location).yard_id || obj(unit.location).yard_id);
      const selectedYard = arr(state.yards).find((yard) => clean(yard.id) === selectedYardId);
      const selectableYards = activeRecords(state.yards);
      if (selectedYard && clean(selectedYard.status) === 'archived' && !selectableYards.includes(selectedYard)) selectableYards.push(selectedYard);
      const yardOptions = [['', 'No home facility'], ...selectableYards.map((yard) => [clean(yard.id), `${clean(yard.name)}${clean(yard.status) === 'archived' ? ' (Archived)' : ''}`])];
      const facilityAccessInstructions = clean(obj(selectedYard?.address).access_instructions || obj(obj(unit.home_location).address).access_instructions || obj(obj(unit.location).address).access_instructions);
      const acquisition = obj(unit.acquisition);
      const pickupCondition = obj(acquisition.pickup_condition);
      const pickupNotes = arr(pickupCondition.notes);
      const pickupMedia = arr(pickupCondition.media);
      const dollars = (cents) => (Number(cents || 0) ? (Number(cents) / 100).toFixed(2) : '');
      let body;
      if (drawer.loading) {
        body = `<div class="eq-loading"><div><div class="eq-spinner"></div>${(globalThis.PlatformLanguage?.htmlText("equipment","m_d2da77452877dd","Loading…") ?? "Loading…")}</div></div>`;
      } else {
        const photo = primaryPhoto(unit);
        const photoUrl = photo ? mediaReferenceUrl(photo, 'original') : '';
        const ownership = clean(unit.ownership || 'owned');
        body = `
          <div class="eq-form ${String(drawer.mode === 'view' ? 'eq-inline-view-form' : '')}">
            <div class="eq-form-error" data-eq-unit-form-error></div>
            <div class="eq-unit-identity">
              <div class="eq-photo-tile ${String(photoUrl ? 'has-photo' : '')}" data-eq-photo-pick role="button" tabindex="0" aria-label="${String(photoUrl ? 'Replace unit photo' : 'Upload unit photo')}" title="${String(photoUrl ? 'Click to replace' : 'Click to upload')}">
                ${String(photoUrl ? `<img src="${esc(photoUrl)}" alt="${esc(unit.name || 'Unit photo')}">` : '')}
                <span class="eq-photo-tile-copy"><i class="fas fa-camera"></i><span>${(globalThis.PlatformLanguage?.htmlText("equipment","m_726a55d8501a84","Click to upload") ?? "Click to upload")}</span></span>
                ${String(photoUrl ? `<button type="button" class="eq-photo-crop" data-eq-photo-crop title="${(globalThis.PlatformLanguage?.htmlText("equipment","m_77e68572349ca5","Crop photo") ?? "Crop photo")}" aria-label="${(globalThis.PlatformLanguage?.htmlText("equipment","m_77e68572349ca5","Crop photo") ?? "Crop photo")}"><i class="fas fa-crop-simple"></i></button>` : '')}
              </div>
              <div class="eq-identity-fields">
                ${String(field('Name', 'name', unit.name, { required:true }))}
                <div class="eq-field eq-identity-color"><label>${(globalThis.PlatformLanguage?.htmlText("equipment","m_db7002926d9977","Color") ?? "Color")}</label><input class="eq-color-input" type="color" data-eq-input="color" value="${String(esc(/^#[0-9a-f]{6}$/i.test(clean(unit.color)) ? unit.color : '#667085'))}" title="${(globalThis.PlatformLanguage?.htmlText("equipment","m_1f68f509e5b4a3","Unit color") ?? "Unit color")}"></div>
              </div>
            </div>
            <div class="eq-field"><label>${(globalThis.PlatformLanguage?.htmlText("equipment","m_2e88df13ca7101","Type") ?? "Type")}</label><div class="eq-inline-select"><select data-eq-input="type_id">${String(typeOptions.map(([value,label]) => `<option value="${esc(value)}" ${clean(unit.type_id) === value ? 'selected' : ''}>${esc(label)}</option>`).join(''))}<option value="__new__">${(globalThis.PlatformLanguage?.htmlText("equipment","m_7165ea381347ad","+ Add new type…") ?? "+ Add new type…")}</option></select></div></div>
            <div class="eq-field"><label>${(globalThis.PlatformLanguage?.htmlText("equipment","m_cb7c55478a40a3","Home facility") ?? "Home facility")}</label><div class="eq-inline-select"><select data-eq-input="yard_id">${String(yardOptions.map(([value,label]) => `<option value="${esc(value)}" ${selectedYardId === value ? 'selected' : ''}>${esc(label)}</option>`).join(''))}<option value="__new__">${(globalThis.PlatformLanguage?.htmlText("equipment","m_0f3537c9bb311a","+ Add new facility…") ?? "+ Add new facility…")}</option></select></div></div>
            ${String(drawer.mode === 'view' && facilityAccessInstructions ? `<div class="eq-field eq-readonly-field"><label>${(globalThis.PlatformLanguage?.htmlText("equipment","m_feb926c42d3f6e","Facility access instructions") ?? "Facility access instructions")}</label><div class="eq-readonly-value" role="note"><i class="fas fa-lock"></i>${esc(facilityAccessInstructions)}</div></div>` : '')}
            ${String(field('Ownership', 'ownership', unit.ownership || 'owned', { select:OWNERSHIPS }))}
            ${String(field('Driver requirement', 'driver_requirement', driverRequirementId(unit), { select:DRIVER_REQUIREMENTS }))}
            ${String(drawer.mode !== 'create' ? field('Status', 'status', unit.status || 'available', { select:Object.entries(STATUS_META).filter(([key]) => key !== 'in_use').map(([key, meta]) => [key, meta.label]) }) : '')}
            ${String(vehicleType ? `<div class="eq-dynamic-panel"><div class="eq-section-label">${(globalThis.PlatformLanguage?.htmlText("equipment","m_113d0683ef8084","Vehicle details") ?? "Vehicle details")}</div>${field('License plate', 'license_plate', unit.license_plate)}${field('Year', 'year', unit.year)}${field('Make', 'make', unit.make)}${field('Model', 'model', unit.model)}${field('VIN', 'vin', unit.vin)}</div>` : '')}
            ${String(ownership === 'owned' ? `<div class="eq-dynamic-panel"><div class="eq-section-label">${(globalThis.PlatformLanguage?.htmlText("equipment","m_250d080790e059","Purchase details") ?? "Purchase details")}</div>${field('Purchased on (optional)', 'procurement_date', acquisition.procurement_date, { type:'date' })}${field('Estimated value ($)', 'estimated_value', dollars(acquisition.estimated_value_cents), { type:'number', step:'0.01' })}</div>` : '')}
            ${String(ownership === 'leased' ? `<div class="eq-dynamic-panel"><div class="eq-section-label">${(globalThis.PlatformLanguage?.htmlText("equipment","m_b01d4473f12ba7","Lease details") ?? "Lease details")}</div>${field('Lease start (optional)', 'procurement_date', acquisition.procurement_date, { type:'date' })}${field('Lease term (months)', 'lease_term_months', acquisition.lease_term_months, { type:'number', step:'1' })}${field('Monthly lease cost ($)', 'lease_monthly_cost', dollars(acquisition.monthly_cost_cents), { type:'number', step:'0.01' })}</div>` : '')}
            ${String(ownership === 'rented' ? `
              <div class="eq-dynamic-panel">
                <div class="eq-section-label">${(globalThis.PlatformLanguage?.htmlText("equipment","m_d6855debf20509","Rental details") ?? "Rental details")}</div>
                ${field('Pickup date (optional)', 'rental_date', acquisition.rental_date || pickupCondition.date, { type:'date' })}${field('Pickup time (optional)', 'pickup_time', acquisition.pickup_time || pickupCondition.time, { type:'time' })}${field('Rental return date (optional)', 'return_date', acquisition.return_date || pickupCondition.return_date, { type:'date' })}${field('Return time (optional)', 'return_time', acquisition.return_time || pickupCondition.return_time, { type:'time' })}${field('Rental cost ($)', 'rental_cost', dollars(acquisition.rental_cost_cents), { type:'number', step:'0.01' })}
                <div class="eq-section-label">${(globalThis.PlatformLanguage?.htmlText("equipment","m_09b6f65ba14e08","Pickup condition") ?? "Pickup condition")}</div>
                <div class="eq-condition-list"><label style="font-size:10px;font-weight:950;letter-spacing:.06em;text-transform:uppercase;color:#667085">${(globalThis.PlatformLanguage?.htmlText("equipment","m_e9231d9e50eeb6","Condition notes") ?? "Condition notes")}</label>${pickupNotes.map((note,index) => `<div class="eq-condition-note"><textarea rows="2" data-eq-pickup-note="${index}" placeholder="${(globalThis.PlatformLanguage?.htmlText("equipment","m_b0bf3a608a0071","Describe existing damage or condition…") ?? "Describe existing damage or condition…")}">${esc(note)}</textarea><button type="button" class="eq-icon-remove" data-eq-pickup-note-remove="${index}" title="${(globalThis.PlatformLanguage?.htmlText("equipment","m_4b4ba3b5b6d01b","Remove note") ?? "Remove note")}"><i class="fas fa-xmark"></i></button></div>`).join('')}<button type="button" class="eq-btn" data-eq-pickup-note-add><i class="fas fa-plus"></i>${(globalThis.PlatformLanguage?.htmlText("equipment","m_b78805965a7319"," Add condition note") ?? " Add condition note")}</button></div>
                <div class="eq-condition-media">${pickupMedia.map((media,index) => { const src = mediaReferenceUrl(media, 'thumb_320'); const isVideo = clean(obj(media).content_type).startsWith('video/'); return `<div class="eq-condition-media-item">${isVideo ? `<video src="${esc(mediaReferenceUrl(media))}" muted preload="metadata"></video>` : `<img src="${esc(src)}" alt="${((v1) => globalThis.PlatformLanguage?.htmlText("equipment","m_6ad3acf5f9a1a2",`Pickup condition ${v1}`,{v1}) ?? `Pickup condition ${v1}`)(index + 1)}">`}<button type="button" class="eq-icon-remove" data-eq-pickup-media-remove="${index}" title="${(globalThis.PlatformLanguage?.htmlText("equipment","m_f643f568915438","Remove") ?? "Remove")}"><i class="fas fa-xmark"></i></button></div>`; }).join('')}</div>
                <div class="eq-field wide"><button type="button" class="eq-btn" data-eq-pickup-media-add><i class="fas fa-photo-film"></i>${(globalThis.PlatformLanguage?.htmlText("equipment","m_c3609786a5300a"," Add pictures or videos") ?? " Add pictures or videos")}</button></div>
              </div>
            ` : '')}
            <div class="eq-section-label">${(globalThis.PlatformLanguage?.htmlText("equipment","m_b0928a4b3f46b9","Identifiers and notes") ?? "Identifiers and notes")}</div>
            ${String(field('Serial number', 'serial_number', unit.serial_number))}
            ${String(field('Asset # (optional)', 'identifier', unit.identifier))}
            ${String(field('Notes', 'notes', unit.notes, { wide:true, textarea:true }))}
          </div>`;
      }
      return `
        <div class="eq-drawer-back" data-eq-drawer-back>
          <div class="eq-drawer" role="dialog" aria-modal="true">
            <div class="eq-drawer-head">
              <span class="eq-card-icon" style="${headerPhotoUrl ? `background-image:url('${esc(headerPhotoUrl)}');background-size:cover;background-position:center;color:transparent` : cssColor(unit.color) ? `color:${esc(cssColor(unit.color))}` : ''}"><i class="fas ${esc(icon)}"></i></span>
              <span class="eq-drawer-title">
                <h3>${esc(drawer.mode === 'create' ? 'New unit' : unit.name || 'Unit')}</h3>
                <span>${drawer.mode === 'create' ? 'Add a unit to the fleet' : esc([unit.type_name, unit.identifier].filter(Boolean).join(' · ') || 'Unit details')}</span>
              </span>
              ${drawer.mode === 'view' && !drawer.loading ? statusChip(unit.status) : ''}
              <button type="button" class="eq-drawer-close" data-eq-drawer-close><i class="fas fa-xmark"></i></button>
            </div>
            <div class="eq-drawer-body" data-eq-unit-scroll>${body}</div>
            <div class="eq-drawer-foot">
              ${existingUnit && !drawer.loading ? `<button type="button" class="eq-danger" data-eq-drawer-archive><i class="fas fa-box-archive"></i>${(globalThis.PlatformLanguage?.htmlText("equipment","m_e92b7354d81c5d"," Retire unit") ?? " Retire unit")}</button>` : ''}
              ${drawer.loading ? '' : drawer.mode === 'create'
                ? `<button type="button" class="eq-btn" data-eq-drawer-cancel>${(globalThis.PlatformLanguage?.htmlText("equipment","m_cbef679b21abb4","Cancel") ?? "Cancel")}</button><button type="button" class="eq-btn primary" data-eq-drawer-save><i class="fas fa-check"></i>${(globalThis.PlatformLanguage?.htmlText("equipment","m_e1f035ff60288f"," Add unit") ?? " Add unit")}</button>`
                : (String(capabilityOn('equipment', 'custody')
                    ? (clean(obj(unit.custody).user_id)
                      ? `<button type="button" class="eq-btn" data-eq-drawer-checkin><i class="fas fa-rotate-left"></i>${(globalThis.PlatformLanguage?.htmlText("equipment","m_9cb588baa72829"," Check in") ?? " Check in")}</button>`
                      : `<button type="button" class="eq-btn" data-eq-drawer-checkout><i class="fas fa-hand-holding"></i>${(globalThis.PlatformLanguage?.htmlText("equipment","m_243d5332cd629a"," Check out") ?? " Check out")}</button>`)
                    : '') + "<button type=\"button\" class=\"eq-btn primary\" data-eq-drawer-save><i class=\"fas fa-check\"></i>" + (globalThis.PlatformLanguage?.htmlText("equipment","m_bfcbd339764266"," Save changes") ?? " Save changes") + "</button>")}
            </div>
          </div>
        </div>`;
    }

    function typesManagerHtml(){
      if (!state.typesOpen) return '';
      const categoryName = (id) => clean(arr(state.categories).find((category) => clean(category.id) === clean(id))?.name) || 'Uncategorized';
      const records = arr(state.types).filter((type) => (clean(type.status || 'active') === 'archived') === state.typesShowArchived);
      return `
        <div class="eq-drawer-back" data-eq-types-back>
          <div class="eq-drawer" role="dialog" aria-modal="true">
            <div class="eq-drawer-head">
              <span class="eq-card-icon"><i class="fas fa-layer-group"></i></span>
              <span class="eq-drawer-title single-line">
                <h3>${String(state.typesShowArchived ? 'Archived equipment types' : esc(terminology('equipment.equipment_types', 'Equipment Types')))}</h3>
              </span>
              <button type="button" class="eq-drawer-close" data-eq-types-close title="${(globalThis.PlatformLanguage?.htmlText("equipment","m_1da70ddf2a99ce","Close equipment types") ?? "Close equipment types")}" aria-label="${(globalThis.PlatformLanguage?.htmlText("equipment","m_1da70ddf2a99ce","Close equipment types") ?? "Close equipment types")}"><i class="fas fa-xmark"></i></button>
            </div>
            <div class="eq-drawer-body" data-eq-manager-scroll="types">
              <div class="eq-types-list">
                ${String(records.map((type) => `
                  <div class="eq-type-row">
                    <span class="eq-card-icon"><i class="fas ${esc(clean(type.icon) || 'fa-truck-pickup')}"></i></span>
                    <span class="eq-type-row-copy">
                      <strong>${esc(type.name)}</strong>
                      <span>${esc((clean(type.kind) || 'other').replace(/^./, (char) => char.toUpperCase()))} · ${esc(categoryName(type.category_id))} · ${esc(clean(type.tracking) === 'quantity' ? `Pool of ${Number(type.pool_quantity || 0)}` : 'Serialized units')}</span>
                    </span>
                    ${state.typesShowArchived
                      ? `<button type="button" class="eq-mini" data-eq-type-restore="${esc(type.id)}" title="${(globalThis.PlatformLanguage?.htmlText("equipment","m_2320e2a7e9e439","Restore type") ?? "Restore type")}" aria-label="${((v1) => globalThis.PlatformLanguage?.htmlText("equipment","m_5d91136e35ab88",`Restore ${v1}`,{v1}) ?? `Restore ${v1}`)(esc(type.name))}"><i class="fas fa-rotate-left"></i></button>`
                      : `<button type="button" class="eq-mini" data-eq-type-edit="${esc(type.id)}" title="${(globalThis.PlatformLanguage?.htmlText("equipment","m_86fa9ca9739918","Edit type") ?? "Edit type")}" aria-label="${((v1) => globalThis.PlatformLanguage?.htmlText("equipment","m_eb14156d1fca4c",`Edit ${v1}`,{v1}) ?? `Edit ${v1}`)(esc(type.name))}"><i class="fas fa-pen"></i></button><button type="button" class="eq-mini" data-eq-type-archive="${esc(type.id)}" title="${(globalThis.PlatformLanguage?.htmlText("equipment","m_470e4e0712ef94","Archive type") ?? "Archive type")}" aria-label="${((v3) => globalThis.PlatformLanguage?.htmlText("equipment","m_3a8f16229de187",`Archive ${v3}`,{v3}) ?? `Archive ${v3}`)(esc(type.name))}"><i class="fas fa-box-archive"></i></button>`}
                  </div>`).join('') || `<div class="eq-empty" style="min-height:160px"><div><strong>${state.typesShowArchived ? 'No archived types' : 'No types yet'}</strong></div></div>`)}
              </div>
            </div>
            <div class="eq-drawer-foot">
              ${String(state.typesShowArchived ? `<button type="button" class="eq-btn" data-eq-types-active><i class="fas fa-arrow-left"></i>${(globalThis.PlatformLanguage?.htmlText("equipment","m_f4c0b2cd481788"," Active types") ?? " Active types")}</button>` : `<button type="button" class="eq-btn primary" data-eq-type-add><i class="fas fa-plus"></i>${(globalThis.PlatformLanguage?.htmlText("equipment","m_7cef72fe83add5"," New type") ?? " New type")}</button>`)}
              <span class="eq-foot-spacer"></span>
              ${String(state.typesShowArchived ? '' : `<button type="button" class="eq-btn" data-eq-types-archive-view><i class="fas fa-box-archive"></i>${(globalThis.PlatformLanguage?.htmlText("equipment","m_d248c450100477"," Archive") ?? " Archive")}</button>`)}
            </div>
          </div>
        </div>`;
    }

    function yardsManagerHtml(){
      if (!state.yardsOpen) return '';
      const records = arr(state.yards).filter((yard) => (clean(yard.status || 'active') === 'archived') === state.yardsShowArchived);
      return `<div class="eq-drawer-back" data-eq-yards-back><div class="eq-drawer" role="dialog" aria-modal="true">
        <div class="eq-drawer-head"><span class="eq-card-icon"><i class="fas fa-warehouse"></i></span><span class="eq-drawer-title single-line"><h3>${String(state.yardsShowArchived ? 'Archived facilities' : 'Facilities')}</h3></span><button type="button" class="eq-drawer-close" data-eq-yards-close title="${(globalThis.PlatformLanguage?.htmlText("equipment","m_17153adf64b080","Close facilities") ?? "Close facilities")}" aria-label="${(globalThis.PlatformLanguage?.htmlText("equipment","m_17153adf64b080","Close facilities") ?? "Close facilities")}"><i class="fas fa-xmark"></i></button></div>
        <div class="eq-drawer-body" data-eq-manager-scroll="yards"><div class="eq-types-list">${String(records.map((yard) => `<div class="eq-type-row"><span class="eq-card-icon"><i class="fas fa-location-dot"></i></span><span class="eq-type-row-copy"><strong>${esc(yard.name)}</strong><span>${esc(obj(yard.address).formatted || 'No address')}${clean(obj(yard.address).access_instructions) ? ` · ${esc(obj(yard.address).access_instructions)}` : ''}</span></span>${state.yardsShowArchived ? `<button type="button" class="eq-mini" data-eq-yard-restore="${esc(yard.id)}" title="${(globalThis.PlatformLanguage?.htmlText("equipment","m_dfa94b8d6efc4d","Restore facility") ?? "Restore facility")}" aria-label="${((v1) => globalThis.PlatformLanguage?.htmlText("equipment","m_5d91136e35ab88",`Restore ${v1}`,{v1}) ?? `Restore ${v1}`)(esc(yard.name))}"><i class="fas fa-rotate-left"></i></button>` : `<button type="button" class="eq-mini" data-eq-yard-edit="${esc(yard.id)}" title="${(globalThis.PlatformLanguage?.htmlText("equipment","m_74805cc67e2143","Edit facility") ?? "Edit facility")}" aria-label="${((v1) => globalThis.PlatformLanguage?.htmlText("equipment","m_eb14156d1fca4c",`Edit ${v1}`,{v1}) ?? `Edit ${v1}`)(esc(yard.name))}"><i class="fas fa-pen"></i></button><button type="button" class="eq-mini" data-eq-yard-archive="${esc(yard.id)}" title="${(globalThis.PlatformLanguage?.htmlText("equipment","m_bb24a8500b97f7","Archive facility") ?? "Archive facility")}" aria-label="${((v3) => globalThis.PlatformLanguage?.htmlText("equipment","m_3a8f16229de187",`Archive ${v3}`,{v3}) ?? `Archive ${v3}`)(esc(yard.name))}"><i class="fas fa-box-archive"></i></button>`}</div>`).join('') || `<div class="eq-empty" style="min-height:160px"><div><strong>${state.yardsShowArchived ? 'No archived facilities' : 'No facilities yet'}</strong></div></div>`)}</div></div>
        <div class="eq-drawer-foot">${String(state.yardsShowArchived ? `<button type="button" class="eq-btn" data-eq-yards-active><i class="fas fa-arrow-left"></i>${(globalThis.PlatformLanguage?.htmlText("equipment","m_ba02871d0ed562"," Active facilities") ?? " Active facilities")}</button>` : `<button type="button" class="eq-btn primary" data-eq-yard-add><i class="fas fa-plus"></i>${(globalThis.PlatformLanguage?.htmlText("equipment","m_6468e0ad5b1770"," New facility") ?? " New facility")}</button>`)}<span class="eq-foot-spacer"></span>${String(state.yardsShowArchived ? '' : `<button type="button" class="eq-btn" data-eq-yards-archive-view><i class="fas fa-box-archive"></i>${(globalThis.PlatformLanguage?.htmlText("equipment","m_d248c450100477"," Archive") ?? " Archive")}</button>`)}</div>
      </div></div>`;
    }

    function catalogEditorHtml(){
      const editor = state.catalogEditor;
      if (!editor) return '';
      const editing = Boolean(editor.entity);
      const typeEditor = editor.kind === 'type';
      const title = `${editing ? 'Edit' : 'New'} ${typeEditor ? 'equipment type' : 'facility'}`;
      const currentKind = clean(editor.selectedKind || editor.entity?.kind) || 'other';
      return `
        <div class="eq-catalog-back" data-eq-catalog-back>
          <div class="eq-catalog-modal" role="dialog" aria-modal="true" aria-label="${String(esc(title))}">
            <div class="eq-drawer-head">
              <span class="eq-card-icon"><i class="fas ${String(typeEditor ? 'fa-shapes' : 'fa-warehouse')}"></i></span>
              <span class="eq-drawer-title single-line"><h3>${String(esc(typeEditor ? title : `${editing ? 'Edit' : 'New'} facility`))}</h3></span>
              <button type="button" class="eq-drawer-close" data-eq-catalog-cancel><i class="fas fa-xmark"></i></button>
            </div>
            <div class="eq-catalog-body">
              <div class="eq-field"><label>${(globalThis.PlatformLanguage?.htmlText("equipment","m_8cf345002184e5","Name") ?? "Name")}</label><input type="text" data-eq-catalog-name value="${String(esc(editor.name ?? editor.entity?.name))}" placeholder="${String(typeEditor ? 'e.g. Dump trailer' : 'e.g. North facility')}" autofocus><span class="eq-field-error" data-eq-field-error></span></div>
              ${String(typeEditor ? `<div class="eq-field"><label>${(globalThis.PlatformLanguage?.htmlText("equipment","m_0ee677e8200886","Classification") ?? "Classification")}</label><div class="eq-kind-options">
                ${[['vehicle','fa-truck-pickup','Vehicle'],['trailer','fa-trailer','Trailer'],['tool','fa-screwdriver-wrench','Tool'],['other','fa-box','Other']].map(([value,icon,label]) => `<label><input type="radio" name="eq-catalog-kind" data-eq-catalog-kind value="${value}" ${currentKind === value ? 'checked' : ''}><span><i class="fas ${icon}"></i><b>${label}</b></span></label>`).join('')}
              </div></div>` : `<div class="eq-field"><label>${(globalThis.PlatformLanguage?.htmlText("equipment","m_0ecd09516ac094","Address (optional)") ?? "Address (optional)")}</label><input type="text" data-eq-catalog-address value="${esc(editor.formatted ?? obj(editor.entity?.address).formatted)}" placeholder="${(globalThis.PlatformLanguage?.htmlText("equipment","m_251e51ba7e4761","Start typing an address") ?? "Start typing an address")}" autocomplete="off"><span class="eq-field-error" data-eq-field-error></span></div><div class="eq-field"><label>${(globalThis.PlatformLanguage?.htmlText("equipment","m_bd935bf52d86b9","Access instructions (optional)") ?? "Access instructions (optional)")}</label><textarea rows="3" data-eq-catalog-access placeholder="${(globalThis.PlatformLanguage?.htmlText("equipment","m_b9e346d068c27a","Gate code, entrance, parking, or check-in details") ?? "Gate code, entrance, parking, or check-in details")}">${esc(obj(editor.entity?.address).access_instructions)}</textarea></div>`)}
              <div class="eq-modal-error" data-eq-catalog-save-error></div>
            </div>
            <div class="eq-drawer-foot"><button type="button" class="eq-btn" data-eq-catalog-cancel>${(globalThis.PlatformLanguage?.htmlText("equipment","m_cbef679b21abb4","Cancel") ?? "Cancel")}</button><button type="button" class="eq-btn primary" data-eq-catalog-save ${String(editor.saving ? 'disabled' : '')}><i class="fas ${String(editor.saving ? 'fa-spinner fa-spin' : 'fa-check')}"></i> ${String(editor.saving ? 'Saving…' : 'Save')}</button></div>
          </div>
        </div>`;
    }

    function archiveConfirmHtml(){
      const pending = state.archiveConfirm;
      if (!pending) return '';
      const noun = pending.kind === 'type' ? 'equipment type' : 'facility';
      return `<div class="eq-catalog-back" data-eq-archive-back><div class="eq-catalog-modal" role="alertdialog" aria-modal="true" aria-label="${((v0) => globalThis.PlatformLanguage?.htmlText("equipment","m_62ff85645577a3",`Archive ${v0}`,{v0}) ?? `Archive ${v0}`)(esc(noun))}"><div class="eq-drawer-head"><span class="eq-card-icon"><i class="fas fa-box-archive"></i></span><span class="eq-drawer-title"><h3>${((v1) => globalThis.PlatformLanguage?.htmlText("equipment","m_db3dbf943a90ce",`Archive ${v1}?`,{v1}) ?? `Archive ${v1}?`)(esc(pending.entity.name))}</h3><span>${(globalThis.PlatformLanguage?.htmlText("equipment","m_c6144099a0ec83","It will stop appearing in unit selectors, but existing unit records stay intact.") ?? "It will stop appearing in unit selectors, but existing unit records stay intact.")}</span></span></div><div class="eq-drawer-foot"><button type="button" class="eq-btn" data-eq-archive-cancel>${(globalThis.PlatformLanguage?.htmlText("equipment","m_cbef679b21abb4","Cancel") ?? "Cancel")}</button><span class="eq-foot-spacer"></span><button type="button" class="eq-btn danger" data-eq-archive-confirm><i class="fas fa-box-archive"></i>${(globalThis.PlatformLanguage?.htmlText("equipment","m_d248c450100477"," Archive") ?? " Archive")}</button></div></div></div>`;
    }

    function closeArchiveConfirm(){
      if (state.archiveConfirm?.saving) return;
      state.archiveConfirm = null;
      root.querySelector('[data-eq-archive-back]')?.remove();
    }

    function openArchiveConfirm(kind, entity){
      state.archiveConfirm = { kind, entity:{ ...entity }, saving:false };
      root.querySelector('[data-eq-archive-back]')?.remove();
      root.querySelector('.eq-shell')?.insertAdjacentHTML('beforeend', archiveConfirmHtml());
      const back = root.querySelector('[data-eq-archive-back]');
      back?.addEventListener('mousedown', (event) => { if (event.target === back) closeArchiveConfirm(); });
      root.querySelector('[data-eq-archive-cancel]')?.addEventListener('click', closeArchiveConfirm);
      root.querySelector('[data-eq-archive-confirm]')?.addEventListener('click', () => void confirmArchiveEntity());
    }

    async function confirmArchiveEntity(){
      const pending = state.archiveConfirm;
      if (!pending || pending.saving) return;
      pending.saving = true;
      const button = root.querySelector('[data-eq-archive-confirm]');
      if (button) { button.disabled = true; button.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Archiving…'; }
      try {
        const result = pending.kind === 'type'
          ? await window.EquipmentAPI.archiveType(organizationId, clean(pending.entity.id))
          : await window.EquipmentAPI.archiveYard(organizationId, clean(pending.entity.id));
        const archived = obj(pending.kind === 'type' ? result.type : result.yard);
        if (pending.kind === 'type') state.types = arr(state.types).map((entry) => clean(entry.id) === clean(archived.id) ? archived : entry);
        else state.yards = arr(state.yards).map((entry) => clean(entry.id) === clean(archived.id) ? archived : entry);
        pending.saving = false;
        closeArchiveConfirm();
        render();
      } catch (error) {
        pending.saving = false;
        if (button) { button.disabled = false; button.innerHTML = '<i class="fas fa-box-archive"></i> Archive'; }
        showToast((globalThis.PlatformLanguage?.text("equipment","m_2813f320a63b94","Equipment") ?? "Equipment"), statusError(error, `The ${pending.kind === 'type' ? 'type' : 'facility'} could not be archived.`), false);
      }
    }

    async function showCatalogArchive(kind){
      try {
        if (kind === 'type') {
          const result = await window.EquipmentAPI.types(organizationId, { includeArchived:true });
          state.types = arr(result.types);
          state.typesShowArchived = true;
        } else {
          const result = await window.EquipmentAPI.yards(organizationId, { includeArchived:true });
          state.yards = arr(result.yards);
          state.yardsShowArchived = true;
        }
        render();
      } catch (error) {
        showToast((globalThis.PlatformLanguage?.text("equipment","m_2813f320a63b94","Equipment") ?? "Equipment"), statusError(error, 'The archive could not be loaded.'), false);
      }
    }

    async function restoreCatalogEntity(kind, entity){
      try {
        const payload = { ...entity, status:'active', expected_revision:Number(entity.revision || 0) || undefined };
        const result = kind === 'type'
          ? await window.EquipmentAPI.saveType(organizationId, clean(entity.id), payload)
          : await window.EquipmentAPI.saveYard(organizationId, clean(entity.id), payload);
        const restored = obj(kind === 'type' ? result.type : result.yard);
        if (kind === 'type') state.types = arr(state.types).map((entry) => clean(entry.id) === clean(restored.id) ? restored : entry);
        else state.yards = arr(state.yards).map((entry) => clean(entry.id) === clean(restored.id) ? restored : entry);
        render();
      } catch (error) {
        showToast((globalThis.PlatformLanguage?.text("equipment","m_2813f320a63b94","Equipment") ?? "Equipment"), statusError(error, `The ${kind === 'type' ? 'type' : 'facility'} could not be restored.`), false);
      }
    }

    function render(){
      if (destroyed) return;
      const scrollState = {
        unit:root.querySelector('[data-eq-unit-scroll]')?.scrollTop || 0,
        types:root.querySelector('[data-eq-manager-scroll="types"]')?.scrollTop || 0,
        yards:root.querySelector('[data-eq-manager-scroll="yards"]')?.scrollTop || 0
      };
      const preserveDrawer = Boolean(root.querySelector('[data-eq-drawer-back]'));
      const views = availableViews();
      if (!views.some((view) => view.id === state.view)) state.view = 'fleet';
      const title = terminology('equipment.portal_tab', 'Equipment');
      let bodyHtml = '';
      if (state.view === 'fleet') bodyHtml = fleetHtml();
      else if (state.view === 'timeline') {
        bodyHtml = state.timeline?.error
          ? `<div class="eq-empty"><div><i class="fas fa-chart-gantt"></i><strong>${(globalThis.PlatformLanguage?.htmlText("equipment","m_f338d62ad81d90","Timeline unavailable") ?? "Timeline unavailable")}</strong><p>${String(esc(state.timeline.error))}</p></div></div>`
          : (state.timeline && !state.timeline.loading
            ? '<div data-eq-timeline style="min-height:420px"></div>'
            : `<div class="eq-loading"><div><div class="eq-spinner"></div>${(globalThis.PlatformLanguage?.htmlText("equipment","m_501c7f15eada0a","Loading the timeline…") ?? "Loading the timeline…")}</div></div>`);
      }
      else if (state.view === 'maintenance') bodyHtml = maintenanceHtml();
      else if (state.view === 'utilization') bodyHtml = utilizationHtml();
      else if (state.view === 'settings') bodyHtml = '<div data-eq-settings-root></div>';

      root.innerHTML = `
        <div class="eq-shell ${preserveDrawer ? 'eq-preserve-drawer' : ''}">
          <div class="eq-top">
            <div class="eq-title">
              <span class="eq-title-icon"><i class="fas fa-truck-pickup"></i></span>
              <div><h2>${esc(title)}</h2></div>
            </div>
            <div class="eq-views">
              ${views.map((view) => `<button type="button" class="${state.view === view.id ? 'on' : ''}" data-eq-view="${esc(view.id)}"><i class="fas ${esc(view.icon)}"></i> ${esc(view.label)}</button>`).join('')}
            </div>
            ${state.view === 'fleet' ? `
              <button type="button" class="eq-btn" data-eq-types-open><i class="fas fa-layer-group"></i>${(globalThis.PlatformLanguage?.htmlText("equipment","m_659c109b30c152"," Types") ?? " Types")}</button>
              <button type="button" class="eq-btn" data-eq-yards-open><i class="fas fa-warehouse"></i>${(globalThis.PlatformLanguage?.htmlText("equipment","m_c6b212605c230d"," Facilities") ?? " Facilities")}</button>
              <button type="button" class="eq-btn primary" data-eq-add-unit><i class="fas fa-plus"></i>${(globalThis.PlatformLanguage?.htmlText("equipment","m_e1f035ff60288f"," Add unit") ?? " Add unit")}</button>` : ''}
          </div>
          <div class="eq-body">${bodyHtml}</div>
          ${drawerHtml()}
          ${typesManagerHtml()}
          ${yardsManagerHtml()}
          ${cropHtml()}
        </div>`;

      bindEvents();
      const unitScroll = root.querySelector('[data-eq-unit-scroll]'); if (unitScroll) unitScroll.scrollTop = scrollState.unit;
      const typesScroll = root.querySelector('[data-eq-manager-scroll="types"]'); if (typesScroll) typesScroll.scrollTop = scrollState.types;
      const yardsScroll = root.querySelector('[data-eq-manager-scroll="yards"]'); if (yardsScroll) yardsScroll.scrollTop = scrollState.yards;
      if (state.crop) drawPhotoCrop();
      if (state.view === 'maintenance') {
        if (!state.maintenance) void loadMaintenance();
        else bindMaintenanceEvents();
      }
      if (state.view === 'timeline') {
        if (!state.timeline) void loadTimeline();
        else mountTimeline();
      }
      if (state.view === 'utilization' && !state.utilization) void loadUtilization();
      if (state.view === 'settings') {
        const settingsRoot = root.querySelector('[data-eq-settings-root]');
        if (settingsRoot && window.FirstMateEquipmentSettings?.mount) {
          state.settingsHandle?.destroy?.();
          state.settingsHandle = window.FirstMateEquipmentSettings.mount(settingsRoot, { orgId: organizationId, showToast });
        }
      }
    }

    function bindEvents(){
      root.querySelectorAll('[data-eq-view]').forEach((button) => button.addEventListener('click', () => {
        const view = clean(button.dataset.eqView);
        if (view === state.view) return;
        state.view = view;
        writeRoute('push', { equipmentView: view, equipmentItem:'' }, { ownedKeys:['equipmentView', 'equipmentItem'] });
        if (view === 'fleet' && !state.units) void loadFleet();
        else render();
      }));
      root.querySelectorAll('[data-eq-filter]').forEach((input) => {
        const apply = () => {
          state.filters[input.dataset.eqFilter] = clean(input.value);
          void loadFleet({ force:true });
        };
        if (input.tagName === 'SELECT') input.addEventListener('change', apply);
        else {
          let timer = null;
          input.addEventListener('input', () => {
            clearTimeout(timer);
            timer = setTimeout(apply, 260);
          });
        }
      });
      root.querySelectorAll('[data-eq-open]').forEach((card) => {
        card.addEventListener('click', (event) => {
          if (event.target.closest('[data-eq-card-status]')) return;
          void openUnit(card.dataset.eqOpen, { push:true });
        });
        card.addEventListener('keydown', (event) => {
          if (event.target.closest('[data-eq-card-status]') || !['Enter',' '].includes(event.key)) return;
          event.preventDefault();
          void openUnit(card.dataset.eqOpen, { push:true });
        });
      });
      root.querySelectorAll('[data-eq-card-status]').forEach((select) => {
        select.addEventListener('click', (event) => event.stopPropagation());
        select.addEventListener('change', (event) => {
          event.stopPropagation();
          void updateCardStatus(select.dataset.eqCardStatus, select.value, select);
        });
      });
      root.querySelectorAll('[data-eq-add-unit]').forEach((button) => button.addEventListener('click', () => {
        state.drawer = { mode:'create', unit:{ status:'available', ownership:'owned' }, loading:false };
        render();
      }));
      const drawerBack = root.querySelector('[data-eq-drawer-back]');
      drawerBack?.addEventListener('mousedown', (event) => { if (event.target === drawerBack) closeDrawer(); });
      root.querySelector('[data-eq-drawer-close]')?.addEventListener('click', () => closeDrawer());
      root.querySelector('[data-eq-drawer-cancel]')?.addEventListener('click', () => {
        if (state.drawer?.mode === 'create') closeDrawer();
        else { state.drawer.mode = 'view'; render(); }
      });
      root.querySelector('[data-eq-drawer-checkout]')?.addEventListener('click', async () => {
        const unit = state.drawer?.unit;
        if (!unit) return;
        try {
          const result = await window.EquipmentAPI.checkOutUnit(organizationId, clean(unit.id), {});
          state.drawer.unit = { ...unit, ...obj(result.unit) };
          showToast((globalThis.PlatformLanguage?.text("equipment","m_2813f320a63b94","Equipment") ?? "Equipment"), ((v0) => globalThis.PlatformLanguage?.text("equipment","m_6447b3f243a67b",`"${v0}" is checked out to you.`,{v0}) ?? `"${v0}" is checked out to you.`)(clean(unit.name)), true);
          await loadFleet({ force:true });
          render();
        } catch (error) {
          showToast((globalThis.PlatformLanguage?.text("equipment","m_2813f320a63b94","Equipment") ?? "Equipment"), statusError(error, 'The unit could not be checked out.'), false);
        }
      });
      root.querySelector('[data-eq-drawer-checkin]')?.addEventListener('click', async () => {
        const unit = state.drawer?.unit;
        if (!unit) return;
        try {
          const result = await window.EquipmentAPI.checkInUnit(organizationId, clean(unit.id));
          state.drawer.unit = { ...unit, ...obj(result.unit) };
          showToast((globalThis.PlatformLanguage?.text("equipment","m_2813f320a63b94","Equipment") ?? "Equipment"), ((v0) => globalThis.PlatformLanguage?.text("equipment","m_b62fb8c04ad84a",`"${v0}" is back.`,{v0}) ?? `"${v0}" is back.`)(clean(unit.name)), true);
          await loadFleet({ force:true });
          render();
        } catch (error) {
          showToast((globalThis.PlatformLanguage?.text("equipment","m_2813f320a63b94","Equipment") ?? "Equipment"), statusError(error, 'The unit could not be checked in.'), false);
        }
      });
      root.querySelector('[data-eq-drawer-save]')?.addEventListener('click', () => void saveDrawer(root));
      root.querySelector('[data-eq-drawer-archive]')?.addEventListener('click', () => void archiveDrawerUnit());
      root.querySelectorAll('[data-eq-input]').forEach((input) => input.addEventListener('input', () => {
        const field = input.closest('.eq-field');
        field?.classList.remove('invalid');
        field?.querySelector('[data-eq-unit-field-error]')?.classList.remove('show');
        input.removeAttribute('aria-invalid');
        root.querySelector('[data-eq-unit-form-error]')?.classList.remove('show');
      }));
      root.querySelector('[data-eq-input="ownership"]')?.addEventListener('change', () => { preserveDrawerDraft(); render(); });
      root.querySelector('[data-eq-input="type_id"]')?.addEventListener('change', (event) => {
        preserveDrawerDraft();
        if (event.currentTarget.value === '__new__') {
          state.drawer.unit.type_id = '';
          openCatalogEditor('type', 'drawer');
        } else {
          render();
        }
      });
      root.querySelector('[data-eq-input="yard_id"]')?.addEventListener('change', (event) => {
        preserveDrawerDraft();
        if (event.currentTarget.value === '__new__') {
          openCatalogEditor('yard', 'drawer');
        } else {
          render();
        }
      });
      const photoTile = root.querySelector('[data-eq-photo-pick]');
      photoTile?.addEventListener('click', (event) => {
        if (event.target.closest?.('[data-eq-photo-crop]')) return;
        window.clearTimeout(state.photoClickTimer);
        state.photoClickTimer = window.setTimeout(chooseUnitPhoto, 240);
      });
      photoTile?.addEventListener('keydown', (event) => {
        if (event.target.closest?.('[data-eq-photo-crop]') || !['Enter',' '].includes(event.key)) return;
        event.preventDefault();
        chooseUnitPhoto();
      });
      photoTile?.addEventListener('dblclick', (event) => {
        if (event.target.closest?.('[data-eq-photo-crop]')) return;
        event.preventDefault();
        window.clearTimeout(state.photoClickTimer);
        state.photoClickTimer = null;
        void recropUnitPhoto();
      });
      root.querySelector('[data-eq-photo-crop]')?.addEventListener('click', (event) => {
        event.preventDefault();
        event.stopPropagation();
        window.clearTimeout(state.photoClickTimer);
        state.photoClickTimer = null;
        void recropUnitPhoto();
      });
      root.querySelector('[data-eq-pickup-note-add]')?.addEventListener('click', () => {
        preserveDrawerDraft(); const acquisition = obj(state.drawer.unit.acquisition); const pickup = obj(acquisition.pickup_condition);
        state.drawer.unit.acquisition = { ...acquisition, pickup_condition:{ ...pickup, notes:[...arr(pickup.notes), ''] } }; render();
      });
      root.querySelectorAll('[data-eq-pickup-note-remove]').forEach((button) => button.addEventListener('click', () => {
        preserveDrawerDraft(); const acquisition = obj(state.drawer.unit.acquisition); const pickup = obj(acquisition.pickup_condition); const notes = arr(pickup.notes).slice(); notes.splice(Number(button.dataset.eqPickupNoteRemove), 1);
        state.drawer.unit.acquisition = { ...acquisition, pickup_condition:{ ...pickup, notes } }; render();
      }));
      root.querySelector('[data-eq-pickup-media-add]')?.addEventListener('click', () => {
        preserveDrawerDraft(); const picker = document.createElement('input'); picker.type = 'file'; picker.accept = 'image/*,video/*'; picker.multiple = true;
        picker.addEventListener('change', async () => {
          const files = [...(picker.files || [])]; if (!files.length) return;
          try {
            const uploads = await Promise.allSettled(files.map((file) => uploadMediaFile(file, { slot:'rental_pickup_condition', role:'rental_pickup_condition' })));
            const added = uploads.filter((result) => result.status === 'fulfilled').map((result) => result.value);
            preserveDrawerDraft();
            const acquisition = obj(state.drawer.unit.acquisition); const pickup = obj(acquisition.pickup_condition);
            state.drawer.unit.acquisition = { ...acquisition, pickup_condition:{ ...pickup, media:[...arr(pickup.media), ...added] } }; render();
            const failed = uploads.length - added.length;
            if (failed) showToast((globalThis.PlatformLanguage?.text("equipment","m_09b6f65ba14e08","Pickup condition") ?? "Pickup condition"), ((v0,v1,v2) => globalThis.PlatformLanguage?.text("equipment","m_cd1fcdebee4a30",`${v0} uploaded; ${v1} file${v2} could not be uploaded.`,{v0,v1,v2}) ?? `${v0} uploaded; ${v1} file${v2} could not be uploaded.`)(added.length,failed,failed === 1 ? '' : 's'), false);
          } catch (error) { showToast((globalThis.PlatformLanguage?.text("equipment","m_09b6f65ba14e08","Pickup condition") ?? "Pickup condition"), statusError(error, 'The condition media could not be uploaded.'), false); }
        }); picker.click();
      });
      root.querySelectorAll('[data-eq-pickup-media-remove]').forEach((button) => button.addEventListener('click', () => {
        preserveDrawerDraft(); const acquisition = obj(state.drawer.unit.acquisition); const pickup = obj(acquisition.pickup_condition); const media = arr(pickup.media).slice(); media.splice(Number(button.dataset.eqPickupMediaRemove), 1);
        state.drawer.unit.acquisition = { ...acquisition, pickup_condition:{ ...pickup, media } }; render();
      }));

      root.querySelectorAll('[data-eq-crop-close]').forEach((button) => button.addEventListener('click', closePhotoCrop));
      root.querySelector('[data-eq-crop-apply]')?.addEventListener('click', () => void applyPhotoCrop());
      root.querySelector('[data-eq-crop-zoom]')?.addEventListener('input', (event) => { if (state.crop) { state.crop.zoom = Number(event.currentTarget.value) || 1; drawPhotoCrop(); } });
      const cropStage = root.querySelector('[data-eq-crop-stage]');
      cropStage?.addEventListener('pointerdown', (event) => { if (!state.crop) return; state.crop.dragging = true; state.crop.lastX = event.clientX; state.crop.lastY = event.clientY; cropStage.setPointerCapture?.(event.pointerId); });
      cropStage?.addEventListener('pointermove', (event) => { if (!state.crop?.dragging) return; const dx = event.clientX - state.crop.lastX; const dy = event.clientY - state.crop.lastY; state.crop.lastX = event.clientX; state.crop.lastY = event.clientY; state.crop.focusX = Math.max(0, Math.min(1, state.crop.focusX - dx / 240)); state.crop.focusY = Math.max(0, Math.min(1, state.crop.focusY - dy / 180)); drawPhotoCrop(); });
      cropStage?.addEventListener('pointerup', () => { if (state.crop) state.crop.dragging = false; });

      root.querySelectorAll('[data-eq-types-open]').forEach((button) => button.addEventListener('click', () => { state.typesOpen = true; state.typesShowArchived = false; render(); }));
      const typesBack = root.querySelector('[data-eq-types-back]');
      typesBack?.addEventListener('mousedown', (event) => { if (event.target === typesBack) { state.typesOpen = false; render(); } });
      root.querySelector('[data-eq-types-close]')?.addEventListener('click', () => { state.typesOpen = false; render(); });
      root.querySelector('[data-eq-type-add]')?.addEventListener('click', () => openCatalogEditor('type', 'types'));
      root.querySelectorAll('[data-eq-type-edit]').forEach((button) => button.addEventListener('click', () => {
        const type = arr(state.types).find((entry) => clean(entry.id) === button.dataset.eqTypeEdit);
        if (!type) return;
        openCatalogEditor('type', 'types', type);
      }));
      root.querySelectorAll('[data-eq-type-archive]').forEach((button) => button.addEventListener('click', () => {
        const type = arr(state.types).find((entry) => clean(entry.id) === button.dataset.eqTypeArchive);
        if (!type) return;
        openArchiveConfirm('type', type);
      }));
      root.querySelector('[data-eq-types-archive-view]')?.addEventListener('click', () => void showCatalogArchive('type'));
      root.querySelector('[data-eq-types-active]')?.addEventListener('click', () => { state.typesShowArchived = false; render(); });
      root.querySelectorAll('[data-eq-type-restore]').forEach((button) => button.addEventListener('click', () => { const type = arr(state.types).find((entry) => clean(entry.id) === button.dataset.eqTypeRestore); if (type) void restoreCatalogEntity('type', type); }));
      root.querySelectorAll('[data-eq-yards-open]').forEach((button) => button.addEventListener('click', () => { state.yardsOpen = true; state.yardsShowArchived = false; render(); }));
      const yardsBack = root.querySelector('[data-eq-yards-back]');
      yardsBack?.addEventListener('mousedown', (event) => { if (event.target === yardsBack) { state.yardsOpen = false; render(); } });
      root.querySelector('[data-eq-yards-close]')?.addEventListener('click', () => { state.yardsOpen = false; render(); });
      root.querySelector('[data-eq-yard-add]')?.addEventListener('click', () => openCatalogEditor('yard', 'yards'));
      root.querySelectorAll('[data-eq-yard-edit]').forEach((button) => button.addEventListener('click', () => {
        const yard = arr(state.yards).find((entry) => clean(entry.id) === button.dataset.eqYardEdit); if (!yard) return;
        openCatalogEditor('yard', 'yards', yard);
      }));
      root.querySelectorAll('[data-eq-yard-archive]').forEach((button) => button.addEventListener('click', () => {
        const yard = arr(state.yards).find((entry) => clean(entry.id) === button.dataset.eqYardArchive); if (!yard) return;
        openArchiveConfirm('yard', yard);
      }));
      root.querySelector('[data-eq-yards-archive-view]')?.addEventListener('click', () => void showCatalogArchive('yard'));
      root.querySelector('[data-eq-yards-active]')?.addEventListener('click', () => { state.yardsShowArchived = false; render(); });
      root.querySelectorAll('[data-eq-yard-restore]').forEach((button) => button.addEventListener('click', () => { const yard = arr(state.yards).find((entry) => clean(entry.id) === button.dataset.eqYardRestore); if (yard) void restoreCatalogEntity('yard', yard); }));
    }

    const handle = {
      applyRoute(route = {}){
        if (destroyed || route.tab !== 'equipment') return;
        const nextView = clean(route.equipmentView) || 'fleet';
        const nextItem = clean(route.equipmentItem);
        if (nextView !== state.view) {
          state.view = nextView;
          if (nextView === 'fleet' && !state.units) { void loadFleet(); return; }
        }
        if (nextItem && clean(state.drawer?.unit?.id) !== nextItem) { void openUnit(nextItem); return; }
        if (!nextItem && state.drawer && state.drawer.mode === 'view') { state.drawer = null; }
        render();
      },
      destroy(){
        destroyed = true;
        state.settingsHandle?.destroy?.();
        if (activeEquipmentHandle === handle) activeEquipmentHandle = null;
        root.innerHTML = '';
      }
    };
    activeEquipmentHandle = handle;

    const initialRoute = Portal.navigation?.read?.() || {};
    if (initialRoute.tab === 'equipment' && (clean(initialRoute.equipmentView) || clean(initialRoute.equipmentItem))) {
      state.view = clean(initialRoute.equipmentView) || 'fleet';
      render();
      if (state.view === 'fleet') void loadFleet();
      if (clean(initialRoute.equipmentItem)) void openUnit(clean(initialRoute.equipmentItem));
    } else {
      render();
      void loadFleet();
    }
    return handle;
  }

  let activeEquipmentHandle = null;
  Portal.navigation?.registerHandler?.('equipment-route', {
    priority: 420,
    immediate: true,
    apply(route){ activeEquipmentHandle?.applyRoute?.(route); }
  });

  Portal.apps?.registerPortalApp?.({
    id: 'portal.equipment',
    tabId: 'equipment',
    title: (globalThis.PlatformLanguage?.text("equipment","m_2813f320a63b94","Equipment") ?? "Equipment"),
    icon: 'fa-truck-pickup',
    order: 57,
    fullBleed: true,
    access: { applicationsAny: ['management'] },
    mount: mountEquipment
  });
})();
