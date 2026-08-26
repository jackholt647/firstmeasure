/* libraries/platform-scheduling/platform-scheduling.js
 * Branch-scoped scheduling helpers for Platform projects.
 *
 * This library is intentionally the front-end authority for scheduling vocabulary:
 * callers pass stable ids such as "sales_appointment" and "sales_appointments";
 * the library loads branch variable mappings and returns objects with both id and
 * label so UI code never has to duplicate terminology rules.
 */
(function(){
  const root = window;
  const PlatformAPI = root.PlatformAPI;

  const MODULES = {
    scheduling: 'scheduling',
    mappings: 'variable_mappings',
    stages: 'stages',
    triggers: 'triggers',
  };

  const STANDARD_ROLES = {
    sales_appointments: { id: 'sales_appointments', fallback_label: 'Sales Appointments' },
    inside_sales: { id: 'inside_sales', fallback_label: 'Inside Sales' },
  };

  const DEFAULT_EVENT_TYPES = {
    sales_appointment: {
      id: 'sales_appointment',
      required_role_ids: ['sales_appointments'],
      allowed_role_ids: ['sales_appointments'],
      role_ids: ['sales_appointments'],
      duration_minutes: 60,
      slot_minutes: 30,
      buffer_minutes: 30,
      allow_unassigned: true,
      color: '#2563eb',
      status: 'active',
    },
    project_work: {
      id: 'project_work',
      required_role_ids: [],
      allowed_role_ids: [],
      role_ids: [],
      duration_minutes: 8 * 60,
      slot_minutes: 30,
      buffer_minutes: 0,
      allow_unassigned: true,
      color: '#16a34a',
      status: 'active',
    },
  };

  const DEFAULT_AVAILABILITY = {
    timezone: 'local',
    working_hours: [
      { days: [1, 2, 3, 4, 5], start: '09:00', end: '17:00' },
    ],
  };

  const DEFAULT_MAPPINGS = {
    schema_version: 1,
    labels: {
      roles: {
        sales_appointments: 'Sales Appointments',
        inside_sales: 'Inside Sales',
      },
      event_types: {
        sales_appointment: 'Sales Appointment',
        project_work: 'Project Work',
      },
      stages: {
        new_lead: 'New Lead',
        appointment_scheduled: 'Appointment Scheduled',
        drafting_proposal: 'Drafting Proposal',
        proposal_sent: 'Proposal Sent',
        newly_sold: 'Sold',
        project_started: 'Project Started',
        in_progress: 'In Progress',
        completed: 'Completed',
        contacting: 'Contacting',
        cancelled: 'Cancelled',
        lost: 'Lost',
      },
    },
  };

  const DEFAULT_STAGES = {
    schema_version: 1,
    order: ['new_lead', 'appointment_scheduled', 'drafting_proposal', 'proposal_sent', 'newly_sold', 'project_started', 'in_progress', 'completed', 'cancelled', 'lost'],
    stages: {
      new_lead: { id: 'new_lead', status: 'active', color: '#0f766e' },
      appointment_scheduled: { id: 'appointment_scheduled', status: 'active', color: '#2563eb' },
      drafting_proposal: { id: 'drafting_proposal', status: 'active', color: '#7c3aed' },
      proposal_sent: { id: 'proposal_sent', status: 'active', color: '#4f46e5' },
      newly_sold: { id: 'newly_sold', status: 'active', color: '#16a34a', locked: true },
      project_started: { id: 'project_started', status: 'active', color: '#0ea5e9' },
      in_progress: { id: 'in_progress', status: 'active', color: '#f59e0b' },
      completed: { id: 'completed', status: 'active', color: '#15803d' },
      contacting: { id: 'contacting', status: 'active', color: '#64748b' },
      cancelled: { id: 'cancelled', status: 'active', color: '#475467', terminal: true },
      lost: { id: 'lost', status: 'active', color: '#b42318' },
    },
  };

  const cache = new Map();

  function nowIso(){ return new Date().toISOString(); }
  function cleanText(value){ return String(value ?? '').trim(); }
  function arrayValue(value){ return Array.isArray(value) ? value : []; }
  function objectValue(value){ return value && typeof value === 'object' && !Array.isArray(value) ? value : {}; }
  function unique(values){ return Array.from(new Set(arrayValue(values).map(cleanText).filter(Boolean))); }

  function humanizeKey(key){
    return cleanText(key)
      .replace(/[_-]+/g, ' ')
      .replace(/\s+/g, ' ')
      .trim()
      .replace(/\b\w/g, (letter) => letter.toUpperCase());
  }

  function toDate(value){
    const date = value instanceof Date ? value : new Date(value);
    return Number.isFinite(date.getTime()) ? date : null;
  }

  function addMinutes(date, minutes){
    return new Date(date.getTime() + (Number(minutes) || 0) * 60000);
  }

  function localDateInput(date = new Date()){
    const year = date.getFullYear();
    const month = String(date.getMonth() + 1).padStart(2, '0');
    const day = String(date.getDate()).padStart(2, '0');
    return `${year}-${month}-${day}`;
  }

  function minutesFromTime(value){
    const match = cleanText(value).match(/^(\d{1,2}):(\d{2})/);
    if (!match) return 0;
    return Math.max(0, Math.min(24 * 60, Number(match[1]) * 60 + Number(match[2])));
  }

  function timeFromMinutes(value){
    const mins = Math.max(0, Math.min(24 * 60 - 1, Number(value) || 0));
    return `${String(Math.floor(mins / 60)).padStart(2, '0')}:${String(mins % 60).padStart(2, '0')}`;
  }

  function dateAtMinutes(dateString, minutes){
    return new Date(`${dateString}T${timeFromMinutes(minutes)}:00`);
  }

  function dayNumber(date = new Date()){
    const value = date instanceof Date ? date : new Date(date);
    return Number.isFinite(value.getTime()) ? value.getDay() : new Date().getDay();
  }

  function availabilityWindow(config = null, date = localDateInput(), eventTypeId = 'sales_appointment'){
    const availability = objectValue(config?.availability || config?.scheduling?.availability || config);
    const windows = objectValue(availability.event_type_windows);
    const eventWindow = objectValue(windows[eventTypeId]);
    const targetDay = dayNumber(`${date}T12:00:00`);
    const workingHours = arrayValue(availability.working_hours);
    const matching = workingHours.find((entry) => arrayValue(entry?.days).map(Number).includes(targetDay)) || workingHours[0] || {};
    const start = cleanText(eventWindow.start || eventWindow.start_time || matching.start || matching.start_time || availability[`${eventTypeId}_start_time`] || availability.sales_appointment_start_time || DEFAULT_AVAILABILITY.working_hours[0].start);
    const end = cleanText(eventWindow.end || eventWindow.end_time || matching.end || matching.end_time || availability[`${eventTypeId}_end_time`] || availability.sales_appointment_end_time || DEFAULT_AVAILABILITY.working_hours[0].end);
    return {
      start: /^\d{1,2}:\d{2}$/.test(start) ? timeFromMinutes(minutesFromTime(start)) : DEFAULT_AVAILABILITY.working_hours[0].start,
      end: /^\d{1,2}:\d{2}$/.test(end) ? timeFromMinutes(minutesFromTime(end)) : DEFAULT_AVAILABILITY.working_hours[0].end,
      days: arrayValue(matching.days).length ? arrayValue(matching.days).map(Number) : DEFAULT_AVAILABILITY.working_hours[0].days,
    };
  }

  function docData(docOrData){
    return docOrData?.data && typeof docOrData.data === 'object' ? docOrData.data : objectValue(docOrData);
  }

  function docId(docOrData){
    return cleanText(docOrData?.id || docOrData?.data?.id || docOrData?.document?.id || docOrData?.document?.data?.id);
  }

  function schedulingDefaults(){
    return {
      schema_version: 1,
      roles: Object.values(STANDARD_ROLES).map((role) => ({ id: role.id })),
      event_types: Object.fromEntries(Object.entries(DEFAULT_EVENT_TYPES).map(([id, eventType]) => [id, { ...eventType }])),
      availability: { ...DEFAULT_AVAILABILITY, working_hours: DEFAULT_AVAILABILITY.working_hours.map((entry) => ({ ...entry, days: [...entry.days] })) },
    };
  }

  function mergeSchedulingModule(input = {}){
    const data = objectValue(input);
    const defaults = schedulingDefaults();
    const eventTypes = { ...defaults.event_types, ...objectValue(data.event_types) };
    Object.entries(eventTypes).forEach(([id, eventType]) => {
      eventTypes[id] = {
        id,
        ...objectValue(DEFAULT_EVENT_TYPES[id]),
        ...objectValue(eventType),
        required_role_ids: unique(eventType?.required_role_ids || eventType?.required_roles || eventType?.role_ids || eventType?.roles || DEFAULT_EVENT_TYPES[id]?.required_role_ids || DEFAULT_EVENT_TYPES[id]?.role_ids || []),
        allowed_role_ids: unique(eventType?.allowed_role_ids || eventType?.allowed_roles || eventType?.role_ids || eventType?.roles || DEFAULT_EVENT_TYPES[id]?.allowed_role_ids || DEFAULT_EVENT_TYPES[id]?.role_ids || []),
        duration_minutes: Math.max(1, Number(eventType?.duration_minutes || eventType?.duration || DEFAULT_EVENT_TYPES[id]?.duration_minutes || 60)),
        slot_minutes: Math.max(1, Number(eventType?.slot_minutes || eventType?.slot || DEFAULT_EVENT_TYPES[id]?.slot_minutes || 30)),
        buffer_minutes: Math.max(0, Number(eventType?.buffer_minutes || eventType?.travel_buffer_minutes || eventType?.gap_minutes || DEFAULT_EVENT_TYPES[id]?.buffer_minutes || 0)),
      };
      eventTypes[id].role_ids = unique([...eventTypes[id].required_role_ids, ...eventTypes[id].allowed_role_ids, ...(eventTypes[id].role_ids || [])]);
    });
    const roleIds = unique([
      ...defaults.roles.map((role) => role.id),
      ...arrayValue(data.roles).map((role) => typeof role === 'string' ? role : role?.id),
      ...Object.values(eventTypes).flatMap((eventType) => [...(eventType.required_role_ids || []), ...(eventType.allowed_role_ids || []), ...(eventType.role_ids || [])]),
    ]);
    return {
      ...defaults,
      ...data,
      roles: roleIds.map((id) => ({ id, ...objectValue(arrayValue(data.roles).find((role) => role?.id === id)) })),
      event_types: eventTypes,
      availability: { ...defaults.availability, ...objectValue(data.availability) },
    };
  }

  function mergeMappingsModule(input = {}){
    const data = objectValue(input);
    return {
      ...DEFAULT_MAPPINGS,
      ...data,
      labels: {
        ...DEFAULT_MAPPINGS.labels,
        ...objectValue(data.labels),
        roles: { ...DEFAULT_MAPPINGS.labels.roles, ...objectValue(data.labels?.roles) },
        event_types: { ...DEFAULT_MAPPINGS.labels.event_types, ...objectValue(data.labels?.event_types) },
        stages: { ...DEFAULT_MAPPINGS.labels.stages, ...objectValue(data.labels?.stages) },
      },
    };
  }

  function mergeStagesModule(input = {}){
    const data = objectValue(input);
    const stages = { ...DEFAULT_STAGES.stages, ...objectValue(data.stages) };
    const rawOrder = arrayValue(data.order).map(cleanText).filter(Boolean);
    const legacyDefaults = [
      ['appointment_scheduled', 'newly_sold', 'project_started', 'in_progress', 'completed'],
      ['new_lead', 'contacting', 'appointment_scheduled', 'newly_sold', 'lost'],
      ['contacting', 'appointment_scheduled', 'newly_sold', 'lost'],
    ];
    const isLegacyDefault = legacyDefaults.some((order) => order.length === rawOrder.length && order.every((stage, index) => stage === rawOrder[index]));
    const order = !rawOrder.length || isLegacyDefault
      ? DEFAULT_STAGES.order
      : [...rawOrder, ...DEFAULT_STAGES.order.filter((stage) => !rawOrder.includes(stage))];
    Object.keys(stages).forEach((id) => {
      stages[id] = { id, ...objectValue(stages[id]) };
    });
    return { ...DEFAULT_STAGES, ...data, stages, order };
  }

  function withMappedLabels(config){
    const mappings = mergeMappingsModule(config.mappings);
    const scheduling = mergeSchedulingModule(config.scheduling);
    const stagesModule = mergeStagesModule(config.stages);
    const roles = scheduling.roles.map((role) => ({
      ...role,
      id: cleanText(role.id),
      label: labelFor({ mappings }, 'roles', role.id),
    }));
    const event_types = Object.fromEntries(Object.entries(scheduling.event_types).map(([id, eventType]) => [id, {
      ...eventType,
      id,
      label: labelFor({ mappings }, 'event_types', id),
      mapped_required_roles: unique(eventType.required_role_ids).map((roleId) => ({ id: roleId, label: labelFor({ mappings }, 'roles', roleId) })),
      mapped_allowed_roles: unique(eventType.allowed_role_ids).map((roleId) => ({ id: roleId, label: labelFor({ mappings }, 'roles', roleId) })),
      mapped_roles: unique(eventType.role_ids).map((roleId) => ({ id: roleId, label: labelFor({ mappings }, 'roles', roleId) })),
    }]));
    const stages = stagesModule.order.map((id) => ({
      ...objectValue(stagesModule.stages[id]),
      id,
      label: labelFor({ mappings }, 'stages', id),
    })).filter((stage) => stage.id);
    return {
      modules: MODULES,
      standard_roles: STANDARD_ROLES,
      scheduling: { ...scheduling, roles, event_types },
      mappings,
      stages_module: { ...stagesModule, stages: Object.fromEntries(stages.map((stage) => [stage.id, stage])) },
      stages,
      roles,
      event_types,
      availability: scheduling.availability,
      loaded_at: nowIso(),
    };
  }

  function cacheKey(orgId, branchId){ return `${cleanText(orgId)}::${cleanText(branchId || 'default')}`; }

  async function loadModule(orgId, branchId, moduleId){
    if (!PlatformAPI?.branchModules?.get) return null;
    try {
      const module = await PlatformAPI.branchModules.get(orgId, branchId, moduleId);
      return module?.data || module || null;
    } catch (error) {
      return null;
    }
  }

  async function saveModule(orgId, branchId, moduleId, data){
    if (!PlatformAPI?.branchModules?.save) return null;
    return PlatformAPI.branchModules.save(orgId, branchId, moduleId, data, { kind: `branch_${moduleId}` });
  }

  async function listedModuleMap(orgId, branchId){
    if (!PlatformAPI?.branchModules?.list) return null;
    try {
      const modules = await PlatformAPI.branchModules.list(orgId, branchId);
      return new Map((Array.isArray(modules) ? modules : [])
        .map((module) => [cleanText(module?.module || module?.id), module])
        .filter(([id]) => id));
    } catch (error) {
      return null;
    }
  }

  async function loadBranchConfig(orgId, branchId, options = {}){
    const key = cacheKey(orgId, branchId);
    if (!options.refresh && cache.has(key)) return cache.get(key);
    const moduleMap = options.ensureDefaults === true ? await listedModuleMap(orgId, branchId) : null;
    const getExisting = (moduleId) => {
      if (!moduleMap) return loadModule(orgId, branchId, moduleId);
      const listed = moduleMap.get(moduleId);
      return listed ? (listed.data || listed) : null;
    };
    const [schedulingRaw, mappingsRaw, stagesRaw] = await Promise.all([
      getExisting(MODULES.scheduling),
      getExisting(MODULES.mappings),
      getExisting(MODULES.stages),
    ]);
    const scheduling = mergeSchedulingModule(schedulingRaw);
    const mappings = mergeMappingsModule(mappingsRaw);
    const stages = mergeStagesModule(stagesRaw);
    const config = withMappedLabels({ scheduling, mappings, stages });
    config.org_id = orgId;
    config.branch_id = branchId || 'default';
    cache.set(key, config);
    if (options.ensureDefaults === true) {
      if (!schedulingRaw || !Object.keys(objectValue(schedulingRaw.event_types)).length) saveModule(orgId, branchId, MODULES.scheduling, scheduling).catch(() => null);
      if (!mappingsRaw || !objectValue(mappingsRaw.labels).roles) saveModule(orgId, branchId, MODULES.mappings, mappings).catch(() => null);
      if (!stagesRaw || !Object.keys(objectValue(stagesRaw.stages)).length) saveModule(orgId, branchId, MODULES.stages, config.stages_module).catch(() => null);
    }
    return config;
  }

  function labelFor(config, namespace, id){
    const labels = objectValue(config?.mappings?.labels?.[namespace]);
    return cleanText(labels[id]) || humanizeKey(id);
  }

  function allStandardRoleIds(){
    return Object.keys(STANDARD_ROLES);
  }

  function defaultRolesForNewAdmin(){
    return allStandardRoleIds();
  }

  function normalizeUser(userDocOrData, config = null){
    const data = docData(userDocOrData);
    const roleText = cleanText(data.role || data.permission_level).toLowerCase();
    let roles = unique(data.roles);
    if (!roles.length && ['owner', 'admin', 'super_admin'].includes(roleText)) roles = defaultRolesForNewAdmin();
    return {
      ...data,
      id: docId(userDocOrData) || cleanText(data.id),
      roles,
      mapped_roles: roles.map((id) => ({ id, label: config ? labelFor(config, 'roles', id) : humanizeKey(id) })),
    };
  }

  function userHasRole(user, roleId){
    return arrayValue(normalizeUser(user).roles).includes(roleId);
  }

  function normalizeEvent(event, config = null, project = null){
    const raw = objectValue(event);
    const typeId = cleanText(raw.event_type_default_id || raw.type_id || raw.event_type_id || raw.type || 'custom');
    const eventType = config?.event_types?.[typeId] || {};
    const start = toDate(raw.start_at || raw.start || raw.starts_at);
    const rawEnd = toDate(raw.end_at || raw.end);
    const derivedDuration = start && rawEnd && rawEnd > start ? Math.max(1, Math.round((rawEnd.getTime() - start.getTime()) / 60000)) : 0;
    const duration = Math.max(1, Number(raw.duration_minutes || raw.duration || derivedDuration || eventType.duration_minutes || 60));
    const end = start ? (rawEnd && rawEnd > start ? rawEnd : addMinutes(start, duration)) : addMinutes(new Date(), duration);
    const requiredRoleIds = unique(raw.required_role_ids || raw.required_roles || eventType.required_role_ids || raw.role_ids || raw.roles || eventType.role_ids || []);
    const allowedRoleIds = unique(raw.allowed_role_ids || raw.allowed_roles || eventType.allowed_role_ids || raw.role_ids || raw.roles || eventType.role_ids || requiredRoleIds);
    const roleIds = unique(raw.role_ids || raw.roles || [...requiredRoleIds, ...allowedRoleIds]);
    const legacyAssignedUser = raw.assigned_user || null;
    const assignedUsers = arrayValue(raw.assigned_users).map((user) => ({
      id: cleanText(user?.id || user?.user_id),
      name: cleanText(user?.name || user?.email || user?.label),
      role_ids: unique(user?.role_ids || user?.roles || roleIds),
    })).filter((user) => user.id);
    const assignedUserIds = unique([
      ...arrayValue(raw.assigned_user_ids || raw.user_ids),
      raw.assigned_user_id,
      raw.user_id,
      legacyAssignedUser?.id,
      ...assignedUsers.map((user) => user.id),
    ]);
    const completeAssignedUsers = assignedUserIds.map((id) => (
      assignedUsers.find((user) => user.id === id) || { id, name: '', role_ids: roleIds }
    ));
    return {
      ...raw,
      id: cleanText(raw.id) || `event_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`,
      type_id: typeId,
      event_type_id: typeId,
      event_type_default_id: cleanText(raw.event_type_default_id || raw.template_id || typeId),
      title: cleanText(raw.title) || (config ? labelFor(config, 'event_types', typeId) : humanizeKey(typeId)),
      start_at: start ? start.toISOString() : nowIso(),
      duration_minutes: duration,
      end_at: end.toISOString(),
      required_role_ids: requiredRoleIds,
      allowed_role_ids: allowedRoleIds,
      role_ids: roleIds,
      mapped_required_roles: requiredRoleIds.map((id) => ({ id, label: config ? labelFor(config, 'roles', id) : humanizeKey(id) })),
      mapped_allowed_roles: allowedRoleIds.map((id) => ({ id, label: config ? labelFor(config, 'roles', id) : humanizeKey(id) })),
      mapped_roles: roleIds.map((id) => ({ id, label: config ? labelFor(config, 'roles', id) : humanizeKey(id) })),
      mapped_type: { id: typeId, label: config ? labelFor(config, 'event_types', typeId) : humanizeKey(typeId) },
      assigned_user_ids: assignedUserIds,
      assigned_users: completeAssignedUsers,
      assigned_user_id: assignedUserIds[0] || '',
      assigned_user_name: cleanText(raw.assigned_user_name || completeAssignedUsers[0]?.name || legacyAssignedUser?.name || legacyAssignedUser?.email),
      status: cleanText(raw.status) || 'scheduled',
      project_id: cleanText(raw.project_id || project?.id),
      project_address: cleanText(raw.project_address || project?.address),
    };
  }

  function normalizeProject(projectDocOrData, config = null){
    const data = docData(projectDocOrData);
    const id = docId(projectDocOrData) || cleanText(data.id);
    const events = arrayValue(data.events).map((event) => normalizeEvent(event, config, { ...data, id }));
    const stageId = cleanText(data.stage || data.stage_id || 'new_lead');
    return {
      ...data,
      id,
      stage: stageId,
      stage_id: stageId,
      mapped_stage: { id: stageId, label: config ? labelFor(config, 'stages', stageId) : humanizeKey(stageId) },
      events
    };
  }

  async function listUsers(orgId, config = null){
    const result = await PlatformAPI.users.list(orgId).catch(() => ({ documents: [], users: [] }));
    return arrayValue(result?.documents || result?.users || result).map((doc) => normalizeUser(doc, config));
  }

  async function listProjects(orgId, config = null){
    const result = await PlatformAPI.projects.list(orgId).catch(() => ({ documents: [], projects: [] }));
    return arrayValue(result?.documents || result?.projects || result).map((doc) => normalizeProject(doc, config));
  }

  function eventsFromProjects(projects, config = null){
    return arrayValue(projects).flatMap((project) => {
      const normalizedProject = normalizeProject(project, config);
      return normalizedProject.events.map((event) => normalizeEvent(event, config, normalizedProject));
    });
  }

  function eventStart(event){ return toDate(event?.start_at || event?.start || event?.starts_at); }
  function eventEnd(event){
    const start = eventStart(event);
    if (!start) return null;
    return toDate(event?.end_at || event?.end) || addMinutes(start, Number(event?.duration_minutes || event?.duration || 60));
  }

  function eventDurationMinutes(event){
    const start = eventStart(event);
    const end = eventEnd(event);
    if (start && end && end > start) return Math.max(1, Math.round((end.getTime() - start.getTime()) / 60000));
    return Math.max(1, Number(event?.duration_minutes || event?.duration || 60));
  }

  function eventTypeId(event = {}){
    return cleanText(event.event_type_default_id || event.type_id || event.event_type_id || event.type);
  }

  function eventIsType(event, typeId){
    const target = cleanText(typeId);
    return !!target && eventTypeId(event) === target;
  }

  function projectEvents(project = {}, config = null){
    return arrayValue(docData(project).events).map((event) => normalizeEvent(event, config, project));
  }

  function projectSalesAppointmentEvents(project = {}, config = null){
    return projectEvents(project, config).filter((event) => eventIsType(event, 'sales_appointment'));
  }

  function projectWorkEvents(project = {}, config = null){
    return projectEvents(project, config).filter((event) => eventIsType(event, 'project_work'));
  }

  function intervalsOverlap(startA, endA, startB, endB){
    const a1 = toDate(startA); const a2 = toDate(endA); const b1 = toDate(startB); const b2 = toDate(endB);
    return !!(a1 && a2 && b1 && b2 && a1 < b2 && b1 < a2);
  }

  function assignedUsersFromInput(users = [], assignedUserIds = [], assignedUsers = []){
    const normalizedUsers = arrayValue(users).map((user) => normalizeUser(user));
    const explicitUsers = arrayValue(assignedUsers).map((user) => normalizeUser(user));
    const ids = unique([
      ...arrayValue(assignedUserIds),
      ...explicitUsers.map((user) => user.id),
    ]);
    return ids.map((id) => {
      const fromUsers = normalizedUsers.find((user) => user.id === id);
      const fromExplicit = explicitUsers.find((user) => user.id === id);
      return {
        ...(fromUsers || {}),
        ...(fromExplicit || {}),
        id,
        roles: unique([...(fromUsers?.roles || []), ...(fromExplicit?.roles || []), ...(fromExplicit?.role_ids || [])]),
      };
    }).filter((user) => user.id);
  }

  function availabilityForRole({ users = [], projects = [], events = null, roleId, start, durationMinutes = 60, bufferMinutes = 0, excludeEventId = '' } = {}){
    const startDate = toDate(start);
    const endDate = startDate ? addMinutes(startDate, durationMinutes) : null;
    const conflictStart = startDate ? addMinutes(startDate, -Math.max(0, Number(bufferMinutes) || 0)) : null;
    const conflictEnd = endDate ? addMinutes(endDate, Math.max(0, Number(bufferMinutes) || 0)) : null;
    const roleUsers = arrayValue(users).map((user) => normalizeUser(user)).filter((user) => userHasRole(user, roleId) && user.status !== 'disabled');
    const allEvents = events ? arrayValue(events) : eventsFromProjects(projects);
    const overlapping = allEvents
      .map((event) => normalizeEvent(event))
      .filter((event) => event.id !== excludeEventId && conflictStart && conflictEnd && intervalsOverlap(conflictStart, conflictEnd, eventStart(event), eventEnd(event)));
    const assignedBusyIds = new Set(overlapping.flatMap((event) => unique([event.assigned_user_id, ...(event.assigned_user_ids || [])])).filter(Boolean));
    const roleConflicts = overlapping.filter((event) => unique([...(event.required_role_ids || []), ...(event.allowed_role_ids || []), ...(event.role_ids || [])]).includes(roleId));
    const unassignedRoleConflictCount = roleConflicts.filter((event) => !event.assigned_user_id).length;
    const availableUsers = roleUsers.filter((user) => !assignedBusyIds.has(user.id));
    const capacityAvailable = Math.max(0, availableUsers.length - unassignedRoleConflictCount);
    return {
      role_id: roleId,
      start: startDate?.toISOString() || '',
      end: endDate?.toISOString() || '',
      duration_minutes: Number(durationMinutes) || 60,
      buffer_minutes: Math.max(0, Number(bufferMinutes) || 0),
      users: roleUsers,
      availableUsers,
      unavailableUsers: roleUsers.filter((user) => assignedBusyIds.has(user.id)),
      overlapping,
      unassigned_role_conflicts: unassignedRoleConflictCount,
      capacity_available: capacityAvailable,
      hasAvailability: capacityAvailable > 0,
    };
  }

  function availabilityForEventType({
    users = [],
    projects = [],
    events = null,
    eventType = null,
    eventTypeId = '',
    start,
    durationMinutes = null,
    bufferMinutes = null,
    excludeEventId = '',
    assignedUserIds = [],
    assigned_user_ids = [],
    assignedUsers = [],
    assigned_users = [],
    allowUnavailableAssigned = false,
    allowSingleUserForMultipleRequiredRoles = false,
  } = {}){
    const type = objectValue(eventType || DEFAULT_EVENT_TYPES[eventTypeId]);
    const requiredRoleIds = unique(type.required_role_ids || type.required_roles || type.role_ids || []);
    const allowedRoleIds = unique(type.allowed_role_ids || type.allowed_roles || type.role_ids || requiredRoleIds);
    const duration = Number(durationMinutes || type.duration_minutes || 60);
    const buffer = Math.max(0, Number(bufferMinutes ?? type.buffer_minutes ?? 0) || 0);
    const required = requiredRoleIds.map((roleId) => availabilityForRole({ users, projects, events, roleId, start, durationMinutes: duration, bufferMinutes: buffer, excludeEventId }));
    const allowed = allowedRoleIds.map((roleId) => availabilityForRole({ users, projects, events, roleId, start, durationMinutes: duration, bufferMinutes: buffer, excludeEventId }));
    const assigned = assignedUsersFromInput(users, unique([...arrayValue(assignedUserIds), ...arrayValue(assigned_user_ids)]), [...arrayValue(assignedUsers), ...arrayValue(assigned_users)]);
    const assignedStatus = assigned.map((user) => {
      const availability = availabilityForRole({ users, projects, events, roleId: user.roles[0] || '', start, durationMinutes: duration, bufferMinutes: buffer, excludeEventId });
      const busy = availability.overlapping.some((event) => unique([event.assigned_user_id, ...(event.assigned_user_ids || [])]).includes(user.id));
      return {
        user,
        busy,
        available: !busy || allowUnavailableAssigned,
        matched_required_role_ids: requiredRoleIds.filter((roleId) => userHasRole(user, roleId)),
        matched_allowed_role_ids: allowedRoleIds.filter((roleId) => userHasRole(user, roleId)),
      };
    });
    const assignedAvailable = assignedStatus.every((entry) => entry.available);
    const assignedRequiredUserIds = new Set();
    const requiredAssignments = [];
    const requiredOk = [...required]
      .sort((a, b) => a.availableUsers.length - b.availableUsers.length)
      .every((item) => {
        const assignedMatch = assignedStatus.find((entry) => {
          if (!entry.matched_required_role_ids.includes(item.role_id) || !entry.available) return false;
          return allowSingleUserForMultipleRequiredRoles || !assignedRequiredUserIds.has(entry.user.id);
        });
        if (assignedMatch) {
          assignedRequiredUserIds.add(assignedMatch.user.id);
          requiredAssignments.push({ role_id: item.role_id, user: assignedMatch.user, source: 'assigned' });
          return true;
        }
        const user = item.availableUsers.find((candidate) => {
          if (!allowSingleUserForMultipleRequiredRoles && assignedRequiredUserIds.has(candidate.id)) return false;
          return true;
        });
        if (!user) return false;
        assignedRequiredUserIds.add(user.id);
        requiredAssignments.push({ role_id: item.role_id, user, source: 'available_pool' });
        return item.hasAvailability;
      });
    const eligibleUsers = [];
    allowed.forEach((item) => {
      item.availableUsers.forEach((user) => {
        if (!eligibleUsers.some((existing) => existing.id === user.id)) eligibleUsers.push(user);
      });
    });
    assignedStatus.forEach((entry) => {
      if (entry.matched_allowed_role_ids.length && !eligibleUsers.some((existing) => existing.id === entry.user.id)) eligibleUsers.push(entry.user);
    });
    const hasAvailability = assignedAvailable && requiredOk && (!allowedRoleIds.length || eligibleUsers.length > 0 || assigned.length > 0);
    return {
      event_type_id: cleanText(type.id || eventTypeId),
      start: toDate(start)?.toISOString() || '',
      duration_minutes: duration,
      buffer_minutes: buffer,
      required,
      allowed,
      assigned,
      assignedStatus,
      assignedAvailable,
      requiredAssignments,
      eligibleUsers,
      hasAvailability,
      overrideRequired: !hasAvailability,
    };
  }

  function availableEventTypeTimeSlots({
    users = [],
    projects = [],
    events = null,
    eventType = null,
    eventTypeId = '',
    date = localDateInput(),
    durationMinutes = null,
    bufferMinutes = null,
    stepMinutes = 30,
    workdayStart = '09:00',
    workdayEnd = '17:00',
    assignedUserIds = [],
    assignedUsers = [],
    allowUnavailableAssigned = false,
    allowSingleUserForMultipleRequiredRoles = false,
  } = {}){
    const type = objectValue(eventType || DEFAULT_EVENT_TYPES[eventTypeId]);
    const duration = Math.max(1, Number(durationMinutes || type.duration_minutes || 60));
    const buffer = Math.max(0, Number(bufferMinutes ?? type.buffer_minutes ?? 0) || 0);
    const slots = [];
    const startMinute = minutesFromTime(workdayStart);
    const endMinute = minutesFromTime(workdayEnd);
    for (let minute = startMinute; minute + duration <= endMinute; minute += Math.max(5, Number(stepMinutes) || 30)) {
      const start = dateAtMinutes(date, minute);
      const availability = availabilityForEventType({
        users,
        projects,
        events,
        eventType: type,
        eventTypeId,
        start,
        durationMinutes: duration,
        bufferMinutes: buffer,
        assignedUserIds,
        assignedUsers,
        allowUnavailableAssigned,
        allowSingleUserForMultipleRequiredRoles,
      });
      slots.push({
        start: start.toISOString(),
        time: timeFromMinutes(minute),
        label: start.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }),
        ...availability,
      });
    }
    return slots;
  }

  function availableTimeSlots({ users = [], projects = [], events = null, roleId, date = localDateInput(), durationMinutes = 60, bufferMinutes = 0, stepMinutes = 30, workdayStart = '09:00', workdayEnd = '17:00' } = {}){
    const slots = [];
    const startMinute = minutesFromTime(workdayStart);
    const endMinute = minutesFromTime(workdayEnd);
    const duration = Math.max(1, Number(durationMinutes) || 60);
    for (let minute = startMinute; minute + duration <= endMinute; minute += Math.max(5, Number(stepMinutes) || 30)) {
      const start = dateAtMinutes(date, minute);
      const availability = availabilityForRole({ users, projects, events, roleId, start, durationMinutes: duration, bufferMinutes });
      slots.push({
        start: start.toISOString(),
        time: timeFromMinutes(minute),
        label: start.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }),
        ...availability,
      });
    }
    return slots;
  }

  function createProjectEvent(project, eventTypeId, fields = {}, config = null){
    const typeId = cleanText(eventTypeId || fields.type_id || 'custom');
    const eventType = config?.event_types?.[typeId] || DEFAULT_EVENT_TYPES[typeId] || {};
    const start = toDate(fields.start || fields.start_at) || new Date();
    const end = toDate(fields.end || fields.end_at);
    const duration = end && end > start
      ? Math.max(1, Math.round((end.getTime() - start.getTime()) / 60000))
      : (fields.durationMinutes || fields.duration_minutes || eventType.duration_minutes || 60);
    const assignedUser = fields.assignedUser || fields.assigned_user || null;
    return normalizeEvent({
      id: fields.id || `event_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`,
      type_id: typeId,
      title: fields.title || (config ? labelFor(config, 'event_types', typeId) : humanizeKey(typeId)),
      start_at: start.toISOString(),
      end_at: end && end > start ? end.toISOString() : undefined,
      duration_minutes: duration,
      buffer_minutes: fields.bufferMinutes || fields.buffer_minutes || eventType.buffer_minutes || 0,
      role_ids: unique(fields.role_ids || eventType.role_ids || []),
      required_role_ids: unique(fields.requiredRoleIds || fields.required_role_ids || eventType.required_role_ids || eventType.role_ids || []),
      allowed_role_ids: unique(fields.allowedRoleIds || fields.allowed_role_ids || eventType.allowed_role_ids || eventType.role_ids || []),
      assigned_user_ids: unique(fields.assignedUserIds || fields.assigned_user_ids || [fields.assignedUserId, fields.assigned_user_id, assignedUser?.id]),
      assigned_users: arrayValue(fields.assignedUsers || fields.assigned_users).length
        ? arrayValue(fields.assignedUsers || fields.assigned_users)
        : (assignedUser?.id ? [{ id: assignedUser.id, name: assignedUser.name || assignedUser.email || '', role_ids: unique(fields.role_ids || eventType.role_ids || []) }] : []),
      assigned_user_name: cleanText(fields.assignedUserName || fields.assigned_user_name || assignedUser?.name || assignedUser?.email),
      assigned_crew_id: cleanText(fields.assignedCrewId || fields.assigned_crew_id || fields.crew_id),
      assigned_crew_name: cleanText(fields.assignedCrewName || fields.assigned_crew_name || fields.crew_name || fields.assignedCrew?.name || fields.assigned_crew?.name),
      assigned_crew: fields.assignedCrew || fields.assigned_crew || null,
      event_type_default_id: typeId,
      source: 'platform_scheduling',
      status: fields.status || 'scheduled',
      notes: fields.notes || '',
      availability_override: !!(fields.availability_override || fields.availabilityOverride),
      availability_snapshot: fields.availability_snapshot || fields.availabilitySnapshot || null,
      all_day: fields.all_day === true || fields.allDay === true,
      start_date: cleanText(fields.start_date || fields.startDate),
      end_date: cleanText(fields.end_date || fields.endDate),
      schedule_granularity: cleanText(fields.schedule_granularity || fields.scheduleGranularity),
      created_at: fields.created_at || nowIso(),
      updated_at: nowIso(),
    }, config, project);
  }

  function updateProjectEventRange(event, fields = {}){
    const has = (key) => Object.prototype.hasOwnProperty.call(fields || {}, key);
    const pick = (...keys) => {
      for (const key of keys) {
        if (has(key)) return fields[key];
      }
      return undefined;
    };
    const start = toDate(fields.start || fields.start_at) || eventStart(event) || new Date();
    const end = toDate(fields.end || fields.end_at) || eventEnd(event) || addMinutes(start, eventDurationMinutes(event));
    const safeEnd = end > start ? end : addMinutes(start, 60);
    const assignedCrewId = pick('assignedCrewId', 'assigned_crew_id', 'crew_id');
    const assignedCrewName = pick('assignedCrewName', 'assigned_crew_name', 'crew_name');
    const assignedCrew = pick('assignedCrew', 'assigned_crew');
    return {
      ...event,
      start_at: start.toISOString(),
      start: start.toISOString(),
      end_at: safeEnd.toISOString(),
      end: safeEnd.toISOString(),
      duration_minutes: Math.max(1, Math.round((safeEnd.getTime() - start.getTime()) / 60000)),
      all_day: fields.all_day ?? fields.allDay ?? event.all_day ?? false,
      start_date: cleanText(fields.start_date || fields.startDate || event.start_date),
      end_date: cleanText(fields.end_date || fields.endDate || event.end_date),
      schedule_granularity: cleanText(fields.schedule_granularity || fields.scheduleGranularity || event.schedule_granularity),
      assigned_crew_id: assignedCrewId !== undefined ? cleanText(assignedCrewId) : cleanText(event.assigned_crew_id || event.crew_id),
      assigned_crew_name: assignedCrewName !== undefined ? cleanText(assignedCrewName) : cleanText(event.assigned_crew_name || event.crew_name),
      assigned_crew: assignedCrew !== undefined ? assignedCrew : (event.assigned_crew || null),
      crew_id: assignedCrewId !== undefined ? cleanText(assignedCrewId) : cleanText(event.crew_id || event.assigned_crew_id),
      crew_name: assignedCrewName !== undefined ? cleanText(assignedCrewName) : cleanText(event.crew_name || event.assigned_crew_name),
      resource_id: assignedCrewId !== undefined ? cleanText(assignedCrewId) : cleanText(event.resource_id || event.assigned_crew_id || event.crew_id),
      resource_name: assignedCrewName !== undefined ? cleanText(assignedCrewName) : cleanText(event.resource_name || event.assigned_crew_name || event.crew_name),
      updated_at: nowIso(),
    };
  }

  function createProjectWorkEvent(project, fields = {}, config = null){
    const title = cleanText(fields.title) || 'Work Section';
    return createProjectEvent(project, 'project_work', {
      ...fields,
      title,
      all_day: fields.all_day ?? fields.allDay ?? true,
      schedule_granularity: fields.schedule_granularity || fields.scheduleGranularity || (fields.all_day === false || fields.allDay === false ? 'time' : 'date'),
    }, config);
  }

  function upsertProjectEvent(project, event){
    const normalizedProject = normalizeProject(project);
    const nextEvent = normalizeEvent(event, null, normalizedProject);
    const events = [...arrayValue(normalizedProject.events)];
    const idx = events.findIndex((item) => item.id === nextEvent.id);
    if (idx >= 0) events[idx] = nextEvent;
    else events.push(nextEvent);
    return { ...normalizedProject, events, updated_at: nowIso() };
  }

  async function saveProjectEvent(orgId, project, event, config = null){
    const normalizedProject = normalizeProject(project, config);
    const nextEvent = normalizeEvent(event, config, normalizedProject);
    if (PlatformAPI?.projects?.scheduleEvent) {
      const result = await PlatformAPI.projects.scheduleEvent(orgId, normalizedProject.id, nextEvent, {
        branchId: config?.branch_id || config?.branchId || 'default'
      });
      const savedProject = result?.document?.data
        ? { ...result.document.data, id: result.document.id }
        : result?.project || normalizedProject;
      return {
        event: result?.event ? normalizeEvent(result.event, config, savedProject) : nextEvent,
        project: normalizeProject(savedProject, config),
        document: result?.document || null,
        triggers: result?.triggers || null
      };
    }
    const events = arrayValue(normalizedProject.events).filter((item) => item.id !== nextEvent.id);
    events.push(nextEvent);
    const result = await PlatformAPI.documents.setField(orgId, 'projects', normalizedProject.id, 'events', events, {
      kind: 'project_events',
      updated_by: 'platform_scheduling',
    });
    const saved = result?.document?.data ? { ...result.document.data, id: result.document.id } : { ...normalizedProject, events };
    return { event: nextEvent, project: normalizeProject(saved, config), document: result?.document || null };
  }

  function ensureProjectSchedulingDefaults(project){
    const data = docData(project);
    return { ...data, id: docId(project) || data.id, events: arrayValue(data.events) };
  }

  root.PlatformScheduling = {
    MODULES,
    STANDARD_ROLES,
    DEFAULT_EVENT_TYPES,
    DEFAULT_MAPPINGS,
    humanizeKey,
    labelFor,
    loadBranchConfig,
    refreshBranchConfig(orgId, branchId){ return loadBranchConfig(orgId, branchId, { refresh: true }); },
    defaultRolesForNewAdmin,
    normalizeUser,
    userHasRole,
    normalizeEvent,
    normalizeProject,
    listUsers,
    listProjects,
    eventsFromProjects,
    availabilityWindow,
    eventStart,
    eventEnd,
    eventDurationMinutes,
    eventTypeId,
    eventIsType,
    projectEvents,
    projectSalesAppointmentEvents,
    projectWorkEvents,
    intervalsOverlap,
    availabilityForRole,
    availabilityForEventType,
    availableEventTypeTimeSlots,
    availableTimeSlots,
    createProjectEvent,
    createProjectWorkEvent,
    updateProjectEventRange,
    upsertProjectEvent,
    saveProjectEvent,
    ensureProjectSchedulingDefaults,
    localDateInput,
  };
})();
