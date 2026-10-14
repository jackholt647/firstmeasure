/* public/libraries/apps/people/people-settings.js
 *
 * The People settings category: Users, Groups, Departments and outside
 * companies as four sub-pages of one category.
 *
 * Settings declares the category once (the `people` entry of settingsSections
 * in settings/company.js) and renders an empty pane, #csPanePeople. This file
 * fills that pane whenever it exists and is active, so the Settings shell needs
 * no other knowledge of People. Sub-pages use the shared bubble tabs
 * (FirstMateSettingsPages.subTabs), which the shell hoists to the top right.
 *
 * Adding a sub-page: declare it in VIEWS and register its mount from its own
 * file with FirstMatePeople.views.register(id, mount) (the same thing as
 * FirstMatePeople.settings.registerView; `views` exists before this file
 * loads). mount(host, context) receives context = { entity, filter, onEntity(key),
 * go(viewId, entity, filter) } and returns { destroy(), refresh() }. A declared view
 * with nothing registered shows the "coming next" state.
 *
 *   FirstMatePeople.settings.views()                the declared sub-pages
 *   FirstMatePeople.settings.registerView(id, mount) fill a sub-page from another file
 *   FirstMatePeople.settings.mount(pane, options)    mount by hand (tests, embedding)
 *
 * Route: ?sub=people&settingsView=<home|users|groups|departments|subcontractors>
 * and settingsEntity=<user:id|role:id|group:id|department:id|company:id> while a modal is open.
 */
(function(){
  'use strict';
  const People = window.FirstMatePeople = window.FirstMatePeople || {};
  if (People.settings) return;
  const kit = People.kit;
  const { esc, t, term } = kit;
  const PANE_ID = 'csPanePeople';
  const mounts = new Map();

  /* Groups and outside companies are named by the organization, never by us. */
  const groupsLabel = () => t('groups', 'Groups');
  const companiesLabel = () => People.data?.state?.loaded ? People.data.state.groupLabels.connectionPlural : term('workforce.organization_connection_plural', t('subcontractors', 'Subcontractors'));
  const departmentsLabel = () => (People.data?.state?.loaded && People.data.state.groupLabels.departmentPlural) || t('departments', 'Departments');
  const VIEWS = [
    { id:'home', icon:'fa-house', label:() => t('overview', 'Overview') },
    { id:'users', icon:'fa-users', label:() => t('users', 'Users'), mount:(host, context) => People.usersPage.mount(host, context) },
    { id:'groups', icon:'fa-user-group', label:groupsLabel, legacy:{ sub:'crews', settingsView:'groups' } },
    { id:'departments', icon:'fa-sitemap', label:departmentsLabel, legacy:{ sub:'users', settingsView:'departments' } },
    { id:'subcontractors', icon:'fa-building', label:companiesLabel, legacy:{ sub:'crews', settingsView:'connections' } }
  ];
  const viewFor = (id) => VIEWS.find((view) => view.id === id) || VIEWS[0];

  function ensureStyles(){
    if (document.getElementById('pp_settings_css')) return;
    const style = document.createElement('style');
    style.id = 'pp_settings_css';
    style.textContent = `
      .pp-people{min-width:0}
      .pp-people>.fm-settings-subtabs{margin-bottom:14px}
      .pp-next{display:grid;place-content:center;justify-items:center;gap:12px;min-height:min(460px,60vh);text-align:center}
      .pp-next>i{display:grid;place-items:center;width:56px;height:56px;border-radius:16px;background:var(--pp-soft);border:1px solid var(--pp-line);color:var(--pp-faint);font-size:21px}
      .pp-next>h2{margin:0;color:var(--pp-text);font-size:18px;font-weight:700}
      .pp-next>.pp-btn{margin-top:6px}
    `;
    document.head.appendChild(style);
  }
  const readRoute = () => {
    try {
      const route = window.Portal?.navigation?.read?.() || {};
      const params = new URLSearchParams(window.location.search || '');
      return { sub:String(route.sub || params.get('sub') || ''), view:String(route.settingsView || ''), entity:String(route.settingsEntity || '') };
    } catch (_) { return { sub:'', view:'', entity:'' }; }
  };
  const writeRoute = (patch, history = 'replace') => {
    try {
      if (window.Portal?.navigation?.applying) return;
      window.Portal?.navigation?.write?.({ tab:'company_settings', sub:'people', ...patch }, { history, source:'people-settings', ownedKeys:['sub', 'settingsView', 'settingsEntity'] });
    } catch (_) {}
  };

  function mount(pane, options = {}){
    ensureStyles();
    const routed = options.route !== false;
    const route = routed ? readRoute() : { sub:'', view:'', entity:'' };
    let active = viewFor(options.view || (route.sub === 'people' ? route.view : '')).id;
    let controller = null;
    let destroyed = false;
    let pendingEntity = options.entity || (route.sub === 'people' ? route.entity : '');
    const tabsHtml = () => window.FirstMateSettingsPages?.subTabs?.({ id:'people', active, ariaLabel:t('people', 'People'), items:VIEWS.map((view) => ({ id:view.id, label:view.label(), icon:`fas ${view.icon}` })) }) || '';
    pane.innerHTML = `<div class="pp pp-people" data-settings-autosave="off"><div data-people-tabs>${tabsHtml()}</div><div data-people-view></div></div>`;
    const root = pane.firstElementChild;
    const host = root.querySelector('[data-people-view]');
    const tabsHost = root.querySelector('[data-people-tabs]');
    tabsHost.style.display = 'contents';

    function comingNext(view){
      host.innerHTML = `<div class="pp-next"><i class="fas ${esc(view.icon)}" aria-hidden="true"></i><h2>${esc(view.label())}</h2>${kit.pill({ label:t('coming_next', 'Coming next'), tone:'role' })}${view.legacy && window.Portal?.navigation?.navigate ? `<button type="button" class="pp-btn" data-people-legacy><i class="fas fa-arrow-up-right-from-square" aria-hidden="true"></i>${esc(t('open_current', 'Open the current page'))}</button>` : ''}</div>`;
      host.querySelector('[data-people-legacy]')?.addEventListener('click', () => {
        window.Portal.navigation.navigate({ tab:'company_settings', sub:view.legacy.sub, settingsView:view.legacy.settingsView, settingsEntity:'' }, { source:'people-settings', ownedKeys:['tab', 'sub', 'settingsView', 'settingsEntity'] });
      });
    }
    function show(id, config = {}){
      const view = viewFor(id);
      active = view.id;
      try { controller?.destroy?.(); } catch (_) {}
      controller = null;
      People.hoverCard?.hide();
      host.replaceChildren();
      tabsHost.innerHTML = tabsHtml();
      const mountView = People.views.get(view.id) || view.mount || mounts.get(view.id);
      if (!mountView) comingNext(view);
      else {
        try {
          controller = mountView(host, {
            entity:config.entity || '',
            filter:config.filter || '',
            go:(viewId, entity, filter) => show(viewId, { entity:entity || '', filter:filter || '' }),
            onEntity:(key) => { if (routed && !destroyed) writeRoute({ settingsView:active, settingsEntity:key || '' }, 'replace'); }
          }) || null;
        } catch (error) {
          host.innerHTML = `<div class="pp-state" role="alert"><i class="fas fa-triangle-exclamation" aria-hidden="true"></i><strong>${esc(error?.message || t('load_failed', 'Could not load'))}</strong></div>`;
        }
      }
      if (routed && config.write !== false) writeRoute({ settingsView:active, settingsEntity:config.entity || '' }, config.history || 'push');
    }
    const unbindTabs = window.FirstMateSettingsPages?.bindSubTabs?.(root, 'people', (value) => { if (value !== active) show(value); }) || (() => {});
    /* The names of groups and outside companies arrive with the data; relabel the tabs when they do. */
    const unsubscribe = People.data?.subscribe?.((state, change) => { if (change?.type === 'load' && !destroyed) tabsHost.innerHTML = tabsHtml(); }) || (() => {});
    const onPop = () => window.setTimeout(() => {
      if (destroyed || !pane.isConnected || !pane.classList.contains('active')) return;
      const next = readRoute();
      if (next.sub === 'people' && viewFor(next.view).id !== active) show(next.view, { write:false });
    }, 0);
    if (routed) window.addEventListener('popstate', onPop);
    show(active, { entity:pendingEntity, write:routed && route.sub === 'people', history:'replace' });
    pendingEntity = '';

    return {
      el:root,
      view:() => active,
      show,
      refresh(){ controller?.refresh?.(); },
      destroy(){
        destroyed = true;
        window.removeEventListener('popstate', onPop);
        unbindTabs();
        unsubscribe();
        try { controller?.destroy?.(); } catch (_) {}
        People.hoverCard?.hide();
        if (pane.isConnected) pane.replaceChildren();
      }
    };
  }

  /* Self-mounting: follow the pane the Settings shell renders for the category. */
  let bound = null;
  function bind(pane){
    let instance = null;
    let wasActive = false;
    const sync = () => {
      const isActive = pane.classList.contains('active');
      if (isActive && !instance) instance = mount(pane);
      else if (isActive && !wasActive) {
        /* Coming back through the sidebar lands where the route says: the overview unless a sub-page is routed. */
        const next = readRoute();
        if (next.sub === 'people' && viewFor(next.view).id !== instance.view()) instance.show(next.view, { write:false, entity:next.entity });
        else instance.refresh();
      }
      else if (!isActive && wasActive) People.hoverCard?.hide();
      wasActive = isActive;
    };
    const observer = new MutationObserver(sync);
    observer.observe(pane, { attributes:true, attributeFilter:['class'] });
    sync();
    return { pane, destroy(){ observer.disconnect(); try { instance?.destroy(); } catch (_) {} } };
  }
  let queued = false;
  function check(){
    queued = false;
    const pane = document.getElementById(PANE_ID);
    if (bound && bound.pane !== pane) { bound.destroy(); bound = null; }
    if (pane && !bound) bound = bind(pane);
  }
  function watch(){
    new MutationObserver(() => { if (!queued) { queued = true; queueMicrotask(check); } }).observe(document.documentElement, { childList:true, subtree:true });
    check();
  }
  if (document.body) watch(); else document.addEventListener('DOMContentLoaded', watch, { once:true });

  People.settings = {
    mount,
    views:() => VIEWS.map((view) => ({ id:view.id, label:view.label(), icon:view.icon, built:!!(view.mount || mounts.get(view.id)) })),
    registerView(id, mountView){ People.views.register(id, mountView); mounts.set(String(id), mountView); if (bound) { const pane = bound.pane; bound.destroy(); bound = null; if (pane.isConnected) bound = bind(pane); } }
  };
})();
