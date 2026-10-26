/* public/libraries/apps/materials/settings.js
 * Materials settings: one set of sub-tabs for the organization-wide materials settings, shown in two places with one
 * implementation:
 *   open(options)               the modal behind the gear at the top right of a project's Materials tab
 *   mountInline(host, options)  Settings › Materials (settings/company.js)
 * Each sub-tab mounts the panel the Settings app already uses, so there is one editor per setting:
 *   Price book           FirstMatePricebook.mount (material costs and the optional labor prices are price book items)
 *   Suppliers            FirstMateSupplierTools.mount (guided-experiences/supplier-columns.js) over
 *                        FirstMateSupplierSettings.mount (settings/suppliers.js)
 *   Calculations         FirstMateMeasurementDefaults.mount (settings/measurement-defaults.js)
 *   Resource categories  the Materials tab's own category writers, handed in by project.js; in Settings, the same
 *                        resource type writers (MaterialsAPI.resourceTypes) for the organization
 * A sub-tab shows only when the organization has its feature on and the person holds the permission its server
 * routes require; the checks match Settings. Resource categories is also an organization switch
 * (materials.resource_categories). No configuration is ever checked.
 * The global assistant is docked on the right of every sub-tab, in the person's private `materials-settings`
 * conversation (v1/materials/settings-assistant.ts); it can be collapsed.
 */
(function(root){
  'use strict';

  const scriptSrc = document.currentScript?.src || `${location.origin}/libraries/apps/materials/settings.js`;
  const suppliersUrl = new URL('../settings/suppliers.js?v=20261012-logos', scriptSrc).href;
  const defaultsUrl = new URL('../settings/measurement-defaults.js?v=20261025-calculations', scriptSrc).href;
  const t = (key, fallback) => root.PlatformLanguage?.text?.('materials', key, fallback) ?? fallback;
  const esc = (value) => String(value ?? '').replace(/[&<>"']/g, (c) => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' }[c]));
  const clean = (value) => String(value ?? '').trim();
  const term = (key, fallback) => root.Portal?.terminology?.get?.(key, fallback) || fallback;
  const reducedMotion = () => !!root.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
  // The platform font is the page body's (portal/index.php); fonts.css gives bare divs, buttons and inputs another.
  const PLATFORM_FONT = `'Inter',system-ui,-apple-system,"Segoe UI",Roboto,Arial,sans-serif`;
  const AGENT_KEY = 'fm.materialsSettings.agentCollapsed';

  // Permission and organization feature checks, the same ones Settings uses for these panels.
  const perm = (key) => root.Portal?.util?.hasPerm?.(key) === true;
  function flag(group, name, fallback = false){
    const flags = root.Portal?.appFlags || root.PlatformAPI?.appFlags;
    if (!flags?.current?.()) return fallback;
    return flags.has?.(group, name) === true || flags.value?.(group, name, fallback) === true;
  }

  const SECTIONS = [
    { id:'pricebook', icon:'fa-book',
      label:() => term('pricebook.pricebook', t('materials_settings_tab_pricebook', 'Price book')),
      tip:() => t('materials_settings_tip_pricebook', 'Material costs and the optional labor prices, shared by every project'),
      // Settings › Pricebook: manage_company_settings and platform.pricebook.
      allowed:() => perm('manage_company_settings') && flag('platform', 'pricebook'),
      mount:mountPricebook },
    { id:'suppliers', icon:'fa-truck',
      label:() => t('materials_settings_tab_suppliers', 'Suppliers'),
      tip:() => t('materials_settings_tip_suppliers', 'Who provides your materials, what each supplier carries and at what price, and their delivery fees'),
      // Settings › Pricebook › Suppliers; supplier writes need manage_company_settings. Its catalogue is price book items.
      allowed:() => perm('manage_company_settings') && flag('platform', 'pricebook'),
      mount:mountSuppliers },
    { id:'calculations', icon:'fa-calculator',
      label:() => t('materials_settings_tab_calculations', 'Calculations'),
      tip:() => t('materials_settings_tip_calculations', 'How a project’s materials and labor are worked out from its measurement report when no document defines them'),
      // Settings › Reports › Default materials and labor (manage_report_settings, apps.firstmeasure); the
      // measurement-defaults routes also require manage_company_settings.
      allowed:() => perm('manage_report_settings') && perm('manage_company_settings') && flag('apps', 'firstmeasure'),
      mount:mountDefaults },
    { id:'categories', icon:'fa-layer-group',
      label:() => t('materials_settings_tab_categories', 'Resource categories'),
      tip:() => t('materials_settings_tip_categories', 'The columns on every project’s Materials tab: their names, icons, colors and where their lines come from'),
      // Resource type writes need manage_projects; the Materials app is platform.materials. The organization switch
      // materials.resource_categories (on by default) turns the sub-tab off. A project hands in its own writers; Settings
      // uses the organization's.
      allowed:(options) => perm('manage_projects') && flag('platform', 'materials') && flag('materials', 'resource_categories', true) && (!!options?.categories || options?.surface === 'settings'),
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
      .mts-overlay{position:fixed;inset:0;z-index:2147483300;display:flex;padding:20px;box-sizing:border-box;background:rgba(15,23,42,.42);backdrop-filter:blur(6px);-webkit-backdrop-filter:blur(6px);opacity:0;transition:opacity .22s ease}
      .mts-overlay.is-open{opacity:1}.mts-overlay.is-closing{opacity:0;transition-duration:.18s}
      /* Every element takes the platform font: fonts.css names another for bare divs, headings, buttons and inputs. */
      .mts-overlay,.mts-shell{font-family:var(--mts-font,${PLATFORM_FONT});color:#101828}
      .mts-shell.mts-shell :is(div,p,h1,h2,h3,h4,h5,h6,button,a,input,select,textarea,label,span,strong,small,b,em,td,th){font-family:inherit}
      .mts-shell{position:relative;display:flex;flex-direction:column;min-width:0;min-height:0;background:#fff;box-sizing:border-box}
      .mts-modal{flex:1;width:100%;height:100%;border:1px solid rgba(15,23,42,.08);border-radius:16px;box-shadow:0 40px 120px rgba(15,23,42,.32),0 2px 6px rgba(15,23,42,.06);overflow:hidden;transform:translateY(10px) scale(.975);opacity:0;transition:transform .32s cubic-bezier(.2,.8,.25,1),opacity .24s ease}
      .mts-overlay.is-open .mts-modal{transform:none;opacity:1}.mts-overlay.is-closing .mts-modal{transform:translateY(6px) scale(.98);opacity:0;transition-duration:.18s}
      .mts-shell.is-inline{border:1px solid #e4e7ec;border-radius:14px;overflow:hidden;height:calc(var(--fm-visual-vh,100vh) - 150px);min-height:600px}
      .mts-head{flex:0 0 auto;display:flex;align-items:center;gap:12px;min-height:58px;padding:10px 12px 10px 16px;border-bottom:1px solid #eaecf0;background:linear-gradient(180deg,#fff,#fbfcfd);box-sizing:border-box}
      .mts-mark{flex:none;width:34px;height:34px;border-radius:10px;display:grid;place-items:center;background:rgba(var(--primary-rgb,217,48,37),.09);color:var(--primary-readable,var(--primary,#d93025))}
      .mts-head h2{flex:none;margin:0;font-size:15px;font-weight:700;letter-spacing:-.01em;color:#101828;white-space:nowrap}
      .mts-tabs{position:relative;flex:0 1 auto;min-width:0;display:flex;align-items:center;gap:2px;padding:3px;margin-left:6px;border-radius:12px;background:#f2f4f7;overflow-x:auto;scrollbar-width:none}.mts-tabs::-webkit-scrollbar{display:none}
      .mts-shell.is-inline .mts-tabs{margin-left:0}
      .mts-tab{position:relative;z-index:1;flex:none;display:inline-flex;align-items:center;gap:7px;height:32px;padding:0 14px;border:0;border-radius:9px;background:transparent;color:#475467;font-size:12.5px;font-weight:600;white-space:nowrap;cursor:pointer;transition:color .2s ease}
      .mts-shell.is-inline .mts-tab{height:34px;font-size:13px;padding:0 16px}
      .mts-tab:hover{color:#101828}.mts-tab[aria-selected="true"]{color:#101828}.mts-tab i{font-size:12px;width:14px;text-align:center;color:#98a2b3;transition:color .2s ease}.mts-tab[aria-selected="true"] i{color:var(--primary-readable,var(--primary,#d93025))}
      .mts-tab:focus-visible{outline:2px solid var(--primary,#d93025);outline-offset:1px}
      .mts-ink{position:absolute;z-index:0;top:3px;left:0;height:calc(100% - 6px);width:0;border-radius:9px;background:#fff;box-shadow:0 1px 3px rgba(16,24,40,.1),0 1px 2px rgba(16,24,40,.06);transition:transform .32s cubic-bezier(.2,.8,.25,1),width .32s cubic-bezier(.2,.8,.25,1);pointer-events:none}
      .mts-head-end{margin-left:auto;display:flex;align-items:center;gap:8px}
      .mts-agent-toggle{height:34px;display:inline-flex;align-items:center;gap:7px;padding:0 12px;border:1px solid #e4e7ec;border-radius:10px;background:#fff;color:#475467;font-size:12.5px;font-weight:600;cursor:pointer;transition:background .15s ease,border-color .15s ease,color .15s ease}
      .mts-agent-toggle i{font-size:12px}.mts-agent-toggle:hover{background:#f9fafb}
      .mts-agent-toggle[aria-pressed="true"]{border-color:rgba(var(--primary-rgb,217,48,37),.3);background:rgba(var(--primary-rgb,217,48,37),.06);color:var(--primary-readable,var(--primary,#d93025))}
      .mts-close{flex:none;width:34px;height:34px;border:1px solid #e4e7ec;border-radius:10px;background:#fff;color:#475467;cursor:pointer;transition:background .15s ease,transform .15s ease}.mts-close:hover{background:#f2f4f7}.mts-close:active{transform:scale(.94)}
      .mts-body{position:relative;flex:1;min-height:0;display:grid;grid-template-columns:minmax(0,1fr) clamp(300px,28%,420px);background:#f8fafc;transition:grid-template-columns .28s cubic-bezier(.2,.8,.25,1)}
      .mts-body.no-agent,.mts-body.agent-collapsed{grid-template-columns:minmax(0,1fr) 0}
      .mts-panes{position:relative;min-width:0;min-height:0}
      .mts-pane{position:absolute;inset:0;display:flex;flex-direction:column;min-height:0;overflow:auto}
      .mts-pane[hidden]{display:none}.mts-pane.is-entering{animation:mts-pane-in .28s cubic-bezier(.2,.8,.25,1) both}
      @keyframes mts-pane-in{from{opacity:0;transform:translateY(8px)}to{opacity:1;transform:none}}
      .mts-agent{position:relative;min-width:0;min-height:0;overflow:hidden;border-left:1px solid #eaecf0;background:#fff;display:flex;flex-direction:column}
      .mts-body.no-agent .mts-agent,.mts-body.agent-collapsed .mts-agent{visibility:hidden;border-left:0}
      .mts-agent-host{flex:1;min-height:0;position:relative;display:flex;flex-direction:column}
      .mts-agent-host>*{flex:1;min-height:0}
      .mts-pane-fill{flex:1;min-height:0;display:flex;flex-direction:column}
      .mts-pane[data-mts-pane="pricebook"]{overflow:hidden;background:#fff}.mts-pane[data-mts-pane="pricebook"] .pb-embed>.pb-win{min-height:0;height:100%}
      /* Suppliers scroll as one page: what each supplier carries at a fixed height, then the supplier editor. */
      .mts-suppliers{display:flex;flex-direction:column;gap:14px;padding:16px;box-sizing:border-box}
      .mts-card{border:1px solid #e4e7ec;border-radius:12px;background:#fff;box-shadow:0 1px 2px rgba(16,24,40,.04)}
      .mts-supplier-tools{padding:14px 16px 12px}.mts-supplier-tools:empty{display:none}
      .mts-supplier-tools .gxsc-tools-cols{height:clamp(240px,34vh,340px)}
      .mts-supplier-editor{padding:12px 0 0;min-height:0}
      .mts-section-title{display:flex;align-items:center;gap:8px;margin:0 16px 10px;font-size:13px;font-weight:650;color:#101828}.mts-section-title i{color:#98a2b3;font-size:12px}
      .mts-pane[data-mts-pane="suppliers"] .sup-wrap{height:clamp(480px,64vh,700px);min-height:0}
      .mts-pane[data-mts-pane="calculations"]>.mts-pane-fill{padding:16px}
      .mts-state{margin:auto;display:flex;flex-direction:column;align-items:center;gap:10px;padding:40px;color:#667085;font-size:13px;font-weight:600}.mts-state i{font-size:20px;color:#98a2b3}
      .mts-spin{animation:mts-spin 1s linear infinite}@keyframes mts-spin{to{transform:rotate(360deg)}}
      .mts-cats{width:min(760px,100%);margin:0 auto;padding:18px 16px 28px;box-sizing:border-box;display:flex;flex-direction:column;gap:8px}
      .mts-cat{display:grid;grid-template-columns:38px minmax(0,1fr) auto 34px;align-items:center;gap:10px;padding:10px 12px;border:1px solid #e4e7ec;border-radius:12px;background:#fff;box-shadow:0 1px 2px rgba(16,24,40,.04);animation:mts-pane-in .26s cubic-bezier(.2,.8,.25,1) both;transition:border-color .15s ease,box-shadow .15s ease}
      .mts-cat:hover{border-color:#d0d5dd;box-shadow:0 4px 14px rgba(16,24,40,.06)}
      .mts-cat-icon{width:38px;height:38px;border:0;border-radius:10px;display:grid;place-items:center;cursor:pointer;background:color-mix(in srgb,var(--cat,#667085) 13%,#fff);color:var(--cat,#667085);font-size:15px;transition:transform .15s ease}.mts-cat-icon:hover{transform:scale(1.06)}.mts-cat-icon:disabled{cursor:default;transform:none}
      .mts-cat-name{min-width:0;height:34px;padding:0 10px;border:1px solid transparent;border-radius:8px;background:transparent;font-size:14px;font-weight:650;color:#101828;transition:border-color .15s ease,background .15s ease}.mts-cat-name:hover{background:#f9fafb}.mts-cat-name:focus{outline:none;border-color:#d0d5dd;background:#fff}
      .mts-cat-sources{display:flex;align-items:center;flex-wrap:wrap;justify-content:flex-end;gap:6px}
      .mts-chip{display:inline-flex;align-items:center;gap:6px;height:28px;padding:0 11px;border:1px solid #d0d5dd;border-radius:999px;background:#fff;color:#475467;font-size:11px;font-weight:600;cursor:pointer;transition:background .15s ease,border-color .15s ease,color .15s ease}
      .mts-chip i{font-size:10px;opacity:0;width:0;transition:opacity .15s ease,width .15s ease}.mts-chip[aria-pressed="true"]{border-color:var(--primary,#d93025);background:rgba(var(--primary-rgb,217,48,37),.07);color:var(--primary-readable,var(--primary,#d93025))}.mts-chip[aria-pressed="true"] i{opacity:1;width:10px}
      .mts-chip-check{display:inline-flex;align-items:center;gap:5px;font-size:11px;font-weight:600;color:#475467;cursor:pointer}
      .mts-cat-remove{width:34px;height:34px;border:0;border-radius:9px;background:transparent;color:#98a2b3;cursor:pointer;transition:background .15s ease,color .15s ease}.mts-cat-remove:hover{background:#fef3f2;color:#d92d20}
      .mts-cat-add{display:flex;gap:8px;margin-top:6px;padding:10px 12px;border:1px dashed #d0d5dd;border-radius:12px;background:rgba(255,255,255,.6)}
      .mts-cat-add input{flex:1;min-width:0;height:34px;padding:0 10px;border:1px solid #d0d5dd;border-radius:8px;font-size:13px}
      .mts-btn{height:34px;padding:0 14px;border:1px solid var(--primary,#d93025);border-radius:8px;background:var(--primary,#d93025);color:var(--on-primary,#fff);font-size:12px;font-weight:650;cursor:pointer;display:inline-flex;align-items:center;gap:6px}.mts-btn:disabled{opacity:.5;cursor:default}
      @media(max-width:1100px){.mts-body{grid-template-columns:minmax(0,1fr) clamp(280px,34%,340px)}}
      .mts-shell{container-type:inline-size;container-name:mts}
      @container mts (max-width:820px){.mts-body:not(.no-agent):not(.agent-collapsed){grid-template-columns:minmax(0,1fr) 280px}.mts-tab{padding:0 10px}.mts-suppliers{padding:12px;gap:12px}}
      @media(max-width:760px){.mts-overlay{padding:0}.mts-modal{border-radius:0}.mts-head h2{display:none}.mts-tabs{margin-left:0}.mts-tab span,.mts-agent-toggle span{display:none}.mts-body{grid-template-columns:minmax(0,1fr) 0}.mts-body:not(.agent-collapsed):not(.no-agent){grid-template-columns:0 minmax(0,1fr)}.mts-body:not(.agent-collapsed):not(.no-agent) .mts-panes{visibility:hidden}.mts-agent{border-left:0}.mts-cat{grid-template-columns:38px minmax(0,1fr) 34px}.mts-cat-sources{grid-column:2 / -1;justify-content:flex-start}}
      @media(prefers-reduced-motion:reduce){.mts-overlay,.mts-modal,.mts-ink,.mts-tab,.mts-body{transition:none!important}.mts-pane.is-entering,.mts-cat{animation:none!important}}
    `;
    document.head.append(style);
  }

  // ---- Sub-tab panels. Each returns a handle with destroy() and, where it can, reload().
  function pricebookLibrary(){ return root.FirstMatePricebook || root.Portal?.modules?.pricebook || null; }
  function stateMarkup(icon, text, spin = false){ return `<div class="mts-state" role="status"><i class="fas ${icon}${spin ? ' mts-spin' : ''}" aria-hidden="true"></i><span>${esc(text)}</span></div>`; }

  // ctx.orgId is a function (the organization can change while a panel is open); ctx.orgIdText() is its current value.
  // The price book, supplier editor and calculations editor take either; the supplier columns take only a string.
  function mountPricebook(host, ctx){
    const pricebook = pricebookLibrary();
    if (!pricebook?.mount) { host.innerHTML = stateMarkup('fa-triangle-exclamation', t('materials_settings_pricebook_unavailable', 'The price book could not be loaded.')); return {}; }
    pricebook.configure?.({ currentOrganizationId:ctx.orgId });
    const handle = pricebook.mount(host, { title:term('pricebook.pricebook', t('materials_settings_tab_pricebook', 'Price book')) });
    return { reload(){ return Promise.resolve(pricebook.loadState?.()).catch(() => null); }, destroy(){ try { handle?.destroy?.(); } catch (error) {} } };
  }

  function mountSuppliers(host, ctx){
    let handle = null, tools = null, destroyed = false;
    host.innerHTML = `<div class="mts-suppliers">
      <section class="mts-card mts-supplier-tools" data-mts-supplier-tools></section>
      <section class="mts-card mts-supplier-editor"><h3 class="mts-section-title"><i class="fas fa-truck" aria-hidden="true"></i>${esc(t('materials_settings_suppliers_editor', 'Suppliers, locations and delivery'))}</h3><div data-mts-supplier-panel>${stateMarkup('fa-circle-notch', t('materials_settings_loading_suppliers', 'Loading suppliers…'), true)}</div></section>
    </div>`;
    const panel = host.querySelector('[data-mts-supplier-panel]');
    const toolsHost = host.querySelector('[data-mts-supplier-tools]');
    const pricebook = pricebookLibrary();
    pricebook?.configure?.({ currentOrganizationId:ctx.orgId });
    Promise.all([loadScript(suppliersUrl, () => !!root.FirstMateSupplierSettings), Promise.resolve(pricebook?.loadState?.()).catch(() => null)]).then(() => {
      if (destroyed) return;
      panel.innerHTML = '';
      handle = root.FirstMateSupplierSettings.mount(panel, { orgId:ctx.orgId, pricebook, toast:ctx.toast });
      // The supplier columns from the guided price book setup: what each supplier carries and costs, and a price
      // sheet per supplier for the agent. Nothing renders where the library is not loaded.
      if (typeof root.FirstMateSupplierTools?.mount === 'function') tools = root.FirstMateSupplierTools.mount(toolsHost, { orgId:ctx.orgIdText(), pricebook, toast:ctx.toast, surface:'materials_settings', reload:() => handle?.reload?.() });
    }).catch(() => { if (!destroyed) panel.innerHTML = stateMarkup('fa-triangle-exclamation', t('materials_settings_suppliers_failed', 'The supplier editor could not load.')); });
    return {
      reload(){ try { handle?.reload?.(); tools?.reload?.(); } catch (error) {} },
      destroy(){ destroyed = true; try { tools?.destroy?.(); handle?.destroy?.(); } catch (error) {} }
    };
  }

  function mountDefaults(host, ctx){
    let handle = null, destroyed = false;
    host.innerHTML = `<div class="mts-pane-fill">${stateMarkup('fa-circle-notch', t('materials_settings_loading_calculations', 'Loading calculations…'), true)}</div>`;
    const fill = host.firstElementChild;
    loadScript(defaultsUrl, () => !!root.FirstMateMeasurementDefaults).then(() => {
      if (destroyed) return;
      fill.innerHTML = '';
      handle = root.FirstMateMeasurementDefaults.mount(fill, { orgId:ctx.orgId, toast:ctx.toast, surface:'materials_settings' });
    }).catch(() => { if (!destroyed) fill.innerHTML = stateMarkup('fa-triangle-exclamation', t('materials_settings_calculations_failed', 'Calculations could not load.')); });
    return { reload(){ return handle?.reload?.(); }, destroy(){ destroyed = true; try { handle?.destroy?.(); } catch (error) {} } };
  }

  // In Settings there is no project: the organization's resource types, written through the same routes project.js uses.
  const LINE_ITEM_SOURCES = () => [
    { id:'pricebook', label:t('materials_settings_source_pricebook', 'Price Book'), detail:t('materials_settings_source_pricebook_tip', 'Items and variants from the price book') },
    { id:'equipment', label:t('materials_settings_source_equipment', 'Equipment'), detail:t('materials_settings_source_equipment_tip', 'Units and their daily rates from the Equipment app') }
  ];
  function organizationCategories(ctx){
    const api = () => root.MaterialsAPI?.resourceTypes;
    let rows = [];
    const find = (id) => rows.find((row) => row.id === id);
    const known = () => LINE_ITEM_SOURCES().map((source) => source.id);
    const sourcesOf = (row) => (Array.isArray(row?.line_item_sources) ? row.line_item_sources : (({ material:['pricebook'], equipment:['equipment'] })[row?.id] || [])).filter((id) => known().includes(id));
    const skuOnlyOf = (row) => typeof row?.pricebook_sku_only === 'boolean' ? row.pricebook_sku_only : row?.id === 'material';
    const queue = new Map();
    const save = (row, create = false) => {
      const next = (queue.get(row.id) || Promise.resolve()).catch(() => {}).then(async () => {
        const input = { id:row.id, name:row.name || '', icon:row.icon, color:row.color, ...(Array.isArray(row.line_item_sources) ? { line_item_sources:row.line_item_sources } : {}), ...(typeof row.pricebook_sku_only === 'boolean' ? { pricebook_sku_only:row.pricebook_sku_only } : {}), ...(!create ? { expected_revision:row.revision || 0 } : {}) };
        const result = await api()[create ? 'create' : 'patch'](ctx.orgIdText(), ...(create ? [input] : [row.id, input]));
        row.revision = result?.resource_type?.revision ?? row.revision;
        return result;
      });
      queue.set(row.id, next);
      next.catch((error) => { if (create) rows = rows.filter((entry) => entry !== row); ctx.toast(t('materials_settings_cat_save_failed', 'Could not save the category'), error?.message || '', false); });
      return next;
    };
    return {
      ready:Promise.resolve(api()?.list?.(ctx.orgIdText())).then((result) => { rows = Array.isArray(result?.resource_types) ? result.resource_types : []; }),
      list:() => rows.map((row) => ({ id:row.id, name:row.name || '', icon:row.icon, color:row.color, sources:sourcesOf(row), skuOnly:skuOnlyOf(row) })),
      sourceDefs:() => LINE_ITEM_SOURCES().filter((source) => source.id !== 'equipment' || rows.some((row) => row.id === 'equipment')),
      add:(name) => { const row = { id:'resource_' + crypto.randomUUID().replaceAll('-', ''), name:clean(name), icon:'fa-layer-group', color:getComputedStyle(document.documentElement).getPropertyValue('--primary').trim() || '#d93025', revision:0 }; rows.push(row); return save(row, true); },
      rename:(id, name) => { const row = find(id); if (!row) return; row.name = clean(name); return save(row); },
      appearance:(id, done) => {
        const row = find(id);
        if (!row || !root.FirstMateWidgets?.mount) return;
        const dialog = document.createElement('dialog');
        dialog.className = 'mts-icon-dialog'; dialog.style.cssText = 'max-width:520px;width:calc(100vw - 32px);padding:12px;border:0;border-radius:14px';
        const stage = document.createElement('div');
        dialog.append(stage); document.body.append(dialog);
        const widget = root.FirstMateWidgets.mount(stage, { id:'icon.picker', version:'1', config:{ prompt:t('materials_settings_cat_icon', 'Icon and color'), includeColor:true, value:row.icon, color:row.color } }, { surface:'settings', onSelect:(selection, detail) => { if (!detail?.confirmed) return; row.icon = selection.value; row.color = selection.color; save(row); dialog.close(); done?.(); } });
        dialog.onclose = () => { try { widget?.destroy?.(); } catch (error) {} dialog.remove(); };
        dialog.addEventListener('click', (event) => { if (event.target === dialog) dialog.close(); });
        dialog.showModal();
      },
      toggleSource:(id, sourceId) => { const row = find(id); if (!row) return; const current = sourcesOf(row); row.line_item_sources = known().filter((key) => (key === sourceId ? !current.includes(key) : current.includes(key))); return save(row); },
      setSkuOnly:(id, on) => { const row = find(id); if (!row) return; row.pricebook_sku_only = !!on; if (!Array.isArray(row.line_item_sources)) row.line_item_sources = sourcesOf(row); return save(row); },
      remove:async (id) => {
        const row = find(id); if (!row) return;
        const ok = await Promise.resolve(root.confirm?.(t('materials_settings_cat_remove_confirm', 'Remove this category? It is removed for every project in this company.')));
        if (!ok) return;
        try { await (queue.get(id) || Promise.resolve()).catch(() => {}); await api().archive(ctx.orgIdText(), id, { expected_revision:row.revision || 0 }); rows = rows.filter((entry) => entry.id !== id); }
        catch (error) { ctx.toast(t('materials_settings_cat_remove_failed', 'Could not remove the category'), error?.message || '', false); }
      }
    };
  }

  // Resource categories are the Materials tab's columns. project.js owns their writers in a project; this only draws them.
  function mountCategories(host, ctx){
    const api = ctx.categories || organizationCategories(ctx);
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
    if (api.ready) { host.innerHTML = stateMarkup('fa-circle-notch', t('materials_settings_loading_categories', 'Loading categories…'), true); api.ready.then(() => { if (host.isConnected) draw(); }, () => { host.innerHTML = stateMarkup('fa-triangle-exclamation', t('materials_settings_categories_failed', 'Categories could not load.')); }); }
    else draw();
    return { refresh:draw, destroy(){ host.innerHTML = ''; } };
  }

  // ---- The docked assistant: the global assistant in the person's private materials-settings conversation.
  function agentAvailable(){ return typeof root.PlatformAssistant?.mountSurface === 'function' && flag('apps', 'assistant') && !!root.MaterialsAPI?.request; }
  // Open unless the person closed it; on a phone the agent takes the whole sheet, so it starts closed there.
  function readCollapsed(){ let stored = null; try { stored = root.localStorage?.getItem(AGENT_KEY); } catch (error) {} return stored === null || stored === undefined ? (root.innerWidth || 1280) < 760 : stored === '1'; }
  function writeCollapsed(value){ try { root.localStorage?.setItem(AGENT_KEY, value ? '1' : '0'); } catch (error) {} }
  const SUGGESTIONS = {
    pricebook:() => [t('materials_settings_ask_pricebook_1', 'Which price book items are missing a cost?'), t('materials_settings_ask_pricebook_2', 'Add the materials for a shingle roof replacement.')],
    suppliers:() => [t('materials_settings_ask_suppliers_1', 'Set my supplier costs from a price sheet.'), t('materials_settings_ask_suppliers_2', 'Which items does no supplier carry?')],
    calculations:() => [t('materials_settings_ask_calculations_1', 'How is the shingle quantity worked out?'), t('materials_settings_ask_calculations_2', 'Use 12% waste on every roof.')],
    categories:() => [t('materials_settings_ask_categories_1', 'Add a category for dumpsters.')]
  };
  function mountAgent(host, shell, ctx){
    let wasPending = false;
    const orgId = ctx.orgIdText();
    const assistant = root.PlatformAssistant.mountSurface(host, {
      orgId,
      welcome:t('materials_settings_agent_welcome', 'I can help with your price book, suppliers and calculations. Ask, or tell me what to change.'),
      suggestions:(SUGGESTIONS[shell.active] || SUGGESTIONS.pricebook)(),
      getContext:() => ({ surface:'materials_settings', tab:shell.active, ...(ctx.projectId ? { projectId:ctx.projectId } : {}) }),
      loadContext:async () => {
        const { thread } = await root.MaterialsAPI.request(`/organizations/${encodeURIComponent(orgId)}/settings/conversation`, { method:'POST', body:{} });
        return { main_thread:thread, threads:[thread], agents:[], dashboard:[] };
      },
      // After the agent's turn, what it changed is read again.
      onState:({ pending }) => { if (wasPending && !pending) shell.reloadPanels(); wasPending = !!pending; }
    });
    assistant?.ready?.catch?.((error) => { if (host.isConnected) host.innerHTML = stateMarkup('fa-triangle-exclamation', error?.message || t('materials_settings_agent_unavailable', 'The agent is unavailable.')); });
    return assistant;
  }

  // ---- The shell: header with the sub-tabs, the panes and the docked agent. Used by the modal and by Settings.
  function createShell(options, { inline }){
    injectStyles();
    const allowed = SECTIONS.filter((section) => sections(options).includes(section.id));
    if (!allowed.length) return null;
    const orgIdFn = typeof options.orgId === 'function' ? options.orgId : () => options.orgId;
    const ctx = { orgId:() => clean(orgIdFn()), orgIdText:() => clean(orgIdFn()), toast:options.toast || root.Portal?.ui?.showToast || (() => {}), categories:options.categories || null, projectId:clean(options.projectId) };
    const withAgent = agentAvailable();
    let collapsed = readCollapsed();
    const shell = document.createElement('section');
    shell.className = `mts-shell ${inline ? 'is-inline' : 'mts-modal'}`;
    shell.dataset.mtsShell = inline ? 'settings' : 'modal';
    shell.style.setProperty('--mts-font', getComputedStyle(document.body).fontFamily || PLATFORM_FONT);
    if (!inline) { shell.setAttribute('role', 'dialog'); shell.setAttribute('aria-modal', 'true'); shell.setAttribute('aria-labelledby', 'mtsTitle'); }
    const title = t('materials_settings_title', 'Materials settings');
    shell.innerHTML = `
      <header class="mts-head">
        ${inline ? '' : `<span class="mts-mark" aria-hidden="true"><i class="fas fa-sliders"></i></span><h2 id="mtsTitle">${esc(title)}</h2>`}
        <nav class="mts-tabs" role="tablist" aria-label="${esc(title)}"><span class="mts-ink" aria-hidden="true"></span>${allowed.map((section) => `<button type="button" class="mts-tab" role="tab" id="mtsTab-${section.id}" aria-controls="mtsPane-${section.id}" aria-selected="false" tabindex="-1" data-mts-tab="${section.id}" data-fm-tooltip="${esc(section.tip())}"><i class="fas ${section.icon}" aria-hidden="true"></i><span>${esc(section.label())}</span></button>`).join('')}</nav>
        <div class="mts-head-end">
          ${withAgent ? `<button type="button" class="mts-agent-toggle" data-mts-agent-toggle aria-pressed="${!collapsed}" aria-controls="mtsAgent" data-fm-tooltip="${esc(t('materials_settings_agent_toggle', 'Show or hide the agent'))}"><i class="fas fa-wand-magic-sparkles" aria-hidden="true"></i><span>${esc(t('materials_settings_agent', 'Agent'))}</span></button>` : ''}
          ${inline ? '' : `<button type="button" class="mts-close" data-mts-close data-fm-tooltip="${esc(t('materials_settings_close', 'Close'))}" aria-label="${esc(t('materials_settings_close', 'Close'))}"><i class="fas fa-xmark" aria-hidden="true"></i></button>`}
        </div>
      </header>
      <div class="mts-body${withAgent ? '' : ' no-agent'}${withAgent && collapsed ? ' agent-collapsed' : ''}">
        <div class="mts-panes">${allowed.map((section) => `<div class="mts-pane" role="tabpanel" id="mtsPane-${section.id}" aria-labelledby="mtsTab-${section.id}" data-mts-pane="${section.id}" hidden></div>`).join('')}</div>
        <aside class="mts-agent" id="mtsAgent" data-mts-agent aria-label="${esc(t('materials_settings_agent', 'Agent'))}"${withAgent && !collapsed ? '' : ' aria-hidden="true"'}><div class="mts-agent-host" data-mts-agent-host></div></aside>
      </div>`;
    const ink = shell.querySelector('.mts-ink'), body = shell.querySelector('.mts-body');
    const handles = new Map();
    let agent = null;
    const placeInk = (animate = true) => {
      const tab = shell.querySelector('.mts-tab[aria-selected="true"]');
      if (!tab) return;
      if (!animate) ink.style.transition = 'none';
      ink.style.width = `${tab.offsetWidth}px`;
      ink.style.transform = `translateX(${tab.offsetLeft - 3}px)`;
      if (!animate) { void ink.offsetWidth; ink.style.transition = ''; }
    };
    const startAgent = () => {
      if (!withAgent || agent || collapsed) return;
      try { agent = mountAgent(shell.querySelector('[data-mts-agent-host]'), state, ctx); } catch (error) { shell.querySelector('[data-mts-agent-host]').innerHTML = stateMarkup('fa-triangle-exclamation', error?.message || t('materials_settings_agent_unavailable', 'The agent is unavailable.')); }
    };
    const setCollapsed = (value) => {
      collapsed = !!value; writeCollapsed(collapsed);
      body.classList.toggle('agent-collapsed', collapsed);
      shell.querySelector('[data-mts-agent-toggle]')?.setAttribute('aria-pressed', String(!collapsed));
      const aside = shell.querySelector('[data-mts-agent]');
      if (collapsed) aside.setAttribute('aria-hidden', 'true'); else aside.removeAttribute('aria-hidden');
      startAgent();
    };
    const state = {
      active:'',
      shell,
      ctx,
      select(id, { focus = false } = {}){
        const section = allowed.find((row) => row.id === id) || allowed[0];
        if (state.active === section.id) return;
        const first = !state.active;
        state.active = section.id;
        shell.querySelectorAll('[data-mts-tab]').forEach((tab) => { const on = tab.dataset.mtsTab === section.id; tab.setAttribute('aria-selected', String(on)); tab.tabIndex = on ? 0 : -1; if (on && focus) tab.focus(); if (on) tab.scrollIntoView?.({ block:'nearest', inline:'nearest' }); });
        shell.querySelectorAll('[data-mts-pane]').forEach((pane) => {
          const on = pane.dataset.mtsPane === section.id;
          pane.hidden = !on;
          pane.classList.remove('is-entering');
          if (on && !reducedMotion()) { void pane.offsetWidth; pane.classList.add('is-entering'); }
        });
        placeInk(!first);
        // Each panel mounts the first time its sub-tab is shown and stays mounted, so switching keeps edits.
        if (!handles.has(section.id)) {
          const pane = shell.querySelector(`[data-mts-pane="${section.id}"]`);
          let handle = {};
          try { handle = section.mount(pane, ctx) || {}; } catch (error) { pane.innerHTML = stateMarkup('fa-triangle-exclamation', error?.message || t('materials_settings_failed', 'This setting could not load.')); }
          handles.set(section.id, handle);
        }
        shell.dispatchEvent(new CustomEvent('mts:section', { detail:{ section:section.id } }));
        options.onSection?.(section.id);
      },
      reloadPanels(){ handles.forEach((handle) => { try { handle.reload?.(); } catch (error) {} }); },
      placeInk,
      setAgentCollapsed:setCollapsed,
      destroy(){
        handles.forEach((handle) => { try { handle.destroy?.(); } catch (error) {} });
        handles.clear();
        try { agent?.destroy?.(); } catch (error) {}
        agent = null;
      }
    };
    shell.addEventListener('click', (event) => {
      const tab = event.target.closest('[data-mts-tab]');
      if (tab) { state.select(tab.dataset.mtsTab); return; }
      if (event.target.closest('[data-mts-agent-toggle]')) setCollapsed(!collapsed);
    });
    shell.querySelector('.mts-tabs').addEventListener('keydown', (event) => {
      if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
      event.preventDefault();
      const ids = allowed.map((row) => row.id), index = ids.indexOf(state.active);
      const next = event.key === 'Home' ? 0 : event.key === 'End' ? ids.length - 1 : (index + (event.key === 'ArrowRight' ? 1 : -1) + ids.length) % ids.length;
      state.select(ids[next], { focus:true });
    });
    state.start = (section) => { state.select(section || allowed[0].id); startAgent(); };
    return state;
  }

  // ---- The modal (a project's Materials tab).
  let current = null;

  function open(options = {}){
    injectStyles();
    if (current) { current.select(options.section || current.active); return current; }
    const shellState = createShell(options, { inline:false });
    if (!shellState) return null;
    const trigger = document.activeElement;
    const overlay = document.createElement('div');
    overlay.className = 'mts-overlay';
    overlay.dataset.mtsOverlay = '';
    overlay.style.setProperty('--mts-font', getComputedStyle(document.body).fontFamily || PLATFORM_FONT);
    overlay.append(shellState.shell);
    const modal = shellState.shell;
    // Grow from the gear that opened it.
    const origin = options.originRect || trigger?.getBoundingClientRect?.();
    document.body.append(overlay);
    if (origin) {
      const box = modal.getBoundingClientRect();
      modal.style.transformOrigin = `${Math.round(origin.left + origin.width / 2 - box.left)}px ${Math.round(origin.top + origin.height / 2 - box.top)}px`;
    }
    overlay.addEventListener('click', (event) => { if (event.target.closest('[data-mts-close]')) close(); });
    const onResize = () => shellState.placeInk(false);
    root.addEventListener('resize', onResize);
    // Stack with the platform's other windows; without the manager it closes on Escape and a backdrop click itself.
    const modals = root.Portal?.modals;
    const modalHandle = modals?.register?.(overlay, { id:'materials-settings', closeOnEscape:true, closeOnBackdrop:true, onClose:() => close() }) || null;
    modalHandle?.bringToFront?.();
    const onKey = (event) => { if (event.key === 'Escape' && !modalHandle && !event.target?.closest?.('.md-dd-pop')) { event.stopPropagation(); close(); } };
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
        shellState.destroy();
        overlay.remove();
        try { trigger?.focus?.({ preventScroll:true }); } catch (error) {}
        options.onClose?.();
      };
      if (reducedMotion()) finish(); else setTimeout(finish, 200);
    }
    const state = { get active(){ return shellState.active; }, overlay, select:shellState.select, setAgentCollapsed:shellState.setAgentCollapsed, close };
    current = state;
    shellState.start(options.section);
    requestAnimationFrame(() => { overlay.classList.add('is-open'); shellState.placeInk(false); shellState.shell.querySelector('.mts-tab[aria-selected="true"]')?.focus({ preventScroll:true }); });
    return state;
  }

  function close(){ current?.close(); }

  // ---- Settings › Materials: the same shell inside a Settings page, a little larger, with no close button.
  function mountInline(host, options = {}){
    const shellState = createShell({ ...options, surface:'settings' }, { inline:true });
    if (!shellState) { host.innerHTML = ''; return null; }
    host.replaceChildren(shellState.shell);
    // The page below the Settings heading: fill the window's height from where the shell starts.
    const fit = () => {
      const top = shellState.shell.getBoundingClientRect().top;
      if (top > 0) shellState.shell.style.height = `${Math.max(600, Math.round(root.innerHeight - top - 20))}px`;
      shellState.placeInk(false);
    };
    root.addEventListener('resize', fit);
    shellState.start(options.section);
    fit();
    requestAnimationFrame(fit);
    return {
      get active(){ return shellState.active; },
      select:shellState.select,
      refit:() => requestAnimationFrame(fit),
      setAgentCollapsed:shellState.setAgentCollapsed,
      destroy(){ root.removeEventListener('resize', fit); shellState.destroy(); host.replaceChildren(); }
    };
  }

  root.FirstMateMaterialsSettings = { sections, open, close, mountInline, isOpen:() => !!current };
})(window);
