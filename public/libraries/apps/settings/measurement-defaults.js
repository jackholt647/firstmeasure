/* Calculations: Settings › Reports › Default materials and labor, and the Calculations sub-tab of Materials settings
 * (materials/settings.js).
 * What a roof needs, worked out from its measurement report alone, for a project no document has defined yet. The
 * Project tab's Generate materials uses these when nothing is signed; a signed document's scope always replaces them.
 * Each material rule adds roof measurements, adds a waste allowance and says how the product is bought. Labor is the
 * work the job includes; how anyone is paid for it stays on their pay sheet. Stored server side
 * (public/v1/materials/measurement-defaults.ts); this file only presents and edits those settings.
 *
 * Presentation: one compact row per material (on, name, how it is worked out, the price book item), with its details
 * folded under the row; explanations are tooltips; choices are the dropdown and segmented controls below, not native
 * selects. Unknown fields on a rule (alternatives) are kept as they are.
 */
(function(root){
  'use strict';
  const esc = (value) => String(value ?? '').replace(/[&<>"']/g, (c) => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' }[c]));
  const text = (value) => String(value ?? '').trim();
  const fill = (template, values) => String(template).replace(/\{(\w+)\}/g, (match, name) => (values && name in values ? String(values[name]) : match));
  const t = (key, fallback, values) => { const text = fill(fallback, values); return globalThis.PlatformLanguage?.text?.('settings', key, text, values) ?? text; };
  const num = (value, fallback = 0) => { const n = Number(value); return Number.isFinite(n) ? n : fallback; };
  const round = (value, places = 4) => String(Math.round(num(value) * 10 ** places) / 10 ** places);
  const clone = (value) => JSON.parse(JSON.stringify(value));
  const FONT = `'Inter',system-ui,-apple-system,"Segoe UI",Roboto,Arial,sans-serif`;

  function csrf(){
    try {
      const name = text(window.__APP?.platformSessionCookieName || 'fm_platform_session');
      const found = document.cookie.split(';').map((part) => part.trim()).find((part) => part.startsWith(`${encodeURIComponent(`${name}_csrf`)}=`));
      return found ? decodeURIComponent(found.split('=').slice(1).join('=')) : '';
    } catch (_) { return ''; }
  }
  async function request(path, options = {}){
    if (window.MaterialsAPI?.request) return window.MaterialsAPI.request(path, options);
    const base = text(window.__APP?.materialsApiBase) || `${location.origin}/v1/materials`;
    const method = text(options.method || 'GET').toUpperCase();
    const response = await fetch(`${base.replace(/\/+$/, '')}/${path.replace(/^\/+/, '')}`, { method, credentials:'include', cache:'no-store', headers:{ Accept:'application/json', ...(options.body ? { 'Content-Type':'application/json' } : {}), ...(method !== 'GET' && csrf() ? { 'X-Platform-CSRF':csrf() } : {}) }, ...(options.body ? { body:JSON.stringify(options.body) } : {}) });
    const raw = await response.text();
    let data = null;
    try { data = raw ? JSON.parse(raw) : null; } catch (_) {}
    if (!response.ok || data?.ok === false) { const error = new Error(text(data?.message || data?.error) || `Request failed (${response.status})`); error.status = response.status; error.data = data; throw error; }
    return data;
  }
  async function products(orgId){
    const read = window.PlatformAPI?.publication?.read;
    if (typeof read !== 'function') return [];
    try {
      const result = await read.call(window.PlatformAPI.publication, orgId, { provider:'materials-inputs', export:'products', target:{ scope:'organization', organizationId:orgId } });
      return Array.isArray(result?.value) ? result.value : [];
    } catch (_) { return []; }
  }

  function injectStyles(){
    if (document.getElementById('fm-measurement-defaults-style')) return;
    const style = document.createElement('style');
    style.id = 'fm-measurement-defaults-style';
    style.textContent = `
      .md-wrap,.md-dd-pop{font-family:var(--md-font,${FONT})}
      .md-wrap.md-wrap :is(div,p,h3,h4,button,a,input,label,span,strong,small,summary){font-family:inherit}
      .md-dd-pop.md-dd-pop :is(div,button,input,small,span){font-family:inherit}
      .md-wrap{display:flex;flex-direction:column;gap:12px;font-size:12.5px;color:#344054;max-width:1180px}
      .md-bar{display:flex;align-items:center;gap:10px;min-height:32px}
      .md-bar h3{margin:0;font-size:15px;font-weight:650;color:#101828}
      .md-status{flex:1;min-width:0;font-size:12px;color:#667085;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.md-status.error{color:#b42318}.md-status.ok{color:#067647}
      .md-info{display:inline-grid;place-items:center;width:18px;height:18px;border-radius:50%;color:#98a2b3;font-size:12px;cursor:help;flex:none}.md-info:hover,.md-info:focus-visible{color:#475467;outline:none}
      .md-btn{height:32px;display:inline-flex;align-items:center;gap:6px;padding:0 12px;border:1px solid #d0d5dd;border-radius:8px;background:#fff;color:#344054;font-size:12.5px;font-weight:600;cursor:pointer;white-space:nowrap;transition:background .15s,border-color .15s}
      .md-btn:hover:not(:disabled){background:#f9fafb;border-color:#98a2b3}.md-btn:disabled{opacity:.5;cursor:default}.md-btn i{font-size:11px;color:#667085}
      .md-btn.ghost{border-color:transparent;background:transparent;color:#475467}.md-btn.ghost:hover{background:#f2f4f7;border-color:transparent}
      .md-icon{width:30px;height:30px;display:inline-grid;place-items:center;border:0;border-radius:8px;background:transparent;color:#98a2b3;cursor:pointer;transition:background .15s,color .15s;flex:none}.md-icon:hover{background:#f2f4f7;color:#475467}.md-icon.danger:hover{background:#fef3f2;color:#d92d20}
      .md-card{border:1px solid #e4e7ec;border-radius:12px;background:#fff;box-shadow:0 1px 2px rgba(16,24,40,.04)}
      .md-card-head{display:flex;align-items:center;gap:8px;padding:12px 14px;border-bottom:1px solid #f0f2f5}
      .md-card-head h4{margin:0;font-size:13.5px;font-weight:650;color:#101828}
      .md-card-head .md-spacer{flex:1}
      .md-off .md-card-body{opacity:.5}
      .md-switch{position:relative;width:34px;height:20px;flex:none;appearance:none;-webkit-appearance:none;margin:0;border-radius:999px;background:#d0d5dd;cursor:pointer;transition:background .15s}
      .md-switch::after{content:'';position:absolute;top:2px;left:2px;width:16px;height:16px;border-radius:50%;background:#fff;box-shadow:0 1px 2px rgba(16,24,40,.2);transition:left .15s}
      .md-switch:checked{background:var(--primary,#d93025)}.md-switch:checked::after{left:16px}
      .md-switch.small{width:28px;height:16px}.md-switch.small::after{width:12px;height:12px}.md-switch.small:checked::after{left:14px}
      .md-switch:focus-visible{outline:2px solid var(--primary,#d93025);outline-offset:2px}
      .md-waste-pill{display:inline-flex;align-items:center;gap:6px;height:28px;padding:0 10px;border:1px solid #e4e7ec;border-radius:999px;background:#f9fafb;color:#475467;font-size:12px;font-weight:600;cursor:pointer}
      .md-waste-pill:hover{border-color:#d0d5dd;background:#fff}.md-waste-pill[aria-expanded="true"]{border-color:#d0d5dd;background:#fff;color:#101828}.md-waste-pill i{font-size:10px;color:#98a2b3}
      .md-waste{display:flex;flex-wrap:wrap;gap:8px 14px;align-items:center;padding:10px 14px;border-bottom:1px solid #f0f2f5;background:#fcfcfd}
      .md-waste label{display:inline-flex;align-items:center;gap:6px;font-size:12px;color:#475467;font-weight:500}
      .md-num{height:28px;width:64px;box-sizing:border-box;padding:0 8px;border:1px solid #d0d5dd;border-radius:7px;background:#fff;font-size:12.5px;color:#101828;text-align:right;-moz-appearance:textfield;appearance:textfield}
      .md-num::-webkit-outer-spin-button,.md-num::-webkit-inner-spin-button{-webkit-appearance:none;margin:0}
      .md-num:focus,.md-text:focus{outline:none;border-color:var(--primary,#d93025);box-shadow:0 0 0 3px rgba(var(--primary-rgb,217,48,37),.1)}
      .md-text{height:28px;box-sizing:border-box;padding:0 8px;border:1px solid #d0d5dd;border-radius:7px;background:#fff;font-size:12.5px;color:#101828;min-width:0}
      .md-cols,.md-row{display:grid;grid-template-columns:28px minmax(140px,1.1fr) minmax(160px,1.6fr) minmax(170px,1.2fr) 30px 30px;align-items:center;gap:10px;padding:0 10px 0 14px}
      .md-cols{min-height:30px;font-size:11px;font-weight:600;color:#98a2b3;letter-spacing:.02em;border-bottom:1px solid #f0f2f5}
      .md-rule{border-bottom:1px solid #f2f4f7}.md-rule:last-child{border-bottom:0}
      .md-row{min-height:46px}
      .md-rule.is-off .md-row>:not(.md-row-on){opacity:.5}
      .md-name{height:30px;width:100%;box-sizing:border-box;padding:0 8px;border:1px solid transparent;border-radius:7px;background:transparent;font-size:13px;font-weight:600;color:#101828;min-width:0}
      .md-name:hover{background:#f9fafb}.md-name:focus{outline:none;border-color:#d0d5dd;background:#fff}
      .md-formula{min-width:0;display:flex;align-items:center;gap:6px;border:0;background:transparent;padding:4px 6px;margin-left:-6px;border-radius:7px;color:#475467;font-size:12px;text-align:left;cursor:pointer}
      .md-formula:hover{background:#f9fafb;color:#101828}.md-formula span{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
      .md-chev{transition:transform .2s ease}.md-rule.is-open .md-chev{transform:rotate(180deg)}
      .md-details{display:grid;grid-template-columns:repeat(auto-fit,minmax(250px,1fr));gap:12px 18px;padding:4px 14px 14px 52px}
      .md-field{display:flex;flex-direction:column;gap:5px;min-width:0}
      .md-label{display:flex;align-items:center;gap:4px;font-size:11px;font-weight:600;color:#667085}
      .md-terms{display:flex;flex-direction:column;gap:5px}.md-term{display:flex;align-items:center;gap:5px;min-width:0}.md-term .md-dd{flex:1}
      .md-inline{display:flex;align-items:center;gap:6px;flex-wrap:nowrap;white-space:nowrap;font-size:12px;color:#475467}
      .md-link{border:0;background:transparent;padding:2px 0;color:#475467;font-size:12px;font-weight:600;cursor:pointer;text-align:left;display:inline-flex;align-items:center;gap:5px}.md-link:hover{color:#101828}.md-link i{font-size:10px}
      .md-foot{display:flex;align-items:center;gap:8px;padding:10px 14px;border-top:1px solid #f0f2f5}
      .md-seg{display:inline-flex;padding:2px;border-radius:8px;background:#f2f4f7;gap:2px;flex:none}
      .md-seg button{height:24px;min-width:28px;padding:0 9px;border:0;border-radius:6px;background:transparent;color:#475467;font-size:12px;font-weight:600;cursor:pointer;transition:background .15s,color .15s}
      .md-seg button[aria-checked="true"]{background:#fff;color:#101828;box-shadow:0 1px 2px rgba(16,24,40,.12)}
      .md-dd{position:relative;display:inline-flex;align-items:center;gap:8px;height:30px;min-width:0;width:100%;box-sizing:border-box;padding:0 9px 0 10px;border:1px solid #d0d5dd;border-radius:8px;background:#fff;color:#101828;font-size:12.5px;cursor:pointer;text-align:left;transition:border-color .15s,box-shadow .15s}
      .md-dd:hover{border-color:#98a2b3}.md-dd[aria-expanded="true"]{border-color:var(--primary,#d93025);box-shadow:0 0 0 3px rgba(var(--primary-rgb,217,48,37),.1)}
      .md-dd>span{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.md-dd>span.is-placeholder{color:#98a2b3}.md-dd>i{font-size:10px;color:#98a2b3;flex:none}
      .md-dd.is-missing{border-color:#fda29b}.md-dd.is-missing>span{color:#b42318}
      .md-dd-pop{position:fixed;z-index:2147483600;min-width:220px;max-width:360px;max-height:320px;display:flex;flex-direction:column;border:1px solid #e4e7ec;border-radius:10px;background:#fff;box-shadow:0 16px 40px rgba(16,24,40,.16),0 2px 6px rgba(16,24,40,.06);overflow:hidden;color:#101828;font-size:12.5px;animation:md-pop .14s ease-out}
      @keyframes md-pop{from{opacity:0;transform:translateY(-4px)}to{opacity:1;transform:none}}
      .md-dd-pop input{margin:8px 8px 4px;height:30px;padding:0 9px;border:1px solid #d0d5dd;border-radius:7px;font:inherit;font-size:12.5px;outline:none}.md-dd-pop input:focus{border-color:var(--primary,#d93025)}
      .md-dd-list{overflow:auto;padding:4px}
      .md-dd-group{padding:8px 8px 3px;font-size:10.5px;font-weight:650;color:#98a2b3;letter-spacing:.03em;text-transform:uppercase}
      .md-dd-opt{display:flex;align-items:center;gap:8px;width:100%;min-height:30px;padding:5px 8px;border:0;border-radius:7px;background:transparent;color:#101828;font:inherit;font-size:12.5px;text-align:left;cursor:pointer}
      .md-dd-opt:hover,.md-dd-opt.is-active{background:#f2f4f7}.md-dd-opt[aria-selected="true"]{font-weight:600}.md-dd-opt i{margin-left:auto;font-size:10px;color:var(--primary,#d93025)}
      .md-dd-opt small{color:#98a2b3;font-size:11px}
      .md-dd-empty{padding:12px;color:#98a2b3;font-size:12px}
      .md-labor{display:flex;flex-wrap:wrap;gap:8px;padding:12px 14px}
      .md-work{display:inline-flex;align-items:center;gap:7px;height:32px;padding:0 12px 0 10px;border:1px solid #d0d5dd;border-radius:999px;background:#fff;color:#475467;font-size:12.5px;font-weight:600;cursor:pointer;transition:background .15s,border-color .15s,color .15s}
      .md-work i{font-size:11px;color:#d0d5dd}.md-work:hover{border-color:#98a2b3}
      .md-work[aria-pressed="true"]{border-color:var(--primary,#d93025);background:rgba(var(--primary-rgb,217,48,37),.06);color:var(--primary-readable,var(--primary,#d93025))}.md-work[aria-pressed="true"] i{color:inherit}
      .md-loading{padding:18px;color:#667085}
      .md-wrap{container-type:inline-size;container-name:md}
      .md-card-head h4{white-space:nowrap}
      /* Narrow (beside the docked agent, or in Settings next to its navigation): the formula and the product drop under the name. */
      @container md (max-width:760px){.md-cols{display:none}.md-row{grid-template-columns:28px minmax(0,1fr) 30px 30px;gap:4px 8px;padding:8px 10px 10px 14px}.md-row .md-formula{grid-column:2 / 4;grid-row:2}.md-row .md-row-product{grid-column:2 / 4;grid-row:3}.md-details{padding-left:14px;grid-template-columns:1fr}.md-details .md-field{grid-column:auto!important}.md-waste-pill{padding:0 8px}}
      @media(max-width:860px){.md-cols{display:none}.md-row{grid-template-columns:28px minmax(0,1fr) 30px 30px;padding:6px 10px}.md-row .md-formula,.md-row .md-row-product{grid-column:2 / -1}.md-details{padding-left:14px}}
      @media(prefers-reduced-motion:reduce){.md-dd-pop{animation:none}.md-chev{transition:none}}
    `;
    document.head.append(style);
  }

  // ---- The dropdown: a button and a listbox popover. options: [{ value, label, group, detail }].
  let openPop = null;
  function closePop(){ if (!openPop) return; const { pop, button, cleanup } = openPop; openPop = null; cleanup(); pop.remove(); button.setAttribute('aria-expanded', 'false'); }
  function openDropdown(button, options, value, { search = false, placeholder = '' } = {}, onPick){
    if (openPop?.button === button) { closePop(); return; }
    closePop();
    const doc = button.ownerDocument, win = doc.defaultView || window;
    const pop = doc.createElement('div');
    pop.className = 'md-dd-pop';
    pop.style.setProperty('--md-font', getComputedStyle(button).fontFamily);
    pop.setAttribute('data-fmr-ignore', '');
    pop.innerHTML = `${search ? `<input type="search" placeholder="${esc(placeholder || t('md_find', 'Find'))}" aria-label="${esc(placeholder || t('md_find', 'Find'))}" autocomplete="off">` : ''}<div class="md-dd-list" role="listbox"></div>`;
    const list = pop.querySelector('.md-dd-list'), input = pop.querySelector('input');
    let active = -1;
    const draw = () => {
      const query = text(input?.value).toLowerCase();
      const shown = options.filter((option) => !query || `${option.label} ${option.group || ''} ${option.detail || ''}`.toLowerCase().includes(query));
      let group = null;
      list.innerHTML = shown.length ? shown.map((option, index) => {
        const head = option.group && option.group !== group ? `<div class="md-dd-group">${esc(option.group)}</div>` : '';
        group = option.group || group;
        return `${head}<button type="button" class="md-dd-opt" role="option" data-index="${index}" aria-selected="${option.value === value}">${esc(option.label)}${option.detail ? ` <small>${esc(option.detail)}</small>` : ''}${option.value === value ? '<i class="fas fa-check" aria-hidden="true"></i>' : ''}</button>`;
      }).join('') : `<div class="md-dd-empty">${esc(t('md_no_match', 'Nothing matches.'))}</div>`;
      list.__shown = shown;
      active = -1;
    };
    draw();
    doc.body.append(pop);
    const place = () => {
      const box = button.getBoundingClientRect(), height = pop.offsetHeight, width = Math.max(box.width, 220);
      const below = win.innerHeight - box.bottom - 8;
      pop.style.width = `${Math.min(width, 360)}px`;
      pop.style.left = `${Math.max(8, Math.min(box.left, win.innerWidth - Math.min(width, 360) - 8))}px`;
      pop.style.top = `${below >= Math.min(height, 200) ? box.bottom + 4 : Math.max(8, box.top - height - 4)}px`;
    };
    place();
    button.setAttribute('aria-expanded', 'true');
    const pick = (option) => { closePop(); button.focus({ preventScroll:true }); onPick(option.value); };
    pop.addEventListener('click', (event) => { const opt = event.target.closest('.md-dd-opt'); if (opt) pick(list.__shown[Number(opt.dataset.index)]); });
    input?.addEventListener('input', draw);
    const move = (delta) => { const opts = [...list.querySelectorAll('.md-dd-opt')]; if (!opts.length) return; active = (active + delta + opts.length) % opts.length; opts.forEach((opt, i) => opt.classList.toggle('is-active', i === active)); const opt = opts[active]; if (opt.offsetTop < list.scrollTop) list.scrollTop = opt.offsetTop - 4; else if (opt.offsetTop + opt.offsetHeight > list.scrollTop + list.clientHeight) list.scrollTop = opt.offsetTop + opt.offsetHeight - list.clientHeight + 4; };
    const onKey = (event) => {
      if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); closePop(); button.focus({ preventScroll:true }); }
      else if (event.key === 'ArrowDown') { event.preventDefault(); move(1); }
      else if (event.key === 'ArrowUp') { event.preventDefault(); move(-1); }
      else if (event.key === 'Enter' && active >= 0) { event.preventDefault(); pick(list.__shown[active]); }
    };
    const onDown = (event) => { if (!pop.contains(event.target) && event.target !== button && !button.contains(event.target)) closePop(); };
    // A scroll around it moves it with its button; once the button is scrolled out of sight it closes.
    const onScroll = (event) => { if (pop.contains(event.target)) return; const box = button.getBoundingClientRect(); if (box.bottom < 0 || box.top > win.innerHeight || !button.isConnected) closePop(); else place(); };
    doc.addEventListener('keydown', onKey, true);
    doc.addEventListener('pointerdown', onDown, true);
    doc.addEventListener('scroll', onScroll, true);
    win.addEventListener('resize', closePop);
    openPop = { pop, button, cleanup(){ doc.removeEventListener('keydown', onKey, true); doc.removeEventListener('pointerdown', onDown, true); doc.removeEventListener('scroll', onScroll, true); win.removeEventListener('resize', closePop); } };
    if (input) input.focus({ preventScroll:true });
    else { const selected = [...list.querySelectorAll('.md-dd-opt')].findIndex((opt) => opt.getAttribute('aria-selected') === 'true'); move(selected >= 0 ? selected + 1 : 1); }
  }

  function mount(host, options = {}){
    injectStyles();
    const orgId = () => text(typeof options.orgId === 'function' ? options.orgId() : options.orgId);
    // In Materials settings the sub-tab is the title; in Settings › Reports the panel names itself.
    const titled = options.surface !== 'materials_settings';
    // Like every settings page this saves as it is changed; the page's own Save-button autosave is switched off here
    // because adding or removing a rule is a click, not a field change.
    host.dataset.settingsAutosave = 'off';
    let saveTimer = null, destroyed = false;
    const state = { loading:true, saving:false, dirty:false, settings:null, industry:null, catalog:{ measurements:[], work_items:[] }, revision:0, stored:false, products:[], status:'', statusKind:'', open:new Set(), wasteOpen:false };
    const measurement = (id) => state.catalog.measurements.find((entry) => entry.id === id);
    const unitOf = (rule) => measurement(rule.terms?.[0]?.measurement)?.unit || '';
    const ruleId = (rule, index) => text(rule.key) || `#${index}`;
    const setStatus = (message, kind = '') => { state.status = message; state.statusKind = kind; const el = host.querySelector('[data-md-status]'); if (el) { el.textContent = message; el.className = `md-status ${kind}`; } };
    const info = (tip) => `<span class="md-info" tabindex="0" role="img" aria-label="${esc(tip)}" data-fm-tooltip="${esc(tip)}"><i class="fas fa-circle-info" aria-hidden="true"></i></span>`;
    const seg = (attrs, value, choices, label) => `<div class="md-seg" role="radiogroup" aria-label="${esc(label)}" ${attrs}>${choices.map(([id, text, tip]) => `<button type="button" role="radio" data-md-seg="${esc(id)}" aria-checked="${id === value}"${tip ? ` data-fm-tooltip="${esc(tip)}"` : ''}>${esc(text)}</button>`).join('')}</div>`;
    const dd = (attrs, label, placeholder, aria, missing = false) => `<button type="button" class="md-dd${missing ? ' is-missing' : ''}" aria-haspopup="listbox" aria-expanded="false" aria-label="${esc(aria)}" ${attrs}><span class="${label ? '' : 'is-placeholder'}">${esc(label || placeholder)}</span><i class="fas fa-chevron-down" aria-hidden="true"></i></button>`;

    function sentence(rule){
      const parts = (rule.terms || []).map((term, index) => `${term.factor < 0 ? '− ' : index ? '+ ' : ''}${Math.abs(term.factor) !== 1 ? `${round(Math.abs(term.factor), 2)} × ` : ''}${measurement(term.measurement)?.label || term.measurement}`);
      const waste = rule.waste === 'roof' ? t('md_waste_roof_short', 'roof waste') : num(rule.waste) ? `${round(rule.waste, 2)}% waste` : '';
      const pack = rule.package ? t('md_bought_by', 'bought by the {unit} of {coverage} {lineUnit}', { unit:rule.package.unit, coverage:round(rule.package.coverage, 3), lineUnit:unitOf(rule) }) : '';
      return [parts.join(' '), waste ? `+ ${waste}` : '', pack ? `· ${pack}` : ''].filter(Boolean).join(' ');
    }
    function productFor(rule){ return (rule.product_id && state.products.find((item) => item.id === rule.product_id)) || null; }
    function productOptions(){
      return [{ value:'', label:t('md_product_by_type', 'Any item of the type below') },
        ...[...state.products].sort((a, b) => (text(a.type) || 'zz').localeCompare(text(b.type) || 'zz') || text(a.name).localeCompare(text(b.name)))
          .map((item) => ({ value:item.id, label:item.name, group:text(item.type) || t('md_other', 'Other') }))];
    }
    function productControl(rule){
      // The price book could not be read: the item is typed in, as the pay sheet editor does.
      if (!state.products.length) return `<input type="text" class="md-text" style="width:100%" data-md-field="product_id" value="${esc(rule.product_id || '')}" placeholder="${esc(t('md_product_id', 'Price book item'))}" aria-label="${esc(t('md_product_id', 'Price book item'))}">`;
      const found = productFor(rule), missing = !!rule.product_id && !found;
      const label = found ? found.name : missing ? t('md_product_gone', 'Not in your price book') : rule.product_type ? t('md_product_any_type', 'Any {type}', { type:rule.product_type }) : '';
      return dd('data-md-dd="product" data-md-field="product_id"', label, t('md_product_choose', 'Choose a price book item'), t('md_product_id', 'Price book item'), missing);
    }
    function termsMarkup(rule){
      return `<div class="md-terms">${(rule.terms || []).map((term, termIndex) => `
        <div class="md-term" data-md-term="${termIndex}">
          ${seg('data-md-term-field="op"', term.factor < 0 ? '-' : '+', [['+', '+', t('md_add', 'Add')], ['-', '−', t('md_take_away', 'Take away')]], t('md_add_or_subtract', 'Add or take away'))}
          <input type="number" class="md-num" style="width:58px" data-md-term-field="factor" min="0" step="0.01" value="${esc(round(Math.abs(term.factor), 4))}" data-fm-tooltip="${esc(t('md_factor_tip', 'Times this much. 1 is the measurement as it is.'))}" aria-label="${esc(t('md_factor', 'Factor'))}">
          ${dd('data-md-dd="measurement" data-md-term-field="measurement"', measurement(term.measurement) ? `${measurement(term.measurement).label} (${measurement(term.measurement).unit})` : term.measurement, '', t('md_measurement', 'Measurement'))}
          ${rule.terms.length > 1 ? `<button type="button" class="md-icon danger" data-md-remove-term="${termIndex}" data-fm-tooltip="${esc(t('md_remove_measurement', 'Remove this measurement'))}" aria-label="${esc(t('md_remove_measurement', 'Remove this measurement'))}"><i class="fas fa-xmark" aria-hidden="true"></i></button>` : ''}
        </div>`).join('')}
        <button type="button" class="md-link" data-md-add-term><i class="fas fa-plus" aria-hidden="true"></i>${esc(t('md_add_measurement_short', 'Add a measurement'))}</button></div>`;
    }
    function ruleMarkup(rule, index){
      const id = ruleId(rule, index), open = state.open.has(id), off = rule.enabled === false;
      return `<div class="md-rule${open ? ' is-open' : ''}${off ? ' is-off' : ''}" data-md-rule="${index}">
        <div class="md-row">
          <span class="md-row-on"><input type="checkbox" class="md-switch small" data-md-field="enabled" ${off ? '' : 'checked'} aria-label="${esc(t('md_rule_on', 'Generate {name}', { name:rule.label }))}" data-fm-tooltip="${esc(off ? t('md_rule_off_tip', 'Off: this line is not generated') : t('md_rule_on_tip', 'On: this line is generated'))}"></span>
          <input type="text" class="md-name" data-md-field="label" value="${esc(rule.label)}" aria-label="${esc(t('md_rule_name', 'Name'))}">
          <button type="button" class="md-formula" data-md-toggle aria-expanded="${open}" data-fm-tooltip="${esc(t('md_formula_tip', 'How it is worked out from the report. Click to change it.'))}"><span>${esc(sentence(rule))}</span></button>
          <div class="md-row-product">${productControl(rule)}</div>
          <button type="button" class="md-icon" data-md-toggle aria-expanded="${open}" data-fm-tooltip="${esc(open ? t('md_less', 'Hide details') : t('md_more', 'Details'))}" aria-label="${esc(open ? t('md_less', 'Hide details') : t('md_more', 'Details'))}"><i class="fas fa-chevron-down md-chev" aria-hidden="true"></i></button>
          <button type="button" class="md-icon danger" data-md-remove-rule data-fm-tooltip="${esc(t('md_remove_rule', 'Remove {name}', { name:rule.label }))}" aria-label="${esc(t('md_remove_rule', 'Remove {name}', { name:rule.label }))}"><i class="fas fa-trash-can" aria-hidden="true"></i></button>
        </div>
        ${open ? `<div class="md-details">
          <div class="md-field" style="grid-column:span 2;min-width:min(100%,360px)"><span class="md-label">${esc(t('md_col_from', 'Measured from'))}${info(t('md_from_tip', 'Report measurements added together, each times a factor. Waste is added after.'))}</span>${termsMarkup(rule)}</div>
          <div class="md-field"><span class="md-label">${esc(t('md_col_waste', 'Waste'))}${info(t('md_waste_kind_tip', 'Roof waste follows the waste allowance above; a fixed percentage is the same on every roof.'))}</span>
            <div class="md-inline">${seg('data-md-field="waste_kind"', rule.waste === 'roof' ? 'roof' : 'fixed', [['roof', t('md_roof_waste', 'Roof waste')], ['fixed', t('md_fixed_waste', 'Fixed %')]], t('md_waste', 'Waste'))}${rule.waste === 'roof' ? '' : `<input type="number" class="md-num" data-md-field="waste" min="0" max="100" step="0.5" value="${esc(round(rule.waste, 2))}" aria-label="${esc(t('md_waste_percent', 'Waste percent'))}"><span>%</span>`}</div></div>
          <div class="md-field"><span class="md-label">${esc(t('md_col_package', 'Bought as'))}${info(t('md_package_tip', 'Ordered in whole packages: one package covers this much. Leave empty to order the measured amount.'))}</span>
            <div class="md-inline"><span>${esc(t('md_one', 'One'))}</span><input type="text" class="md-text" style="width:76px" data-md-field="package_unit" value="${esc(rule.package?.unit || '')}" placeholder="${esc(t('md_package', 'bundle'))}" aria-label="${esc(t('md_package_unit', 'Package'))}"><span>${esc(t('md_covers', 'covers'))}</span><input type="number" class="md-num" data-md-field="package_coverage" min="0" step="0.0001" value="${rule.package ? esc(round(rule.package.coverage, 4)) : ''}" aria-label="${esc(t('md_package_coverage', 'What one package covers'))}"><span>${esc(unitOf(rule))}</span></div></div>
          <div class="md-field"><span class="md-label">${esc(t('md_product_type_label', 'Item type'))}${info(t('md_product_type_tip', 'With no item chosen, the line uses the first price book item of this type. Not found, it uses this rule’s name.'))}</span><input type="text" class="md-text" data-md-field="product_type" value="${esc(rule.product_type || '')}" placeholder="${esc(t('md_product_type', 'or item type'))}" aria-label="${esc(t('md_product_type_label', 'Item type'))}"></div>
          <div class="md-field"><span class="md-label">${esc(t('md_group', 'Group'))}${info(t('md_group_tip', 'The heading this line sits under on the materials list.'))}</span><input type="text" class="md-text" data-md-field="group" value="${esc(rule.group || '')}" placeholder="${esc(t('md_group', 'Group'))}" aria-label="${esc(t('md_group', 'Group'))}"></div>
        </div>` : ''}
      </div>`;
    }

    function render(){
      closePop();
      host.style.setProperty('--md-font', getComputedStyle(document.body).fontFamily || FONT);
      if (state.loading) { host.innerHTML = `<div class="md-wrap"><div class="md-card md-loading">${esc(t('md_loading_calculations', 'Loading calculations…'))}</div></div>`; return; }
      if (!state.settings) { host.innerHTML = `<div class="md-wrap"><div class="md-card md-loading"><div class="md-status error">${esc(state.status || t('md_load_failed', 'The defaults could not load.'))}</div></div></div>`; return; }
      const s = state.settings, w = s.materials.waste;
      const status = state.status || (state.stored ? t('md_autosave', 'Changes save as you make them.') : t('md_not_saved_short', 'Industry defaults. A change is saved as your own.'));
      const wasteRange = `${round(w.min_percent, 1)}–${round(w.max_percent, 1)}%`;
      host.innerHTML = `
        <div class="md-wrap">
          <div class="md-bar">
            ${titled ? `<h3>${esc(t('md_title', 'Default materials and labor'))}</h3>` : ''}
            ${info(t('md_intro', 'When a project has a measurement report but no signed document, Generate materials in the Project tab uses these to build its materials, and the work the job includes when default labor is on. A signed document’s scope always replaces them.'))}
            <span class="md-status ${state.statusKind}" data-md-status role="status">${esc(status)}</span>
            <button type="button" class="md-btn ghost" data-md-reset data-fm-tooltip="${esc(t('md_reset_tip', 'Replace every rule and switch here with the industry defaults'))}"><i class="fas fa-rotate-left" aria-hidden="true"></i>${esc(t('md_reset_short', 'Reset to defaults'))}</button>
          </div>
          <section class="md-card ${s.materials.enabled ? '' : 'md-off'}" data-md-section="materials">
            <div class="md-card-head">
              <h4>${esc(t('md_materials', 'Default materials'))}</h4>
              ${info(`${t('md_materials_sub', 'Each line adds roof measurements together, adds waste, and is ordered in whole packages.')} ${t('md_materials_note', 'Pipe boots, vents and other penetrations are not in a measurement report, so they are not generated. A line with nothing measured (a roof with no valleys) is left out.')}`)}
              <span class="md-spacer"></span>
              <button type="button" class="md-waste-pill" data-md-waste-toggle aria-expanded="${state.wasteOpen}" data-fm-tooltip="${esc(t('md_waste_note', 'Roof waste grows with how cut up the roof is and how steep it is: a plain gable gets the base, a hip roof with valleys a few points more. Steep squares add their share of the steep allowance. Rounded to the half percent.'))}"><i class="fas fa-scissors" aria-hidden="true"></i>${esc(t('md_waste_pill', 'Roof waste {range}', { range:wasteRange }))}<i class="fas fa-chevron-${state.wasteOpen ? 'up' : 'down'}" aria-hidden="true"></i></button>
              <input type="checkbox" class="md-switch" data-md-switch="materials" ${s.materials.enabled ? 'checked' : ''} aria-label="${esc(t('md_materials', 'Default materials'))}" data-fm-tooltip="${esc(s.materials.enabled ? t('md_on', 'On') : t('md_off', 'Off'))}">
            </div>
            <div class="md-card-body">
              ${state.wasteOpen ? `<div class="md-waste" data-md-waste-panel>
                <label data-fm-tooltip="${esc(t('md_waste_base_tip', 'Every roof gets at least this much'))}">${esc(t('md_waste_base_short', 'Base'))}<input type="number" class="md-num" min="0" max="100" step="0.5" data-md-waste="base_percent" value="${esc(round(w.base_percent, 2))}">%</label>
                <label data-fm-tooltip="${esc(t('md_waste_cut', '+ % per ft of hip and valley per square'))}">${esc(t('md_waste_cut_short', 'Hips and valleys'))}<input type="number" class="md-num" min="0" max="10" step="0.1" data-md-waste="per_cut_foot_percent" value="${esc(round(w.per_cut_foot_percent, 2))}">%</label>
                <label data-fm-tooltip="${esc(t('md_waste_steep', '+ % for a roof all over 8/12'))}">${esc(t('md_waste_steep_short', 'Steep'))}<input type="number" class="md-num" min="0" max="100" step="0.5" data-md-waste="steep_percent" value="${esc(round(w.steep_percent, 2))}">%</label>
                <label>${esc(t('md_waste_min', 'Lowest %'))}<input type="number" class="md-num" min="0" max="100" step="0.5" data-md-waste="min_percent" value="${esc(round(w.min_percent, 2))}"></label>
                <label>${esc(t('md_waste_max', 'Highest %'))}<input type="number" class="md-num" min="0" max="100" step="0.5" data-md-waste="max_percent" value="${esc(round(w.max_percent, 2))}"></label>
              </div>` : ''}
              <div class="md-cols" aria-hidden="true"><span></span><span>${esc(t('md_col_material', 'Material'))}</span><span>${esc(t('md_col_worked_out', 'Worked out as'))}</span><span>${esc(t('md_col_product', 'Product'))}</span><span></span><span></span></div>
              <div class="md-rules">${s.materials.rules.map(ruleMarkup).join('')}</div>
              <div class="md-foot"><button type="button" class="md-btn" data-md-add-rule><i class="fas fa-plus" aria-hidden="true"></i>${esc(t('md_add_rule_short', 'Add a material'))}</button></div>
            </div>
          </section>
          <section class="md-card ${s.labor.enabled ? '' : 'md-off'}" data-md-section="labor">
            <div class="md-card-head">
              <h4>${esc(t('md_labor', 'Default labor'))}</h4>
              ${info(`${t('md_labor_sub', 'The work the job includes, each sized from the same measurements. Off, nothing is required of a work order until a document says so.')} ${t('md_labor_note', 'How each assignee is paid for this work, including pitch and story adders, is on their pay sheet (People › Pay sheets). Generating a work order prices it there.')}`)}
              <span class="md-spacer"></span>
              <input type="checkbox" class="md-switch" data-md-switch="labor" ${s.labor.enabled ? 'checked' : ''} aria-label="${esc(t('md_labor', 'Default labor'))}" data-fm-tooltip="${esc(s.labor.enabled ? t('md_on', 'On') : t('md_off', 'Off'))}">
            </div>
            <div class="md-card-body"><div class="md-labor">${state.catalog.work_items.map((item) => { const entry = s.labor.items.find((row) => row.item === item.id); const on = !!entry && entry.enabled !== false; return `
              <button type="button" class="md-work" data-md-work="${esc(item.id)}" aria-pressed="${on}" data-fm-tooltip="${esc(`${item.description || ''}${item.optional ? ` ${t('md_work_optional', 'Only where the roof has some.')}` : ''}`.trim() || item.label)}"><i class="fas ${on ? 'fa-circle-check' : 'fa-circle'}" aria-hidden="true"></i>${esc(item.label)}</button>`; }).join('')}</div></div>
          </section>
        </div>`;
    }

    // Redrawn after the event has finished bubbling, so the page's autosave still sees the field inside this opted-out editor.
    function changed(){ setTimeout(() => { if (!destroyed) render(); }, 0); clearTimeout(saveTimer); saveTimer = setTimeout(() => { saveTimer = null; save(); }, 600); }
    function ruleAt(element){ return state.settings.materials.rules[Number(element.closest('[data-md-rule]')?.dataset.mdRule)]; }
    function setField(element, value){
      const rule = ruleAt(element), field = element.dataset.mdField;
      if (!rule) return;
      if (field === 'enabled') rule.enabled = !!value;
      else if (field === 'waste_kind') { if ((value === 'roof') === (rule.waste === 'roof')) return; rule.waste = value === 'roof' ? 'roof' : 5; }
      else if (field === 'waste') rule.waste = num(value);
      else if (field === 'package_unit' || field === 'package_coverage') {
        const unit = text(field === 'package_unit' ? value : rule.package?.unit), coverage = field === 'package_coverage' ? num(value) : num(rule.package?.coverage);
        if (unit && coverage > 0) rule.package = { unit, coverage }; else if (!unit && !(coverage > 0)) delete rule.package; else rule.package = { unit:unit || 'each', coverage:coverage > 0 ? coverage : 1 };
      } else rule[field] = value;
      changed();
    }
    function setTerm(element, value){
      const rule = ruleAt(element), term = rule?.terms[Number(element.closest('[data-md-term]').dataset.mdTerm)];
      if (!term) return;
      const field = element.dataset.mdTermField;
      if (field === 'measurement') term.measurement = value;
      else if (field === 'op') term.factor = Math.abs(term.factor) * (value === '-' ? -1 : 1);
      else term.factor = Math.abs(num(value, 1)) * (term.factor < 0 ? -1 : 1);
      changed();
    }
    // One set of delegated listeners for the whole editor; the markup is redrawn after each change.
    host.addEventListener('change', (event) => {
      const input = event.target;
      if (!state.settings || !(input instanceof HTMLInputElement)) return;
      if (input.dataset.mdSwitch) { state.settings[input.dataset.mdSwitch].enabled = input.checked; changed(); }
      else if (input.dataset.mdWaste) { state.settings.materials.waste[input.dataset.mdWaste] = num(input.value); changed(); }
      else if (input.dataset.mdField) setField(input, input.type === 'checkbox' ? input.checked : input.value);
      else if (input.dataset.mdTermField) setTerm(input, input.value);
    });
    host.addEventListener('click', (event) => {
      if (!state.settings) return;
      const target = event.target;
      const segButton = target.closest('[data-md-seg]');
      if (segButton) {
        const group = segButton.closest('.md-seg');
        if (group.dataset.mdField) setField(group, segButton.dataset.mdSeg);
        else if (group.dataset.mdTermField) setTerm(group, segButton.dataset.mdSeg);
        return;
      }
      const dropdown = target.closest('[data-md-dd]');
      if (dropdown) {
        const rule = ruleAt(dropdown);
        if (dropdown.dataset.mdDd === 'product') openDropdown(dropdown, productOptions(), rule?.product_id || '', { search:state.products.length > 8, placeholder:t('md_product_find', 'Find a price book item') }, (value) => setField(dropdown, value));
        else {
          const term = rule?.terms[Number(dropdown.closest('[data-md-term]').dataset.mdTerm)];
          openDropdown(dropdown, state.catalog.measurements.map((entry) => ({ value:entry.id, label:entry.label, detail:entry.unit })), term?.measurement || '', { search:state.catalog.measurements.length > 10, placeholder:t('md_measurement_find', 'Find a measurement') }, (value) => setTerm(dropdown, value));
        }
        return;
      }
      const toggle = target.closest('[data-md-toggle]');
      if (toggle) {
        const index = Number(toggle.closest('[data-md-rule]').dataset.mdRule), id = ruleId(state.settings.materials.rules[index], index);
        if (state.open.has(id)) state.open.delete(id); else state.open.add(id);
        render();
        return;
      }
      if (target.closest('[data-md-waste-toggle]')) { state.wasteOpen = !state.wasteOpen; render(); return; }
      const work = target.closest('[data-md-work]');
      if (work) {
        const items = state.settings.labor.items, found = items.find((row) => row.item === work.dataset.mdWork), on = work.getAttribute('aria-pressed') !== 'true';
        if (found) found.enabled = on; else items.push({ item:work.dataset.mdWork, enabled:on });
        changed();
        return;
      }
      if (target.closest('[data-md-add-term]')) {
        const rule = ruleAt(target), first = measurement(rule.terms[0]?.measurement);
        const next = state.catalog.measurements.find((entry) => entry.unit === first?.unit && !rule.terms.some((term) => term.measurement === entry.id)) || state.catalog.measurements[0];
        if (next) { rule.terms.push({ measurement:next.id, factor:1 }); changed(); }
        return;
      }
      const removeTerm = target.closest('[data-md-remove-term]');
      if (removeTerm) { const rule = ruleAt(removeTerm); rule.terms.splice(Number(removeTerm.dataset.mdRemoveTerm), 1); changed(); return; }
      const removeRule = target.closest('[data-md-remove-rule]');
      if (removeRule) { state.settings.materials.rules.splice(Number(removeRule.closest('[data-md-rule]').dataset.mdRule), 1); changed(); return; }
      if (target.closest('[data-md-add-rule]')) {
        const keys = new Set(state.settings.materials.rules.map((rule) => rule.key));
        let n = state.settings.materials.rules.length + 1; while (keys.has(`material_${n}`)) n += 1;
        state.settings.materials.rules.push({ key:`material_${n}`, enabled:true, label:t('md_new_material', 'New material'), group:'Materials', terms:[{ measurement:'roof.squares', factor:1 }], waste:0, product_id:'', product_type:'' });
        state.open.add(`material_${n}`);
        changed();
        return;
      }
      if (target.closest('[data-md-reset]')) { state.settings = clone(state.industry); state.open.clear(); changed(); }
    });

    async function save(){
      if (destroyed) return;
      if (state.saving) { state.dirty = true; return; }
      state.saving = true; state.dirty = false; setStatus(t('md_saving', 'Saving…'));
      try {
        const result = await request(`/organizations/${encodeURIComponent(orgId())}/measurement-defaults`, { method:'PUT', body:{ settings:state.settings, expected_revision:state.revision } });
        Object.assign(state, { revision:result.revision, stored:true });
        if (!state.dirty) state.settings = result.settings;
        setStatus(t('md_saved_short', 'Saved. New materials use these from now on.'), 'ok');
      } catch (error) {
        setStatus(error?.message || t('md_save_failed', 'The defaults could not be saved.'), 'error');
      } finally { state.saving = false; if (state.dirty) save(); }
    }

    async function load(){
      state.loading = !state.settings; render();
      try {
        const [result, items] = await Promise.all([request(`/organizations/${encodeURIComponent(orgId())}/measurement-defaults`), products(orgId())]);
        Object.assign(state, { settings:result.settings, industry:result.industry, catalog:result.catalog || state.catalog, revision:result.revision || 0, stored:!!result.stored, products:items, status:'', statusKind:'' });
      } catch (error) {
        Object.assign(state, { settings:null, status:error?.status === 403 ? t('md_forbidden', 'Changing default materials needs permission to manage company settings.') : (error?.message || t('md_load_failed', 'The defaults could not load.')), statusKind:'error' });
      } finally { state.loading = false; if (!destroyed) render(); }
    }
    load();
    return { reload(){ if (!state.saving && !saveTimer) return load(); return Promise.resolve(); }, destroy(){ destroyed = true; clearTimeout(saveTimer); closePop(); } };
  }

  root.FirstMateMeasurementDefaults = { mount };
})(window);
