/* public/libraries/apps/people/departments-page.js
 *
 * People > Departments. Users, groups and outside companies belong to
 * departments (none, one or several); departments do not nest, but organizational
 * units do and hold them, so the list is sectioned by unit (else by category).
 *
 *   FirstMatePeople.departmentsPage.mount(container, { entity:'department:<id>', onEntity(key) }) -> { refresh(), openDepartment(id), destroy() }
 *
 * A department's name, color, icon and the roles and group types that put
 * people in it are saved with Save. Who is in it directly, and the roles that
 * apply only inside it, are saved as each change is made, through the same
 * assignment writers the rest of Settings uses.
 */
(function(){
  'use strict';
  const People = window.FirstMatePeople = window.FirstMatePeople || {};
  if (People.departmentsPage) return;
  const kit = People.kit;
  const data = People.data;
  const pageKit = People.pageKit;
  const { esc, t, tip } = kit;
  const same = (left, right) => JSON.stringify(left) === JSON.stringify(right);
  const sorted = (list) => [...list].sort();
  const clone = (value) => JSON.parse(JSON.stringify(value));
  const ICON_CHOICES = ['fa-sitemap', 'fa-handshake', 'fa-helmet-safety', 'fa-hammer', 'fa-screwdriver-wrench', 'fa-toolbox', 'fa-paint-roller', 'fa-house-chimney', 'fa-truck', 'fa-truck-fast', 'fa-warehouse', 'fa-boxes-stacked', 'fa-headset', 'fa-phone-volume', 'fa-bullhorn', 'fa-chart-line', 'fa-calculator', 'fa-dollar-sign', 'fa-coins', 'fa-scale-balanced', 'fa-clipboard-check', 'fa-pen-ruler', 'fa-compass-drafting', 'fa-laptop', 'fa-graduation-cap', 'fa-shield', 'fa-bolt', 'fa-faucet', 'fa-fire', 'fa-leaf', 'fa-store', 'fa-briefcase', 'fa-users', 'fa-building', 'fa-flag', 'fa-heart'];
  const COLOR_CHOICES = ['#2563eb', '#0891b2', '#0d9488', '#16a34a', '#65a30d', '#ca8a04', '#ea580c', '#dc2626', '#db2777', '#9333ea', '#4f46e5', '#64748b'];

  function ensureStyles(){
    if (document.getElementById('pp_departments_css')) return;
    const style = document.createElement('style');
    style.id = 'pp_departments_css';
    style.textContent = `
      .pp-picker{padding:12px;display:grid;gap:10px;width:292px;max-width:100%}
      .pp-picker-colors{display:flex;flex-wrap:wrap;gap:6px}
      .pp-swatch{width:22px;height:22px;padding:0;border:2px solid var(--pp-panel);border-radius:50%;box-shadow:0 0 0 1px var(--pp-line);cursor:pointer}
      .pp-swatch[aria-checked="true"]{box-shadow:0 0 0 2px var(--pp-text)}
      .pp-picker-icons{display:grid;grid-template-columns:repeat(9,1fr);gap:2px}
      .pp-picker-icons>button{display:grid;place-items:center;aspect-ratio:1;border:0;border-radius:7px;background:transparent;color:var(--pp-muted);font-size:13px;cursor:pointer}
      .pp-picker-icons>button:hover{background:var(--pp-hover);color:var(--pp-text)}
      .pp-picker-icons>button[aria-checked="true"]{background:var(--pp-picked,#64748b);color:#fff}
      .pp-dept-tab{display:flex;flex-direction:column;height:100%;min-height:0}
      .pp-dept-tab>.pp-seg{align-self:flex-start;margin-bottom:10px}
      .pp-dept-tab>[data-dept-list]{flex:1;min-height:0}
    `;
    document.head.appendChild(style);
  }

  function iconPicker(anchor, value, onPick){
    const panel = document.createElement('div');
    panel.className = 'pp-picker';
    panel.setAttribute('role', 'dialog');
    panel.setAttribute('aria-label', t('icon_and_color', 'Icon and color'));
    const state = { icon:value.icon || 'fa-sitemap', color:value.color || '#64748b' };
    const draw = () => {
      panel.style.setProperty('--pp-picked', state.color);
      panel.innerHTML = `<div class="pp-picker-colors" role="radiogroup" aria-label="${esc(t('color', 'Color'))}">${COLOR_CHOICES.map((color) => `<button type="button" class="pp-swatch" role="radio" aria-checked="${color.toLowerCase() === state.color.toLowerCase()}" data-pick-color="${color}" style="background:${color}" aria-label="${color}"></button>`).join('')}</div>
        <div class="pp-picker-icons" role="radiogroup" aria-label="${esc(t('icon', 'Icon'))}">${ICON_CHOICES.map((icon) => `<button type="button" role="radio" aria-checked="${icon === state.icon}" data-pick-icon="${icon}" aria-label="${esc(icon.replace(/^fa-/, '').replace(/-/g, ' '))}"><i class="fas ${icon}" aria-hidden="true"></i></button>`).join('')}</div>`;
    };
    draw();
    const handle = kit.layer(anchor, panel, { align:'start' });
    panel.addEventListener('click', (event) => {
      const color = event.target.closest('[data-pick-color]');
      const icon = event.target.closest('[data-pick-icon]');
      if (!color && !icon) return;
      if (color) state.color = color.dataset.pickColor;
      if (icon) state.icon = icon.dataset.pickIcon;
      draw();
      onPick({ ...state });
      panel.querySelector(color ? `[data-pick-color="${state.color}"]` : `[data-pick-icon="${state.icon}"]`)?.focus();
    });
    panel.querySelector('[aria-checked="true"]')?.focus();
    return handle;
  }

  function mount(container, options = {}){
    if (!container) throw new Error('departmentsPage.mount requires a container.');
    ensureStyles();
    const can = data.can;
    let query = '';
    let destroyed = false;
    let openEntity = null;
    const labels = () => data.state.groupLabels;
    const plural = () => labels().departmentPlural || t('departments', 'Departments');
    const singular = () => labels().departmentSingular || t('department', 'Department');
    const canManage = () => data.state.departmentState?.can_manage !== false && can.settings;
    const person = (user) => ({ id:user.id, name:user.name || user.email, photoUrl:data.assetUrl(user.profile_photo_url || user.profile_photo) });

    function rowModel(department){
      const members = data.departmentMembers(department);
      return {
        key:department.id, square:true,
        entity:{ id:department.id, name:department.label, icon:String(department.icon || kit.ICONS.department).split(' ').pop(), color:department.color || '#64748b' },
        title:department.label || department.id,
        // Sectioned by unit, a department's category is still worth seeing beside its name.
        pills:data.departmentNesting() === 'units' && data.category(department.group_id) ? [{ label:data.category(department.group_id).label, tone:'neutral', icon:'fa-folder' }] : [],
        // People and groups are counts with a few faces each, like the Users list; there may be dozens of groups.
        aside:`<span class="pp-stacks">${kit.stack(members.users.map((entry) => person(entry.user)), members.users.length, { label:kit.countPhrase([[members.users.length, t('user_one', 'user'), t('user_many', 'users')]]) })}${members.groups.length ? kit.stack(members.groups.map((entry) => ({ id:entry.group.id, name:entry.group.name || entry.group.id, icon:kit.ICONS.group, color:'#0e7090' })), members.groups.length, { square:true, label:members.groups.map((entry) => entry.group.name || entry.group.id).join(', ') }) : ''}</span>`,
        chipGroups:[{ chips:(department.role_ids || []).map((roleId) => ({ label:data.role(roleId)?.name || roleId, tone:'role' })), tone:'role' }],
        actions:[{ id:'edit', icon:kit.ICONS.edit, label:t('edit', 'Edit') }, canManage() ? { id:'archive', icon:'fa-box-archive', label:t('archive', 'Archive'), tone:'danger' } : null],
        hover:`department:${department.id}`
      };
    }
    const visible = () => data.state.departments.filter((department) => !query || String(department.label || '').toLowerCase().includes(query)).sort((left, right) => String(left.label || '').localeCompare(String(right.label || '')));
    const subtitle = () => {
      const count = data.state.departments.length;
      const without = data.state.users.filter((user) => !data.userDepartments(user).length).length;
      return `${count.toLocaleString()} ${count === 1 ? singular().toLowerCase() : plural().toLowerCase()}${without ? `, ${kit.countPhrase([[without, t('user_without', 'user in none'), t('users_without', 'users in none')]])}` : ''}`;
    };
    function renderList(){ if (destroyed || !data.state.loaded) return; list.setItems(visible()); list.setSubtitle(subtitle()); }
    async function archive(department, anchor){
      const yes = await kit.confirm(anchor, { title:t('archive_confirm', 'Archive {name}?', { name:department.label || department.id }), confirmLabel:t('archive', 'Archive'), tone:'danger' });
      if (!yes) return false;
      try { await data.archiveDepartment(department.id); kit.toast(t('archived', 'Archived'), department.label || '', true); return true; }
      catch (error) { pageKit.failed(t('not_archived', 'Not archived'), error); return false; }
    }
    const create = (button) => kit.form(button, {
      title:t('new_department', 'New {department}', { department:singular().toLowerCase() }), submitLabel:t('create', 'Create'),
      fields:[{ id:'label', label:t('name', 'Name'), required:true }],
      submit:(values) => data.saveDepartment({ label:values.label, color:COLOR_CHOICES[data.state.departments.length % COLOR_CHOICES.length] })
    }).then((department) => { if (department?.id) openDepartment(department.id, { opener:button }); });

    /* Sectioned the way the catalog organizes departments: by unit (with its parents), else by category. */
    function placeSection(department){
      const how = data.departmentNesting();
      if (!how) return null;
      const place = data.departmentPlace(department.id);
      if (!place.length) return { key:'none', title:how === 'units' ? t('not_in_unit', 'Not in a unit') : t('no_category', 'No category'), order:Number.MAX_SAFE_INTEGER };
      const last = place[place.length - 1];
      const order = data.departmentOutline({ loose:'last' }).findIndex((row) => row.kind === last.kind && row.id === last.id);
      return { key:`${last.kind}:${last.id}`, title:place.map((step) => step.label).join(' › '), icon:last.kind === 'unit' ? 'fa-diagram-project' : 'fa-folder', tooltip:last.tooltip || '', order };
    }
    const memberCount = (department) => data.departmentMembers(department).users.length;
    const list = People.listPage.mount(container, {
      // Few departments, each with several roles and groups: full-width rows.
      columns:false,
      section:placeSection,
      sorts:[
        { id:'name', label:t('sort_name', 'Name'), compare:(left, right) => String(left.label || '').localeCompare(String(right.label || '')) },
        { id:'members', label:t('sort_members', 'Members'), first:'desc', compare:(left, right) => (memberCount(left) - memberCount(right)) || String(right.label || '').localeCompare(String(left.label || '')) }
      ],
      sort:{ id:'name', dir:'asc' }, sortStore:'departments',
      icon:kit.ICONS.department, title:plural(), subtitle:'',
      search:{ placeholder:t('search', 'Search'), onInput(value){ query = value.trim().toLowerCase(); renderList(); } },
      actions:canManage() ? [{ id:'divisions', label:t('divisions_short', 'Units'), icon:'fa-diagram-project', tooltip:t('divisions', 'Organizational units'), onClick:(button) => People.lists.divisions({ opener:button }) }, { id:'categories', label:t('categories', 'Categories'), icon:'fa-folder', onClick:(button) => People.lists.categories({ opener:button }) }, { id:'new', label:t('new_department', 'New {department}', { department:singular().toLowerCase() }), icon:'fa-plus', primary:true, onClick:create }] : [],
      empty:{ icon:kit.ICONS.department, title:t('no_departments_yet', 'No {departments} yet', { departments:plural().toLowerCase() }) },
      row:rowModel,
      onOpen:(department, row) => openDepartment(department.id, { opener:row.querySelector('[data-row-open]') }),
      onAction:(action, department, button) => { if (action === 'edit') openDepartment(department.id, { opener:button }); else if (action === 'archive') archive(department, button); }
    });
    const detachHover = People.hoverCard.attach(list.el, {});
    const unsubscribe = data.subscribe((state, change) => { if (destroyed) return; renderList(); openEntity?.refresh?.(change); });
    async function refresh(force = true){
      try { await data.load({ refresh:force }); renderList(); }
      catch (error) { if (!data.state.loaded) list.setError(error?.message || t('load_failed', 'Could not load'), () => { list.setLoading(true); refresh(true); }); }
    }

    function openDepartment(id, extra = {}){
      const start = data.department(id);
      if (!start) return null;
      const current = () => data.department(id) || start;
      const appChoices = (defaults) => Object.fromEntries(Object.entries(defaults || {}).filter(([, entry]) => ['show', 'hide'].includes(entry?.visibility)).map(([appId, entry]) => [appId, entry.visibility]));
      const baseline = () => ({ label:current().label || '', color:current().color || '#64748b', icon:current().icon || '', role_ids:[...(current().role_ids || [])], group_kind_ids:[...(current().group_kind_ids || [])], group_id:current().group_id || '', division_id:current().division_id || '', default_channel:current().default_channel !== false, apps:appChoices(current().app_defaults) });
      let base = baseline();
      const draft = clone(base);
      let editing = false;
      let membersTab = null;
      let scoped = null;
      const editable = canManage();
      const sync = () => modal.setDirty('department', !same({ ...draft, role_ids:sorted(draft.role_ids), group_kind_ids:sorted(draft.group_kind_ids) }, { ...base, role_ids:sorted(base.role_ids), group_kind_ids:sorted(base.group_kind_ids) }));
      function drawSummary(host){
        const model = data.departmentSummary(current(), draft);
        model.sections.forEach((section) => { if (editable) section.action = { id:section.id, label:section.id === 'roles' ? t('change_roles', 'Change roles') : t('change_types', 'Change types') }; });
        model.sections = model.sections.filter((section) => section.action || section.chips.length);
        const category = data.state.departmentCategories.find((entry) => entry.id === draft.group_id);
        const unit = data.division(draft.division_id);
        model.pills = [...(category ? [{ label:category.label, tone:'neutral', icon:'fa-folder' }] : []), ...(unit ? [{ label:unit.label, tone:'neutral', icon:'fa-diagram-project' }] : [])];
        People.lists.ensureStyles();
        host.innerHTML = kit.summary(model, 'panel', { photoAction:editable ? t('icon_and_color', 'Icon and color') : '', photoIcon:'fa-palette', editAction:editable && !editing ? t('edit_department_identity', 'Edit name, category and unit') : '' })
          + `<div class="pp-sum-extra"><label class="pp-sum-switch"><i class="fas fa-hashtag" aria-hidden="true"></i><span>${esc(t('default_channel', 'Channel'))}</span>${kit.info(t('default_channel_tip', 'Keep a channel for this department that its members are in.'))}<button type="button" class="pp-switch" role="switch" data-dept-channel aria-checked="${draft.default_channel}" aria-label="${esc(t('default_channel', 'Channel'))}" ${editable ? '' : 'disabled'}></button></label></div>`;
        if (editing) pageKit.identity(host, [
          { id:'label', value:draft.label, placeholder:t('name', 'Name') },
          ...(data.state.departmentCategories.length ? [{ id:'group_id', type:'select', value:draft.group_id, placeholder:t('category', 'Category'), options:[{ value:'', label:t('no_category', 'No category') }, ...data.state.departmentCategories.map((entry) => ({ value:entry.id, label:entry.label }))] }] : []),
          ...(data.state.divisions.length ? [{ id:'division_id', type:'select', value:draft.division_id, placeholder:t('division', 'Unit'), options:[{ value:'', label:t('no_division', 'No unit') }, ...data.state.divisions.map((entry) => ({ value:entry.id, label:entry.label }))] }] : [])
        ]);
      }
      const saving = async (work) => { try { await work(); modal.setStatus('saved', t('saved', 'Saved')); } catch (error) { pageKit.failed(t('not_saved', 'Not saved'), error); } };
      /* Members: who is in this department directly, and who is there through a role, a group or a group type. */
      function mountMembers(panel){
        panel.innerHTML = `<div class="pp-dept-tab"><div class="pp-seg" role="tablist" aria-label="${esc(t('kind_of_member', 'Kind of member'))}">${[['users', t('users', 'Users'), kit.ICONS.users], ['groups', labels().plural || t('groups', 'Groups'), kit.ICONS.group], ['companies', labels().connectionPlural || t('subcontractors', 'Subcontractors'), kit.ICONS.company]].map(([kind, label, icon]) => `<button type="button" role="tab" data-dept-kind="${kind}" aria-selected="${kind === 'users'}"><i class="fas ${icon}" aria-hidden="true"></i>${esc(label)}<span class="pp-seg-count" data-dept-count="${kind}"></span></button>`).join('')}</div><div data-dept-list></div></div>`;
        const host = panel.querySelector('[data-dept-list]');
        let kind = 'users';
        let inner = null;
        const counts = () => { const members = data.departmentMembers(current()); ['users', 'groups', 'companies'].forEach((name) => { const badge = panel.querySelector(`[data-dept-count="${name}"]`); if (badge) { badge.textContent = members[name].length ? String(members[name].length) : ''; badge.style.background = 'var(--pp-hover)'; badge.style.color = 'var(--pp-muted)'; } }); };
        function show(){
          inner?.destroy();
          host.replaceChildren();
          if (kind === 'users') {
            inner = pageKit.peopleList(host, {
              count:() => kit.countPhrase([[data.departmentMembers(current()).users.length, t('member_one', 'member'), t('member_many', 'members')]]) || t('no_members', 'No members'),
              items:() => data.departmentMembers(current()).users.map((entry) => ({ user:entry.user, chips:entry.via.map((label) => ({ label, tone:'muted', tooltip:t('member_through', 'In this department through {source}', { source:label }) })), actions:editable && entry.direct ? [{ id:'remove', icon:'fa-user-minus', label:t('remove_member', 'Remove'), tone:'danger' }] : [] })),
              add:editable ? {
                candidates:() => data.state.users.map((user) => { const entry = data.departmentMembers(current()).users.find((item) => item.user.id === user.id); return { user, checked:!!entry?.direct, hint:entry && !entry.direct ? t('inherited_short', 'inherited') : '' }; }),
                onToggle:(user, on) => saving(() => data.saveUserDepartments(user.id, on ? [...data.userDirectDepartmentIds(user), id] : data.userDirectDepartmentIds(user).filter((departmentId) => departmentId !== id)))
              } : null,
              onAction:(action, user) => { if (action === 'remove') saving(() => data.saveUserDepartments(user.id, data.userDirectDepartmentIds(user).filter((departmentId) => departmentId !== id))); }
            });
          } else {
            const groups = kind === 'groups';
            const all = () => groups ? data.state.groups : data.state.connections;
            const members = () => groups ? data.departmentMembers(current()).groups.map((entry) => ({ item:entry.group, direct:entry.direct })) : data.departmentMembers(current()).companies.map((entry) => ({ item:entry.company, direct:true }));
            const directIds = (item) => (groups ? data.groupDepartments(item) : data.companyDepartments(item)).filter((department) => department.direct).map((department) => department.id);
            const toggle = (item, on) => saving(() => data.saveSubjectDepartments(groups ? 'group' : 'connection', item.id, on ? [...directIds(item), id] : directIds(item).filter((departmentId) => departmentId !== id)));
            const sub = People.listPage.mount(host, {
              embedded:true, subtitle:'',
              actions:editable ? [{ id:'add', label:t('add', 'Add'), icon:'fa-plus', menu:true, onClick(button){
                pageKit.checkMenu(button, { align:'end', label:t('add', 'Add'), items:all().map((item) => ({ id:String(item.id), label:item.name || item.id })), selected:members().filter((entry) => entry.direct).map((entry) => String(entry.item.id)), onChange:(next, item, on) => toggle(all().find((entry) => String(entry.id) === item.id), on) });
              } }] : [],
              empty:{ icon:groups ? kit.ICONS.group : kit.ICONS.company, title:t('none_here', 'None here yet') },
              row:(entry) => ({ key:entry.item.id, square:true, entity:{ id:entry.item.id, name:entry.item.name, icon:groups ? kit.ICONS.group : kit.ICONS.company, color:groups ? '#0e7090' : '#475467' }, title:entry.item.name || entry.item.id,
                pills:groups && entry.item.kind_id ? [{ label:data.typeName('resource_group', entry.item.kind_id), tone:'role' }] : [],
                chipGroups:entry.direct ? [] : [{ chips:[{ label:t('through_type', 'through its type'), tone:'muted' }] }],
                actions:editable && entry.direct ? [{ id:'remove', icon:'fa-xmark', label:t('remove_member', 'Remove'), tone:'danger' }] : [], hover:`${groups ? 'resource_group' : 'organization_connection'}:${entry.item.id}` }),
              onAction:(action, entry) => { if (action === 'remove') toggle(entry.item, false); }
            });
            const detach = People.hoverCard.attach(sub.el, {});
            const paint = () => { const items = members().sort((left, right) => String(left.item.name || '').localeCompare(String(right.item.name || ''))); sub.setItems(items); const words = groups ? [labels().singular || t('group', 'Group'), labels().plural || t('groups', 'Groups')] : [labels().connectionSingular || t('subcontractor', 'Subcontractor'), labels().connectionPlural || t('subcontractors', 'Subcontractors')]; sub.setSubtitle(items.length ? `${items.length} ${(items.length === 1 ? words[0] : words[1]).toLowerCase()}` : ''); };
            paint();
            inner = { refresh:paint, destroy(){ detach(); sub.destroy(); } };
          }
          counts();
        }
        panel.querySelector('.pp-seg').addEventListener('click', (event) => {
          const button = event.target.closest('[data-dept-kind]');
          if (!button) return;
          kind = button.dataset.deptKind;
          panel.querySelectorAll('[data-dept-kind]').forEach((other) => other.setAttribute('aria-selected', String(other === button)));
          show();
        });
        show();
        return { refresh(){ inner?.refresh(); counts(); }, destroy(){ inner?.destroy(); } };
      }
      /* The roles people hold only for work in this department, one row per person. They are stored on each user. */
      function mountScoped(panel){
        const roles = () => data.scopableRoles();
        const place = () => current().label || singular();
        const people = () => new Set(data.departmentScopedRoles(id).map((entry) => entry.user.id)).size;
        const rolesOf = (userId) => data.departmentScopedRoles(id).filter((entry) => entry.user.id === userId).map((entry) => entry.role_id);
        const list = pageKit.peopleList(panel, {
          title:t('roles_in', 'Roles in {place}', { place:place() }),
          count:() => people() ? t('people_with_roles_in', '{count} with roles in {place}', { count:kit.countPhrase([[people(), t('person_one', 'person'), t('person_many', 'people')]]), place:place() }) : t('nobody_with_roles_in', 'Nobody has roles only in {place}', { place:place() }),
          items:() => { const byUser = new Map(); data.departmentScopedRoles(id).forEach((entry) => { const self = data.isMe(entry.user); const item = byUser.get(entry.user.id) || { user:entry.user, chips:[], chipTone:'role', actions:can.permissions && !self ? [{ id:'roles', icon:kit.ICONS.role, label:t('change_roles_of_in', 'Change {name}’s roles in {place}', { name:entry.user.name || entry.user.email, place:place() }) }, { id:'remove', icon:'fa-xmark', label:t('remove_roles_of_in', 'Remove {name}’s roles in {place}', { name:entry.user.name || entry.user.email, place:place() }), tone:'danger' }] : [] }; item.chips.push({ label:data.role(entry.role_id)?.name || entry.role_id, tone:'role' }); byUser.set(entry.user.id, item); }); return [...byUser.values()]; },
          actions:can.permissions && roles().length ? [{ id:'give', label:t('give_role_in', 'Give a role in {place}', { place:place() }), icon:'fa-plus', onClick(button){
            kit.form(button, {
              title:t('give_role_in', 'Give a role in {place}', { place:place() }), submitLabel:t('give', 'Give'),
              fields:[
                { id:'userId', label:t('user', 'User'), type:'select', required:true, placeholder:t('choose', 'Choose'), options:[...data.state.users].filter((user) => !data.isMe(user)).sort(pageKit.byName).map((user) => ({ value:user.id, label:user.name || user.email || user.id })) },
                { id:'roleId', label:t('role', 'Role'), type:'select', required:true, placeholder:t('choose', 'Choose'), options:roles().map((role) => ({ value:role.id, label:role.name || role.id })) }
              ],
              submit:(values) => data.setScopedRole(values.userId, values.roleId, id, true)
            });
          } }] : [],
          onAction:(action, user, button) => {
            if (action === 'remove') queued(async () => { for (const roleId of rolesOf(user.id)) await data.setScopedRole(user.id, roleId, id, false); });
            else if (action === 'roles') pageKit.scopedRolesMenu(button, {
              place:place(), kind:'department', selected:rolesOf(user.id), everywhere:data.userRoleIds(user),
              onChange:(next, roleId, on) => queued(() => data.setScopedRole(user.id, roleId, id, on)),
              refocus:() => panel.querySelector(`[data-row-key="${CSS.escape(user.id)}"] [data-row-action="roles"]`)?.focus()
            });
          },
          empty:{ icon:kit.ICONS.role, title:t('nobody_with_roles_in', 'Nobody has roles only in {place}', { place:place() }) }
        });
        /* One write at a time: each reads the person's list as the last one left it. */
        let queue = Promise.resolve();
        const queued = (work) => (queue = queue.then(() => saving(work)));
        return list;
      }
      const entity = data.entityFor('department', id, start.label);
      const modal = People.entityModal.open({
        label:start.label || singular(), opener:extra.opener, returnFocus:() => list.rowElement(id)?.querySelector('[data-row-open]'), tab:extra.tab,
        summary:drawSummary,
        actions:() => editable ? [{ id:'archive', icon:'fa-box-archive', label:t('archive', 'Archive'), tone:'danger', onClick:async (button) => { if (await archive(current(), button)) modal.close(true); } }] : [],
        tabs:[
          { id:'members', label:t('members', 'Members'), icon:kit.ICONS.users, mount(panel){ membersTab = mountMembers(panel); return membersTab; } },
          { id:'apps', label:t('app_visibility', 'App visibility'), icon:kit.ICONS.apps, tooltip:t('app_visibility_tip', 'Tabs this department shows or hides for its members, over what their roles give'), mount(panel){
            const grid = People.appGrid.mount(panel, { apps:data.state.apps, value:draft.apps, inherited:data.catalogDefaultApp(), readOnly:!editable, onChange(value){ draft.apps = value; modal.setTabBadge('apps', Object.keys(value).length || ''); sync(); } });
            modal.setTabBadge('apps', Object.keys(draft.apps).length || '');
            return { destroy:() => grid.destroy() };
          } },
          { id:'scoped', label:t('roles_in', 'Roles in {place}', { place:start.label || singular() }), icon:kit.ICONS.role, tooltip:t('roles_in_department_tab_tip', 'Roles these people hold only for work in {place}. Roles on a user apply everywhere.', { place:start.label || singular() }), mount(panel){ scoped = mountScoped(panel); return scoped; } },
          People.slots.tab('fields', entity, { readOnly:!can.settings })
        ],
        async onSave(){
          /* A tab's show or hide is written into the department's app defaults; what else an entry carries (enforcement, layout) is kept. */
          const existing = current().app_defaults || {};
          const app_defaults = {};
          Object.entries(existing).forEach(([appId, entry]) => { if (draft.apps[appId]) app_defaults[appId] = { ...entry, visibility:draft.apps[appId] }; else if (entry && (entry.enforcement === 'restricted' || entry.params || entry.layout)) app_defaults[appId] = { ...entry, visibility:'inherit' }; });
          Object.entries(draft.apps).forEach(([appId, visibility]) => { if (!app_defaults[appId]) app_defaults[appId] = { visibility, enforcement:'default' }; });
          await data.saveDepartment({ id, label:draft.label, color:draft.color, icon:draft.icon, role_ids:draft.role_ids, group_kind_ids:draft.group_kind_ids, group_id:draft.group_id, division_id:draft.division_id, default_channel:draft.default_channel, app_defaults });
          base = baseline();
          Object.assign(draft, clone(base));
          editing = false;
          modal.refreshSummary();
        },
        onClose(){ if (openEntity?.modal === modal) { openEntity = null; options.onEntity?.(''); } }
      });
      const summaryHost = modal.el.querySelector('[data-modal-summary]');
      summaryHost.addEventListener('click', (event) => {
        if (event.target.closest('[data-people-identity]')) { editing = true; modal.refreshSummary(); summaryHost.querySelector('[data-identity="label"]')?.focus(); return; }
        const channel = event.target.closest('[data-dept-channel]');
        if (channel && !channel.disabled) { draft.default_channel = !draft.default_channel; channel.setAttribute('aria-checked', String(draft.default_channel)); sync(); return; }
        const photo = event.target.closest('[data-people-photo]');
        if (photo) { iconPicker(photo, { icon:String(draft.icon || 'fa-sitemap').split(' ').pop(), color:draft.color }, (picked) => { draft.icon = picked.icon; draft.color = picked.color; const avatar = summaryHost.querySelector('.pp-sum-photo .pp-avatar'); if (avatar) { avatar.style.setProperty('--pp-avatar-bg', picked.color); const glyph = avatar.querySelector('i'); if (glyph) glyph.className = `fas ${picked.icon}`; } sync(); }); return; }
        const button = event.target.closest('[data-people-section-action]');
        if (!button) return;
        const section = button.dataset.peopleSectionAction;
        const refocus = () => modal.el.querySelector(`[data-people-section-action="${section}"]`)?.focus();
        if (section === 'roles') pageKit.checkMenu(button, { label:t('roles', 'Roles'), items:data.activeRoles().map((role) => ({ id:role.id, label:role.name || role.id, tooltip:role.description })), selected:draft.role_ids, onChange(next){ draft.role_ids = next; modal.refreshSummary(); sync(); }, refocus });
        else pageKit.checkMenu(button, { label:t('types', 'Types'), items:data.types('resource_group').map((type) => ({ id:type.id, label:type.name, tooltip:type.description })), selected:draft.group_kind_ids, onChange(next){ draft.group_kind_ids = next; modal.refreshSummary(); sync(); }, refocus });
      });
      const onIdentity = (event) => { const field = event.target.closest('[data-identity]'); if (!field) return; draft[field.dataset.identity] = field.value; sync(); };
      summaryHost.addEventListener('input', onIdentity);
      summaryHost.addEventListener('change', onIdentity);
      openEntity = { key:`department:${id}`, modal, refresh(){
        if (!data.department(id)) { modal.close(true); return; }
        if (!modal.isDirty()) { base = baseline(); Object.assign(draft, clone(base)); }
        if (!editing && !document.querySelector('.pp-picker')) modal.refreshSummary();
        membersTab?.refresh();
        scoped?.refresh();
      } };
      options.onEntity?.(openEntity.key);
      sync();
      return modal;
    }

    refresh(false).then(() => {
      if (destroyed || !options.entity) return;
      const [kind, ...rest] = String(options.entity).split(':');
      if (kind === 'department') openDepartment(rest.join(':'));
    });
    return {
      refresh:() => refresh(true), openDepartment,
      destroy(){ destroyed = true; unsubscribe(); detachHover(); People.hoverCard.hide(); openEntity?.modal.close(true); list.destroy(); }
    };
  }

  People.departmentsPage = { mount, ICON_CHOICES };
  People.views.register('departments', mount);
})();
