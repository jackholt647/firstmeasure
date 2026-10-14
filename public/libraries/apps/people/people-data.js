/* public/libraries/apps/people/people-data.js
 *
 * What People knows, read through the APIs the Settings screens already use
 * (PlatformAPI.users, PlatformAPI.workforce). Nothing here adds an endpoint.
 * Every People page shares one store per organization.
 *
 *   const data = FirstMatePeople.data;
 *   await data.load({ refresh })          -> state
 *   data.state                             { users, roles, apps, permissionKeys, departments, groups, ... }
 *   data.subscribe(listener)               called after anything changes; returns unsubscribe
 *   data.can                               { users, permissions, access, settings }   what the viewer may do
 *
 * Reading (all synchronous, from the loaded state)
 *   data.user(id)  data.role(id)  data.activeRoles()
 *   data.userRoleIds(user)  data.userRoles(user)  data.userDepartments(user)  data.userGroups(user)
 *   data.neverSignedIn(user)  data.isSuspended(user)  data.isMe(user)  data.isOwner(user)
 *   data.roleMembers(roleId)  data.roleApplications(role)
 *   data.permissionGroups()                groups for permissionsPanel
 *   data.inheritedPermission(roleIds)      (key) => { allowed, sources }
 *   data.inheritedApp(roleIds)             (appId) => { shown, sources }
 *   data.userSummary(user, draft)          the kit.summary model for a person
 *
 * Writing (each resolves after the store is current again)
 *   data.invite({ name, email, roleIds, photo })
 *   data.resendInvite(id)  data.setSuspended(id, bool)  data.removeUser(id)
 *   data.saveUser(id, { name, email, roleIds, permissionOverrides, appOverrides })
 *   data.uploadPhoto(id, file)  data.saveUserDepartments(id, departmentIds)
 *   data.saveRole(id, { name, description, permissions, appDefaults, applicationIds })
 *   data.createRole({ name, applicationIds })  data.archiveRole(id)
 */
(function(){
  'use strict';
  const People = window.FirstMatePeople = window.FirstMatePeople || {};
  if (People.data) return;
  const kit = People.kit;
  const { t, term } = kit;

  const arr = (value) => Array.isArray(value) ? value : [];
  const obj = (value) => value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  const text = (...values) => { for (const value of values) { const clean = String(value ?? '').trim(); if (clean) return clean; } return ''; };
  const ids = (value) => [...new Set(arr(value).map((item) => text(item?.id, item?.role_id, item)).filter(Boolean))];
  const api = () => window.PlatformAPI;
  const orgId = () => String(window.__APP?.userOrgId || window.__APP?.orgId || '').trim();
  const branchId = () => String(window.Portal?.branchModules?.currentBranchId?.() || window.__APP?.userBranchId || 'default').trim() || 'default';
  const hasPerm = (key) => { try { return window.Portal?.util?.hasPerm?.(key) === true; } catch (_) { return false; } };
  const records = (result, ...keys) => {
    for (const key of keys) for (const source of [result, result?.data, result?.settings, result?.configuration]) if (Array.isArray(source?.[key])) return source[key];
    return Array.isArray(result) ? result : [];
  };
  function assetUrl(url){
    const raw = String(url || '').trim();
    if (!raw || /^(https?:|blob:|data:)/i.test(raw) || !/^(\/v1\/|organizations\/)/.test(raw)) return raw;
    try {
      const configured = String(window.__APP?.platformApiBase || '').trim().replace(/\/+$/, '');
      const local = ['127.0.0.1', 'localhost'].includes(String(location.hostname || '').toLowerCase());
      const base = configured || (local ? '' : `${location.origin}/v1/platform`);
      if (!base) return raw.startsWith('/') ? raw : '';
      return raw.startsWith('/') ? new URL(raw, base).href : `${base}/${raw}`;
    } catch (_) { return raw; }
  }
  const canonicalApplication = (value) => {
    const id = text(value).toLowerCase();
    return ['crew', 'workforce'].includes(id) ? 'field' : ['main', 'portal'].includes(id) ? 'management' : id;
  };

  const state = {
    loaded:false, orgId:'', users:[], roles:[], apps:[], applications:[], permissionKeys:[],
    departments:[], memberships:new Map(), departmentState:null, groups:[], groupLabels:{}, errors:{},
    configuration:{}, tags:[], connections:[], directory:new Map(), types:[], staffing:new Map(), scopes:[], archivedUsers:[], divisions:[], departmentCategories:[]
  };
  const listeners = new Set();
  let loading = null;
  const emit = (change = {}) => listeners.forEach((listener) => { try { listener(state, change); } catch (_) {} });

  const can = {
    get users(){ return hasPerm('manage_company_users'); },
    get permissions(){ return hasPerm('manage_company_user_permissions'); },
    get settings(){ return hasPerm('manage_company_settings'); },
    get access(){ return this.permissions || this.users || this.settings; }
  };

  function normalizeUser(doc){
    const user = api()?.users?.normalize ? api().users.normalize(doc || {}) : { id:doc?.id, ...obj(doc?.data || doc) };
    return { ...user, id:text(user.id, user.user_id) };
  }
  async function load(options = {}){
    if (state.loaded && !options.refresh && state.orgId === orgId()) return state;
    if (loading && !options.refresh) return loading;
    const org = orgId();
    const branch = branchId();
    const platform = api();
    if (!org || !platform?.users?.list) throw new Error(t('api_unavailable', 'People is unavailable right now.'));
    loading = (async () => {
      const target = { scope:'organization', organizationId:org };
      const published = (name) => platform.publication?.read?.(org, { provider:'assignee-directory', export:name, target });
      const [usersResult, profilesResult, catalogResult, departmentsResult, groupsResult, configurationResult, connectionsResult, directoryResult, typesResult, staffingResult, scopesResult] = await Promise.allSettled([
        platform.users.list(org),
        platform.workforce?.users?.(org, branch),
        platform.workforce?.accessCatalog?.(org),
        platform.workforce?.departments?.(org),
        platform.workforce?.resourceGroups?.(org, branch),
        platform.workforce?.configuration?.(org, branch),
        platform.connections?.list?.(org, { branchId:branch }),
        published('assignees'),
        published('types'),
        published('staffing-requirements'),
        platform.scopes?.list?.(org, branch, { include_disabled:true, includeDisabled:true })
      ]);
      if (usersResult.status !== 'fulfilled') throw usersResult.reason || new Error(t('load_failed', 'Could not load'));
      const profiles = new Map((profilesResult.status === 'fulfilled' ? records(profilesResult.value, 'users', 'workforce_users', 'profiles') : []).map(normalizeUser).map((user) => [user.id, user]));
      const everyone = arr(usersResult.value?.users).map(normalizeUser).filter((user) => user.id).map((user) => ({ ...(profiles.get(user.id) || {}), ...user, profile:profiles.get(user.id) || null }));
      state.users = everyone.filter((user) => !user.deleted);
      state.archivedUsers = everyone.filter((user) => user.deleted);
      state.errors = {};
      if (catalogResult.status === 'fulfilled' && catalogResult.value) {
        const catalog = catalogResult.value;
        state.roles = records(catalog, 'roles', 'access_roles').map((role) => ({ ...role, id:text(role.id, role.role_id) }));
        state.apps = records(catalog, 'apps', 'app_catalog').map((app) => ({
          ...app, id:text(app.id, app.app_id, app.runtime_app_id), title:text(app.title, app.label, app.id),
          application_id:canonicalApplication(text(app.application_id, app.application, 'field')),
          surface:text(app.surface, app.kind).toLowerCase() === 'project_modal_app' ? 'project_modal' : text(app.surface, 'portal_tab').toLowerCase(),
          devices:arr(app.devices).length ? arr(app.devices) : ['desktop', 'mobile']
        }));
        state.applications = arr(catalog.applications);
        state.permissionKeys = ids(catalog.permission_keys);
      } else state.errors.access = catalogResult.reason?.message || 'access';
      if (departmentsResult.status === 'fulfilled' && departmentsResult.value) {
        const departments = obj(departmentsResult.value.catalog || departmentsResult.value);
        state.departmentState = departments;
        state.departments = arr(departments.departments).filter((department) => department.status !== 'archived');
        state.memberships = new Map(arr(departments.effective_memberships).map((entry) => [String(entry.id), entry]));
        state.divisions = arr(departments.divisions).filter((division) => division.status !== 'archived');
        state.departmentCategories = arr(departments.groups);
      } else { state.departments = []; state.memberships = new Map(); state.departmentState = null; state.divisions = []; state.departmentCategories = []; }
      state.groups = groupsResult.status === 'fulfilled' ? records(groupsResult.value, 'resource_groups', 'groups').map((group) => ({ ...obj(group?.data), ...group })).filter((group) => group.status !== 'archived' && !group.archived_at) : [];
      const terminology = configurationResult.status === 'fulfilled' ? obj((configurationResult.value?.configuration || configurationResult.value)?.terminology) : {};
      state.groupLabels = {
        singular:t('group', 'Group'),
        plural:t('groups', 'Groups'),
        connectionPlural:term('workforce.organization_connection_plural', text(terminology.organization_connection_plural, obj(terminology.organization_connection).plural, t('subcontractors', 'Subcontractors'))),
        connectionSingular:term('workforce.organization_connection_singular', text(terminology.organization_connection_singular, obj(terminology.organization_connection).singular, t('subcontractor', 'Subcontractor'))),
        departmentSingular:text(obj(obj(state.departmentState?.terminology).department).singular, t('department', 'Department')),
        departmentPlural:text(obj(obj(state.departmentState?.terminology).department).plural, t('departments', 'Departments'))
      };
      /* Groups keep their full rows (members, tags, revision): the group page edits them. */
      state.configuration = configurationResult.status === 'fulfilled' ? obj(configurationResult.value?.configuration || configurationResult.value) : {};
      state.tags = arr(state.configuration.assignment_tags).filter((tag) => tag && tag.status !== 'archived' && text(tag.id));
      state.connections = connectionsResult.status === 'fulfilled' ? records(connectionsResult.value, 'connections', 'organization_connections').map((entry) => ({ ...obj(entry?.data), ...entry, id:text(entry?.id) })).filter((entry) => entry.id && entry.status !== 'archived' && !entry.archived_at) : [];
      if (connectionsResult.status !== 'fulfilled') state.errors.connections = connectionsResult.reason?.message || 'connections';
      /* The assignee directory is enrichment: traits, type names and link status. Every page works without it. */
      const value = (result) => (result.status === 'fulfilled' && result.value && (result.value.status === undefined || result.value.status === 'ready') ? result.value.value : null);
      state.directory = new Map(arr(value(directoryResult)).map((row) => [String(row.id), row]));
      const publishedTypes = value(typesResult);
      state.types = Array.isArray(publishedTypes) ? publishedTypes : [
        ...arr(state.configuration.resource_group_kinds).map((entry) => ({ id:text(entry.id), name:text(entry.name, entry.label, entry.id), description:text(entry.description), status:text(entry.status, 'active'), kind:'resource_group', member_role_ids:ids(entry.member_role_ids) })),
        ...arr(state.configuration.organization_connection_types).map((entry) => ({ id:text(entry.id), name:text(entry.name, entry.label, entry.id), description:text(entry.description), status:text(entry.status, 'active'), kind:'organization_connection', member_role_ids:[] }))
      ];
      state.staffing = new Map(arr(value(staffingResult)).map((row) => [String(row.id || row.assignee_id), row]));
      state.scopes = scopesResult.status === 'fulfilled' ? records(scopesResult.value, 'templates', 'scope_templates').map((entry) => ({ ...obj(entry?.definition), ...entry })).filter((entry) => text(entry.id)).map((entry) => ({ id:text(entry.id), name:text(entry.name, entry.title, entry.label, entry.id) })) : [];
      state.loaded = true;
      state.orgId = org;
      return state;
    })().finally(() => { loading = null; });
    const result = await loading;
    emit({ type:'load' });
    return result;
  }

  /* ---- reading ---- */
  const user = (id) => state.users.find((entry) => entry.id === String(id)) || null;
  const role = (id) => state.roles.find((entry) => entry.id === String(id)) || null;
  const activeRoles = () => state.roles.filter((entry) => text(entry.status, 'active') !== 'archived' && !entry.archived_at)
    .sort((left, right) => text(left.name, left.id).localeCompare(text(right.name, right.id)));
  const roleApplications = (entry = {}) => {
    const list = ids(entry.application_ids).map(canonicalApplication).filter(Boolean);
    const fallback = canonicalApplication(text(entry.application_id, entry.application, 'management'));
    return [...new Set(list.length ? list : [fallback])];
  };
  function userRoleIds(entry = {}){
    const stored = entry.profile || entry;
    const assigned = ids(stored.access_profile?.access_role_ids || stored.access_role_ids || stored.access_roles || stored.workforce_profile?.access_role_ids).filter((id) => role(id));
    if (assigned.length) return assigned;
    const access = obj(stored.access_profile?.application_access || stored.application_access);
    return ['management', 'field'].map((application) => text(obj(access[application]).role_id)).filter((id) => role(id));
  }
  const userRoles = (entry) => userRoleIds(entry).map(role).filter(Boolean);
  const userPermissionOverrides = (entry = {}) => ({ ...obj((entry.profile || entry).permission_overrides || entry.permission_overrides) });
  const userAppOverrides = (entry = {}) => {
    const raw = obj((entry.profile || entry).app_access_overrides || entry.app_access_overrides);
    const result = {};
    Object.entries(raw).forEach(([appId, value]) => {
      const source = obj(value);
      const word = text(typeof value === 'string' ? value : source.state, source.visibility, source.override).toLowerCase();
      if (value === true || ['show', 'shown', 'visible', 'allow', 'allowed'].includes(word) || source.enabled === true || source.visible === true) result[appId] = 'show';
      else if (value === false || ['hide', 'hidden', 'deny', 'denied'].includes(word) || source.enabled === false || source.visible === false) result[appId] = 'hide';
    });
    return result;
  };
  function userDepartments(entry = {}){
    const membership = state.memberships.get(String(entry.id));
    if (!membership) return [];
    return arr(membership.department_ids).map((id) => {
      const department = state.departments.find((item) => item.id === id);
      if (!department) return null;
      const sources = arr(membership.sources).filter((source) => source.department_id === id);
      return { id, label:text(department.label, department.name, id), color:text(department.color, '#98a2b3'), direct:sources.some((source) => source.kind === 'direct'), sources };
    }).filter(Boolean);
  }
  const userDirectDepartmentIds = (entry = {}) => userDepartments(entry).filter((department) => department.direct).map((department) => department.id);
  const groupMemberIds = (group = {}) => {
    const members = arr(group.member_assignments || group.members);
    return members.length ? members.map((member) => text(member?.user_id, member?.userId, member?.id)).filter(Boolean) : ids(group.member_user_ids || group.user_ids);
  };
  const userGroups = (entry = {}) => state.groups.filter((group) => groupMemberIds(group).includes(String(entry.id)));
  const isSuspended = (entry = {}) => entry.disabled === true || text(entry.status).toLowerCase() === 'disabled';
  const neverSignedIn = (entry = {}) => !isSuspended(entry) && (entry.never_signed_in === true || (!entry.last_login_at && ['invited', 'pending'].includes(text(entry.status).toLowerCase())));
  const isMe = (entry = {}) => {
    const myId = text(window.__APP?.userId);
    const myEmail = text(window.__APP?.userEmail).toLowerCase();
    return (!!myId && entry.id === myId) || (!!myEmail && text(entry.email).toLowerCase() === myEmail);
  };
  const isOwner = (entry = {}) => text(entry.org_permissions?.level, entry.org_permission_level, entry.role).toLowerCase() === 'super_admin';
  const roleMembers = (roleId) => state.users.filter((entry) => userRoleIds(entry).includes(String(roleId)));

  const sentence = (value) => { const words = String(value || '').replace(/[_-]+/g, ' ').trim(); return words ? words.charAt(0).toUpperCase() + words.slice(1) : ''; };
  const PERMISSION_GROUP_ICONS = { general:'fa-building', crew:'fa-helmet-safety', sales:'fa-handshake', projects:'fa-briefcase', payroll:'fa-money-check-dollar', schedule:'fa-calendar-days' };
  function permissionKeys(){
    const keys = new Set(state.permissionKeys);
    state.roles.forEach((entry) => Object.keys(obj(entry.permissions || entry.permission_defaults)).forEach((key) => keys.add(key)));
    state.apps.forEach((app) => {
      arr(app.required_permissions).forEach((key) => { if (text(key)) keys.add(text(key)); });
      Object.values(obj(app.parameter_permissions)).forEach((key) => { if (text(key)) keys.add(text(key)); });
    });
    state.users.forEach((entry) => Object.keys(userPermissionOverrides(entry)).forEach((key) => keys.add(key)));
    return [...keys].filter(Boolean).sort();
  }
  function permissionGroups(){
    const groups = new Map();
    const usedBy = (key) => state.apps.filter((app) => arr(app.required_permissions).includes(key) || Object.values(obj(app.parameter_permissions)).includes(key)).map((app) => app.title);
    permissionKeys().forEach((key) => {
      const parts = key.split('.');
      const groupId = key === '*' || parts.length === 1 ? 'general' : parts[0];
      const label = key === '*' ? t('permission_everything', 'Everything') : sentence(parts.length === 1 ? key : parts.slice(1).join(' '));
      const apps = usedBy(key);
      const description = key === '*' ? t('permission_everything_tip', 'Every current and future permission unless one is denied')
        : apps.length ? t('permission_used_by', 'Used by {apps}', { apps:[...new Set(apps)].join(', ') }) : '';
      if (!groups.has(groupId)) groups.set(groupId, {
        id:groupId,
        label:groupId === 'general' ? t('permission_group_general', 'Company') : term(`people.permission_group.${groupId}`, groupId === 'crew' ? t('permission_group_field', 'Field') : sentence(groupId)),
        icon:PERMISSION_GROUP_ICONS[groupId] || 'fa-key',
        permissions:[]
      });
      groups.get(groupId).permissions.push({ key, label, description });
    });
    const list = [...groups.values()];
    list.forEach((group) => group.permissions.sort((left, right) => (left.key === '*' ? -1 : right.key === '*' ? 1 : left.label.localeCompare(right.label))));
    return list.sort((left, right) => (left.id === 'general' ? -1 : right.id === 'general' ? 1 : left.label.localeCompare(right.label)));
  }
  function inheritedPermission(roleIds){
    const roles = ids(roleIds).map(role).filter(Boolean);
    return (key) => {
      const granting = [];
      let denied = false;
      roles.forEach((entry) => {
        const permissions = obj(entry.permissions || entry.permission_defaults);
        if (permissions[key] === false) denied = true;
        else if (permissions[key] === true || (key !== '*' && permissions['*'] === true)) granting.push(text(entry.name, entry.id));
      });
      return { allowed:!denied && granting.length > 0, sources:denied ? [] : granting };
    };
  }
  const appDefaultEnabled = (value, fallback) => {
    if (value == null) return fallback === true;
    if (typeof value === 'boolean') return value;
    const source = obj(value);
    if (source.enabled === false || source.allowed === false || source.visible === false) return false;
    if (source.enabled === true || source.allowed === true || source.visible === true) return true;
    return fallback === true;
  };
  function inheritedApp(roleIds){
    const roles = ids(roleIds).map(role).filter(Boolean);
    return (appId) => {
      const app = state.apps.find((entry) => entry.id === appId);
      if (!app) return { shown:false, sources:[] };
      const sources = roles.filter((entry) => roleApplications(entry).includes(app.application_id)
        && appDefaultEnabled(obj(entry.app_defaults || entry.apps)[appId], app.default_enabled === true || app.defaultEnabled === true)).map((entry) => text(entry.name, entry.id));
      return { shown:sources.length > 0, sources };
    };
  }
  const roleAppValue = (entry = {}) => {
    const result = {};
    Object.entries(obj(entry.app_defaults || entry.apps)).forEach(([appId, value]) => {
      const app = state.apps.find((item) => item.id === appId);
      const enabled = appDefaultEnabled(value, app?.default_enabled === true);
      if (app && enabled !== (app.default_enabled === true)) result[appId] = enabled ? 'show' : 'hide';
    });
    return result;
  };
  const catalogDefaultApp = () => (appId) => {
    const app = state.apps.find((entry) => entry.id === appId);
    return { shown:app?.default_enabled === true || app?.defaultEnabled === true, sources:[] };
  };
  function applicationAccessFor(roleIds, current = {}){
    const result = {};
    ['management', 'field'].forEach((application) => {
      const roles = ids(roleIds).map(role).filter((entry) => entry && roleApplications(entry).includes(application));
      const primary = [...roles].sort((left, right) => Number(obj(left.metadata).level || 0) - Number(obj(right.metadata).level || 0)).at(-1);
      result[application] = { ...obj(current[application]), enabled:roles.length > 0, role_id:text(primary?.id), permissions:obj(obj(current[application]).permissions) };
    });
    return result;
  }

  const dateText = (value) => {
    const date = value ? new Date(value) : null;
    if (!date || Number.isNaN(date.getTime())) return '';
    try { return date.toLocaleDateString(undefined, { year:'numeric', month:'short', day:'numeric' }); } catch (_) { return date.toISOString().slice(0, 10); }
  };
  /* The one description of a person, for the modal column and the hover card. `draft` shows unsaved edits. */
  function userSummary(entry = {}, draft = {}){
    const roleIds = draft.roleIds || userRoleIds(entry);
    let departments = userDepartments(entry);
    if (draft.departmentIds) {
      const inherited = departments.filter((department) => department.sources.some((source) => source.kind !== 'direct')).map((department) => ({ ...department, direct:draft.departmentIds.includes(department.id) }));
      const direct = draft.departmentIds.filter((id) => !inherited.some((department) => department.id === id)).map((id) => state.departments.find((department) => department.id === id)).filter(Boolean)
        .map((department) => ({ id:department.id, label:text(department.label, department.name, department.id), color:text(department.color, '#98a2b3'), direct:true, sources:[] }));
      departments = [...direct, ...inherited];
    }
    const groups = userGroups(entry);
    const pills = [];
    if (isMe(entry)) pills.push({ label:t('you', 'You'), tone:'role' });
    if (isSuspended(entry)) pills.push({ label:t('suspended', 'Suspended'), tone:'danger', icon:kit.ICONS.suspend });
    else if (neverSignedIn(entry)) pills.push({ label:t('never_signed_in', 'Never signed in'), tone:'warn', tooltip:t('never_signed_in_tip', 'Invited, has not signed in yet') });
    return {
      kind:'organization_user', id:entry.id, name:text(draft.name, entry.name, entry.email, entry.id), secondary:text(draft.email, entry.email),
      photoUrl:assetUrl(entry.profile_photo_url || entry.profile_photo), online:entry.id, pills,
      facts:[
        { icon:kit.ICONS.email, label:t('email', 'Email'), value:'', card:false },
        { icon:kit.ICONS.phone, label:t('phone', 'Phone'), value:text(entry.phone, entry.phone_number, entry.mobile) },
        { icon:kit.ICONS.clock, label:t('last_sign_in', 'Last sign-in'), value:dateText(entry.last_login_at), cardLabel:true },
        { icon:kit.ICONS.invite, label:t('invited', 'Invited'), value:neverSignedIn(entry) ? dateText(entry.invited_at || entry.created_at) : '', cardLabel:true },
        { icon:'fa-calendar-plus', label:t('added', 'Added'), value:neverSignedIn(entry) ? '' : dateText(entry.created_at), card:false }
      ],
      sections:[
        { id:'roles', title:t('roles', 'Roles'), icon:kit.ICONS.role, chips:roleIds.map(role).filter(Boolean).map((item) => ({ label:text(item.name, item.id), tone:'role', tooltip:item.description })), empty:t('no_roles', 'No roles') },
        { id:'departments', title:state.groupLabels.departmentPlural || t('departments', 'Departments'), icon:kit.ICONS.department,
          chips:departments.map((department) => ({ label:department.label, color:department.color, tooltip:department.direct ? '' : t('department_inherited', 'Through a role or a group') })), empty:t('no_departments', 'None') },
        { id:'tags', title:t('tags', 'Tags'), icon:'fa-tag', chips:ids(draft.tagIds || userTagIds(entry)).map((id) => state.tags.find((tag) => String(tag.id) === id)).filter(Boolean).map((tag) => ({ label:text(tag.name, tag.id), tone:'muted' })), empty:t('none', 'None'), optional:true },
        { id:'scoped', title:t('scoped_roles', 'Roles here only'), icon:'fa-location-crosshairs', tooltip:t('scoped_roles_user_tip', 'Roles that apply only inside one department'), chips:(draft.scopedAssignments || userScopedAssignments(entry)).map((assignment) => ({ label:`${text(role(assignment.role_id)?.name, assignment.role_id)} \u00b7 ${text((assignment.scope.kind === 'division' ? state.divisions : state.departments).find((unit) => unit.id === assignment.scope.id)?.label, assignment.scope.id)}`, tone:'role' })), empty:t('none', 'None'), optional:true },
        { id:'groups', title:state.groupLabels.plural || t('groups', 'Groups'), icon:kit.ICONS.group, tooltip:t('groups_tip', 'Membership is edited from the group'),
          chips:groups.map((group) => ({ label:text(group.name, group.id), tone:'group' })), empty:t('no_groups', 'None') }
      ]
    };
  }

  /* ---- writing ---- */
  const replaceUser = (next) => { const index = state.users.findIndex((entry) => entry.id === next.id); if (index >= 0) state.users[index] = { ...state.users[index], ...next }; else state.users.push(next); };
  async function reload(change){ await load({ refresh:true }).catch(() => {}); emit(change); return state; }

  async function invite({ name, email, roleIds = [], photo = null }){
    const platform = api();
    const applicationAccess = applicationAccessFor(roleIds);
    const result = await platform.users.create(orgId(), {
      email:String(email || '').trim().toLowerCase(), name:String(name || '').trim(), role:'viewer', status:'invited', permissions:{}, account_type:'customer',
      application_access:applicationAccess, access_role_ids:ids(roleIds), permission_overrides:{}, app_access_overrides:{}
    });
    const created = normalizeUser(result?.document || {});
    let profileError = '';
    if (created.id && platform.workforce?.saveUserProfile) {
      try { await platform.workforce.saveUserProfile(orgId(), created.id, { application_access:applicationAccess, access_role_ids:ids(roleIds), permission_overrides:{}, app_access_overrides:{} }); }
      catch (error) { profileError = error?.message || 'profile'; }
    }
    let photoError = '';
    if (created.id && photo) { try { await uploadPhoto(created.id, photo, { silent:true }); } catch (error) { photoError = error?.message || 'photo'; } }
    await reload({ type:'invite', id:created.id });
    return { user:user(created.id) || created, emailed:!!(result?.emailed || result?.email_sent), activateUrl:result?.activate_url || result?.invite?.activate_url || '', inviteError:result?.invite?.error || '', profileError, photoError };
  }
  async function resendInvite(id){
    const result = await api().users.resendInvite(orgId(), id);
    const ok = !!(result?.ok || result?.success || result?.emailed || result?.email_sent);
    if (!ok && !result?.activate_url) throw new Error(result?.error || result?.message || t('invite_failed', 'The invitation could not be sent.'));
    return { emailed:ok, activateUrl:result?.activate_url || '' };
  }
  async function setSuspended(id, suspended){
    const result = await api().users.setDisabled(orgId(), id, !!suspended);
    const next = normalizeUser(result?.document || { id, status:suspended ? 'disabled' : 'active', disabled:!!suspended });
    replaceUser({ ...next, id:String(id), disabled:!!suspended, status:suspended ? 'disabled' : text(next.status === 'disabled' ? 'active' : next.status, 'active') });
    emit({ type:'user', id:String(id) });
  }
  async function removeUser(id){
    await api().users.remove(orgId(), id);
    state.users = state.users.filter((entry) => entry.id !== String(id));
    emit({ type:'remove', id:String(id) });
  }
  /* Scoped entries People does not edit (permission-only ones) are written back untouched. */
  const keptScoped = (entry) => arr((entry.profile || entry).scoped_access_assignments).filter((assignment) => assignment && !assignment.role_id);
  async function saveUser(id, patch = {}){
    const platform = api();
    const current = user(id);
    if (!current) throw new Error(t('user_missing', 'This user no longer exists.'));
    if (can.users && (patch.name !== undefined || patch.email !== undefined)) {
      const email = String(patch.email ?? current.email ?? '').trim().toLowerCase();
      const name = String(patch.name ?? current.name ?? '').trim();
      if (!email || !email.includes('@')) throw new Error(t('email_invalid', 'Enter a valid email.'));
      if (isOwner(current) && email !== text(current.email).toLowerCase()) throw new Error(t('owner_email_locked', "An owner's email cannot be changed."));
      if (email !== text(current.email).toLowerCase() || name !== text(current.name)) await platform.users.patch(orgId(), id, { email, name }, { source:'org_users_update' });
    }
    /* Organizations that have not moved to roles keep an admin level and the seven original flags on the user. */
    if (can.permissions && patch.legacy !== undefined) {
      if (isMe(current) || isOwner(current)) throw new Error(t('legacy_locked', 'This level cannot be changed here.'));
      await platform.users.setPermissions(orgId(), id, patch.legacy.level || 'viewer', obj(patch.legacy.items));
    }
    if (can.access && (patch.tagIds !== undefined || patch.scopedAssignments !== undefined) && patch.roleIds === undefined && patch.permissionOverrides === undefined && patch.appOverrides === undefined) {
      await platform.workforce.saveUserProfile(orgId(), id, {
        ...(patch.tagIds !== undefined ? { assignment_tag_ids:ids(patch.tagIds) } : {}),
        ...(patch.scopedAssignments !== undefined ? { scoped_access_assignments:[...arr(patch.scopedAssignments), ...keptScoped(current)] } : {})
      });
    }
    if (can.access && (patch.roleIds !== undefined || patch.permissionOverrides !== undefined || patch.appOverrides !== undefined)) {
      const roleIds = patch.roleIds !== undefined ? ids(patch.roleIds) : userRoleIds(current);
      if (isMe(current) && !roleIds.some((roleId) => roleApplications(role(roleId)).includes('management'))) throw new Error(t('keep_own_access', 'Keep a role that lets you into Settings on your own account.'));
      const stored = current.profile || current;
      await platform.workforce.saveUserProfile(orgId(), id, {
        application_access:applicationAccessFor(roleIds, obj(stored.application_access)),
        access_role_ids:roleIds,
        ...(patch.permissionOverrides !== undefined ? { permission_overrides:obj(patch.permissionOverrides) } : {}),
        ...(patch.appOverrides !== undefined ? { app_access_overrides:obj(patch.appOverrides) } : {}),
        ...(patch.tagIds !== undefined ? { assignment_tag_ids:ids(patch.tagIds) } : {}),
        ...(patch.scopedAssignments !== undefined ? { scoped_access_assignments:[...arr(patch.scopedAssignments), ...keptScoped(current)] } : {})
      });
    }
    await reload({ type:'user', id:String(id) });
    return user(id);
  }
  async function uploadPhoto(id, file, options = {}){
    const endpoint = window.Portal?.cfg?.serverEndpoint;
    if (!endpoint) throw new Error(t('photo_unavailable', 'Photos cannot be changed here.'));
    const form = new FormData();
    form.append('action', 'org_users_upload_avatar_my');
    form.append('actor_email', window.__APP?.userEmail || '');
    form.append('actor_name', window.__APP?.userName || '');
    form.append('actor_org_id', window.__APP?.userOrgId || '');
    form.append('user_id', id || '');
    form.append('avatar', file);
    const response = await fetch(endpoint, { method:'POST', body:form, credentials:'include' });
    const result = await response.json().catch(() => null);
    if (!result?.success) throw new Error(result?.error || t('photo_failed', 'The photo could not be uploaded.'));
    const url = result.avatar_url || result.user?.profile_photo_url || '';
    if (url) replaceUser({ id:String(id), profile_photo_url:url });
    if (!options.silent) emit({ type:'user', id:String(id) });
    return url;
  }
  async function saveUserDepartments(id, departmentIds){
    const current = state.departmentState || {};
    const next = await api().workforce.saveDepartmentAssignment(orgId(), { kind:'user', id, department_ids:ids(departmentIds), revision:current.revision, legacy_token:current.legacy_token });
    const departments = obj(next?.catalog || next);
    if (arr(departments.departments).length || departments.revision != null) {
      state.departmentState = { ...current, ...departments };
      state.departments = arr(state.departmentState.departments).filter((department) => department.status !== 'archived');
      if (Array.isArray(departments.effective_memberships)) state.memberships = new Map(departments.effective_memberships.map((entry) => [String(entry.id), entry]));
    }
    if (!Array.isArray(departments.effective_memberships)) await load({ refresh:true }).catch(() => {});
    window.dispatchEvent(new CustomEvent('fm:departments:updated'));
    emit({ type:'user', id:String(id) });
  }
  /* A role's permissions are stored as said: true grants, false denies (a denial also carves out of 'Everything'). */
  const rolePermissionsPayload = (value) => Object.fromEntries(Object.entries(obj(value)).filter(([, allowed]) => typeof allowed === 'boolean'));
  async function saveRole(id, patch = {}){
    const current = role(id);
    if (!current) throw new Error(t('role_missing', 'This role no longer exists.'));
    const payload = { expected_revision:Number(current.revision || 0) };
    if (patch.name !== undefined) { payload.name = String(patch.name || '').trim(); if (!payload.name) throw new Error(t('name_required', 'Enter a name.')); }
    if (patch.description !== undefined) payload.description = String(patch.description || '').trim();
    if (patch.applicationIds !== undefined) { payload.application_ids = ids(patch.applicationIds); if (!payload.application_ids.length) throw new Error(t('role_needs_app', 'A role needs at least one place it applies.')); }
    if (patch.permissions !== undefined) payload.permissions = rolePermissionsPayload(patch.permissions);
    if (patch.appDefaults !== undefined) {
      const existing = obj(current.app_defaults || current.apps);
      const next = { ...existing };
      state.apps.forEach((app) => {
        const choice = patch.appDefaults[app.id];
        const params = obj(obj(existing[app.id]).params);
        const layout = obj(obj(existing[app.id]).layout);
        if (!choice) { if (Object.keys(params).length || Object.keys(layout).length) next[app.id] = { enabled:app.default_enabled === true, params, layout }; else delete next[app.id]; }
        else next[app.id] = { enabled:choice === 'show', params, layout };
      });
      payload.app_defaults = next;
    }
    await api().workforce.updateAccessRole(orgId(), id, payload);
    await reload({ type:'role', id:String(id) });
    return role(id);
  }
  async function createRole({ name, applicationIds = ['management'] } = {}){
    const clean = String(name || '').trim();
    if (!clean) throw new Error(t('name_required', 'Enter a name.'));
    const result = await api().workforce.createAccessRole(orgId(), { name:clean, description:'', application_ids:ids(applicationIds), permissions:{}, app_defaults:{} });
    const createdId = text(result?.role?.id, result?.id, result?.access_role?.id);
    await reload({ type:'role', id:createdId });
    return role(createdId) || activeRoles().find((entry) => text(entry.name) === clean) || null;
  }
  async function archiveRole(id){
    const current = role(id);
    await api().workforce.archiveAccessRole(orgId(), id, Number(current?.revision || 0));
    await reload({ type:'role', id:String(id) });
  }
  async function setRoleMembership(userId, roleId, member){
    const current = user(userId);
    if (!current) return;
    const roleIds = userRoleIds(current).filter((id) => id !== String(roleId));
    if (member) roleIds.push(String(roleId));
    await saveUser(userId, { roleIds });
  }

  const userTagIds = (entry = {}) => ids((entry.profile || entry).assignment_tag_ids || entry.assignment_tag_ids || entry.tag_ids);
  const userScopedAssignments = (entry = {}) => arr((entry.profile || entry).scoped_access_assignments || entry.scoped_access_assignments).filter((assignment) => assignment && assignment.scope && assignment.role_id).map((assignment) => ({ role_id:String(assignment.role_id), scope:{ kind:String(assignment.scope.kind), id:String(assignment.scope.id) } }));
  /* Roles that may be scoped to a department: nothing that administers the whole organization. */
  const SCOPE_FORBIDDEN = new Set(['*', 'manage_billing', 'manage_company_settings', 'manage_company_users', 'manage_company_user_permissions', 'manage_report_settings', 'manage_notification_defaults', 'manage_integrations', 'manage_security', 'manage_roles', 'manage_organization', 'manage_capabilities']);
  const scopableRoles = () => activeRoles().filter((entry) => !Object.entries(obj(entry.permissions)).some(([key, allowed]) => allowed && SCOPE_FORBIDDEN.has(key)));
  /* Legacy access: an admin level and seven flags, for organizations without roles. */
  const LEGACY_FLAGS = ['order_reports', 'view_reports', 'manage_billing', 'manage_company_settings', 'manage_report_settings', 'manage_company_users', 'manage_company_user_permissions'];
  const LEGACY_LEVELS = { viewer:[0, 1, 0, 0, 0, 0, 0], manager:[1, 1, 0, 0, 0, 0, 0], admin:[1, 1, 1, 1, 1, 1, 0], super_admin:[1, 1, 1, 1, 1, 1, 1] };
  const legacyLevelItems = (level) => Object.fromEntries(LEGACY_FLAGS.map((key, index) => [key, !!(LEGACY_LEVELS[level] || LEGACY_LEVELS.viewer)[index]]));
  const legacyMode = () => { try { return window.PlatformAPI?.appFlags?.has?.('platform', 'expanded_access') !== true; } catch (_) { return false; } };
  function userLegacy(entry = {}){
    const level = text(entry.org_permissions?.level, entry.org_permission_level, entry.role, 'viewer').toLowerCase();
    const items = level === 'custom' ? Object.fromEntries(LEGACY_FLAGS.map((key) => [key, obj(entry.org_permissions?.items)[key] === true])) : legacyLevelItems(level);
    return { level:LEGACY_LEVELS[level] || level === 'custom' ? level : 'viewer', items };
  }
  const newKey = (prefix) => `${prefix}-${window.crypto?.randomUUID?.() || `${Date.now()}-${Math.random().toString(36).slice(2)}`}`;
  /* Published actions: the workforce domain's own writers, with a fresh idempotency key per intent. */
  async function invoke(action, input){
    const publication = api()?.publication;
    if (!publication?.invoke) throw new Error(t('api_unavailable', 'People is unavailable right now.'));
    const result = await publication.invoke(orgId(), action, { scope:'organization', organizationId:orgId() }, input, { idempotencyKey:newKey(action) });
    return result?.value ?? result?.result ?? result;
  }

  People.data = {
    internal:{ emit, reload, api, arr, obj, text, ids, records, invoke, newKey },
    userTagIds, userScopedAssignments, scopableRoles, legacyMode, userLegacy, legacyLevelItems, LEGACY_FLAGS, LEGACY_LEVELS:Object.keys(LEGACY_LEVELS), invoke,
    state, load, subscribe(listener){ listeners.add(listener); return () => listeners.delete(listener); }, can, orgId, branchId, assetUrl,
    user, role, activeRoles, roleApplications, userRoleIds, userRoles, userPermissionOverrides, userAppOverrides, userDepartments, userDirectDepartmentIds, userGroups,
    neverSignedIn, isSuspended, isMe, isOwner, roleMembers, permissionGroups, inheritedPermission, inheritedApp, roleAppValue, catalogDefaultApp, userSummary,
    invite, resendInvite, setSuspended, removeUser, saveUser, uploadPhoto, saveUserDepartments, saveRole, createRole, archiveRole, setRoleMembership
  };
})();
