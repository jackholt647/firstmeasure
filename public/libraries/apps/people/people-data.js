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
 *   data.roleMembers(roleId)
 *   data.permissionGroups()                groups for permissionsPanel
 *   data.inheritedPermission(roleIds)      (key) => { allowed, sources }
 *   data.inheritedApp(roleIds, user)       (appId) => { visible: { device: shown }, options, sources }
 *   data.userSummary(user, draft)          the kit.summary model for a person
 *
 * Writing (each resolves after the store is current again)
 *   data.invite({ name, email, roleIds, photo })
 *   data.resendInvite(id)  data.setSuspended(id, bool)  data.removeUser(id, reason) (archives)  data.restoreUser(id)
 *   data.saveUser(id, { name, email, roleIds, permissionOverrides, appOverrides })
 *   data.uploadPhoto(id, file)  data.saveUserDepartments(id, departmentIds)
 *   data.saveRole(id, { name, description, permissions, appDefaults })
 *   data.createRole({ name })  data.archiveRole(id)
 *
 * Branches (docs/architecture/branches.md): the organization-branches.structure read, as this viewer may see it
 *   data.structure()  data.multipleBranches()  data.branches()  data.regions()  data.branch(id)  data.branchName(id)  data.region(id)
 *   data.branchIdsOf(kind, record)   kind: 'user' | 'group' | 'company' | 'department'; [] for a company means every branch
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


  const state = {
    loaded:false, orgId:'', users:[], roles:[], apps:[], deviceTypes:[], permissionKeys:[],
    departments:[], memberships:new Map(), departmentState:null, groups:[], groupLabels:{}, errors:{},
    configuration:{}, tags:[], connections:[], directory:new Map(), types:[], staffing:new Map(), scopes:[], archivedUsers:[], structure:null
  };
  const listeners = new Set();
  let loading = null;
  const emit = (change = {}) => listeners.forEach((listener) => { try { listener(state, change); } catch (_) {} });

  /*
   * What this organization and this user can do. App flags and capabilities reach the page through
   * PlatformAPI.appFlags (the same source Settings' appFlag() reads); permissions through Portal.util.hasPerm.
   * The server is the authority: every /v1/workforce, /v1/connections, /v1/publication and /v1/payroll route
   * requires the platform.expanded_access capability (platform/rollout_routes.ts, checked in requirePlatformAuth),
   * then its own permission. The users collection, invitations and activity are core and need only a permission.
   */
  const flag = (group, name) => { try { return window.PlatformAPI?.appFlags?.has?.(group, name) === true; } catch (_) { return false; } };
  const CAPABILITIES = {
    people_access:() => flag('platform', 'people_access'),
    expanded_access:() => flag('platform', 'expanded_access'),
    legacy_access:() => !flag('platform', 'expanded_access'),
    groups_app:() => flag('apps', 'crew'),
    payroll_app:() => flag('apps', 'payroll'),
    custom_fields:() => flag('platform', 'custom_fields'),
    /* Pay sheets (pay-sheets-editor.js): the Materials switch the /v1/materials pay sheet routes check, and project access for trying one on a project. */
    materials_app:() => flag('platform', 'materials'),
    manage_projects:() => hasPerm('manage_projects'),
    manage_company_users:() => hasPerm('manage_company_users'),
    manage_company_user_permissions:() => hasPerm('manage_company_user_permissions'),
    manage_company_settings:() => hasPerm('manage_company_settings'),
    manage_payroll:() => hasPerm('manage_payroll'),
    view_projects:() => hasPerm('view_projects'),
    /* payroll.contractor.worker.update asks for manage_company_users or manage_company_settings. */
    payroll_and_users:() => hasPerm('manage_payroll') && hasPerm('manage_company_users'),
    /* Collaboration: inviting an outside company to link its own organization (collaboration/api.ts partner-invitations). */
    collaboration:() => flag('platform', 'collaboration'),
    manage_external_connections:() => hasPerm('manage_external_connections'),
    send_email:() => ['manage_projects', 'manage_sales', 'send_communications', 'manage_company_settings'].some(hasPerm),
    /* Branches: the feature, then what the structure read says this organization has and this viewer may do. */
    branches_feature:() => flag('platform', 'multiple_branches') && state.structure?.feature_enabled !== false,
    multiple_branches:() => flag('platform', 'multiple_branches') && state.structure?.feature_enabled === true && state.structure?.multiple === true,
    branch_admin:() => { const s = state.structure; return !!s && (s.access?.can_add_branch === true || arr(s.access?.can_rename_branch_ids).length > 0 || arr(s.branches).some((entry) => entry.can_manage === true)); },
    can_add_branch:() => state.structure?.access?.can_add_branch === true,
    can_archive_branch:() => state.structure?.access?.can_archive_branch === true,
    can_manage_regions:() => state.structure?.access?.can_manage_regions === true,
    manage_all_branches:() => hasPerm('manage_all_branches'),
    view_region_branches:() => hasPerm('view_region_branches') || hasPerm('manage_region_branches'),
    view_all_branches:() => hasPerm('view_all_branches') || hasPerm('manage_all_branches')
  };
  const ADMIN = ['manage_company_users', 'manage_company_user_permissions', 'manage_company_settings'];
  const WORKFORCE = ['expanded_access'];
  const GROUPS = ['people_access', 'expanded_access', 'groups_app'];
  const DEPARTMENTS = ['people_access', 'expanded_access'];
  const BRANCHES = ['expanded_access', 'branches_feature', 'manage_company_settings'];
  /*
   * Every People action, the capabilities it needs (all of `all`, at least one of `any`) and the server route or
   * published action it calls. An action the page offers must be listed here: listPage and entityModal drop, and
   * record in FirstMatePeople.undeclared, any action or tab whose `needs` is missing or unknown.
   */
  const ACTIONS = Object.freeze({
    'users.view':{ any:ADMIN, server:'GET /v1/platform/organizations/:org/users' },
    'users.open':{ any:ADMIN, server:'GET /v1/platform/organizations/:org/users/:id' },
    'users.invite':{ all:['manage_company_users'], server:'POST /v1/platform/organizations/:org/users' },
    'users.photo':{ all:['manage_company_users'], server:'POST portal action org_users_upload_avatar_my' },
    'users.identity':{ all:['manage_company_users'], server:'PATCH /v1/platform/organizations/:org/users/:id' },
    'users.resend_invite':{ all:['manage_company_users'], server:'POST /v1/platform/organizations/:org/users/:id/invite' },
    'users.suspend':{ all:['manage_company_users'], server:'PATCH /v1/platform/organizations/:org/users/:id (status)' },
    'users.archive':{ all:['manage_company_users'], server:'DELETE /v1/platform/organizations/:org/users/:id (archives: kept, cannot sign in)' },
    'users.restore':{ all:['expanded_access', 'manage_company_users'], server:'workforce.users.restore' },
    'users.activity':{ any:['manage_company_users', 'manage_company_settings'], server:'GET /v1/platform/organizations/:org/activity' },
    'users.legacy_permissions':{ all:['legacy_access'], any:ADMIN, server:'PATCH /v1/platform/organizations/:org/users/:id (org_permissions)' },
    'users.roles':{ all:WORKFORCE, any:ADMIN, server:'PATCH /v1/workforce/organizations/:org/users/:id/profile' },
    'users.permissions':{ all:WORKFORCE, any:ADMIN, server:'PATCH /v1/workforce/organizations/:org/users/:id/profile (permission_overrides)' },
    'users.apps':{ all:WORKFORCE, any:ADMIN, server:'PATCH /v1/workforce/organizations/:org/users/:id/profile (app_access_overrides)' },
    'users.tags':{ all:WORKFORCE, any:ADMIN, server:'PATCH /v1/workforce/organizations/:org/users/:id/profile (assignment_tag_ids)' },
    'users.scoped':{ all:[...WORKFORCE, 'manage_company_user_permissions'], server:'PATCH /v1/workforce/organizations/:org/users/:id/profile (scoped_access_assignments)' },
    'users.departments':{ all:WORKFORCE, any:['manage_company_settings', 'manage_company_users'], server:'PATCH /v1/workforce/organizations/:org/departments/assignments' },
    'roles.view':{ all:WORKFORCE, any:ADMIN, server:'GET /v1/workforce/organizations/:org/access/catalog' },
    'roles.edit':{ all:WORKFORCE, any:ADMIN, server:'POST|PATCH|DELETE /v1/workforce/organizations/:org/access/roles' },
    'compensation':{ all:['expanded_access', 'payroll_app'], any:['manage_payroll', 'manage_company_settings'], server:'/v1/payroll pay setups and defaults (PayrollAPI.pay)' },
    /* Pay sheets: compensation records, read and written with company settings access (docs/architecture/pay-sheets.md). */
    'pay_sheets':{ all:['materials_app', 'manage_company_settings'], server:'GET /v1/materials/organizations/:org/pay-sheets, .../pay-sheets/kinds-of-work, .../pay-sheets/overview' },
    'pay_sheets.edit':{ all:['materials_app', 'manage_company_settings'], server:'POST|PATCH|DELETE /v1/materials/organizations/:org/pay-sheets (pay-sheets.sheet.save, pay-sheets.sheet.archive)' },
    'pay_sheets.try':{ all:['materials_app', 'manage_company_settings', 'manage_projects'], server:'POST /v1/materials/organizations/:org/projects/:projectId/pay-sheets/try' },
    /* How a person is paid: employee or independent contractor. Seen and changed with Compensation. */
    'users.classification_view':{ all:['expanded_access', 'payroll_app'], any:['manage_payroll', 'manage_company_settings'], server:'GET /v1/workforce/organizations/:org/users (worker_classification)' },
    'users.classification':{ all:['expanded_access', 'payroll_app'], any:['manage_company_settings', 'payroll_and_users'], server:'payroll.contractor.worker.update (manage_company_users | manage_company_settings)' },
    'fields':{ all:['expanded_access', 'custom_fields'], any:['manage_company_settings', 'manage_company_users'], server:'/v1/publication custom-fields-* and custom-fields.* actions' },
    'home.view':{ all:['people_access'], server:'(reads only what the pages read)' },
    'home.wording':{ all:['people_access', 'expanded_access', 'manage_company_settings'], server:'PUT /v1/workforce/.../configuration, PUT /v1/workforce/.../departments' },
    'groups.view':{ all:GROUPS, any:['view_projects', 'manage_company_settings'], server:'GET /v1/workforce/.../resource-groups' },
    'groups.edit':{ all:[...GROUPS, 'manage_company_settings'], server:'POST|PATCH|DELETE /v1/workforce/.../resource-groups, assignees.type.save, assignees.staffing-requirements.set, PUT configuration (tags)' },
    'groups.type_roles':{ all:[...GROUPS, 'manage_company_user_permissions'], server:'assignees.type.member-roles.set' },
    'groups.invite':{ all:[...GROUPS, 'manage_company_settings', 'manage_company_users'], server:'POST collections/users, PATCH resource-groups' },
    'departments.view':{ all:DEPARTMENTS, any:ADMIN, server:'GET /v1/workforce/organizations/:org/departments' },
    'departments.edit':{ all:[...DEPARTMENTS, 'manage_company_settings'], server:'PUT /v1/workforce/organizations/:org/departments' },
    'departments.members':{ all:DEPARTMENTS, any:['manage_company_settings', 'manage_company_users'], server:'PATCH /v1/workforce/organizations/:org/departments/assignments' },
    'departments.scoped':{ all:[...DEPARTMENTS, 'manage_company_user_permissions'], server:'PATCH /v1/workforce/.../users/:id/profile (scoped_access_assignments)' },
    'companies.view':{ all:GROUPS, any:['view_projects', 'manage_company_settings'], server:'GET /v1/connections/.../organization-connections' },
    'companies.edit':{ all:[...GROUPS, 'manage_company_settings'], server:'POST|PATCH|DELETE /v1/connections/..., assignees.profile.set, assignees.type.save' },
    'companies.terms':{ all:[...GROUPS, 'payroll_app'], any:['manage_payroll', 'manage_company_settings'], server:'payroll.contractor.company.update' },
    'companies.permissions':{ all:[...GROUPS, 'manage_company_user_permissions'], server:'assignee-directory.permission-defaults, assignees.permission-defaults.set' },
    'companies.onboarding':{ all:[...GROUPS, 'manage_company_settings'], server:'connections.onboarding.save, POST /v1/platform/organizations/:org/media (owner company)' },
    'companies.onboarding_requirements':{ all:[...GROUPS, 'manage_company_settings'], server:'assignees.type.save (onboarding_requirements)' },
    'companies.invite':{ all:[...GROUPS, 'collaboration', 'manage_external_connections', 'send_email'], server:'POST /v1/collaboration/organizations/:org/partner-invitations (workforce_connection_id), /invitations/:id/send, /invitations/:id/revoke' },
    /* Branches and regions. The Branches button shows even with one branch; nothing else does until there are several. */
    'branches.view':{ all:[...BRANCHES, 'people_access', 'branch_admin'], server:'organization-branches.structure' },
    'branches.add':{ all:[...BRANCHES, 'manage_all_branches', 'can_add_branch'], server:'organization-branches.branch.add' },
    'branches.rename':{ all:BRANCHES, server:'organization-branches.branch.rename (the branch must be in access.can_rename_branch_ids)' },
    'branches.archive':{ all:[...BRANCHES, 'manage_all_branches', 'can_archive_branch'], server:'organization-branches.branch.archive' },
    'branches.region':{ all:[...BRANCHES, 'manage_all_branches', 'can_manage_regions'], server:'organization-branches.branch.region.set' },
    'regions.edit':{ all:[...BRANCHES, 'manage_all_branches', 'can_manage_regions'], server:'organization-branches.region.save' },
    'branches.filter':{ all:['expanded_access', 'multiple_branches'], server:'users, resource-groups and organization-connections lists with branch_ids=all; filtered on the rows\' branch_ids' },
    'branches.membership_users':{ all:['expanded_access', 'multiple_branches', 'manage_company_users'], server:'organization-branches.membership.set (a person)' },
    'branches.membership':{ all:['expanded_access', 'multiple_branches', 'manage_company_settings'], server:'organization-branches.membership.set (a group or outside company)' },
    'branches.filter_region':{ all:['expanded_access', 'multiple_branches'], any:['view_region_branches', 'view_all_branches'], server:'branch_ids=region' },
    'users.scoped_branch':{ all:[...WORKFORCE, 'multiple_branches', 'manage_company_user_permissions'], server:'PATCH /v1/workforce/.../users/:id/profile (scoped_access_assignments, scope kind branch | region)' },
    'departments.branch':{ all:[...DEPARTMENTS, 'multiple_branches', 'manage_company_settings'], server:'PUT /v1/workforce/organizations/:org/departments (branch_id)' }
  });
  function allows(id){
    const entry = ACTIONS[id];
    if (!entry) { (People.undeclared = People.undeclared || []).push(String(id)); return false; }
    const holds = (key) => CAPABILITIES[key] ? CAPABILITIES[key]() === true : false;
    return (entry.all || []).every(holds) && (!entry.any || entry.any.some(holds));
  }
  /* Drops what the organization or user cannot do; an item that does not say what it needs is dropped and recorded. */
  function gate(list, where = ''){
    return (list || []).filter(Boolean).filter((item) => {
      if (item.needs === undefined) { (People.undeclared = People.undeclared || []).push(`${where}:${item.id}`); return false; }
      return item.needs === null || allows(item.needs);
    });
  }
  const can = {
    get users(){ return hasPerm('manage_company_users'); },
    get permissions(){ return hasPerm('manage_company_user_permissions'); },
    get settings(){ return hasPerm('manage_company_settings'); },
    get access(){ return this.permissions || this.users || this.settings; },
    get payroll(){ return hasPerm('manage_payroll'); },
    get peopleAccess(){ return CAPABILITIES.people_access(); },
    get expanded(){ return CAPABILITIES.expanded_access(); },
    get workforce(){ return allows('users.roles'); },
    get groups(){ return allows('groups.view'); },
    get departments(){ return allows('departments.view'); },
    get companies(){ return allows('companies.view'); },
    get compensation(){ return allows('compensation'); },
    get fields(){ return allows('fields'); },
    get wording(){ return allows('home.wording'); },
    get multipleBranches(){ return CAPABILITIES.multiple_branches(); }
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
      /* The branch structure first: with several branches the lists are asked for every branch the viewer may see. */
      state.structure = null;
      if (CAPABILITIES.expanded_access()) {
        try {
          const result = await platform.publication?.read?.(org, { provider:'organization-branches', export:'structure', target });
          const value = result && (result.status === undefined || result.status === 'ready') ? obj(result.value) : null;
          state.structure = value && Array.isArray(value.branches) ? value : null;
        } catch (_) { state.structure = null; }
      }
      const every = CAPABILITIES.multiple_branches() ? { branchIds:'all' } : {};
      const [usersResult, profilesResult, catalogResult, departmentsResult, groupsResult, configurationResult, connectionsResult, directoryResult, typesResult, staffingResult, scopesResult] = await Promise.allSettled([
        platform.users.list(org),
        can.workforce ? platform.workforce?.users?.(org, branch) : null,
        can.workforce ? platform.workforce?.accessCatalog?.(org) : null,
        allows('departments.view') || allows('users.departments') ? platform.workforce?.departments?.(org) : null,
        can.groups ? platform.workforce?.resourceGroups?.(org, branch, every) : null,
        can.workforce ? platform.workforce?.configuration?.(org, branch) : null,
        can.companies ? platform.connections?.list?.(org, every.branchIds ? every : { branchId:branch }) : null,
        can.groups || can.companies ? published('assignees') : null,
        can.groups || can.companies ? published('types') : null,
        can.groups ? published('staffing-requirements') : null,
        can.groups || can.companies ? platform.scopes?.list?.(org, branch, { include_disabled:true, includeDisabled:true }) : null
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
        // Every app the organization has on, with the devices it exists on and its options (docs/architecture/app-experience.md).
        state.apps = records(catalog, 'apps').map((app) => ({
          ...app, id:text(app.id), title:text(app.title, app.id),
          surface:text(app.surface, 'portal_tab'), devices:arr(app.devices), options:arr(app.options), default_visible:app.default_visible === true
        }));
        state.deviceTypes = arr(obj(catalog.device_types).types).map((type) => ({ id:text(type.id), label:text(type.label, type.id), icon:kit.ICONS[text(type.id)] || text(type.icon, 'fa-display') }));
        state.permissionKeys = ids(catalog.permission_keys);
        state.permissionCatalog = catalog.permission_catalog && typeof catalog.permission_catalog === 'object' ? catalog.permission_catalog : null;
      } else state.errors.access = catalogResult.reason?.message || 'access';
      if (departmentsResult.status === 'fulfilled' && departmentsResult.value) {
        const departments = obj(departmentsResult.value.catalog || departmentsResult.value);
        state.departmentState = departments;
        state.departments = arr(departments.departments).filter((department) => department.status !== 'archived');
        state.memberships = new Map(arr(departments.effective_memberships).map((entry) => [String(entry.id), entry]));
      } else { state.departments = []; state.memberships = new Map(); state.departmentState = null; }
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

  /* ---- how a person is paid ---- */
  const classificationOf = (entry = {}) => text(entry.profile?.worker_classification, entry.worker_classification, 'employee') === 'independent_contractor' ? 'independent_contractor' : 'employee';
  const paymentTermsOf = (entry = {}) => { const terms = obj(entry.profile?.payment_terms || entry.payment_terms); return { basis:terms.basis === 'net_days' ? 'net_days' : 'payroll_schedule', net_days:terms.basis === 'net_days' ? Math.max(0, Math.min(365, Math.floor(Number(terms.net_days || 0)))) : 0 }; };
  /* The icon beside a contractor's name, for viewers who may see how people are paid. Employees get none. */
  const workerMarks = (entry) => classificationOf(entry) === 'independent_contractor' && allows('users.classification_view') ? [{ id:'contractor', icon:'fa-file-contract', label:t('independent_contractor', 'Independent contractor') }] : [];
  /* payroll.contractor.worker.update: the classification and the payment terms together (both are required). */
  async function saveClassification(id, classification, terms){
    const current = user(id);
    if (!current) throw new Error(t('user_missing', 'This user no longer exists.'));
    const next = classification === 'independent_contractor' ? 'independent_contractor' : 'employee';
    const payment = terms ? { basis:terms.basis === 'net_days' ? 'net_days' : 'payroll_schedule', net_days:terms.basis === 'net_days' ? Math.max(0, Math.min(365, Math.floor(Number(terms.net_days || 0)))) : 0 } : paymentTermsOf(current);
    await api().publication.invoke(orgId(), 'payroll.contractor.worker.update', { scope:'organization', organizationId:orgId(), id:String(id) }, { worker_classification:next, payment_terms:payment }, { idempotencyKey:newKey('worker') });
    await reload({ type:'user', id:String(id) });
    return user(id);
  }

  /* ---- branches ---- */
  const structure = () => state.structure;
  const multipleBranches = () => CAPABILITIES.multiple_branches();
  const branches = () => arr(state.structure?.branches).filter((entry) => text(entry.status, 'active') !== 'archived');
  const regions = () => arr(state.structure?.regions).filter((entry) => text(entry.status, 'active') !== 'archived');
  const branch = (id) => arr(state.structure?.branches).find((entry) => String(entry.id) === String(id)) || null;
  const region = (id) => arr(state.structure?.regions).find((entry) => String(entry.id) === String(id)) || null;
  /* What the organization calls a branch and a region (terminology keys branches.*; organization-wide, kept on the default branch). */
  const lower = (value) => value ? value.charAt(0).toLowerCase() + value.slice(1) : value;
  function branchWords(){
    const word = (key, fallback) => text(term(`branches.${key}`, fallback), fallback);
    const words = { Branch:word('branch', 'Branch'), Branches:word('branches', 'Branches'), Region:word('region', 'Region'), Regions:word('regions', 'Regions'), Main:word('main_branch', 'Main branch') };
    if (words.Main === 'Main branch' && words.Branch !== 'Branch') words.Main = t('main_branch_word', 'Main {branch}', { branch:lower(words.Branch) });
    return { ...words, branch:lower(words.Branch), branches:lower(words.Branches), region:lower(words.Region), regions:lower(words.Regions), main:lower(words.Main) };
  }
  /* A sentence about branches in the organization's words: {w_Branch} {w_branches} {w_Region} {w_main} ... */
  const bt = (key, fallback, values = {}) => { const words = branchWords(); return t(key, fallback, { ...Object.fromEntries(Object.entries(words).map(([name, value]) => [`w_${name}`, value])), ...values }); };
  /* An unnamed default branch is called by the organization's word for it (branches.main_branch). */
  const branchName = (id) => { const entry = branch(id); const name = text(entry?.name); return name && name !== 'Default Branch' ? name : (entry?.is_default || String(id) === 'default' ? branchWords().Main : String(id)); };
  /* The branches a record belongs to, the way each kind keeps them. */
  function branchIdsOf(kind, record = {}){
    if (!record) return [];
    if (kind === 'department') return [text(record.branch_id, 'default')];
    if (kind === 'company') return ids(record.branch_ids || state.directory.get(`organization_connection:${record.id}`)?.branch_ids);
    if (kind === 'group') { const list = ids(record.branch_ids || record.metadata?.branch_ids || state.directory.get(`resource_group:${record.id}`)?.branch_ids); return list.length ? list : [text(record.branch_id, 'default')]; }
    const list = ids([record.branch_id, ...arr(record.branch_ids), ...arr(record.profile?.branch_ids), ...arr(state.directory.get(`organization_user:${record.id}`)?.branch_ids)].filter(Boolean));
    return list.length ? list : ['default'];
  }

  /* ---- reading ---- */
  const user = (id) => state.users.find((entry) => entry.id === String(id)) || null;
  const role = (id) => state.roles.find((entry) => entry.id === String(id)) || null;
  const activeRoles = () => state.roles.filter((entry) => text(entry.status, 'active') !== 'archived' && !entry.archived_at)
    .sort((left, right) => text(left.name, left.id).localeCompare(text(right.name, right.id)));
  function userRoleIds(entry = {}){
    const stored = entry.profile || entry;
    const assigned = ids(stored.access_profile?.access_role_ids || stored.access_role_ids || stored.access_roles || stored.workforce_profile?.access_role_ids).filter((id) => role(id));
    return assigned;
  }
  const userRoles = (entry) => userRoleIds(entry).map(role).filter(Boolean);
  const userPermissionOverrides = (entry = {}) => ({ ...obj((entry.profile || entry).permission_overrides || entry.permission_overrides) });
  /* A person's own App experience settings: app id -> { visible: { device: shown }, options }. */
  const userAppOverrides = (entry = {}) => appSettings((entry.profile || entry).app_access_overrides || entry.app_access_overrides);
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
  /* Signup writes the account's first user as role "owner" with no level; that user is a super admin. */
  const isOwner = (entry = {}) => ['super_admin', 'owner'].includes(text(entry.org_permissions?.level, entry.org_permission_level, entry.role).toLowerCase());
  const roleMembers = (roleId) => state.users.filter((entry) => userRoleIds(entry).includes(String(roleId)));

  const sentence = (value) => { const words = String(value || '').replace(/[_-]+/g, ' ').trim(); return words ? words.charAt(0).toUpperCase() + words.slice(1) : ''; };
  /* Icons for categories the catalog sends without one, and for Other. */
  const PERMISSION_GROUP_ICONS = { company:'fa-building', people:'fa-users', sales:'fa-handshake', projects:'fa-briefcase', scheduling:'fa-calendar-days', field:'fa-helmet-safety', materials:'fa-boxes-stacked', money:'fa-money-check-dollar', communications:'fa-comments', documents:'fa-file-signature', partners:'fa-people-arrows', other:'fa-key' };
  /* Every permission key there is: the published catalog plus anything a role, an app or a user names. */
  function permissionKeys(){
    const keys = new Set(state.permissionKeys);
    arr(obj(state.permissionCatalog).categories).forEach((category) => arr(category.subcategories).forEach((sub) => arr(sub.permissions).forEach((entry) => { if (text(entry.key)) keys.add(text(entry.key)); })));
    state.roles.forEach((entry) => Object.keys(obj(entry.permissions || entry.permission_defaults)).forEach((key) => keys.add(key)));
    state.apps.forEach((app) => {
      arr(app.required_permissions).forEach((key) => { if (text(key)) keys.add(text(key)); });
      Object.values(obj(app.parameter_permissions)).forEach((key) => { if (text(key)) keys.add(text(key)); });
    });
    state.users.forEach((entry) => Object.keys(userPermissionOverrides(entry)).forEach((key) => keys.add(key)));
    return [...keys].filter(Boolean).sort();
  }
  /*
   * Category -> subcategory -> permission, from the published catalog
   * (permission_catalog on the access catalog). Each group is a category:
   *   { id, label, icon, description, permissions:[every permission in it], subgroups:[{ id, label, description, collapsed, permissions }] }
   * A permission is { key, label, description, unavailable }. A key the catalog
   * does not describe is never hidden: it is listed under Other.
   */
  function permissionGroups(){
    const catalog = obj(state.permissionCatalog);
    const usedBy = (key) => [...new Set(state.apps.filter((app) => arr(app.required_permissions).includes(key) || Object.values(obj(app.parameter_permissions)).includes(key)).map((app) => app.title))];
    const tooltip = (key, description, unavailable) => {
      const apps = usedBy(key);
      return [description, apps.length ? t('permission_used_by', 'Used by {apps}', { apps:apps.join(', ') }) : '', unavailable ? t('permission_app_off', 'Its app is turned off for this company') : ''].filter(Boolean).join('. ');
    };
    const seen = new Set();
    const groups = arr(catalog.categories).map((category) => {
      const id = text(category.id);
      const subgroups = arr(category.subcategories).map((sub) => ({
        id:text(sub.id),
        label:term(`people.permission_subcategory.${text(sub.id)}`, text(sub.label, sentence(sub.id))),
        description:text(sub.description),
        collapsed:sub.collapsed === true,
        permissions:arr(sub.permissions).filter((entry) => text(entry.key) && !seen.has(text(entry.key))).map((entry) => {
          const key = text(entry.key);
          seen.add(key);
          const unavailable = entry.available === false;
          return { key, label:key === '*' ? t('permission_everything', 'Everything') : text(entry.label, sentence(key)), description:tooltip(key, key === '*' ? t('permission_everything_tip', 'Every current and future permission unless one is denied') : text(entry.description), unavailable), unavailable };
        })
      })).filter((sub) => sub.permissions.length);
      return {
        id, label:term(`people.permission_category.${id}`, text(category.label, sentence(id))), icon:text(category.icon, PERMISSION_GROUP_ICONS[id] || 'fa-key'), description:text(category.description),
        subgroups, permissions:subgroups.flatMap((sub) => sub.permissions)
      };
    }).filter((group) => group.permissions.length);
    const unknown = permissionKeys().filter((key) => !seen.has(key));
    if (unknown.length) {
      const other = obj(catalog.other);
      const permissions = unknown.map((key) => ({ key, label:key === '*' ? t('permission_everything', 'Everything') : sentence(key.split('.').join(' ')), description:tooltip(key, key === '*' ? t('permission_everything_tip', 'Every current and future permission unless one is denied') : key, false), unavailable:false }))
        .sort((left, right) => (left.key === '*' ? -1 : right.key === '*' ? 1 : left.label.localeCompare(right.label)));
      groups.push({
        id:'other', label:t('permission_group_other', text(other.label, 'Other')), icon:text(other.icon, PERMISSION_GROUP_ICONS.other), description:t('permission_group_other_tip', text(other.description, 'Permissions the catalog does not describe yet')),
        subgroups:[{ id:'other', label:t('permission_subgroup_other', 'Not described yet'), description:'', permissions }], permissions
      });
    }
    return groups;
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
  /* ---- App experience (docs/architecture/app-experience.md) ---- */
  const boolMap = (value) => Object.fromEntries(Object.entries(obj(value)).filter(([, on]) => typeof on === 'boolean'));
  /* One level's stored settings, with anything that says nothing dropped. */
  function appSettings(value){
    const result = {};
    Object.entries(obj(value)).forEach(([appId, setting]) => {
      const next = People.appGrid?.compact?.({ ...obj(setting), visible:boolMap(obj(setting).visible), options:boolMap(obj(setting).options) });
      if (next) result[appId] = next;
    });
    return result;
  }
  /*
   * What the levels below this one give an app, the way the server resolves it: the app's default,
   * then roles (any role showing it is enough; a role that says nothing gives the default), then
   * departments and groups (any of them showing it is enough), and a restricted app is hidden.
   */
  function inheritedFrom({ roleIds = [], memberships = [] } = {}){
    const roles = ids(roleIds).map(role).filter(Boolean);
    return (appId) => {
      const app = state.apps.find((entry) => entry.id === appId);
      if (!app) return { visible:{}, options:{}, sources:[] };
      const roleSetting = (entry) => obj(appSettings(entry.app_defaults || entry.apps)[appId]);
      const visible = {};
      const sources = new Set();
      arr(app.devices).forEach((device) => {
        let shown = app.default_visible === true;
        if (roles.some((entry) => typeof obj(roleSetting(entry).visible)[device] === 'boolean')) {
          const showing = roles.filter((entry) => { const own = obj(roleSetting(entry).visible)[device]; return typeof own === 'boolean' ? own : app.default_visible === true; });
          shown = showing.length > 0;
          showing.forEach((entry) => sources.add(text(entry.name, entry.id)));
        }
        const explicit = memberships.filter((layer) => typeof obj(obj(layer.settings[appId]).visible)[device] === 'boolean');
        if (explicit.length) {
          const showing = explicit.filter((layer) => obj(layer.settings[appId]).visible[device] === true);
          shown = showing.length > 0;
          showing.forEach((layer) => sources.add(layer.label));
        }
        if (memberships.some((layer) => obj(layer.settings[appId]).restricted === true)) shown = false;
        visible[device] = shown;
      });
      const options = {};
      arr(app.options).forEach((option) => {
        let on = option.default === true;
        if (roles.some((entry) => typeof obj(roleSetting(entry).options)[option.key] === 'boolean')) {
          on = roles.some((entry) => { const own = obj(roleSetting(entry).options)[option.key]; return typeof own === 'boolean' ? own : option.default === true; });
        }
        const explicit = memberships.filter((layer) => typeof obj(obj(layer.settings[appId]).options)[option.key] === 'boolean');
        if (explicit.length) on = explicit.some((layer) => obj(layer.settings[appId]).options[option.key] === true);
        options[option.key] = on;
      });
      return { visible, options, sources:[...sources] };
    };
  }
  /* What a person gets before their own settings: their roles, departments and groups. */
  function inheritedApp(roleIds, entry = null){
    const memberships = [];
    if (entry) {
      userDepartments(entry).forEach((department) => {
        const source = state.departments.find((item) => item.id === department.id);
        if (source) memberships.push({ label:department.label, settings:appSettings(source.app_defaults) });
      });
      userGroups(entry).forEach((group) => {
        memberships.push({ label:text(group.name, group.id), settings:appSettings(obj(group.attributes).app_defaults) });
      });
    }
    return inheritedFrom({ roleIds, memberships });
  }
  const roleAppValue = (entry = {}) => appSettings(entry.app_defaults || entry.apps);
  /* The product defaults: what a level with nothing above it inherits. */
  const catalogDefaultApp = () => inheritedFrom({});

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
      kind:'organization_user', id:entry.id, name:text(draft.name, entry.name, entry.email, entry.id), secondary:text(draft.email, entry.email), marks:workerMarks(entry),
      photoUrl:assetUrl(entry.profile_photo_url || entry.profile_photo), online:entry.id, pills,
      facts:[
        { icon:kit.ICONS.email, label:t('email', 'Email'), value:'', card:false },
        { icon:kit.ICONS.phone, label:t('phone', 'Phone'), value:text(entry.phone, entry.phone_number, entry.mobile) },
        { icon:kit.ICONS.clock, label:t('last_sign_in', 'Last sign-in'), value:dateText(entry.last_login_at), cardLabel:true },
        { icon:kit.ICONS.invite, label:t('invited', 'Invited'), value:neverSignedIn(entry) ? dateText(entry.invited_at || entry.created_at) : '', cardLabel:true },
        { icon:'fa-calendar-plus', label:t('added', 'Added'), value:neverSignedIn(entry) ? '' : dateText(entry.created_at), card:false }
      ],
      sections:[
        /* Roles on the user apply to all work; roles held in one department are shown under that department. */
        { id:'roles', title:t('roles_everywhere', 'Roles everywhere'), icon:kit.ICONS.role, tooltip:t('roles_everywhere_tip', 'These apply to all work, in every department'), chips:roleIds.map(role).filter(Boolean).map((item) => ({ label:text(item.name, item.id), tone:'role', tooltip:item.description })), empty:t('no_roles', 'No roles') },
        { id:'departments', title:state.groupLabels.departmentPlural || t('departments', 'Departments'), icon:kit.ICONS.department,
          chips:departments.map((department) => {
            const here = (draft.scopedAssignments || userScopedAssignments(entry)).filter((assignment) => assignment.scope.kind === 'department' && assignment.scope.id === department.id).map((assignment) => text(role(assignment.role_id)?.name, assignment.role_id));
            const via = department.direct ? '' : t('department_inherited', 'Through a role or a group');
            return { label:department.label, color:department.color, tooltip:[via, here.length ? t('roles_in_list', 'Roles in {place}: {roles}', { place:department.label, roles:here.join(', ') }) : ''].filter(Boolean).join('. ') };
          }), empty:t('no_departments', 'None') },
        { id:'tags', title:t('tags', 'Tags'), icon:'fa-tag', chips:ids(draft.tagIds || userTagIds(entry)).map((id) => state.tags.find((tag) => String(tag.id) === id)).filter(Boolean).map((tag) => ({ label:text(tag.name, tag.id), tone:'muted' })), empty:t('none', 'None'), optional:true },
        { id:'groups', title:state.groupLabels.plural || t('groups', 'Groups'), icon:kit.ICONS.group, tooltip:t('groups_tip', 'Membership is edited from the group'),
          chips:groups.map((group) => ({ label:text(group.name, group.id), tone:'group' })), empty:t('no_groups', 'None') }
      ].filter((section) => ({ roles:can.workforce, departments:can.workforce && (allows('departments.view') || allows('users.departments')), tags:can.workforce, groups:can.groups })[section.id] !== false)
    };
  }

  /* ---- writing ---- */
  const replaceUser = (next) => { const index = state.users.findIndex((entry) => entry.id === next.id); if (index >= 0) state.users[index] = { ...state.users[index], ...next }; else state.users.push(next); };
  async function reload(change){ await load({ refresh:true }).catch(() => {}); emit(change); return state; }

  async function invite({ name, email, roleIds = [], photo = null, level = '' }){
    const platform = api();
    const result = await platform.users.create(orgId(), {
      email:String(email || '').trim().toLowerCase(), name:String(name || '').trim(), role:'viewer', status:'invited', permissions:{}, account_type:'customer',
      access_role_ids:ids(roleIds), permission_overrides:{}, app_access_overrides:{}
    });
    const created = normalizeUser(result?.document || {});
    let profileError = '';
    if (created.id && can.workforce && platform.workforce?.saveUserProfile) {
      try { await platform.workforce.saveUserProfile(orgId(), created.id, { access_role_ids:ids(roleIds), permission_overrides:{}, app_access_overrides:{} }); }
      catch (error) { profileError = error?.message || 'profile'; }
    }
    /* The level goes through the permissions endpoint, which checks the inviter may set it. */
    let levelError = '';
    const chosenLevel = text(level).toLowerCase();
    if (created.id && chosenLevel && chosenLevel !== 'viewer' && LEGACY_LEVELS[chosenLevel] && can.permissions) {
      try { await platform.users.setPermissions(orgId(), created.id, chosenLevel, legacyLevelItems(chosenLevel)); }
      catch (error) { levelError = error?.message || 'level'; }
    }
    let photoError = '';
    if (created.id && photo) { try { await uploadPhoto(created.id, photo, { silent:true }); } catch (error) { photoError = error?.message || 'photo'; } }
    await reload({ type:'invite', id:created.id });
    return { user:user(created.id) || created, emailed:!!(result?.emailed || result?.email_sent), activateUrl:result?.activate_url || result?.invite?.activate_url || '', existingAccount:result?.existing_account === true || result?.invite?.existing_account === true, inviteError:result?.invite?.error || '', profileError, photoError, levelError };
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
  /* Archives: the person is kept for the record (Archived), cannot sign in, and can be restored with everything they had. */
  async function removeUser(id, reason = ''){
    await api().users.remove(orgId(), id, { reason });
    const gone = state.users.find((entry) => entry.id === String(id));
    state.users = state.users.filter((entry) => entry.id !== String(id));
    if (gone) state.archivedUsers = [...state.archivedUsers.filter((entry) => entry.id !== String(id)), { ...gone, deleted:true, status:'disabled', archived_reason:text(reason) }];
    emit({ type:'remove', id:String(id) });
  }
  async function restoreUser(id){
    await api().publication.invoke(orgId(), 'workforce.users.restore', { scope:'organization', organizationId:orgId(), id:String(id) }, {}, { idempotencyKey:newKey('restore') });
    await reload({ type:'user', id:String(id) });
    return user(id);
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
      const administers = (roleId) => ['*', 'manage_company_users', 'manage_company_user_permissions'].some((key) => obj(role(roleId)?.permissions)[key] === true);
      if (isMe(current) && !roleIds.some(administers)) throw new Error(t('keep_own_access', 'Keep a role that lets you into Settings on your own account.'));
      await platform.workforce.saveUserProfile(orgId(), id, {
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
    if (patch.permissions !== undefined) payload.permissions = rolePermissionsPayload(patch.permissions);
    if (patch.appDefaults !== undefined) payload.app_defaults = appSettings(patch.appDefaults);
    await api().workforce.updateAccessRole(orgId(), id, payload);
    await reload({ type:'role', id:String(id) });
    return role(id);
  }
  async function createRole({ name } = {}){
    const clean = String(name || '').trim();
    if (!clean) throw new Error(t('name_required', 'Enter a name.'));
    const result = await api().workforce.createAccessRole(orgId(), { name:clean, description:'', permissions:{}, app_defaults:{} });
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
  const SCOPE_FORBIDDEN = new Set(['*', 'view_region_branches', 'manage_region_branches', 'view_all_branches', 'manage_all_branches', 'manage_billing', 'manage_company_settings', 'manage_company_users', 'manage_company_user_permissions', 'manage_report_settings', 'manage_notification_defaults', 'manage_integrations', 'manage_security', 'manage_roles', 'manage_organization', 'manage_capabilities']);
  const scopableRoles = () => activeRoles().filter((entry) => !Object.entries(obj(entry.permissions)).some(([key, allowed]) => allowed && SCOPE_FORBIDDEN.has(key)));
  /* Legacy access: an admin level and seven flags, for organizations without roles. */
  const LEGACY_FLAGS = ['order_reports', 'view_reports', 'manage_billing', 'manage_company_settings', 'manage_report_settings', 'manage_company_users', 'manage_company_user_permissions'];
  const LEGACY_LEVELS = { viewer:[0, 1, 0, 0, 0, 0, 0], manager:[1, 1, 0, 0, 0, 0, 0], admin:[1, 1, 1, 1, 1, 1, 0], super_admin:[1, 1, 1, 1, 1, 1, 1] };
  const legacyLevelItems = (level) => Object.fromEntries(LEGACY_FLAGS.map((key, index) => [key, !!(LEGACY_LEVELS[level] || LEGACY_LEVELS.viewer)[index]]));
  const legacyMode = () => { try { return window.PlatformAPI?.appFlags?.has?.('platform', 'expanded_access') !== true; } catch (_) { return false; } };
  /* A level outside the five (signup's "owner", a platform role such as "member") is read from the user's flags, never assumed to be viewer. */
  function userLegacy(entry = {}){
    const stored = text(entry.org_permissions?.level, entry.org_permission_level, entry.role, 'viewer').toLowerCase();
    if (stored === 'owner') return { level:'super_admin', items:legacyLevelItems('super_admin') };
    if (stored === 'custom') return { level:'custom', items:Object.fromEntries(LEGACY_FLAGS.map((key) => [key, obj(entry.org_permissions?.items)[key] === true])) };
    if (LEGACY_LEVELS[stored]) return { level:stored, items:legacyLevelItems(stored) };
    const granted = { ...obj(entry.permissions), ...obj(entry.effective_permissions), ...obj(entry.org_permissions?.items) };
    if (granted['*'] === true) return { level:'super_admin', items:legacyLevelItems('super_admin') };
    const items = Object.fromEntries(LEGACY_FLAGS.map((key) => [key, granted[key] === true]));
    const preset = Object.keys(LEGACY_LEVELS).find((level) => LEGACY_FLAGS.every((key) => legacyLevelItems(level)[key] === items[key]));
    if (preset) return { level:preset, items };
    return LEGACY_FLAGS.some((key) => items[key]) ? { level:'custom', items } : { level:'viewer', items:legacyLevelItems('viewer') };
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
    ACTIONS, CAPABILITIES, allows, gate,
    internal:{ emit, reload, api, arr, obj, text, ids, records, invoke, newKey },
    userTagIds, userScopedAssignments, scopableRoles, legacyMode, userLegacy, legacyLevelItems, LEGACY_FLAGS, LEGACY_LEVELS:Object.keys(LEGACY_LEVELS), invoke,
    classificationOf, paymentTermsOf, workerMarks, saveClassification,
    structure, multipleBranches, branches, regions, branch, region, branchName, branchIdsOf, branchWords, bt,
    state, load, subscribe(listener){ listeners.add(listener); return () => listeners.delete(listener); }, can, orgId, branchId, assetUrl,
    user, role, activeRoles, userRoleIds, userRoles, userPermissionOverrides, userAppOverrides, userDepartments, userDirectDepartmentIds, userGroups,
    neverSignedIn, isSuspended, isMe, isOwner, roleMembers, permissionGroups, inheritedPermission, inheritedApp, roleAppValue, appSettings, catalogDefaultApp, userSummary,
    invite, resendInvite, setSuspended, removeUser, restoreUser, saveUser, uploadPhoto, saveUserDepartments, saveRole, createRole, archiveRole, setRoleMembership
  };
})();
