/* public/libraries/apps/people/permissions-panel.js
 *
 * The permissions panel. One component for every level that can hold
 * permissions: a role (the base), a group type, a group, a user (the final
 * override). It shows, for each permission, what this level inherits, what it
 * says itself, and the result.
 *
 *   const panel = FirstMatePeople.permissionsPanel.mount(container, {
 *     level: 'user',                          // 'role' | 'group_type' | 'group' | 'user'
 *     groups: [{ id, label, icon, description,                         // a category
 *                subgroups: [{ id, label, description,                 // a subcategory (optional)
 *                              collapsed,                            // folded at the end of the category
 *                              permissions: [{ key, label, description, unavailable }] }],
 *                permissions: [...] }],                                // used when there are no subgroups
 *     value: { 'crew.schedule.view': false }, // what THIS level says; a missing key says nothing
 *     inherited(key) => ({ allowed: true, sources: ['Sales'] }),   // what the levels above give; omit for the base level
 *     readOnly: false,
 *     onChange(value, key) {}                 // value is a fresh object every time
 *   });
 *   panel.getValue()   panel.setValue(value)   panel.refresh()   panel.overrideCount()   panel.destroy()
 *
 * With `inherited`, each permission is a three-way choice: inherit, allow,
 * deny. A row that says something itself is marked as overridden and can be
 * filtered to. Without `inherited` (a role), each permission is a switch.
 * Categories are paged on the left; the right side lists the category's
 * subcategories under headings. Searching looks across every category.
 * Labels are titles; descriptions are tooltips. An `unavailable` permission
 * (its app is off) is muted but still editable.
 */
(function(){
  'use strict';
  const People = window.FirstMatePeople = window.FirstMatePeople || {};
  if (People.permissionsPanel) return;
  const kit = People.kit;
  const { esc, t, tip } = kit;

  function ensureStyles(){
    if (document.getElementById('pp_perm_css')) return;
    const style = document.createElement('style');
    style.id = 'pp_perm_css';
    style.textContent = `
      .pp-perm{display:flex;flex-direction:column;gap:12px;height:100%;min-height:0;container-type:inline-size}
      .pp-perm-bar{display:flex;align-items:center;gap:10px;flex:none}
      .pp-perm-bar .pp-search{flex:0 1 230px}
      .pp-perm-tally{margin-left:auto;display:flex;align-items:center;gap:12px;color:var(--pp-muted);font-size:12px;font-weight:600;white-space:nowrap}
      .pp-perm-tally>span{display:inline-flex;align-items:center;gap:5px}
      .pp-perm-tally i{font-size:11px}
      .pp-perm-body{display:grid;grid-template-columns:212px minmax(0,1fr);gap:16px;flex:1;min-height:0}
      .pp-perm.single .pp-perm-body{grid-template-columns:minmax(0,1fr)}
      .pp-perm.single .pp-perm-groups{display:none}
      .pp-perm-groups{display:flex;flex-direction:column;gap:2px;min-height:0;overflow-y:auto;padding-right:2px}
      .pp-perm-group{display:flex;align-items:center;gap:9px;width:100%;min-height:34px;padding:0 9px;border:0;border-radius:8px;background:transparent;color:var(--pp-muted);font-size:12.5px;font-weight:650;text-align:left;cursor:pointer}
      .pp-perm-group>i{width:14px;text-align:center;font-size:11.5px;opacity:.8}
      .pp-perm-group>span:first-of-type{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
      .pp-perm-group:hover{background:var(--pp-hover);color:var(--pp-text)}
      .pp-perm-group[aria-selected="true"]{background:rgba(var(--pp-accent-rgb),.08);color:var(--pp-accent)}
      .pp-perm-group-count{flex:none;min-width:17px;height:17px;padding:0 5px;border-radius:999px;display:inline-grid;place-items:center;background:var(--pp-hover);color:var(--pp-muted);font-size:10px;font-weight:700;font-variant-numeric:tabular-nums}
      .pp-perm-group-count.override{background:var(--pp-warn-bg);color:var(--pp-warn)}
      .pp-perm-group-count:empty{display:none}
      .pp-perm-list{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));grid-auto-rows:min-content;align-content:start;gap:3px 14px;min-height:0;overflow-y:auto;padding:1px}
      .pp-perm-row{display:flex;align-items:center;gap:9px;min-width:0;min-height:36px;padding:3px 4px 3px 9px;box-sizing:border-box;border-radius:8px;background:var(--pp-soft);transition:background .12s ease,box-shadow .12s ease}
      .pp-perm-row.overridden{background:var(--pp-warn-bg);box-shadow:inset 0 0 0 1px var(--pp-warn-line)}
      .pp-perm-state{flex:none;width:14px;text-align:center;font-size:13px;color:#d0d5dd}
      .pp-perm-row.allowed .pp-perm-state{color:var(--pp-online)}
      .pp-perm-row.denied .pp-perm-state{color:var(--pp-danger)}
      .pp-perm-label{flex:1;min-width:0;color:var(--pp-strong);font-size:12.5px;font-weight:600;line-height:1.3;overflow:hidden;overflow-wrap:anywhere;display:-webkit-box;-webkit-box-orient:vertical;-webkit-line-clamp:2}
      .pp-perm-row:not(.allowed) .pp-perm-label{color:var(--pp-muted)}
      .pp-perm-row.unavailable .pp-perm-label,.pp-perm-row.unavailable .pp-perm-state{opacity:.55}
      .pp-perm-off{flex:none;color:var(--pp-faint);font-size:10.5px}
      .pp-tri{display:inline-flex;flex:none;padding:2px;border-radius:8px;background:rgba(16,24,40,.05)}
      .pp-tri>button{display:grid;place-items:center;width:26px;height:24px;border:0;border-radius:6px;background:transparent;color:var(--pp-faint);font-size:11px;cursor:pointer;transition:background .1s ease,color .1s ease}
      .pp-tri>button:hover:not(:disabled){color:var(--pp-text)}
      .pp-tri>button[aria-checked="true"]{background:var(--pp-panel);color:var(--pp-strong);box-shadow:0 1px 2px rgba(16,24,40,.16)}
      .pp-tri>button[data-choice="allow"][aria-checked="true"]{background:var(--pp-online);color:#fff}
      .pp-tri>button[data-choice="deny"][aria-checked="true"]{background:var(--pp-danger);color:#fff}
      .pp-tri>button:disabled{cursor:default;opacity:.6}
      .pp-switch{position:relative;flex:none;width:34px;height:20px;margin-right:4px;padding:0;border:0;border-radius:999px;background:#d0d5dd;cursor:pointer;transition:background .14s ease}
      .pp-switch::after{content:'';position:absolute;left:2px;top:2px;width:16px;height:16px;border-radius:50%;background:#fff;box-shadow:0 1px 2px rgba(16,24,40,.25);transition:transform .14s ease}
      .pp-switch[aria-checked="true"]{background:var(--pp-online)}
      .pp-switch[aria-checked="true"]::after{transform:translateX(14px)}
      .pp-switch:disabled{cursor:default;opacity:.6}
      .pp-perm-empty{grid-column:1/-1}
      .pp-perm-heading{grid-column:1/-1;display:flex;align-items:baseline;gap:6px;margin:10px 0 1px 2px;color:var(--pp-muted);font-size:11px;font-weight:700;letter-spacing:.04em;text-transform:uppercase}
      .pp-perm-heading:first-child{margin-top:0}
      .pp-perm-heading>span{color:var(--pp-faint);font-weight:650}
      .pp-perm-heading>span::after{content:'\\203A';margin-left:6px}
      .pp-perm-fold{grid-column:1/-1;display:flex;align-items:center;gap:7px;margin:12px 0 1px;padding:6px 2px;border:0;border-top:1px dashed var(--pp-line);background:transparent;color:var(--pp-muted);font-size:11px;font-weight:700;letter-spacing:.04em;text-transform:uppercase;text-align:left;cursor:pointer}
      .pp-perm-fold:hover{color:var(--pp-text)}
      .pp-perm-fold>i{width:10px;font-size:9.5px;transition:transform .12s ease}
      .pp-perm-fold[aria-expanded="true"]>i{transform:rotate(90deg)}
      .pp-perm-fold>em{font-style:normal;font-weight:650;letter-spacing:0;text-transform:none;color:var(--pp-faint)}
      @container (max-width:620px){
        .pp-perm-body{grid-template-columns:minmax(0,1fr);grid-template-rows:auto minmax(0,1fr);gap:10px}
        .pp-perm-groups{flex-direction:row;overflow-x:auto;overflow-y:hidden;padding:0 0 2px;scrollbar-width:none}
        .pp-perm-groups::-webkit-scrollbar{display:none}
        .pp-perm-group{width:auto;flex:none;border:1px solid var(--pp-line);border-radius:999px;min-height:30px}
        .pp-perm-group[aria-selected="true"]{border-color:transparent}
        .pp-perm-list{grid-template-columns:minmax(0,1fr)}
        .pp-perm-tally{display:none}
        .pp-perm-bar .pp-search{flex:1 1 auto}
      }
      @media (prefers-reduced-motion:reduce){.pp-switch,.pp-switch::after,.pp-perm-row{transition:none}}
    `;
    document.head.appendChild(style);
  }

  function mount(container, options = {}){
    if (!container) throw new Error('permissionsPanel.mount requires a container.');
    ensureStyles();
    // A group is a category. Its subgroups are subcategories; a group without them is one unnamed subgroup.
    const groups = (options.groups || []).filter(Boolean).map((group) => {
      // Folded subgroups (rarely used, such as older names) go to the end of their category.
      const subgroups = (group.subgroups || []).filter((sub) => sub && (sub.permissions || []).length)
        .map((sub, index) => ({ sub, index })).sort((left, right) => (left.sub.collapsed === true) - (right.sub.collapsed === true) || left.index - right.index).map(({ sub }) => sub);
      const permissions = subgroups.length ? subgroups.flatMap((sub) => sub.permissions) : (group.permissions || []);
      return { ...group, permissions, named:subgroups.length > 0, subgroups:subgroups.length ? subgroups : [{ id:'', label:'', description:'', permissions }] };
    }).filter((group) => group.permissions.length);
    const inheritable = typeof options.inherited === 'function';
    const readOnly = options.readOnly === true;
    let inherited = options.inherited;
    let value = { ...(options.value || {}) };
    const everything = groups.flatMap((group) => group.permissions);
    const ALL = '__all';
    const showAll = groups.length > 1 && everything.length <= (options.allLimit || 28);
    let activeGroup = showAll ? ALL : groups[0]?.id || '';
    let query = '';
    let onlyOverrides = false;

    const says = (key) => Object.prototype.hasOwnProperty.call(value, key) ? value[key] === true : null;
    const above = (key) => (inheritable ? inherited(key) : null) || { allowed:false, sources:[] };
    const effective = (key) => { const own = says(key); return own == null ? above(key).allowed === true : own; };
    const overrideCount = (list) => (list || groups.flatMap((group) => group.permissions)).filter((permission) => says(permission.key) != null).length;
    const allowedCount = () => groups.flatMap((group) => group.permissions).filter((permission) => effective(permission.key)).length;

    container.innerHTML = `<div class="pp pp-perm${groups.length < 2 ? ' single' : ''}" data-settings-autosave="off" data-level="${esc(options.level || '')}">
      <div class="pp-perm-bar">
        <label class="pp-search"><i class="fas ${kit.ICONS.search}" aria-hidden="true"></i><input type="search" data-perm-search placeholder="${esc(t('search_permissions', 'Search permissions'))}" aria-label="${esc(t('search_permissions', 'Search permissions'))}" autocomplete="off" spellcheck="false"></label>
        ${inheritable ? `<div class="pp-seg" role="group" aria-label="${esc(t('show', 'Show'))}"><button type="button" data-perm-filter="all" aria-pressed="true">${esc(t('all', 'All'))}</button><button type="button" data-perm-filter="overrides" aria-pressed="false"${tip(t('overridden_tip', 'Only what is set here instead of inherited'))}>${esc(t('overridden', 'Overridden'))}<span class="pp-seg-count" data-perm-override-total></span></button></div>` : ''}
        <div class="pp-perm-tally" aria-live="polite"></div>
      </div>
      <div class="pp-perm-body">
        <div class="pp-perm-groups" role="tablist" aria-orientation="vertical" aria-label="${esc(t('permission_groups', 'Permission groups'))}"></div>
        <div class="pp-perm-list" role="tabpanel"></div>
      </div>
    </div>`;
    const root = container.firstElementChild;
    const groupsEl = root.querySelector('.pp-perm-groups');
    const listEl = root.querySelector('.pp-perm-list');
    const tallyEl = root.querySelector('.pp-perm-tally');

    function sourceText(key){
      const from = above(key);
      const own = says(key);
      const inheritedText = from.allowed
        ? t('inherits_allowed', 'Inherited: allowed{sources}', { sources:from.sources?.length ? ` (${from.sources.join(', ')})` : '' })
        : t('inherits_not_allowed', 'Inherited: not allowed');
      if (!inheritable) return own === true ? t('granted', 'Granted') : own === false ? t('denied_here', 'Denied here') : t('not_granted', 'Not granted');
      return own == null ? inheritedText : `${own ? t('allowed_here', 'Allowed here') : t('denied_here', 'Denied here')}. ${inheritedText}`;
    }
    function rowHtml(permission){
      const key = permission.key;
      const own = says(key);
      const result = effective(key);
      const choice = own == null ? 'inherit' : own ? 'allow' : 'deny';
      const classes = ['pp-perm-row', result ? 'allowed' : '', own === false ? 'denied' : '', inheritable && own != null ? 'overridden' : '', permission.unavailable ? 'unavailable' : ''].filter(Boolean).join(' ');
      const stateIcon = result ? 'fa-circle-check' : own === false ? 'fa-circle-xmark' : 'fa-circle-minus';
      const control = inheritable
        ? `<div class="pp-tri" role="radiogroup" aria-label="${esc(permission.label)}">${[
            ['inherit', kit.ICONS.inherited, above(key).allowed ? t('inherit_allowed', 'Inherit (allowed)') : t('inherit_not_allowed', 'Inherit (not allowed)')],
            ['allow', kit.ICONS.allow, t('allow', 'Allow')],
            ['deny', kit.ICONS.deny, t('deny', 'Deny')]
          ].map(([id, icon, label]) => `<button type="button" role="radio" data-choice="${id}" aria-checked="${choice === id}" aria-label="${esc(label)}" tabindex="${choice === id ? 0 : -1}"${tip(label)} ${readOnly ? 'disabled' : ''}><i class="fas ${icon}" aria-hidden="true"></i></button>`).join('')}</div>`
        : `<button type="button" class="pp-switch" role="switch" aria-checked="${own === true}" aria-label="${esc(permission.label)}" data-choice="toggle" ${readOnly ? 'disabled' : ''}></button>`;
      return `<div class="${classes}" data-perm-key="${esc(key)}"><i class="fas ${stateIcon} pp-perm-state" aria-hidden="true"${tip(sourceText(key))}></i><span class="pp-perm-label"${tip([permission.description, sourceText(key)].filter(Boolean).join(' • '))}>${esc(permission.label)}</span>${permission.unavailable ? `<i class="fas fa-power-off pp-perm-off" aria-label="${esc(t('permission_app_off', 'Its app is turned off for this company'))}"${tip(t('permission_app_off', 'Its app is turned off for this company'))}></i>` : ''}${control}</div>`;
    }
    const placed = (group) => group.subgroups.flatMap((sub) => sub.permissions.map((permission) => ({ ...permission, groupId:group.id, groupLabel:group.label, subId:sub.id, subLabel:sub.label, subDescription:sub.description, folded:sub.collapsed === true, named:group.named })));
    const unfolded = new Set();
    function visiblePermissions(){
      const text = query.trim().toLowerCase();
      const pool = text || activeGroup === ALL
        ? groups.flatMap(placed)
        : placed(groups.find((group) => group.id === activeGroup) || { subgroups:[] });
      return pool.filter((permission) => (!text || `${permission.label} ${permission.groupLabel || ''} ${permission.subLabel || ''} ${permission.key} ${permission.description || ''}`.toLowerCase().includes(text))
        && (!onlyOverrides || says(permission.key) != null));
    }
    function renderGroups(){
      const allButton = showAll ? `<button type="button" class="pp-perm-group" role="tab" data-perm-group="${ALL}" aria-selected="${!query && activeGroup === ALL}" tabindex="${activeGroup === ALL ? 0 : -1}"><i class="fas fa-border-all" aria-hidden="true"></i><span>${esc(t('all', 'All'))}</span><span class="pp-perm-group-count${inheritable ? ' override' : ''}">${inheritable ? (overrideCount() || '') : ''}</span></button>` : '';
      groupsEl.innerHTML = allButton + groups.map((group) => {
        const overrides = overrideCount(group.permissions);
        const count = inheritable ? (overrides || '') : (group.permissions.filter((permission) => effective(permission.key)).length || '');
        return `<button type="button" class="pp-perm-group" role="tab" data-perm-group="${esc(group.id)}" aria-selected="${!query && group.id === activeGroup}" tabindex="${group.id === activeGroup ? 0 : -1}"><i class="fas ${esc(group.icon || 'fa-key')}" aria-hidden="true"></i><span${tip(group.description ? `${group.label}: ${group.description}` : '')}>${esc(group.label)}</span><span class="pp-perm-group-count${inheritable ? ' override' : ''}"${tip(inheritable ? t('overridden_here', 'Overridden here') : t('granted', 'Granted'))}>${count}</span></button>`;
      }).join('');
    }
    function renderList(){
      const list = visiblePermissions();
      // Across categories (search, All) a heading names the category and subcategory; within one, the subcategory.
      const across = Boolean(query.trim() || activeGroup === ALL);
      let lastSection = null;
      listEl.innerHTML = list.length ? list.map((permission) => {
        const section = `${permission.groupId}/${permission.subId}`;
        // A folded subgroup is a toggle at the end of its category; search, All and the overridden filter open it.
        if (permission.folded && !across && !onlyOverrides) {
          const open = unfolded.has(section);
          const heading = section === lastSection ? '' : (() => {
            const members = list.filter((entry) => `${entry.groupId}/${entry.subId}` === section);
            const set = members.filter((entry) => says(entry.key) != null).length;
            return `<button type="button" class="pp-perm-fold" data-perm-fold="${esc(section)}" aria-expanded="${open}"${tip(permission.subDescription)}><i class="fas fa-chevron-right" aria-hidden="true"></i>${esc(permission.subLabel)}<em>${esc(set ? t('permission_fold_set', '{count} of {total} set', { count:set, total:members.length }) : String(members.length))}</em></button>`;
          })();
          lastSection = section;
          return heading + (open ? rowHtml(permission) : '');
        }
        let heading = '';
        if (section !== lastSection && (across || permission.named)) {
          const category = across ? `<span>${esc(permission.groupLabel || '')}</span>` : '';
          const title = permission.named ? esc(permission.subLabel) : '';
          heading = `<h5 class="pp-perm-heading" data-perm-section="${esc(section)}"${tip(permission.named ? permission.subDescription : '')}>${title ? category + title : esc(permission.groupLabel || '')}</h5>`;
        }
        lastSection = section;
        return heading + rowHtml(permission);
      }).join('')
        : `<div class="pp-list-state pp-perm-empty"><i class="fas ${onlyOverrides ? 'fa-rotate-left' : kit.ICONS.search}" aria-hidden="true"></i><strong>${esc(onlyOverrides && !query ? t('nothing_overridden', 'Nothing overridden') : t('no_matches', 'No matches'))}</strong></div>`;
    }
    function renderTally(){
      const total = overrideCount();
      const totalEl = root.querySelector('[data-perm-override-total]');
      if (totalEl) totalEl.textContent = total ? String(total) : '';
      tallyEl.innerHTML = `<span${tip(t('allowed_total_tip', 'Permissions in effect'))}><i class="fas fa-circle-check" style="color:var(--pp-online)" aria-hidden="true"></i>${esc(t('allowed_of', '{count} of {total} allowed', { count:allowedCount(), total:everything.length }))}</span>`;
    }
    function render(){ renderGroups(); renderList(); renderTally(); }

    function setChoice(key, choice){
      if (readOnly) return;
      const next = { ...value };
      if (choice === 'allow') next[key] = true;
      else if (choice === 'deny') next[key] = false;
      else if (choice === 'toggle') { if (next[key] === true) delete next[key]; else next[key] = true; }
      else delete next[key];
      value = next;
      const row = listEl.querySelector(`[data-perm-key="${CSS.escape(key)}"]`);
      const focusChoice = document.activeElement?.dataset?.choice;
      if (row) {
        const permission = groups.flatMap((group) => group.permissions).find((entry) => entry.key === key);
        row.outerHTML = rowHtml(permission);
        const fresh = listEl.querySelector(`[data-perm-key="${CSS.escape(key)}"]`);
        (fresh?.querySelector(focusChoice === 'toggle' ? '[data-choice="toggle"]' : '[aria-checked="true"]'))?.focus({ preventScroll:true });
      }
      renderGroups();
      renderTally();
      options.onChange?.({ ...value }, key);
    }

    listEl.addEventListener('click', (event) => {
      const fold = event.target.closest('[data-perm-fold]');
      if (fold) {
        const section = fold.dataset.permFold;
        if (unfolded.has(section)) unfolded.delete(section); else unfolded.add(section);
        renderList();
        listEl.querySelector(`[data-perm-fold="${CSS.escape(section)}"]`)?.focus({ preventScroll:true });
        return;
      }
      const button = event.target.closest('[data-choice]');
      const row = event.target.closest('[data-perm-key]');
      if (button && row && !button.disabled) setChoice(row.dataset.permKey, button.dataset.choice);
    });
    listEl.addEventListener('keydown', (event) => {
      const button = event.target.closest?.('.pp-tri>button');
      if (!button || !['ArrowRight', 'ArrowLeft', 'ArrowDown', 'ArrowUp'].includes(event.key)) return;
      const all = Array.from(button.parentElement.children);
      const next = all[(all.indexOf(button) + (['ArrowRight', 'ArrowDown'].includes(event.key) ? 1 : -1) + all.length) % all.length];
      event.preventDefault();
      setChoice(button.closest('[data-perm-key]').dataset.permKey, next.dataset.choice);
    });
    groupsEl.addEventListener('click', (event) => {
      const button = event.target.closest('[data-perm-group]');
      if (!button) return;
      activeGroup = button.dataset.permGroup;
      if (query) { query = ''; root.querySelector('[data-perm-search]').value = ''; }
      renderGroups();
      renderList();
    });
    groupsEl.addEventListener('keydown', (event) => {
      if (!['ArrowDown', 'ArrowUp', 'ArrowRight', 'ArrowLeft'].includes(event.key)) return;
      const order = [...(showAll ? [{ id:ALL }] : []), ...groups];
      const index = order.findIndex((group) => group.id === activeGroup);
      const next = order[(index + (['ArrowDown', 'ArrowRight'].includes(event.key) ? 1 : -1) + order.length) % order.length];
      if (!next) return;
      event.preventDefault();
      activeGroup = next.id;
      renderGroups();
      renderList();
      groupsEl.querySelector('[aria-selected="true"]')?.focus();
    });
    root.querySelector('[data-perm-search]').addEventListener('input', (event) => { query = event.target.value; renderGroups(); renderList(); });
    root.querySelectorAll('[data-perm-filter]').forEach((button) => button.addEventListener('click', () => {
      onlyOverrides = button.dataset.permFilter === 'overrides';
      root.querySelectorAll('[data-perm-filter]').forEach((other) => other.setAttribute('aria-pressed', String(other === button)));
      if (onlyOverrides && !query && !visiblePermissions().length) {
        const withOverrides = groups.find((group) => overrideCount(group.permissions));
        if (withOverrides) activeGroup = withOverrides.id;
      }
      renderGroups();
      renderList();
    }));
    render();

    return {
      el:root,
      getValue:() => ({ ...value }),
      setValue(next){ value = { ...(next || {}) }; render(); },
      setInherited(next){ inherited = next; render(); },
      refresh:render,
      overrideCount:() => overrideCount(),
      destroy(){ container.replaceChildren(); }
    };
  }

  People.permissionsPanel = { mount, ensureStyles };
})();
