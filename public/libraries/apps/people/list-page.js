/* public/libraries/apps/people/list-page.js
 *
 * The People list page: one header line and a dense list of rows. Used by
 * Users today; Groups, Departments and Subcontractors mount the same thing.
 *
 *   const list = FirstMatePeople.listPage.mount(container, {
 *     icon: 'fa-users',                       // top-left icon
 *     title: 'Users',                         // the single title (no pre-title)
 *     subtitle: '42 users, 3 never signed in',// the count, in English
 *     search: { placeholder, value, onInput(query) },
 *     filters: { items:[{ id, label, count, tooltip }], value, onChange(id) },   // chips before the search; list.setFilters(items, value) updates them
 *     actions: [{ id, label, icon, primary, menu, tooltip, onClick(button) }],   // right of the search, one line
 *                                             // list.controlHost: an empty slot between the search and the actions (the branch filter)
 *     empty: { icon, title, action:{ label, onClick(button) } },   // no rows: one line and one action
 *     embedded: true,                         // inside a modal tab: no icon or title, the count leads the line
 *     row(item, { section }) => ({            // how one item becomes a row; section is the key of the section it is drawn in, if any
 *       key,                                  // stable id
 *       entity: { id, name, photoUrl, icon, color },   // for the photo
 *       online: userId,                       // presence dot on the photo
 *       photoAction: 'Change photo',          // makes the photo a button that picks an image
 *       title, secondary,                     // name and the line under it
 *       pills: [{ label, tone, icon, tooltip }],        // beside the name
 *       aside: html,                          // fixed block before the chips (kit.stack of members)
 *       chipGroups: [{ chips:[{ label, tone, color, tooltip }], tone }],   // right side, whole chips that fit, then +N
 *       actions: [{ id, icon, label, tone, disabled }], // quick actions, inline on hover and focus
 *       hover: 'organization_user:ana',       // key the hover card resolves
 *       dimmed: false
 *     }),
 *     onOpen(item, rowElement),               // click or Enter on a row
 *     onAction(actionId, item, button),       // a quick action
 *     onPhoto(item, file)                     // an image was picked for the photo
 *     section(item) => ({ key, title, icon, color, tooltip, order }) | [..] | null,   // sections; an item can sit in several
 *     sorts: [{ id, label, compare(a, b), first }], sort: { id, dir }, sortStore: 'users'   // per-section sort buttons, remembered per page
 *                                             // a section header also collapses its section (remembered under the same store)
 *     columns: false                          // full-width rows instead of two columns
 *   });
 *   list.setItems(items)      list.setSubtitle(text)      list.setLoading(true)
 *   list.setError(message, retry)   list.refreshRow(key, item)  list.el   list.destroy()
 *
 * Rows flow into two columns when there is room (a grid filled column first, so
 * reading and tab order run down the first column and then the second) and one
 * below that.
 * There is no refresh button: pages refresh from platform events.
 */
(function(){
  'use strict';
  const People = window.FirstMatePeople = window.FirstMatePeople || {};
  if (People.listPage) return;
  const kit = People.kit;
  const { esc, t, tip } = kit;

  function ensureStyles(){
    if (document.getElementById('pp_list_css')) return;
    const style = document.createElement('style');
    style.id = 'pp_list_css';
    style.textContent = `
      .pp-list{display:flex;flex-direction:column;min-width:0;container-type:inline-size}
      .pp-list-head{position:sticky;top:0;z-index:3;display:flex;align-items:center;justify-content:space-between;gap:14px;padding:0 0 32px;background:var(--pp-panel)}
      .pp-list-heading{display:flex;align-items:center;gap:11px;min-width:0}
      .pp-list.embedded .pp-list-sub{color:var(--pp-strong);font-size:13px;font-weight:650}
      .pp-list-heading>i{display:grid;place-items:center;flex:none;width:36px;height:36px;border-radius:10px;background:var(--primary,#d93025);color:var(--on-primary,#fff);font-size:15px}
      .pp-list-heading>div{display:grid;gap:2px;min-width:0}
      .pp-list-heading h2{margin:0;color:var(--pp-text);font-size:18px;font-weight:700;line-height:1.2;letter-spacing:0;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
      .pp-list-sub{margin:0;min-height:15px;color:var(--pp-muted);font-size:12px;font-weight:400;line-height:1.25;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
      .pp-list-head{flex-wrap:wrap;row-gap:10px}
      /* Stuck over scrolled rows, the header covers everything up to the top of its card and fades into the rows below. */
      .pp-list-head::before,.pp-list-head::after{content:"";position:absolute;left:0;right:0;pointer-events:none;opacity:0;transition:opacity .12s ease}
      .pp-list-head::before{bottom:100%;height:var(--pp-head-cover,0px);background:var(--pp-panel)}
      .pp-list-head::after{top:100%;height:18px;background:linear-gradient(to bottom,var(--pp-panel),rgba(255,255,255,0))}
      .pp-list-head.stuck::before,.pp-list-head.stuck::after{opacity:1}
      .pp-list.embedded .pp-list-head::before,.pp-list.embedded .pp-list-head::after{display:none}
      .pp-list-tools{display:flex;align-items:center;justify-content:flex-end;gap:8px;min-width:0;flex:1 1 auto}
      .pp-list-control{display:contents}
      .pp-list-filters{flex:0 1 auto;min-width:0;overflow-x:auto;scrollbar-width:none}
      .pp-list-filters::-webkit-scrollbar{display:none}
      .pp-list-filters~.pp-search{flex-basis:170px}
      .pp-list-filters .pp-seg-count{background:var(--pp-hover);color:var(--pp-muted)}

      /* Two columns of rows, read down the first and then the second. A grid, not CSS columns: a row holds positioned controls, and those misplace inside fragmented columns. */
      .pp-list-body,.pp-list-grid{position:relative;display:grid;grid-template-columns:minmax(0,1fr);column-gap:28px;margin:0;padding:0}
      .pp-list-body.sectioned{display:flex;flex-direction:column;gap:22px}
      .pp-list-section-head{display:flex;align-items:center;gap:8px;min-width:0;min-height:28px;margin:0 0 6px;padding:0 4px 6px 8px;border-bottom:1px solid var(--pp-line-soft)}
      .pp-list-section-head h3{flex:0 1 auto;min-width:0;margin:0;color:var(--pp-text);font-size:13.5px;font-weight:700;line-height:1.3;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
      .pp-list-section-head h3.pp-list-section-title{display:flex;flex:0 1 auto;min-width:0;margin:0;overflow:visible}
      .pp-list-section-toggle{display:flex;flex:0 1 auto;align-items:center;gap:8px;min-width:0;margin:0 0 0 -6px;padding:2px 6px;border:0;border-radius:7px;background:transparent;color:var(--pp-text);font:inherit;font-size:13.5px;font-weight:700;line-height:1.3;text-align:left;cursor:pointer}
      .pp-list-section-toggle:hover{background:var(--pp-hover)}
      .pp-list-section-name{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
      .pp-list-section-chevron{flex:none;width:10px;color:var(--pp-faint);font-size:9.5px;transition:transform .16s ease}
      .pp-list-section.collapsed .pp-list-section-chevron{transform:rotate(-90deg)}
      .pp-list-section.collapsed .pp-list-section-head{margin-bottom:0}
      .pp-list-section-toggle .pp-list-section-count{font-weight:400}
      @media (prefers-reduced-motion:reduce){.pp-list-section-chevron{transition:none}}
      .pp-list-section-count{flex:none;color:var(--pp-muted);font-size:12px;font-variant-numeric:tabular-nums}
      .pp-list-section-mark{display:inline-grid;place-items:center;flex:none;width:20px;height:20px;border-radius:6px;background:var(--pp-mark);color:#fff;font-size:9.5px}
      .pp-list-section-mark.dot{width:8px;height:8px;border-radius:50%}
      .pp-list-sorts{display:flex;align-items:center;gap:1px;flex:none;margin-left:auto}
      .pp-list-sort{display:inline-flex;align-items:center;gap:4px;height:24px;padding:0 7px;border:0;border-radius:6px;background:transparent;color:var(--pp-muted);font:inherit;font-size:11.5px;font-weight:600;white-space:nowrap;cursor:pointer;transition:background .1s ease,color .1s ease}
      .pp-list-sort:hover{background:var(--pp-hover);color:var(--pp-strong)}
      .pp-list-sort[aria-pressed="true"]{background:var(--pp-hover);color:var(--pp-text)}
      .pp-list-sort>i{font-size:9px}
      @container (min-width:888px){.pp-list:not(.embedded) :is(.pp-list-body,.pp-list-grid).two{grid-template-columns:repeat(2,minmax(0,1fr));grid-auto-flow:column;grid-template-rows:repeat(var(--pp-rows,1),auto)}.pp-list:not(.embedded) :is(.pp-list-body,.pp-list-grid).two::before{content:"";position:absolute;left:50%;top:0;bottom:0;width:1px;background:var(--pp-line-soft)}}
      @container (min-width:628px){.pp-list.embedded :is(.pp-list-body,.pp-list-grid).two{grid-template-columns:repeat(2,minmax(0,1fr));grid-auto-flow:column;grid-template-rows:repeat(var(--pp-rows,1),auto)}.pp-list.embedded :is(.pp-list-body,.pp-list-grid).two::before{content:"";position:absolute;left:50%;top:0;bottom:0;width:1px;background:var(--pp-line-soft)}}
      .pp-row{position:relative;display:flex;align-items:center;gap:10px;min-width:0;height:44px;padding:0 8px;border-radius:9px;break-inside:avoid;cursor:pointer;transition:background .1s ease}
      .pp-row:hover,.pp-row:focus-within{background:var(--pp-soft)}
      .pp-row:has(.pp-row-name:focus-visible){box-shadow:inset 0 0 0 2px var(--pp-accent)}
      .pp-row.dimmed .pp-row-main,.pp-row.dimmed .pp-row-chips,.pp-row.dimmed .pp-avatar{opacity:.55}
      .pp-row-photo{position:relative;display:inline-grid;flex:none;padding:0;border:0;border-radius:50%;background:transparent;cursor:pointer}
      span.pp-row-photo{cursor:inherit}
      .pp-row-photo-edit{position:absolute;inset:0;display:grid;place-items:center;border-radius:50%;background:rgba(16,24,40,.52);color:#fff;font-size:10px;opacity:0;transition:opacity .12s ease}
      button.pp-row-photo:hover .pp-row-photo-edit,button.pp-row-photo:focus-visible .pp-row-photo-edit{opacity:1}
      .pp-row-main{display:grid;gap:1px;flex:1 1 96px;min-width:0}
      .pp-row-title{display:flex;align-items:center;gap:6px;min-width:0}
      .pp-row-name{min-width:0;margin:0;padding:0;border:0;background:transparent;color:var(--pp-text);font:inherit;font-size:13px;font-weight:650;line-height:1.3;text-align:left;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;cursor:pointer}
      .pp-row-name:focus-visible{outline:0}
      .pp-row-secondary{color:var(--pp-muted);font-size:11.5px;line-height:1.3;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
      .pp-row-chips{display:flex;align-items:center;justify-content:flex-end;gap:10px;flex:0 1 auto;min-width:0;overflow:hidden}
      .pp-row-chips>.pp-chip-run{flex:0 1 auto}
      .pp-row-chips>.pp-chip-run:empty{display:none}
      .pp-row-chips .pp-chip{flex:none}
      .pp-row-chips .pp-chip.squeeze{flex:0 1 auto}
      .pp-row-aside{display:flex;align-items:center;flex:none}
      .pp-row-actions{position:absolute;right:4px;top:50%;display:flex;align-items:center;gap:1px;padding:3px 3px 3px 22px;border-radius:9px;background:linear-gradient(to right,rgba(248,250,252,0),var(--pp-soft) 20px);transform:translateY(-50%);opacity:0;pointer-events:none;transition:opacity .1s ease}
      .pp-row:hover .pp-row-actions,.pp-row:focus-within .pp-row-actions{opacity:1;pointer-events:auto}
      .pp-row-more{display:none}
      .pp-list-file{position:absolute;width:1px;height:1px;opacity:0;pointer-events:none}

      .pp-skeleton{display:flex;align-items:center;gap:10px;height:44px;padding:0 8px;break-inside:avoid}
      .pp-skeleton>i{flex:none;width:30px;height:30px;border-radius:50%}
      .pp-skeleton>span{display:grid;gap:6px;flex:1}
      .pp-skeleton b{display:block;height:9px;border-radius:5px}
      .pp-skeleton>i,.pp-skeleton b{background:linear-gradient(90deg,var(--pp-hover) 25%,var(--pp-line-soft) 37%,var(--pp-hover) 63%);background-size:400% 100%;animation:pp-shimmer 1.3s ease infinite}
      @keyframes pp-shimmer{0%{background-position:100% 50%}100%{background-position:0 50%}}

      @container (max-width:640px){
        .pp-list-head{flex-wrap:wrap;gap:10px}
        .pp-list-tools{flex:1 1 100%;flex-wrap:wrap}
        .pp-list-filters{flex:1 1 100%;order:3}
        .pp-search{flex:1 1 auto}
        .pp-list-tools .pp-btn{padding:0 10px}
        .pp-list-tools .pp-btn>.pp-btn-label{position:absolute;width:1px;height:1px;overflow:hidden;clip-path:inset(50%)}
        .pp-list-tools .pp-btn.primary>.pp-btn-label{position:static;width:auto;height:auto;overflow:visible;clip-path:none}
        .pp-row{height:48px;padding:0 4px}
      }
      @media (hover:none){
        .pp-row-actions{display:none}
        .pp-row-more{display:inline-grid}
      }
      @media (prefers-reduced-motion:reduce){.pp-skeleton>i,.pp-skeleton b{animation:none}.pp-row,.pp-row-actions{transition:none}}
    `;
    document.head.appendChild(style);
  }

  function mount(container, options = {}){
    if (!container) throw new Error('listPage.mount requires a container.');
    ensureStyles();
    let items = [];
    let models = new Map();
    let byKey = new Map();
    let state = 'loading';
    // Two columns unless a page asks for full-width rows.
    const columns = options.columns !== false;
    let error = null;
    /* Actions and row actions say what they need (data.ACTIONS); what this organization or user cannot do is never drawn. */
    const gate = ((list, where) => (window.FirstMatePeople?.data?.gate ? window.FirstMatePeople.data.gate(list, where) : (list || []).filter(Boolean)));
    const actions = gate(options.actions, 'list');
    container.innerHTML = `<div class="pp pp-list${options.embedded ? ' embedded' : ''}" data-settings-autosave="off">
      <header class="pp-list-head">
        <div class="pp-list-heading">${options.embedded ? '' : `<i class="fas ${esc(options.icon || 'fa-users')}" aria-hidden="true"></i>`}<div>${options.embedded ? '' : `<h2>${esc(options.title || '')}</h2>`}<p class="pp-list-sub" aria-live="polite">${esc(options.subtitle || '')}</p></div></div>
        <div class="pp-list-tools">
          ${options.filters ? `<div class="pp-seg pp-list-filters" role="group" aria-label="${esc(options.filters.label || t('show', 'Show'))}" data-list-filters></div>` : ''}
          ${options.search ? `<label class="pp-search"><i class="fas ${kit.ICONS.search}" aria-hidden="true"></i><input type="search" data-list-search placeholder="${esc(options.search.placeholder || t('search', 'Search'))}" aria-label="${esc(options.search.placeholder || t('search', 'Search'))}" value="${esc(options.search.value || '')}" autocomplete="off" spellcheck="false"></label>` : ''}
          <div class="pp-list-control" data-list-control></div>
          ${actions.map((action, index) => `<button type="button" class="pp-btn ${action.primary ? 'primary' : ''}" data-list-action="${index}" ${action.menu ? 'aria-haspopup="menu" aria-expanded="false"' : ''} aria-label="${esc(action.label)}"${tip(action.tooltip)}>${action.icon ? `<i class="fas ${esc(action.icon)}" aria-hidden="true"></i>` : ''}<span class="pp-btn-label">${esc(action.label)}</span>${action.menu ? `<i class="fas fa-chevron-down pp-caret" aria-hidden="true"></i>` : ''}</button>`).join('')}
        </div>
      </header>
      <div class="pp-list-body" role="list" aria-label="${esc(options.title || '')}" aria-busy="true"></div>
      <input type="file" class="pp-list-file" accept="image/png,image/jpeg,image/webp" tabindex="-1" aria-hidden="true">
    </div>`;
    const root = container.firstElementChild;
    const body = root.querySelector('.pp-list-body');
    const head = root.querySelector('.pp-list-head');
    /* The header is sticky inside whatever scrolls the page. When rows pass under it, it covers the gap up to the top of
       its card (the card's padding is not part of the header) and shows a fade at its bottom edge. */
    const scroller = (() => { for (let node = root.parentElement; node && node !== document.body; node = node.parentElement) { const overflow = getComputedStyle(node).overflowY; if (overflow === 'auto' || overflow === 'scroll') return node; } return window; })();
    let headFrame = 0;
    const paintHead = () => {
      headFrame = 0;
      if (!head.isConnected) return;
      const headBox = head.getBoundingClientRect();
      const stuck = body.getBoundingClientRect().top < headBox.bottom - 1;
      head.classList.toggle('stuck', stuck);
      if (!stuck) return;
      const card = root.closest('.cs-card, .pp-modal, .pp-card') || (scroller === window ? null : scroller);
      const top = Math.max(card ? card.getBoundingClientRect().top + (card.clientTop || 0) : 0, scroller === window ? 0 : scroller.getBoundingClientRect().top);
      head.style.setProperty('--pp-head-cover', `${Math.max(0, Math.min(120, headBox.top - top))}px`);
    };
    const onScroll = () => { if (!headFrame) headFrame = requestAnimationFrame(paintHead); };
    scroller.addEventListener('scroll', onScroll, { passive:true });
    const fileInput = root.querySelector('.pp-list-file');
    let photoKey = '';

    /*
     * Sections. options.section(item) returns { key, title, icon, color, tooltip, order } or a list of them
     * (an item in two sections is drawn in each; row keys stay unique within a section), or null when the
     * list is not sectioned. Sections are ordered by `order`, then by their first item. options.sorts are
     * the orders each section can be put in: [{ id, label, compare(a, b), first:'asc' | 'desc' }], with
     * options.sort ({ id, dir }) the default. A section's choice is remembered under options.sortStore.
     */
    const sorts = (options.sorts || []).filter((sort) => sort && sort.id && typeof sort.compare === 'function');
    const defaultSort = () => ({ id:options.sort?.id || sorts[0]?.id || '', dir:options.sort?.dir || sorts.find((sort) => sort.id === options.sort?.id)?.first || sorts[0]?.first || 'asc' });
    const sortStoreKey = options.sortStore ? `fm.people.list-sort.${options.sortStore}` : '';
    let sortState = {};
    try { if (sortStoreKey) sortState = JSON.parse(window.localStorage.getItem(sortStoreKey) || '{}') || {}; } catch (_) { sortState = {}; }
    const saveSorts = () => { try { if (sortStoreKey) window.localStorage.setItem(sortStoreKey, JSON.stringify(sortState)); } catch (_) {} };
    const sortOf = (key) => { const held = sortState[key]; return held && sorts.some((sort) => sort.id === held.id) ? { id:held.id, dir:held.dir === 'desc' ? 'desc' : 'asc' } : defaultSort(); };
    /* Collapsed sections, remembered per page and section beside the sort choice. A search opens every section it finds rows in. */
    const collapseStoreKey = options.sortStore ? `fm.people.list-collapse.${options.sortStore}` : '';
    let collapsed = new Set();
    try { if (collapseStoreKey) collapsed = new Set(JSON.parse(window.localStorage.getItem(collapseStoreKey) || '[]') || []); } catch (_) { collapsed = new Set(); }
    const saveCollapsed = () => { try { if (collapseStoreKey) window.localStorage.setItem(collapseStoreKey, JSON.stringify([...collapsed])); } catch (_) {} };
    let searching = false;
    const isCollapsed = (key) => !searching && collapsed.has(String(key));
    function toggleSection(key){
      const id = String(key);
      if (collapsed.has(id)) collapsed.delete(id); else collapsed.add(id);
      saveCollapsed();
      if (searching) searching = false;
      render();
      body.querySelector(`[data-section-toggle="${CSS.escape(id)}"]`)?.focus({ preventScroll:true });
    }
    const listId = `pp-list-${Math.random().toString(36).slice(2, 8)}`;
    let sectionCache = null;
    function sectionList(){
      if (!options.section || state !== 'ready' || !items.length) return null;
      if (sectionCache) return sectionCache;
      const sections = new Map();
      let placedAny = false;
      items.forEach((item, index) => {
        const placed = options.section(item);
        if (placed == null) return;
        placedAny = true;
        const seen = new Set();
        (Array.isArray(placed) ? placed : [placed]).filter(Boolean).forEach((section) => {
          const key = String(section.key ?? '');
          if (seen.has(key)) return;
          seen.add(key);
          if (!sections.has(key)) sections.set(key, { key, title:section.title || '', icon:section.icon || '', color:section.color || '', tooltip:section.tooltip || '', order:section.order, first:sections.size, items:[], indexes:new Map() });
          sections.get(key).items.push(item);
          sections.get(key).indexes.set(item, index);
        });
      });
      if (!placedAny) return null;
      const rank = (section) => (typeof section.order === 'number' ? section.order : Number.MAX_SAFE_INTEGER);
      sectionCache = [...sections.values()].sort((left, right) => (rank(left) - rank(right)) || (left.first - right.first));
      return sectionCache;
    }
    function sortedItems(section){
      const chosen = sortOf(section.key);
      const sort = sorts.find((entry) => entry.id === chosen.id);
      if (!sort) return section.items;
      const sign = chosen.dir === 'desc' ? -1 : 1;
      return [...section.items].sort((left, right) => (sign * sort.compare(left, right)) || (section.indexes.get(left) - section.indexes.get(right)));
    }
    const sectionMark = (section) => section.icon || section.color
      ? `<span class="pp-list-section-mark${section.icon ? '' : ' dot'}" style="--pp-mark:${esc(section.color || '#64748b')}" aria-hidden="true">${section.icon ? `<i class="fas ${esc(String(section.icon).split(' ').pop())}"></i>` : ''}</span>` : '';
    function sortControls(section){
      if (!sorts.length) return '';
      const chosen = sortOf(section.key);
      return `<div class="pp-list-sorts" role="group" aria-label="${esc(t('sort_section', 'Sort {section}', { section:section.title }))}">${sorts.map((sort) => {
        const active = sort.id === chosen.id;
        const label = active ? t(chosen.dir === 'desc' ? 'sorted_desc' : 'sorted_asc', chosen.dir === 'desc' ? '{sort}, descending' : '{sort}, ascending', { sort:sort.label }) : t('sort_by', 'Sort by {sort}', { sort:sort.label });
        return `<button type="button" class="pp-list-sort" data-list-sort="${esc(sort.id)}" data-sort-section="${esc(section.key)}" aria-pressed="${active}" aria-label="${esc(label)}">${esc(sort.label)}${active ? `<i class="fas fa-arrow-${chosen.dir === 'desc' ? 'down' : 'up'}" aria-hidden="true"></i>` : ''}</button>`;
      }).join('')}</div>`;
    }
    function toggleSort(sectionKey, sortId){
      const current = sortOf(sectionKey);
      const sort = sorts.find((entry) => entry.id === sortId);
      if (!sort) return;
      sortState[sectionKey] = current.id === sortId ? { id:sortId, dir:current.dir === 'asc' ? 'desc' : 'asc' } : { id:sortId, dir:sort.first === 'desc' ? 'desc' : 'asc' };
      saveSorts();
      render();
      body.querySelector(`[data-sort-section="${CSS.escape(sectionKey)}"][data-list-sort="${CSS.escape(sortId)}"]`)?.focus({ preventScroll:true });
    }

    const rowHtml = (item, sectionKey) => {
      const model = options.row(item, { section:sectionKey ?? null }) || {};
      const key = String(model.key ?? '');
      models.set(key, model);
      byKey.set(key, item);
      const photo = kit.avatar(model.entity || { name:model.title }, { size:30, online:model.online, square:model.square });
      const photoHtml = model.photoAction
        ? `<button type="button" class="pp-row-photo" data-row-photo aria-label="${esc(model.photoAction)}"${tip(model.photoAction)}>${photo}<span class="pp-row-photo-edit" aria-hidden="true"><i class="fas fa-camera"></i></span></button>`
        : `<span class="pp-row-photo">${photo}</span>`;
      const rowActions = gate(model.actions, 'row');
      model.actions = rowActions;
      return `<div class="pp-row${model.dimmed ? ' dimmed' : ''}" role="listitem" data-row-key="${esc(key)}"${sectionKey != null ? ` data-row-section="${esc(sectionKey)}"` : ''}>
        ${photoHtml}
        <div class="pp-row-main"${model.hover ? ` data-people-hover="${esc(model.hover)}"` : ''}>
          <div class="pp-row-title"><button type="button" class="pp-row-name" data-row-open>${esc(model.title || '')}</button>${(model.pills || []).map(kit.pill).join('')}</div>
          ${model.secondary ? `<div class="pp-row-secondary">${esc(model.secondary)}</div>` : ''}
        </div>
        ${model.aside ? `<div class="pp-row-aside">${model.aside}</div>` : ''}
        <div class="pp-row-chips">${(model.chipGroups || []).map((group) => (group.chips || []).length ? `<div class="pp-chip-run" data-chip-run>${group.chips.slice(0, 8).map(kit.chip).join('')}<span class="pp-chip more ${esc(group.tone || 'muted')}" data-chip-more data-chip-labels="${esc(JSON.stringify(group.chips.map((chip) => chip.label)))}" hidden></span></div>` : '').join('')}</div>
        ${rowActions.length ? `<div class="pp-row-actions">${rowActions.map((action) => `<button type="button" class="pp-icon-btn ${action.tone === 'danger' ? 'danger' : ''}" data-row-action="${esc(action.id)}" aria-label="${esc(action.label)}"${tip(action.label)} ${action.disabled ? 'disabled' : ''}><i class="fas ${esc(action.icon)}" aria-hidden="true"></i></button>`).join('')}</div>
        <button type="button" class="pp-icon-btn pp-row-more" data-row-more aria-haspopup="menu" aria-expanded="false" aria-label="${esc(t('actions', 'Actions'))}"><i class="fas fa-ellipsis" aria-hidden="true"></i></button>` : ''}
      </div>`;
    };
    const skeleton = () => Array.from({ length:10 }, (_, index) => `<div class="pp-skeleton" aria-hidden="true"><i></i><span><b style="width:${38 + (index * 17) % 30}%"></b><b style="width:${52 + (index * 11) % 26}%"></b></span></div>`).join('');

    function render(){
      const focusedRow = document.activeElement?.closest?.('.pp-row');
      const focused = focusedRow?.dataset.rowKey;
      const focusedSection = focusedRow?.dataset.rowSection;
      const focusedSelector = document.activeElement?.matches?.('[data-row-open]') ? '[data-row-open]' : '';
      models = new Map();
      byKey = new Map();
      sectionCache = null;
      body.setAttribute('aria-busy', String(state === 'loading'));
      if (state === 'loading') body.innerHTML = skeleton();
      else if (state === 'error') body.innerHTML = `<div class="pp-list-state" role="alert"><i class="fas fa-triangle-exclamation" aria-hidden="true"></i><strong>${esc(error?.message || t('load_failed', 'Could not load'))}</strong>${error?.retry ? `<button type="button" class="pp-btn" data-list-retry>${esc(t('try_again', 'Try again'))}</button>` : ''}</div>`;
      else if (!items.length) body.innerHTML = `<div class="pp-list-state"><i class="fas ${esc(options.empty?.icon || options.icon || 'fa-users')}" aria-hidden="true"></i><strong>${esc(options.empty?.title || t('nothing_here', 'Nothing here yet'))}</strong>${options.empty?.action ? `<button type="button" class="pp-btn" data-list-empty-action>${esc(options.empty.action.label)}</button>` : ''}</div>`;
      else if (sectionList()) {
        // Each section is its own grid of rows, its rows in the order its sort says.
        body.innerHTML = sectionList().map((section) => `<section class="pp-list-section${isCollapsed(section.key) ? ' collapsed' : ''}" data-list-section="${esc(section.key)}"><div class="pp-list-section-head"><h3 class="pp-list-section-title"${tip(section.tooltip)}><button type="button" class="pp-list-section-toggle" data-section-toggle="${esc(section.key)}" aria-expanded="${!isCollapsed(section.key)}" aria-controls="${esc(`${listId}-${section.key}`)}"><i class="fas fa-chevron-down pp-list-section-chevron" aria-hidden="true"></i>${sectionMark(section)}<span class="pp-list-section-name">${esc(section.title)}</span><span class="pp-list-section-count">${section.items.length.toLocaleString()}</span></button></h3>${isCollapsed(section.key) ? '' : sortControls(section)}</div><div class="pp-list-grid${columns && section.items.length > 1 ? ' two' : ''}" id="${esc(`${listId}-${section.key}`)}" ${isCollapsed(section.key) ? 'hidden' : ''} role="list" aria-label="${esc(section.title)}" style="--pp-rows:${Math.ceil(section.items.length / 2)}">${sortedItems(section).map((item) => rowHtml(item, section.key)).join('')}</div></section>`).join('');
      }
      else body.innerHTML = items.map((item) => rowHtml(item)).join('');
      const sectioned = state === 'ready' && items.length > 0 && !!sectionList();
      const count = sectioned ? 0 : state === 'loading' ? 10 : state === 'ready' ? items.length : 0;
      body.classList.toggle('sectioned', sectioned);
      body.setAttribute('role', sectioned ? 'presentation' : 'list');
      body.classList.toggle('two', columns && count > 1);
      body.style.setProperty('--pp-rows', String(Math.max(1, Math.ceil(count / 2))));
      kit.presence.paint(body);
      fit();
      if (focused && focusedSelector) {
        const inSection = focusedSection != null ? body.querySelector(`[data-row-key="${CSS.escape(focused)}"][data-row-section="${CSS.escape(focusedSection)}"] ${focusedSelector}`) : null;
        (inSection || body.querySelector(`[data-row-key="${CSS.escape(focused)}"] ${focusedSelector}`))?.focus({ preventScroll:true });
      }
    }

    /*
     * Chips never truncate mid-word: each row shows as many whole chips as fit beside the name and
     * folds the rest into "+N". One read pass and one write pass for the whole list.
     */
    function fit(only){
      if (!body.clientWidth) return;
      const rows = only ? [only] : Array.from(body.querySelectorAll('.pp-row'));
      rows.forEach((row) => row.querySelectorAll('[data-chip-run]').forEach((run) => {
        run.hidden = false;
        run.querySelectorAll('.pp-chip').forEach((chip) => { chip.hidden = chip.hasAttribute('data-chip-more'); chip.classList.remove('squeeze'); });
      }));
      const MORE = 34, GAP = 4, RUN_GAP = 10;
      const plans = rows.map((row) => {
        const runs = Array.from(row.querySelectorAll('[data-chip-run]'));
        if (!runs.length) return null;
        const name = row.querySelector('.pp-row-name');
        const pills = Array.from(row.querySelectorAll('.pp-row-title .pp-pill')).reduce((sum, pill) => sum + pill.offsetWidth + 6, 0);
        const natural = Math.max((name?.scrollWidth || 0) + pills, row.querySelector('.pp-row-secondary')?.scrollWidth || 0);
        const inner = row.clientWidth - 16 - 40 - (row.querySelector('.pp-row-aside') ? row.querySelector('.pp-row-aside').offsetWidth + 10 : 0);
        const budget = Math.min(inner - 96, Math.max(inner * 0.45, inner - natural - 12));
        const widths = runs.map((run) => Array.from(run.querySelectorAll('.pp-chip:not([data-chip-more])')).map((chip) => chip.offsetWidth));
        const totals = runs.map((run) => JSON.parse(run.querySelector('[data-chip-more]').dataset.chipLabels || '[]').length);
        const counts = runs.map(() => 0);
        const used = () => counts.reduce((sum, count, index) => {
          const shown = widths[index].slice(0, count);
          if (!shown.length) return sum;
          const width = shown.reduce((a, b) => a + b, 0) + (shown.length - 1) * GAP + (totals[index] > count ? MORE + GAP : 0);
          return sum + width + (sum > 0 ? RUN_GAP : 0);
        }, 0);
        let progressed = true;
        while (progressed) {
          progressed = false;
          for (let index = 0; index < runs.length; index += 1) {
            if (counts[index] >= widths[index].length) continue;
            counts[index] += 1;
            if (used() <= budget) progressed = true; else counts[index] -= 1;
          }
        }
        const squeeze = counts.every((count) => count === 0);
        if (squeeze) counts[0] = 1;
        return { runs, counts, totals, squeeze };
      });
      plans.forEach((plan) => plan && plan.runs.forEach((run, index) => {
        const count = plan.counts[index];
        const chips = Array.from(run.querySelectorAll('.pp-chip:not([data-chip-more])'));
        const more = run.querySelector('[data-chip-more]');
        const labels = JSON.parse(more.dataset.chipLabels || '[]');
        run.hidden = count === 0;
        chips.forEach((chip, chipIndex) => { chip.hidden = chipIndex >= count; if (plan.squeeze) chip.classList.add('squeeze'); });
        more.hidden = count === 0 || plan.totals[index] <= count;
        more.textContent = `+${plan.totals[index] - count}`;
        more.setAttribute('data-fm-tooltip', labels.slice(count).join(', '));
      }));
    }
    let fitFrame = 0;
    let fitWidth = 0;
    const resizeObserver = typeof ResizeObserver === 'function' ? new ResizeObserver(() => {
      if (Math.abs(body.clientWidth - fitWidth) < 2) return;
      fitWidth = body.clientWidth;
      cancelAnimationFrame(fitFrame);
      fitFrame = requestAnimationFrame(() => fit());
    }) : null;
    resizeObserver?.observe(body);
    const rowOf = (target) => target.closest?.('.pp-row');
    body.addEventListener('click', (event) => {
      if (event.target.closest('[data-list-retry]')) { error?.retry?.(); return; }
      const sectionToggle = event.target.closest('[data-section-toggle]');
      if (sectionToggle) { toggleSection(sectionToggle.dataset.sectionToggle); return; }
      const sortButton = event.target.closest('[data-list-sort]');
      if (sortButton) { toggleSort(sortButton.dataset.sortSection, sortButton.dataset.listSort); return; }
      const emptyAction = event.target.closest('[data-list-empty-action]');
      if (emptyAction) { options.empty?.action?.onClick?.(emptyAction); return; }
      const row = rowOf(event.target);
      if (!row) return;
      const key = row.dataset.rowKey;
      const item = byKey.get(key);
      const actionButton = event.target.closest('[data-row-action]');
      if (actionButton) { event.stopPropagation(); if (!actionButton.disabled) options.onAction?.(actionButton.dataset.rowAction, item, actionButton); return; }
      const more = event.target.closest('[data-row-more]');
      if (more) {
        event.stopPropagation();
        kit.menu(more, { align:'end', label:t('actions', 'Actions'), items:(models.get(key)?.actions || []).map((action) => ({ id:action.id, label:action.label, icon:action.icon, tone:action.tone === 'danger' ? 'danger' : '', disabled:action.disabled })), onSelect:(action) => { options.onAction?.(action.id, item, more); } });
        return;
      }
      if (event.target.closest('[data-row-photo]')) { event.stopPropagation(); photoKey = key; fileInput.value = ''; fileInput.click(); return; }
      if (event.target.closest('a,input,select,textarea')) return;
      options.onOpen?.(item, row);
    });
    body.addEventListener('keydown', (event) => {
      if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key) || !event.target.matches?.('[data-row-open]')) return;
      const all = Array.from(body.querySelectorAll('[data-row-open]'));
      const index = all.indexOf(event.target);
      const next = event.key === 'Home' ? 0 : event.key === 'End' ? all.length - 1 : index + (event.key === 'ArrowDown' ? 1 : -1);
      if (all[next]) { event.preventDefault(); all[next].focus(); }
    });
    fileInput.addEventListener('change', () => {
      const file = fileInput.files?.[0];
      if (file && byKey.has(photoKey)) options.onPhoto?.(byKey.get(photoKey), file);
    });
    let searchTimer = 0;
    root.querySelector('[data-list-search]')?.addEventListener('input', (event) => {
      window.clearTimeout(searchTimer);
      const value = event.target.value;
      searchTimer = window.setTimeout(() => { searching = value.trim() !== ''; options.search.onInput?.(value); }, 90);
    });
    /* Filter chips: which rows are shown. The page owns the meaning; the list draws the chips and their counts. */
    let filterValue = options.filters?.value || options.filters?.items?.[0]?.id || '';
    function drawFilters(items){
      const host = root.querySelector('[data-list-filters]');
      if (!host) return;
      host.innerHTML = (items || options.filters.items).filter(Boolean).map((item) => `<button type="button" data-list-filter="${esc(item.id)}" aria-pressed="${item.id === filterValue}"${tip(item.tooltip)}>${esc(item.label)}${item.count ? `<span class="pp-seg-count">${esc(item.count)}</span>` : ''}</button>`).join('');
    }
    if (options.filters) drawFilters();
    root.querySelector('.pp-list-tools').addEventListener('click', (event) => {
      const filter = event.target.closest('[data-list-filter]');
      if (filter) { filterValue = filter.dataset.listFilter; root.querySelectorAll('[data-list-filter]').forEach((other) => other.setAttribute('aria-pressed', String(other === filter))); options.filters.onChange?.(filterValue); return; }
      const button = event.target.closest('[data-list-action]');
      if (button) actions[Number(button.dataset.listAction)]?.onClick?.(button);
    });
    render();

    return {
      el:root,
      controlHost:root.querySelector('[data-list-control]'),
      setItems(next){ items = Array.isArray(next) ? next : []; state = 'ready'; error = null; render(); },
      setLoading(loading = true){ state = loading ? 'loading' : 'ready'; render(); },
      setError(message, retry){ state = 'error'; error = { message, retry }; render(); },
      setSubtitle(text){ root.querySelector('.pp-list-sub').textContent = text || ''; },
      setFilters(items, value){ if (value !== undefined) filterValue = value; drawFilters(items); },
      filter:() => filterValue,
      refreshRow(key, next){
        const row = body.querySelector(`[data-row-key="${CSS.escape(String(key))}"]`);
        const item = next || byKey.get(String(key));
        if (!row || !item) return;
        // A sectioned list may move the item between sections or within its sort: draw it again.
        if (sectionList()) { const old = byKey.get(String(key)); const index = items.indexOf(old); if (index >= 0) items[index] = item; render(); return; }
        row.insertAdjacentHTML('afterend', rowHtml(item));
        const fresh = row.nextElementSibling;
        row.remove();
        kit.presence.paint(body);
        fit(fresh);
      },
      rowElement:(key) => body.querySelector(`[data-row-key="${CSS.escape(String(key))}"]`),
      actionButton:(id) => root.querySelector(`[data-list-action="${actions.findIndex((action) => action.id === id)}"]`),
      focusSearch(){ root.querySelector('[data-list-search]')?.focus(); },
      destroy(){ window.clearTimeout(searchTimer); cancelAnimationFrame(fitFrame); cancelAnimationFrame(headFrame); scroller.removeEventListener('scroll', onScroll); resizeObserver?.disconnect(); container.replaceChildren(); }
    };
  }

  People.listPage = { mount, ensureStyles };
})();
