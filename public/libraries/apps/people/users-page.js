/* public/libraries/apps/people/users-page.js
 *
 * People > Users. The list of people, the user modal, the role modal and
 * invitations, built from the shared People pieces:
 *
 *   listPage          header and rows
 *   entityModal       the large modal for a user and for a role
 *   hoverCard         the summary on hover
 *   permissionsPanel  a user's overrides over their roles, and a role's own permissions
 *   appGrid           which tabs on which platform
 *   slots             Compensation and Fields, filled by the modules that own them
 *
 *   const page = FirstMatePeople.usersPage.mount(container, {
 *     entity: 'user:<id>' | 'role:<id>',      // open this on arrival (deep link)
 *     onEntity(key) {}                        // told what is open ('' when closed), for the route
 *   });
 *   page.refresh()   page.openUser(id)   page.openRole(id)   page.destroy()
 *
 * Rules kept here: a user's types are their roles (several allowed); group
 * membership is shown, never edited, on the user; departments can be set on
 * the user; nothing is saved until Save, except actions that are their own
 * verb (invite, suspend, delete, a role's members).
 */
(function(){
  'use strict';
  const People = window.FirstMatePeople = window.FirstMatePeople || {};
  if (People.usersPage) return;
  const kit = People.kit;
  const data = People.data;
  const { esc, t, tip } = kit;
  const same = (left, right) => JSON.stringify(left) === JSON.stringify(right);
  const sorted = (list) => [...list].sort();
  const failed = (title, error) => kit.toast(title, error?.message || t('try_again_later', 'Try again in a moment.'), false);

  function ensureStyles(){
    if (document.getElementById('pp_users_css')) return;
    const style = document.createElement('style');
    style.id = 'pp_users_css';
    style.textContent = `
      .pp-identity{display:grid;gap:6px;width:100%;margin-top:2px}
      .pp-identity .pp-input{height:32px;text-align:center}
      .pp-identity textarea.pp-input{height:58px;padding:7px 10px;resize:none;line-height:1.35}
      .pp-activity{list-style:none;margin:0;padding:0;columns:2 300px;column-gap:24px}
      .pp-activity>li{display:flex;align-items:center;gap:9px;min-height:32px;padding:0 4px;break-inside:avoid;font-size:12.5px}
      .pp-activity>li>i{flex:none;width:14px;text-align:center;color:var(--pp-faint);font-size:11px}
      .pp-activity>li>span{flex:1;min-width:0;color:var(--pp-strong);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
      .pp-activity>li>time{flex:none;color:var(--pp-muted);font-size:11.5px;font-variant-numeric:tabular-nums}
      .pp-members{height:100%;min-height:0;overflow-y:auto}
      .pp-members .pp-list-head{padding-bottom:8px}
    `;
    document.head.appendChild(style);
  }

  function mount(container, options = {}){
    if (!container) throw new Error('usersPage.mount requires a container.');
    ensureStyles();
    const can = data.can;
    let query = '';
    let destroyed = false;
    let openEntity = null;      // { key, modal, refresh() }
    let lastLoad = 0;
    /* Organizations without roles keep an admin level and seven flags per user. */
    const legacy = data.legacyMode();
    const LEVEL_LABELS = { viewer:'Viewer', manager:'Manager', admin:'Admin', super_admin:'Super admin', custom:'Custom' };
    const FLAG_LABELS = { order_reports:'Order reports', view_reports:'View reports', manage_billing:'Manage billing', manage_company_settings:'Manage company settings', manage_report_settings:'Manage report settings', manage_company_users:'Manage users', manage_company_user_permissions:'Manage user permissions' };

    /* ---------- the list ---------- */
    function rowModel(user){
      if (user.deleted) return { key:user.id, entity:{ id:user.id, name:user.name || user.email, photoUrl:data.assetUrl(user.profile_photo_url || user.profile_photo) }, title:user.name || user.email || user.id, secondary:user.name ? user.email : '', pills:[{ label:t('archived', 'Archived'), tone:'neutral' }], chipGroups:[], actions:[], dimmed:true };
      const roles = data.userRoles(user);
      const departments = data.userDepartments(user);
      const me = data.isMe(user);
      const protectedUser = me || data.isOwner(user);
      const suspended = data.isSuspended(user);
      const never = data.neverSignedIn(user);
      const pills = [];
      if (me) pills.push({ label:t('you', 'You'), tone:'role' });
      if (suspended) pills.push({ label:t('suspended', 'Suspended'), tone:'danger' });
      else if (never) pills.push({ label:t('never_signed_in', 'Never signed in'), tone:'warn', tooltip:t('never_signed_in_tip', 'Invited, has not signed in yet') });
      return {
        key:user.id,
        entity:{ id:user.id, name:user.name || user.email, photoUrl:data.assetUrl(user.profile_photo_url || user.profile_photo) },
        online:user.id,
        photoAction:can.users ? t('change_photo', 'Change photo') : '',
        title:user.name || user.email || user.id,
        secondary:user.name ? user.email : '',
        pills,
        chipGroups:[
          { chips:legacy ? [{ label:t(`level_${data.userLegacy(user).level}`, LEVEL_LABELS[data.userLegacy(user).level] || data.userLegacy(user).level), tone:'role' }] : roles.map((role) => ({ label:role.name || role.id, tone:'role' })), tone:'role' },
          { chips:departments.map((department) => ({ label:department.label, color:department.color })), max:2 }
        ],
        actions:[
          { id:'edit', icon:kit.ICONS.edit, label:t('edit', 'Edit') },
          can.users && never ? { id:'invite', icon:kit.ICONS.invite, label:t('resend_invite', 'Resend invitation') } : null,
          can.users ? { id:'suspend', icon:suspended ? kit.ICONS.resume : kit.ICONS.suspend, label:suspended ? t('resume', 'Reinstate') : t('suspend', 'Suspend'), disabled:protectedUser } : null,
          can.users ? { id:'delete', icon:kit.ICONS.remove, label:t('delete', 'Delete'), tone:'danger', disabled:protectedUser } : null
        ],
        hover:`organization_user:${user.id}`,
        dimmed:suspended
      };
    }
    /* Which users the chips show. The last two are reached from the overview's "needs attention" rows. */
    const FILTERS = {
      all:() => true,
      active:(user) => !data.isSuspended(user) && !data.neverSignedIn(user),
      never:(user) => data.neverSignedIn(user),
      suspended:(user) => data.isSuspended(user),
      no_role:(user) => !data.userRoleIds(user).length && !data.isSuspended(user),
      no_department:(user) => !data.userDepartments(user).length && !data.isSuspended(user)
    };
    let filter = FILTERS[options.filter] || options.filter === 'archived' ? options.filter : 'all';
    const filterItems = () => {
      const users = data.state.users;
      const count = (id) => users.filter(FILTERS[id]).length;
      return [
        { id:'all', label:t('filter_all', 'All') },
        { id:'active', label:t('filter_active', 'Active'), count:count('active') },
        { id:'never', label:t('never_signed_in', 'Never signed in'), count:count('never') },
        { id:'suspended', label:t('suspended', 'Suspended'), count:count('suspended') },
        { id:'archived', label:t('archived', 'Archived'), count:data.state.archivedUsers.length, tooltip:t('archived_users_tip', 'People who were deleted. They are kept for the record and cannot sign in.') },
        filter === 'no_role' ? { id:'no_role', label:t('filter_no_role', 'No role'), count:count('no_role') } : null,
        filter === 'no_department' ? { id:'no_department', label:t('filter_no_department', 'No department'), count:count('no_department') } : null
      ];
    };
    function visibleUsers(){
      const text = query.trim().toLowerCase();
      return (filter === 'archived' ? data.state.archivedUsers : data.state.users.filter(FILTERS[filter] || FILTERS.all)).filter((user) => {
        if (!text) return true;
        return [user.name, user.email, ...data.userRoles(user).map((role) => role.name), ...data.userDepartments(user).map((department) => department.label), ...data.userGroups(user).map((group) => group.name)]
          .join(' ').toLowerCase().includes(text);
      }).sort((left, right) => (Number(data.isMe(right)) - Number(data.isMe(left))) || String(left.name || left.email || '').localeCompare(String(right.name || right.email || '')));
    }
    function subtitle(shown){
      const users = data.state.users;
      const total = kit.countPhrase([[users.length, t('user_one', 'user'), t('user_many', 'users')], [users.filter(data.neverSignedIn).length, t('never_signed_in_count', 'never signed in')], [users.filter(data.isSuspended).length, t('suspended_count', 'suspended')]]);
      return query.trim() || filter !== 'all' ? t('matches_of', '{shown} of {total}', { shown:shown.toLocaleString(), total }) : total;
    }
    function renderList(){
      if (destroyed || !data.state.loaded) return;
      const users = visibleUsers();
      list.setItems(users);
      list.setSubtitle(subtitle(users.length));
      list.setFilters(filterItems(), filter);
    }

    const list = People.listPage.mount(container, {
      icon:kit.ICONS.users,
      title:t('users', 'Users'),
      subtitle:'',
      search:{ placeholder:t('search_users', 'Search users'), onInput(value){ query = value; renderList(); } },
      filters:{ items:[{ id:'all', label:t('filter_all', 'All') }], value:filter, onChange(next){ filter = next; renderList(); } },
      actions:[
        { id:'roles', label:t('roles', 'Roles'), icon:kit.ICONS.role, menu:true, onClick:openRolesMenu },
        can.users ? { id:'invite', label:t('invite_user', 'Invite user'), icon:'fa-user-plus', primary:true, onClick:openInvite } : null
      ].filter(Boolean),
      empty:{ icon:kit.ICONS.users, title:t('no_users', 'No users') },
      row:rowModel,
      onOpen:(user, row) => { if (!user.deleted) openUser(user.id, { opener:row.querySelector('[data-row-open]') }); },
      /* (rows are redrawn after a save, so focus returns to the row by key) */
      onAction:(action, user, button) => userAction(action, user, button),
      async onPhoto(user, file){
        try { await data.uploadPhoto(user.id, file); kit.toast(t('saved', 'Saved'), t('photo_updated', 'Photo updated.'), true); }
        catch (error) { failed(t('photo_failed_title', 'Photo not saved'), error); }
      }
    });
    const detachHover = People.hoverCard.attach(list.el, { resolve:(key) => { const user = data.user(String(key).split(':').slice(1).join(':')); return user ? data.userSummary(user) : null; } });
    const stopPresence = kit.presence.watch(data.orgId());
    const unsubscribe = data.subscribe((state, change) => {
      if (destroyed) return;
      if (change?.type === 'user' && !query && list.rowElement(change.id) && data.user(change.id)) { list.refreshRow(change.id, data.user(change.id)); list.setSubtitle(subtitle(visibleUsers().length)); }
      else renderList();
      openEntity?.refresh?.(change);
    });
    async function refresh(force = true){
      try {
        await data.load({ refresh:force });
        lastLoad = Date.now();
        renderList();
      } catch (error) {
        if (!data.state.loaded) list.setError(error?.message || t('load_failed', 'Could not load'), () => { list.setLoading(true); refresh(true); });
      }
    }
    const onVisible = () => { if (!destroyed && document.visibilityState === 'visible' && container.isConnected && container.getClientRects().length && Date.now() - lastLoad > 60000 && !People.entityModal.current()) refresh(true); };
    document.addEventListener('visibilitychange', onVisible);

    /* ---------- actions that are their own verb ---------- */
    async function resend(user){
      try {
        const result = await data.resendInvite(user.id);
        if (!result.emailed && result.activateUrl) { try { await navigator.clipboard.writeText(result.activateUrl); } catch (_) {} kit.toast(t('invite_link_copied', 'Invitation link copied'), t('invite_link_copied_detail', 'The email could not be sent, so the link is on your clipboard.'), true); }
        else kit.toast(t('invite_sent', 'Invitation sent'), user.email || '', true);
      } catch (error) { failed(t('invite_not_sent', 'Invitation not sent'), error); }
    }
    async function suspend(user){
      const next = !data.isSuspended(user);
      try { await data.setSuspended(user.id, next); kit.toast(next ? t('suspended', 'Suspended') : t('reinstated', 'Reinstated'), user.name || user.email || '', true); }
      catch (error) { failed(t('not_saved', 'Not saved'), error); }
    }
    async function remove(user, anchor){
      const yes = await kit.confirm(anchor, { title:t('delete_user_confirm', 'Delete {name}?', { name:user.name || user.email }), confirmLabel:t('delete', 'Delete'), tone:'danger' });
      if (!yes) return false;
      try { await data.removeUser(user.id); kit.toast(t('deleted', 'Deleted'), user.name || user.email || '', true); return true; }
      catch (error) { failed(t('not_deleted', 'Not deleted'), error); return false; }
    }
    function userAction(action, user, button){
      if (action === 'edit') openUser(user.id, { opener:button });
      else if (action === 'invite') resend(user);
      else if (action === 'suspend') suspend(user);
      else if (action === 'delete') remove(user, button);
    }
    function openInvite(button){
      const roles = data.activeRoles();
      /* Nothing is preselected unless the organization has a plain viewer role: a default must never grant more than intended. */
      const preferred = roles.find((role) => role.id === 'viewer');
      kit.form(button, {
        title:t('invite_user', 'Invite user'),
        submitLabel:t('send_invite', 'Send invitation'),
        submitIcon:kit.ICONS.invite,
        fields:[
          { id:'name', label:t('name', 'Name'), autocomplete:'off' },
          { id:'email', label:t('email', 'Email'), type:'email', required:true, autocomplete:'off' },
          { id:'photo', label:t('photo', 'Photo'), type:'photo' }
        ],
        choices:roles.length ? { id:'roleIds', label:t('roles', 'Roles'), items:roles.map((role) => ({ id:role.id, label:role.name || role.id, tooltip:role.description })), value:preferred ? [preferred.id] : [], min:1 } : null,
        submit:(values) => data.invite({ name:values.name, email:values.email, roleIds:values.roleIds || [], photo:values.photo || null })
      }).then(async (result) => {
        if (!result) return;
        if (!result.emailed && result.activateUrl) { try { await navigator.clipboard.writeText(result.activateUrl); } catch (_) {} kit.toast(t('invite_link_copied', 'Invitation link copied'), t('invite_link_copied_detail', 'The email could not be sent, so the link is on your clipboard.'), true); }
        else kit.toast(t('invite_sent', 'Invitation sent'), result.user?.email || '', true);
        if (result.profileError) kit.toast(t('roles_not_saved', 'Roles not saved'), result.profileError, false);
        if (result.photoError) kit.toast(t('photo_failed_title', 'Photo not saved'), result.photoError, false);
      });
    }

    /* ---------- the user modal ---------- */
    function openUser(id, extra = {}){
      const start = data.user(id);
      if (!start) return null;
      const baseline = () => {
        const user = data.user(id) || start;
        return { name:user.name || '', email:user.email || '', roleIds:data.userRoleIds(user), departmentIds:data.userDirectDepartmentIds(user), permissionOverrides:data.userPermissionOverrides(user), appOverrides:data.userAppOverrides(user), tagIds:data.userTagIds(user), scopedAssignments:data.userScopedAssignments(user), legacy:data.userLegacy(user) };
      };
      let base = baseline();
      const draft = JSON.parse(JSON.stringify(base));
      let editingIdentity = false;
      let permissions = null;
      let apps = null;
      let appsPanel = null;
      const current = () => data.user(id) || start;
      const reachableApps = () => {
        const applications = new Set(draft.roleIds.flatMap((roleId) => data.roleApplications(data.role(roleId) || {})));
        const reachable = data.state.apps.filter((app) => applications.has(app.application_id) || draft.appOverrides[app.id]);
        return reachable.length ? reachable : data.state.apps;
      };
      const sync = () => {
        modal.setDirty('identity', draft.name.trim() !== base.name.trim() || draft.email.trim().toLowerCase() !== base.email.trim().toLowerCase());
        modal.setDirty('roles', !same(sorted(draft.roleIds), sorted(base.roleIds)));
        modal.setDirty('departments', !same(sorted(draft.departmentIds), sorted(base.departmentIds)));
        modal.setDirty('permission_overrides', !same(draft.permissionOverrides, base.permissionOverrides));
        modal.setDirty('app_overrides', !same(draft.appOverrides, base.appOverrides));
        modal.setDirty('tags', !same(sorted(draft.tagIds), sorted(base.tagIds)));
        modal.setDirty('scoped', !same(draft.scopedAssignments, base.scopedAssignments));
        modal.setDirty('legacy', !same(draft.legacy, base.legacy));
        modal.setTabBadge('permissions', Object.keys(draft.permissionOverrides).length || '');
        modal.setTabBadge('apps', Object.keys(draft.appOverrides).length || '');
      };
      const mountApps = () => {
        if (!appsPanel) return;
        apps?.destroy();
        apps = People.appGrid.mount(appsPanel, { apps:reachableApps(), value:draft.appOverrides, inherited:(appId) => data.inheritedApp(draft.roleIds)(appId), readOnly:!can.access, onChange(value){ draft.appOverrides = value; sync(); } });
      };
      const rolesChanged = () => { permissions?.refresh(); mountApps(); modal.refreshSummary(); sync(); };

      function drawSummary(host){
        const user = current();
        const model = data.userSummary(user, draft);
        const departmentCanAssign = data.state.departments.length && data.state.departmentState?.can_assign?.user !== false && (can.users || can.settings);
        model.sections.forEach((section) => {
          if (section.id === 'roles' && can.access) section.action = { id:'roles', label:t('change_roles', 'Change roles') };
          if (section.id === 'departments' && departmentCanAssign) section.action = { id:'departments', label:t('change_departments', 'Change departments') };
          if (section.id === 'tags' && can.access && data.state.tags.length) section.action = { id:'tags', label:t('change_tags', 'Change tags') };
          if (section.id === 'scoped' && can.permissions && !data.isMe(user) && (data.state.departments.length || data.state.divisions.length) && data.scopableRoles().length) section.action = { id:'scoped', label:t('change_scoped_roles', 'Change roles held in one department') };
        });
        model.sections = model.sections.filter((section) => !section.optional || section.action || section.chips.length);
        host.innerHTML = kit.summary(model, 'panel', { photoAction:can.users ? t('change_photo', 'Change photo') : '', editAction:can.users && !editingIdentity ? t('edit_identity', 'Edit name and email') : '' })
          + '<input type="file" class="pp-list-file" data-user-photo-input accept="image/png,image/jpeg,image/webp" tabindex="-1" aria-hidden="true">';
        if (editingIdentity) {
          const idBlock = host.querySelector('.pp-sum-id');
          idBlock.querySelector('.pp-sum-name').hidden = true;
          const secondary = idBlock.querySelector('.pp-sum-secondary');
          if (secondary) secondary.hidden = true;
          idBlock.insertAdjacentHTML('afterbegin', `<div class="pp-identity"><input class="pp-input" data-identity="name" value="${esc(draft.name)}" placeholder="${esc(t('name', 'Name'))}" aria-label="${esc(t('name', 'Name'))}" autocomplete="off"><input class="pp-input" type="email" data-identity="email" value="${esc(draft.email)}" placeholder="${esc(t('email', 'Email'))}" aria-label="${esc(t('email', 'Email'))}" autocomplete="off" ${data.isOwner(user) ? `readonly${tip(t('owner_email_locked', "An owner's email cannot be changed."))}` : ''}></div>`);
        }
      }
      function summaryClick(event){
        const host = event.currentTarget;
        if (event.target.closest('[data-people-identity]')) { editingIdentity = true; modal.refreshSummary(); host.querySelector('[data-identity="name"]')?.focus(); return; }
        if (event.target.closest('[data-people-photo]')) { const input = host.querySelector('[data-user-photo-input]'); input.value = ''; input.click(); return; }
        const sectionButton = event.target.closest('[data-people-section-action]');
        if (!sectionButton) return;
        const refocus = (sectionId) => modal.el.querySelector(`[data-people-section-action="${sectionId}"]`)?.focus();
        if (sectionButton.dataset.peopleSectionAction === 'roles') {
          kit.menu(sectionButton, {
            label:t('roles', 'Roles'), search:data.activeRoles().length > 8 ? t('search_roles', 'Search roles') : '',
            items:data.activeRoles().map((role) => ({ id:role.id, label:role.name || role.id, checked:draft.roleIds.includes(role.id), tooltip:role.description })),
            onSelect(item, menu){
              const on = !draft.roleIds.includes(item.id);
              draft.roleIds = on ? [...draft.roleIds, item.id] : draft.roleIds.filter((roleId) => roleId !== item.id);
              menu.setChecked(item.id, on);
              rolesChanged();
            },
            onClose:() => refocus('roles')
          });
        } else if (sectionButton.dataset.peopleSectionAction === 'tags') {
          People.pageKit.checkMenu(sectionButton, { label:t('tags', 'Tags'), items:data.state.tags.map((tag) => ({ id:String(tag.id), label:tag.name || tag.id })), selected:draft.tagIds, onChange(next){ draft.tagIds = next; modal.refreshSummary(); sync(); }, refocus:() => refocus('tags') });
        } else if (sectionButton.dataset.peopleSectionAction === 'scoped') {
          const label = (assignment) => `${data.role(assignment.role_id)?.name || assignment.role_id} \u00b7 ${(assignment.scope.kind === 'division' ? data.division(assignment.scope.id) : data.department(assignment.scope.id))?.label || assignment.scope.id}`;
          kit.menu(sectionButton, {
            label:t('scoped_roles', 'Roles here only'),
            items:[...draft.scopedAssignments.map((assignment, index) => ({ id:`held:${index}`, label:label(assignment), checked:true })), draft.scopedAssignments.length ? { separator:true } : null, { id:'__give', label:t('give_role_in_department', 'Give a role in one department'), icon:'fa-plus', tone:'accent' }],
            onSelect(item){
              if (item.id === '__give') {
                window.setTimeout(() => kit.form(modal.el.querySelector('[data-people-section-action="scoped"]'), {
                  title:t('give_role_in_department', 'Give a role in one department'), submitLabel:t('give', 'Give'), align:'start',
                  fields:[
                    { id:'roleId', label:t('role', 'Role'), type:'select', required:true, placeholder:t('choose', 'Choose'), options:data.scopableRoles().map((role) => ({ value:role.id, label:role.name || role.id })) },
                    { id:'departmentId', label:data.state.groupLabels.departmentSingular || t('department', 'Department'), type:'select', required:true, placeholder:t('choose', 'Choose'), options:[...data.state.departments.map((department) => ({ value:`department:${department.id}`, label:department.label || department.id })), ...data.state.divisions.map((unit) => ({ value:`division:${unit.id}`, label:`${unit.label} (${unit.kind || t('division', 'Division')})` }))] }
                  ]
                }).then((values) => {
                  if (!values) return;
                  const [scopeKind, ...scopeRest] = String(values.departmentId).split(':');
                  const scope = { kind:scopeKind, id:scopeRest.join(':') };
                  if (!draft.scopedAssignments.some((assignment) => assignment.role_id === values.roleId && assignment.scope.kind === scope.kind && assignment.scope.id === scope.id)) draft.scopedAssignments = [...draft.scopedAssignments, { role_id:values.roleId, scope }];
                  modal.refreshSummary(); sync();
                }), 0);
                return;
              }
              draft.scopedAssignments = draft.scopedAssignments.filter((_, index) => `held:${index}` !== item.id);
              modal.refreshSummary(); sync();
              return true;
            },
            onClose:() => refocus('scoped')
          });
        } else {
          const inherited = new Map(data.userDepartments(current()).filter((department) => department.sources.some((source) => source.kind !== 'direct')).map((department) => [department.id, department]));
          kit.menu(sectionButton, {
            label:t('departments', 'Departments'), search:data.state.departments.length > 8 ? t('search_departments', 'Search departments') : '',
            items:data.state.departments.map((department) => ({ id:department.id, label:department.label || department.name || department.id, color:department.color, checked:draft.departmentIds.includes(department.id), hint:inherited.has(department.id) && !draft.departmentIds.includes(department.id) ? t('inherited_short', 'inherited') : '', tooltip:inherited.has(department.id) ? t('department_inherited', 'Through a role or a group') : '' })),
            onSelect(item, menu){
              const on = !draft.departmentIds.includes(item.id);
              draft.departmentIds = on ? [...draft.departmentIds, item.id] : draft.departmentIds.filter((departmentId) => departmentId !== item.id);
              menu.setChecked(item.id, on);
              modal.refreshSummary();
              sync();
            },
            onClose:() => refocus('departments')
          });
        }
      }
      const user = current();
      const entity = data.entityFor('organization_user', id, user.name || user.email);
      const modal = People.entityModal.open({
        label:user.name || user.email || t('user', 'User'),
        opener:extra.opener,
        returnFocus:() => list.rowElement(id)?.querySelector('[data-row-open]'),
        tab:extra.tab,
        summary:drawSummary,
        actions(){
          const now = current();
          const protectedUser = data.isMe(now) || data.isOwner(now);
          if (!can.users) return [];
          return [
            data.neverSignedIn(now) ? { id:'invite', icon:kit.ICONS.invite, label:t('resend_invite', 'Resend invitation'), onClick:() => resend(now) } : null,
            { id:'suspend', icon:data.isSuspended(now) ? kit.ICONS.resume : kit.ICONS.suspend, label:data.isSuspended(now) ? t('resume', 'Reinstate') : t('suspend', 'Suspend'), disabled:protectedUser, onClick:() => suspend(now) },
            { id:'delete', icon:kit.ICONS.remove, label:t('delete', 'Delete'), tone:'danger', disabled:protectedUser, onClick:async (button) => { if (await remove(now, button)) modal.close(true); } }
          ];
        },
        tabs:[
          legacy ? { id:'permissions', label:t('permissions', 'Permissions'), icon:kit.ICONS.permissions, mount(panel){
            /* The admin level is a dropdown; the seven flags are switches. Changing a flag makes the level Custom. */
            const locked = !can.permissions || data.isMe(current()) || data.isOwner(current());
            let flags = null;
            const draw = () => {
              flags?.destroy();
              panel.innerHTML = `<div style="display:flex;flex-direction:column;height:100%;min-height:0;gap:10px"><div class="pp-tab-bar" style="margin:0"><label class="pp-field" style="width:220px"><span>${esc(t('admin_level', 'Admin level'))}</span>${kit.select({ value:draft.legacy.level, options:[...data.LEGACY_LEVELS, 'custom'].map((level) => ({ value:level, label:t(`level_${level}`, LEVEL_LABELS[level]) })), label:t('admin_level', 'Admin level'), attrs:'data-legacy-level', disabled:locked })}</label>${locked ? kit.info(t('legacy_locked_tip', 'Your own level and an owner\u2019s level cannot be changed here.')) : ''}</div><div data-legacy-flags style="flex:1;min-height:0"></div></div>`;
              flags = People.permissionsPanel.mount(panel.querySelector('[data-legacy-flags]'), { level:'legacy', groups:[{ id:'general', label:t('permissions', 'Permissions'), icon:kit.ICONS.permissions, permissions:data.LEGACY_FLAGS.map((key) => ({ key, label:t(`flag_${key}`, FLAG_LABELS[key]) })) }], value:Object.fromEntries(Object.entries(draft.legacy.items).filter(([, on]) => on)), readOnly:locked, onChange(value){ draft.legacy = { level:'custom', items:Object.fromEntries(data.LEGACY_FLAGS.map((key) => [key, value[key] === true])) }; panel.querySelector('[data-legacy-level]').value = 'custom'; sync(); } });
            };
            draw();
            panel.addEventListener('change', (event) => { if (!event.target.matches('[data-legacy-level]')) return; const level = event.target.value; draft.legacy = { level, items:level === 'custom' ? draft.legacy.items : data.legacyLevelItems(level) }; draw(); sync(); });
            permissions = { refresh(){}, setValue(){ draw(); }, destroy(){ flags?.destroy(); } };
            return { destroy:() => flags?.destroy() };
          } } : { id:'permissions', label:t('permissions', 'Permissions'), icon:kit.ICONS.permissions, mount(panel){
            permissions = People.permissionsPanel.mount(panel, { level:'user', groups:data.permissionGroups(), value:draft.permissionOverrides, inherited:(key) => data.inheritedPermission(draft.roleIds)(key), readOnly:!can.access, onChange(value){ draft.permissionOverrides = value; sync(); } });
            return { destroy:() => permissions?.destroy() };
          } },
          { id:'apps', label:t('app_experience', 'App experience'), icon:kit.ICONS.apps, mount(panel){ appsPanel = panel; mountApps(); return { destroy:() => apps?.destroy() }; } },
          People.slots.tab('compensation', entity, { readOnly:!can.settings }),
          People.slots.tab('fields', entity, { readOnly:!can.users }),
          window.PlatformAPI?.userActivity?.list ? { id:'activity', label:t('activity', 'Activity'), icon:'fa-clock-rotate-left', mount(panel){
            /* What this person did, newest first: the record the old profile window showed. */
            panel.innerHTML = `<div class="pp-state" aria-busy="true"><i class="fas fa-clock-rotate-left" aria-hidden="true"></i></div>`;
            const now = current();
            window.PlatformAPI.userActivity.list(data.orgId(), { user:{ id:now.id, email:now.email, name:now.name }, limit:60 }).then((result) => {
              const events = (Array.isArray(result) ? result : result?.events || result?.items || []).slice(0, 60);
              if (!panel.isConnected) return;
              const when = (value) => { const date = new Date(value); return Number.isNaN(date.getTime()) ? '' : date.toLocaleString(undefined, { month:'short', day:'numeric', hour:'numeric', minute:'2-digit' }); };
              panel.innerHTML = events.length ? `<div class="pp-tab-bar"><strong>${esc(kit.countPhrase([[events.length, t('event_one', 'recent action'), t('event_many', 'recent actions')]]))}</strong></div><ol class="pp-activity">${events.map((event) => `<li><i class="fas ${/photo|media/.test(event.type) ? 'fa-camera' : /login|sign/.test(event.type) ? 'fa-right-to-bracket' : /project/.test(event.type) ? 'fa-briefcase' : 'fa-circle-dot'}" aria-hidden="true"></i><span>${esc(event.summary || String(event.type || '').replace(/[._-]+/g, ' '))}</span><time>${esc(when(event.occurred_at || event.created_at))}</time></li>`).join('')}</ol>`
                : `<div class="pp-state"><i class="fas fa-clock-rotate-left" aria-hidden="true"></i><strong>${esc(t('no_activity', 'No activity yet'))}</strong></div>`;
            }).catch((error) => { if (panel.isConnected) panel.innerHTML = `<div class="pp-state" role="alert"><i class="fas fa-triangle-exclamation" aria-hidden="true"></i><strong>${esc(error?.message || t('load_failed', 'Could not load'))}</strong></div>`; });
            return {};
          } } : null
        ].filter(Boolean),
        async onSave(){
          const patch = {};
          if (draft.name.trim() !== base.name.trim() || draft.email.trim().toLowerCase() !== base.email.trim().toLowerCase()) { patch.name = draft.name; patch.email = draft.email; }
          const accessChanged = !same(sorted(draft.roleIds), sorted(base.roleIds)) || !same(draft.permissionOverrides, base.permissionOverrides) || !same(draft.appOverrides, base.appOverrides);
          if (accessChanged) { patch.roleIds = draft.roleIds; patch.permissionOverrides = draft.permissionOverrides; patch.appOverrides = draft.appOverrides; }
          const departmentsChanged = !same(sorted(draft.departmentIds), sorted(base.departmentIds));
          if (!same(sorted(draft.tagIds), sorted(base.tagIds))) patch.tagIds = draft.tagIds;
          if (!same(draft.scopedAssignments, base.scopedAssignments)) patch.scopedAssignments = draft.scopedAssignments;
          if (!same(draft.legacy, base.legacy)) patch.legacy = draft.legacy;
          if (Object.keys(patch).length) await data.saveUser(id, patch);
          if (departmentsChanged) await data.saveUserDepartments(id, draft.departmentIds);
          base = baseline();
          Object.assign(draft, JSON.parse(JSON.stringify(base)));
          editingIdentity = false;
          modal.refreshSummary();
          permissions?.setValue(draft.permissionOverrides);
          mountApps();
          if (data.isMe(current()) && (accessChanged || patch.email !== undefined)) {
            kit.toast(t('saved', 'Saved'), t('own_account_reload', 'Your own access changed. Reloading…'), true);
            window.setTimeout(() => window.location.reload(), 400);
          }
        },
        onClose(){ if (openEntity?.modal === modal) { openEntity = null; options.onEntity?.(''); } }
      });
      const summaryHost = modal.el.querySelector('[data-modal-summary]');
      summaryHost.addEventListener('click', summaryClick);
      summaryHost.addEventListener('input', (event) => {
        const field = event.target.closest('[data-identity]');
        if (!field) return;
        draft[field.dataset.identity] = field.value;
        sync();
      });
      summaryHost.addEventListener('change', async (event) => {
        const input = event.target.closest('[data-user-photo-input]');
        const file = input?.files?.[0];
        if (!file) return;
        try { await data.uploadPhoto(id, file); kit.toast(t('saved', 'Saved'), t('photo_updated', 'Photo updated.'), true); }
        catch (error) { failed(t('photo_failed_title', 'Photo not saved'), error); }
      });
      openEntity = { key:`user:${id}`, modal, refresh(change){
        if (!data.user(id)) { modal.close(true); return; }
        if (!modal.isDirty()) { base = baseline(); Object.assign(draft, JSON.parse(JSON.stringify(base))); }
        if (!editingIdentity || change?.type !== 'user') modal.refreshSummary();
        modal.refreshActions();
      } };
      options.onEntity?.(openEntity.key);
      sync();
      return modal;
    }

    /* ---------- roles ---------- */
    function openRolesMenu(button){
      const roles = data.activeRoles();
      kit.menu(button, {
        align:'end', label:t('roles', 'Roles'), search:roles.length > 8 ? t('search_roles', 'Search roles') : '',
        items:[
          ...roles.map((role) => ({ id:role.id, label:role.name || role.id, icon:kit.ICONS.role, hint:String(data.roleMembers(role.id).length), tooltip:role.description })),
          can.access && roles.length ? { separator:true } : null,
          can.access ? { id:'__new', label:t('new_role', 'New role'), icon:'fa-plus', tone:'accent' } : null
        ],
        onSelect(item){
          if (item.id === '__new') { window.setTimeout(() => newRole(button), 0); return; }
          window.setTimeout(() => openRole(item.id, { opener:button }), 0);
        }
      });
    }
    function newRole(button){
      kit.form(button, {
        title:t('new_role', 'New role'), submitLabel:t('create', 'Create'),
        fields:[{ id:'name', label:t('name', 'Name'), required:true }],
        submit:(values) => data.createRole({ name:values.name })
      }).then((role) => { if (role?.id) openRole(role.id, { opener:button }); });
    }
    function openRole(id, extra = {}){
      const start = data.role(id);
      if (!start) return null;
      const current = () => data.role(id) || start;
      const baseline = () => {
        const role = current();
        return { name:role.name || '', description:role.description || '', applicationIds:data.roleApplications(role), permissions:{ ...(role.permissions || role.permission_defaults || {}) }, appDefaults:data.roleAppValue(role) };
      };
      let base = baseline();
      const draft = JSON.parse(JSON.stringify(base));
      const system = current().is_system === true;
      const editable = can.access;
      let editingIdentity = false;
      let permissions = null;
      let permissionsPanel = null;
      let apps = null;
      let appsPanel = null;
      let members = null;
      const applicationLabel = (applicationId) => {
        const fromCatalog = data.state.applications.find((application) => String(application.id) === applicationId)?.label;
        return kit.term(`workforce.${applicationId}_application`, fromCatalog || (applicationId === 'field' ? t('field_app', 'Field') : t('office_app', 'Office')));
      };
      const sync = () => {
        modal.setDirty('identity', draft.name.trim() !== base.name.trim() || draft.description.trim() !== base.description.trim());
        modal.setDirty('applications', !same(sorted(draft.applicationIds), sorted(base.applicationIds)));
        modal.setDirty('role_permissions', !same(draft.permissions, base.permissions));
        modal.setDirty('role_apps', !same(draft.appDefaults, base.appDefaults));
      };
      /* Under "Everything", each permission inherits the grant and can only be carved out; otherwise it is a switch. */
      const mountPermissions = () => {
        if (!permissionsPanel) return;
        permissions?.destroy();
        const everything = draft.permissions['*'] === true;
        permissions = People.permissionsPanel.mount(permissionsPanel, {
          level:'role', groups:data.permissionGroups(), value:draft.permissions, readOnly:!editable,
          ...(everything ? { inherited:(key) => ({ allowed:key !== '*', sources:key === '*' ? [] : [t('permission_everything', 'Everything')] }) } : {}),
          onChange(value, key){
            const wasEverything = draft.permissions['*'] === true;
            draft.permissions = value;
            sync();
            if (key === '*' && wasEverything !== (value['*'] === true)) mountPermissions();
          }
        });
      };
      const mountApps = () => {
        if (!appsPanel) return;
        apps?.destroy();
        const list = data.state.apps.filter((app) => draft.applicationIds.includes(app.application_id));
        apps = People.appGrid.mount(appsPanel, { apps:list, value:draft.appDefaults, inherited:data.catalogDefaultApp(), readOnly:!editable, onChange(value){ draft.appDefaults = value; sync(); } });
      };
      function drawSummary(host){
        const role = current();
        const count = data.roleMembers(id).length;
        const model = {
          kind:'access_role', id, name:draft.name || role.id, secondary:draft.description, icon:kit.ICONS.role, color:'#3538cd',
          pills:system ? [{ label:t('built_in', 'Built-in'), tone:'neutral', tooltip:t('built_in_tip', 'Comes with the product and cannot be archived') }] : [],
          facts:[{ icon:kit.ICONS.users, label:t('members', 'Members'), value:count.toLocaleString() }],
          sections:[{ id:'applications', title:t('role_apps', 'Apps'), icon:kit.ICONS.apps, tooltip:t('role_apps_tip', 'Where people with this role work'), chips:draft.applicationIds.map((applicationId) => ({ label:applicationLabel(applicationId) })), empty:t('none', 'None'), action:editable ? { id:'applications', label:t('change_apps', 'Change apps') } : null }]
        };
        host.innerHTML = kit.summary(model, 'panel', { editAction:editable && !editingIdentity ? t('edit_role_identity', 'Edit name and description') : '' });
        if (editingIdentity) {
          const idBlock = host.querySelector('.pp-sum-id');
          idBlock.querySelector('.pp-sum-name').hidden = true;
          const secondary = idBlock.querySelector('.pp-sum-secondary');
          if (secondary) secondary.hidden = true;
          idBlock.insertAdjacentHTML('afterbegin', `<div class="pp-identity"><input class="pp-input" data-identity="name" value="${esc(draft.name)}" placeholder="${esc(t('name', 'Name'))}" aria-label="${esc(t('name', 'Name'))}" autocomplete="off"><textarea class="pp-input" data-identity="description" placeholder="${esc(t('description', 'Description'))}" aria-label="${esc(t('description', 'Description'))}">${esc(draft.description)}</textarea></div>`);
        }
      }
      const entity = data.entityFor('access_role', id, start.name);
      const modal = People.entityModal.open({
        label:start.name || t('role', 'Role'),
        opener:extra.opener,
        tab:extra.tab,
        summary:drawSummary,
        actions(){
          if (!editable || system) return [];
          return [{ id:'archive', icon:'fa-box-archive', label:t('archive_role', 'Archive role'), tone:'danger', onClick:async (button) => {
            const yes = await kit.confirm(button, { title:t('archive_role_confirm', 'Archive {name}?', { name:current().name || id }), confirmLabel:t('archive', 'Archive'), tone:'danger' });
            if (!yes) return;
            try { await data.archiveRole(id); kit.toast(t('archived', 'Archived'), current().name || '', true); modal.close(true); }
            catch (error) { failed(t('not_archived', 'Not archived'), error); }
          } }];
        },
        tabs:[
          { id:'permissions', label:t('permissions', 'Permissions'), icon:kit.ICONS.permissions, mount(panel){ permissionsPanel = panel; mountPermissions(); return { destroy:() => permissions?.destroy() }; } },
          { id:'members', label:t('members', 'Members'), icon:kit.ICONS.users, mount(panel, ctx){ members = mountMembers(panel, id, ctx.modal); return members; } },
          { id:'apps', label:t('app_experience', 'App experience'), icon:kit.ICONS.apps, mount(panel){ appsPanel = panel; mountApps(); return { destroy:() => apps?.destroy() }; } },
          People.slots.tab('compensation', entity, { readOnly:!can.settings }),
          People.slots.tab('fields', entity, { readOnly:!can.settings })
        ],
        async onSave(){
          const patch = {};
          if (draft.name.trim() !== base.name.trim()) patch.name = draft.name;
          if (draft.description.trim() !== base.description.trim()) patch.description = draft.description;
          if (!same(sorted(draft.applicationIds), sorted(base.applicationIds))) patch.applicationIds = draft.applicationIds;
          if (!same(draft.permissions, base.permissions)) patch.permissions = draft.permissions;
          if (!same(draft.appDefaults, base.appDefaults)) patch.appDefaults = draft.appDefaults;
          if (Object.keys(patch).length) await data.saveRole(id, patch);
          base = baseline();
          Object.assign(draft, JSON.parse(JSON.stringify(base)));
          editingIdentity = false;
          modal.refreshSummary();
          mountPermissions();
          mountApps();
        },
        onClose(){ if (openEntity?.modal === modal) { openEntity = null; options.onEntity?.(''); } }
      });
      const summaryHost = modal.el.querySelector('[data-modal-summary]');
      summaryHost.addEventListener('click', (event) => {
        if (event.target.closest('[data-people-identity]')) { editingIdentity = true; modal.refreshSummary(); summaryHost.querySelector('[data-identity="name"]')?.focus(); return; }
        const sectionButton = event.target.closest('[data-people-section-action="applications"]');
        if (!sectionButton) return;
        kit.menu(sectionButton, {
          label:t('role_apps', 'Apps'),
          items:['management', 'field'].map((applicationId) => ({ id:applicationId, label:applicationLabel(applicationId), checked:draft.applicationIds.includes(applicationId) })),
          onSelect(item, menu){
            const on = !draft.applicationIds.includes(item.id);
            if (!on && draft.applicationIds.length === 1) return;
            draft.applicationIds = on ? [...draft.applicationIds, item.id] : draft.applicationIds.filter((applicationId) => applicationId !== item.id);
            menu.setChecked(item.id, on);
            modal.refreshSummary();
            mountApps();
            sync();
          },
          onClose:() => modal.el.querySelector('[data-people-section-action="applications"]')?.focus()
        });
      });
      summaryHost.addEventListener('input', (event) => {
        const field = event.target.closest('[data-identity]');
        if (!field) return;
        draft[field.dataset.identity] = field.value;
        sync();
      });
      openEntity = { key:`role:${id}`, modal, refresh(change){
        if (!data.role(id) || String(data.role(id).status) === 'archived') { modal.close(true); return; }
        if (!modal.isDirty()) { base = baseline(); Object.assign(draft, JSON.parse(JSON.stringify(base))); }
        if (!editingIdentity) modal.refreshSummary();
        members?.refresh();
        void change;
      } };
      options.onEntity?.(openEntity.key);
      sync();
      return modal;
    }
    /* A role's members: the same rows as the Users list, added and removed here. Each change is saved as it is made. */
    function mountMembers(panel, roleId, modal){
      panel.classList.add('pp-members');
      let memberQuery = '';
      const items = () => data.roleMembers(roleId).filter((user) => !memberQuery || `${user.name} ${user.email}`.toLowerCase().includes(memberQuery))
        .sort((left, right) => String(left.name || left.email || '').localeCompare(String(right.name || right.email || '')));
      const count = () => kit.countPhrase([[data.roleMembers(roleId).length, t('member_one', 'member'), t('member_many', 'members')]]);
      const change = async (user, member) => {
        try { await data.setRoleMembership(user.id, roleId, member); modal.setStatus('saved', t('saved', 'Saved')); }
        catch (error) { failed(t('not_saved', 'Not saved'), error); }
      };
      const membersList = People.listPage.mount(panel, {
        embedded:true,
        title:t('members', 'Members'),
        subtitle:count(),
        search:{ placeholder:t('search_members', 'Search members'), onInput(value){ memberQuery = value.trim().toLowerCase(); membersList.setItems(items()); } },
        actions:can.access ? [{ id:'add', label:t('add_people', 'Add people'), icon:'fa-user-plus', menu:true, onClick(button){
          kit.menu(button, {
            align:'end', label:t('add_people', 'Add people'), search:t('search_users', 'Search users'),
            items:[...data.state.users].sort((left, right) => String(left.name || left.email || '').localeCompare(String(right.name || right.email || ''))).map((user) => ({ id:user.id, label:user.name || user.email || user.id, checked:data.userRoleIds(user).includes(String(roleId)) })),
            onSelect(item, menu){
              const user = data.user(item.id);
              const on = !data.userRoleIds(user).includes(String(roleId));
              menu.setChecked(item.id, on);
              change(user, on);
            }
          });
        } }] : [],
        empty:{ icon:kit.ICONS.users, title:t('no_members', 'No members') },
        row:(user) => ({
          key:user.id,
          entity:{ id:user.id, name:user.name || user.email, photoUrl:data.assetUrl(user.profile_photo_url || user.profile_photo) },
          online:user.id,
          title:user.name || user.email || user.id,
          secondary:user.name ? user.email : '',
          pills:data.isSuspended(user) ? [{ label:t('suspended', 'Suspended'), tone:'danger' }] : data.neverSignedIn(user) ? [{ label:t('never_signed_in', 'Never signed in'), tone:'warn' }] : [],
          actions:can.access ? [{ id:'remove', icon:'fa-user-minus', label:t('remove_from_role', 'Remove from role'), tone:'danger' }] : [],
          hover:`organization_user:${user.id}`,
          dimmed:data.isSuspended(user)
        }),
        onOpen(user, row){
          if (modal.isDirty()) { modal.setStatus('dirty', t('save_first', 'Save or discard your changes first')); return; }
          openUser(user.id, { opener:row.querySelector('[data-row-open]') });
        },
        onAction:(action, user) => { if (action === 'remove') change(user, false); }
      });
      const detach = People.hoverCard.attach(membersList.el, { resolve:(key) => { const user = data.user(String(key).split(':').slice(1).join(':')); return user ? data.userSummary(user) : null; } });
      membersList.setItems(items());
      return {
        refresh(){ membersList.setItems(items()); membersList.setSubtitle(count()); },
        destroy(){ detach(); membersList.destroy(); }
      };
    }

    refresh(false).then(() => {
      if (destroyed || !options.entity) return;
      const [kind, ...rest] = String(options.entity).split(':');
      if (kind === 'user') openUser(rest.join(':'));
      else if (kind === 'role') openRole(rest.join(':'));
    });

    return {
      refresh:() => refresh(true),
      openUser, openRole,
      destroy(){
        destroyed = true;
        document.removeEventListener('visibilitychange', onVisible);
        unsubscribe();
        detachHover();
        stopPresence();
        People.hoverCard.hide();
        openEntity?.modal.close(true);
        list.destroy();
      }
    };
  }

  People.usersPage = { mount };
  People.views.register('users', mount);
})();
