/* public/libraries/apps/people/app-grid.js
 *
 * App experience as a grid (docs/architecture/app-experience.md): which apps
 * a person gets on which device, and each app's options. One tile per app,
 * one cell per device type, one line under the tile per option. Used for a
 * user (over their roles, groups and departments), a role, a group and a
 * department.
 *
 *   const grid = FirstMatePeople.appGrid.mount(container, {
 *     apps: [{ id, title, description, icon, surface, devices: ['desktop'], order, options: [{ key, label, description }] }],
 *     sections: [{ id: 'portal_tab', label: 'Apps', icon }],      // pages of the grid, matched on app.surface
 *     platforms: [{ id: 'desktop', label: 'Desktop', icon }],     // the device types, as columns
 *     value: { 'portal.chat': { visible: { mobile: false }, options: {} } },   // what THIS level says; anything missing inherits
 *     inherited(appId) => ({ visible: { desktop: true, mobile: true }, options: { time_clock: false }, sources: ['Sales'] }),
 *     restrictable: false,                    // departments and groups can restrict an app: hidden everywhere, refused by the server
 *     readOnly: false,
 *     onChange(value, appId) {}
 *   });
 *   grid.getValue()   grid.setValue(value)   grid.refresh()   grid.overrideCount()   grid.destroy()
 *
 * A device an app does not exist on shows as absent and cannot be turned on.
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
      .pp-app{display:flex;flex-direction:column;min-width:0;border-radius:8px;background:var(--pp-soft);transition:background .12s ease,box-shadow .12s ease}
      .pp-app-main{display:flex;align-items:center;gap:9px;min-width:0;height:36px;padding:0 4px 0 9px}
      .pp-app.overridden{background:var(--pp-warn-bg);box-shadow:inset 0 0 0 1px var(--pp-warn-line)}
      .pp-app.restricted{background:var(--pp-soft);box-shadow:inset 0 0 0 1px var(--pp-line)}
      .pp-app-main>i{flex:none;width:15px;text-align:center;color:var(--pp-muted);font-size:12px}
      .pp-app-title{flex:1;min-width:0;color:var(--pp-strong);font-size:12.5px;font-weight:600;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
      .pp-app.off .pp-app-title,.pp-app.off .pp-app-main>i{color:var(--pp-faint)}
      .pp-app-cells{display:inline-flex;flex:none;gap:2px}
      .pp-app-cell{position:relative;display:grid;place-items:center;width:28px;height:26px;border:0;border-radius:7px;background:transparent;color:#c2c8d2;font-size:12px;cursor:pointer;transition:background .1s ease,color .1s ease}
      .pp-app-cell:hover:not(:disabled){background:rgba(16,24,40,.06);color:var(--pp-muted)}
      .pp-app-cell[aria-pressed="true"]{background:var(--pp-ok-bg);color:var(--pp-ok)}
      .pp-app-cell[aria-pressed="true"]:hover:not(:disabled){background:var(--pp-ok-line);color:var(--pp-ok)}
      .pp-app-cell[aria-pressed="false"]::after{content:'';position:absolute;left:7px;right:7px;top:50%;height:1.5px;border-radius:2px;background:currentColor;transform:rotate(-38deg)}
      .pp-app-cell:disabled{cursor:default}
      .pp-app-cell.absent{color:transparent}
      .pp-app-cell.absent::after{content:'';position:absolute;left:11px;right:11px;top:50%;height:1.5px;background:#d0d5dd;transform:none}
      .pp-app-option{display:flex;align-items:center;gap:8px;min-width:0;height:28px;padding:0 4px 0 33px;border-top:1px solid rgba(16,24,40,.05)}
      .pp-app-option-label{flex:1;min-width:0;color:var(--pp-muted);font-size:12px;font-weight:600;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
      .pp-app-option.overridden .pp-app-option-label{color:var(--pp-warn)}
      .pp-app-switch{position:relative;flex:none;width:30px;height:18px;border:0;border-radius:999px;background:#d0d5dd;cursor:pointer;transition:background .12s ease}
      .pp-app-switch::after{content:'';position:absolute;top:2px;left:2px;width:14px;height:14px;border-radius:50%;background:#fff;box-shadow:0 1px 2px rgba(16,24,40,.2);transition:transform .12s ease}
      .pp-app-switch[aria-checked="true"]{background:var(--pp-ok)}
      .pp-app-switch[aria-checked="true"]::after{transform:translateX(12px)}
      .pp-app-switch:disabled{cursor:default;opacity:.6}
      .pp-apps-heading{grid-column:1/-1;margin:8px 0 1px 2px;color:var(--pp-muted);font-size:11px;font-weight:700;letter-spacing:.04em;text-transform:uppercase}
      .pp-apps-heading:first-child{margin-top:0}
      .pp-app-reset,.pp-app-restrict{width:22px;height:26px;font-size:10px}
      .pp-app-reset{visibility:hidden}
      .pp-app.overridden .pp-app-reset{visibility:visible;color:var(--pp-warn)}
      .pp-app-restrict[aria-pressed="true"]{color:var(--pp-danger,#b42318)}
      @container (max-width:620px){
        .pp-apps-legend{display:none}
        .pp-apps-grid{grid-template-columns:minmax(0,1fr)}
      }
      @media (prefers-reduced-motion:reduce){.pp-app,.pp-app-cell,.pp-app-switch,.pp-app-switch::after{transition:none}}
    `;
    document.head.appendChild(style);
  }

  const DEFAULT_SECTIONS = () => [
    { id:'portal_tab', label:t('apps', 'Apps'), icon:'fa-table-columns' },
    { id:'project_modal', label:t('project_views', 'Project views'), icon:'fa-window-maximize' },
    { id:'contact_modal', label:t('contact_views', 'Contact views'), icon:'fa-address-card' }
  ];
  const DEFAULT_PLATFORMS = () => [
    { id:'desktop', label:t('desktop', 'Desktop'), icon:kit.ICONS.desktop },
    { id:'mobile', label:t('phone', 'Phone'), icon:kit.ICONS.mobile }
  ];
  const plain = (value) => value && typeof value === 'object' && !Array.isArray(value) ? value : {};

  /** One level's setting for an app, with empty parts dropped; null when it says nothing. */
  function compact(setting){
    const visible = { ...plain(setting?.visible) };
    const options = { ...plain(setting?.options) };
    const rest = Object.fromEntries(Object.entries(plain(setting)).filter(([key, part]) => !['visible', 'options', 'restricted'].includes(key) && Object.keys(plain(part)).length));
    const next = { ...rest };
    if (Object.keys(visible).length) next.visible = visible;
    if (Object.keys(options).length) next.options = options;
    if (setting?.restricted === true) next.restricted = true;
    return Object.keys(next).length ? next : null;
  }

  function mount(container, options = {}){
    if (!container) throw new Error('appGrid.mount requires a container.');
    ensureStyles();
    const apps = (options.apps || []).filter((app) => app && app.id);
    const platforms = options.platforms || DEFAULT_PLATFORMS();
    const sections = (options.sections || DEFAULT_SECTIONS()).filter((section) => apps.some((app) => (app.surface || 'portal_tab') === section.id));
    const readOnly = options.readOnly === true;
    const restrictable = options.restrictable === true;
    let value = { ...(options.value || {}) };
    const ALL = '__all';
    const showAll = sections.length > 1 && apps.length <= (options.allLimit || 60);
    let active = showAll ? ALL : sections[0]?.id || '';
    let query = '';

    const above = (appId) => {
      const from = options.inherited?.(appId) || {};
      return { visible:plain(from.visible), options:plain(from.options), sources:from.sources || [] };
    };
    const mine = (appId) => plain(value[appId]);
    const exists = (app, platformId) => (app.devices || platforms.map((platform) => platform.id)).includes(platformId);
    const restricted = (appId) => mine(appId).restricted === true;
    const ownDevice = (appId, platformId) => { const own = plain(mine(appId).visible)[platformId]; return typeof own === 'boolean' ? own : null; };
    const ownOption = (appId, key) => { const own = plain(mine(appId).options)[key]; return typeof own === 'boolean' ? own : null; };
    const shown = (appId, platformId) => {
      if (restricted(appId)) return false;
      const own = ownDevice(appId, platformId);
      return own == null ? above(appId).visible[platformId] === true : own;
    };
    const optionOn = (appId, key) => { const own = ownOption(appId, key); return own == null ? above(appId).options[key] === true : own; };
    const overridden = (appId) => compact(value[appId]) != null;
    const overrideCount = () => apps.filter((app) => overridden(app.id)).length;
    const deviceLabel = (platformId) => platforms.find((platform) => platform.id === platformId)?.label || platformId;

    container.innerHTML = `<div class="pp pp-apps" data-settings-autosave="off">
      <div class="pp-apps-bar">
        ${sections.length > 1 ? `<div class="pp-seg" role="tablist" aria-label="${esc(t('app_sections', 'Kind of app'))}">${showAll ? `<button type="button" role="tab" data-apps-section="${ALL}" aria-selected="${active === ALL}">${esc(t('all', 'All'))}</button>` : ''}${sections.map((section) => `<button type="button" role="tab" data-apps-section="${esc(section.id)}" aria-selected="${section.id === active}"><i class="fas ${esc(section.icon || 'fa-table-columns')}" aria-hidden="true"></i>${esc(section.label)}<span class="pp-seg-count" data-apps-section-count="${esc(section.id)}"></span></button>`).join('')}</div>` : ''}
        <label class="pp-search"><i class="fas ${kit.ICONS.search}" aria-hidden="true"></i><input type="search" data-apps-search placeholder="${esc(t('search_apps', 'Search apps'))}" aria-label="${esc(t('search_apps', 'Search apps'))}" autocomplete="off" spellcheck="false"></label>
        <div class="pp-apps-legend" aria-hidden="true">${platforms.map((platform) => `<span><i class="fas ${esc(platform.icon)}"></i>${esc(platform.label)}</span>`).join('')}</div>
      </div>
      <div class="pp-apps-grid" role="group" aria-label="${esc(t('app_experience', 'App experience'))}"></div>
    </div>`;
    const root = container.firstElementChild;
    const gridEl = root.querySelector('.pp-apps-grid');

    function inheritedText(app){
      const from = above(app.id);
      const on = (app.devices || []).filter((device) => from.visible[device] === true).map(deviceLabel);
      const where = on.length ? t('inherits_shown_on', 'Inherited: shown on {devices}', { devices:on.join(', ') }) : t('inherits_hidden', 'Inherited: hidden');
      return `${where}${from.sources.length ? ` (${from.sources.join(', ')})` : ''}`;
    }

    function tileHtml(app){
      const isOverridden = overridden(app.id);
      const isRestricted = restricted(app.id);
      const anyShown = platforms.some((platform) => exists(app, platform.id) && shown(app.id, platform.id));
      const inherited = inheritedText(app);
      const cells = platforms.map((platform) => {
        if (!exists(app, platform.id)) return `<span class="pp-app-cell absent" role="img" aria-label="${esc(t('not_on_platform', 'Not available on {platform}', { platform:platform.label }))}"${tip(t('not_on_platform', 'Not available on {platform}', { platform:platform.label }))}><i class="fas ${esc(platform.icon)}" aria-hidden="true"></i></span>`;
        const on = shown(app.id, platform.id);
        const label = `${platform.label}: ${on ? t('shown', 'shown') : t('hidden', 'hidden')}`;
        return `<button type="button" class="pp-app-cell" data-apps-cell="${esc(platform.id)}" aria-pressed="${on}" aria-label="${esc(`${app.title}, ${label}`)}"${tip(`${label} • ${inherited}`)} ${readOnly || isRestricted ? 'disabled' : ''}><i class="fas ${esc(platform.icon)}" aria-hidden="true"></i></button>`;
      }).join('');
      const optionRows = (app.options || []).map((option) => {
        const on = optionOn(app.id, option.key);
        const own = ownOption(app.id, option.key) != null;
        const from = above(app.id).options[option.key] === true;
        return `<div class="pp-app-option${own ? ' overridden' : ''}" data-apps-option-row="${esc(option.key)}"><span class="pp-app-option-label"${tip([option.description, own ? (from ? t('inherits_on', 'Inherited: on') : t('inherits_off', 'Inherited: off')) : ''].filter(Boolean).join(' • '))}>${esc(option.label)}</span><button type="button" class="pp-app-switch" role="switch" data-apps-option="${esc(option.key)}" aria-checked="${on}" aria-label="${esc(`${app.title}: ${option.label}`)}" ${readOnly || isRestricted ? 'disabled' : ''}></button></div>`;
      }).join('');
      const restrictButton = restrictable ? `<button type="button" class="pp-icon-btn pp-app-restrict" data-apps-restrict aria-pressed="${isRestricted}" aria-label="${esc(t('restrict_app', 'Restrict: hidden everywhere and refused by the server'))}"${tip(t('restrict_app', 'Restrict: hidden everywhere and refused by the server'))} ${readOnly ? 'disabled' : ''}><i class="fas fa-lock" aria-hidden="true"></i></button>` : '';
      return `<div class="pp-app${isOverridden ? ' overridden' : ''}${isRestricted ? ' restricted' : ''}${anyShown ? '' : ' off'}" data-apps-id="${esc(app.id)}"><div class="pp-app-main"><i class="fas ${esc(app.icon || 'fa-table-cells-large')}" aria-hidden="true"></i><span class="pp-app-title"${tip([app.description, isOverridden ? inherited : ''].filter(Boolean).join(' • '))}>${esc(app.title)}</span><span class="pp-app-cells">${cells}</span>${restrictButton}<button type="button" class="pp-icon-btn pp-app-reset" data-apps-reset aria-label="${esc(t('reset_to_inherited', 'Back to inherited'))}"${tip(t('reset_to_inherited', 'Back to inherited'))} ${readOnly || !isOverridden ? 'disabled' : ''}><i class="fas ${kit.ICONS.inherited}" aria-hidden="true"></i></button></div>${optionRows}</div>`;
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
    /** Apply one change to this level's setting for an app; a value equal to the inherited one is dropped. */
    function change(appId, edit, focusSelector){
      if (readOnly) return;
      const setting = { ...mine(appId), visible:{ ...plain(mine(appId).visible) }, options:{ ...plain(mine(appId).options) } };
      if (edit.reset) { value = { ...value }; delete value[appId]; }
      else {
        if (edit.device) {
          const target = !shown(appId, edit.device);
          if (target === (above(appId).visible[edit.device] === true)) delete setting.visible[edit.device];
          else setting.visible[edit.device] = target;
        }
        if (edit.option) {
          const target = !optionOn(appId, edit.option);
          if (target === (above(appId).options[edit.option] === true)) delete setting.options[edit.option];
          else setting.options[edit.option] = target;
        }
        if (edit.restrict) {
          if (setting.restricted === true) delete setting.restricted;
          else setting.restricted = true;
        }
        const next = compact(setting);
        if (next) value = { ...value, [appId]: next };
        else { value = { ...value }; delete value[appId]; }
      }
      const tile = gridEl.querySelector(`[data-apps-id="${CSS.escape(appId)}"]`);
      const app = apps.find((entry) => entry.id === appId);
      if (tile && app) {
        tile.outerHTML = tileHtml(app);
        const fresh = gridEl.querySelector(`[data-apps-id="${CSS.escape(appId)}"]`);
        (fresh?.querySelector(focusSelector) || fresh?.querySelector('[data-apps-cell]'))?.focus({ preventScroll:true });
      }
      renderCounts();
      options.onChange?.({ ...value }, appId);
    }
    gridEl.addEventListener('click', (event) => {
      const tile = event.target.closest('[data-apps-id]');
      if (!tile) return;
      const appId = tile.dataset.appsId;
      const reset = event.target.closest('[data-apps-reset]');
      if (reset && !reset.disabled) { change(appId, { reset:true }, '[data-apps-cell]'); return; }
      const restrict = event.target.closest('[data-apps-restrict]');
      if (restrict && !restrict.disabled) { change(appId, { restrict:true }, '[data-apps-restrict]'); return; }
      const option = event.target.closest('[data-apps-option]');
      if (option && !option.disabled) { change(appId, { option:option.dataset.appsOption }, `[data-apps-option="${CSS.escape(option.dataset.appsOption)}"]`); return; }
      const cell = event.target.closest('[data-apps-cell]');
      if (cell && !cell.disabled) change(appId, { device:cell.dataset.appsCell }, `[data-apps-cell="${CSS.escape(cell.dataset.appsCell)}"]`);
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

  People.appGrid = { mount, ensureStyles, compact };
})();
