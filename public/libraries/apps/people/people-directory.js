/* public/libraries/apps/people/people-directory.js
 *
 * Groups, departments, outside companies and their types, added to the People
 * store (FirstMatePeople.data). Reads come from the APIs Settings already uses
 * plus the published assignee directory (`assignee-directory.assignees`,
 * `.types`, `.staffing-requirements`), which is enrichment: every page works
 * when a viewer cannot read it. Writes go to each domain's own writer: the
 * workforce group and connection routes, the department catalog, and the
 * `assignees.*` published actions.
 *
 * Reading
 *   data.traits(key)                      { has_members, has_login, external_link, splits_pay }: ask these, never the kind
 *   data.types(kind)  data.typeName(kind, id)      kind: 'resource_group' | 'organization_connection'
 *   data.group(id)  data.groupMembers(group)  data.groupDepartments(group)  data.groupSummary(group, draft)
 *   data.staffing(groupId)
 *   data.department(id)  data.departmentMembers(department)  data.departmentScopedRoles(id)  data.departmentSummary(department)
 *   data.company(id)  data.companyTypeIds(company)  data.companyContact(company)  data.companyDepartments(company)  data.companySummary(company, draft)
 *   data.counts()  data.attention()       live counts and what needs attention, for the People home
 *   data.entityFor(kind, id, name)        the entity the Compensation and Fields panels are given: home, traits, members
 *   data.groupTypeName(id)  data.companyTypeName(id)  data.groupTypeNames()  data.companyTypeNames()  data.companyTypeIds(company | id)
 *   data.wording()  data.allTags()  data.tagUsage(id)  data.typeFlag(id)  data.typeUsage(kind, id)  data.memberRoleWords()
 *   data.division(id)  data.divisionDepartments(id)  data.categoryDepartments(id)  data.loadCompanyPermissions(id)
 *   data.departmentNesting()  data.departmentPlace(id)  data.departmentOutline({ departmentIds, unitIds, loose })   how departments are organized
 *
 * Writing (each resolves after the store is current again)
 *   data.saveType({ kind, id, name, description, status })   data.setTypeMemberRoles(id, roleIds)
 *   data.createGroup({ name, typeId })  data.saveGroup(id, { name, typeId, tagIds, scopeIds })
 *   data.setGroupMembers(id, members) -> { grants:[{ user_id, role_ids, error }] }   data.archiveGroup(id)
 *   data.saveStaffing(groupId, requirements)
 *   data.saveSubjectDepartments('group' | 'connection', id, departmentIds)
 *   data.saveDepartment(department)  data.archiveDepartment(id)  data.setScopedRole(userId, roleId, departmentId, on)
 *   data.createCompany({ name })  data.saveCompany(id, patch)  data.setCompanyTypes(id, typeIds)  data.archiveCompany(id)
 *   data.saveConfiguration(change)  data.saveTag({ id, name, status })  data.setTypeExternal(id, bool)  data.saveWording({ group, member, company, department })
 *   data.saveDivision({ id, label, kind, parent_id, status })  data.saveCategory({ id, label, remove })
 *   data.savePaymentTerms(id, { basis, net_days })  data.saveCompanyPermissions(id, { access_role_ids, permission_overrides })
 */
(function(){
  'use strict';
  const People = window.FirstMatePeople = window.FirstMatePeople || {};
  const data = People.data;
  if (!data || data.group) return;
  const kit = People.kit;
  const { t } = kit;
  const { emit, reload, api, arr, obj, text, ids, records, invoke } = data.internal;
  const state = data.state;
  const orgId = data.orgId;
  const branchId = data.branchId;

  const TRAITS = {
    organization_user:{ has_members:false, has_login:true, external_link:false, splits_pay:false },
    resource_group:{ has_members:true, has_login:false, external_link:false, splits_pay:true },
    organization_connection:{ has_members:false, has_login:false, external_link:true, splits_pay:false }
  };
  const row = (key) => state.directory.get(String(key)) || null;
  const traits = (key) => ({ ...(TRAITS[String(key).split(':')[0]] || {}), ...obj(row(key)?.traits) });

  /* ---- types ---- */
  const types = (kind) => state.types.filter((type) => type.kind === kind && text(type.status, 'active') !== 'archived').sort((left, right) => text(left.name).localeCompare(text(right.name)));
  const typeName = (kind, id) => text(state.types.find((type) => type.kind === kind && type.id === String(id))?.name, id);
  async function saveType(input){
    const saved = await invoke('assignees.type.save', { kind:input.kind, ...(input.id ? { id:input.id } : {}), name:String(input.name || '').trim(), ...(input.description !== undefined ? { description:String(input.description || '').trim() } : {}), ...(input.status ? { status:input.status } : {}) });
    await reload({ type:'types' });
    return saved;
  }
  async function setTypeMemberRoles(id, roleIds){
    const saved = await invoke('assignees.type.member-roles.set', { id, member_role_ids:ids(roleIds) });
    await reload({ type:'types' });
    return saved;
  }

  /* ---- groups ---- */
  const group = (id) => state.groups.find((entry) => String(entry.id) === String(id)) || null;
  const groupMembers = (entry = {}) => {
    const lead = text(entry.lead_user_id, entry.primary_member_user_id);
    const members = arr(entry.member_assignments || entry.members);
    const list = members.length ? members.map((member) => ({ user_id:text(member?.user_id, member?.userId, member?.id), role:text(member?.role, member?.role_id, 'member'), is_lead:member?.is_lead === true || member?.lead === true, status:text(member?.status, 'active'), joined_role_ids:ids(member?.joined_role_ids) }))
      : ids(entry.member_user_ids || entry.user_ids).map((userId) => ({ user_id:userId, role:'member', is_lead:false, status:'active', joined_role_ids:[] }));
    return list.filter((member) => member.user_id && member.status !== 'removed').map((member) => ({ ...member, is_lead:member.is_lead || (!!lead && lead === member.user_id) }));
  };
  const subjectDepartments = (key, typeId) => state.departments.map((department) => {
    const direct = arr(department.subject_keys).includes(key);
    const viaType = !!typeId && arr(department.group_kind_ids).includes(typeId);
    return direct || viaType ? { id:department.id, label:text(department.label, department.id), color:text(department.color, '#98a2b3'), icon:text(department.icon), direct } : null;
  }).filter(Boolean);
  const groupDepartments = (entry = {}) => subjectDepartments(`resource_group:${entry.id}`, text(entry.kind_id));
  const departmentChips = (list, draftIds) => {
    const shown = draftIds ? [...list.filter((department) => !department.direct), ...draftIds.filter((id) => !list.some((department) => department.id === id && !department.direct)).map((id) => state.departments.find((department) => department.id === id)).filter(Boolean).map((department) => ({ id:department.id, label:text(department.label, department.id), color:text(department.color, '#98a2b3'), direct:true }))] : list;
    return shown.map((department) => ({ label:department.label, color:department.color, tooltip:department.direct ? '' : t('department_inherited_type', 'Through its type') }));
  };
  const scopeChips = (scopeIds) => ids(scopeIds).map((id) => state.scopes.find((scope) => scope.id === id)).filter(Boolean).map((scope) => ({ label:scope.name }));
  const tagChips = (tagIds) => ids(tagIds).map((id) => state.tags.find((tag) => String(tag.id) === id)).filter(Boolean).map((tag) => ({ label:text(tag.name, tag.id), tone:'muted' }));
  function groupSummary(entry = {}, draft = {}){
    const members = groupMembers(entry);
    const lead = members.find((member) => member.is_lead);
    const typeId = draft.typeId || text(entry.kind_id);
    return {
      kind:'resource_group', id:entry.id, name:text(draft.name, entry.name, entry.id), secondary:'', icon:kit.ICONS.group, color:'#0e7090',
      pills:typeId ? [{ label:typeName('resource_group', typeId), tone:'role' }] : [],
      facts:[
        { icon:'fa-star', label:t('lead', 'Lead'), value:lead ? text(data.user(lead.user_id)?.name, data.user(lead.user_id)?.email) : '', cardLabel:true },
        { icon:kit.ICONS.users, label:t('members', 'Members'), value:String(members.length), card:true, panel:false, cardLabel:true }
      ],
      sections:[
        { id:'departments', title:state.groupLabels.departmentPlural || t('departments', 'Departments'), icon:kit.ICONS.department, chips:departmentChips(groupDepartments({ ...entry, kind_id:typeId }), draft.departmentIds), empty:t('none', 'None') },
        { id:'tags', title:t('tags', 'Tags'), icon:'fa-tag', chips:tagChips(draft.tagIds || entry.assignment_tag_ids), empty:t('none', 'None') },
        { id:'scopes', title:t('kinds_of_work', 'Kinds of work'), icon:'fa-layer-group', tooltip:t('kinds_of_work_tip', 'The project scopes this can be given work in'), chips:scopeChips(draft.scopeIds || entry.capability_scope_ids), empty:t('none', 'None') }
      ]
    };
  }
  const groupResult = (result) => result?.resource_group || result?.group || result || {};
  async function createGroup({ name, typeId }){
    const result = await api().workforce.createResourceGroup(orgId(), branchId(), { branch_id:branchId(), name:String(name || '').trim(), kind_id:typeId, assignment_tag_ids:[], members:[], capability_scope_ids:[] });
    const created = groupResult(result);
    await reload({ type:'group', id:text(created.id) });
    return group(created.id) || created;
  }
  async function saveGroup(id, patch = {}){
    const current = group(id);
    if (!current) throw new Error(t('gone', 'This no longer exists.'));
    await api().workforce.updateResourceGroup(orgId(), branchId(), id, {
      expected_revision:Number(current.revision || 0) || undefined,
      ...(patch.name !== undefined ? { name:String(patch.name || '').trim() } : {}),
      ...(patch.typeId !== undefined ? { kind_id:patch.typeId } : {}),
      ...(patch.tagIds !== undefined ? { assignment_tag_ids:ids(patch.tagIds) } : {}),
      ...(patch.scopeIds !== undefined ? { capability_scope_ids:ids(patch.scopeIds) } : {})
    });
    await reload({ type:'group', id:String(id) });
    return group(id);
  }
  /* Joining a group gives the roles its type names. The write says who was given what; nothing is taken away on leaving. */
  async function setGroupMembers(id, members){
    const current = group(id);
    if (!current) throw new Error(t('gone', 'This no longer exists.'));
    const list = members.map((member) => ({ user_id:member.user_id, role:text(member.role, 'member'), is_lead:member.is_lead === true, status:'active' }));
    const result = await api().workforce.updateResourceGroup(orgId(), branchId(), id, { expected_revision:Number(current.revision || 0) || undefined, members:list, primary_member_user_id:list.find((member) => member.is_lead)?.user_id || null });
    const grants = arr(result?.member_role_grants || groupResult(result).member_role_grants);
    await reload({ type:'group', id:String(id) });
    return { grants };
  }
  async function archiveGroup(id){
    await api().workforce.archiveResourceGroup(orgId(), branchId(), id, Number(group(id)?.revision || 0));
    await reload({ type:'group', id:String(id) });
  }
  const staffing = (groupId) => arr(state.staffing.get(`resource_group:${groupId}`)?.staffing_requirements).map((entry) => JSON.parse(JSON.stringify(entry)));
  async function saveStaffing(groupId, requirements){
    const saved = await invoke('assignees.staffing-requirements.set', { assignee:{ type:'resource_group', id:String(groupId) }, staffing_requirements:requirements });
    state.staffing.set(`resource_group:${groupId}`, { id:`resource_group:${groupId}`, assignee_id:`resource_group:${groupId}`, staffing_requirements:arr(saved?.staffing_requirements || requirements), revision:saved?.revision });
    emit({ type:'group', id:String(groupId) });
  }
  async function saveSubjectDepartments(kind, id, departmentIds){
    const current = state.departmentState || {};
    const next = await api().workforce.saveDepartmentAssignment(orgId(), { kind, id, department_ids:ids(departmentIds), revision:current.revision, legacy_token:current.legacy_token });
    window.dispatchEvent(new CustomEvent('fm:departments:updated'));
    void next;
    await reload({ type:kind === 'group' ? 'group' : 'company', id:String(id) });
  }

  /* ---- departments ---- */
  const department = (id) => state.departments.find((entry) => String(entry.id) === String(id)) || null;
  function departmentMembers(entry = {}){
    const keys = arr(entry.subject_keys);
    const users = state.users.map((user) => {
      const membership = state.memberships.get(user.id);
      const sources = arr(membership?.sources).filter((source) => source.department_id === entry.id);
      const direct = keys.includes(`organization_user:${user.id}`);
      if (!direct && !sources.length) return null;
      return { user, direct, via:sources.filter((source) => source.kind !== 'direct').map((source) => source.kind === 'role' ? text(data.role(source.id)?.name, source.id) : text(group(source.id)?.name, source.id)) };
    }).filter(Boolean);
    const groups = state.groups.filter((entry2) => keys.includes(`resource_group:${entry2.id}`) || arr(entry.group_kind_ids).includes(text(entry2.kind_id))).map((entry2) => ({ group:entry2, direct:keys.includes(`resource_group:${entry2.id}`) }));
    const companies = state.connections.filter((company) => keys.includes(`organization_connection:${company.id}`)).map((company) => ({ company, direct:true }));
    return { users, groups, companies };
  }
  const departmentScopedRoles = (id, kind = 'department') => state.users.flatMap((user) => data.userScopedAssignments(user).filter((assignment) => assignment.scope.kind === kind && assignment.scope.id === String(id)).map((assignment) => ({ user, role_id:assignment.role_id })));
  function departmentSummary(entry = {}, draft = {}){
    const members = departmentMembers({ ...entry, ...draft });
    return {
      kind:'department', id:entry.id, name:text(draft.label, entry.label, entry.id), secondary:'', icon:text(draft.icon ?? entry.icon, kit.ICONS.department).split(' ').pop(), color:text(draft.color, entry.color, '#64748b'),
      pills:[],
      facts:[{ icon:kit.ICONS.users, label:t('members', 'Members'), value:String(members.users.length), panel:false, cardLabel:true }, { icon:kit.ICONS.group, label:state.groupLabels.plural || t('groups', 'Groups'), value:members.groups.length ? String(members.groups.length) : '', panel:false, cardLabel:true }],
      sections:[
        { id:'roles', title:t('department_member_roles', 'Everyone with these roles'), icon:kit.ICONS.role, tooltip:t('department_roles_tip', 'Everyone with one of these roles is in this department'), chips:ids(draft.role_ids || entry.role_ids).map((id) => ({ label:text(data.role(id)?.name, id), tone:'role' })), empty:t('none', 'None') },
        { id:'group_types', title:t('group_types', '{groups} types', { groups:state.groupLabels.singular || t('group', 'Group') }), icon:kit.ICONS.group, tooltip:t('department_group_types_tip', 'Every group of one of these types is in this department'), chips:ids(draft.group_kind_ids || entry.group_kind_ids).map((id) => ({ label:typeName('resource_group', id), tone:'group' })), empty:t('none', 'None') }
      ]
    };
  }
  async function writeDepartments(change){
    const current = state.departmentState || {};
    const all = arr(current.departments).map((entry) => ({ ...entry }));
    const next = change(all);
    const strip = (entry) => { const { id, label, color, icon, group_id, division_id, status, default_channel, app_defaults, subject_keys, role_ids, group_kind_ids } = entry; return { id, label, color:color || '#64748b', ...(icon ? { icon } : {}), group_id:group_id || '', division_id:division_id || '', status:status || 'active', default_channel:default_channel !== false, app_defaults:app_defaults || {}, subject_keys:ids(subject_keys), role_ids:ids(role_ids), group_kind_ids:ids(group_kind_ids) }; };
    await api().workforce.saveDepartments(orgId(), { departments:next.map(strip), groups:arr(current.groups), divisions:arr(current.divisions), terminology:current.terminology, revision:current.revision, legacy_token:current.legacy_token });
    window.dispatchEvent(new CustomEvent('fm:departments:updated'));
  }
  async function saveDepartment(input = {}){
    const id = text(input.id) || (window.crypto?.randomUUID?.() || `department-${Date.now()}`);
    const label = String(input.label || '').trim();
    if (!label) throw new Error(t('name_required', 'Enter a name.'));
    await writeDepartments((all) => {
      const index = all.findIndex((entry) => entry.id === id);
      const merged = { ...(index >= 0 ? all[index] : { id, status:'active', subject_keys:[], role_ids:[], group_kind_ids:[], group_id:'', division_id:'', default_channel:true, app_defaults:{} }), ...input, id, label };
      if (index >= 0) all[index] = merged; else all.push(merged);
      return all;
    });
    await reload({ type:'department', id });
    return department(id);
  }
  async function archiveDepartment(id){
    await writeDepartments((all) => all.map((entry) => entry.id === String(id) ? { ...entry, status:'archived' } : entry));
    await reload({ type:'department', id:String(id) });
  }
  async function setScopedRole(userId, roleId, departmentId, on, kind = 'department'){
    const user = data.user(userId);
    if (!user) throw new Error(t('user_missing', 'This user no longer exists.'));
    const same = (assignment) => assignment.role_id === String(roleId) && assignment.scope.kind === kind && assignment.scope.id === String(departmentId);
    const list = data.userScopedAssignments(user).filter((assignment) => !same(assignment));
    if (on) list.push({ role_id:String(roleId), scope:{ kind, id:String(departmentId) } });
    await data.saveUser(userId, { scopedAssignments:list });
  }

  /* ---- outside companies ---- */
  const company = (id) => state.connections.find((entry) => String(entry.id) === String(id)) || null;
  const companyTypeIds = (entry = {}) => ids(row(`organization_connection:${typeof entry === 'object' ? entry.id : entry}`)?.type_ids);
  const companyContact = (entry = {}) => { const contacts = arr(entry.contacts); return obj(contacts.find((contact) => contact?.primary === true) || contacts[0]); };
  const companyDepartments = (entry = {}) => subjectDepartments(`organization_connection:${entry.id}`, '');
  const linkStatus = (entry = {}) => text(row(`organization_connection:${entry.id}`)?.link_status, entry.link_status, entry.linked_organization_id ? 'pending' : 'unlinked');
  const linkPill = (entry) => {
    const status = linkStatus(entry);
    return status === 'linked' ? { label:t('linked', 'Linked'), tone:'ok', icon:'fa-link' } : status === 'pending' ? { label:t('link_pending', 'Link pending'), tone:'warn', icon:'fa-link' } : null;
  };
  function companySummary(entry = {}, draft = {}){
    const contact = { ...companyContact(entry), ...obj(draft.contact) };
    const typeIds = draft.typeIds || companyTypeIds(entry);
    const pill = linkPill(entry);
    return {
      kind:'organization_connection', id:entry.id, name:text(draft.name, entry.name, entry.display_name, entry.legal_name, entry.id), secondary:text(draft.legal_name ?? entry.legal_name), icon:kit.ICONS.company, color:'#475467',
      pills:pill ? [pill] : [],
      facts:[
        { icon:kit.ICONS.user, label:t('contact', 'Contact'), value:text(contact.name), panel:false },
        { icon:kit.ICONS.email, label:t('email', 'Email'), value:text(contact.email), panel:false },
        { icon:kit.ICONS.phone, label:t('phone', 'Phone'), value:text(contact.phone), panel:false }
      ],
      sections:[
        { id:'types', title:t('types', 'Types'), icon:'fa-tags', chips:typeIds.map((id) => ({ label:typeName('organization_connection', id), tone:'group' })), empty:t('none', 'None') },
        { id:'departments', title:state.groupLabels.departmentPlural || t('departments', 'Departments'), icon:kit.ICONS.department, chips:departmentChips(companyDepartments(entry), draft.departmentIds), empty:t('none', 'None') },
        { id:'scopes', title:t('kinds_of_work', 'Kinds of work'), icon:'fa-layer-group', tooltip:t('kinds_of_work_tip', 'The project scopes this can be given work in'), chips:scopeChips(draft.scopeIds || entry.capability_scope_ids), empty:t('none', 'None') }
      ]
    };
  }
  const companyResult = (result) => result?.organization_connection || result?.connection || result || {};
  async function createCompany({ name }){
    const result = await api().connections.create(orgId(), { name:String(name || '').trim(), legal_name:'', branch_ids:[branchId()], contacts:[], capability_scope_ids:[] }, { branchId:branchId() });
    const created = companyResult(result);
    await reload({ type:'company', id:text(created.id) });
    return company(created.id) || created;
  }
  async function saveCompany(id, patch = {}){
    const current = company(id);
    if (!current) throw new Error(t('gone', 'This no longer exists.'));
    const body = { expected_revision:Number(current.revision || 0) || undefined };
    ['name', 'legal_name'].forEach((key) => { if (patch[key] !== undefined) body[key] = String(patch[key] || '').trim(); });
    if (body.name !== undefined && !body.name) throw new Error(t('name_required', 'Enter a name.'));
    if (patch.contact !== undefined) {
      const primary = { ...companyContact(current), ...obj(patch.contact), id:text(companyContact(current).id, 'primary'), primary:true };
      body.contacts = [primary.name, primary.email, primary.phone].some((value) => text(value)) ? [primary, ...arr(current.contacts).filter((contact) => contact !== companyContact(current) && contact?.primary !== true)] : arr(current.contacts).filter((contact) => contact?.primary !== true && contact !== companyContact(current));
    }
    if (patch.address !== undefined) body.address = { ...obj(current.address), ...obj(patch.address) };
    if (patch.external_reference !== undefined) body.metadata = { ...obj(current.metadata), external_reference:String(patch.external_reference || '').trim() };
    if (patch.scopeIds !== undefined) body.capability_scope_ids = ids(patch.scopeIds);
    if (patch.linked_organization_id !== undefined) {
      const linked = String(patch.linked_organization_id || '').trim();
      body.linked_organization_id = linked || null;
      body.link_status = linked ? (current.link_status === 'linked' && linked === text(current.linked_organization_id) ? 'linked' : 'pending') : 'unlinked';
    }
    body.branch_ids = ids([...arr(current.branch_ids), branchId()]);
    const result = await api().connections.update(orgId(), id, body);
    window.dispatchEvent(new CustomEvent('fm:organization-connections:updated', { detail:{ connection:companyResult(result) } }));
    await reload({ type:'company', id:String(id) });
    return company(id);
  }
  async function setCompanyTypes(id, typeIds){
    await invoke('assignees.profile.set', { assignee:{ type:'organization_connection', id:String(id) }, type_ids:ids(typeIds) });
    await reload({ type:'company', id:String(id) });
  }
  async function archiveCompany(id){
    await api().connections.archive(orgId(), id, Number(company(id)?.revision || 0));
    await reload({ type:'company', id:String(id) });
  }
  /* Payment terms belong to payroll; this is its own published writer. */
  async function savePaymentTerms(id, terms){
    const current = company(id);
    const publication = api()?.publication;
    await publication.invoke(orgId(), 'payroll.contractor.company.update', { scope:'organization', organizationId:orgId(), id:String(id) }, { expected_revision:Number(current?.revision || 0), payment_terms:{ basis:terms.basis, net_days:terms.basis === 'net_days' ? Number(terms.net_days || 0) : 0 } }, { idempotencyKey:data.internal.newKey('people-company-terms') });
    await reload({ type:'company', id:String(id) });
  }
  /* What a company's own people may do on this organization's projects. Stored only; nothing resolves it yet. */
  const companyPermissions = (entry = {}) => { const set = row(`organization_connection:${entry.id}`)?.permission_defaults; return set && typeof set === 'object' ? { access_role_ids:ids(set.access_role_ids), permission_overrides:{ ...obj(set.permission_overrides) } } : null; };
  async function saveCompanyPermissions(id, set){
    await invoke('assignees.permission-defaults.set', { assignee:{ type:'organization_connection', id:String(id) }, access_role_ids:ids(set.access_role_ids), permission_overrides:obj(set.permission_overrides) });
    await reload({ type:'company', id:String(id) });
  }

  /* ---- the workforce configuration: tags, the partner flag on a group type, the organization's own words ---- */
  async function saveConfiguration(change){
    await api().workforce.saveConfiguration(orgId(), branchId(), { expected_revision:Number(state.configuration.revision || 0), ...change });
    await reload({ type:'configuration' });
  }
  const slug = (value) => String(value || '').trim().toLowerCase().replace(/[^a-z0-9_-]+/g, '_').replace(/^_+|_+$/g, '');
  const allTags = () => arr(state.configuration.assignment_tags).filter((tag) => tag && text(tag.id));
  async function saveTag(input){
    const name = String(input.name || '').trim();
    if (!name) throw new Error(t('name_required', 'Enter a name.'));
    const id = text(input.id) || slug(name);
    if (!input.id && allTags().some((tag) => String(tag.id) === id && tag.status !== 'archived')) throw new Error(t('tag_exists', 'There is already a tag with that name.'));
    await saveConfiguration({ assignment_tags:[{ id, name, status:input.status || 'active' }] });
  }
  const tagUsage = (id) => state.users.filter((user) => data.userTagIds(user).includes(String(id))).length + state.groups.filter((entry) => ids(entry.assignment_tag_ids).includes(String(id))).length;
  const typeFlag = (id) => arr(state.configuration.resource_group_kinds).find((entry) => String(entry.id) === String(id))?.external_assignment === true;
  async function setTypeExternal(id, on){
    const current = arr(state.configuration.resource_group_kinds).find((entry) => String(entry.id) === String(id)) || state.types.find((type) => type.kind === 'resource_group' && type.id === String(id));
    if (!current) throw new Error(t('gone', 'This no longer exists.'));
    await saveConfiguration({ resource_group_kinds:[{ id:String(id), name:text(current.name, id), ...(text(current.description) ? { description:text(current.description) } : {}), status:text(current.status, 'active'), external_assignment:!!on }] });
  }
  const typeUsage = (kind, id) => kind === 'resource_group' ? state.groups.filter((entry) => String(entry.kind_id) === String(id)) : state.connections.filter((entry) => companyTypeIds(entry).includes(String(id)));
  /* What the organization calls a group, its members, an outside company and a department. */
  const wording = () => {
    const terms = obj(state.configuration.terminology);
    const pair = (source, one, many) => ({ singular:text(obj(source).singular, one), plural:text(obj(source).plural, many) });
    return {
      group:pair(terms.resource_group, state.groupLabels.singular, state.groupLabels.plural),
      member:pair(terms.resource_group_member, t('member_word', 'Member'), t('members', 'Members')),
      company:pair(terms.organization_connection, state.groupLabels.connectionSingular, state.groupLabels.connectionPlural),
      department:pair(obj(state.departmentState?.terminology).department, state.groupLabels.departmentSingular, state.groupLabels.departmentPlural)
    };
  };
  async function saveWording(next){
    const now = wording();
    const changed = (key) => next[key] && (next[key].singular !== now[key].singular || next[key].plural !== now[key].plural);
    if (changed('group') || changed('member') || changed('company')) await saveConfiguration({ terminology:{ resource_group:next.group, resource_group_member:next.member, organization_connection:next.company } });
    if (changed('department')) await writeCatalog((catalog) => { catalog.terminology = { ...obj(catalog.terminology), department:next.department }; });
    await reload({ type:'configuration' });
    try { await window.PlatformTerminology?.refresh?.(orgId(), branchId()); } catch (_) {}
    window.dispatchEvent(new CustomEvent('fm:terminology:updated'));
  }

  /* ---- the department catalog beyond one department: categories and divisions ---- */
  async function writeCatalog(change){
    const current = state.departmentState || {};
    const catalog = { departments:arr(current.departments).map((entry) => ({ ...entry })), groups:arr(current.groups).map((entry) => ({ ...entry })), divisions:arr(current.divisions).map((entry) => ({ ...entry })), terminology:current.terminology };
    change(catalog);
    const department = (entry) => { const { id, label, color, icon, group_id, division_id, status, default_channel, app_defaults, subject_keys, role_ids, group_kind_ids } = entry; return { id, label, color:color || '#64748b', ...(icon ? { icon } : {}), group_id:group_id || '', division_id:division_id || '', status:status || 'active', default_channel:default_channel !== false, app_defaults:app_defaults || {}, subject_keys:ids(subject_keys), role_ids:ids(role_ids), group_kind_ids:ids(group_kind_ids) }; };
    const division = (entry) => ({ id:entry.id, label:entry.label, kind:text(entry.kind, 'Division'), parent_id:entry.parent_id || '', branch_id:entry.branch_id || '', status:entry.status || 'active', subject_keys:ids(entry.subject_keys) });
    await api().workforce.saveDepartments(orgId(), { departments:catalog.departments.map(department), groups:catalog.groups.map((entry) => ({ id:entry.id, label:entry.label })), divisions:catalog.divisions.map(division), ...(catalog.terminology ? { terminology:catalog.terminology } : {}), revision:current.revision, legacy_token:current.legacy_token });
    window.dispatchEvent(new CustomEvent('fm:departments:updated'));
  }
  const newId = () => window.crypto?.randomUUID?.() || `id-${Date.now().toString(36)}`;
  const division = (id) => state.divisions.find((entry) => String(entry.id) === String(id)) || null;
  async function saveDivision(input){
    const label = String(input.label || '').trim();
    if (!label) throw new Error(t('name_required', 'Enter a name.'));
    const id = text(input.id) || newId();
    await writeCatalog((catalog) => { const index = catalog.divisions.findIndex((entry) => entry.id === id); const merged = { ...(index >= 0 ? catalog.divisions[index] : { id, status:'active', subject_keys:[], parent_id:'', branch_id:'' }), ...input, id, label }; if (index >= 0) catalog.divisions[index] = merged; else catalog.divisions.push(merged); });
    await reload({ type:'division', id });
    return division(id);
  }
  const divisionDepartments = (id) => state.departments.filter((entry) => String(entry.division_id || '') === String(id));
  async function saveCategory(input){
    const label = String(input.label || '').trim();
    if (!label) throw new Error(t('name_required', 'Enter a name.'));
    const id = text(input.id) || newId();
    await writeCatalog((catalog) => {
      if (input.remove) { catalog.groups = catalog.groups.filter((entry) => entry.id !== id); catalog.departments.forEach((entry) => { if (entry.group_id === id) entry.group_id = ''; }); return; }
      const index = catalog.groups.findIndex((entry) => entry.id === id);
      if (index >= 0) catalog.groups[index] = { id, label }; else catalog.groups.push({ id, label });
    });
    await reload({ type:'department' });
    return state.departmentCategories.find((entry) => entry.id === id) || null;
  }
  const categoryDepartments = (id) => state.departments.filter((entry) => String(entry.group_id || '') === String(id));

  /*
   * How departments are organized. Departments do not nest; organizational units (divisions) do, through
   * parent_id, and a department sits in at most one unit. A category only labels a department. So the
   * outline nests by unit when any department is in one, and by category when none is but some have one.
   */
  const category = (id) => state.departmentCategories.find((entry) => String(entry.id) === String(id)) || null;
  function unitPath(unitId){
    const path = [];
    const seen = new Set();
    let id = String(unitId || '');
    while (id && !seen.has(id)) { seen.add(id); const unit = division(id); if (!unit) break; path.unshift(unit); id = String(unit.parent_id || ''); }
    return path;
  }
  const departmentNesting = () => state.departments.some((entry) => unitPath(entry.division_id).length) ? 'units' : state.departments.some((entry) => category(entry.group_id)) ? 'categories' : '';
  const unitSteps = (unitId) => unitPath(unitId).map((unit) => ({ kind:'unit', id:String(unit.id), label:text(unit.label, unit.id), tooltip:text(unit.kind), unit }));
  /* Where a department sits, outermost first: [{ kind:'unit' | 'category', id, label }]. Empty when it sits at the top. */
  function departmentPlace(departmentId){
    const entry = department(departmentId);
    if (!entry) return [];
    const how = departmentNesting();
    if (how === 'units') return unitSteps(entry.division_id);
    const holder = how === 'categories' ? category(entry.group_id) : null;
    return holder ? [{ kind:'category', id:String(holder.id), label:text(holder.label, holder.id) }] : [];
  }
  /*
   * departmentOutline({ departmentIds, unitIds, loose:'first' | 'last' }) -> rows in reading order
   *   [{ kind:'unit' | 'category' | 'department', id, label, tooltip, depth, department, unit }]
   * The given departments (all when omitted) under the units or category that hold them. unitIds adds
   * units that must show although none of the listed departments is in them. `loose` puts the
   * departments of a level before (default) or after the units in it.
   */
  function departmentOutline(options = {}){
    const wanted = options.departmentIds ? ids(options.departmentIds) : state.departments.map((entry) => String(entry.id));
    const root = { children:new Map(), departments:[] };
    const nodeFor = (path) => path.reduce((node, step) => {
      const key = `${step.kind}:${step.id}`;
      if (!node.children.has(key)) node.children.set(key, { step, children:new Map(), departments:[] });
      return node.children.get(key);
    }, root);
    wanted.forEach((id) => { const entry = department(id); if (entry && !nodeFor(departmentPlace(id)).departments.includes(entry)) nodeFor(departmentPlace(id)).departments.push(entry); });
    ids(options.unitIds).forEach((id) => { const path = unitSteps(id); if (path.length) nodeFor(path); });
    const rows = [];
    const byLabel = (left, right) => String(left).localeCompare(String(right));
    const walk = (node, depth) => {
      const departments = () => node.departments.sort((left, right) => byLabel(text(left.label, left.id), text(right.label, right.id))).forEach((entry) => rows.push({ kind:'department', id:String(entry.id), label:text(entry.label, entry.id), depth, department:entry }));
      const children = () => [...node.children.values()].sort((left, right) => byLabel(left.step.label, right.step.label)).forEach((child) => { rows.push({ ...child.step, depth }); walk(child, depth + 1); });
      if (options.loose === 'last') { children(); departments(); } else { departments(); children(); }
    };
    walk(root, 0);
    return rows;
  }

  /* ---- a company's permission set: read when the directory publishes it ---- */
  async function loadCompanyPermissions(id){
    const fromRow = companyPermissions({ id });
    if (fromRow) return fromRow;
    try {
      const result = await api()?.publication?.read?.(orgId(), { provider:'assignee-directory', export:'permission-defaults', target:{ scope:'organization', organizationId:orgId(), id:`organization_connection:${id}` } });
      const set = result && (result.status === undefined || result.status === 'ready') ? obj(result.value).permission_defaults : null;
      return set && typeof set === 'object' ? { access_role_ids:ids(set.access_role_ids), permission_overrides:{ ...obj(set.permission_overrides) } } : null;
    } catch (_) { return null; }
  }

  /* ---- what the Compensation and Fields panels are told about an entity ---- */
  const HOME = { access_role:'role', resource_group_kind:'group_type', organization_connection_type:'company_type', department:'department' };
  function entityFor(kind, id, name){
    const key = `${kind}:${id}`;
    const extra = {};
    if (HOME[kind]) extra.home = { kind:HOME[kind], id:String(id) };
    else {
      extra.traits = traits(key);
      if (extra.traits.has_members) extra.members = groupMembers(group(id) || {}).map((member) => ({ id:member.user_id, name:text(data.user(member.user_id)?.name, data.user(member.user_id)?.email, member.user_id) }));
      if (kind === 'organization_connection') extra.type_ids = companyTypeIds(id);
    }
    return People.slots.entity(kind, id, name, extra);
  }
  const memberRoleWords = () => [...new Set(state.groups.flatMap((entry) => groupMembers(entry).map((member) => member.role)).filter((role) => role && !['member', 'lead'].includes(role)))].sort();

  /* ---- what needs attention, from what is already loaded ---- */
  function attention(){
    const never = state.users.filter(data.neverSignedIn).length;
    const unlinked = state.connections.filter((entry) => linkStatus(entry) !== 'linked').length;
    const none = state.departments.length ? state.users.filter((user) => !data.userDepartments(user).length && !data.isSuspended(user)).length : 0;
    const empty = state.groups.filter((entry) => !groupMembers(entry).length).length;
    const noRole = state.roles.length ? state.users.filter((user) => !data.userRoleIds(user).length && !data.isSuspended(user)).length : 0;
    return [
      never ? { id:'never', icon:kit.ICONS.invite, view:'users', filter:'never', count:never, label:t('attention_never', 'never signed in') } : null,
      noRole ? { id:'no_role', icon:kit.ICONS.role, view:'users', filter:'no_role', count:noRole, label:t('attention_no_role', 'without a role') } : null,
      none ? { id:'no_department', icon:kit.ICONS.department, view:'users', filter:'no_department', count:none, label:t('attention_no_department', 'in no {department}', { department:(state.groupLabels.departmentSingular || 'department').toLowerCase() }) } : null,
      empty ? { id:'empty_groups', icon:kit.ICONS.group, view:'groups', filter:'empty', count:empty, label:t('attention_empty', 'with no members') } : null,
      unlinked ? { id:'unlinked', icon:'fa-link-slash', view:'subcontractors', filter:'unlinked', count:unlinked, label:t('attention_unlinked', 'not linked') } : null
    ].filter(Boolean);
  }

  const counts = () => ({
    users:state.users.length, neverSignedIn:state.users.filter(data.neverSignedIn).length, online:0,
    groups:state.groups.length, groupTypes:types('resource_group').length,
    departments:state.departments.length,
    companies:state.connections.length, linked:state.connections.filter((entry) => linkStatus(entry) === 'linked').length
  });

  Object.assign(data, {
    traits, types, typeName, saveType, setTypeMemberRoles,
    group, groupMembers, groupDepartments, groupSummary, createGroup, saveGroup, setGroupMembers, archiveGroup, staffing, saveStaffing, saveSubjectDepartments,
    department, departmentMembers, departmentScopedRoles, departmentSummary, saveDepartment, archiveDepartment, setScopedRole,
    company, companyTypeIds, companyContact, companyDepartments, companySummary, linkStatus, linkPill, createCompany, saveCompany, setCompanyTypes, archiveCompany, savePaymentTerms, companyPermissions, saveCompanyPermissions,
    counts, saveConfiguration, allTags, saveTag, tagUsage, typeFlag, setTypeExternal, typeUsage, wording, saveWording,
    division, saveDivision, divisionDepartments, saveCategory, categoryDepartments, category, unitPath, departmentNesting, departmentPlace, departmentOutline, loadCompanyPermissions, entityFor, memberRoleWords, attention,
    groupTypeName:(id) => typeName('resource_group', id), companyTypeName:(id) => typeName('organization_connection', id),
    groupTypeNames:() => Object.fromEntries(types('resource_group').map((type) => [type.id, type.name])), companyTypeNames:() => Object.fromEntries(types('organization_connection').map((type) => [type.id, type.name]))
  });
  void records;
})();
