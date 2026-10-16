/* public/libraries/apps/crm/app.js
 * The CRM tab (docs/architecture/crm.md, "The CRM app"): saved views of leads, contacts,
 * follow-ups and appointments as lists, boards and an agenda; filters in the one condition
 * contract; the lead drawer; worklists; bulk actions; the funnel; duplicates; sources and
 * CRM settings. It writes nothing of its own: every action goes through an existing writer.
 */
(function(){
  'use strict';
  const runtime = window.FirstMateEmbeddableApps;
  if (!runtime?.registerApp) return;
  const SCRIPT_SRC = document.currentScript?.src || '';

  // ---- Small helpers ------------------------------------------------------------
  const text = (v) => String(v ?? '').trim();
  const arr = (v) => Array.isArray(v) ? v : [];
  const obj = (v) => v && typeof v === 'object' && !Array.isArray(v) ? v : {};
  const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' }[c]));
  // Catalog text for a key, with {name} placeholders filled from values.
  const L = (key, fallback, values) => {
    const message = globalThis.PlatformLanguage?.text?.('crm', key, fallback, values) ?? fallback;
    return values ? String(message).replace(/\{(\w+)\}/g, (match, name) => values[name] ?? match) : message;
  };
  const term = (key, fallback) => (key && globalThis.PlatformTerminology?.get?.(key, fallback)) || fallback;
  const api = () => window.PlatformAPI?.crm;
  const uid = () => (crypto.randomUUID ? crypto.randomUUID() : String(Date.now()) + Math.random().toString(16).slice(2));
  const money = (cents) => Number.isFinite(Number(cents)) && Number(cents) ? (Number(cents) / 100).toLocaleString(undefined, { style:'currency', currency:'USD', maximumFractionDigits:0 }) : '';
  const initials = (name) => text(name).split(/\s+/).filter(Boolean).slice(0, 2).map((p) => p[0]).join('').toUpperCase() || '?';
  const DAY = 86400000;
  /** A time relative to now, by calendar day: "12 min ago", "Today 3:00 PM", "Tomorrow 9:30 AM", "3 days ago". */
  function when(value){
    const t = Date.parse(text(value)); if (!Number.isFinite(t)) return '';
    const now = Date.now(), mins = Math.round((t - now) / 60000);
    if (Math.abs(mins) < 1) return L('just_now', 'Just now');
    if (Math.abs(mins) < 60) return mins > 0 ? L('in_minutes', 'in {n} min', { n: mins }) : L('minutes_ago', '{n} min ago', { n: -mins });
    const dayOf = (ms) => { const d = new Date(ms); return Math.round(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()) / DAY); };
    const days = dayOf(t) - dayOf(now), at = new Date(t).toLocaleTimeString(undefined, { hour:'numeric', minute:'2-digit' });
    if (days === 0) return t > now ? L('today_at', 'Today {time}', { time: at }) : L('hours_ago', '{n} h ago', { n: Math.max(1, Math.round((now - t) / 3_600_000)) });
    if (days === 1) return L('tomorrow_at', 'Tomorrow {time}', { time: at });
    if (days === -1) return L('yesterday', 'Yesterday');
    if (days > 1 && days < 7) return `${new Date(t).toLocaleDateString(undefined, { weekday:'short' })} ${at}`;
    if (days < 0 && days > -7) return L('days_ago', '{n} days ago', { n: -days });
    return new Date(t).toLocaleDateString(undefined, { month:'short', day:'numeric', ...(new Date(t).getFullYear() !== new Date().getFullYear() ? { year:'numeric' } : {}) });
  }
  const fullDate = (value) => { const t = Date.parse(text(value)); return Number.isFinite(t) ? new Date(t).toLocaleString(undefined, { dateStyle:'medium', timeStyle:'short' }) : ''; };
  const timeOf = (value) => { const t = Date.parse(text(value)); return Number.isFinite(t) ? new Date(t).toLocaleTimeString(undefined, { hour:'numeric', minute:'2-digit' }) : ''; };
  const dayKey = (value) => { const d = new Date(Date.parse(text(value))); return Number.isFinite(d.getTime()) ? `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}` : ''; };
  const isoDay = (date) => `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
  function clone(v){ return v == null ? v : JSON.parse(JSON.stringify(v)); }
  function same(a, b){ return JSON.stringify(a) === JSON.stringify(b); }

  const OPERATORS = {
    text: [['contains', 'contains'], ['equals', 'is'], ['not_contains', 'does not contain'], ['is_present', 'has a value'], ['is_missing', 'is empty']],
    number: [['greater_or_equal', 'is at least'], ['less_or_equal', 'is at most'], ['equals', 'is'], ['greater_than', 'is more than'], ['less_than', 'is less than'], ['is_present', 'has a value'], ['is_missing', 'is empty']],
    date: [['after', 'is after'], ['before', 'is before'], ['is_present', 'has a value'], ['is_missing', 'is empty']],
    select: [['in', 'is any of'], ['not_in', 'is none of'], ['is_present', 'has a value'], ['is_missing', 'is empty']],
    multi: [['contains', 'includes'], ['not_contains', 'does not include'], ['is_present', 'has any'], ['is_missing', 'has none']],
    user: [['contains', 'includes'], ['in', 'is any of'], ['not_contains', 'does not include'], ['is_present', 'has someone'], ['is_missing', 'has no one']],
    bool: [['equals', 'is']]
  };
  const opsFor = (type) => OPERATORS[type === 'money' ? 'number' : type === 'contact' ? 'text' : type] || OPERATORS.text;
  const RELATIVE = [['now-1d', 'the last day'], ['now-7d', 'the last 7 days'], ['now-30d', 'the last 30 days'], ['now-90d', 'the last 90 days'], ['now', 'now'], ['now+1d', 'the next day'], ['now+7d', 'the next 7 days'], ['now+30d', 'the next 30 days']];
  const ME_VALUES = [['$me', 'me']];

  // ---- The app ------------------------------------------------------------------
  function mount(context = {}){
    const root = context.roots?.main || context.root;
    if (!root) return {};
    const orgId = context.orgId || window.__APP?.userOrgId || window.__APP?.orgId;
    const navigation = window.Portal?.navigation;
    ensureStyles();
    const host = document.createElement('div');
    host.className = 'crm';
    host.setAttribute('data-crm-app', '');
    root.appendChild(host);

    const state = {
      meta: null, views: [], viewId: '', saved: null, draft: null, panel: 'view',
      result: null, offset: 0, loading: false, error: '', search: '',
      selected: new Set(), openRow: '', drawer: null, worklist: null, pop: null, sequence: 0, counts: {}, report: null, reportInput: null
    };
    const viewById = (id) => state.views.find((v) => v.id === id) || null;
    const collectionInfo = (id) => arr(state.meta?.collections).find((c) => c.id === id) || { id, label: id };
    const fields = () => arr(state.result?.fields);
    const fieldByKey = (key) => fields().find((f) => f.key === key) || null;
    const feature = (key) => state.meta?.features?.[key] === true;
    const dirty = () => state.saved && state.draft && !same(normalizedDefinition(state.saved.definition), normalizedDefinition(state.draft.definition));
    const toast = (message, ok = true) => {
      const ui = window.Portal?.ui || window.PlatformUI;
      if (ui?.showToast) { ui.showToast(ok ? L('done', 'Done') : L('not_done', 'Not done'), message, ok); return; }
      const el = document.createElement('div'); el.className = 'crm-toast'; el.textContent = message; host.appendChild(el); setTimeout(() => el.remove(), 2600);
    };
    const confirmDialog = async (message, options = {}) => (window.PlatformUI?.confirm ? window.PlatformUI.confirm(message, options) : window.confirm(message));
    const promptDialog = async (message, value = '', options = {}) => (window.PlatformUI?.prompt ? window.PlatformUI.prompt(message, value, options) : window.prompt(message, value));

    function normalizedDefinition(def = {}){
      return { filter: def.filter || { match:'all', rules:[] }, sort: arr(def.sort), group_by: text(def.group_by), layout: text(def.layout) || 'list', columns: arr(def.columns) };
    }

    // ---- Loading --------------------------------------------------------------
    async function boot(){
      host.innerHTML = `<div class="crm-loading"></div>`;
      try {
        const [meta, views] = await Promise.all([api().meta(orgId), api().views(orgId)]);
        state.meta = meta; state.views = arr(views.views);
      } catch (error) {
        // The tab belongs to the CRM app (apps.crm); its views are the crm.views feature, which a company can turn off.
        const off = error?.status === 403 && JSON.stringify(error?.data || {}).includes('capability_denied');
        host.innerHTML = `<div class="crm-empty" style="grid-column:1/-1"><h3>${esc(off ? L('views_off', 'CRM views are turned off') : L('load_failed', 'The CRM could not be loaded'))}</h3><p>${esc(off ? L('views_off_hint', 'Someone who manages company settings can turn them on under Settings, in the CRM app’s features.') : error?.message || '')}</p><button type="button" class="crm-btn" data-retry>${esc(L('try_again', 'Try again'))}</button></div>`;
        host.querySelector('[data-retry]')?.addEventListener('click', boot);
        return;
      }
      const route = navigation?.read?.() || {};
      const initial = viewById(text(route.crmView)) || state.views.find((v) => v.pinned) || state.views[0];
      if (['reports', 'duplicates', 'sources', 'settings'].includes(text(route.crmPanel))) { state.panel = text(route.crmPanel); renderShell(); renderPanel(); }
      else if (initial) openView(initial.id, { history:false });
      else { state.panel = 'view'; state.saved = null; state.draft = blankDraft('opportunities'); renderShell(); query(); }
      loadCounts();
    }

    function blankDraft(collection){
      return { id:'', name: L('untitled_view', 'New view'), collection, definition: { filter:{ match:'all', rules:[] }, sort:[], group_by:'', layout:'list', columns:[] } };
    }

    async function loadCounts(){
      const pinned = state.views.filter((v) => v.pinned).slice(0, 20);
      await Promise.all(pinned.map(async (view) => {
        try { const r = await api().query(orgId, { view_id: view.id, limit: 1, definition:{ group_by:'' } }); state.counts[view.id] = r.total; } catch { /* a count that fails stays blank */ }
      }));
      renderRail();
    }

    function openView(id, options = {}){
      const view = viewById(id); if (!view) return;
      state.panel = 'view'; state.saved = clone(view); state.draft = clone(view); state.offset = 0; state.selected.clear(); state.search = ''; closeDrawer(false);
      if (options.history !== false && !navigation?.applying) navigation?.push?.({ tab:'crm', crmView:id, crmPanel:null }, { source:'crm-view', ownedKeys:['crmView', 'crmPanel'] });
      renderShell(); query();
      host.classList.remove('rail-open');
    }

    function openPanel(panel){
      state.panel = panel; closeDrawer(false); state.selected.clear();
      if (!navigation?.applying) navigation?.push?.({ tab:'crm', crmPanel:panel, crmView:null }, { source:'crm-panel', ownedKeys:['crmView', 'crmPanel'] });
      renderShell(); renderPanel(); host.classList.remove('rail-open');
    }

    async function query(options = {}){
      const draft = state.draft; if (!draft) return;
      const ticket = ++state.sequence;
      state.loading = true; renderLoading();
      const definition = normalizedDefinition(draft.definition);
      const layout = definition.layout;
      try {
        const result = await api().query(orgId, {
          collection: draft.collection, definition: { ...definition, ...(layout === 'board' && !definition.group_by ? { group_by: defaultGroup(draft.collection) } : {}) },
          search: state.search, offset: options.append ? state.offset : 0, limit: layout === 'list' ? 100 : 500
        });
        if (ticket !== state.sequence) return;
        if (options.append && state.result) { result.rows = [...state.result.rows, ...result.rows]; }
        const fieldsChanged = state.result?.fields?.length !== result.fields?.length || state.resultCollection !== draft.collection;
        state.result = result; state.resultCollection = draft.collection; state.error = '';
        // Filter chips name fields by label, which arrive with the first result of a collection.
        if (fieldsChanged) renderFilters();
        if (draft.id && !state.search && same(normalizedDefinition(state.saved?.definition), definition)) { state.counts[draft.id] = result.total; renderRail(); }
      } catch (error) {
        if (ticket !== state.sequence) return;
        state.error = error?.message || L('query_failed', 'This view could not be loaded.');
      } finally {
        if (ticket === state.sequence) { state.loading = false; renderView(); }
      }
    }
    const defaultGroup = (collection) => collection === 'opportunities' ? 'stage_id' : collection === 'contacts' ? 'state' : collection === 'follow_ups' ? 'list_key' : 'type';

    function changeDraft(mutate, options = {}){
      if (!state.draft) return;
      const next = clone(state.draft); mutate(next.definition, next);
      state.draft = next; state.offset = 0; state.selected.clear();
      renderHeader(); renderFilters(); renderSavebar();
      if (options.query !== false) query(); else renderView();
    }

    // ---- Shell ---------------------------------------------------------------
    function renderShell(){
      if (!host.querySelector('.crm-rail')) {
        host.innerHTML = `
          <aside class="crm-rail" aria-label="${esc(L('crm_navigation', 'CRM views'))}"></aside>
          <section class="crm-main">
            <header class="crm-head"></header>
            <div class="crm-filterbar" role="toolbar" aria-label="${esc(L('filters', 'Filters'))}"></div>
            <div class="crm-savebar" hidden></div>
            <div class="crm-content" tabindex="-1"></div>
            <div class="crm-bulkbar" hidden></div>
          </section>
          <aside class="crm-drawer" hidden aria-label="${esc(L('record', 'Record'))}"></aside>
          <div class="crm-worklist" hidden></div>`;
        bindShell();
      }
      renderRail(); renderHeader(); renderFilters(); renderSavebar();
    }

    function renderRail(){
      const rail = host.querySelector('.crm-rail'); if (!rail) return;
      const pinned = state.views.filter((v) => v.pinned);
      const others = state.views.filter((v) => !v.pinned && !v.hidden);
      const viewItem = (v) => `<button type="button" class="crm-rail-item" data-open-view="${esc(v.id)}" aria-current="${state.panel === 'view' && state.draft?.id === v.id}">
          <i class="fas ${esc(v.definition?.icon || collectionInfo(v.collection).icon || 'fa-list')}" aria-hidden="true"></i><span class="crm-rail-name">${esc(v.name)}</span><span class="crm-rail-count">${state.counts[v.id] ?? ''}</span></button>`;
      const panelItem = (panel, icon, label, visible = true) => visible ? `<button type="button" class="crm-rail-item" data-open-panel="${panel}" aria-current="${state.panel === panel}"><i class="fas ${icon}" aria-hidden="true"></i><span class="crm-rail-name">${esc(label)}</span></button>` : '';
      rail.innerHTML = `
        <div class="crm-rail-head"><h1>${esc(term('crm.portal_tab', 'CRM'))}</h1></div>
        <div class="crm-rail-scroll">
          <div class="crm-rail-section"><span>${esc(term('crm.views', 'Views'))}</span></div>
          ${pinned.map(viewItem).join('') || `<p class="crm-dim" style="padding:4px 10px">${esc(L('no_pinned', 'Pin a view to keep it here.'))}</p>`}
          <button type="button" class="crm-rail-item crm-rail-add" data-new-view><i class="fas fa-plus" aria-hidden="true"></i><span class="crm-rail-name">${esc(L('new_view', 'New view'))}</span></button>
          ${others.length ? `<div class="crm-rail-section"><span>${esc(L('more_views', 'More views'))}</span></div>${others.map(viewItem).join('')}` : ''}
          <div class="crm-rail-section"><span>${esc(L('insights', 'Insights'))}</span></div>
          ${panelItem('reports', 'fa-chart-bar', term('crm.funnel', 'Funnel'), feature('funnel'))}
          ${panelItem('duplicates', 'fa-clone', L('duplicates', 'Duplicates'))}
          ${panelItem('sources', 'fa-sitemap', term('crm.sources', 'Sources'), feature('sources'))}
          ${panelItem('settings', 'fa-sliders', L('crm_settings', 'CRM settings'), state.meta?.can_share_views === true)}
        </div>`;
    }

    function renderHeader(){
      const head = host.querySelector('.crm-head'); if (!head) return;
      if (state.panel !== 'view') {
        const titles = { reports: term('crm.funnel', 'Funnel'), duplicates: L('duplicates', 'Duplicates'), sources: term('crm.sources', 'Sources'), settings: L('crm_settings', 'CRM settings') };
        head.innerHTML = `<div class="crm-title"><button type="button" class="crm-btn icon ghost crm-menu-toggle" data-rail-toggle aria-label="${esc(L('menu', 'Views'))}"><i class="fas fa-bars"></i></button><h2>${esc(titles[state.panel] || '')}</h2></div>`;
        return;
      }
      const draft = state.draft; if (!draft) return;
      const def = normalizedDefinition(draft.definition);
      const info = collectionInfo(draft.collection);
      const layouts = draft.collection === 'appointments' ? [['list', 'fa-list', L('list', 'List')], ['calendar', 'fa-calendar-day', L('agenda', 'Agenda')], ['board', 'fa-table-columns', L('board', 'Board')]] : [['list', 'fa-list', L('list', 'List')], ['board', 'fa-table-columns', L('board', 'Board')]];
      const total = state.result?.total;
      head.innerHTML = `
        <div class="crm-title">
          <button type="button" class="crm-btn icon ghost crm-menu-toggle" data-rail-toggle aria-label="${esc(L('menu', 'Views'))}"><i class="fas fa-bars"></i></button>
          <h2 title="${esc(draft.name)}">${esc(draft.name)}</h2>
          <span class="crm-count">${total == null ? '' : esc(countLabel(draft.collection, total))}</span>
        </div>
        <div class="crm-head-actions">
          <div class="crm-seg" role="group" aria-label="${esc(L('layout', 'Layout'))}">${layouts.map(([id, icon, label]) => `<button type="button" data-layout="${id}" aria-pressed="${def.layout === id}" title="${esc(label)}"><i class="fas ${icon}" aria-hidden="true"></i><span>${esc(label)}</span></button>`).join('')}</div>
          <button type="button" class="crm-btn" data-display><i class="fas fa-sliders" aria-hidden="true"></i>${esc(L('display', 'Display'))}</button>
          ${feature('worklists') ? `<button type="button" class="crm-btn primary" data-worklist ${total ? '' : 'disabled'}><i class="fas fa-play" aria-hidden="true"></i>${esc(term('crm.worklist', 'Work this list'))}</button>` : ''}
          <button type="button" class="crm-btn icon" data-view-menu aria-label="${esc(L('view_options', 'View options'))}"><i class="fas fa-ellipsis"></i></button>
        </div>`;
    }

    // ---- Filters -------------------------------------------------------------
    function ruleSummary(rule){
      const field = fieldByKey(rule.field);
      const label = field ? term(field.term, field.label) : rule.field;
      const op = opsFor(field?.type || 'text').find(([id]) => id === rule.operator)?.[1] || rule.operator;
      if (['is_present', 'is_missing'].includes(rule.operator)) return `<b>${esc(label)}</b> ${esc(op)}`;
      const values = arr(Array.isArray(rule.value) ? rule.value : [rule.value]).map((v) => displayValue(field, v));
      return `<b>${esc(label)}</b> ${esc(op)} <b>${esc(values.join(', '))}</b>`;
    }
    function displayValue(field, value){
      if (value === '$me') return L('me', 'me');
      if (value === '$my_branches') return L('my_branches', 'my branches');
      if (value === '$my_departments') return L('my_departments', 'my departments');
      const rel = RELATIVE.find(([v]) => v === value); if (rel) return rel[1];
      if (field?.type === 'bool') return String(value) === 'true' ? L('yes', 'Yes') : L('no', 'No');
      const opt = arr(field?.options).find((o) => o.value === String(value)); if (opt) return opt.label;
      if (field?.type === 'money') return money(Number(value) * 100) || String(value);
      return String(value);
    }
    function renderFilters(){
      const bar = host.querySelector('.crm-filterbar'); if (!bar) return;
      if (state.panel !== 'view' || !state.draft) { bar.innerHTML = ''; bar.hidden = true; return; }
      bar.hidden = false;
      const filter = normalizedDefinition(state.draft.definition).filter;
      const rules = arr(filter.rules);
      bar.innerHTML = `
        ${rules.length > 1 ? `<button type="button" class="crm-match" data-filter-match title="${esc(L('match_hint', 'Whether a row must match every condition or any one'))}">${esc(filter.match === 'any' ? L('match_any', 'Any of') : L('match_all', 'All of'))} <i class="fas fa-caret-down"></i></button>` : ''}
        ${rules.map((rule, i) => `<span class="crm-chip" data-edit-filter="${i}" role="button" tabindex="0"><span class="crm-chip-text">${rule.rules || rule.conditions ? esc(L('filter_group', '{n} conditions, {match}', { n: arr(rule.rules || rule.conditions).length, match: rule.match === 'any' ? L('any', 'any') : L('all', 'all') })) : ruleSummary(rule)}</span><button type="button" class="crm-chip-x" data-remove-filter="${i}" aria-label="${esc(L('remove_filter', 'Remove filter'))}"><i class="fas fa-xmark"></i></button></span>`).join('')}
        <button type="button" class="crm-chip add" data-add-filter><i class="fas fa-plus" aria-hidden="true"></i>${esc(L('filter', 'Filter'))}</button>
        <label class="crm-search"><i class="fas fa-magnifying-glass" aria-hidden="true"></i><input type="search" data-search value="${esc(state.search)}" placeholder="${esc(L('search_view', 'Search this view'))}" aria-label="${esc(L('search_view', 'Search this view'))}"></label>`;
    }

    function renderSavebar(){
      const bar = host.querySelector('.crm-savebar'); if (!bar) return;
      const view = state.saved;
      const show = state.panel === 'view' && (dirty() || (!state.draft?.id && arr(normalizedDefinition(state.draft?.definition).filter.rules).length));
      bar.hidden = !show; if (!show) return;
      const canSaveHere = view?.id && view.editable;
      bar.innerHTML = `<span>${esc(view?.id ? L('changed_view', 'You changed this view. The change is only yours until you save it.') : L('unsaved_view', 'This view is not saved yet.'))}</span>
        ${view?.id ? `<button type="button" class="crm-btn small ghost" data-discard>${esc(L('discard', 'Discard'))}</button>` : ''}
        <button type="button" class="crm-btn small" data-save-as>${esc(L('save_as_new', 'Save as new view'))}</button>
        ${canSaveHere ? `<button type="button" class="crm-btn small primary" data-save>${esc(view.visibility === 'private' ? L('save', 'Save') : L('save_for_everyone', 'Save for everyone'))}</button>` : ''}`;
    }

    function renderLoading(){
      const content = host.querySelector('.crm-content'); if (!content) return;
      if (!content.querySelector('.crm-loading')) content.insertAdjacentHTML('afterbegin', '<div class="crm-loading" role="progressbar" aria-label="Loading"></div>');
    }

    // ---- Rendering a view -------------------------------------------------------
    function renderView(){
      if (state.panel !== 'view') return;
      renderHeader();
      const content = host.querySelector('.crm-content'); if (!content) return;
      content.querySelector('.crm-loading')?.remove();
      if (state.error) { content.innerHTML = `<div class="crm-empty"><h3>${esc(L('query_failed_title', 'This view could not be loaded'))}</h3><p>${esc(state.error)}</p><button type="button" class="crm-btn" data-requery>${esc(L('try_again', 'Try again'))}</button></div>`; return; }
      const result = state.result; if (!result) { content.innerHTML = '<div class="crm-loading"></div>'; return; }
      const def = normalizedDefinition(state.draft.definition);
      if (!result.rows.length) {
        const filtered = arr(def.filter.rules).length || state.search;
        content.innerHTML = `<div class="crm-empty"><h3>${esc(filtered ? L('nothing_matches', 'Nothing matches') : L('nothing_here', 'Nothing here yet'))}</h3><p>${esc(filtered ? L('nothing_matches_hint', 'Try removing a filter or clearing the search.') : L('nothing_here_hint', 'New records show up here as they arrive.'))}</p></div>`;
        renderBulkbar(); return;
      }
      if (def.layout === 'board') content.innerHTML = boardHtml(result, def);
      else if (def.layout === 'calendar') content.innerHTML = agendaHtml(result);
      else content.innerHTML = listHtml(result, def);
      if (state.loading) renderLoading();
      renderBulkbar();
      if (def.layout === 'board') bindBoard(content);
    }

    function visibleColumns(def){
      const cols = arr(def.columns).filter((key) => fieldByKey(key));
      return cols.length ? cols : fields().filter((f) => f.column).map((f) => f.key);
    }
    /** "1 lead", "12 leads": the collection's own words, from the terminology catalog. */
    function countLabel(collection, n){
      const nouns = { opportunities: [['crm.lead', 'Lead'], ['crm.leads', 'Leads']], contacts: [['contacts.contact', 'Contact'], ['contacts.contacts', 'Contacts']], follow_ups: [['', L('follow_up', 'Follow-up')], ['crm.follow_ups', 'Follow-ups']], appointments: [['crm.appointment', 'Appointment'], ['crm.appointments', 'Appointments']] }[collection] || [['', ''], ['', '']];
      const [key, fallback] = nouns[n === 1 ? 0 : 1];
      return `${Number(n).toLocaleString()} ${term(key, fallback).toLowerCase()}`;
    }
    /** What a group with no value is called: leads with no scope are new leads. */
    function emptyGroupLabel(key){
      return ['stage_id', 'scope_template_id'].includes(key) ? term('crm.new_leads', 'New leads') : L('not_set', 'Not set');
    }
    function cellHtml(field, row){
      const value = row[field.key];
      if (value == null || value === '' || (Array.isArray(value) && !value.length)) return '<span class="crm-dim">—</span>';
      switch (field.type) {
        case 'money': return esc(money(value));
        case 'number': return esc(Number(value).toLocaleString());
        case 'bool': return value === true ? '<i class="fas fa-check" aria-label="Yes"></i>' : '<span class="crm-dim">—</span>';
        case 'date': {
          const late = field.key.includes('due') && Date.parse(value) < Date.now();
          return `<span title="${esc(fullDate(value))}" class="${late ? 'crm-due-late' : ''}">${esc(when(value))}</span>`;
        }
        case 'select': {
          const opt = arr(field.options).find((o) => o.value === String(value));
          return opt ? `<span class="crm-pill" style="${opt.color ? `color:${esc(opt.color)};background:${esc(opt.color)}14` : ''}"><span class="dot"></span>${esc(opt.label)}</span>` : esc(String(value).replace(/_/g, ' '));
        }
        case 'user': {
          const ids = Array.isArray(value) ? value : [value];
          return ids.slice(0, 2).map((id) => { const name = arr(field.options).find((o) => o.value === id)?.label || state.result?.labels?.[`user:${id}`] || id; return `<span class="crm-person"><span class="crm-avatar">${esc(initials(name))}</span>${esc(name)}</span>`; }).join(' ') + (ids.length > 2 ? ` <span class="crm-dim">+${ids.length - 2}</span>` : '');
        }
        case 'multi': return arr(value).slice(0, 3).map((v) => `<span class="crm-tag">${esc(arr(field.options).find((o) => o.value === v)?.label || v)}</span>`).join('') + (arr(value).length > 3 ? `<span class="crm-dim">+${arr(value).length - 3}</span>` : '');
        default: return esc(Array.isArray(value) ? value.join(', ') : value);
      }
    }
    function listHtml(result, def){
      const cols = visibleColumns(def).map(fieldByKey).filter(Boolean);
      const sort = def.sort[0];
      const head = `<tr><th class="crm-check"><input type="checkbox" data-select-all aria-label="${esc(L('select_all', 'Select all'))}" ${result.rows.length && result.rows.every((r) => state.selected.has(r.id)) ? 'checked' : ''}></th>${cols.map((f) => `<th class="${['number', 'money'].includes(f.type) ? 'crm-num' : ''}"><button type="button" data-sort-by="${esc(f.key)}">${esc(term(f.term, f.label))}${sort?.key === f.key ? `<i class="fas fa-arrow-${sort.dir === 'desc' ? 'down' : 'up'}" aria-hidden="true"></i>` : ''}</button></th>`).join('')}</tr>`;
      const row = (r) => `<tr data-row="${esc(r.id)}" aria-selected="${state.selected.has(r.id)}" class="${state.openRow === r.id ? 'crm-row-open' : ''}"><td class="crm-check"><input type="checkbox" data-select="${esc(r.id)}" aria-label="${esc(L('select', 'Select'))}" ${state.selected.has(r.id) ? 'checked' : ''}></td>${cols.map((f, i) => `<td data-label="${esc(term(f.term, f.label))}" class="${i === 0 ? 'crm-primary-cell' : ''} ${['number', 'money'].includes(f.type) ? 'crm-num' : ''}">${cellHtml(f, r)}${i === 0 && f.sub && text(r[f.sub]) && text(r[f.sub]) !== text(r[f.key]) ? `<div class="crm-cell-sub">${esc(r[f.sub])}</div>` : ''}</td>`).join('')}</tr>`;
      let body = '';
      if (def.group_by && arr(result.groups).length) {
        const groupField = fieldByKey(def.group_by);
        const value = (r) => { const v = r[def.group_by]; return Array.isArray(v) ? text(v[0]) : typeof v === 'boolean' ? String(v) : text(v); };
        for (const g of result.groups.filter((g) => g.count)) {
          const rows = result.rows.filter((r) => value(r) === g.value);
          if (!rows.length) continue;
          body += `<tr class="crm-group-row"><td colspan="${cols.length + 1}">${esc(g.value ? g.label : emptyGroupLabel(def.group_by))}<span class="crm-group-meta">${g.count}${g.value_cents ? ` · ${esc(money(g.value_cents))}` : ''}</span></td></tr>${rows.map(row).join('')}`;
        }
        void groupField;
      } else body = result.rows.map(row).join('');
      const more = result.total > result.rows.length ? `<div class="crm-more"><button type="button" class="crm-btn" data-load-more>${esc(L('load_more', 'Show more ({n} left)', { n: (result.total - result.rows.length).toLocaleString() }))}</button></div>` : '';
      return `<table class="crm-table"><thead>${head}</thead><tbody>${body}</tbody></table>${more}`;
    }

    function cardHtml(r, collection){
      const draggable = collection === 'opportunities';
      const title = collection === 'contacts' ? r.name : collection === 'follow_ups' || collection === 'appointments' ? (r.contact_name || r.title) : (r.contact_name || r.title);
      const sub = collection === 'opportunities' ? (r.title !== r.contact_name ? r.title : r.address) : collection === 'contacts' ? (r.phone || r.email) : (r.project_title || r.title);
      const meta = [];
      if (r.value_cents) meta.push(`<span><i class="fas fa-dollar-sign" aria-hidden="true"></i>${esc(money(r.value_cents).replace('$', ''))}</span>`);
      if (r.next_appointment_at) meta.push(`<span title="${esc(fullDate(r.next_appointment_at))}"><i class="far fa-calendar" aria-hidden="true"></i>${esc(when(r.next_appointment_at))}</span>`);
      if (r.due_at) meta.push(`<span class="${Date.parse(r.due_at) < Date.now() ? 'crm-due-late' : ''}"><i class="far fa-clock" aria-hidden="true"></i>${esc(when(r.due_at))}</span>`);
      if (r.start_at) meta.push(`<span><i class="far fa-clock" aria-hidden="true"></i>${esc(fullDate(r.start_at))}</span>`);
      if (r.age_days != null && collection === 'opportunities') meta.push(`<span title="${esc(L('age', 'Age'))}"><i class="fas fa-hourglass-half" aria-hidden="true"></i>${esc(L('days_short', '{n}d', { n: r.age_days }))}</span>`);
      return `<div class="crm-card" data-row="${esc(r.id)}" ${draggable ? 'draggable="true"' : ''} tabindex="0"><div class="crm-card-title">${esc(title || L('untitled', 'Untitled'))}</div>${sub ? `<div class="crm-card-sub">${esc(sub)}</div>` : ''}${meta.length ? `<div class="crm-card-meta">${meta.join('')}</div>` : ''}</div>`;
    }
    function boardHtml(result, def){
      const groupKey = def.group_by || defaultGroup(state.draft.collection);
      const value = (r) => { const v = r[groupKey]; return Array.isArray(v) ? text(v[0]) : typeof v === 'boolean' ? String(v) : text(v); };
      let groups = arr(result.groups);
      // A board of stages shows only the stages of the scopes its rows are in, plus the rows with no scope yet.
      if (groupKey === 'stage_id') {
        const scopes = new Set(result.rows.map((r) => text(r.scope_template_id)).filter(Boolean));
        groups = groups.filter((g) => !g.value || scopes.has(g.value.split(':')[0]));
        if (!groups.some((g) => !g.value) && result.rows.some((r) => !text(r.stage_id))) groups = [{ value:'', label:'', count:0, value_cents:0 }, ...groups];
      }
      const cols = groups.map((g) => {
        const rows = result.rows.filter((r) => value(r) === g.value);
        return `<section class="crm-col" data-col="${esc(g.value)}" aria-label="${esc(g.label)}"><header class="crm-col-head"><span class="dot" style="background:${esc(g.color || '#98a2b3')}"></span>${esc(g.value ? g.label : emptyGroupLabel(groupKey))}<span class="crm-col-count">${rows.length}</span>${g.value_cents ? `<span class="crm-col-value">${esc(money(g.value_cents))}</span>` : ''}</header><div class="crm-col-body">${rows.map((r) => cardHtml(r, state.draft.collection)).join('')}</div></section>`;
      }).join('');
      return `<div class="crm-board">${cols}</div>`;
    }
    function agendaHtml(result){
      const byDay = new Map();
      for (const r of result.rows) { const k = dayKey(r.start_at) || 'none'; byDay.set(k, [...(byDay.get(k) || []), r]); }
      return `<div class="crm-agenda">${[...byDay].map(([k, rows]) => `<div class="crm-agenda-day"><h4>${esc(k === 'none' ? L('no_date', 'No date') : new Date(`${k}T12:00:00`).toLocaleDateString(undefined, { weekday:'long', month:'long', day:'numeric' }))}</h4>${rows.map((r) => {
        const confirm = arr(fieldByKey('confirmation')?.options).find((o) => o.value === r.confirmation);
        return `<div class="crm-agenda-item" data-row="${esc(r.id)}" tabindex="0"><span class="crm-agenda-time">${esc(timeOf(r.start_at))}</span><span><b>${esc(r.contact_name || r.title)}</b><br><span class="crm-dim">${esc([r.title, r.address].filter(Boolean).join(' · '))}</span></span>${confirm ? `<span class="crm-pill" style="color:${esc(confirm.color || '#344054')};background:${esc(confirm.color || '#344054')}14"><span class="dot"></span>${esc(confirm.label)}</span>` : ''}</div>`;
      }).join('')}</div>`).join('')}</div>`;
    }

    // ---- Board drag and drop -------------------------------------------------------
    function bindBoard(content){
      let dragId = '';
      content.querySelectorAll('.crm-card[draggable="true"]').forEach((card) => {
        card.addEventListener('dragstart', (e) => { dragId = card.dataset.row; card.classList.add('dragging'); e.dataTransfer.effectAllowed = 'move'; e.dataTransfer.setData('text/plain', dragId); });
        card.addEventListener('dragend', () => { card.classList.remove('dragging'); content.querySelectorAll('.drop-target').forEach((c) => c.classList.remove('drop-target')); });
      });
      content.querySelectorAll('.crm-col').forEach((col) => {
        col.addEventListener('dragover', (e) => { if (!dragId) return; e.preventDefault(); col.classList.add('drop-target'); });
        col.addEventListener('dragleave', (e) => { if (!col.contains(e.relatedTarget)) col.classList.remove('drop-target'); });
        col.addEventListener('drop', (e) => { e.preventDefault(); col.classList.remove('drop-target'); const id = dragId; dragId = ''; if (id) void moveCard(id, col.dataset.col); });
      });
    }
    async function moveCard(rowId, groupValue){
      const row = arr(state.result?.rows).find((r) => r.id === rowId); if (!row) return;
      const def = normalizedDefinition(state.draft.definition), key = def.group_by || defaultGroup(state.draft.collection);
      if (text(row[key]) === text(groupValue)) return;
      try {
        if (key === 'stage_id') {
          const [templateId, stageId] = text(groupValue).split(':');
          if (!templateId) throw new Error(L('cannot_unscope', 'A lead cannot be moved back to having no scope.'));
          if (!row.plan_id || row.scope_template_id !== templateId) {
            const started = await window.PlatformAPI.scopes.startOnProject(orgId, row.project_id, templateId);
            const planId = text(started?.plan?.id);
            if (planId && stageId) await window.PlatformAPI.work.setManualStage(orgId, planId, stageId).catch(() => null);
          } else await window.PlatformAPI.work.setManualStage(orgId, row.plan_id, stageId);
        } else if (key.startsWith('cf.') && fieldByKey(key)?.type === 'user') {
          await writeProjectField(row.project_id, key.slice(3), groupValue ? { subject_type:'organization_user', subject_id: groupValue } : null);
        } else throw new Error(L('cannot_move', 'Cards on this board cannot be moved.'));
        toast(L('moved', 'Moved'));
      } catch (error) { toast(error?.message || L('move_failed', 'That card could not be moved.'), false); }
      query();
    }
    async function writeProjectField(projectId, path, value){
      const target = { scope:'project', organizationId: orgId, projectId };
      const read = await window.PlatformAPI.publication.read(orgId, { provider:'custom-fields-project', export:'contract', target });
      const contract = read.result || read;
      const field = arr(contract.value?.fields).find((f) => f.path === path);
      if (contract.status !== 'ready' || !field?.writable) throw new Error(L('field_not_writable', 'You cannot change this field on that project.'));
      const written = await window.PlatformAPI.publication.invoke(orgId, 'custom-fields.project.write', target, { values:{ [path]: value }, expectedRevision: contract.value.recordRevision }, { idempotencyKey: uid() });
      const result = written.result || written;
      if (result.status && result.status !== 'succeeded') throw new Error(result.message || L('field_not_saved', 'The field could not be saved.'));
    }

    // ---- Events ----------------------------------------------------------------
    function bindShell(){
      host.addEventListener('click', onClick);
      host.addEventListener('change', onChange);
      host.addEventListener('input', onInput);
      document.addEventListener('keydown', onDocumentKey);
      document.addEventListener('mousedown', onOutside, true);
    }
    /** Shortcuts work while the CRM is on screen and nothing else (a dialog, another app) has focus. */
    function onDocumentKey(event){
      if (!host.isConnected || !host.offsetParent) return;
      const active = document.activeElement;
      if (!host.contains(active) && active && active !== document.body && active !== document.documentElement) return;
      onKey(event);
    }
    function onOutside(event){
      if (!state.pop) return;
      if (state.pop.el.contains(event.target) || state.pop.anchor?.contains?.(event.target)) return;
      closePop();
    }
    let searchTimer = 0;
    function onInput(event){
      const t = event.target;
      if (t.matches('[data-search]')) { state.search = t.value; clearTimeout(searchTimer); searchTimer = setTimeout(() => query(), 220); }
      if (t.matches('[data-pop-filter]')) { const q = t.value.toLowerCase(); state.pop?.el.querySelectorAll('[data-pick-field]').forEach((b) => { b.hidden = !b.textContent.toLowerCase().includes(q); }); }
    }
    function onChange(event){
      const t = event.target;
      if (t.matches('[data-select]')) { t.checked ? state.selected.add(t.dataset.select) : state.selected.delete(t.dataset.select); t.closest('tr')?.setAttribute('aria-selected', String(t.checked)); renderBulkbar(); return; }
      if (t.matches('[data-select-all]')) { for (const r of arr(state.result?.rows)) t.checked ? state.selected.add(r.id) : state.selected.delete(r.id); renderView(); return; }
    }
    function onKey(event){
      const t = event.target;
      if (event.key === 'Escape') { if (state.pop) { closePop(); return; } if (!host.querySelector('.crm-worklist').hidden) { closeWorklist(); return; } if (state.drawer) { closeDrawer(); return; } }
      if ((event.key === 'Enter' || event.key === ' ') && t.matches('[data-edit-filter], .crm-card, .crm-agenda-item')) { event.preventDefault(); t.click(); return; }
      if (t.matches('input, textarea, select, [contenteditable]')) return;
      if ((event.ctrlKey || event.metaKey || event.altKey) && event.key.toLowerCase() !== 'k') return;
      if (!host.querySelector('.crm-worklist').hidden) { worklistKey(event); return; }
      if (event.key === '/') { event.preventDefault(); host.querySelector('[data-search]')?.focus(); }
      else if (event.key === 'f') { event.preventDefault(); host.querySelector('[data-add-filter]')?.click(); }
      else if (event.key === 'j' || event.key === 'k') { event.preventDefault(); stepRow(event.key === 'j' ? 1 : -1); }
      else if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'k') { event.preventDefault(); openCommand(); }
    }
    function stepRow(delta){
      const rows = arr(state.result?.rows); if (!rows.length) return;
      const i = Math.max(0, rows.findIndex((r) => r.id === state.openRow));
      const next = rows[Math.min(rows.length - 1, Math.max(0, state.openRow ? i + delta : 0))];
      openDrawer(next.id);
      host.querySelector(`[data-row="${CSS.escape(next.id)}"]`)?.scrollIntoView({ block:'nearest' });
    }

    async function onClick(event){
      // On a phone the rail slides over the page; a tap anywhere else closes it.
      if (host.classList.contains('rail-open') && !event.target.closest('.crm-rail, [data-rail-toggle]')) host.classList.remove('rail-open');
      const t = event.target.closest('button, [data-row], [data-edit-filter], [role="button"]');
      if (!t || !host.contains(t)) return;
      const d = t.dataset;
      if (d.railToggle !== undefined) { host.classList.toggle('rail-open'); return; }
      if (d.openView) return openView(d.openView);
      if (d.openPanel) return openPanel(d.openPanel);
      if (d.newView !== undefined) return openNewView(t);
      if (d.layout) return changeDraft((def) => { def.layout = d.layout; if (d.layout === 'board' && !def.group_by) def.group_by = defaultGroup(state.draft.collection); if (d.layout === 'calendar') def.sort = [{ key:'start_at', dir:'asc' }]; });
      if (d.display !== undefined) return openDisplay(t);
      if (d.viewMenu !== undefined) return openViewMenu(t);
      if (d.worklist !== undefined) return openWorklist();
      if (d.addFilter !== undefined) return openFieldPicker(t);
      if (d.removeFilter !== undefined) { event.stopPropagation(); return changeDraft((def) => { def.filter = { ...def.filter, rules: arr(def.filter?.rules).filter((_, i) => i !== Number(d.removeFilter)) }; }); }
      if (d.editFilter !== undefined) return openFilterEditor(t, Number(d.editFilter));
      if (d.filterMatch !== undefined) return changeDraft((def) => { def.filter = { ...def.filter, match: def.filter?.match === 'any' ? 'all' : 'any' }; });
      if (d.sortBy) return changeDraft((def) => { const cur = def.sort[0]; def.sort = [{ key: d.sortBy, dir: cur?.key === d.sortBy && cur.dir === 'asc' ? 'desc' : 'asc' }]; });
      if (d.loadMore !== undefined) { state.offset = arr(state.result?.rows).length; return query({ append:true }); }
      if (d.requery !== undefined) return query();
      if (d.discard !== undefined) { state.draft = clone(state.saved); state.search = ''; renderShell(); return query(); }
      if (d.saveAs !== undefined) return saveAsNew(t);
      if (d.save !== undefined) return saveView();
      if (d.bulk) return bulkAction(d.bulk, t);
      if (d.clearSelection !== undefined) { state.selected.clear(); return renderView(); }
      if (d.closeDrawer !== undefined) return closeDrawer();
      if (d.drawerAction) return drawerAction(d.drawerAction, t);
      if (d.row && !event.target.closest('input, .crm-check')) return openDrawer(d.row);
    }

    // ---- Popovers -------------------------------------------------------------
    function openPop(anchor, html, options = {}){
      closePop();
      const el = document.createElement('div');
      el.className = 'crm-pop'; el.setAttribute('role', options.role || 'dialog'); el.innerHTML = html;
      host.appendChild(el);
      const a = anchor.getBoundingClientRect(), h = host.getBoundingClientRect();
      const width = Math.min(options.width || 300, h.width - 24);
      el.style.width = `${width}px`;
      let left = a.left - h.left; if (options.alignRight) left = a.right - h.left - width;
      left = Math.max(12, Math.min(left, h.width - width - 12));
      el.style.left = `${left}px`; el.style.top = `${Math.min(a.bottom - h.top + 6, h.height - 80)}px`;
      state.pop = { el, anchor };
      setTimeout(() => el.querySelector('[autofocus], input, select, button')?.focus(), 0);
      return el;
    }
    function closePop(){ state.pop?.el.remove(); state.pop = null; }

    function fieldOptionsHtml(selected, predicate = () => true){
      const groups = new Map();
      for (const f of fields().filter(predicate)) { const g = f.group === 'fields' ? L('project_fields', 'Fields') : f.group === 'funnel' ? term('crm.funnel', 'Funnel') : L('general', 'General'); groups.set(g, [...(groups.get(g) || []), f]); }
      return [...groups].map(([g, list]) => `<optgroup label="${esc(g)}">${list.map((f) => `<option value="${esc(f.key)}" ${f.key === selected ? 'selected' : ''}>${esc(term(f.term, f.label))}</option>`).join('')}</optgroup>`).join('');
    }

    function openFieldPicker(anchor){
      const list = fields();
      const el = openPop(anchor, `<input type="search" data-pop-filter placeholder="${esc(L('filter_by', 'Filter by…'))}" aria-label="${esc(L('filter_by', 'Filter by…'))}" autofocus>
        <div class="crm-options" style="margin-top:6px">${list.map((f) => `<button type="button" class="crm-pop-item" data-pick-field="${esc(f.key)}">${esc(term(f.term, f.label))}<span class="crm-pop-hint">${esc(f.group === 'funnel' ? term('crm.funnel', 'Funnel') : f.group === 'fields' ? L('field', 'Field') : '')}</span></button>`).join('')}</div>`, { width: 280 });
      el.addEventListener('click', (e) => {
        const b = e.target.closest('[data-pick-field]'); if (!b) return;
        const field = fieldByKey(b.dataset.pickField);
        const rule = defaultRule(field);
        const def = normalizedDefinition(state.draft.definition);
        const index = arr(def.filter.rules).length;
        state.draft.definition.filter = { match: def.filter.match || 'all', rules: [...arr(def.filter.rules), rule] };
        closePop(); renderFilters();
        const chip = host.querySelector(`[data-edit-filter="${index}"]`) || anchor;
        openFilterEditor(chip, index, { fresh: true });
      });
    }
    function defaultRule(field){
      const type = field?.type || 'text';
      const op = opsFor(type)[0][0];
      const value = type === 'bool' ? 'true' : ['select', 'user'].includes(type) || op === 'in' ? [] : type === 'date' ? 'now-7d' : '';
      return { field: field?.key || '', operator: op, value };
    }

    /** The filter editor: every condition of the view, with all-or-any groups one level deep. */
    function openFilterEditor(anchor, focusIndex = -1, options = {}){
      let working = clone(normalizedDefinition(state.draft.definition).filter);
      if (!arr(working.rules).length) working = { match:'all', rules:[defaultRule(fields()[0])] };
      const valueControl = (rule, path) => {
        const field = fieldByKey(rule.field), type = field?.type || 'text';
        if (['is_present', 'is_missing'].includes(rule.operator)) return '<span class="crm-dim">—</span>';
        if (type === 'bool') return `<select data-fval="${path}"><option value="true" ${String(rule.value) === 'true' ? 'selected' : ''}>${esc(L('yes', 'Yes'))}</option><option value="false" ${String(rule.value) === 'false' ? 'selected' : ''}>${esc(L('no', 'No'))}</option></select>`;
        if (type === 'date') {
          const rel = RELATIVE.some(([v]) => v === rule.value);
          return `<select data-fval="${path}">${RELATIVE.map(([v, l]) => `<option value="${v}" ${v === rule.value ? 'selected' : ''}>${esc(l)}</option>`).join('')}<option value="__date" ${!rel ? 'selected' : ''}>${esc(L('a_date', 'A date…'))}</option></select>${!rel ? `<input type="date" data-fdate="${path}" value="${esc(text(rule.value).slice(0, 10))}" style="margin-top:4px">` : ''}`;
        }
        const listed = ['select', 'user', 'multi'].includes(type) && arr(field?.options).length;
        if (listed) {
          const chosen = new Set((Array.isArray(rule.value) ? rule.value : [rule.value]).map(String));
          const opts = [...(type === 'user' ? ME_VALUES.map(([value, label]) => ({ value, label })) : []), ...arr(field.options)];
          return `<details class="crm-multi"><summary class="crm-btn small" style="width:100%;justify-content:space-between">${esc(chosen.size ? [...chosen].map((v) => displayValue(field, v)).join(', ') : L('choose', 'Choose…'))}<i class="fas fa-caret-down"></i></summary><div class="crm-options">${opts.map((o) => `<label class="crm-option"><input type="checkbox" data-fopt="${path}" value="${esc(o.value)}" ${chosen.has(o.value) ? 'checked' : ''}>${esc(o.label)}</label>`).join('')}</div></details>`;
        }
        return `<input type="${['number', 'money'].includes(type) ? 'number' : 'text'}" data-fval="${path}" value="${esc(Array.isArray(rule.value) ? rule.value.join(', ') : rule.value)}" placeholder="${esc(L('value', 'Value'))}">`;
      };
      const rowHtml = (rule, path) => {
        const field = fieldByKey(rule.field);
        return `<div class="crm-frow" data-frow="${path}"><select data-ffield="${path}" aria-label="${esc(L('field', 'Field'))}">${fieldOptionsHtml(rule.field)}</select><select data-fop="${path}" aria-label="${esc(L('operator', 'Condition'))}">${opsFor(field?.type || 'text').map(([id, l]) => `<option value="${id}" ${id === rule.operator ? 'selected' : ''}>${esc(l)}</option>`).join('')}</select><div>${valueControl(rule, path)}</div><button type="button" class="crm-btn icon ghost" data-fremove="${path}" aria-label="${esc(L('remove', 'Remove'))}"><i class="fas fa-xmark"></i></button></div>`;
      };
      const render = () => {
        const groupHtml = (group, prefix) => `${arr(group.rules).map((rule, i) => {
          const path = prefix ? `${prefix}.${i}` : String(i);
          if (Array.isArray(rule.rules)) return `<div class="crm-fgroup"><div class="crm-pop-row"><select data-fmatch="${path}" aria-label="${esc(L('match', 'Match'))}"><option value="all" ${rule.match !== 'any' ? 'selected' : ''}>${esc(L('all_of', 'All of these'))}</option><option value="any" ${rule.match === 'any' ? 'selected' : ''}>${esc(L('any_of', 'Any of these'))}</option></select><button type="button" class="crm-btn icon ghost" data-fremove="${path}" aria-label="${esc(L('remove_group', 'Remove group'))}"><i class="fas fa-trash"></i></button></div>${groupHtml(rule, path)}<button type="button" class="crm-btn small ghost" data-fadd="${path}"><i class="fas fa-plus"></i>${esc(L('add_condition', 'Add condition'))}</button></div>`;
          return rowHtml(rule, path);
        }).join('')}`;
        el.innerHTML = `<h5>${esc(L('filter_rows', 'Show rows that match'))}</h5>
          <div class="crm-pop-row"><select data-fmatch="" aria-label="${esc(L('match', 'Match'))}"><option value="all" ${working.match !== 'any' ? 'selected' : ''}>${esc(L('all_of', 'All of these'))}</option><option value="any" ${working.match === 'any' ? 'selected' : ''}>${esc(L('any_of', 'Any of these'))}</option></select></div>
          ${groupHtml(working, '')}
          <div class="crm-pop-row"><button type="button" class="crm-btn small ghost" data-fadd=""><i class="fas fa-plus"></i>${esc(L('add_condition', 'Add condition'))}</button><button type="button" class="crm-btn small ghost" data-faddgroup><i class="fas fa-layer-group"></i>${esc(L('add_group', 'Add group'))}</button></div>
          <div class="crm-pop-foot"><button type="button" class="crm-btn small ghost" data-fcancel>${esc(L('cancel', 'Cancel'))}</button><button type="button" class="crm-btn small primary" data-fapply>${esc(L('apply', 'Apply'))}</button></div>`;
        if (focusIndex >= 0) { el.querySelector(`[data-frow="${focusIndex}"] select[data-fop]`)?.focus(); focusIndex = -1; }
      };
      const at = (path) => { const parts = text(path) === '' ? [] : String(path).split('.').map(Number); let node = working, parent = null, idx = -1; for (const p of parts) { parent = node; idx = p; node = arr(node.rules)[p]; } return { node, parent, idx }; };
      const el = openPop(anchor, '', { width: Math.min(680, host.clientWidth - 24) });
      render();
      el.addEventListener('change', (e) => {
        const t = e.target;
        if (t.dataset.ffield !== undefined) { const { parent, idx } = at(t.dataset.ffield); parent.rules[idx] = defaultRule(fieldByKey(t.value)); render(); }
        else if (t.dataset.fop !== undefined) { const { node } = at(t.dataset.fop); node.operator = t.value; const type = fieldByKey(node.field)?.type; if (['in', 'not_in'].includes(t.value) && !Array.isArray(node.value)) node.value = node.value ? [node.value] : []; if (!['in', 'not_in'].includes(t.value) && Array.isArray(node.value) && !['user', 'multi'].includes(type)) node.value = node.value[0] ?? ''; render(); }
        else if (t.dataset.fval !== undefined) { const { node } = at(t.dataset.fval); if (t.value === '__date') { node.value = isoDay(new Date()); render(); } else node.value = t.type === 'number' ? (t.value === '' ? '' : Number(t.value)) : t.value; }
        else if (t.dataset.fdate !== undefined) { const { node } = at(t.dataset.fdate); node.value = t.value; }
        else if (t.dataset.fopt !== undefined) { const { node } = at(t.dataset.fopt); const values = new Set(Array.isArray(node.value) ? node.value : node.value ? [node.value] : []); t.checked ? values.add(t.value) : values.delete(t.value); node.value = [...values]; const summary = t.closest('details')?.querySelector('summary'); if (summary) summary.firstChild.textContent = node.value.length ? node.value.map((v) => displayValue(fieldByKey(node.field), v)).join(', ') : L('choose', 'Choose…'); }
        else if (t.dataset.fmatch !== undefined) { const target = t.dataset.fmatch === '' ? working : at(t.dataset.fmatch).node; target.match = t.value; }
      });
      el.addEventListener('click', (e) => {
        const b = e.target.closest('button'); if (!b) return;
        if (b.dataset.fremove !== undefined) { const { parent, idx } = at(b.dataset.fremove); parent.rules.splice(idx, 1); render(); }
        else if (b.dataset.fadd !== undefined) { const target = b.dataset.fadd === '' ? working : at(b.dataset.fadd).node; target.rules = [...arr(target.rules), defaultRule(fields()[0])]; render(); }
        else if (b.dataset.faddgroup !== undefined) { working.rules = [...arr(working.rules), { match:'any', rules:[defaultRule(fields()[0])] }]; render(); }
        else if (b.dataset.fcancel !== undefined) { if (options.fresh) changeDraft((def) => { def.filter = { ...def.filter, rules: arr(def.filter.rules).slice(0, -1) }; }, { query:false }); closePop(); renderFilters(); }
        else if (b.dataset.fapply !== undefined) { const clean = (g) => ({ match: g.match === 'any' ? 'any' : 'all', rules: arr(g.rules).map((r) => Array.isArray(r.rules) ? clean(r) : r).filter((r) => Array.isArray(r.rules) ? r.rules.length : r.field) }); const next = clean(working); closePop(); changeDraft((def) => { def.filter = next; }); }
      });
    }

    function openDisplay(anchor){
      const def = normalizedDefinition(state.draft.definition);
      const cols = visibleColumns(def);
      const el = openPop(anchor, '', { width: 320, alignRight: true });
      const render = () => {
        const current = normalizedDefinition(state.draft.definition), columns = visibleColumns(current), sort = current.sort[0] || {};
        el.innerHTML = `
          <h5>${esc(L('group_by', 'Group by'))}</h5>
          <div class="crm-pop-row"><select data-dgroup aria-label="${esc(L('group_by', 'Group by'))}"><option value="">${esc(L('no_grouping', 'No grouping'))}</option>${fieldOptionsHtml(current.group_by, (f) => f.groupable !== false && ['select', 'bool', 'user', 'text'].includes(f.type))}</select></div>
          <h5>${esc(L('sort_by', 'Sort by'))}</h5>
          <div class="crm-pop-row"><select data-dsort aria-label="${esc(L('sort_by', 'Sort by'))}"><option value="">${esc(L('default', 'Default'))}</option>${fieldOptionsHtml(sort.key)}</select><select data-ddir aria-label="${esc(L('direction', 'Direction'))}" style="width:110px"><option value="asc" ${sort.dir !== 'desc' ? 'selected' : ''}>${esc(L('ascending', 'Ascending'))}</option><option value="desc" ${sort.dir === 'desc' ? 'selected' : ''}>${esc(L('descending', 'Descending'))}</option></select></div>
          <h5>${esc(L('columns', 'Columns'))}</h5>
          <div class="crm-options">${[...columns.map(fieldByKey), ...fields().filter((f) => !columns.includes(f.key))].filter(Boolean).map((f) => {
            const on = columns.includes(f.key), i = columns.indexOf(f.key);
            return `<div class="crm-option"><input type="checkbox" data-dcol="${esc(f.key)}" ${on ? 'checked' : ''} id="crm-col-${esc(f.key)}"><label for="crm-col-${esc(f.key)}" style="flex:1">${esc(term(f.term, f.label))}</label>${on ? `<button type="button" class="crm-btn icon ghost small" data-dup="${i}" aria-label="${esc(L('move_up', 'Move up'))}" ${i === 0 ? 'disabled' : ''}><i class="fas fa-chevron-up"></i></button>` : ''}</div>`;
          }).join('')}</div>`;
      };
      render();
      el.addEventListener('change', (e) => {
        const t = e.target;
        if (t.matches('[data-dgroup]')) changeDraft((d) => { d.group_by = t.value; }); else if (t.matches('[data-dsort], [data-ddir]')) { const key = el.querySelector('[data-dsort]').value, dir = el.querySelector('[data-ddir]').value; changeDraft((d) => { d.sort = key ? [{ key, dir }] : []; }); }
        else if (t.matches('[data-dcol]')) { const now = visibleColumns(normalizedDefinition(state.draft.definition)); changeDraft((d) => { d.columns = t.checked ? [...now, t.dataset.dcol] : now.filter((k) => k !== t.dataset.dcol); }, { query:false }); }
        render();
      });
      el.addEventListener('click', (e) => { const b = e.target.closest('[data-dup]'); if (!b) return; const i = Number(b.dataset.dup); const now = visibleColumns(normalizedDefinition(state.draft.definition)); if (i <= 0) return; [now[i - 1], now[i]] = [now[i], now[i - 1]]; changeDraft((d) => { d.columns = now; }, { query:false }); render(); });
      void cols;
    }

    function openViewMenu(anchor){
      const view = state.saved;
      const can = view?.editable;
      const el = openPop(anchor, `
        ${view?.id ? `<button type="button" class="crm-pop-item" data-vm="pin"><i class="fas fa-thumbtack"></i>${esc(viewById(view.id)?.pinned ? L('unpin', 'Unpin from the rail') : L('pin', 'Pin to the rail'))}</button>` : ''}
        ${can ? `<button type="button" class="crm-pop-item" data-vm="rename"><i class="fas fa-pen"></i>${esc(L('rename', 'Rename'))}</button>` : ''}
        <button type="button" class="crm-pop-item" data-vm="duplicate"><i class="fas fa-copy"></i>${esc(L('duplicate_view', 'Save a copy'))}</button>
        ${view?.id && state.meta?.can_share_views ? `<button type="button" class="crm-pop-item" data-vm="share"><i class="fas fa-user-group"></i>${esc(L('who_sees', 'Who sees this view'))}</button>` : ''}
        ${view?.id && !can ? `<button type="button" class="crm-pop-item" data-vm="hide"><i class="fas fa-eye-slash"></i>${esc(L('hide_view', 'Hide this view'))}</button>` : ''}
        ${can ? `<button type="button" class="crm-pop-item" data-vm="delete" style="color:#b42318"><i class="fas fa-trash"></i>${esc(L('delete_view', 'Delete view'))}</button>` : ''}`, { width: 240, alignRight: true, role:'menu' });
      el.addEventListener('click', async (e) => {
        const b = e.target.closest('[data-vm]'); if (!b) return;
        const action = b.dataset.vm; closePop();
        try {
          if (action === 'pin') { const pinned = !viewById(view.id)?.pinned; await api().setViewPreference(orgId, view.id, { pinned, hidden: false }); await reloadViews(); toast(pinned ? L('pinned', 'Pinned') : L('unpinned', 'Unpinned')); }
          else if (action === 'hide') { await api().setViewPreference(orgId, view.id, { pinned:false, hidden:true }); await reloadViews(); toast(L('hidden', 'Hidden')); }
          else if (action === 'rename') { const name = await promptDialog(L('rename_prompt', 'Name this view'), view.name, { title: L('rename', 'Rename') }); if (!text(name)) return; const saved = await api().saveView(orgId, view.id, payload(view, { name: text(name) })); afterSave(saved.view); }
          else if (action === 'duplicate') saveAsNew(anchor, `${state.draft.name} ${L('copy', '(copy)')}`);
          else if (action === 'share') openShare(anchor);
          else if (action === 'delete') { if (!(await confirmDialog(L('delete_confirm', 'Delete "{name}" for everyone who sees it?', { name: view.name }), { danger:true, okLabel: L('delete', 'Delete') }))) return; await api().deleteView(orgId, view.id); await reloadViews(); const next = state.views.find((v) => v.pinned) || state.views[0]; if (next) openView(next.id); }
        } catch (error) { toast(error?.message || L('failed', 'That did not work.'), false); }
      });
    }

    function payload(view, overrides = {}){
      return { name: view.name, collection: view.collection, definition: { ...normalizedDefinition(state.draft.definition), icon: text(view.definition?.icon), description: text(view.definition?.description) }, visibility: view.visibility || 'private', role_ids: arr(view.role_ids), default_role_ids: arr(view.default_role_ids), expected_revision: view.revision, ...overrides };
    }
    async function reloadViews(){ state.views = arr((await api().views(orgId)).views); renderRail(); }
    function afterSave(view){
      state.saved = clone(view); state.draft = clone(view);
      reloadViews().then(() => { renderShell(); loadCounts(); });
      if (!navigation?.applying) navigation?.replace?.({ tab:'crm', crmView: view.id }, { source:'crm-view-save', ownedKeys:['crmView'] });
      toast(L('saved', 'Saved'));
    }
    async function saveView(){
      try { const saved = await api().saveView(orgId, state.saved.id, payload(state.saved)); afterSave(saved.view); }
      catch (error) { toast(error?.message || L('save_failed', 'The view could not be saved.'), false); }
    }
    async function saveAsNew(anchor, suggested){
      const name = await promptDialog(L('name_prompt', 'Name the new view'), suggested || (state.saved?.id ? `${state.draft.name} ${L('copy', '(copy)')}` : state.draft.name), { title: L('save_as_new', 'Save as new view') });
      if (!text(name)) return;
      try { const saved = await api().createView(orgId, { name: text(name), collection: state.draft.collection, definition: normalizedDefinition(state.draft.definition), visibility:'private' }); afterSave(saved.view); }
      catch (error) { toast(error?.message || L('save_failed', 'The view could not be saved.'), false); }
    }
    function openNewView(anchor){
      const collections = arr(state.meta?.collections);
      const el = openPop(anchor, `<h5>${esc(L('new_view', 'New view'))}</h5>${collections.map((c) => `<button type="button" class="crm-pop-item" data-nv="${esc(c.id)}"><i class="fas ${esc(c.icon)}"></i>${esc(term(c.term, c.label))}</button>`).join('')}`, { width: 260, role:'menu' });
      el.addEventListener('click', (e) => {
        const b = e.target.closest('[data-nv]'); if (!b) return;
        closePop(); state.panel = 'view'; state.saved = null; state.draft = blankDraft(b.dataset.nv); state.draft.name = term(collectionInfo(b.dataset.nv).term, collectionInfo(b.dataset.nv).label);
        state.result = null; renderShell(); query(); host.classList.remove('rail-open');
      });
    }
    async function openShare(anchor){
      const view = state.saved;
      let roles = [];
      try { const r = await (window.PlatformAPI.workforce?.accessRoles || window.PlatformAPI.accessRoles)?.(orgId); roles = arr(r?.roles || r?.access_roles || r?.items).map((x) => ({ id: text(x.id), label: text(x.label || x.name || x.id) })).filter((x) => x.id); } catch { roles = []; }
      const el = openPop(anchor, '', { width: 340, alignRight: true });
      let draft = { visibility: view.visibility, role_ids: arr(view.role_ids), default_role_ids: arr(view.default_role_ids) };
      const render = () => {
        el.innerHTML = `<h5>${esc(L('who_sees', 'Who sees this view'))}</h5>
          ${[['private', L('only_me', 'Only me')], ['roles', L('some_roles', 'People in some roles')], ['everyone', L('everyone', 'Everyone')]].map(([v, l]) => `<label class="crm-option"><input type="radio" name="crm-vis" value="${v}" ${draft.visibility === v ? 'checked' : ''}>${esc(l)}</label>`).join('')}
          ${draft.visibility === 'roles' ? `<div class="crm-options" style="margin:4px 0 0 22px">${roles.map((r) => `<label class="crm-option"><input type="checkbox" data-role="${esc(r.id)}" ${draft.role_ids.includes(r.id) ? 'checked' : ''}>${esc(r.label)}</label>`).join('') || `<span class="crm-dim">${esc(L('no_roles', 'No roles found'))}</span>`}</div>` : ''}
          ${draft.visibility !== 'private' ? `<h5>${esc(L('default_for', 'Pinned by default for'))}</h5><div class="crm-options">${roles.map((r) => `<label class="crm-option"><input type="checkbox" data-default-role="${esc(r.id)}" ${draft.default_role_ids.includes(r.id) ? 'checked' : ''}>${esc(r.label)}</label>`).join('')}</div>` : ''}
          <div class="crm-pop-foot"><button type="button" class="crm-btn small ghost" data-share-cancel>${esc(L('cancel', 'Cancel'))}</button><button type="button" class="crm-btn small primary" data-share-save>${esc(L('save', 'Save'))}</button></div>`;
      };
      render();
      el.addEventListener('change', (e) => {
        const t = e.target;
        if (t.name === 'crm-vis') draft.visibility = t.value;
        if (t.dataset.role) draft.role_ids = t.checked ? [...draft.role_ids, t.dataset.role] : draft.role_ids.filter((x) => x !== t.dataset.role);
        if (t.dataset.defaultRole) draft.default_role_ids = t.checked ? [...draft.default_role_ids, t.dataset.defaultRole] : draft.default_role_ids.filter((x) => x !== t.dataset.defaultRole);
        render();
      });
      el.addEventListener('click', async (e) => {
        if (e.target.closest('[data-share-cancel]')) return closePop();
        if (!e.target.closest('[data-share-save]')) return;
        try { const saved = await api().saveView(orgId, view.id, payload(view, { visibility: draft.visibility, role_ids: draft.visibility === 'roles' ? draft.role_ids : [], default_role_ids: draft.visibility === 'private' ? [] : draft.default_role_ids })); closePop(); afterSave(saved.view); }
        catch (error) { toast(error?.message || L('save_failed', 'The view could not be saved.'), false); }
      });
    }

    function openCommand(){
      const anchor = host.querySelector('.crm-head') || host;
      const items = [
        ...state.views.map((v) => ({ label: v.name, hint: term(collectionInfo(v.collection).term, collectionInfo(v.collection).label), run: () => openView(v.id) })),
        ...(feature('funnel') ? [{ label: term('crm.funnel', 'Funnel'), hint: L('insights', 'Insights'), run: () => openPanel('reports') }] : []),
        { label: L('duplicates', 'Duplicates'), hint: L('insights', 'Insights'), run: () => openPanel('duplicates') },
        ...(state.panel === 'view' ? [{ label: L('add_filter', 'Add a filter'), hint: 'F', run: () => host.querySelector('[data-add-filter]')?.click() }, { label: term('crm.worklist', 'Work this list'), hint: '', run: () => openWorklist() }] : [])
      ];
      const el = openPop(anchor, `<input type="search" data-pop-filter placeholder="${esc(L('command', 'Go to a view or run a command'))}" aria-label="${esc(L('command', 'Go to a view or run a command'))}" autofocus><div class="crm-options" style="margin-top:6px">${items.map((it, i) => `<button type="button" class="crm-pop-item" data-pick-field="${i}" data-cmd="${i}">${esc(it.label)}<span class="crm-pop-hint">${esc(it.hint)}</span></button>`).join('')}</div>`, { width: 420 });
      el.style.left = `${Math.max(12, (host.clientWidth - 420) / 2)}px`; el.style.top = '64px';
      el.addEventListener('click', (e) => { const b = e.target.closest('[data-cmd]'); if (!b) return; closePop(); items[Number(b.dataset.cmd)]?.run(); });
      el.addEventListener('keydown', (e) => { if (e.key === 'Enter') { const first = [...el.querySelectorAll('[data-cmd]')].find((b) => !b.hidden); if (first) { e.preventDefault(); first.click(); } } });
    }

    // ---- Bulk actions ------------------------------------------------------------
    function renderBulkbar(){
      const bar = host.querySelector('.crm-bulkbar'); if (!bar) return;
      const n = state.selected.size;
      bar.hidden = !n || state.panel !== 'view'; if (bar.hidden) return;
      const c = state.draft.collection;
      const actions = c === 'opportunities' ? [['assign', 'fa-user-plus', L('assign', 'Assign')], ['scope', 'fa-diagram-project', L('start_scope', 'Start a scope')], ['follow_up', 'fa-clock', L('follow_up', 'Follow up')], ['lost', 'fa-circle-xmark', L('mark_lost', 'Mark lost')], ...(n === 2 ? [['merge_projects', 'fa-code-merge', L('merge', 'Merge')]] : [])]
        : c === 'contacts' ? [['tag', 'fa-tag', L('tag', 'Tag')], ...(n === 2 ? [['merge_contacts', 'fa-code-merge', L('merge', 'Merge')]] : [])]
        : [];
      bar.innerHTML = `<span class="crm-bulk-count">${esc(L('selected', '{n} selected', { n }))}</span>${feature('worklists') ? `<button type="button" class="crm-btn small" data-bulk="work"><i class="fas fa-play"></i>${esc(L('work_these', 'Work these'))}</button>` : ''}${actions.map(([id, icon, label]) => `<button type="button" class="crm-btn small" data-bulk="${id}"><i class="fas ${icon}"></i>${esc(label)}</button>`).join('')}<button type="button" class="crm-btn small" data-clear-selection aria-label="${esc(L('clear_selection', 'Clear selection'))}"><i class="fas fa-xmark"></i></button>`;
    }
    const selectedRows = () => arr(state.result?.rows).filter((r) => state.selected.has(r.id));
    async function runEach(rows, label, fn){
      let done = 0, failed = 0;
      for (let i = 0; i < rows.length; i += 4) {
        const results = await Promise.allSettled(rows.slice(i, i + 4).map(fn));
        for (const r of results) r.status === 'fulfilled' ? done++ : failed++;
      }
      toast(failed ? L('bulk_partial', '{label}: {done} done, {failed} not done', { label, done, failed }) : L('bulk_done', '{label}: {done} done', { label, done }), !failed);
      state.selected.clear(); query();
    }
    async function bulkAction(action, anchor){
      const rows = selectedRows(); if (!rows.length) return;
      if (action === 'work') return openWorklist(rows);
      if (action === 'assign') {
        const userFields = fields().filter((f) => f.type === 'user' && f.key.startsWith('cf.'));
        if (!userFields.length) return toast(L('no_assign_fields', 'These scopes have no person fields to assign.'), false);
        const el = openPop(anchor, `<h5>${esc(L('assign', 'Assign'))}</h5><div class="crm-pop-row"><select data-af>${userFields.map((f) => `<option value="${esc(f.key)}">${esc(f.label)}</option>`).join('')}</select></div><div class="crm-pop-row"><select data-au>${arr(userFields[0].options).map((o) => `<option value="${esc(o.value)}">${esc(o.label)}</option>`).join('')}</select></div><div class="crm-pop-foot"><button type="button" class="crm-btn small primary" data-ago>${esc(L('assign', 'Assign'))}</button></div>`, { width: 300 });
        el.querySelector('[data-af]').addEventListener('change', (e) => { el.querySelector('[data-au]').innerHTML = arr(fieldByKey(e.target.value)?.options).map((o) => `<option value="${esc(o.value)}">${esc(o.label)}</option>`).join(''); });
        el.querySelector('[data-ago]').addEventListener('click', () => { const key = el.querySelector('[data-af]').value, user = el.querySelector('[data-au]').value; closePop(); runEach(rows, L('assign', 'Assign'), (r) => writeProjectField(r.project_id, key.slice(3), { subject_type:'organization_user', subject_id:user })); });
        return;
      }
      if (action === 'scope') {
        const templates = arr((await window.PlatformAPI.scopes.list(orgId, 'default')).templates).filter((t) => t.enabled !== false && t.status !== 'archived');
        const el = openPop(anchor, `<h5>${esc(L('start_scope', 'Start a scope'))}</h5><div class="crm-options">${templates.map((t) => `<button type="button" class="crm-pop-item" data-st="${esc(t.id)}">${esc(t.name || t.id)}</button>`).join('')}</div>`, { width: 280 });
        el.addEventListener('click', (e) => { const b = e.target.closest('[data-st]'); if (!b) return; closePop(); runEach(rows, L('start_scope', 'Start a scope'), (r) => window.PlatformAPI.scopes.startOnProject(orgId, r.project_id, b.dataset.st)); });
        return;
      }
      if (action === 'follow_up') {
        const el = openPop(anchor, `<h5>${esc(L('follow_up_when', 'Follow up on'))}</h5><div class="crm-pop-row"><input type="date" data-fd value="${isoDay(new Date(Date.now() + DAY))}"></div><div class="crm-pop-foot"><button type="button" class="crm-btn small primary" data-fgo>${esc(L('schedule', 'Schedule'))}</button></div>`, { width: 260 });
        el.querySelector('[data-fgo]').addEventListener('click', () => {
          const due = el.querySelector('[data-fd]').value; const followUp = arr(state.meta?.outcomes).find((o) => o.action === 'reschedule'); closePop();
          if (!followUp) return toast(L('no_follow_up_outcome', 'No follow-up result is configured.'), false);
          runEach(rows, L('follow_up', 'Follow up'), (r) => api().recordResult(orgId, { project_id: r.project_id, contact_id: text(r.contact_id), disposition:'other', outcome_id: followUp.id, follow_up_at: due, channel:'other' }));
        });
        return;
      }
      if (action === 'lost') {
        const lost = arr(state.meta?.outcomes).filter((o) => o.action === 'lost');
        const reason = await promptDialog(L('lost_reason', 'Why were these lost?'), lost[0]?.label || L('lost', 'Lost'), { title: L('mark_lost', 'Mark lost') });
        if (reason === null || reason === undefined) return;
        return runEach(rows, L('mark_lost', 'Mark lost'), (r) => window.PlatformAPI.work.markProjectLost(orgId, r.project_id, { reason: text(reason) || 'lost' }));
      }
      if (action === 'tag') {
        const tag = text(await promptDialog(L('tag_prompt', 'Add which tag?'), '', { title: L('tag', 'Tag') })); if (!tag) return;
        return runEach(rows, L('tag', 'Tag'), async (r) => { const current = await window.PlatformAPI.contacts.get(orgId, r.contact_id || r.id); const contact = current.contact || current; return window.PlatformAPI.contacts.update(orgId, contact.id, { tags: [...new Set([...arr(contact.tags), tag])] }, contact.revision || current.revision); });
      }
      if (action === 'merge_contacts' || action === 'merge_projects') {
        const [a, b] = rows;
        const label = (r) => r.name || r.contact_name || r.title;
        const el = openPop(anchor, `<h5>${esc(L('keep_which', 'Keep which one?'))}</h5><p class="crm-dim" style="margin:0 8px 6px">${esc(L('merge_hint', 'The other is merged into it. This cannot be undone.'))}</p>${[a, b].map((r, i) => `<button type="button" class="crm-pop-item" data-keep="${i}"><i class="fas fa-crown"></i>${esc(label(r))}</button>`).join('')}`, { width: 300 });
        el.addEventListener('click', async (e) => {
          const k = e.target.closest('[data-keep]'); if (!k) return; closePop();
          const keep = Number(k.dataset.keep) === 0 ? a : b, other = keep === a ? b : a;
          try {
            if (action === 'merge_contacts') await window.PlatformAPI.contacts.merge(orgId, keep.contact_id || keep.id, other.contact_id || other.id, {});
            else await window.PlatformAPI.contacts.mergeProjects(orgId, keep.project_id, other.project_id);
            toast(L('merged', 'Merged')); state.selected.clear(); query();
          } catch (error) { toast(error?.message || L('merge_failed', 'They could not be merged.'), false); }
        });
      }
    }

    // ---- The lead drawer -----------------------------------------------------------
    function rowById(id){ return arr(state.result?.rows).find((r) => r.id === id) || arr(state.worklist?.rows).find((r) => r.id === id) || null; }
    async function loadRecord(row){
      const projectId = text(row.project_id || (state.draft?.collection === 'opportunities' ? row.id : ''));
      const contactId = text(row.contact_id || (state.draft?.collection === 'contacts' ? row.id : ''));
      const [project, contact, results] = await Promise.all([
        projectId ? window.PlatformAPI.projects.get(orgId, projectId).then((r) => ({ id: projectId, ...obj(r.document?.data), revision: r.document?.revision })).catch(() => null) : null,
        contactId ? window.PlatformAPI.contacts.get(orgId, contactId).then((r) => ({ ...obj(r.contact || r), project_ids: arr(r.project_ids) })).catch(() => null) : null,
        projectId ? api().projectResults(orgId, projectId).then((r) => arr(r.results)).catch(() => []) : []
      ]);
      let contactProjects = [];
      if (contact && !projectId && contact.project_ids?.length) contactProjects = (await Promise.all(contact.project_ids.slice(0, 12).map((id) => window.PlatformAPI.projects.get(orgId, id).then((r) => ({ id, ...obj(r.document?.data) })).catch(() => null)))).filter(Boolean);
      return { row, project, contact, results, contactProjects };
    }
    async function openDrawer(rowId){
      const row = rowById(rowId); if (!row) return;
      state.openRow = rowId;
      host.querySelectorAll('.crm-row-open').forEach((el) => el.classList.remove('crm-row-open'));
      host.querySelector(`tr[data-row="${CSS.escape(rowId)}"]`)?.classList.add('crm-row-open');
      const drawer = host.querySelector('.crm-drawer'); drawer.hidden = false;
      drawer.innerHTML = `<div class="crm-drawer-head"><span class="crm-avatar">${esc(initials(row.contact_name || row.name || row.title))}</span><div style="flex:1;min-width:0"><h3>${esc(row.contact_name || row.name || row.title || '')}</h3><div class="crm-sub">${esc(L('loading', 'Loading…'))}</div></div><button type="button" class="crm-btn icon ghost" data-close-drawer aria-label="${esc(L('close', 'Close'))}"><i class="fas fa-xmark"></i></button></div><div class="crm-loading"></div>`;
      const ticket = (state.drawerTicket = (state.drawerTicket || 0) + 1);
      try { state.drawer = await loadRecord(row); } catch (error) { state.drawer = { row, error: error?.message }; }
      if (ticket !== state.drawerTicket || drawer.hidden) return;
      renderDrawer();
    }
    function closeDrawer(focus = true){
      const drawer = host.querySelector('.crm-drawer'); if (!drawer) return;
      drawer.hidden = true; drawer.innerHTML = ''; state.drawer = null;
      if (state.openRow) { const el = host.querySelector(`[data-row="${CSS.escape(state.openRow)}"]`); el?.classList.remove('crm-row-open'); if (focus) el?.focus?.(); }
      state.openRow = '';
    }
    function phonesOf(contact, row){ return [...new Set([...arr(contact?.phones).map((p) => p.value || p), contact?.phone, row?.contact_phone, row?.phone].map(text).filter(Boolean))]; }
    function emailsOf(contact, row){ return [...new Set([...arr(contact?.emails).map((p) => p.value || p), contact?.email, row?.contact_email, row?.email].map(text).filter(Boolean))]; }
    function timelineHtml(record){
      const items = [];
      const project = record.project;
      if (project?.lead_source?.received_at || project?.created_at) items.push({ at: project.lead_source?.received_at || project.created_at, what: L('lead_arrived', 'Arrived as a lead from {source}', { source: text(project.lead_source?.source_path || project.lead_source?.provider || project.lead_source?.kind || project.source).replace(/_/g, ' ') || L('unknown', 'unknown') }) });
      for (const r of arr(record.results)) items.push({ at: r.created_at, what: `${arr(state.meta?.outcomes).find((o) => o.id === r.outcome_id)?.label || r.outcome_id} · ${r.channel}`, note: r.note });
      for (const e of arr(project?.events)) if (text(e.start_at) && !['canceled', 'cancelled'].includes(text(e.status).toLowerCase())) items.push({ at: e.start_at, what: `${e.title || L('appointment', 'Appointment')}${text(e.status) === 'completed' ? ` · ${L('completed', 'completed')}` : ''}`, future: Date.parse(e.start_at) > Date.now() });
      const life = obj(project?.lifecycle);
      if (life.sold_at) items.push({ at: life.sold_at, what: L('won', 'Won') });
      if (project?.lost_at) items.push({ at: project.lost_at, what: `${L('lost', 'Lost')}${project.lost_reason ? ` · ${project.lost_reason}` : ''}` });
      items.sort((a, b) => Date.parse(b.at) - Date.parse(a.at));
      if (!items.length) return `<p class="crm-dim">${esc(L('no_history', 'Nothing has happened yet.'))}</p>`;
      return `<ul class="crm-timeline">${items.slice(0, 40).map((i) => `<li><div class="crm-when" title="${esc(fullDate(i.at))}">${esc(i.future ? L('upcoming_when', 'Upcoming · {when}', { when: when(i.at) }) : when(i.at))}</div><div class="crm-what">${esc(i.what)}</div>${i.note ? `<div class="crm-note">${esc(i.note)}</div>` : ''}</li>`).join('')}</ul>`;
    }
    function overviewFields(project){
      const schema = obj(project?.custom_field_schema), values = obj(project?.custom_field_values || project?.custom_fields);
      const at = (path) => String(path).split('.').reduce((n, k) => (n && typeof n === 'object' ? n[k] : undefined), values);
      return arr(schema.fields).filter((f) => f.show_in_overview !== false && !f.background_only).map((f) => {
        let v = at(f.path || f.key); if (v == null || v === '' || (Array.isArray(v) && !v.length)) return null;
        if (v && typeof v === 'object' && !Array.isArray(v)) v = v.name || v.label || state.result?.labels?.[`user:${v.subject_id}`] || v.subject_id || v.value || JSON.stringify(v);
        if (Array.isArray(v)) v = v.map((x) => typeof x === 'object' ? (x.name || x.label || JSON.stringify(x)) : x).join(', ');
        if (['currency', 'money'].includes(f.type)) v = money(Math.round(Number(v) * 100));
        const option = arr(f.options).find((o) => String(typeof o === 'object' ? o.value : o) === String(v));
        if (option && typeof option === 'object') v = option.label || v;
        if (f.type === 'date' || f.type === 'datetime') v = f.type === 'date' ? new Date(`${v}T12:00:00`).toLocaleDateString(undefined, { dateStyle:'medium' }) : fullDate(v);
        return [f.label || f.path, String(v)];
      }).filter(Boolean).slice(0, 14);
    }
    function renderDrawer(){
      const drawer = host.querySelector('.crm-drawer'); const record = state.drawer; if (!record || drawer.hidden) return;
      const { row, project, contact } = record;
      const name = contact?.name || row.contact_name || row.name || project?.title || row.title || '';
      const phones = phonesOf(contact, row), emails = emailsOf(contact, row);
      const life = obj(project?.lifecycle);
      const instances = arr(project?.work_projection?.instances).filter((i) => !['canceled'].includes(i.status));
      const stateOpt = (key, value) => arr(fieldByKey(key)?.options).find((o) => o.value === value);
      const leadState = stateOpt('state', row.state);
      const fieldsList = overviewFields(project);
      drawer.innerHTML = `
        <div class="crm-drawer-head"><span class="crm-avatar">${esc(initials(name))}</span><div style="flex:1;min-width:0"><h3>${esc(name || L('unnamed', 'Unnamed'))}</h3><div class="crm-sub">${esc([phones[0], emails[0]].filter(Boolean).join(' · ') || project?.address || '')}</div>${leadState ? `<div style="margin-top:6px"><span class="crm-pill" style="color:${esc(leadState.color || '#344054')};background:${esc(leadState.color || '#344054')}14"><span class="dot"></span>${esc(leadState.label)}</span></div>` : ''}</div><button type="button" class="crm-btn icon ghost" data-close-drawer aria-label="${esc(L('close', 'Close'))}"><i class="fas fa-xmark"></i></button></div>
        <div class="crm-drawer-actions">
          ${phones.length ? `<button type="button" class="crm-btn small" data-drawer-action="call"><i class="fas fa-phone"></i>${esc(L('call', 'Call'))}</button>` : ''}
          ${project ? `<button type="button" class="crm-btn small" data-drawer-action="text"><i class="fas fa-comment"></i>${esc(L('text', 'Text'))}</button>` : ''}
          ${emails.length ? `<a class="crm-btn small" href="mailto:${esc(emails[0])}"><i class="fas fa-envelope"></i>${esc(L('email', 'Email'))}</a>` : ''}
          ${project && feature('appointment_slots') && window.FirstMateBooking?.open ? `<button type="button" class="crm-btn small" data-drawer-action="book"><i class="fas fa-calendar-plus"></i>${esc(L('set_appointment', 'Set appointment'))}</button>` : ''}
          ${project ? `<button type="button" class="crm-btn small" data-drawer-action="result"><i class="fas fa-check-to-slot"></i>${esc(term('crm.disposition', 'Result'))}</button>` : ''}
          ${project ? `<button type="button" class="crm-btn small" data-drawer-action="open"><i class="fas fa-arrow-up-right-from-square"></i>${esc(L('open_project', 'Open project'))}</button>` : contact ? `<button type="button" class="crm-btn small" data-drawer-action="open_contact"><i class="fas fa-arrow-up-right-from-square"></i>${esc(L('open_contact', 'Open contact'))}</button>` : ''}
          ${project ? `<button type="button" class="crm-btn small" data-drawer-action="more"><i class="fas fa-ellipsis"></i>${esc(L('more', 'More'))}</button>` : ''}
        </div>
        <div class="crm-drawer-body">
          ${row.rescission_until && Date.parse(row.rescission_until) > Date.now() ? `<div class="crm-callout"><i class="fas fa-hourglass-half"></i><div style="flex:1">${esc(L('in_window', 'Sold. The customer can cancel until {when}.', { when: fullDate(row.rescission_until) }))}</div>${feature('rescission') ? `<button type="button" class="crm-btn small" data-drawer-action="cancel_sale">${esc(L('customer_cancelled', 'Customer cancelled'))}</button>` : ''}</div>` : ''}
          <div data-result-slot></div>
          ${project ? `<div class="crm-section"><h4>${esc(term('crm.opportunity', 'Opportunity'))}</h4>
            ${instances.length ? instances.map((i) => `<div class="crm-opp"><div class="crm-opp-head"><span>${esc(i.title || i.template_id)}</span>${i.stage_title ? `<span class="crm-pill">${esc(i.stage_title)}</span>` : ''}</div><div class="crm-dim" style="margin-top:4px">${esc([i.sales ? (i.outcome === 'won' ? L('won', 'Won') : i.outcome === 'lost' ? L('lost', 'Lost') : L('open', 'Open')) : L('production', 'Work'), i.started_at ? L('started_when', 'started {when}', { when: when(i.started_at) }) : ''].filter(Boolean).join(' · '))}</div></div>`).join('') : `<div class="crm-opp"><div class="crm-opp-head"><span>${esc(term('crm.new_lead', 'New lead'))}</span></div><div class="crm-dim" style="margin-top:4px">${esc(L('no_scope_yet', 'No scope yet. Start the scope it needs, or close it if it is not a lead.'))}</div><div style="margin-top:8px"><button type="button" class="crm-btn small" data-drawer-action="start_scope"><i class="fas fa-play"></i>${esc(L('start_scope', 'Start a scope'))}</button></div></div>`}
            <dl class="crm-kv">
              ${row.source_id || project.lead_source ? `<dt>${esc(term('crm.source', 'Source'))}</dt><dd>${esc(text(project.lead_source?.source_path) || text(project.lead_source?.provider || project.lead_source?.kind || project.source).replace(/_/g, ' ') || '—')}</dd>` : ''}
              ${row.value_cents ? `<dt>${esc(L('value', 'Value'))}</dt><dd>${esc(money(row.value_cents))}</dd>` : ''}
              ${row.next_appointment_at ? `<dt>${esc(term('crm.next_appointment', 'Next appointment'))}</dt><dd>${esc(fullDate(row.next_appointment_at))}</dd>` : ''}
              ${row.next_follow_up_at ? `<dt>${esc(L('next_follow_up', 'Next follow-up'))}</dt><dd>${esc(when(row.next_follow_up_at))}</dd>` : ''}
              ${life.sold_at ? `<dt>${esc(L('won', 'Won'))}</dt><dd>${esc(fullDate(life.sold_at))}</dd>` : ''}
              ${row.feedback_rating != null && row.feedback_rating !== '' ? `<dt>${esc(term('feedback.rating', 'Rating'))}</dt><dd><span class="crm-stars" aria-label="${esc(L('rating_of', '{n} out of 5', { n: row.feedback_rating }))}">${'★'.repeat(Math.max(0, Math.min(5, Math.round(Number(row.feedback_rating) || 0))))}${'☆'.repeat(5 - Math.max(0, Math.min(5, Math.round(Number(row.feedback_rating) || 0))))}</span></dd>` : ''}
              ${project.address ? `<dt>${esc(L('address', 'Address'))}</dt><dd>${esc(project.address)}</dd>` : ''}
              ${project.created_at ? `<dt>${esc(L('created', 'Created'))}</dt><dd>${esc(fullDate(project.created_at))}</dd>` : ''}
            </dl></div>` : ''}
          ${fieldsList.length ? `<div class="crm-section"><h4>${esc(L('details', 'Details'))}</h4><dl class="crm-kv">${fieldsList.map(([k, v]) => `<dt>${esc(k)}</dt><dd>${esc(v)}</dd>`).join('')}</dl></div>` : ''}
          ${contact ? `<div class="crm-section"><h4>${esc(term('contacts.contact', 'Contact'))}</h4><dl class="crm-kv">
            ${phones.map((p) => `<dt>${esc(L('phone', 'Phone'))}</dt><dd><a href="tel:${esc(p)}">${esc(p)}</a></dd>`).join('')}
            ${emails.map((e) => `<dt>${esc(L('email', 'Email'))}</dt><dd><a href="mailto:${esc(e)}">${esc(e)}</a></dd>`).join('')}
            ${contact.address ? `<dt>${esc(L('address', 'Address'))}</dt><dd>${esc(contact.address)}</dd>` : ''}
            ${arr(contact.tags).length ? `<dt>${esc(L('tags', 'Tags'))}</dt><dd>${arr(contact.tags).map((t) => `<span class="crm-tag">${esc(t)}</span>`).join('')}</dd>` : ''}
          </dl></div>` : ''}
          ${record.contactProjects?.length ? `<div class="crm-section"><h4>${esc(term('projects.projects', 'Projects'))}</h4>${record.contactProjects.map((p) => `<div class="crm-opp"><div class="crm-opp-head"><span>${esc(p.title || p.address || p.id)}</span><span class="crm-pill">${esc(arr(fieldByKey('state')?.options).find((o) => o.value === (p.lifecycle?.new_lead ? 'new_lead' : p.lifecycle?.sold_at ? 'customer' : 'lead'))?.label || '')}</span></div></div>`).join('')}</div>` : ''}
          ${project ? `<div class="crm-section"><h4>${esc(L('history', 'History'))}</h4>${timelineHtml(record)}</div>` : ''}
        </div>`;
    }
    async function drawerAction(action, anchor){
      const record = state.drawer; if (!record) return;
      const { row, project, contact } = record;
      const phones = phonesOf(contact, row);
      if (action === 'call') return window.Portal?.Communications?.open?.({ project_id: project?.id || '', contact_id: contact?.id || row.contact_id || '', customer_name: contact?.name || row.contact_name || '', customer_number: phones[0] || '' });
      if (action === 'text') return openProjectWindow(project, 'comms');
      if (action === 'open') return openProjectWindow(project);
      if (action === 'open_contact') return window.Portal?.modules?.contacts?.open?.(contact);
      if (action === 'book') return window.FirstMateBooking.open({ orgId, projectId: project.id, lockProject: true, onBooked: () => { toast(L('booked', 'Booked')); query(); openDrawer(row.id); } });
      if (action === 'result') { const slot = host.querySelector('.crm-drawer [data-result-slot]'); if (slot) mountResultForm(slot, row, project, contact, { onDone: () => { query(); openDrawer(row.id); } }); return; }
      if (action === 'start_scope') return bulkStartScope(anchor, [row], () => { query(); openDrawer(row.id); });
      if (action === 'cancel_sale') {
        const reason = await promptDialog(L('cancel_reason', 'What did the customer say?'), '', { title: L('customer_cancelled', 'Customer cancelled') });
        if (reason === null || reason === undefined) return;
        try { await api().cancelSale(orgId, project.id, text(reason)); toast(L('sale_cancelled', 'The sale is cancelled and its work stopped.')); query(); openDrawer(row.id); }
        catch (error) { toast(error?.message || L('failed', 'That did not work.'), false); }
        return;
      }
      if (action === 'more') {
        const el = openPop(anchor, `<button type="button" class="crm-pop-item" data-dm="scope"><i class="fas fa-diagram-project"></i>${esc(L('start_scope', 'Start a scope'))}</button><button type="button" class="crm-pop-item" data-dm="lost" style="color:#b42318"><i class="fas fa-circle-xmark"></i>${esc(L('mark_lost', 'Mark lost'))}</button>`, { width: 220, alignRight: true, role:'menu' });
        el.addEventListener('click', async (e) => {
          const b = e.target.closest('[data-dm]'); if (!b) return; closePop();
          if (b.dataset.dm === 'scope') return bulkStartScope(anchor, [row], () => { query(); openDrawer(row.id); });
          const reason = await promptDialog(L('lost_reason_one', 'Why was it lost?'), L('lost', 'Lost'), { title: L('mark_lost', 'Mark lost') });
          if (reason === null || reason === undefined) return;
          try { await window.PlatformAPI.work.markProjectLost(orgId, project.id, { reason: text(reason) || 'lost' }); toast(L('marked_lost', 'Marked lost')); query(); openDrawer(row.id); } catch (error) { toast(error?.message || L('failed', 'That did not work.'), false); }
        });
      }
    }
    async function bulkStartScope(anchor, rows, done){
      const templates = arr((await window.PlatformAPI.scopes.list(orgId, 'default')).templates).filter((t) => t.enabled !== false && t.status !== 'archived');
      const rank = (t) => arr(t.definition?.category_ids).includes('sales') ? 0 : arr(t.definition?.category_ids).includes('intake') ? 1 : 2;
      templates.sort((a, b) => rank(a) - rank(b) || text(a.name).localeCompare(text(b.name)));
      const el = openPop(anchor, `<h5>${esc(L('start_scope', 'Start a scope'))}</h5><div class="crm-options">${templates.map((t) => `<button type="button" class="crm-pop-item" data-st="${esc(t.id)}">${esc(t.name || t.id)}</button>`).join('')}</div>`, { width: 280, alignRight: true });
      el.addEventListener('click', async (e) => {
        const b = e.target.closest('[data-st]'); if (!b) return; closePop();
        const results = await Promise.allSettled(rows.map((r) => window.PlatformAPI.scopes.startOnProject(orgId, r.project_id, b.dataset.st)));
        const failed = results.filter((r) => r.status === 'rejected');
        toast(failed.length ? failed[0].reason?.message || L('failed', 'That did not work.') : L('scope_started', 'Scope started'), !failed.length);
        done?.();
      });
    }
    function openProjectWindow(project, tab){
      if (!project) return;
      const open = window.Portal?.modules?.request?.openProject;
      if (open) open({ ...project }, tab ? { tab } : {});
      else window.dispatchEvent(new CustomEvent('fm:projects:open', { detail:{ project, ...(tab ? { tab } : {}) } }));
    }

    /** Recording a result: what happened, the outcome, a note, and when to try again. */
    function mountResultForm(slot, row, project, contact, options = {}){
      const outcomes = arr(state.meta?.outcomes);
      const form = { disposition: options.disposition || 'answered', outcome: '', note: '', follow_up_at: '' };
      const quick = [[1, L('tomorrow', 'Tomorrow')], [2, L('in_2_days', 'In 2 days')], [7, L('next_week', 'Next week')], [30, L('next_month', 'Next month')]];
      const render = () => {
        const chosen = outcomes.find((o) => o.id === form.outcome);
        slot.innerHTML = `<div class="${options.inline ? '' : 'crm-section'}">${options.inline ? '' : `<h4>${esc(term('crm.disposition', 'Result'))}</h4>`}
          <div class="crm-disposition" role="group" aria-label="${esc(L('what_happened', 'What happened'))}">${[['answered', L('answered', 'Talked')], ['voicemail', L('voicemail', 'Left voicemail')], ['no_answer', L('no_answer', 'No answer')], ['texted', L('texted', 'Texted')], ['met', L('met', 'Met')]].map(([v, l]) => `<button type="button" class="crm-btn small ${form.disposition === v ? 'primary' : ''}" data-rd="${v}" aria-pressed="${form.disposition === v}">${esc(l)}</button>`).join('')}</div>
          <div class="crm-outcomes">${outcomes.map((o) => `<button type="button" class="crm-outcome" data-ro="${esc(o.id)}" aria-pressed="${form.outcome === o.id}"><span class="dot" style="background:${esc(o.color || '#98a2b3')}"></span>${esc(o.label)}</button>`).join('')}</div>
          ${chosen?.action === 'reschedule' ? `<label class="crm-field"><span>${esc(L('try_again_on', 'Try again on'))}</span><input type="date" data-rf value="${esc(form.follow_up_at)}" placeholder="${esc(L('use_schedule', 'Use the follow-up schedule'))}"><div class="crm-quick">${quick.map(([d, l]) => `<button type="button" class="crm-btn small" data-rq="${d}">${esc(l)}</button>`).join('')}<span class="crm-dim" style="align-self:center">${esc(form.follow_up_at ? '' : L('blank_uses_schedule', 'Blank uses the follow-up schedule'))}</span></div></label>` : ''}
          <label class="crm-field"><span>${esc(L('note', 'Note'))}</span><textarea data-rn rows="3" placeholder="${esc(L('note_placeholder', 'What did they say?'))}">${esc(form.note)}</textarea></label>
          <div style="display:flex;gap:8px;justify-content:flex-end;margin-top:12px">${options.inline ? '' : `<button type="button" class="crm-btn small ghost" data-rcancel>${esc(L('cancel', 'Cancel'))}</button>`}<button type="button" class="crm-btn ${options.inline ? '' : 'small'} primary" data-rsave ${form.outcome ? '' : 'disabled'}>${esc(options.saveLabel || L('save_result', 'Save result'))}</button></div></div>`;
      };
      render();
      slot.onclick = async (e) => {
        const b = e.target.closest('button'); if (!b) return;
        if (b.dataset.rd) { form.disposition = b.dataset.rd; render(); }
        else if (b.dataset.ro) { form.outcome = b.dataset.ro; render(); }
        else if (b.dataset.rq) { form.follow_up_at = isoDay(new Date(Date.now() + Number(b.dataset.rq) * DAY)); render(); }
        else if (b.dataset.rcancel !== undefined) slot.innerHTML = '';
        else if (b.dataset.rsave !== undefined) {
          b.disabled = true;
          try {
            await api().recordResult(orgId, {
              project_id: text(project?.id || row.project_id), contact_id: text(contact?.id || row.contact_id),
              entry_id: text(row.entry_id), node_id: text(row.node_id),
              disposition: form.disposition, outcome_id: form.outcome, note: form.note, follow_up_at: form.follow_up_at,
              channel: form.disposition === 'texted' ? 'text' : form.disposition === 'met' ? 'visit' : 'call'
            });
            toast(L('result_saved', 'Result saved'));
            if (!options.inline) slot.innerHTML = '';
            options.onDone?.();
          } catch (error) { b.disabled = false; toast(error?.message || L('result_failed', 'The result could not be saved.'), false); }
        }
      };
      slot.oninput = (e) => { if (e.target.matches('[data-rn]')) form.note = e.target.value; if (e.target.matches('[data-rf]')) form.follow_up_at = e.target.value; };
      slot.onchange = slot.oninput;
    }

    // ---- Worklists -------------------------------------------------------------------
    async function openWorklist(rows){
      if (!rows) {
        const total = state.result?.total || 0;
        rows = arr(state.result?.rows);
        if (total > rows.length) {
          try { const all = await api().query(orgId, { collection: state.draft.collection, definition: normalizedDefinition(state.draft.definition), search: state.search, limit: 1000 }); rows = arr(all.rows); } catch { /* the loaded rows */ }
        }
      }
      if (!rows.length) return;
      closeDrawer(false);
      state.worklist = { rows, index: 0, worked: new Set(), skipped: new Set(), record: null };
      host.querySelector('.crm-worklist').hidden = false;
      renderWorklist();
    }
    function closeWorklist(){
      const el = host.querySelector('.crm-worklist'); el.hidden = true; el.innerHTML = '';
      const worked = state.worklist?.worked.size || 0; state.worklist = null;
      if (worked) query();
    }
    async function renderWorklist(){
      const wl = state.worklist, el = host.querySelector('.crm-worklist'); if (!wl) return;
      const row = wl.rows[wl.index];
      const done = wl.worked.size + wl.skipped.size;
      if (!row) {
        el.innerHTML = `<div class="crm-wl-head"><h3>${esc(state.draft?.name || '')}</h3><span style="flex:1"></span><button type="button" class="crm-btn" data-wl-close>${esc(L('close', 'Close'))}</button></div><div class="crm-empty"><h3>${esc(L('list_done', 'You reached the end of the list'))}</h3><p>${esc(L('list_done_detail', '{worked} worked, {skipped} skipped.', { worked: wl.worked.size, skipped: wl.skipped.size }))}</p><button type="button" class="crm-btn primary" data-wl-close>${esc(L('back_to_view', 'Back to the view'))}</button></div>`;
        el.querySelectorAll('[data-wl-close]').forEach((b) => b.addEventListener('click', closeWorklist));
        return;
      }
      el.innerHTML = `<div class="crm-wl-head"><button type="button" class="crm-btn icon ghost" data-wl-close aria-label="${esc(L('close', 'Close'))}"><i class="fas fa-xmark"></i></button><h3>${esc(state.draft?.name || '')}</h3><div class="crm-wl-progress" role="progressbar" aria-valuemin="0" aria-valuemax="${wl.rows.length}" aria-valuenow="${done}"><span style="width:${Math.round(done / wl.rows.length * 100)}%"></span></div><span class="crm-dim">${esc(L('n_of_m', '{n} of {m}', { n: wl.index + 1, m: wl.rows.length }))}</span></div>
        <div class="crm-wl-body"><div class="crm-loading"></div></div>
        <div class="crm-wl-foot"><span class="crm-dim"><span class="crm-kbd">S</span> ${esc(L('skip', 'Skip'))} &nbsp; <span class="crm-kbd">Esc</span> ${esc(L('close', 'Close'))}</span><div style="display:flex;gap:8px"><button type="button" class="crm-btn" data-wl-back ${wl.index ? '' : 'disabled'}><i class="fas fa-arrow-left"></i>${esc(L('back', 'Back'))}</button><button type="button" class="crm-btn" data-wl-skip>${esc(L('skip', 'Skip'))}<i class="fas fa-arrow-right"></i></button></div></div>`;
      el.querySelector('[data-wl-close]').addEventListener('click', closeWorklist);
      el.querySelector('[data-wl-skip]').addEventListener('click', () => { wl.skipped.add(row.id); advance(); });
      el.querySelector('[data-wl-back]').addEventListener('click', () => { if (wl.index) { wl.index--; renderWorklist(); } });
      const index = wl.index;
      let record; try { record = await loadRecord(row); } catch { record = { row }; }
      if (state.worklist !== wl || wl.index !== index) return;
      wl.record = record;
      const { project, contact } = record;
      const name = contact?.name || row.contact_name || row.name || project?.title || row.title || '';
      const phones = phonesOf(contact, row), emails = emailsOf(contact, row);
      const body = el.querySelector('.crm-wl-body');
      const instance = arr(project?.work_projection?.instances).find((i) => i.status !== 'canceled');
      body.innerHTML = `
        <div class="crm-panel">
          <div class="crm-wl-person"><span class="crm-avatar">${esc(initials(name))}</span><div style="min-width:0"><h2>${esc(name || L('unnamed', 'Unnamed'))}</h2><div class="crm-dim">${esc([project?.address, instance ? `${instance.title}${instance.stage_title ? ` · ${instance.stage_title}` : ''}` : project ? term('crm.new_lead', 'New lead') : ''].filter(Boolean).join(' · '))}</div></div></div>
          <div class="crm-wl-contact">
            ${phones.map((p, i) => `<button type="button" class="crm-btn ${i ? '' : 'primary'}" data-wl-call="${esc(p)}"><i class="fas fa-phone"></i>${esc(p)}</button>`).join('')}
            ${project ? `<button type="button" class="crm-btn" data-wl-text><i class="fas fa-comment"></i>${esc(L('text', 'Text'))}</button>` : ''}
            ${emails[0] ? `<a class="crm-btn" href="mailto:${esc(emails[0])}"><i class="fas fa-envelope"></i>${esc(L('email', 'Email'))}</a>` : ''}
            ${project && feature('appointment_slots') && window.FirstMateBooking?.open ? `<button type="button" class="crm-btn" data-wl-book><i class="fas fa-calendar-plus"></i>${esc(L('set_appointment', 'Set appointment'))}</button>` : ''}
            ${project ? `<button type="button" class="crm-btn ghost" data-wl-open><i class="fas fa-arrow-up-right-from-square"></i>${esc(L('open_project', 'Open project'))}</button>` : ''}
          </div>
          <div class="crm-section" style="margin-top:8px"><h4>${esc(L('history', 'History'))}</h4>${project ? timelineHtml(record) : `<p class="crm-dim">${esc(L('no_project', 'No project.'))}</p>`}</div>
        </div>
        <div class="crm-panel"><h4 style="margin:0 0 10px;font-size:11px;letter-spacing:.05em;text-transform:uppercase;color:var(--crm-muted)">${esc(term('crm.disposition', 'Result'))}</h4><div data-wl-result></div></div>`;
      body.querySelectorAll('[data-wl-call]').forEach((b) => b.addEventListener('click', () => window.Portal?.Communications?.open?.({ project_id: project?.id || '', contact_id: contact?.id || row.contact_id || '', customer_name: name, customer_number: b.dataset.wlCall, entry_id: text(row.entry_id) })));
      body.querySelector('[data-wl-text]')?.addEventListener('click', () => openProjectWindow(project, 'comms'));
      body.querySelector('[data-wl-open]')?.addEventListener('click', () => openProjectWindow(project));
      body.querySelector('[data-wl-book]')?.addEventListener('click', () => window.FirstMateBooking.open({ orgId, projectId: project.id, lockProject: true, onBooked: () => toast(L('booked', 'Booked')) }));
      if (project || row.entry_id || row.node_id) mountResultForm(body.querySelector('[data-wl-result]'), row, project, contact, { inline: true, saveLabel: L('save_and_next', 'Save and next'), onDone: () => { wl.worked.add(row.id); advance(); } });
      else body.querySelector('[data-wl-result]').innerHTML = `<p class="crm-dim">${esc(L('no_result_target', 'This row has no project to record a result on.'))}</p>`;
    }
    function advance(){
      const wl = state.worklist; if (!wl) return;
      let next = wl.index + 1;
      while (next < wl.rows.length && (wl.worked.has(wl.rows[next].id) || wl.skipped.has(wl.rows[next].id))) next++;
      wl.index = next; renderWorklist();
    }
    function worklistKey(event){
      if (event.key.toLowerCase() === 's') { event.preventDefault(); host.querySelector('[data-wl-skip]')?.click(); }
    }

    // ---- Panels: funnel, duplicates, sources, settings ------------------------------------
    function renderPanel(){
      host.querySelector('.crm-filterbar').hidden = true; host.querySelector('.crm-savebar').hidden = true; host.querySelector('.crm-bulkbar').hidden = true;
      const content = host.querySelector('.crm-content');
      content.innerHTML = '<div class="crm-loading"></div>';
      if (state.panel === 'reports') return renderReports(content);
      if (state.panel === 'duplicates') return renderDuplicates(content);
      if (state.panel === 'sources') return renderSources(content);
      if (state.panel === 'settings') return renderSettings(content);
    }

    function periodRange(id){
      const now = new Date(), y = now.getFullYear(), m = now.getMonth();
      const start = { this_month: new Date(y, m, 1), last_month: new Date(y, m - 1, 1), last_30: new Date(Date.now() - 29 * DAY), last_90: new Date(Date.now() - 89 * DAY), this_quarter: new Date(y, Math.floor(m / 3) * 3, 1), this_year: new Date(y, 0, 1) }[id] || new Date(y, m, 1);
      const end = id === 'last_month' ? new Date(y, m, 0) : now;
      return { from: isoDay(start), to: isoDay(end) };
    }
    async function renderReports(content){
      const input = state.reportInput ||= { period:'this_month', group:'source', ...periodRange('this_month') };
      const groups = [['source', term('crm.source', 'Source')], ['source_kind', L('source_type', 'Source type')], ['scope', L('scope', 'Scope')], ['setter', L('setter', 'Setter')], ['rep', L('rep', 'Rep')], ['branch', term('branches.branch', 'Branch')], ['month', L('month', 'Month')], ['none', L('everyone', 'Everyone')]];
      content.innerHTML = `<div class="crm-page"><div class="crm-toolbar">
          <select class="crm-btn" data-rp-period aria-label="${esc(L('period', 'Period'))}">${[['this_month', L('this_month', 'This month')], ['last_month', L('last_month', 'Last month')], ['last_30', L('last_30', 'Last 30 days')], ['last_90', L('last_90', 'Last 90 days')], ['this_quarter', L('this_quarter', 'This quarter')], ['this_year', L('this_year', 'This year')], ['custom', L('custom', 'Custom…')]].map(([v, l]) => `<option value="${v}" ${input.period === v ? 'selected' : ''}>${esc(l)}</option>`).join('')}</select>
          ${input.period === 'custom' ? `<input type="date" class="crm-btn" data-rp-from value="${esc(input.from)}" aria-label="${esc(L('from', 'From'))}"><input type="date" class="crm-btn" data-rp-to value="${esc(input.to)}" aria-label="${esc(L('to', 'To'))}">` : `<span class="crm-dim">${esc(input.from)} – ${esc(input.to)}</span>`}
          <span style="flex:1"></span><span class="crm-dim">${esc(L('grouped_by', 'Grouped by'))}</span><select class="crm-btn" data-rp-group aria-label="${esc(L('grouped_by', 'Grouped by'))}">${groups.map(([v, l]) => `<option value="${v}" ${input.group === v ? 'selected' : ''}>${esc(l)}</option>`).join('')}</select>
        </div><div data-rp-body><div class="crm-loading"></div></div></div>`;
      content.querySelector('[data-rp-period]').addEventListener('change', (e) => { input.period = e.target.value; if (input.period !== 'custom') Object.assign(input, periodRange(input.period)); renderReports(content); });
      content.querySelector('[data-rp-group]').addEventListener('change', (e) => { input.group = e.target.value; renderReports(content); });
      content.querySelector('[data-rp-from]')?.addEventListener('change', (e) => { input.from = e.target.value; renderReports(content); });
      content.querySelector('[data-rp-to]')?.addEventListener('change', (e) => { input.to = e.target.value; renderReports(content); });
      let report;
      try { report = await api().funnelReport(orgId, { from: input.from, to: input.to, group: input.group }); }
      catch (error) { content.querySelector('[data-rp-body]').innerHTML = `<div class="crm-empty"><h3>${esc(L('report_failed', 'The funnel could not be loaded'))}</h3><p>${esc(error?.message || '')}</p></div>`; return; }
      state.report = report;
      const milestones = arr(report.milestones), totals = report.totals;
      const body = content.querySelector('[data-rp-body]');
      if (!totals || !totals.milestones?.[0]?.count) { body.innerHTML = `<div class="crm-empty"><h3>${esc(L('no_leads_period', 'No leads in this period'))}</h3><p>${esc(L('no_leads_period_hint', 'Pick a longer period, or check back as leads arrive.'))}</p></div>`; return; }
      const max = totals.milestones[0].count || 1;
      const showCost = report.spend_cents != null;
      const pct = (v) => v == null ? '' : `${Math.round(v * 100)}%`;
      const cell = (g, m, i) => {
        const detail = [i && m.count ? pct(m.rate_from_previous) : '', showCost && m.cost_cents ? L('cost_each', '{cost} each', { cost: money(m.cost_cents) }) : ''].filter(Boolean).join(' · ');
        return `<td><button type="button" class="crm-cell" data-rp-cell="${esc(g.key)}:${esc(m.id)}" ${m.count ? '' : 'disabled'} title="${esc(L('open_leads', 'Open these leads'))}"><b>${m.count.toLocaleString()}</b>${detail ? `<small>${esc(detail)}</small>` : ''}</button></td>`;
      };
      body.innerHTML = `
        <div class="crm-bars">${totals.milestones.map((m, i) => `<div class="crm-bar"><span>${esc(term(milestones[i]?.term, milestones[i]?.label || m.id))}</span><div class="crm-bar-track"><span style="width:${m.count ? Math.max(2, Math.round(m.count / max * 100)) : 0}%;${milestones[i]?.color ? `background:${esc(milestones[i].color)}` : ''}"></span></div><span class="crm-num"><b>${m.count.toLocaleString()}</b> ${esc(i ? pct(m.rate_from_previous) : '')}</span></div>`).join('')}</div>
        <div class="crm-report"><table><thead><tr><th>${esc(groups.find(([v]) => v === input.group)?.[1] || '')}</th>${milestones.map((m) => `<th>${esc(term(m.term, m.label))}</th>`).join('')}${showCost ? `<th>${esc(L('spend', 'Spend'))}</th>` : ''}</tr></thead>
          <tbody>${arr(report.groups).map((g) => `<tr><td>${esc(g.label)}</td>${g.milestones.map((m, i) => cell(g, m, i)).join('')}${showCost ? `<td>${esc(money(g.spend_cents) || '—')}</td>` : ''}</tr>`).join('')}</tbody>
          <tfoot><tr><td>${esc(L('total', 'Total'))}</td>${totals.milestones.map((m, i) => cell(totals, m, i)).join('')}${showCost ? `<td>${esc(money(report.spend_cents) || '—')}</td>` : ''}</tr></tfoot></table></div>
        <p class="crm-dim" style="margin-top:10px">${esc(L('cohort_note', 'Leads that arrived in the period, and how far each got. Percentages are from the step before.'))}</p>`;
      body.querySelectorAll('[data-rp-cell]').forEach((b) => b.addEventListener('click', () => {
        const [gKey, mId] = b.dataset.rpCell.split(':');
        const group = gKey === 'total' ? report.totals : arr(report.groups).find((g) => g.key === gKey);
        const ms = group?.milestones.find((m) => m.id === mId); if (!ms) return;
        const label = `${group.label} · ${term(milestones.find((m) => m.id === mId)?.term, milestones.find((m) => m.id === mId)?.label || mId)}`;
        state.panel = 'view'; state.saved = null;
        state.draft = { ...blankDraft('opportunities'), name: label, definition: { filter:{ match:'all', rules:[{ field:'id', operator:'in', value: ms.project_ids }] }, sort:[{ key:'created_at', dir:'desc' }], group_by:'', layout:'list', columns:[] } };
        renderShell(); query();
      }));
    }

    async function renderDuplicates(content){
      let list = [];
      try { const [contacts, projects] = await Promise.all([window.PlatformAPI.contacts.duplicates(orgId, 'contact'), window.PlatformAPI.contacts.duplicates(orgId, 'project')]); list = [...arr(contacts.duplicates || contacts.suggestions), ...arr(projects.duplicates || projects.suggestions)]; }
      catch (error) { content.innerHTML = `<div class="crm-empty"><h3>${esc(L('dups_failed', 'Duplicates could not be loaded'))}</h3><p>${esc(error?.message || '')}</p></div>`; return; }
      if (!list.length) { content.innerHTML = `<div class="crm-empty"><h3>${esc(L('no_dups', 'No duplicates to review'))}</h3><p>${esc(L('no_dups_hint', 'New contacts and sales are checked as they arrive; suggestions show up here.'))}</p></div>`; return; }
      const describe = async (kind, id) => {
        if (kind === 'contact') { const r = await window.PlatformAPI.contacts.get(orgId, id).catch(() => null); const c = obj(r?.contact); return { title: c.name || c.email || c.phone || id, sub: [c.phone, c.email].filter(Boolean).join(' · ') }; }
        const r = await window.PlatformAPI.projects.get(orgId, id).catch(() => null); const p = obj(r?.document?.data); return { title: p.title || p.address || id, sub: [p.customer_name, p.address].filter(Boolean).join(' · ') };
      };
      const rows = await Promise.all(list.slice(0, 50).map(async (d) => ({ ...d, a: await describe(d.kind, d.first_id), b: await describe(d.kind, d.second_id) })));
      content.innerHTML = `<div class="crm-page"><p class="crm-dim" style="margin-top:0">${esc(L('dups_intro', 'Pick which record to keep; the other is merged into it. Merging cannot be undone.'))}</p>${rows.map((d, i) => `<div class="crm-dup"><div><b>${esc(d.a.title)}</b><div class="crm-dim">${esc(d.a.sub)}</div></div><div><b>${esc(d.b.title)}</b><div class="crm-dim">${esc(d.b.sub)}</div></div><div style="display:flex;gap:6px;flex-wrap:wrap"><button type="button" class="crm-btn small" data-dup-keep="${i}:a">${esc(L('keep_left', 'Keep left'))}</button><button type="button" class="crm-btn small" data-dup-keep="${i}:b">${esc(L('keep_right', 'Keep right'))}</button><button type="button" class="crm-btn small ghost" data-dup-dismiss="${i}">${esc(L('not_duplicates', 'Not the same'))}</button></div><div class="crm-dim" style="grid-column:1/-1;font-size:12px">${esc(d.kind === 'project' ? L('same_sale', 'Possibly one sale that came in twice') : L('same_person', 'Possibly the same person'))}${arr(d.reasons).length ? ` · ${esc(arr(d.reasons).join(', ').replace(/_/g, ' '))}` : ''}</div></div>`).join('')}</div>`;
      content.onclick = async (e) => {
        const keep = e.target.closest('[data-dup-keep]'), dismiss = e.target.closest('[data-dup-dismiss]');
        if (!keep && !dismiss) return;
        const [i, side] = (keep?.dataset.dupKeep || dismiss.dataset.dupDismiss).split(':'); const d = rows[Number(i)];
        try {
          if (dismiss) await window.PlatformAPI.contacts.dismissDuplicate(orgId, d.kind, d.first_id, d.second_id);
          else {
            const survivor = side === 'a' ? d.first_id : d.second_id, merged = side === 'a' ? d.second_id : d.first_id;
            if (!(await confirmDialog(L('merge_confirm', 'Merge these? This cannot be undone.'), { okLabel: L('merge', 'Merge') }))) return;
            if (d.kind === 'contact') await window.PlatformAPI.contacts.merge(orgId, survivor, merged, {}); else await window.PlatformAPI.contacts.mergeProjects(orgId, survivor, merged);
          }
          toast(dismiss ? L('dismissed', 'Dismissed') : L('merged', 'Merged')); renderDuplicates(content);
        } catch (error) { toast(error?.message || L('failed', 'That did not work.'), false); }
      };
    }

    const SOURCE_FIELDS = [['lead_source.kind', L('lead_type', 'How it arrived')], ['lead_source.provider', L('provider', 'Provider')], ['lead_source.utm_source', L('utm_source', 'UTM source')], ['lead_source.utm_medium', L('utm_medium', 'UTM medium')], ['lead_source.utm_campaign', L('utm_campaign', 'UTM campaign')], ['lead_source.gclid', L('gclid', 'Google ad click')], ['lead_source.fbclid', L('fbclid', 'Facebook ad click')], ['lead_source.page_url', L('page_url', 'Page address')], ['lead_source.form_id', L('form', 'Form')], ['lead_source.tracking_number', L('tracking_number', 'Tracking number')], ['lead_source.connection_id', L('connection', 'Connection')]];
    const SOURCE_OPERATORS = { equals: L('is', 'is'), in: L('is_any_of', 'is any of'), contains: L('contains', 'contains'), not_equals: L('is_not', 'is not'), starts_with: L('starts_with', 'starts with'), is_present: L('is_set', 'is set'), is_missing: L('is_empty', 'is empty') };
    async function renderSources(content){
      let sources = [], channels = [], spend = [];
      try { const r = await api().sources(orgId); sources = arr(r.sources); channels = arr(r.channels); if (feature('source_spend') && state.meta?.can_share_views) spend = arr((await api().spend(orgId)).spend); }
      catch (error) { content.innerHTML = `<div class="crm-empty"><h3>${esc(L('sources_failed', 'Sources could not be loaded'))}</h3><p>${esc(error?.message || '')}</p></div>`; return; }
      const canEdit = state.meta?.can_share_views === true;
      const draft = sources.map(({ path_label: _p, depth: _d, ...s }) => clone(s));
      const byId = new Map(sources.map((s) => [s.id, s]));
      const ruleText = (s) => arr(s.rules?.rules).map((r) => {
        const field = SOURCE_FIELDS.find(([k]) => k === r.field)?.[1] || text(r.field).replace(/^lead_source\./, '').replace(/_/g, ' ');
        const value = ['is_present', 'is_missing'].includes(r.operator) ? '' : (Array.isArray(r.value) ? r.value : [r.value]).map((v) => text(v).replace(/_/g, ' ')).join(', ');
        return [field, SOURCE_OPERATORS[r.operator] || text(r.operator).replace(/_/g, ' '), value].filter(Boolean).join(' ');
      }).join(` ${s.rules?.match === 'any' ? L('or', 'or') : L('and', 'and')} `);
      content.innerHTML = `<div class="crm-page">
        <p class="crm-dim" style="margin-top:0">${esc(L('sources_intro', 'Where leads come from. A new lead gets the most specific source whose rules match it; a person can correct it on the lead.'))}</p>
        ${canEdit ? `<div class="crm-toolbar"><button type="button" class="crm-btn" data-src-add><i class="fas fa-plus"></i>${esc(L('add_source', 'Add a source'))}</button></div>` : ''}
        <ul class="crm-tree">${sources.map((s) => `<li style="padding-left:${10 + (s.depth || 0) * 22}px"><i class="fas ${s.depth ? 'fa-turn-up fa-rotate-90' : 'fa-circle-dot'} crm-dim"></i><div style="flex:1;min-width:0"><b>${esc(s.label)}</b> <span class="crm-tag">${esc(s.channel.replace(/_/g, ' '))}</span>${s.active ? '' : ` <span class="crm-tag">${esc(L('inactive', 'Off'))}</span>`}<div class="crm-dim" style="font-size:12px">${esc(ruleText(s) || L('no_rules', 'Matched by hand only'))}</div></div>${canEdit ? `<button type="button" class="crm-btn small" data-src-child="${esc(s.id)}">${esc(L('add_sub', 'Add under'))}</button><button type="button" class="crm-btn small" data-src-edit="${esc(s.id)}">${esc(L('edit', 'Edit'))}</button>` : ''}</li>`).join('') || `<li class="crm-dim">${esc(L('no_sources', 'No sources yet.'))}</li>`}</ul>
        ${feature('source_spend') && canEdit ? `<h3 style="margin:24px 0 8px;font-size:14px">${esc(L('spend', 'Spend'))}</h3><div class="crm-toolbar"><button type="button" class="crm-btn" data-spend-add ${sources.length ? '' : 'disabled'}><i class="fas fa-plus"></i>${esc(L('add_spend', 'Add spend'))}</button></div><div class="crm-report"><table><thead><tr><th>${esc(term('crm.source', 'Source'))}</th><th>${esc(L('period', 'Period'))}</th><th>${esc(L('amount', 'Amount'))}</th><th></th></tr></thead><tbody>${spend.map((x) => `<tr><td>${esc(byId.get(x.source_id)?.path_label || x.source_id)}</td><td>${esc(x.period_start)} – ${esc(x.period_end)}</td><td>${esc(money(x.amount_cents))}</td><td><button type="button" class="crm-btn small ghost" data-spend-del="${esc(x.id)}" aria-label="${esc(L('delete', 'Delete'))}"><i class="fas fa-trash"></i></button></td></tr>`).join('') || `<tr><td colspan="4" class="crm-dim" style="text-align:left">${esc(L('no_spend', 'No spend entered yet.'))}</td></tr>`}</tbody></table></div>` : ''}
      </div>`;
      const editSource = (anchor, source) => {
        const s = source || { id: '', label: '', parent_id: '', channel: 'other', rules: { match:'all', rules:[] }, active: true, position: draft.length };
        const isNew = !source;
        const rules = clone(arr(s.rules?.rules));
        const el = openPop(anchor, '', { width: 460 });
        const render = () => {
          el.innerHTML = `<h5>${esc(isNew ? L('add_source', 'Add a source') : L('edit_source', 'Edit source'))}</h5>
            <label class="crm-field" style="margin:6px 4px"><span>${esc(L('name', 'Name'))}</span><input type="text" data-sl value="${esc(s.label)}" autofocus></label>
            <label class="crm-field" style="margin:6px 4px"><span>${esc(L('channel', 'Channel'))}</span><select data-sc>${channels.map((c) => `<option value="${c}" ${s.channel === c ? 'selected' : ''}>${esc(c.replace(/_/g, ' '))}</option>`).join('')}</select></label>
            <label class="crm-field" style="margin:6px 4px"><span>${esc(L('under', 'Under'))}</span><select data-sp><option value="">${esc(L('top_level', 'Top level'))}</option>${draft.filter((x) => x.id !== s.id).map((x) => `<option value="${esc(x.id)}" ${s.parent_id === x.id ? 'selected' : ''}>${esc(byId.get(x.id)?.path_label || x.label)}</option>`).join('')}</select></label>
            <h5>${esc(L('matches_when', 'A lead gets this source when'))}</h5>
            ${rules.map((r, i) => `<div class="crm-frow" style="grid-template-columns:minmax(0,1fr) 110px minmax(0,1fr) 28px"><select data-rf="${i}">${SOURCE_FIELDS.map(([k, l]) => `<option value="${k}" ${r.field === k ? 'selected' : ''}>${esc(l)}</option>`).join('')}</select><select data-ro="${i}">${[['equals', L('is', 'is')], ['contains', L('contains', 'contains')], ['in', L('is_any_of', 'is any of')]].map(([v, l]) => `<option value="${v}" ${r.operator === v ? 'selected' : ''}>${esc(l)}</option>`).join('')}</select><input type="text" data-rv="${i}" value="${esc(Array.isArray(r.value) ? r.value.join(', ') : r.value)}"><button type="button" class="crm-btn icon ghost" data-rx="${i}" aria-label="${esc(L('remove', 'Remove'))}"><i class="fas fa-xmark"></i></button></div>`).join('')}
            <div class="crm-pop-row"><button type="button" class="crm-btn small ghost" data-radd><i class="fas fa-plus"></i>${esc(L('add_condition', 'Add condition'))}</button></div>
            <label class="crm-option"><input type="checkbox" data-sa ${s.active ? 'checked' : ''}>${esc(L('active', 'On'))}</label>
            <div class="crm-pop-foot">${isNew ? '' : `<button type="button" class="crm-btn small ghost" data-sdel style="color:#b42318;margin-right:auto">${esc(L('delete', 'Delete'))}</button>`}<button type="button" class="crm-btn small ghost" data-scancel>${esc(L('cancel', 'Cancel'))}</button><button type="button" class="crm-btn small primary" data-ssave>${esc(L('save', 'Save'))}</button></div>`;
        };
        render();
        el.addEventListener('change', (e) => { const t = e.target; if (t.dataset.rf) rules[Number(t.dataset.rf)].field = t.value; if (t.dataset.ro) rules[Number(t.dataset.ro)].operator = t.value; });
        el.addEventListener('input', (e) => { const t = e.target; if (t.dataset.rv) { const r = rules[Number(t.dataset.rv)]; r.value = r.operator === 'in' ? t.value.split(',').map(text).filter(Boolean) : t.value; } });
        el.addEventListener('click', async (e) => {
          const b = e.target.closest('button'); if (!b) return;
          if (b.dataset.radd !== undefined) { rules.push({ field:'lead_source.kind', operator:'equals', value:'' }); s.label = el.querySelector('[data-sl]').value; render(); }
          else if (b.dataset.rx !== undefined) { rules.splice(Number(b.dataset.rx), 1); render(); }
          else if (b.dataset.scancel !== undefined) closePop();
          else if (b.dataset.sdel !== undefined || b.dataset.ssave !== undefined) {
            const label = text(el.querySelector('[data-sl]').value);
            let next = draft.filter((x) => x.id !== s.id);
            if (b.dataset.ssave !== undefined) {
              if (!label) return toast(L('name_required', 'Give it a name.'), false);
              const id = s.id || label.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 50) || `source_${Date.now().toString(36)}`;
              const unique = s.id ? id : (draft.some((x) => x.id === id) ? `${id}_${Date.now().toString(36).slice(-4)}` : id);
              next = [...next, { ...s, id: unique, label, channel: el.querySelector('[data-sc]').value, parent_id: el.querySelector('[data-sp]').value, active: el.querySelector('[data-sa]').checked, rules: { match:'all', rules: rules.map((r) => ({ ...r, value: r.operator === 'in' && !Array.isArray(r.value) ? text(r.value).split(',').map(text).filter(Boolean) : r.value })).filter((r) => text(Array.isArray(r.value) ? r.value.join('') : r.value)) } }];
            } else next = next.map((x) => x.parent_id === s.id ? { ...x, parent_id: s.parent_id } : x);
            try { await api().saveSources(orgId, next); closePop(); toast(L('saved', 'Saved')); renderSources(content); } catch (error) { toast(error?.message || L('save_failed', 'Not saved.'), false); }
          }
        });
      };
      content.onclick = async (e) => {
        const b = e.target.closest('button'); if (!b) return;
        if (b.dataset.srcAdd !== undefined) editSource(b, null);
        if (b.dataset.srcEdit) editSource(b, draft.find((x) => x.id === b.dataset.srcEdit));
        if (b.dataset.srcChild) { editSource(b, null); const sel = state.pop?.el.querySelector('[data-sp]'); if (sel) sel.value = b.dataset.srcChild; }
        if (b.dataset.spendDel) { if (!(await confirmDialog(L('delete_spend', 'Delete this spend entry?'), { danger:true }))) return; await api().deleteSpend(orgId, b.dataset.spendDel).catch((err) => toast(err.message, false)); renderSources(content); }
        if (b.dataset.spendAdd !== undefined) {
          const month = periodRange('this_month');
          const el = openPop(b, `<h5>${esc(L('add_spend', 'Add spend'))}</h5><label class="crm-field" style="margin:6px 4px"><span>${esc(term('crm.source', 'Source'))}</span><select data-xs>${sources.map((s) => `<option value="${esc(s.id)}">${esc(s.path_label)}</option>`).join('')}</select></label><div class="crm-pop-row"><input type="date" data-xf value="${month.from}" aria-label="${esc(L('from', 'From'))}"><input type="date" data-xt value="${isoDay(new Date(new Date().getFullYear(), new Date().getMonth() + 1, 0))}" aria-label="${esc(L('to', 'To'))}"></div><label class="crm-field" style="margin:6px 4px"><span>${esc(L('amount', 'Amount'))}</span><input type="number" min="0" step="1" data-xa placeholder="0"></label><div class="crm-pop-foot"><button type="button" class="crm-btn small primary" data-xsave>${esc(L('save', 'Save'))}</button></div>`, { width: 320 });
          el.querySelector('[data-xsave]').addEventListener('click', async () => {
            try { await api().saveSpend(orgId, 'new', { source_id: el.querySelector('[data-xs]').value, period_start: el.querySelector('[data-xf]').value, period_end: el.querySelector('[data-xt]').value, amount_cents: Math.round(Number(el.querySelector('[data-xa]').value || 0) * 100) }); closePop(); renderSources(content); }
            catch (error) { toast(error?.message || L('save_failed', 'Not saved.'), false); }
          });
        }
      };
    }

    /** Setting the CRM up for an industry and a team size: adds what the organization does not have yet. */
    async function renderSetup(section){
      if (!section) return;
      let packs = [];
      try { packs = arr((await api().presets(orgId)).packs); } catch { section.remove(); return; }
      const pick = { industry: packs[0]?.id || 'general', employees: 5, capabilities: true };
      const render = async () => {
        let tier = null; try { tier = (await api().presets(orgId, pick.employees)).tier; } catch { /* shown without it */ }
        section.innerHTML = `<h3 style="margin:0 0 4px;font-size:15px">${esc(L('setup', 'Set up for your business'))}</h3><p class="crm-dim" style="margin:0 0 12px">${esc(L('setup_intro', 'Adds the views, sources, funnel, cancellation rules and sales scopes that fit your kind of business. Nothing you already set is replaced.'))}</p>
          <div class="crm-packs" role="radiogroup" aria-label="${esc(L('kind_of_business', 'Kind of business'))}">${packs.map((p) => `<label class="crm-pack ${pick.industry === p.id ? 'on' : ''}"><input type="radio" name="crm-pack" value="${esc(p.id)}" ${pick.industry === p.id ? 'checked' : ''}><b>${esc(p.label)}</b><span class="crm-dim">${esc(p.description)}</span></label>`).join('')}</div>
          <div class="crm-toolbar" style="margin-top:12px"><label class="crm-field" style="margin:0;max-width:200px"><span>${esc(L('team_size', 'People on the team'))}</span><input type="number" min="1" max="100000" data-su-size value="${esc(pick.employees)}"></label>
          <label class="crm-option" style="align-self:flex-end"><input type="checkbox" data-su-caps ${pick.capabilities ? 'checked' : ''}>${esc(L('setup_features', 'Turn features on or off to fit this size'))}</label></div>
          ${tier && pick.capabilities ? `<p class="crm-dim" style="margin:8px 0 0">${esc(L('setup_tier', 'For this size: {on}.', { on: Object.entries(tier.capabilities).filter(([, v]) => v).map(([k]) => ({ 'crm.views': L('f_views', 'views'), 'crm.sources': L('f_sources', 'sources'), 'crm.worklists': L('f_worklists', 'worklists'), 'crm.funnel': L('f_funnel', 'the funnel'), 'crm.call_lists': L('f_call_lists', 'call lists'), 'crm.source_spend': L('f_spend', 'spend and cost per lead') }[k] || k)).join(', ') }))}</p>` : ''}
          <div class="crm-toolbar" style="margin-top:12px"><span style="flex:1"></span><button type="button" class="crm-btn primary" data-su-apply>${esc(L('setup_apply', 'Set it up'))}</button></div>`;
      };
      await render();
      section.addEventListener('change', (e) => {
        if (e.target.name === 'crm-pack') { pick.industry = e.target.value; render(); }
        if (e.target.matches('[data-su-size]')) { pick.employees = Math.max(1, Number(e.target.value) || 1); render(); }
        if (e.target.matches('[data-su-caps]')) { pick.capabilities = e.target.checked; render(); }
      });
      section.addEventListener('click', async (e) => {
        const b = e.target.closest('[data-su-apply]'); if (!b) return;
        b.disabled = true;
        try {
          const { applied } = await api().applyPreset(orgId, pick);
          const parts = [applied.views ? L('n_views', '{n} views', { n: applied.views }) : '', applied.sources ? L('n_sources', '{n} sources', { n: applied.sources }) : '', applied.funnel ? L('a_funnel', 'a funnel') : '', applied.rescission ? L('a_rescission', 'cancellation rules') : '', ...arr(applied.scopes).map((id) => L('a_scope', 'the {id} scope', { id: id.replace(/_/g, ' ') }))].filter(Boolean);
          toast(parts.length ? L('setup_added', 'Added {what}.', { what: parts.join(', ') }) : L('setup_nothing', 'You already had everything in this preset.'));
          await boot();
        } catch (error) { b.disabled = false; toast(error?.message || L('failed', 'That did not work.'), false); }
      });
    }

    async function renderSettings(content){
      let funnel = null, rescission = null;
      try { [funnel, rescission] = await Promise.all([feature('funnel') ? api().funnel(orgId).then((r) => r.funnel) : null, feature('rescission') ? api().rescission(orgId).then((r) => r.rescission) : null]); }
      catch (error) { content.innerHTML = `<div class="crm-empty"><h3>${esc(L('settings_failed', 'Settings could not be loaded'))}</h3><p>${esc(error?.message || '')}</p></div>`; return; }
      const EVENTS = [['lead.received', L('ev_lead', 'A lead arrives')], ['project.event_scheduled', L('ev_scheduled', 'An appointment is booked')], ['appointment.confirmed', L('ev_confirmed', 'An appointment is confirmed')], ['project.event.completed', L('ev_completed', 'An appointment is completed')], ['document.sent', L('ev_doc_sent', 'A document is sent')], ['document.signed', L('ev_doc_signed', 'A document is signed')], ['payment.received', L('ev_paid', 'A payment is received')], ['opportunity.won', L('ev_won', 'The sale is won')], ['opportunity.lost', L('ev_lost', 'The sale is lost')], ['work.node.completed', L('ev_step_done', 'A scope step is completed')], ['work.node.skipped', L('ev_step_skipped', 'A scope step is skipped')], ['crm.disposition.recorded', L('ev_result', 'A result is recorded')]];
      content.innerHTML = `<div class="crm-page">
        ${state.meta?.can_share_views ? `<section class="crm-panel" style="margin-bottom:16px" data-setup><div class="crm-loading"></div></section>` : ''}
        ${funnel ? `<section class="crm-panel" style="margin-bottom:16px"><h3 style="margin:0 0 4px;font-size:15px">${esc(term('crm.funnel', 'Funnel'))}</h3><p class="crm-dim" style="margin:0 0 12px">${esc(L('funnel_intro', 'Each step is reached when the first matching event happens on a lead. Reports count leads by the steps they reached.'))}</p>
          <div data-funnel></div>
          <div class="crm-toolbar" style="margin-top:12px"><button type="button" class="crm-btn" data-fn-add><i class="fas fa-plus"></i>${esc(L('add_step', 'Add a step'))}</button><span style="flex:1"></span><button type="button" class="crm-btn primary" data-fn-save>${esc(L('save', 'Save'))}</button></div></section>` : ''}
        ${rescission ? `<section class="crm-panel"><h3 style="margin:0 0 4px;font-size:15px">${esc(L('rescission', 'Cancellation windows'))}</h3><p class="crm-dim" style="margin:0 0 12px">${esc(L('rescission_intro', 'How long a customer may cancel a sale. A scope with a cancellation step uses the first rule that matches; without one, the sale has no window.'))}</p>
          <label class="crm-option"><input type="checkbox" data-rs-enabled ${rescission.enabled ? 'checked' : ''}>${esc(L('rescission_on', 'Use cancellation windows'))}</label>
          <div data-rescission></div>
          <div class="crm-toolbar" style="margin-top:12px"><button type="button" class="crm-btn" data-rs-add><i class="fas fa-plus"></i>${esc(L('add_rule', 'Add a rule'))}</button><span style="flex:1"></span><button type="button" class="crm-btn primary" data-rs-save>${esc(L('save', 'Save'))}</button></div></section>` : ''}
        ${!funnel && !rescission && !state.meta?.can_share_views ? `<div class="crm-empty"><h3>${esc(L('no_settings', 'Nothing to set here'))}</h3><p>${esc(L('no_settings_hint', 'Turn on the funnel or cancellation windows in the CRM app settings.'))}</p></div>` : ''}
      </div>`;
      const steps = clone(arr(funnel?.milestones));
      const rules = clone(arr(rescission?.rules));
      const renderFunnel = () => {
        const host2 = content.querySelector('[data-funnel]'); if (!host2) return;
        host2.innerHTML = steps.map((m, i) => `<div class="crm-frow" style="grid-template-columns:24px minmax(0,1fr) minmax(0,1.2fr) minmax(0,1fr) 28px"><span class="crm-dim" style="font-weight:800">${i + 1}</span><input type="text" data-fl="${i}" value="${esc(m.label)}" aria-label="${esc(L('step_name', 'Step name'))}"><select data-fe="${i}" aria-label="${esc(L('reached_when', 'Reached when'))}">${EVENTS.map(([v, l]) => `<option value="${v}" ${m.when?.[0]?.event === v ? 'selected' : ''}>${esc(l)}</option>`).join('')}${m.when?.[0] && !EVENTS.some(([v]) => v === m.when[0].event) ? `<option value="${esc(m.when[0].event)}" selected>${esc(m.when[0].event)}</option>` : ''}</select><span class="crm-dim" style="font-size:12px">${esc(Object.keys(obj(m.when?.[0]?.conditions)).length || (m.when?.length > 1) ? L('with_conditions', 'with conditions') : '')}${m.unless?.length ? ` · ${esc(L('unless', 'unless {steps}', { steps: m.unless.map((u) => steps.find((s) => s.id === u)?.label || u).join(', ') }))}` : ''}</span><button type="button" class="crm-btn icon ghost" data-fx="${i}" aria-label="${esc(L('remove', 'Remove'))}"><i class="fas fa-xmark"></i></button></div>`).join('');
      };
      const renderRescission = () => {
        const host2 = content.querySelector('[data-rescission]'); if (!host2) return;
        host2.innerHTML = rules.map((r, i) => `<div class="crm-fgroup"><div class="crm-frow" style="grid-template-columns:minmax(0,1.4fr) 70px minmax(0,1fr) minmax(0,1fr) 28px"><input type="text" data-rl="${i}" value="${esc(r.label)}" aria-label="${esc(L('rule_name', 'Rule name'))}"><input type="number" min="0" max="60" data-rdays="${i}" value="${esc(r.days)}" aria-label="${esc(L('days', 'Days'))}"><select data-rc="${i}" aria-label="${esc(L('counting', 'Counting'))}"><option value="business" ${r.count === 'business' ? 'selected' : ''}>${esc(L('business_days', 'Business days (not Sundays)'))}</option><option value="weekdays" ${r.count === 'weekdays' ? 'selected' : ''}>${esc(L('weekdays', 'Weekdays'))}</option><option value="calendar" ${r.count === 'calendar' ? 'selected' : ''}>${esc(L('calendar_days', 'Calendar days'))}</option></select><select data-rh="${i}" aria-label="${esc(L('holidays', 'Holidays'))}"><option value="us_federal" ${r.holidays !== 'none' ? 'selected' : ''}>${esc(L('no_federal_holidays', 'Skip federal holidays'))}</option><option value="none" ${r.holidays === 'none' ? 'selected' : ''}>${esc(L('count_holidays', 'Count holidays'))}</option></select><button type="button" class="crm-btn icon ghost" data-rx2="${i}" aria-label="${esc(L('remove', 'Remove'))}"><i class="fas fa-xmark"></i></button></div>
          <div class="crm-pop-row"><span class="crm-dim" style="white-space:nowrap">${esc(L('applies_when', 'Applies when'))}</span><select data-rcf="${i}" style="max-width:200px">${[['', L('always', 'Always')], ['address.state', L('state', 'State')], ['contact.age', L('customer_age', 'Customer age')], ['lead_source.kind', L('lead_type', 'How it arrived')]].map(([v, l]) => `<option value="${v}" ${(r.conditions?.rules?.[0]?.field || '') === v ? 'selected' : ''}>${esc(l)}</option>`).join('')}</select>${r.conditions?.rules?.[0] ? `<select data-rco="${i}" style="max-width:130px">${[['in', L('is_any_of', 'is any of')], ['greater_or_equal', L('is_at_least', 'is at least')], ['equals', L('is', 'is')]].map(([v, l]) => `<option value="${v}" ${r.conditions.rules[0].operator === v ? 'selected' : ''}>${esc(l)}</option>`).join('')}</select><input type="text" data-rcv="${i}" value="${esc(Array.isArray(r.conditions.rules[0].value) ? r.conditions.rules[0].value.join(', ') : r.conditions.rules[0].value)}" placeholder="${esc(L('rule_value_hint', 'CA, NY  or  65'))}">` : ''}</div></div>`).join('') || `<p class="crm-dim">${esc(L('no_rules_yet', 'No rules yet. The federal cooling-off rule is three business days.'))}</p>`;
      };
      renderFunnel(); renderRescission(); renderSetup(content.querySelector('[data-setup]'));
      content.oninput = (e) => {
        const t = e.target;
        if (t.dataset.fl) steps[Number(t.dataset.fl)].label = t.value;
        if (t.dataset.rl) rules[Number(t.dataset.rl)].label = t.value;
        if (t.dataset.rdays) rules[Number(t.dataset.rdays)].days = Number(t.value || 0);
        if (t.dataset.rcv) { const c = rules[Number(t.dataset.rcv)].conditions.rules[0]; c.value = c.operator === 'in' ? t.value.split(',').map(text).filter(Boolean) : (c.field === 'contact.age' ? Number(t.value) : t.value); }
      };
      content.onchange = (e) => {
        const t = e.target;
        if (t.dataset.fe) { steps[Number(t.dataset.fe)].when = [{ event: t.value, conditions: {} }]; renderFunnel(); }
        if (t.dataset.rc) rules[Number(t.dataset.rc)].count = t.value;
        if (t.dataset.rh) rules[Number(t.dataset.rh)].holidays = t.value;
        if (t.dataset.rcf !== undefined) { const r = rules[Number(t.dataset.rcf)]; r.conditions = t.value ? { match:'all', rules:[{ field: t.value, operator: t.value === 'contact.age' ? 'greater_or_equal' : 'in', value: t.value === 'contact.age' ? 65 : [] }] } : {}; renderRescission(); }
        if (t.dataset.rco) { const c = rules[Number(t.dataset.rco)].conditions.rules[0]; c.operator = t.value; }
      };
      content.onclick = async (e) => {
        const b = e.target.closest('button'); if (!b) return;
        if (b.dataset.fnAdd !== undefined) { steps.push({ id: `step_${Date.now().toString(36)}`, label: L('new_step', 'New step'), when:[{ event:'opportunity.won', conditions:{} }], unless:[], credit:'', term:'', color:'' }); renderFunnel(); }
        if (b.dataset.fx !== undefined) { const [gone] = steps.splice(Number(b.dataset.fx), 1); steps.forEach((s) => { s.unless = arr(s.unless).filter((u) => u !== gone.id); }); renderFunnel(); }
        if (b.dataset.fnSave !== undefined) { try { await api().saveFunnel(orgId, { milestones: steps }); toast(L('saved', 'Saved')); } catch (error) { toast(error?.message || L('save_failed', 'Not saved.'), false); } }
        if (b.dataset.rsAdd !== undefined) { rules.push({ id: `rule_${Date.now().toString(36)}`, label: L('federal_rule', 'Federal cooling-off rule'), days: 3, count:'business', holidays:'us_federal', conditions:{}, note:'' }); renderRescission(); }
        if (b.dataset.rx2 !== undefined) { rules.splice(Number(b.dataset.rx2), 1); renderRescission(); }
        if (b.dataset.rsSave !== undefined) { try { await api().saveRescission(orgId, { enabled: content.querySelector('[data-rs-enabled]').checked, rules }); toast(L('saved', 'Saved')); } catch (error) { toast(error?.message || L('save_failed', 'Not saved.'), false); } }
      };
    }

    boot();
    const unregisterRoute = navigation?.registerHandler?.(`crm:${context.instanceId || 'main'}`, {
      priority: 400,
      apply: (route) => {
        if (route.tab !== 'crm' || !state.meta) return;
        if (text(route.crmPanel) && text(route.crmPanel) !== state.panel) openPanel(text(route.crmPanel));
        else if (text(route.crmView) && text(route.crmView) !== state.draft?.id) openView(text(route.crmView), { history:false });
      }
    });
    return { destroy(){ unregisterRoute?.(); document.removeEventListener('keydown', onDocumentKey); document.removeEventListener('mousedown', onOutside, true); host.remove(); } };
  }

  function ensureStyles(){
    if (document.getElementById('crm-app-styles')) return;
    const link = document.createElement('link');
    link.id = 'crm-app-styles'; link.rel = 'stylesheet';
    const script = SCRIPT_SRC || [...document.scripts].map((s) => s.src).find((s) => /\/apps\/crm\/app\.js/.test(s)) || '';
    link.href = script ? script.replace(/app\.js(\?.*)?$/, 'crm.css$1') : '../libraries/apps/crm/crm.css';
    document.head.appendChild(link);
  }

  runtime.registerApp({
    id:'portal.crm', package:'crm', kind:'portal_tab',
    title: globalThis.PlatformTerminology?.get?.('crm.portal_tab', 'CRM') || 'CRM', label: globalThis.PlatformTerminology?.get?.('crm.portal_tab', 'CRM') || 'CRM',
    icon:'fa-filter', surfaces:['portal_tab'], regions:['main'], visible:true,
    access:{ applicationsAny:['management'], capability:'apps.crm' },
    mount
  });
})();
