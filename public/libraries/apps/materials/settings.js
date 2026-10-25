/* public/libraries/apps/materials/settings.js
 * Materials settings: the gear at the top right of the Materials tab opens one large modal with a sub-tab for each
 * organization-wide materials setting. Each sub-tab mounts the panel the Settings app already uses, so there is one
 * editor per setting:
 *   Price book           FirstMatePricebook.mount (material costs and the optional labor prices are price book items)
 *   Suppliers            FirstMateSupplierSettings.mount (settings/suppliers.js)
 *   Report defaults      FirstMateMeasurementDefaults.mount (settings/measurement-defaults.js)
 *   Resource categories  the Materials tab's own category writers, handed in by project.js
 * A sub-tab shows only when the organization has its feature on and the person holds the permission its server
 * routes require; the checks match Settings. No configuration is ever checked.
 */
(function(root){
  'use strict';

  const scriptSrc = document.currentScript?.src || `${location.origin}/libraries/apps/materials/settings.js`;
  const suppliersUrl = new URL('../settings/suppliers.js?v=20261012-logos', scriptSrc).href;
  const defaultsUrl = new URL('../settings/measurement-defaults.js?v=20261022-measurement-defaults-2', scriptSrc).href;
  const t = (key, fallback) => root.PlatformLanguage?.text?.('materials', key, fallback) ?? fallback;
  const esc = (value) => String(value ?? '').replace(/[&<>"']/g, (c) => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' }[c]));
  const term = (key, fallback) => root.Portal?.terminology?.get?.(key, fallback) || fallback;
  const reducedMotion = () => !!root.matchMedia?.('(prefers-reduced-motion: reduce)').matches;

  // Permission and organization feature checks, the same ones Settings uses for these panels.
  const perm = (key) => root.Portal?.util?.hasPerm?.(key) === true;
  function flag(group, name){
    const flags = root.Portal?.appFlags || root.PlatformAPI?.appFlags;
    if (!flags?.current?.()) return false;
    return flags.has?.(group, name) === true || flags.value?.(group, name, false) === true;
  }

  const SECTIONS = [
    { id:'pricebook', icon:'fa-book',
      label:() => term('pricebook.pricebook', t('materials_settings_tab_pricebook', 'Price book')),
      tip:() => t('materials_settings_tip_pricebook', 'Material costs and the optional labor prices, shared by every project'),
      // Settings › Pricebook: manage_company_settings and platform.pricebook.
      allowed:() => perm('manage_company_settings') && flag('platform', 'pricebook'),
      mount:mountPricebook },
    { id:'suppliers', icon:'fa-truck-field',
      label:() => t('materials_settings_tab_suppliers', 'Suppliers'),
      tip:() => t('materials_settings_tip_suppliers', 'Who provides your materials, what each supplier carries and at what price, and their delivery fees'),
      // Settings › Pricebook › Suppliers; supplier writes need manage_company_settings. Its catalogue is price book items.
      allowed:() => perm('manage_company_settings') && flag('platform', 'pricebook'),
      mount:mountSuppliers },
    { id:'defaults', icon:'fa-ruler-combined',
      label:() => t('materials_settings_tab_defaults', 'Report defaults'),
      tip:() => t('materials_settings_tip_defaults', 'The materials and labor a project gets from its measurement report when no document defines them'),
      // Settings › Reports › Default materials and labor (manage_report_settings, apps.firstmeasure); the
      // measurement-defaults routes also require manage_company_settings.
      allowed:() => perm('manage_report_settings') && perm('manage_company_settings') && flag('apps', 'firstmeasure'),
      mount:mountDefaults },
    { id:'categories', icon:'fa-layer-group',
      label:() => t('materials_settings_tab_categories', 'Resource categories'),
      tip:() => t('materials_settings_tip_categories', 'The columns on every project’s Materials tab: their names, icons, colors and where their lines come from'),
      // Resource type writes need manage_projects; the tab itself is already gated by platform.materials.
      allowed:(options) => perm('manage_projects') && !!options?.categories,
      mount:mountCategories }
  ];

  function sections(options = {}){
    return SECTIONS.filter((section) => { try { return section.allowed(options); } catch (error) { return false; } }).map((section) => section.id);
  }

  function loadScript(url, ready){
    if (ready()) return Promise.resolve();
    root.__fmMaterialsSettingsScripts = root.__fmMaterialsSettingsScripts || new Map();
    const scripts = root.__fmMaterialsSettingsScripts;
    if (!scripts.has(url)) {
      scripts.set(url, new Promise((resolve, reject) => {
        const script = document.createElement('script');
        script.src = url;
        script.onload = () => resolve();
        script.onerror = () => { scripts.delete(url); reject(new Error('The script could not load.')); };
        document.head.append(script);
      }));
    }
    return scripts.get(url);
  }

  function injectStyles(){
    if (document.getElementById('fm-materials-settings-style')) return;
    const style = document.createElement('style');
    style.id = 'fm-materials-settings-style';
    style.textContent = `
      .mts-overlay{position:fixed;inset:0;z-index:2147483300;display:grid;place-items:center;padding:24px;box-sizing:border-box;background:rgba(15,23,42,.42);backdrop-filter:blur(6px);-webkit-backdrop-filter:blur(6px);font-family:Inter,system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;color:#101828;opacity:0;transition:opacity .22s ease}
      .mts-overlay.is-open{opacity:1}.mts-overlay.is-closing{opacity:0;transition-duration:.18s}
      .mts-modal{position:relative;display:flex;flex-direction:column;width:min(1240px,100%);height:min(860px,100%);background:#fff;border:1px solid rgba(15,23,42,.08);border-radius:18px;box-shadow:0 40px 120px rgba(15,23,42,.32),0 2px 6px rgba(15,23,42,.06);overflow:hidden;transform:translateY(10px) scale(.965);opacity:0;transition:transform .32s cubic-bezier(.2,.8,.25,1),opacity .24s ease}
      .mts-overlay.is-open .mts-modal{transform:none;opacity:1}.mts-overlay.is-closing .mts-modal{transform:translateY(6px) scale(.975);opacity:0;transition-duration:.18s}
      .mts-head{flex:0 0 auto;display:flex;align-items:center;gap:14px;min-height:60px;padding:10px 12px 10px 16px;border-bottom:1px solid #eaecf0;background:linear-gradient(180deg,#fff,#fbfcfd)}
      .mts-mark{flex:none;width:34px;height:34px;border-radius:10px;display:grid;place-items:center;background:rgba(var(--primary-rgb,217,48,37),.09);color:var(--primary-readable,var(--primary,#d93025))}
      .mts-head h2{flex:none;margin:0;font-size:15px;font-weight:800;letter-spacing:-.01em;color:#101828;white-space:nowrap}
      .mts-tabs{position:relative;flex:1;min-width:0;display:flex;align-items:center;gap:2px;padding:3px;margin-left:8px;border-radius:12px;background:#f2f4f7;overflow-x:auto;scrollbar-width:none}.mts-tabs::-webkit-scrollbar{display:none}
      .mts-tab{position:relative;z-index:1;flex:none;display:inline-flex;align-items:center;gap:7px;height:32px;padding:0 13px;border:0;border-radius:9px;background:transparent;color:#475467;font:inherit;font-size:12px;font-weight:650;white-space:nowrap;cursor:pointer;transition:color .2s ease}
      .mts-tab:hover{color:#101828}.mts-tab[aria-selected="true"]{color:#101828}.mts-tab i{font-size:12px;color:#98a2b3;transition:color .2s ease}.mts-tab[aria-selected="true"] i{color:var(--primary-readable,var(--primary,#d93025))}
      .mts-tab:focus-visible{outline:2px solid var(--primary,#d93025);outline-offset:1px}
      .mts-ink{position:absolute;z-index:0;top:3px;left:0;height:32px;width:0;border-radius:9px;background:#fff;box-shadow:0 1px 3px rgba(16,24,40,.1),0 1px 2px rgba(16,24,40,.06);transition:transform .32s cubic-bezier(.2,.8,.25,1),width .32s cubic-bezier(.2,.8,.25,1);pointer-events:none}
      .mts-close{flex:none;width:34px;height:34px;margin-left:auto;border:1px solid #e4e7ec;border-radius:10px;background:#fff;color:#475467;cursor:pointer;transition:background .15s ease,transform .15s ease}.mts-close:hover{background:#f2f4f7}.mts-close:active{transform:scale(.94)}
      .mts-body{position:relative;flex:1;min-height:0;background:#f8fafc}
      .mts-pane{position:absolute;inset:0;display:flex;flex-direction:column;min-height:0;overflow:auto}
      .mts-pane[hidden]{display:none}.mts-pane.is-entering{animation:mts-pane-in .28s cubic-bezier(.2,.8,.25,1) both}
      @keyframes mts-pane-in{from{opacity:0;transform:translateY(8px)}to{opacity:1;transform:none}}
      .mts-pane-fill{flex:1;min-height:0;display:flex;flex-direction:column}
      .mts-pane[data-mts-pane="pricebook"]{overflow:hidden;background:#fff}.mts-pane[data-mts-pane="pricebook"] .pb-embed>.pb-win{min-height:0;height:100%}
      .mts-pane[data-mts-pane="suppliers"] .sup-wrap{flex:1;min-height:0;padding:14px}
      .mts-pane[data-mts-pane="defaults"]>.mts-pane-fill{padding:14px}
      .mts-supplier-tools:empty{display:none}.mts-supplier-tools{padding:14px 14px 0}
      .mts-state{margin:auto;display:flex;flex-direction:column;align-items:center;gap:10px;padding:40px;color:#667085;font-size:13px;font-weight:600}.mts-state i{font-size:20px;color:#98a2b3}
      .mts-spin{animation:mts-spin 1s linear infinite}@keyframes mts-spin{to{transform:rotate(360deg)}}
      .mts-cats{width:min(760px,100%);margin:0 auto;padding:18px 16px 28px;box-sizing:border-box;display:flex;flex-direction:column;gap:8px}
      .mts-cat{display:grid;grid-template-columns:38px minmax(0,1fr) auto 34px;align-items:center;gap:10px;padding:10px 12px;border:1px solid #e4e7ec;border-radius:12px;background:#fff;box-shadow:0 1px 2px rgba(16,24,40,.04);animation:mts-pane-in .26s cubic-bezier(.2,.8,.25,1) both;transition:border-color .15s ease,box-shadow .15s ease}
      .mts-cat:hover{border-color:#d0d5dd;box-shadow:0 4px 14px rgba(16,24,40,.06)}
      .mts-cat-icon{width:38px;height:38px;border:0;border-radius:10px;display:grid;place-items:center;cursor:pointer;background:color-mix(in srgb,var(--cat,#667085) 13%,#fff);color:var(--cat,#667085);font-size:15px;transition:transform .15s ease}.mts-cat-icon:hover{transform:scale(1.06)}.mts-cat-icon:disabled{cursor:default;transform:none}
      .mts-cat-name{min-width:0;height:34px;padding:0 10px;border:1px solid transparent;border-radius:8px;background:transparent;font:inherit;font-size:14px;font-weight:700;color:#101828;transition:border-color .15s ease,background .15s ease}.mts-cat-name:hover{background:#f9fafb}.mts-cat-name:focus{outline:none;border-color:#d0d5dd;background:#fff}
      .mts-cat-sources{display:flex;align-items:center;flex-wrap:wrap;justify-content:flex-end;gap:6px}
      .mts-chip{display:inline-flex;align-items:center;gap:6px;height:28px;padding:0 11px;border:1px solid #d0d5dd;border-radius:999px;background:#fff;color:#475467;font:inherit;font-size:11px;font-weight:650;cursor:pointer;transition:background .15s ease,border-color .15s ease,color .15s ease}
      .mts-chip i{font-size:10px;opacity:0;width:0;transition:opacity .15s ease,width .15s ease}.mts-chip[aria-pressed="true"]{border-color:var(--primary,#d93025);background:rgba(var(--primary-rgb,217,48,37),.07);color:var(--primary-readable,var(--primary,#d93025))}.mts-chip[aria-pressed="true"] i{opacity:1;width:10px}
      .mts-chip-check{display:inline-flex;align-items:center;gap:5px;font-size:11px;font-weight:600;color:#475467;cursor:pointer}
      .mts-cat-remove{width:34px;height:34px;border:0;border-radius:9px;background:transparent;color:#98a2b3;cursor:pointer;transition:background .15s ease,color .15s ease}.mts-cat-remove:hover{background:#fef3f2;color:#d92d20}
      .mts-cat-add{display:flex;gap:8px;margin-top:6px;padding:10px 12px;border:1px dashed #d0d5dd;border-radius:12px;background:rgba(255,255,255,.6)}
      .mts-cat-add input{flex:1;min-width:0;height:34px;padding:0 10px;border:1px solid #d0d5dd;border-radius:8px;font:inherit;font-size:13px}
      .mts-btn{height:34px;padding:0 14px;border:1px solid var(--primary,#d93025);border-radius:8px;background:var(--primary,#d93025);color:var(--on-primary,#fff);font:inherit;font-size:12px;font-weight:700;cursor:pointer;display:inline-flex;align-items:center;gap:6px}.mts-btn:disabled{opacity:.5;cursor:default}
      @media(max-width:760px){.mts-overlay{padding:0}.mts-modal{width:100%;height:100%;border-radius:0}.mts-head h2{display:none}.mts-tabs{margin-left:0}.mts-tab span{display:none}.mts-cat{grid-template-columns:38px minmax(0,1fr) 34px}.mts-cat-sources{grid-column:2 / -1;justify-content:flex-start}}
      @media(prefers-reduced-motion:reduce){.mts-overlay,.mts-modal,.mts-ink,.mts-tab{transition:none!important}.mts-pane.is-entering,.mts-cat{animation:none!important}}
    `;
    document.head.append(style);
  }

  // ---- Sub-tab panels. Each returns a handle with destroy().
  function pricebookLibrary(){ return root.FirstMatePricebook || root.Portal?.modules?.pricebook || null; }
  function stateMarkup(icon, text, spin = false){ return `<div class="mts-state" role="status"><i class="fas ${icon}${spin ? ' mts-spin' : ''}" aria-hidden="true"></i><span>${esc(text)}</span></div>`; }

  function mountPricebook(host, ctx){
    const pricebook = pricebookLibrary();
    if (!pricebook?.mount) { host.innerHTML = stateMarkup('fa-triangle-exclamation', t('materials_settings_pricebook_unavailable', 'The price book could not be loaded.')); return {}; }
    pricebook.configure?.({ currentOrganizationId:ctx.orgId });
    const handle = pricebook.mount(host, { title:term('pricebook.pricebook', t('materials_settings_tab_pricebook', 'Price book')) });
    return { destroy(){ try { handle?.destroy?.(); } catch (error) {} } };
  }

  function mountSuppliers(host, ctx){
    let handle = null, destroyed = false;
    host.innerHTML = `<div class="mts-pane-fill"><div class="mts-supplier-tools" data-mts-supplier-tools></div><div class="mts-pane-fill" data-mts-supplier-panel>${stateMarkup('fa-circle-notch', t('materials_settings_loading_suppliers', 'Loading suppliers…'), true)}</div></div>`;
    const panel = host.querySelector('[data-mts-supplier-panel]');
    const tools = host.querySelector('[data-mts-supplier-tools]');
    const pricebook = pricebookLibrary();
    pricebook?.configure?.({ currentOrganizationId:ctx.orgId });
    Promise.all([loadScript(suppliersUrl, () => !!root.FirstMateSupplierSettings), Promise.resolve(pricebook?.loadState?.()).catch(() => null)]).then(() => {
      if (destroyed) return;
      panel.innerHTML = '';
      handle = root.FirstMateSupplierSettings.mount(panel, { orgId:ctx.orgId, pricebook, toast:ctx.toast });
      // Reserved for the guided materials setup's supplier step: its reusable supplier columns and per-supplier price
      // sheet upload (handed to the agent) mount here once it ships them. Nothing renders until it exists.
      if (typeof root.FirstMateSupplierTools?.mount === 'function') ctx.supplierTools = root.FirstMateSupplierTools.mount(tools, { orgId:ctx.orgId, pricebook, toast:ctx.toast, surface:'materials_settings', reload:() => handle?.reload?.() });
    }).catch(() => { if (!destroyed) panel.innerHTML = stateMarkup('fa-triangle-exclamation', t('materials_settings_suppliers_failed', 'The supplier editor could not load.')); });
    return { destroy(){ destroyed = true; try { ctx.supplierTools?.destroy?.(); handle?.destroy?.(); } catch (error) {} } };
  }

  function mountDefaults(host, ctx){
    let handle = null, destroyed = false;
    host.innerHTML = `<div class="mts-pane-fill">${stateMarkup('fa-circle-notch', t('materials_settings_loading_defaults', 'Loading default materials and labor…'), true)}</div>`;
    const fill = host.firstElementChild;
    loadScript(defaultsUrl, () => !!root.FirstMateMeasurementDefaults).then(() => {
      if (destroyed) return;
      fill.innerHTML = '';
      handle = root.FirstMateMeasurementDefaults.mount(fill, { orgId:ctx.orgId, toast:ctx.toast });
    }).catch(() => { if (!destroyed) fill.innerHTML = stateMarkup('fa-triangle-exclamation', t('materials_settings_defaults_failed', 'Default materials and labor could not load.')); });
    return { destroy(){ destroyed = true; try { handle?.destroy?.(); } catch (error) {} } };
  }

  // Resource categories are the Materials tab's columns. project.js owns their writers; this only draws them.
  function mountCategories(host, ctx){
    const api = ctx.categories;
    const builtIn = (id) => ['material', 'labor', 'equipment'].includes(id);
    const draw = () => {
      const rows = api.list?.() || [], defs = api.sourceDefs?.() || [];
      host.innerHTML = `<div class="mts-cats" data-mts-cats>${rows.map((row) => `
        <div class="mts-cat" data-mts-cat="${esc(row.id)}" style="--cat:${esc(row.color || '#667085')}">
          <button type="button" class="mts-cat-icon" data-mts-cat-icon data-fm-tooltip="${esc(t('materials_settings_cat_icon', 'Icon and color'))}" aria-label="${esc(t('materials_settings_cat_icon', 'Icon and color'))}"><i class="fas ${esc(row.icon || 'fa-layer-group')}" aria-hidden="true"></i></button>
          <input class="mts-cat-name" data-mts-cat-name value="${esc(row.name)}" placeholder="${esc(t('materials_settings_cat_untitled', 'Untitled'))}" aria-label="${esc(t('materials_settings_cat_name', 'Category name'))}">
          <div class="mts-cat-sources" role="group" aria-label="${esc(t('materials_settings_cat_sources', 'Line item sources'))}" data-fm-tooltip="${esc(t('materials_settings_cat_sources_tip', 'Where this column’s suggested lines come from'))}">${defs.map((source) => {
            const on = (row.sources || []).includes(source.id);
            return `<button type="button" class="mts-chip" data-mts-cat-source="${esc(source.id)}" aria-pressed="${on}" data-fm-tooltip="${esc(source.detail || source.label)}"><i class="fas fa-check" aria-hidden="true"></i>${esc(source.label)}</button>${source.id === 'pricebook' && on ? `<label class="mts-chip-check" data-fm-tooltip="${esc(t('materials_settings_cat_sku_tip', 'Leave out price book items kept only for estimating, which have no SKU to order.'))}"><input type="checkbox" data-mts-cat-sku ${row.skuOnly ? 'checked' : ''}>${esc(t('materials_settings_cat_sku', 'SKU only'))}</label>` : ''}`;
          }).join('')}</div>
          ${builtIn(row.id) ? '<span></span>' : `<button type="button" class="mts-cat-remove" data-mts-cat-remove data-fm-tooltip="${esc(t('materials_settings_cat_remove', 'Remove from every project'))}" aria-label="${esc(t('materials_settings_cat_remove', 'Remove from every project'))}"><i class="fas fa-trash" aria-hidden="true"></i></button>`}
        </div>`).join('')}
        <form class="mts-cat-add" data-mts-cat-add><input name="name" placeholder="${esc(t('materials_settings_cat_new_placeholder', 'New category name'))}" aria-label="${esc(t('materials_settings_cat_new', 'New category'))}" autocomplete="off"><button type="submit" class="mts-btn"><i class="fas fa-plus" aria-hidden="true"></i>${esc(t('materials_settings_cat_add', 'Add'))}</button></form>
      </div>`;
    };
    const rowId = (node) => node.closest('[data-mts-cat]')?.dataset.mtsCat || '';
    const settle = (result) => Promise.resolve(result).catch(() => null).then(() => { if (host.isConnected) draw(); });
    host.addEventListener('click', (event) => {
      const icon = event.target.closest('[data-mts-cat-icon]'), source = event.target.closest('[data-mts-cat-source]'), remove = event.target.closest('[data-mts-cat-remove]');
      if (icon) api.appearance?.(rowId(icon), () => draw());
      else if (source) { api.toggleSource?.(rowId(source), source.dataset.mtsCatSource); draw(); }
      else if (remove) settle(api.remove?.(rowId(remove)));
    });
    host.addEventListener('change', (event) => {
      const name = event.target.closest('[data-mts-cat-name]'), sku = event.target.closest('[data-mts-cat-sku]');
      if (name) api.rename?.(rowId(name), name.value);
      else if (sku) api.setSkuOnly?.(rowId(sku), sku.checked);
    });
    host.addEventListener('submit', (event) => {
      if (!event.target.matches('[data-mts-cat-add]')) return;
      event.preventDefault();
      const input = event.target.elements.name, name = String(input.value || '').trim();
      if (!name) { input.focus(); return; }
      settle(api.add?.(name));
      draw();
      host.querySelector('[data-mts-cat-add] input')?.focus();
    });
    draw();
    return { refresh:draw, destroy(){ host.innerHTML = ''; } };
  }

  // ---- The modal.
  let current = null;

  function open(options = {}){
    injectStyles();
    if (current) { current.select(options.section || current.active); return current; }
    const allowed = SECTIONS.filter((section) => sections(options).includes(section.id));
    if (!allowed.length) return null;
    const ctx = { orgId:typeof options.orgId === 'function' ? options.orgId : () => String(options.orgId || ''), toast:options.toast || root.Portal?.ui?.showToast || (() => {}), categories:options.categories || null };
    const trigger = document.activeElement;
    const overlay = document.createElement('div');
    overlay.className = 'mts-overlay';
    overlay.dataset.mtsOverlay = '';
    overlay.innerHTML = `<section class="mts-modal" role="dialog" aria-modal="true" aria-labelledby="mtsTitle">
      <header class="mts-head">
        <span class="mts-mark" aria-hidden="true"><i class="fas fa-sliders"></i></span>
        <h2 id="mtsTitle">${esc(t('materials_settings_title', 'Materials settings'))}</h2>
        <nav class="mts-tabs" role="tablist" aria-label="${esc(t('materials_settings_title', 'Materials settings'))}"><span class="mts-ink" aria-hidden="true"></span>${allowed.map((section) => `<button type="button" class="mts-tab" role="tab" id="mtsTab-${section.id}" aria-controls="mtsPane-${section.id}" aria-selected="false" tabindex="-1" data-mts-tab="${section.id}" data-fm-tooltip="${esc(section.tip())}"><i class="fas ${section.icon}" aria-hidden="true"></i><span>${esc(section.label())}</span></button>`).join('')}</nav>
        <button type="button" class="mts-close" data-mts-close data-fm-tooltip="${esc(t('materials_settings_close', 'Close'))}" aria-label="${esc(t('materials_settings_close', 'Close'))}"><i class="fas fa-xmark" aria-hidden="true"></i></button>
      </header>
      <div class="mts-body">${allowed.map((section) => `<div class="mts-pane" role="tabpanel" id="mtsPane-${section.id}" aria-labelledby="mtsTab-${section.id}" data-mts-pane="${section.id}" hidden></div>`).join('')}</div>
    </section>`;
    const modal = overlay.firstElementChild, ink = overlay.querySelector('.mts-ink');
    // Grow from the gear that opened it.
    const origin = options.originRect || trigger?.getBoundingClientRect?.();
    document.body.append(overlay);
    if (origin) {
      const box = modal.getBoundingClientRect();
      modal.style.transformOrigin = `${Math.round(origin.left + origin.width / 2 - box.left)}px ${Math.round(origin.top + origin.height / 2 - box.top)}px`;
    }
    const handles = new Map();
    const placeInk = (animate = true) => {
      const tab = overlay.querySelector('.mts-tab[aria-selected="true"]');
      if (!tab) return;
      if (!animate) ink.style.transition = 'none';
      ink.style.width = `${tab.offsetWidth}px`;
      ink.style.transform = `translateX(${tab.offsetLeft}px)`;
      if (!animate) { void ink.offsetWidth; ink.style.transition = ''; }
    };
    const state = {
      active:'',
      overlay,
      select(id, { focus = false } = {}){
        const section = allowed.find((row) => row.id === id) || allowed[0];
        if (state.active === section.id) return;
        const first = !state.active;
        state.active = section.id;
        overlay.querySelectorAll('[data-mts-tab]').forEach((tab) => { const on = tab.dataset.mtsTab === section.id; tab.setAttribute('aria-selected', String(on)); tab.tabIndex = on ? 0 : -1; if (on && focus) tab.focus(); if (on) tab.scrollIntoView?.({ block:'nearest', inline:'nearest' }); });
        overlay.querySelectorAll('[data-mts-pane]').forEach((pane) => {
          const on = pane.dataset.mtsPane === section.id;
          pane.hidden = !on;
          pane.classList.remove('is-entering');
          if (on && !reducedMotion()) { void pane.offsetWidth; pane.classList.add('is-entering'); }
        });
        placeInk(!first);
        // Each panel mounts the first time its sub-tab is shown and stays while the modal is open, so switching keeps edits.
        if (!handles.has(section.id)) {
          const pane = overlay.querySelector(`[data-mts-pane="${section.id}"]`);
          let handle = {};
          try { handle = section.mount(pane, ctx) || {}; } catch (error) { pane.innerHTML = stateMarkup('fa-triangle-exclamation', error?.message || t('materials_settings_failed', 'This setting could not load.')); }
          handles.set(section.id, handle);
        }
        overlay.dispatchEvent(new CustomEvent('mts:section', { detail:{ section:section.id } }));
      },
      close
    };
    overlay.addEventListener('click', (event) => {
      const tab = event.target.closest('[data-mts-tab]');
      if (tab) { state.select(tab.dataset.mtsTab); return; }
      if (event.target.closest('[data-mts-close]')) close();
    });
    overlay.querySelector('.mts-tabs').addEventListener('keydown', (event) => {
      if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
      event.preventDefault();
      const ids = allowed.map((row) => row.id), index = ids.indexOf(state.active);
      const next = event.key === 'Home' ? 0 : event.key === 'End' ? ids.length - 1 : (index + (event.key === 'ArrowRight' ? 1 : -1) + ids.length) % ids.length;
      state.select(ids[next], { focus:true });
    });
    const onResize = () => placeInk(false);
    root.addEventListener('resize', onResize);
    // Stack with the platform's other windows; without the manager it closes on Escape and a backdrop click itself.
    const modals = root.Portal?.modals;
    const modalHandle = modals?.register?.(overlay, { id:'materials-settings', closeOnEscape:true, closeOnBackdrop:true, onClose:() => close() }) || null;
    modalHandle?.bringToFront?.();
    const onKey = (event) => { if (event.key === 'Escape' && !modalHandle) { event.stopPropagation(); close(); } };
    const onBackdrop = (event) => { if (!modalHandle && event.target === overlay) close(); };
    document.addEventListener('keydown', onKey, true);
    overlay.addEventListener('mousedown', onBackdrop);
    let closing = false;
    function close(){
      if (closing) return;
      closing = true;
      if (current === state) current = null;
      root.removeEventListener('resize', onResize);
      document.removeEventListener('keydown', onKey, true);
      try { modalHandle?.unregister?.(); } catch (error) {}
      overlay.classList.remove('is-open');
      overlay.classList.add('is-closing');
      const finish = () => {
        handles.forEach((handle) => { try { handle.destroy?.(); } catch (error) {} });
        handles.clear();
        overlay.remove();
        try { trigger?.focus?.({ preventScroll:true }); } catch (error) {}
        options.onClose?.();
      };
      if (reducedMotion()) finish(); else setTimeout(finish, 200);
    }
    current = state;
    state.select(options.section || allowed[0].id);
    requestAnimationFrame(() => { overlay.classList.add('is-open'); placeInk(false); overlay.querySelector('.mts-tab[aria-selected="true"]')?.focus({ preventScroll:true }); });
    return state;
  }

  function close(){ current?.close(); }

  root.FirstMateMaterialsSettings = { sections, open, close, isOpen:() => !!current };
})(window);
