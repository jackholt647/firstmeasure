/* public/libraries/apps/people/app-grid.js
 *
 * App experience as a grid: which tabs a person gets on which platform.
 * One tile per tab, one cell per platform. Used for a user (overriding their
 * roles) and for a role (overriding the product defaults).
 *
 *   const grid = FirstMatePeople.appGrid.mount(container, {
 *     apps: [{ id, title, description, icon, surface, devices: ['desktop', 'mobile'], order }],
 *     sections: [{ id: 'portal_tab', label: 'Tabs', icon }],      // pages of the grid, matched on app.surface
 *     platforms: [{ id: 'desktop', label: 'Desktop', icon }],     // the columns
 *     value: { 'portal.calls': 'hide' },      // what THIS level says; a missing key inherits
 *     inherited(appId) => ({ shown: true, sources: ['Sales'] }),
 *     perPlatform: false,                     // see below
 *     readOnly: false,
 *     onChange(value, appId) {}
 *   });
 *   grid.getValue()   grid.setValue(value)   grid.refresh()   grid.overrideCount()   grid.destroy()
 *
 * Today the platform stores one answer per tab (show or hide), not one per
 * platform, so a tab's cells move together: a cell is lit on every platform
 * the tab exists on (app.devices). With perPlatform: true the value becomes
 * { appId: { desktop: 'show', mobile: 'hide' } } and each cell is independent;
 * nothing else in this component changes when the backend can store that.
 */
(function(){
  'use strict';
  const People = window.FirstMatePeople = window.FirstMatePeople || {};
  if (People.appGrid) return;
  const kit = People.kit;
  const { esc, t, tip } = kit;

  function ensureStyles(){
    if (document.getElementById('pp_apps_css')) return;
    const style = document.createElement('style');
    style.id = 'pp_apps_css';
    style.textContent = `
      .pp-apps{display:flex;flex-direction:column;gap:12px;height:100%;min-height:0;container-type:inline-size}
      .pp-apps-bar{display:flex;align-items:center;gap:10px;flex:none}
      .pp-apps-legend{margin-left:auto;display:flex;align-items:center;gap:12px;color:var(--pp-muted);font-size:12px;font-weight:600;white-space:nowrap}
      .pp-apps-legend>span{display:inline-flex;align-items:center;gap:6px}
      .pp-apps-legend i{font-size:11px;color:var(--pp-faint)}
      .pp-apps-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(228px,1fr));grid-auto-rows:min-content;align-content:start;gap:3px 12px;flex:1;min-height:0;overflow-y:auto;padding:1px}
      .pp-app{display:flex;align-items:center;gap:9px;min-width:0;height:36px;padding:0 4px 0 9px;border-radius:8px;background:var(--pp-soft);transition:background .12s ease,box-shadow .12s ease}
      .pp-app.overridden{background:var(--pp-warn-bg);box-shadow:inset 0 0 0 1px var(--pp-warn-line)}
      .pp-app>i{flex:none;width:15px;text-align:center;color:var(--pp-muted);font-size:12px}
      .pp-app-title{flex:1;min-width:0;color:var(--pp-strong);font-size:12.5px;font-weight:600;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
      .pp-app.off .pp-app-title,.pp-app.off>i{color:var(--pp-faint)}
      .pp-app-cells{display:inline-flex;flex:none;gap:2px}
      .pp-app-cell{position:relative;display:grid;place-items:center;width:28px;height:26px;border:0;border-radius:7px;background:transparent;color:#c2c8d2;font-size:12px;cursor:pointer;transition:background .1s ease,color .1s ease}
      .pp-app-cell:hover:not(:disabled){background:rgba(16,24,40,.06);color:var(--pp-muted)}
      .pp-app-cell[aria-pressed="true"]{background:var(--pp-ok-bg);color:var(--pp-ok)}
      .pp-app-cell[aria-pressed="true"]:hover:not(:disabled){background:var(--pp-ok-line);color:var(--pp-ok)}
      .pp-app-cell[aria-pressed="false"]::after{content:'';position:absolute;left:7px;right:7px;top:50%;height:1.5px;border-radius:2px;background:currentColor;transform:rotate(-38deg)}
      .pp-app-cell:disabled{cursor:default}
      .pp-app-cell.absent{color:transparent}
      .pp-app-cell.absent::after{content:'';position:absolute;left:11px;right:11px;top:50%;height:1.5px;background:#d0d5dd;transform:none}
      .pp-apps-heading{grid-column:1/-1;margin:8px 0 1px 2px;color:var(--pp-muted);font-size:11px;font-weight:700;letter-spacing:.04em;text-transform:uppercase}
      .pp-apps-heading:first-child{margin-top:0}
      .pp-app-reset{width:22px;height:26px;font-size:10px;visibility:hidden}
      .pp-app.overridden .pp-app-reset{visibility:visible;color:var(--pp-warn)}
      @container (max-width:620px){
        .pp-apps-legend{display:none}
        .pp-apps-grid{grid-template-columns:minmax(0,1fr)}
      }
      @media (prefers-reduced-motion:reduce){.pp-app,.pp-app-cell{transition:none}}
    `;
    document.head.appendChild(style);
  }

  const DEFAULT_SECTIONS = () => [
    { id:'portal_tab', label:t('tabs', 'Tabs'), icon:'fa-table-columns' },
    { id:'project_modal', label:t('project_views', 'Project views'), icon:'fa-window-maximize' }
  ];
  const DEFAULT_PLATFORMS = () => [
    { id:'desktop', label:t('desktop', 'Desktop'), icon:kit.ICONS.desktop },
    { id:'mobile', label:t('phone', 'Phone'), icon:kit.ICONS.mobile }
  ];

  function mount(container, options = {}){
    if (!container) throw new Error('appGrid.mount requires a container.');
    ensureStyles();
    const apps = (options.apps || []).filter((app) => app && app.id);
    const platforms = options.platforms || DEFAULT_PLATFORMS();
    const sections = (options.sections || DEFAULT_SECTIONS()).filter((section) => apps.some((app) => (app.surface || 'portal_tab') === section.id));
    const perPlatform = options.perPlatform === true;
    const readOnly = options.readOnly === true;
    let value = { ...(options.value || {}) };
    const ALL = '__all';
    const showAll = sections.length > 1 && apps.length <= (options.allLimit || 30);
    let active = showAll ? ALL : sections[0]?.id || '';
    let query = '';

    const above = (appId) => options.inherited?.(appId) || { shown:false, sources:[] };
    const own = (appId, platformId) => {
      const entry = value[appId];
      const raw = perPlatform && entry && typeof entry === 'object' ? entry[platformId] : entry;
      return raw === 'show' ? true : raw === 'hide' ? false : null;
    };
    const overridden = (appId) => platforms.some((platform) => own(appId, platform.id) != null);
    const shown = (appId, platformId) => { const mine = own(appId, platformId); return mine == null ? above(appId).shown === true : mine; };
    const overrideCount = () => apps.filter((app) => overridden(app.id)).length;

    container.innerHTML = `<div class="pp pp-apps" data-settings-autosave="off">
      <div class="pp-apps-bar">
        ${sections.length > 1 ? `<div class="pp-seg" role="tablist" aria-label="${esc(t('app_sections', 'Kind of tab'))}">${showAll ? `<button type="button" role="tab" data-apps-section="${ALL}" aria-selected="${active === ALL}">${esc(t('all', 'All'))}</button>` : ''}${sections.map((section) => `<button type="button" role="tab" data-apps-section="${esc(section.id)}" aria-selected="${section.id === active}"><i class="fas ${esc(section.icon || 'fa-table-columns')}" aria-hidden="true"></i>${esc(section.label)}<span class="pp-seg-count" data-apps-section-count="${esc(section.id)}"></span></button>`).join('')}</div>` : ''}
        <label class="pp-search"><i class="fas ${kit.ICONS.search}" aria-hidden="true"></i><input type="search" data-apps-search placeholder="${esc(t('search_tabs', 'Search tabs'))}" aria-label="${esc(t('search_tabs', 'Search tabs'))}" autocomplete="off" spellcheck="false"></label>
        <div class="pp-apps-legend" aria-hidden="true">${platforms.map((platform) => `<span><i class="fas ${esc(platform.icon)}"></i>${esc(platform.label)}</span>`).join('')}</div>
      </div>
      <div class="pp-apps-grid" role="group" aria-label="${esc(t('app_experience', 'App experience'))}"></div>
    </div>`;
    const root = container.firstElementChild;
    const gridEl = root.querySelector('.pp-apps-grid');

    function tileHtml(app){
      const from = above(app.id);
      const isOverridden = overridden(app.id);
      const anyShown = platforms.some((platform) => (app.devices || []).includes(platform.id) && shown(app.id, platform.id));
      const inheritedText = from.shown
        ? t('inherits_shown', 'Inherited: shown{sources}', { sources:from.sources?.length ? ` (${from.sources.join(', ')})` : '' })
        : t('inherits_hidden', 'Inherited: hidden');
      const cells = platforms.map((platform) => {
        if (!(app.devices || platforms.map((entry) => entry.id)).includes(platform.id)) return `<span class="pp-app-cell absent" role="img" aria-label="${esc(t('not_on_platform', 'Not available on {platform}', { platform:platform.label }))}"${tip(t('not_on_platform', 'Not available on {platform}', { platform:platform.label }))}><i class="fas ${esc(platform.icon)}" aria-hidden="true"></i></span>`;
        const on = shown(app.id, platform.id);
        const label = `${platform.label}: ${on ? t('shown', 'shown') : t('hidden', 'hidden')}`;
        const linked = !perPlatform && platforms.filter((entry) => (app.devices || []).includes(entry.id)).length > 1 ? ` • ${t('platforms_linked', 'Set for every platform together')}` : '';
        return `<button type="button" class="pp-app-cell" data-apps-cell="${esc(platform.id)}" aria-pressed="${on}" aria-label="${esc(`${app.title}, ${label}`)}"${tip(`${label}${linked} • ${inheritedText}`)} ${readOnly ? 'disabled' : ''}><i class="fas ${esc(platform.icon)}" aria-hidden="true"></i></button>`;
      }).join('');
      return `<div class="pp-app${isOverridden ? ' overridden' : ''}${anyShown ? '' : ' off'}" data-apps-id="${esc(app.id)}"><i class="fas ${esc(app.icon || 'fa-table-cells-large')}" aria-hidden="true"></i><span class="pp-app-title"${tip([app.description, isOverridden ? inheritedText : ''].filter(Boolean).join(' • '))}>${esc(app.title)}</span><span class="pp-app-cells">${cells}</span><button type="button" class="pp-icon-btn pp-app-reset" data-apps-reset aria-label="${esc(t('reset_to_inherited', 'Back to inherited'))}"${tip(t('reset_to_inherited', 'Back to inherited'))} ${readOnly || !isOverridden ? 'disabled' : ''}><i class="fas ${kit.ICONS.inherited}" aria-hidden="true"></i></button></div>`;
    }
    const sectionIndex = (app) => { const index = sections.findIndex((section) => section.id === (app.surface || 'portal_tab')); return index < 0 ? sections.length : index; };
    function visible(){
      const text = query.trim().toLowerCase();
      return apps
        .filter((app) => text ? `${app.title} ${app.description || ''} ${app.id}`.toLowerCase().includes(text) : active === ALL || (app.surface || 'portal_tab') === active)
        .sort((left, right) => (sectionIndex(left) - sectionIndex(right)) || (Number(left.order || 0) - Number(right.order || 0)) || String(left.title).localeCompare(String(right.title)));
    }
    function renderCounts(){
      sections.forEach((section) => {
        const count = apps.filter((app) => (app.surface || 'portal_tab') === section.id && overridden(app.id)).length;
        const badge = root.querySelector(`[data-apps-section-count="${CSS.escape(section.id)}"]`);
        if (badge) badge.textContent = count ? String(count) : '';
      });
    }
    function render(){
      const list = visible();
      root.querySelectorAll('[data-apps-section]').forEach((button) => button.setAttribute('aria-selected', String(!query && button.dataset.appsSection === active)));
      const grouped = (query.trim() || active === ALL) && sections.length > 1;
      let lastSection = '';
      gridEl.innerHTML = list.length ? list.map((app) => {
        const sectionId = app.surface || 'portal_tab';
        const heading = grouped && sectionId !== lastSection ? `<h5 class="pp-apps-heading">${esc(sections.find((section) => section.id === sectionId)?.label || '')}</h5>` : '';
        lastSection = sectionId;
        return heading + tileHtml(app);
      }).join('') : `<div class="pp-list-state" style="grid-column:1/-1"><i class="fas ${kit.ICONS.search}" aria-hidden="true"></i><strong>${esc(t('no_matches', 'No matches'))}</strong></div>`;
      renderCounts();
    }
    function change(appId, platformId, reset){
      if (readOnly) return;
      const next = { ...value };
      if (reset) delete next[appId];
      else {
        const target = !shown(appId, platformId);
        const matchesInherited = target === (above(appId).shown === true);
        if (perPlatform) {
          const entry = { ...(typeof next[appId] === 'object' && next[appId] ? next[appId] : {}) };
          if (matchesInherited) delete entry[platformId]; else entry[platformId] = target ? 'show' : 'hide';
          if (Object.keys(entry).length) next[appId] = entry; else delete next[appId];
        } else if (matchesInherited) delete next[appId];
        else next[appId] = target ? 'show' : 'hide';
      }
      value = next;
      const tile = gridEl.querySelector(`[data-apps-id="${CSS.escape(appId)}"]`);
      const app = apps.find((entry) => entry.id === appId);
      if (tile && app) {
        tile.outerHTML = tileHtml(app);
        const fresh = gridEl.querySelector(`[data-apps-id="${CSS.escape(appId)}"]`);
        (fresh?.querySelector(platformId ? `[data-apps-cell="${CSS.escape(platformId)}"]` : '[data-apps-cell]'))?.focus({ preventScroll:true });
      }
      renderCounts();
      options.onChange?.({ ...value }, appId);
    }
    gridEl.addEventListener('click', (event) => {
      const tile = event.target.closest('[data-apps-id]');
      if (!tile) return;
      const reset = event.target.closest('[data-apps-reset]');
      if (reset && !reset.disabled) { change(tile.dataset.appsId, '', true); return; }
      const cell = event.target.closest('[data-apps-cell]');
      if (cell && !cell.disabled) change(tile.dataset.appsId, cell.dataset.appsCell, false);
    });
    root.querySelectorAll('[data-apps-section]').forEach((button) => button.addEventListener('click', () => {
      active = button.dataset.appsSection;
      if (query) { query = ''; root.querySelector('[data-apps-search]').value = ''; }
      render();
    }));
    root.querySelector('[data-apps-search]').addEventListener('input', (event) => { query = event.target.value; render(); });
    render();

    return {
      el:root,
      getValue:() => ({ ...value }),
      setValue(next){ value = { ...(next || {}) }; render(); },
      refresh:render,
      overrideCount,
      destroy(){ container.replaceChildren(); }
    };
  }

  People.appGrid = { mount, ensureStyles };
})();
