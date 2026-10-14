/* public/libraries/apps/people/page-kit.js
 *
 * What the People pages have in common beyond the shared pieces: the small
 * behaviours every entity modal repeats. Pages use these so a group, a
 * department and an outside company behave like a user.
 *
 *   FirstMatePeople.pageKit
 *     identity(host, fields)              swap the summary's name for inputs: [{ id, value, placeholder, type:'text'|'textarea'|'select', options }]
 *     checkMenu(anchor, options)          checkbox menu over a draft list: { label, items:[{ id, label, color, hint, tooltip }], selected:[ids], onChange(next), refocus() }
 *     scopedRolesMenu(anchor, options)    the roles a person holds only in one department or unit ("Roles in Production")
 *     peopleList(panel, options)          a tab of user rows (members): see below
 *     typesModal(options)                 the type list of a kind (people-lists.js puts it here)
 *     userRow(user, extra)                the row model of a person, as the Users list draws it
 *     resolveHover(key)                   the summary model for any "<kind>:<id>" key (registered with hoverCard for every kind)
 *
 *   peopleList(panel, {
 *     count() => 'N members', items() => [{ user, pills, chips, actions }], search placeholder,
 *     add: { label, candidates() => [{ user, checked, hint }], onToggle(user, on) },    // omitted when read-only
 *     onAction(actionId, user, button), onOpen(user, row), empty: { icon, title, action }
 *   }) -> { refresh(), destroy() }
 */
(function(){
  'use strict';
  const People = window.FirstMatePeople = window.FirstMatePeople || {};
  if (People.pageKit) return;
  const kit = People.kit;
  const data = People.data;
  const { esc, t, tip } = kit;
  const failed = (title, error) => kit.toast(title, error?.message || t('try_again_later', 'Try again in a moment.'), false);

  function ensureStyles(){
    if (document.getElementById('pp_pagekit_css')) return;
    const style = document.createElement('style');
    style.id = 'pp_pagekit_css';
    style.textContent = `
      .pp-identity{display:grid;gap:6px;width:100%;margin-top:2px}
      .pp-identity .pp-input{height:32px;text-align:center}
      .pp-identity .pp-select>select{text-align:left}
      .pp-identity textarea.pp-input{height:58px;padding:7px 10px;resize:none;line-height:1.35}
      .pp-members{height:100%;min-height:0;overflow-y:auto}
      .pp-members .pp-list-head{padding-bottom:8px}
      .pp-tab-bar{display:flex;align-items:center;gap:10px;flex:none;min-height:34px;margin-bottom:10px}
      .pp-tab-bar>strong{color:var(--pp-strong);font-size:13px;font-weight:650}
      .pp-tab-bar>.pp-spacer{flex:1}
      .pp-types{display:grid;gap:3px;align-content:start}
      .pp-type{display:flex;align-items:center;gap:10px;min-width:0;min-height:40px;padding:0 6px 0 11px;border-radius:9px;background:var(--pp-soft)}
      .pp-type-name{flex:0 1 220px;min-width:90px;color:var(--pp-text);font-size:13px;font-weight:650;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
      .pp-type>.pp-chip-run{flex:1;min-width:0;flex-wrap:wrap;padding:4px 0}
      .pp-type-count{flex:none;color:var(--pp-muted);font-size:12px;font-variant-numeric:tabular-nums}
      .pp-form-grid{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:12px 14px;align-content:start}
      .pp-form-grid .wide{grid-column:span 2}
      .pp-form-grid .full{grid-column:1/-1}
      .pp-form-grid h5{grid-column:1/-1;margin:6px 0 -4px;color:var(--pp-muted);font-size:11px;font-weight:700;letter-spacing:.04em;text-transform:uppercase}
      .pp-form-grid h5:first-child{margin-top:0}
      @container (max-width:620px){.pp-form-grid{grid-template-columns:minmax(0,1fr)}.pp-form-grid .wide{grid-column:auto}}
      @media (max-width:760px){.pp-form-grid{grid-template-columns:minmax(0,1fr)}.pp-form-grid .wide{grid-column:auto}.pp-type{flex-wrap:wrap;padding:6px 6px 6px 11px}}
    `;
    document.head.appendChild(style);
  }
  ensureStyles();

  function identity(host, fields){
    const block = host.querySelector('.pp-sum-id');
    if (!block) return;
    block.querySelector('.pp-sum-name').hidden = true;
    const secondary = block.querySelector('.pp-sum-secondary');
    if (secondary) secondary.hidden = true;
    block.insertAdjacentHTML('afterbegin', `<div class="pp-identity">${fields.map((field) => field.type === 'select'
      ? kit.select({ value:field.value, options:field.options, label:field.placeholder, attrs:`data-identity="${esc(field.id)}"` })
      : field.type === 'textarea'
        ? `<textarea class="pp-input" data-identity="${esc(field.id)}" placeholder="${esc(field.placeholder)}" aria-label="${esc(field.placeholder)}">${esc(field.value || '')}</textarea>`
        : `<input class="pp-input" ${field.type === 'email' ? 'type="email"' : ''} data-identity="${esc(field.id)}" value="${esc(field.value || '')}" placeholder="${esc(field.placeholder)}" aria-label="${esc(field.placeholder)}" autocomplete="off" ${field.readOnly ? `readonly${tip(field.readOnly)}` : ''}>`).join('')}</div>`);
  }

  function checkMenu(anchor, options = {}){
    let selected = [...(options.selected || [])];
    const items = options.items || [];
    return kit.menu(anchor, {
      label:options.label, align:options.align, search:items.length > 8 ? t('search', 'Search') : '',
      items:items.map((item) => ({ ...item, checked:selected.includes(item.id) })),
      onSelect(item, menu){
        const on = !selected.includes(item.id);
        if (!on && options.min && selected.length <= options.min) return;
        selected = on ? [...selected, item.id] : selected.filter((id) => id !== item.id);
        menu.setChecked(item.id, on);
        options.onChange?.(selected, item, on);
      },
      onClose:() => options.refocus?.()
    });
  }

  /*
   * scopedRolesMenu(anchor, { place, kind:'department' | 'unit', selected:[roleIds], everywhere:[roleIds], onChange(next, roleId, on), refocus() })
   * The roles a person holds only for work in one department or one unit, titled with the place
   * ("Roles in Production"). Roles that administer the whole organization are not offered; a role the
   * person already holds everywhere is shown but cannot be added again.
   */
  function scopedRolesMenu(anchor, options = {}){
    let selected = [...(options.selected || [])];
    const everywhere = new Set(options.everywhere || []);
    const offered = data.scopableRoles();
    const kept = selected.filter((id) => !offered.some((role) => role.id === id)).map((id) => data.role(id) || { id, name:id });
    const place = options.place || '';
    return kit.menu(anchor, {
      title:t('roles_in', 'Roles in {place}', { place }),
      titleTip:options.kind === 'unit'
        ? t('roles_in_unit_tip', 'These apply only to work in {place} and its departments.', { place })
        : t('roles_in_department_tip', 'These apply only to work in {place}.', { place }),
      align:options.align || 'end', search:offered.length > 8 ? t('search_roles', 'Search roles') : '',
      items:[...offered, ...kept].map((role) => {
        const held = everywhere.has(role.id) && !selected.includes(role.id);
        return { id:role.id, label:role.name || role.id, checked:selected.includes(role.id), disabled:held, hint:held ? t('everywhere_short', 'everywhere') : '', tooltip:held ? t('held_everywhere', 'Already held everywhere') : role.description };
      }),
      onSelect(item, menu){
        const on = !selected.includes(item.id);
        selected = on ? [...selected, item.id] : selected.filter((id) => id !== item.id);
        menu.setChecked(item.id, on);
        options.onChange?.(selected, item.id, on);
      },
      onClose:() => options.refocus?.()
    });
  }

  function userRow(user, extra = {}){
    const suspended = data.isSuspended(user);
    return {
      key:user.id,
      entity:{ id:user.id, name:user.name || user.email, photoUrl:data.assetUrl(user.profile_photo_url || user.profile_photo) },
      online:user.id,
      title:user.name || user.email || user.id,
      secondary:user.name ? user.email : '',
      pills:[...(extra.pills || []), ...(suspended ? [{ label:t('suspended', 'Suspended'), tone:'danger' }] : [])],
      chipGroups:extra.chips ? [{ chips:extra.chips, tone:extra.chipTone }] : [],
      actions:extra.actions || [],
      hover:`organization_user:${user.id}`,
      dimmed:suspended
    };
  }
  const byName = (left, right) => String(left.name || left.email || '').localeCompare(String(right.name || right.email || ''));

  function peopleList(panel, options = {}){
    panel.classList.add('pp-members');
    let query = '';
    const visible = () => options.items().filter((item) => !query || `${item.user.name} ${item.user.email}`.toLowerCase().includes(query)).sort((left, right) => byName(left.user, right.user));
    const list = People.listPage.mount(panel, {
      embedded:true,
      title:options.title || t('members', 'Members'),
      subtitle:options.count(),
      search:{ placeholder:options.search || t('search_members', 'Search members'), onInput(value){ query = value.trim().toLowerCase(); list.setItems(visible()); } },
      actions:[...(options.actions || []), ...(options.add ? [{ id:'add', label:options.add.label || t('add_people', 'Add people'), icon:'fa-user-plus', menu:true, onClick(button){
        kit.menu(button, {
          align:'end', label:options.add.label || t('add_people', 'Add people'), search:t('search_users', 'Search users'),
          items:options.add.candidates().sort((left, right) => byName(left.user, right.user)).map((candidate) => ({ id:candidate.user.id, label:candidate.user.name || candidate.user.email || candidate.user.id, checked:candidate.checked === true, hint:candidate.hint || '', disabled:candidate.disabled === true, tooltip:candidate.tooltip })),
          onSelect(item, menu){
            const candidate = options.add.candidates().find((entry) => entry.user.id === item.id);
            const on = !(candidate?.checked === true);
            menu.setChecked(item.id, on);
            options.add.onToggle(candidate.user, on);
          }
        });
      } }] : [])],
      empty:options.empty || { icon:kit.ICONS.users, title:t('no_members', 'No members') },
      row:(item) => userRow(item.user, item),
      onOpen:(item, row) => options.onOpen?.(item.user, row),
      onAction:(action, item, button) => options.onAction?.(action, item.user, button)
    });
    const detach = People.hoverCard.attach(list.el, {});
    list.setItems(visible());
    return {
      el:list.el,
      refresh(){ list.setItems(visible()); list.setSubtitle(options.count()); },
      destroy(){ detach(); list.destroy(); }
    };
  }

  /* One resolver for every kind, so a hover card works wherever a key is marked. */
  function resolveHover(key){
    const [kind, ...rest] = String(key || '').split(':');
    const id = rest.join(':');
    if (kind === 'organization_user') { const user = data.user(id); return user ? data.userSummary(user) : null; }
    if (kind === 'resource_group') { const group = data.group(id); return group ? data.groupSummary(group) : null; }
    if (kind === 'organization_connection') { const company = data.company(id); return company ? data.companySummary(company) : null; }
    if (kind === 'department') { const department = data.department(id); return department ? data.departmentSummary(department) : null; }
    return null;
  }
  ['organization_user', 'resource_group', 'organization_connection', 'department'].forEach((kind) => People.hoverCard.register(kind, resolveHover));

  People.pageKit = { identity, checkMenu, scopedRolesMenu, peopleList, userRow, resolveHover, failed, byName };
})();
