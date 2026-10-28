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
  };

  const STANDARD_ROLES = {
    sales_appointments: { id: 'sales_appointments', fallback_label: 'Sales Appointments' },
    inside_sales: { id: 'inside_sales', fallback_label: 'Inside Sales' },
  };

  const DEFAULT_EVENT_TYPES = {
    sales_follow_up: {
      id: 'sales_follow_up',
      required_role_ids: ['sales_appointments'],
      allowed_role_ids: ['sales_appointments'],
      role_ids: ['sales_appointments'],
      duration_minutes: 30,
      slot_minutes: 30,
      buffer_minutes: 0,
      allow_unassigned: true,
      color: '#7c3aed',
      icon: 'fa-phone',
      status: 'active',
    },
    sales_appointment: {
      id: 'sales_appointment',
      required_role_ids: ['sales_appointments'],
      allowed_role_ids: ['sales_appointments'],
      role_ids: ['sales_appointments'],
      title_template: '{project} — Sales',
      duration_minutes: 60,
      slot_minutes: 30,
      buffer_minutes: 30,
      allow_unassigned: true,
      color: '#2563eb',
      status: 'active',
      assignment_policy: {
        schema_version:1,
        mode:'any',
        allow_unassigned:true,
        rules:[{ id:'salespeople', subject_types:['organization_user'], role_ids:['sales_appointments'] }],
      },
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
      assignment_policy: {
        schema_version:1,
        mode:'any',
        allow_unassigned:true,
        rules:[
          { id:'production_groups', subject_types:['resource_group'], group_kind_ids:['crew'] },
          { id:'external_work_resources', subject_types:['organization_connection'] },
          { id:'field_people', subject_types:['organization_user'], role_ids:['crew_member','repairman','crew_foreman','supervisor'] },
        ],
      },
    },
    material_delivery: {
      id: 'material_delivery',
      required_role_ids: [],
      allowed_role_ids: [],
      role_ids: [],
      duration_minutes: 60,
      slot_minutes: 30,
      buffer_minutes: 0,
      allow_unassigned: true,
      color: '#f97316',
      icon: 'fa-truck-ramp-box',
      status: 'active',
    },
    equipment_maintenance: {
      id: 'equipment_maintenance',
      duration_minutes: 8 * 60,
      slot_minutes: 30,
      buffer_minutes: 0,
      allow_unassigned: true,
      color: '#64748b',
      icon: 'fa-wrench',
      equipment_status: 'down',
      status: 'active',
    },
    equipment_booking: {
      id: 'equipment_booking',
      duration_minutes: 8 * 60,
      slot_minutes: 30,
      buffer_minutes: 0,
      allow_unassigned: true,
      color: '#2563eb',
      icon: 'fa-truck-pickup',
      equipment_status: 'in_use',
      status: 'active',
    },
    equipment_reservation: {
      id: 'equipment_reservation',
      duration_minutes: 8 * 60,
      slot_minutes: 30,
      buffer_minutes: 0,
      allow_unassigned: true,
      color: '#f59e0b',
      icon: 'fa-calendar-check',
      equipment_status: 'reserved',
      status: 'active',
    },
  };

  const DEFAULT_AVAILABILITY = {
    timezone: 'local',
    working_hours: [
      { days: [1, 2, 3, 4, 5], start: '09:00', end: '17:00' },
    ],
  };

  // Default labels are config library terminology entries (roles, event_types, ui, money and the rest);
  // PlatformTerminology adds them here when they load. An organization's variable_mappings hold overrides only.
  const DEFAULT_MAPPINGS = {
    schema_version: 1,
    labels: {},
  };

  const cache = new Map();

  function nowIso(){ return new Date().toISOString(); }
  function cleanText(value){ return String(value ?? '').trim(); }
  function arrayValue(value){ return Array.isArray(value) ? value : []; }
  function objectValue(value){ return value && typeof value === 'object' && !Array.isArray(value) ? value : {}; }
  function unique(values){ return Array.from(new Set(arrayValue(values).map(cleanText).filter(Boolean))); }
  function assignableSubjectType(value){
    const type = cleanText(value).toLowerCase();
    if (['user','person','people','organization_user'].includes(type)) return 'organization_user';
    if (['group','team','crew','resource_group'].includes(type)) return 'resource_group';
    if (['connection','subcontractor','organization_connection'].includes(type)) return 'organization_connection';
    if (['equipment','equipment_unit'].includes(type)) return 'equipment_unit';
    return '';
  }
  function normalizeAssignmentRule(value = {}, index = 0){
    const rule = objectValue(value);
    return {
      ...rule,
      id:cleanText(rule.id) || `rule_${index + 1}`,
      subject_types:unique(rule.subject_types || rule.types || [rule.subject_type || rule.type]).map(assignableSubjectType).filter(Boolean),
      subject_ids:unique(rule.subject_ids || rule.ids),
      role_ids:unique(rule.role_ids || rule.user_role_ids || rule.person_kind_ids),
      group_kind_ids:unique(rule.group_kind_ids || rule.resource_group_kind_ids),
      kind_ids:unique(rule.kind_ids),
      assignment_tag_ids:unique(rule.assignment_tag_ids || rule.tag_ids || rule.tags),
      tag_match:cleanText(rule.tag_match || rule.tag_mode).toLowerCase() === 'any' ? 'any' : 'all',
      capability_scope_ids:unique(rule.capability_scope_ids || rule.scope_template_ids || rule.scope_ids),
    };
  }
  function defaultAssignmentPolicy(eventTypeId = ''){
    const eventType = objectValue(DEFAULT_EVENT_TYPES[cleanText(eventTypeId)]);
    const configured = objectValue(eventType.assignment_policy);
    return {
      schema_version:1,
      mode:'any',
      allow_unassigned:configured.allow_unassigned !== false,
      rules:arrayValue(configured.rules).map(normalizeAssignmentRule),
    };
  }
  function normalizeAssignmentPolicy(value = {}, options = {}){
    const input = objectValue(value);
    const hasExplicitRules = Object.prototype.hasOwnProperty.call(input, 'rules')
      || Object.prototype.hasOwnProperty.call(input, 'any_of')
      || Object.prototype.hasOwnProperty.call(input, 'allow');
    let rules = arrayValue(input.rules || input.any_of || input.allow).map(normalizeAssignmentRule);
    if (!rules.length && !hasExplicitRules) {
      const legacyRoles = unique(options.legacyRoleIds);
      rules = legacyRoles.length
        ? [normalizeAssignmentRule({ id:'legacy_user_roles', subject_types:['organization_user'], role_ids:legacyRoles })]
        : defaultAssignmentPolicy(options.eventTypeId).rules;
    }
    const explicitAllow = input.allow_unassigned ?? input.allowUnassigned ?? options.allowUnassigned;
    return {
      schema_version:1,
      mode:'any',
      allow_unassigned:explicitAllow === undefined ? defaultAssignmentPolicy(options.eventTypeId).allow_unassigned : explicitAllow === true,
      rules,
    };
  }
  function assignmentPolicyForEventType(eventType = {}, eventTypeId = ''){
    const type = objectValue(eventType);
    return normalizeAssignmentPolicy(type.assignment_policy || type.assignable_policy || type.assignability, {
      eventTypeId:eventTypeId || type.id,
      legacyRoleIds:type.required_role_ids || type.allowed_role_ids || type.role_ids,
      allowUnassigned:type.allow_unassigned,
    });
  }
  function normalizeAssignableSubject(value = {}){
    const input = objectValue(value);
    const user = objectValue(input.user);
    const subject_type = assignableSubjectType(input.subject_type || input.resource_kind || input.kind || (user.id ? 'organization_user' : ''));
    const role_ids = unique(input.role_ids || input.access_role_ids || user.role_ids || user.access_role_ids || user.roles || input.roles);
    const group_kind_id = cleanText(input.group_kind_id || input.kind_id);
    return {
      ...input,
      subject_type,
      id:cleanText(input.id || input.resource_id || objectValue(input.work_resource_ref).id),
      role_ids,
      group_kind_id,
      kind_ids:unique([...arrayValue(input.kind_ids), ...role_ids, ...(group_kind_id ? [group_kind_id] : [])]),
      assignment_tag_ids:unique(input.assignment_tag_ids || input.tag_ids || input.tags),
      capability_scope_ids:unique(input.capability_scope_ids || input.scope_template_ids || input.project_types),
    };
  }
  function assignableMatchesRule(subjectValue = {}, ruleValue = {}){
    const subject = normalizeAssignableSubject(subjectValue);
    const rule = normalizeAssignmentRule(ruleValue);
    if (!subject.subject_type || !subject.id) return false;
    const mappedExternal = subject.subject_type === 'organization_connection' && subject.external_assignment === true;
    const mappedKinds = Array.isArray(subject.mapped_group_kind_ids) ? subject.mapped_group_kind_ids : [];
    if (rule.subject_types.length && !rule.subject_types.includes(subject.subject_type) && !(mappedExternal && rule.subject_types.includes('resource_group') && rule.group_kind_ids.some(id => mappedKinds.includes(id)))) return false;
    if (rule.subject_ids.length && !rule.subject_ids.includes(subject.id)) return false;
    if (rule.role_ids.length && (subject.subject_type !== 'organization_user' || !rule.role_ids.some((id) => subject.role_ids.includes(id)))) return false;
    if (rule.group_kind_ids.length && (mappedExternal ? !rule.group_kind_ids.some(id => mappedKinds.includes(id)) : subject.subject_type !== 'resource_group' || !rule.group_kind_ids.includes(subject.group_kind_id))) return false;
    if (rule.kind_ids.length && !rule.kind_ids.some((id) => subject.kind_ids.includes(id))) return false;
    if (rule.assignment_tag_ids.length) {
      const hits = rule.assignment_tag_ids.map((id) => subject.assignment_tag_ids.includes(id));
      if (rule.tag_match === 'any' ? !hits.some(Boolean) : !hits.every(Boolean)) return false;
    }
    if (rule.capability_scope_ids.length && !rule.capability_scope_ids.every((id) => subject.capability_scope_ids.includes(id))) return false;
    return true;
  }
  function filterAssignableSubjects(subjects = [], policyValue = {}){
    const policy = normalizeAssignmentPolicy(policyValue);
    return arrayValue(subjects).map(normalizeAssignableSubject)
      .filter((subject) => {
        const kinds=policy.rules.flatMap(rule=>rule.group_kind_ids);
        if(subject.external_assignment===true && kinds.length && !(subject.mapped_group_kind_ids||[]).some(id=>kinds.includes(id)))return false;
        return !policy.rules.length || policy.rules.some(rule=>assignableMatchesRule(subject,rule));
      });
  }

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

  function addBusinessDays(dateValue, amount){
    const date = new Date(dateValue);
    const direction = Number(amount) < 0 ? -1 : 1;
    let remaining = Math.abs(Math.trunc(Number(amount) || 0));
    while (remaining > 0) {
      date.setDate(date.getDate() + direction);
      if (![0, 6].includes(date.getDay())) remaining -= 1;
    }
    return date;
  }

  function projectScheduleMeasurements(project = {}, event = {}){
    const scope = objectValue(project.scope);
    const pieceId = cleanText(event.scope_piece_id);
    const piece = arrayValue(scope.pieces).find((item) => cleanText(item.id) === pieceId);
    return {
      ...objectValue(scope.measurements),
      ...objectValue(project.measurements),
      ...objectValue(piece?.measurements)
    };
  }

  /* ── Calendar arithmetic shared by placement and dependency cascades ───────
   * Whole-day items move by local calendar days (DST-safe) and always start at
   * midnight; timed items keep a time of day (their own, or the workday start)
   * so a linked item never lands at 00:00 just because its predecessor ended
   * at midnight. */
  const FIXED_EVENT_STATUSES = ['completed', 'complete', 'done'];

  function localDayStart(value){
    const date = new Date(value);
    date.setHours(0, 0, 0, 0);
    return date;
  }

  function addLocalDays(value, days){
    const date = new Date(value);
    date.setDate(date.getDate() + Math.round(Number(days) || 0));
    return date;
  }

  function atLocalMinute(dayValue, minute){
    const date = localDayStart(dayValue);
    const value = Math.max(0, Math.min(24 * 60 - 1, Math.round(Number(minute) || 0)));
    date.setHours(Math.floor(value / 60), value % 60, 0, 0);
    return date;
  }

  function isLocalMidnight(value){
    const date = toDate(value);
    return !!date && date.getHours() === 0 && date.getMinutes() === 0 && date.getSeconds() === 0 && date.getMilliseconds() === 0;
  }

  function minuteOfDay(date){
    return date.getHours() * 60 + date.getMinutes();
  }

  function eventIsAllDay(event = {}){
    if (event.all_day === true || event.allDay === true) return true;
    if (event.all_day === false || event.allDay === false) return false;
    const granularity = cleanText(event.schedule_granularity || event.scheduleGranularity).toLowerCase();
    if (granularity === 'date') return true;
    if (granularity === 'time') return false;
    const start = eventStart(event);
    const end = start ? eventEnd(event) : null;
    return !!(start && end && end > start && isLocalMidnight(start) && isLocalMidnight(end));
  }

  // Locked or finished work never moves as a side effect of another change.
  function eventIsFixed(event = {}){
    return eventIsLocked(event) || FIXED_EVENT_STATUSES.includes(cleanText(event.status).toLowerCase());
  }

  function workdayMinutes(options = {}, date = new Date()){
    const hours = availabilityWindow(options.config || null, localDateInput(toDate(date) || new Date()), 'project_work');
    const start = options.workdayStartMinute != null && Number.isFinite(Number(options.workdayStartMinute)) ? Number(options.workdayStartMinute) : minutesFromTime(hours.start);
    const end = options.workdayEndMinute != null && Number.isFinite(Number(options.workdayEndMinute)) ? Number(options.workdayEndMinute) : minutesFromTime(hours.end);
    return { start, end:end > start ? end : 24 * 60 };
  }

  // How long an item runs, whether it occupies whole days, and its time of day.
  function scheduleItemSpan(event = {}, range = null){
    const allDay = eventIsAllDay(event);
    const start = range?.start ? toDate(range.start) : eventStart(event);
    const end = range?.end ? toDate(range.end) : (start ? eventEnd(event) : null);
    const minutes = start && end && end > start
      ? Math.round((end.getTime() - start.getTime()) / 60000)
      : Math.max(1, Number(event.duration_minutes || event.duration || 60));
    if (allDay) {
      const days = Math.max(1, Math.round(minutes / 1440));
      return { allDay:true, days, minutes:days * 1440, timeOfDay:null };
    }
    return { allDay:false, days:minutes / 1440, minutes:Math.max(1, minutes), timeOfDay:start ? minuteOfDay(start) : null };
  }

  function spanEnd(start, span){
    return span.allDay ? addLocalDays(start, span.days) : new Date(start.getTime() + span.minutes * 60000);
  }

  // Earliest start at or after `base` that suits the item: whole days begin at
  // the next midnight, timed items keep their time of day (next day when it
  // has already passed) or begin inside the workday.
  function alignStartOnOrAfter(base, span, options = {}){
    const at = toDate(base);
    if (!at) return null;
    if (span.allDay) {
      const day = localDayStart(at);
      return day.getTime() < at.getTime() ? addLocalDays(day, 1) : day;
    }
    if (Number.isFinite(span.timeOfDay)) {
      const sameDay = atLocalMinute(at, span.timeOfDay);
      return sameDay.getTime() >= at.getTime() ? sameDay : atLocalMinute(addLocalDays(at, 1), span.timeOfDay);
    }
    const hours = workdayMinutes(options, at);
    const minute = minuteOfDay(at);
    if (minute < hours.start) return atLocalMinute(at, hours.start);
    if (minute + Math.min(span.minutes, hours.end - hours.start) > hours.end) return atLocalMinute(addLocalDays(at, 1), hours.start);
    return at;
  }

  // Latest start whose finish is at or before `limit` (mirror of the above).
  function alignStartEndingBy(limit, span, options = {}){
    const at = toDate(limit);
    if (!at) return null;
    if (span.allDay) return addLocalDays(localDayStart(at), -span.days);
    const latest = new Date(at.getTime() - span.minutes * 60000);
    if (Number.isFinite(span.timeOfDay)) {
      const sameDay = atLocalMinute(latest, span.timeOfDay);
      return sameDay.getTime() <= latest.getTime() ? sameDay : atLocalMinute(addLocalDays(latest, -1), span.timeOfDay);
    }
    const hours = workdayMinutes(options, latest);
    const minute = minuteOfDay(latest);
    const lastStart = Math.max(hours.start, hours.end - span.minutes);
    if (minute >= hours.start && minute <= lastStart) return latest;
    if (minute < hours.start) return atLocalMinute(addLocalDays(latest, -1), lastStart);
    return atLocalMinute(latest, lastStart);
  }

  function dependencyEarliestStart(edge = {}, predecessorRange = {}, span = {}, options = {}){
    const predStart = toDate(predecessorRange?.start);
    if (!predStart) return null;
    const predEnd = toDate(predecessorRange?.end) || predStart;
    const lag = (Number(edge.lag_minutes) || 0) * 60000;
    const base = edge.type === 'start_to_start' ? predStart.getTime() + lag
      : edge.type === 'finish_to_finish' ? predEnd.getTime() + lag - span.minutes * 60000
        : predEnd.getTime() + lag;
    return alignStartOnOrAfter(new Date(base), span, options);
  }

  function dependencyLatestStart(edge = {}, successorRange = {}, span = {}, options = {}){
    const succStart = toDate(successorRange?.start);
    if (!succStart) return null;
    const succEnd = toDate(successorRange?.end) || succStart;
    const lag = (Number(edge.lag_minutes) || 0) * 60000;
    const limit = edge.type === 'start_to_start' ? succStart.getTime() - lag + span.minutes * 60000
      : edge.type === 'finish_to_finish' ? succEnd.getTime() - lag
        : succStart.getTime() - lag;
    return alignStartEndingBy(new Date(limit), span, options);
  }

  // Dependency order (predecessors first); ties and cycles keep input order.
  function orderByDependencies(events = []){
    const list = arrayValue(events);
    const ids = list.map((event) => cleanText(event?.id));
    const index = new Map();
    ids.forEach((id, position) => { if (id && !index.has(id)) index.set(id, position); });
    const indegree = new Map(ids.map((id) => [id, 0]));
    const next = new Map();
    list.forEach((event) => {
      const id = cleanText(event?.id);
      new Set(eventDependencies(event).map((dep) => dep.event_id)).forEach((from) => {
        if (!index.has(from) || from === id) return;
        indegree.set(id, (indegree.get(id) || 0) + 1);
        if (!next.has(from)) next.set(from, []);
        next.get(from).push(id);
      });
    });
    const ready = ids.filter((id) => !indegree.get(id));
    const ordered = [];
    const seen = new Set();
    while (ready.length) {
      ready.sort((a, b) => (index.get(a) ?? 0) - (index.get(b) ?? 0));
      const id = ready.shift();
      if (seen.has(id)) continue;
      seen.add(id);
      ordered.push(id);
      arrayValue(next.get(id)).forEach((to) => {
        indegree.set(to, (indegree.get(to) || 0) - 1);
        if (indegree.get(to) === 0) ready.push(to);
      });
    }
    ids.forEach((id) => { if (!seen.has(id)) { seen.add(id); ordered.push(id); } });
    return ordered.map((id) => list[index.get(id)]).filter(Boolean);
  }

  const DEPENDENCY_TYPES = ['finish_to_start', 'start_to_start', 'finish_to_finish'];

  function normalizeDependency(value = {}, index = 0){
    if (typeof value === 'string') return { id:`dep_${index + 1}`, event_id:cleanText(value), type:'finish_to_start', lag_minutes:0 };
    const input = objectValue(value);
    const type = cleanText(input.type || input.kind).toLowerCase().replace(/-/g, '_');
    return {
      id:cleanText(input.id) || `dep_${index + 1}`,
      event_id:cleanText(input.event_id || input.eventId || input.predecessor_id || input.predecessorId),
      type:DEPENDENCY_TYPES.includes(type) ? type : 'finish_to_start',
      lag_minutes:Math.round(Number(input.lag_minutes ?? input.lagMinutes ?? (Number(input.lag_days || 0) * 1440)) || 0),
    };
  }

  function eventDependencies(event = {}){
    const raw = arrayValue(event.depends_on || event.dependsOn || objectValue(event.metadata).depends_on);
    return raw.map(normalizeDependency).filter((dep) => dep.event_id);
  }

  /* ── Parents and children ─────────────────────────────────────────────────
   * Browser twin of public/v1/scheduling/event-model.ts and placement.ts; the
   * contract is docs/architecture/schedule-events.md. An event names its
   * parent with parent_event_id and stores a placement relative to it. A span
   * is an event of kind 'schedule_group' holding its own stored range. The
   * server places children when a parent is saved and returns the result;
   * the functions here preview that while dragging, in the browser's local
   * calendar days. */
  function eventParentId(event = {}){
    return cleanText(objectValue(event).parent_event_id);
  }

  function eventIsSpan(event = {}){
    return cleanText(objectValue(event).kind).toLowerCase() === 'schedule_group';
  }

  function eventChildren(events = [], parentId = ''){
    const id = cleanText(parentId);
    return !id ? [] : arrayValue(events).filter((event) => eventParentId(event) === id);
  }

  // Every event under this one, nearest first. Safe against a stored cycle.
  function eventDescendants(events = [], rootId = ''){
    const list = arrayValue(events);
    const found = [];
    const seen = new Set([cleanText(rootId)]);
    const queue = [cleanText(rootId)];
    while (queue.length) {
      eventChildren(list, queue.shift()).forEach((child) => {
        const id = cleanText(child.id);
        if (!id || seen.has(id)) return;
        seen.add(id);
        found.push(child);
        queue.push(id);
      });
    }
    return found;
  }

  // Ids of the events above this one, nearest first.
  function eventAncestorIds(events = [], event = {}){
    const byId = new Map(arrayValue(events).map((item) => [cleanText(item?.id), item]));
    const selfId = cleanText(objectValue(event).id);
    const ids = [];
    let parentId = eventParentId(event);
    while (parentId && !ids.includes(parentId) && parentId !== selfId) {
      ids.push(parentId);
      parentId = eventParentId(byId.get(parentId));
    }
    return ids;
  }

  // The ids an event never conflicts with: itself, everything above it and
  // everything under it.
  function eventFamilyIds(events = [], event = {}){
    const id = cleanText(objectValue(event).id);
    return new Set([id, ...eventAncestorIds(events, event), ...eventDescendants(events, id).map((item) => cleanText(item.id))].filter(Boolean));
  }

  // The range an event holds on the calendar, or null when it holds none.
  function eventWindow(event = {}){
    const value = objectValue(event);
    if (['unscheduled', 'canceled', 'cancelled'].includes(cleanText(value.status).toLowerCase())) return null;
    const start = eventStart(value);
    if (!start) return null;
    const explicitEnd = toDate(value.end_at || value.end);
    const end = explicitEnd && explicitEnd > start ? explicitEnd : addMinutes(start, Math.max(1, Number(value.duration_minutes || 60)));
    return { start, end };
  }

  const PLACEMENT_UNITS = ['minute', 'hour', 'day', 'business_day', 'week'];

  function normalizePlacementAmount(value){
    if (typeof value === 'number') return Number.isFinite(value) ? { value, unit:'day' } : undefined;
    const input = objectValue(value);
    if (!Object.keys(input).length) return undefined;
    const unit = cleanText(input.unit || 'day').toLowerCase().replace(/s$/, '');
    const adjust = objectValue(input.adjust);
    const amount = { unit:PLACEMENT_UNITS.includes(unit) ? unit : 'day' };
    if (input.expression !== undefined && input.expression !== null) amount.expression = input.expression;
    else amount.value = Number.isFinite(Number(input.value)) ? Number(input.value) : 0;
    if (cleanText(adjust.calendar).toLowerCase().replace(/s$/, '') === 'business_day') {
      amount.adjust = { calendar:'business_day', direction:cleanText(adjust.direction).toLowerCase() === 'next' ? 'next' : 'previous' };
    }
    return amount;
  }

  // A stored or template placement in its one shape, or null when there is none.
  function normalizePlacement(value){
    const input = objectValue(value);
    if (!Object.keys(input).length) return null;
    const anchor = cleanText(input.anchor).toLowerCase();
    const placement = { anchor:anchor === 'end' ? 'end' : anchor === 'span' ? 'span' : 'start' };
    if (placement.anchor !== 'span') {
      const offset = normalizePlacementAmount(input.offset);
      if (offset) placement.offset = offset;
      const duration = normalizePlacementAmount(input.duration);
      if (duration) placement.duration = duration;
    }
    if (input.all_day === true || input.all_day === false) placement.all_day = input.all_day;
    if (input.manual === true) placement.manual = true;
    return placement;
  }

  function readPlacementPath(source, path){
    return cleanText(path).split('.').filter(Boolean).reduce((value, key) => value == null ? undefined : value[key], source);
  }

  // Arithmetic over numbers and { ref } paths (parent.duration.days,
  // parent.duration.minutes, measurements.<key>). Anything unreadable is zero.
  function evaluatePlacementExpression(expression, context = {}){
    if (typeof expression === 'number') return Number.isFinite(expression) ? expression : 0;
    if (typeof expression === 'string') {
      const numeric = Number(expression);
      return Number.isFinite(numeric) ? numeric : Number(readPlacementPath(context, expression) || 0) || 0;
    }
    const rule = objectValue(expression);
    if (rule.ref) return Number(readPlacementPath(context, rule.ref) ?? rule.fallback ?? 0) || 0;
    const operator = cleanText(rule.operator).toLowerCase();
    if (!operator) return rule.value === undefined ? 0 : evaluatePlacementExpression(rule.value, context);
    const operands = Array.isArray(rule.operands)
      ? rule.operands.map((entry) => evaluatePlacementExpression(entry, context))
      : [evaluatePlacementExpression(rule.left ?? rule.value ?? 0, context), evaluatePlacementExpression(rule.right ?? 0, context)];
    const left = operands[0] ?? 0;
    const right = operands[1] ?? 0;
    if (operator === 'add') return operands.reduce((sum, value) => sum + value, 0);
    if (operator === 'subtract') return left - right;
    if (operator === 'multiply') return operands.reduce((product, value) => product * value, 1);
    if (operator === 'divide') return right === 0 ? 0 : left / right;
    if (operator === 'floor') return Math.floor(left);
    if (operator === 'ceil') return Math.ceil(left);
    if (operator === 'round') return Math.round(left);
    if (operator === 'min') return Math.min(...operands);
    if (operator === 'max') return Math.max(...operands);
    if (operator === 'coalesce') return operands.find((value) => Number.isFinite(value) && value !== 0) ?? 0;
    return 0;
  }

  // Whole local days between two instants' dates.
  function localDayDifference(from, to){
    const a = new Date(from);
    const b = new Date(to);
    return Math.round((Date.UTC(b.getFullYear(), b.getMonth(), b.getDate()) - Date.UTC(a.getFullYear(), a.getMonth(), a.getDate())) / 86400000);
  }

  function placementAmountValue(amount, context){
    return amount.expression !== undefined ? evaluatePlacementExpression(amount.expression, context) : Number(amount.value || 0);
  }

  function applyPlacementAmount(base, amount, context){
    if (!amount) return new Date(base);
    const value = placementAmountValue(amount, context);
    let result;
    if (amount.unit === 'minute') result = new Date(base.getTime() + value * 60000);
    else if (amount.unit === 'hour') result = new Date(base.getTime() + value * 3600000);
    else if (amount.unit === 'business_day') result = addBusinessDays(base, value);
    else {
      const days = amount.unit === 'week' ? value * 7 : value;
      // Whole days keep the local time of day across a clock change; a
      // fraction of a day is plain elapsed time.
      result = Number.isInteger(days) ? addLocalDays(base, days) : new Date(base.getTime() + days * 86400000);
    }
    if (amount.adjust) {
      const direction = amount.adjust.direction === 'next' ? 1 : -1;
      while ([0, 6].includes(result.getDay())) result.setDate(result.getDate() + direction);
    }
    return result;
  }

  function placementAmountMinutes(amount, context){
    const perUnit = amount.unit === 'minute' ? 1 : amount.unit === 'hour' ? 60 : amount.unit === 'week' ? 7 * 1440 : 1440;
    return placementAmountValue(amount, context) * perUnit;
  }

  /* The range a child holds for a given parent range -> { start, end, all_day }
   * (Dates), or null without a placement or a parent range. `child` supplies
   * the length to keep when the placement names none; options.measurements
   * feeds `measurements.<key>` refs. */
  function evaluatePlacement(placementValue, parentRange = {}, child = {}, options = {}){
    const placement = normalizePlacement(placementValue);
    const parentStart = toDate(parentRange?.start);
    const parentEnd = toDate(parentRange?.end);
    if (!placement || !parentStart || !parentEnd) return null;
    const childEvent = objectValue(child);
    const parentMinutes = Math.max(1, Math.round((parentEnd.getTime() - parentStart.getTime()) / 60000));
    const context = {
      parent:{ duration:{ minutes:parentMinutes, days:Math.max(1, localDayDifference(parentStart, parentEnd) || Math.round(parentMinutes / 1440)) } },
      measurements:objectValue(options?.measurements),
    };
    const allDay = placement.all_day ?? childEvent.all_day === true;
    if (placement.anchor === 'span') return { start:new Date(parentStart), end:new Date(parentEnd), all_day:allDay };
    let start = applyPlacementAmount(placement.anchor === 'end' ? parentEnd : parentStart, placement.offset, context);
    const current = eventWindow({ ...childEvent, status:'scheduled' });
    const keptMinutes = current
      ? Math.round((current.end.getTime() - current.start.getTime()) / 60000)
      : Math.max(1, Number(childEvent.duration_minutes || (allDay ? 1440 : 60)));
    const minutes = Math.max(1, placement.duration ? placementAmountMinutes(placement.duration, context) : keptMinutes);
    if (allDay) {
      start = localDayStart(start);
      return { start, end:addLocalDays(start, Math.max(1, Math.round(minutes / 1440))), all_day:true };
    }
    return { start, end:new Date(start.getTime() + Math.round(minutes) * 60000), all_day:false };
  }

  // The placement that keeps a child exactly where it now is, as a fixed
  // distance from its parent's start. childRange: { start, end, all_day }.
  function manualPlacement(childRange = {}, parentRange = {}){
    const childStart = toDate(childRange?.start);
    const childEnd = toDate(childRange?.end);
    const parentStart = toDate(parentRange?.start);
    if (!childStart || !childEnd || !parentStart) return null;
    if (childRange.all_day) {
      return {
        anchor:'start',
        offset:{ value:localDayDifference(parentStart, childStart), unit:'day' },
        duration:{ value:Math.max(1, localDayDifference(childStart, childEnd)), unit:'day' },
        all_day:true,
        manual:true,
      };
    }
    return {
      anchor:'start',
      offset:{ value:Math.round((childStart.getTime() - parentStart.getTime()) / 60000), unit:'minute' },
      duration:{ value:Math.max(1, Math.round((childEnd.getTime() - childStart.getTime()) / 60000)), unit:'minute' },
      all_day:false,
      manual:true,
    };
  }

  /* Re-places everything under one parent after that parent's range changed.
   * `events` is the project's events with the parent already in its new
   * state. -> { updated, blocked }: `updated` are drafts of the children whose
   * range or status changed (theirs too, nested); `blocked` are locked or
   * finished children that should have moved and did not. A child without a
   * placement is left alone, as are its own children. These are previews: the
   * server re-places children itself when the parent is saved, so the drafts
   * are not saved one by one. options: { measurements }. */
  function placeChildren(events = [], parentId = '', options = {}){
    const working = arrayValue(events).map((event) => ({ ...objectValue(event) }));
    const byId = new Map(working.map((event) => [cleanText(event.id), event]));
    const updated = [];
    const blocked = [];
    const rootId = cleanText(parentId);
    const seen = new Set([rootId]);
    const queue = [rootId];
    while (queue.length) {
      const parent = byId.get(queue.shift());
      if (!parent) continue;
      const parentWindow = eventWindow(parent);
      eventChildren(working, parent.id).forEach((child) => {
        const id = cleanText(child.id);
        if (!id || seen.has(id)) return;
        seen.add(id);
        const placement = normalizePlacement(child.placement);
        if (!placement) return;
        const current = eventWindow(child);
        const target = parentWindow ? evaluatePlacement(placement, parentWindow, child, options) : null;
        const unchanged = target
          ? !!current && current.start.getTime() === target.start.getTime() && current.end.getTime() === target.end.getTime()
          : !current;
        if (unchanged) { queue.push(id); return; }
        if (eventIsFixed(child)) { blocked.push(child); return; }
        if (target) {
          const status = cleanText(child.status).toLowerCase();
          Object.assign(child, updateProjectEventRange(child, {
            start:target.start,
            end:target.end,
            all_day:target.all_day,
            schedule_granularity:target.all_day ? 'date' : 'time',
          }), { status:!status || status === 'unscheduled' ? 'scheduled' : child.status });
        } else {
          Object.assign(child, { status:'unscheduled', start_at:'', start:'', end_at:'', end:'', start_date:'', end_date:'', updated_at:nowIso() });
        }
        updated.push(child);
        queue.push(id);
      });
    }
    return { updated, blocked };
  }

  function scheduleGraph(events = []){
    const list = arrayValue(events);
    const byId = new Map(list.map((event) => [cleanText(event.id), event]));
    const edges = [];
    list.forEach((event) => {
      eventDependencies(event).forEach((dep) => {
        if (byId.has(dep.event_id)) edges.push({ from:dep.event_id, to:cleanText(event.id), type:dep.type, lag_minutes:dep.lag_minutes });
      });
    });
    const dependentsOf = new Map();
    edges.forEach((edge) => {
      if (!dependentsOf.has(edge.from)) dependentsOf.set(edge.from, []);
      dependentsOf.get(edge.from).push(edge);
    });
    return { byId, edges, dependentsOf };
  }

  /* Works out what moving one item does to its depends_on neighbours.
   * Successors are pushed later only when the new range violates their link
   * (items with slack stay put — nothing is pulled earlier); predecessors are
   * pulled earlier only when the moved item now starts before they allow.
   * Whole-day items land on day boundaries and timed items keep their time
   * of day. Locked or completed items are never moved: they are reported in
   * `blocked` so the caller can warn. Cycle-safe. */
  function dependencyRescheduleImpact(events = [], movedEventId = '', nextRange = {}, options = {}){
    const movedId = cleanText(movedEventId);
    const graph = scheduleGraph(events);
    const moved = graph.byId.get(movedId);
    const movedStart = toDate(nextRange?.start);
    if (!moved || !movedStart) return { drafts:[], blocked:[] };
    const requestedEnd = toDate(nextRange?.end);
    const movedEnd = requestedEnd && requestedEnd > movedStart ? requestedEnd : new Date(movedStart.getTime() + eventDurationMinutes(moved) * 60000);
    const predecessorsOf = new Map();
    graph.edges.forEach((edge) => {
      if (!predecessorsOf.has(edge.to)) predecessorsOf.set(edge.to, []);
      predecessorsOf.get(edge.to).push(edge);
    });
    const ranges = new Map([[movedId, { start:movedStart, end:movedEnd }]]);
    const rangeOf = (id) => {
      if (ranges.has(id)) return ranges.get(id);
      const event = graph.byId.get(id);
      const start = event && eventIsScheduled(event) ? eventStart(event) : null;
      return start ? { start, end:eventEnd(event) || start } : null;
    };
    const drafts = new Map();
    const blocked = new Map();
    const block = (event, related, dependency, direction) => {
      const id = cleanText(event.id);
      if (!blocked.has(id)) blocked.set(id, { event, related, dependency, direction, reason:eventIsLocked(event) ? 'locked' : 'completed' });
    };
    const place = (event, start, span) => {
      const id = cleanText(event.id);
      const end = spanEnd(start, span);
      ranges.set(id, { start, end });
      drafts.set(id, updateProjectEventRange(event, { start, end }));
    };
    const budget = Math.max(8, graph.edges.length * 4);
    let steps = 0;
    const forward = [movedId];
    while (forward.length && steps++ < budget) {
      const currentId = forward.shift();
      const currentRange = rangeOf(currentId);
      if (!currentRange) continue;
      arrayValue(graph.dependentsOf.get(currentId)).forEach((edge) => {
        if (edge.to === movedId) return;
        const dependent = graph.byId.get(edge.to);
        const dependentRange = rangeOf(edge.to);
        if (!dependent || !dependentRange) return;
        const span = scheduleItemSpan(dependent, dependentRange);
        const earliest = dependencyEarliestStart(edge, currentRange, span, options);
        if (!earliest || dependentRange.start.getTime() >= earliest.getTime()) return;
        if (eventIsFixed(dependent)) { block(dependent, graph.byId.get(currentId), edge, 'successor'); return; }
        place(dependent, earliest, span);
        forward.push(edge.to);
      });
    }
    steps = 0;
    const backward = [movedId];
    while (backward.length && steps++ < budget) {
      const currentId = backward.shift();
      const currentRange = rangeOf(currentId);
      if (!currentRange) continue;
      arrayValue(predecessorsOf.get(currentId)).forEach((edge) => {
        if (edge.from === movedId || drafts.has(edge.from)) return;
        const predecessor = graph.byId.get(edge.from);
        const predecessorRange = rangeOf(edge.from);
        if (!predecessor || !predecessorRange) return;
        const span = scheduleItemSpan(predecessor, predecessorRange);
        const latest = dependencyLatestStart(edge, currentRange, span, options);
        if (!latest || predecessorRange.start.getTime() <= latest.getTime()) return;
        if (eventIsFixed(predecessor)) { block(predecessor, graph.byId.get(currentId), edge, 'predecessor'); return; }
        place(predecessor, latest, span);
        backward.push(edge.from);
      });
    }
    const sortByStart = (a, b) => (eventStart(a)?.getTime() || 0) - (eventStart(b)?.getTime() || 0);
    return { drafts:Array.from(drafts.values()).sort(sortByStart), blocked:Array.from(blocked.values()) };
  }

  // Drafts for every linked item a move displaces (see dependencyRescheduleImpact).
  function cascadeDependentDrafts(events = [], movedEventId = '', nextRange = {}, options = {}){
    return dependencyRescheduleImpact(events, movedEventId, nextRange, options).drafts;
  }

  // Links whose successor currently starts before its predecessor allows.
  function dependencyViolations(events = [], options = {}){
    const graph = scheduleGraph(events);
    return graph.edges.map((edge) => {
      const from = graph.byId.get(edge.from);
      const to = graph.byId.get(edge.to);
      if (!eventIsScheduled(from) || !eventIsScheduled(to)) return null;
      const toRange = { start:eventStart(to), end:eventEnd(to) };
      const earliest = dependencyEarliestStart(edge, { start:eventStart(from), end:eventEnd(from) }, scheduleItemSpan(to, toRange), options);
      return earliest && toRange.start.getTime() < earliest.getTime()
        ? { ...edge, earliest_start:earliest.toISOString() }
        : null;
    }).filter(Boolean);
  }

  /* Everything a move of one project item implies for its related items: its
   * children (and theirs) placed against the new range, plus the depends_on
   * links of the item and of every re-placed child, in both directions.
   * -> { drafts, blocked, children, dependents }. `children` are previews of
   * what the server does when the moved item is saved; `dependents` are the
   * linked items the caller saves itself; `drafts` is both. `blocked` lists
   * locked or finished items that are now out of place (never moved) as
   * { event, related, dependency, direction, reason }, with direction 'child'
   * for a child that could not follow its parent.
   * options: { measurements } plus the dependency cascade's workday options. */
  function relatedScheduleRescheduleImpact(primaryEvent = {}, projectEvents = [], nextRange = {}, project = {}, options = {}){
    const empty = { drafts:[], blocked:[], children:[], dependents:[] };
    const nextStart = toDate(nextRange?.start);
    if (!nextStart) return empty;
    const primaryId = cleanText(primaryEvent.id);
    const list = arrayValue(projectEvents);
    const stored = list.find((event) => cleanText(event.id) === primaryId) || primaryEvent;
    const primaryStatus = cleanText(stored.status).toLowerCase();
    const requestedEnd = toDate(nextRange?.end);
    const moved = {
      ...updateProjectEventRange(stored, {
        start:nextStart,
        end:requestedEnd && requestedEnd > nextStart ? requestedEnd : addMinutes(nextStart, eventDurationMinutes(stored)),
        ...(nextRange.all_day === true || nextRange.all_day === false ? { all_day:nextRange.all_day } : {}),
      }),
      status:!primaryStatus || primaryStatus === 'unscheduled' ? 'scheduled' : stored.status,
    };
    let effective = list.some((event) => cleanText(event.id) === primaryId)
      ? list.map((event) => cleanText(event.id) === primaryId ? moved : event)
      : [...list, moved];
    const placed = placeChildren(effective, primaryId, {
      measurements:options?.measurements || projectScheduleMeasurements(project, primaryEvent),
    });
    const children = placed.updated.map((child) => ({ ...child, __placed_child:true }));
    const childById = new Map(children.map((child) => [cleanText(child.id), child]));
    effective = effective.map((event) => childById.get(cleanText(event.id)) || event);
    const blocked = new Map(placed.blocked.map((child) => [cleanText(child.id), {
      event:child,
      related:effective.find((event) => cleanText(event.id) === eventParentId(child)) || moved,
      dependency:null,
      direction:'child',
      reason:eventIsLocked(child) ? 'locked' : 'completed',
    }]));
    const settled = new Set([primaryId, ...childById.keys()]);
    const dependents = new Map();
    [moved, ...children].forEach((source) => {
      const range = eventWindow(source);
      if (!range) return;
      const impact = dependencyRescheduleImpact(effective, source.id, range, options);
      impact.drafts.forEach((draft) => {
        const id = cleanText(draft.id);
        if (settled.has(id)) return;
        dependents.set(id, draft);
        effective = effective.map((event) => cleanText(event.id) === id ? draft : event);
      });
      impact.blocked.forEach((entry) => {
        const id = cleanText(entry.event?.id);
        if (!blocked.has(id) && !settled.has(id)) blocked.set(id, entry);
      });
    });
    const dependentDrafts = Array.from(dependents.values());
    return { drafts:[...children, ...dependentDrafts], blocked:Array.from(blocked.values()), children, dependents:dependentDrafts };
  }

  function relatedScheduleRescheduleDrafts(primaryEvent = {}, projectEvents = [], nextRange = {}, project = {}, options = {}){
    return relatedScheduleRescheduleImpact(primaryEvent, projectEvents, nextRange, project, options).drafts;
  }

  // A span: an event that holds the range its children are placed against.
  function createScheduleGroupEvent(project, fields = {}, config = null){
    const event = createProjectEvent(project, cleanText(fields.event_type_default_id) || 'project_work', {
      ...fields,
      title:cleanText(fields.title) || 'Work Group',
      all_day:fields.all_day ?? true,
      status:fields.status || 'unscheduled',
    }, config);
    return { ...event, kind:'schedule_group' };
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
        assignment_policy:assignmentPolicyForEventType({
          ...objectValue(DEFAULT_EVENT_TYPES[id]),
          ...objectValue(eventType),
        }, id),
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
    const defaultLabels = objectValue(DEFAULT_MAPPINGS.labels);
    const inputLabels = objectValue(data.labels);
    return {
      ...DEFAULT_MAPPINGS,
      ...data,
      labels: Object.fromEntries(Object.entries({ ...defaultLabels, ...inputLabels }).map(([namespace, labels]) => [
        namespace,
        { ...objectValue(defaultLabels[namespace]), ...objectValue(labels) }
      ])),
    };
  }

  function withMappedLabels(config){
    const mappings = mergeMappingsModule(config.mappings);
    const scheduling = mergeSchedulingModule(config.scheduling);
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
    return {
      modules: MODULES,
      standard_roles: STANDARD_ROLES,
      scheduling: { ...scheduling, roles, event_types },
      mappings,
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

  window.addEventListener?.('fm:departments:updated', () => cache.clear());

  async function loadBranchConfig(orgId, branchId, options = {}){
    const key = cacheKey(orgId, branchId);
    if (!options.refresh && cache.has(key)) return cache.get(key);
    const moduleMap = options.ensureDefaults === true ? await listedModuleMap(orgId, branchId) : null;
    const getExisting = (moduleId) => {
      if (!moduleMap) return loadModule(orgId, branchId, moduleId);
      const listed = moduleMap.get(moduleId);
      return listed ? (listed.data || listed) : null;
    };
    const [schedulingRaw, mappingsRaw] = await Promise.all([
      getExisting(MODULES.scheduling),
      getExisting(MODULES.mappings),
    ]);
    const scheduling = mergeSchedulingModule(schedulingRaw);
    const mappings = mergeMappingsModule(mappingsRaw);
    const config = withMappedLabels({ scheduling, mappings });
    if (window.PlatformAPI?.workforce?.departments) {
      const departments = await window.PlatformAPI.workforce.departments(orgId);
      config.appointment_catalog = { ...config.scheduling.appointment_catalog, departments:departments.departments, groups:departments.groups };
      config.scheduling.appointment_catalog = config.appointment_catalog;
    }
    config.org_id = orgId;
    config.branch_id = branchId || 'default';
    // The module list failed to load: the stored modules are unknown, so the
    // defaults above are a stand-in only. Never cache them or save them over
    // the organization's real configuration.
    if (options.ensureDefaults === true && !moduleMap) return config;
    cache.set(key, config);
    if (options.ensureDefaults === true) {
      if (!schedulingRaw || !Object.keys(objectValue(schedulingRaw.event_types)).length) saveModule(orgId, branchId, MODULES.scheduling, scheduling).catch(() => null);
      // Terminology is never seeded: default labels are library entries and the module keeps only overrides.
    }
    return config;
  }

  function labelFor(config, namespace, id){
    const labels = objectValue(config?.mappings?.labels?.[namespace]);
    return window.PlatformTerminology?.get?.(`${namespace}.${id}`, cleanText(labels[id]) || humanizeKey(id), { mappings:config?.mappings }) || cleanText(labels[id]) || humanizeKey(id);
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
    let roles = unique([...(arrayValue(data.roles)), ...(arrayValue(data.access_role_ids)), ...(arrayValue(data.role_ids))]);
    // No implicit roles for admins: assignability is strictly what the user's
    // role list says, matching the server-side policy engine. An admin who
    // should take sales appointments gets the scheduling role explicitly.
    return {
      ...data,
      id: docId(userDocOrData) || cleanText(data.id),
      roles,
      role_ids:roles,
      subject_type:'organization_user',
      assignment_tag_ids:unique(data.assignment_tag_ids || data.tag_ids),
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
    const unscheduled = cleanText(raw.status).toLowerCase() === 'unscheduled' && !cleanText(raw.start_at || raw.start || raw.starts_at);
    const start = unscheduled ? null : toDate(raw.start_at || raw.start || raw.starts_at);
    const rawEnd = toDate(raw.end_at || raw.end);
    const derivedDuration = start && rawEnd && rawEnd > start ? Math.max(1, Math.round((rawEnd.getTime() - start.getTime()) / 60000)) : 0;
    const duration = Math.max(1, Number(raw.duration_minutes || raw.duration || derivedDuration || eventType.duration_minutes || 60));
    const end = start ? (rawEnd && rawEnd > start ? rawEnd : addMinutes(start, duration)) : null;
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
      start_at: start ? start.toISOString() : '',
      duration_minutes: duration,
      end_at: end ? end.toISOString() : '',
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
      customer_visible: raw.customer_visible === true,
      customer_show_title: raw.customer_show_title !== false,
      customer_show_crew: raw.customer_show_crew === true,
      customer_description: cleanText(raw.customer_description || raw.customerDescription),
      parent_event_id: eventParentId(raw),
      depends_on: eventDependencies(raw),
    };
  }

  function projectionStageInstance(data){
    const instances = arrayValue(objectValue(data.work_projection).instances).filter((instance) => instance && typeof instance === 'object');
    return instances.find((instance) => instance.sales === true)
      || instances.find((instance) => instance.sales !== true)
      || instances[0]
      || null;
  }

  function normalizeProject(projectDocOrData, config = null){
    const data = docData(projectDocOrData);
    const id = docId(projectDocOrData) || cleanText(data.id);
    const events = arrayValue(data.events).map((event) => normalizeEvent(event, config, { ...data, id }));
    // Stage display comes from the denormalized work projection the backend
    // writes on every project; legacy stage fields remain as a fallback only.
    const instance = projectionStageInstance(data);
    const stageId = cleanText(instance?.stage_id || data.stage || data.stage_id || objectValue(data.lifecycle).status);
    const stageLabel = cleanText(instance?.stage_title) || humanizeKey(stageId);
    return {
      ...data,
      id,
      stage: stageId,
      stage_id: stageId,
      mapped_stage: { id: stageId, label: stageLabel, color: cleanText(instance?.stage_color) },
      events
    };
  }

  /* List helpers never turn a failed read into an empty list (R3-HDR-1): an
   * empty schedule is indistinguishable from "nothing booked", so callers
   * could overwrite good data with it. A failed request rejects with a typed
   * ScheduleSourceError (error.code 'schedule_source_failed', error.source,
   * error.status, error.cause) so the caller can keep its last good data and
   * offer a retry. A permission refusal (401/403) is not a failure of the
   * source: that viewer simply has no such list, so it still resolves []. A
   * missing collection (404) resolves [] via PlatformAPI as before. */
  function scheduleSourceError(source, error){
    const failure = new Error((globalThis.PlatformLanguage?.text("platform-scheduling","m_schedule_source_failed","Some schedule data could not be loaded.") ?? "Some schedule data could not be loaded."));
    failure.name = 'ScheduleSourceError';
    failure.code = 'schedule_source_failed';
    failure.source = source;
    failure.status = Number(error?.status || 0);
    failure.cause = error;
    return failure;
  }

  function isScheduleSourceError(error){
    return error?.code === 'schedule_source_failed' && error?.name === 'ScheduleSourceError';
  }

  function isPermissionRefusal(error){
    return [401, 403].includes(Number(error?.status || 0));
  }

  async function listSource(source, load){
    try {
      return await load();
    } catch (error) {
      if (isPermissionRefusal(error)) return [];
      throw scheduleSourceError(source, error);
    }
  }

  async function listUsers(orgId, config = null){
    const result = await listSource('users', () => PlatformAPI.users.list(orgId));
    return arrayValue(result?.documents || result?.users || result).map((doc) => normalizeUser(doc, config));
  }

  async function listProjects(orgId, config = null){
    const result = await listSource('projects', () => PlatformAPI.projects.list(orgId));
    return arrayValue(result?.documents || result?.projects || result).map((doc) => normalizeProject(doc, config));
  }

  /* Floating (non-project) calendar events, with the same failure contract. */
  async function listCalendarEvents(orgId, options = {}){
    if (!PlatformAPI?.calendarEvents?.list) return [];
    const result = await listSource('calendar_events', () => PlatformAPI.calendarEvents.list(orgId, options));
    return arrayValue(result?.documents || result?.calendar_events || result);
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

  /* Render an event type's title_template ('{project} — Sales') with data
   * from the event/project. Returns '' when the type declares no template so
   * callers can fall back to their existing default titles. Supported
   * variables: {project}, {customer}, {address}, {type}. */
  function autoEventTitle(config, event = {}, project = {}){
    const typeId = eventTypeId(event);
    const eventType = objectValue(config?.event_types?.[typeId] || config?.scheduling?.event_types?.[typeId] || DEFAULT_EVENT_TYPES[typeId]);
    const template = cleanText(eventType.title_template);
    if (!template) return '';
    const contact = arrayValue(project.contacts).find((entry) => entry?.primary) || arrayValue(project.contacts)[0] || {};
    const vars = {
      project: cleanText(project.title || project.name || event.project_title || contact.name),
      customer: cleanText(contact.name || project.customer_name || project.title || event.project_title),
      address: cleanText(project.address || project.project_address || event.project_address),
      type: cleanText(eventType.label) || humanizeKey(typeId)
    };
    const rendered = template.replace(/\{(project|customer|address|type)\}/g, (_, key) => vars[key] || '').replace(/\s{2,}/g, ' ').trim();
    // A template that resolved to nothing but separators is no title at all.
    return /[a-z0-9]/i.test(rendered.replace(/—|-|·/g, '')) ? rendered : '';
  }

  function eventKind(event = {}){
    // `kind` is intentionally customizable.  Keep the canonical scheduling
    // marker authoritative so a scope-defined label cannot make a material
    // delivery lose its category, lock rules, or lifecycle behavior.
    const scheduleKind = cleanText(event.schedule_item_kind || event.scheduleItemKind).toLowerCase();
    const resourceType = eventResourceType(event);
    if (resourceType === 'labor' || scheduleKind === 'labor') return 'project_work';
    if (resourceType === 'equipment' || scheduleKind === 'equipment') return 'equipment';
    if (resourceType === 'material' || scheduleKind === 'material_delivery' || scheduleKind === 'materials_delivery' || materialListId(event)) return 'material_delivery';
    const explicit = cleanText(event.kind || event.event_kind).toLowerCase();
    if (explicit) return explicit;
    const typeId = eventTypeId(event).toLowerCase();
    if (typeId === 'sales_appointment') return 'sales_appointment';
    if (typeId === 'project_work') return 'project_work';
    if (typeId === 'delivery' || typeId === 'material_delivery' || typeId.startsWith('material_delivery_')) return 'material_delivery';
    return typeId || 'custom';
  }

  function eventCategory(event = {}){
    // A span belongs with the work its event type names.
    const kind = eventIsSpan(event) ? eventTypeId(event).toLowerCase() : eventKind(event);
    if (kind === 'sales_appointment') return 'sales';
    if (kind === 'project_work') return 'production';
    // Equipment rides the production schedule (matches isProductionEvent in
    // the scheduling app so the view filters agree).
    if (kind === 'equipment') return 'production';
    if (kind === 'material_delivery') return 'materials';
    return 'other';
  }

  function eventRequirementWarnings(event = {}, options = {}){
    const value = objectValue(event);
    const warnings = [];
    const kind = eventKind(value);
    const assignedUsers = arrayValue(value.assigned_user_ids).filter(Boolean);
    const assignedUserId = cleanText(value.assigned_user_id || objectValue(arrayValue(value.assigned_users)[0]).id);
    const assignedResourceId = cleanText(eventAssignees(value)[0]?.id);
    const requiredRoleIds = arrayValue(value.required_role_ids || value.role_ids).filter(Boolean);
    const assignmentRequired = objectValue(value.assignment_policy).allow_unassigned === false || requiredRoleIds.length > 0;
    if (kind === 'sales_appointment' && !assignedUserId && !assignedUsers.length && !assignedResourceId) {
      warnings.push({ code:'salesperson_unassigned', label:(globalThis.PlatformLanguage?.text("platform-scheduling","m_fea338f4e06ef3","Salesperson is not assigned") ?? "Salesperson is not assigned") });
    } else if (assignmentRequired && kind !== 'project_work' && !assignedUserId && !assignedUsers.length && !assignedResourceId) {
      warnings.push({ code:'assignment_unassigned', label:(globalThis.PlatformLanguage?.text("platform-scheduling","m_5df5da02403b40","Required person or team is not assigned") ?? "Required person or team is not assigned") });
    }
    if (kind === 'project_work' && !assignedResourceId && !assignedUserId && !assignedUsers.length) {
      warnings.push({ code:'crew_unassigned', label:(globalThis.PlatformLanguage?.text("platform-scheduling","m_7c77a4ac5fa59d","Crew is not assigned") ?? "Crew is not assigned") });
    }
    if (options.includeEquipment !== false) {
      const units = arrayValue(options.equipmentUnits).map(objectValue);
      const refs = eventEquipment(value);
      const requirements = arrayValue(value.resource_requirements).map(objectValue);
      requirements.forEach((requirement) => {
        const typeId = cleanText(requirement.equipment_type_id || requirement.id);
        if (!typeId) return;
        const needed = Math.max(1, Number(requirement.quantity || 1));
        const assigned = refs.reduce((count, ref) => {
          if (ref.kind === 'equipment_type') return ref.id === typeId ? count + (ref.quantity || 1) : count;
          const unit = units.find((candidate) => cleanText(candidate.id) === ref.id);
          return cleanText(unit?.type_id || unit?.equipment_type_id) === typeId ? count + 1 : count;
        }, 0);
        if (assigned < needed) warnings.push({
          code:`equipment_type_unassigned:${typeId}`,
          label:((v0,v1,v2) => globalThis.PlatformLanguage?.text("platform-scheduling","m_e465a5b03772d8",`${v0}: ${v1} of ${v2} assigned`,{v0,v1,v2}) ?? `${v0}: ${v1} of ${v2} assigned`)(cleanText(requirement.label || requirement.name) || 'Required equipment',assigned,needed),
          equipment_type_id:typeId,
          assigned,
          required:needed,
        });
      });
    }
    return warnings;
  }

  function eventIsScheduled(event = {}){
    const status = cleanText(event.status).toLowerCase();
    return !['unscheduled', 'cancelled', 'canceled'].includes(status) && !!eventStart(event);
  }

  function eventIsLocked(event = {}){
    const scheduleLock = objectValue(event.schedule_lock || event.scheduleLock);
    if (Object.prototype.hasOwnProperty.call(scheduleLock, 'locked')) return scheduleLock.locked === true;
    return event.locked === true || event.schedule_locked === true;
  }

  /* ── Appointment confirmations ────────────────────────────────────────────
   * An appointment can require the customer to confirm it on the day (or the
   * afternoon before, or an hour ahead). Until they answer, the appointment
   * renders with a dashed border everywhere it appears. Companies that would
   * rather some roles not see that can hide it — confirmationVisible() is the
   * single gate every surface asks. */

  const CONFIRMATION_TONES = {
    pending: { label: (globalThis.PlatformLanguage?.text("platform-scheduling","m_a6113a5a5e994c","Awaiting confirmation") ?? "Awaiting confirmation"), short: 'Unconfirmed', tone: 'warn', icon: 'fa-hourglass-half' },
    sent: { label: (globalThis.PlatformLanguage?.text("platform-scheduling","m_cdc436dfc32234","Awaiting customer reply") ?? "Awaiting customer reply"), short: 'Unconfirmed', tone: 'warn', icon: 'fa-paper-plane' },
    confirmed: { label: (globalThis.PlatformLanguage?.text("platform-scheduling","m_5800ed31fbc525","Confirmed by customer") ?? "Confirmed by customer"), short: 'Confirmed', tone: 'good', icon: 'fa-circle-check' },
    declined: { label: (globalThis.PlatformLanguage?.text("platform-scheduling","m_4ec26f7d4fc657","Customer asked to reschedule") ?? "Customer asked to reschedule"), short: 'Reschedule', tone: 'bad', icon: 'fa-triangle-exclamation' },
    failed: { label: (globalThis.PlatformLanguage?.text("platform-scheduling","m_d1169ea1ee5bd9","Confirmation could not be sent") ?? "Confirmation could not be sent"), short: 'Send failed', tone: 'bad', icon: 'fa-circle-exclamation' },
    canceled: { label: (globalThis.PlatformLanguage?.text("platform-scheduling","m_7aa5218edc4733","Confirmation withdrawn") ?? "Confirmation withdrawn"), short: 'Withdrawn', tone: 'muted', icon: 'fa-ban' },
  };

  function eventConfirmation(event = {}){
    return objectValue(objectValue(event).confirmation);
  }

  /* The rendering-ready view of an appointment's confirmation state. */
  function confirmationState(event = {}){
    const confirmation = eventConfirmation(event);
    const required = confirmation.required === true;
    const status = cleanText(confirmation.status).toLowerCase() || (required ? 'pending' : 'not_required');
    const descriptor = CONFIRMATION_TONES[status] || null;
    return {
      required,
      status,
      label: descriptor ? descriptor.label : '',
      short: descriptor ? descriptor.short : '',
      tone: descriptor ? descriptor.tone : 'muted',
      icon: descriptor ? descriptor.icon : 'fa-circle-question',
      // Only "awaiting an answer" earns the dashed treatment; a declined
      // appointment is a louder problem and gets its own styling.
      awaiting: required && ['pending', 'sent'].includes(status),
      confirmed: status === 'confirmed',
      declined: status === 'declined',
      channels: objectValue(confirmation.channels),
      channels_sent: arrayValue(confirmation.channels_sent),
      scheduled_send_at: cleanText(confirmation.scheduled_send_at),
      sent_at: cleanText(confirmation.sent_at),
      confirmed_at: cleanText(confirmation.confirmed_at),
      declined_at: cleanText(confirmation.declined_at),
      confirmed_via: cleanText(confirmation.confirmed_via),
      confirmed_by: cleanText(confirmation.confirmed_by),
      response_text: cleanText(confirmation.response_text),
      last_error: cleanText(confirmation.last_error),
      include_portal_link: confirmation.include_portal_link === true,
      schedule: objectValue(confirmation.schedule),
    };
  }

  let confirmationSettingsCache = null;

  function setConfirmationSettings(settings){
    confirmationSettingsCache = objectValue(settings);
    return confirmationSettingsCache;
  }

  function confirmationSettings(){
    return objectValue(confirmationSettingsCache);
  }

  /* Whether the current user may see confirmation state at all. Mirrors
   * canViewConfirmations() in public/v1/appointments/service.ts. */
  function confirmationVisible(settings = null){
    const resolved = objectValue(settings || confirmationSettingsCache);
    const visibility = objectValue(resolved.visibility);
    if (cleanText(visibility.mode) !== 'permission') return true;
    const portal = (typeof window !== 'undefined' && window.Portal) ? window.Portal : null;
    const currentUser = objectValue(portal?.currentUser);
    const permissions = objectValue(currentUser.permissions);
    if (permissions['*'] === true || permissions.view_appointment_confirmation === true) return true;
    const allowed = arrayValue(visibility.role_ids).map(cleanText).filter(Boolean);
    const roleIds = unique([
      ...arrayValue(currentUser.roleIds),
      ...arrayValue(currentUser.accessProfile?.access_role_ids),
    ]);
    return allowed.length > 0 && roleIds.some((roleId) => allowed.includes(roleId));
  }

  /* The one call every schedule surface makes: returns null when the viewer
   * should see nothing, so the appointment renders exactly as it always did. */
  function visibleConfirmationState(event = {}, settings = null){
    const state = confirmationState(event);
    if (!state.required) return null;
    if (!confirmationVisible(settings)) return null;
    return state;
  }

  /* The list an event was made for: scope_resource_list_id + resource_type,
   * and list_part_id when one list has several events. */
  function eventListId(event = {}){ return cleanText(objectValue(event).scope_resource_list_id); }
  function eventListPartId(event = {}){ return cleanText(objectValue(event).list_part_id); }
  function eventResourceType(event = {}){ return cleanText(objectValue(event).resource_type).toLowerCase(); }

  function materialListId(event = {}){
    if (eventResourceType(event) === 'material') return eventListId(event);
    const sourceRef = objectValue(event.source_ref || event.sourceRef);
    return cleanText(sourceRef.type) === 'material_list' ? cleanText(sourceRef.id) : '';
  }

  function eventPresentation(event = {}){
    const presentation = objectValue(event.presentation);
    const kind = eventKind(event);
    return {
      kind,
      category: eventCategory(event),
      color: cleanText(presentation.color || event.category_color || event.event_color || event.color || (kind === 'material_delivery' ? '#7c3aed' : '')),
      accent_color: cleanText(presentation.accent_color || event.material_list_color || event.accent_color),
      icon: cleanText(presentation.icon || event.icon || (kind === 'material_delivery' ? 'fa-truck-ramp-box' : '')),
      ordered: cleanText(event.order_status).toLowerCase() === 'ordered' || event.ordered === true,
      locked: eventIsLocked(event),
    };
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

  /* Client twin of availabilityForEquipment in public/v1/equipment/service.ts:
   * which equipment units are free in a window, judged from the same event
   * set every schedule surface already holds. Units come from the
   * assignable-resources catalog (subject_type equipment_unit). */
  function availabilityForEquipment({ units = [], projects = [], events = null, start, durationMinutes = 60, end = null, excludeEventId = '', typeId = '' } = {}){
    const startDate = toDate(start);
    const endDate = end ? toDate(end) : (startDate ? addMinutes(startDate, durationMinutes) : null);
    const allEvents = events ? arrayValue(events) : eventsFromProjects(projects);
    const overlapping = startDate && endDate ? allEvents
      .map((event) => normalizeEvent(event))
      .filter((event) => !['completed', 'canceled', 'cancelled', 'unscheduled'].includes(cleanText(event.status).toLowerCase()))
      .filter((event) => cleanText(event.id) !== cleanText(excludeEventId))
      .filter((event) => eventEquipment(event).length)
      .filter((event) => intervalsOverlap(startDate, endDate, eventStart(event), eventEnd(event))) : [];
    const normalizedUnits = arrayValue(units).map(objectValue)
      .map((unit) => objectValue(unit.equipment_unit ? { ...unit.equipment_unit, ...unit } : unit))
      .filter((unit) => cleanText(unit.subject_type || 'equipment_unit') === 'equipment_unit')
      .filter((unit) => !typeId || cleanText(unit.type_id) === cleanText(typeId));
    const results = normalizedUnits.map((unit) => {
      const unitId = cleanText(unit.id);
      const bookings = overlapping.filter((event) => eventEquipment(event).some((ref) => ref.kind === 'equipment_unit' && ref.id === unitId));
      // Live down/in-use/reserved badges describe the current instant; a
      // different window is blocked by its overlapping events, not that badge.
      const unavailable = cleanText(unit.status) === 'retired'
        || (cleanText(unit.status) === 'down' && cleanText(unit.status_source) !== 'schedule');
      return {
        id: unitId,
        name: cleanText(unit.name),
        type_id: cleanText(unit.type_id),
        status: cleanText(unit.status),
        bookings,
        available: !unavailable && !bookings.length,
        reason: unavailable ? 'unit_unavailable' : (bookings.length ? 'double_booked' : ''),
      };
    });
    return {
      start: startDate?.toISOString() || '',
      end: endDate?.toISOString() || '',
      units: results,
      availableUnits: results.filter((unit) => unit.available),
      conflictedUnits: results.filter((unit) => !unit.available),
      hasAvailability: results.some((unit) => unit.available),
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
    const unscheduled = cleanText(fields.status).toLowerCase() === 'unscheduled' && !cleanText(fields.start || fields.start_at);
    const start = unscheduled ? null : (toDate(fields.start || fields.start_at) || new Date());
    const end = toDate(fields.end || fields.end_at);
    const duration = start && end && end > start
      ? Math.max(1, Math.round((end.getTime() - start.getTime()) / 60000))
      : (fields.durationMinutes || fields.duration_minutes || eventType.duration_minutes || 60);
    const assignedUser = fields.assignedUser || fields.assigned_user || null;
    return normalizeEvent({
      id: fields.id || `event_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`,
      type_id: typeId,
      title: fields.title || (config ? labelFor(config, 'event_types', typeId) : humanizeKey(typeId)),
      start_at: start ? start.toISOString() : '',
      end_at: start && end && end > start ? end.toISOString() : '',
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
      resource_refs: arrayValue(fields.resourceRefs || fields.resource_refs),
      resource_requirements: arrayValue(fields.resourceRequirements || fields.resource_requirements),
      parent_event_id: cleanText(fields.parentEventId || fields.parent_event_id),
      ...(normalizePlacement(fields.placement) ? { placement:normalizePlacement(fields.placement) } : {}),
      scope_template_id: cleanText(fields.scopeTemplateId || fields.scope_template_id),
      event_type_default_id: typeId,
      source: 'platform_scheduling',
      status: fields.status || 'scheduled',
      notes: fields.notes || '',
      customer_visible: fields.customer_visible === true,
      customer_show_title: fields.customer_show_title !== false,
      customer_show_crew: fields.customer_show_crew === true,
      customer_description: cleanText(fields.customer_description || fields.customerDescription),
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

  /* ── Resources ────────────────────────────────────────────────────────────
   * Browser twin of public/v1/scheduling/event-model.ts. resource_refs is the
   * only place an event names the groups, people, companies and equipment it
   * uses: { kind, id, name, role, unit_id?, quantity? }. A resource has its
   * event's range. The first crew-role assignee is the primary one. People
   * attached through assigned_user_ids (the sales appointment path) stay
   * there; eventAssigneeKeys covers both. */
  const ASSIGNEE_REF_KINDS = ['organization_user', 'resource_group', 'organization_connection'];
  const EQUIPMENT_REF_KINDS = ['equipment_unit', 'equipment_type'];
  const RESOURCE_KIND_ALIASES = {
    crew:'resource_group', team:'resource_group', group:'resource_group',
    person:'organization_user', user:'organization_user',
    subcontractor:'organization_connection', connection:'organization_connection',
  };

  function resourceRefKind(value){
    const kind = cleanText(value).toLowerCase();
    const resolved = RESOURCE_KIND_ALIASES[kind] || kind;
    return ASSIGNEE_REF_KINDS.includes(resolved) || EQUIPMENT_REF_KINDS.includes(resolved) ? resolved : '';
  }

  function resourceRefKey(ref = {}){
    return `${cleanText(ref.kind)}:${cleanText(ref.id).toLowerCase()}`;
  }

  // One entry of resource_refs, or null when it names nothing usable.
  function normalizeResourceRef(value){
    const ref = objectValue(value);
    const kind = resourceRefKind(ref.kind);
    const id = cleanText(ref.id);
    if (!kind || !id) return null;
    const equipment = EQUIPMENT_REF_KINDS.includes(kind);
    const role = cleanText(ref.role).toLowerCase();
    const quantity = Math.max(1, Math.round(Number(ref.quantity || 1)) || 1);
    const unitId = equipment ? '' : cleanText(ref.unit_id);
    return {
      kind,
      id,
      name: cleanText(ref.name || ref.label),
      role: equipment ? 'equipment' : role === 'operator' ? 'operator' : 'crew',
      ...(unitId ? { unit_id:unitId } : {}),
      ...(equipment && (kind === 'equipment_type' || quantity > 1) ? { quantity } : {}),
    };
  }

  // The event's resources in stored order, without duplicates and never
  // naming the event itself.
  function eventResources(event = {}){
    const value = objectValue(event);
    const selfId = cleanText(value.id);
    const seen = new Set();
    const refs = [];
    arrayValue(value.resource_refs).forEach((entry) => {
      const ref = normalizeResourceRef(entry);
      if (!ref || ref.id === selfId) return;
      const key = resourceRefKey(ref);
      if (seen.has(key)) return;
      seen.add(key);
      refs.push(ref);
    });
    return refs;
  }

  function eventAssignees(event = {}){
    return eventResources(event).filter((ref) => ASSIGNEE_REF_KINDS.includes(ref.kind));
  }

  function eventEquipment(event = {}){
    return eventResources(event).filter((ref) => EQUIPMENT_REF_KINDS.includes(ref.kind));
  }

  function eventPrimaryAssignee(event = {}){
    return eventAssignees(event).find((ref) => ref.role === 'crew') || null;
  }

  function eventAssignedUserIds(event = {}){
    const value = objectValue(event);
    return unique([...arrayValue(value.assigned_user_ids), value.assigned_user_id]);
  }

  // Everyone on the event as lower-cased `kind:id` keys: its assignees plus
  // the people in assigned_user_ids.
  function eventAssigneeKeys(event = {}){
    return unique([
      ...eventAssignees(event).map(resourceRefKey),
      ...eventAssignedUserIds(event).map((id) => `organization_user:${id.toLowerCase()}`),
    ]);
  }

  function workResourceRef(value = {}){
    const input = objectValue(value);
    const id = cleanText(input.id);
    return normalizeResourceRef({
      kind: resourceRefKind(input.kind || input.subject_type || input.resource_kind) || 'resource_group',
      id,
      name: cleanText(input.name || input.label) || id,
      role: 'crew',
      unit_id: input.unit_id,
    });
  }

  function keptResourceRefs(event = {}){
    return eventResources(event).filter((ref) => EQUIPMENT_REF_KINDS.includes(ref.kind) || ref.role === 'operator');
  }

  /* -> { crews:[{kind,id,name,unit_id?}], people:[{id,name}] } for an event:
   * the groups and companies doing the work, and the people (assigned_user_ids
   * plus anyone listed as a crew-role resource). */
  function eventWorkAssignees(event = {}){
    const value = objectValue(event);
    const assignees = eventAssignees(value).filter((ref) => ref.role === 'crew');
    const personRefs = assignees.filter((ref) => ref.kind === 'organization_user');
    const users = arrayValue(value.assigned_users).map(objectValue);
    const people = unique([...eventAssignedUserIds(value), ...personRefs.map((ref) => ref.id)]).map((id) => {
      const user = users.find((candidate) => cleanText(candidate.id || candidate.user_id) === id);
      const ref = personRefs.find((candidate) => candidate.id === id);
      return { id, name:cleanText(user?.name || user?.email || ref?.name || (id === cleanText(value.assigned_user_id) ? value.assigned_user_name : '')) };
    });
    return {
      crews:assignees.filter((ref) => ref.kind !== 'organization_user').map((ref) => ({ kind:ref.kind, id:ref.id, name:ref.name, ...(ref.unit_id ? { unit_id:ref.unit_id } : {}) })),
      people,
    };
  }

  /* The explicit assignee set as an event patch: every group or company as a
   * crew-role resource_ref (first = primary, unit_id carried), people as
   * assigned_user_ids; equipment and operator refs are kept as they are. */
  function assigneeSetPayload(event = {}, { crews = [], people = [] } = {}){
    const crewRefs = arrayValue(crews).map(workResourceRef)
      .filter((ref, index, list) => ref && ASSIGNEE_REF_KINDS.includes(ref.kind) && ref.kind !== 'organization_user'
        && list.findIndex((other) => other && resourceRefKey(other) === resourceRefKey(ref)) === index);
    const personList = arrayValue(people).map(objectValue).map((person) => ({
      id: cleanText(person.id || person.user_id),
      name: cleanText(person.name || person.email || person.label),
      role_ids: unique(person.role_ids || person.roles || []),
    })).filter((person, index, list) => person.id && list.findIndex((other) => other.id === person.id) === index);
    const names = [...crewRefs.map((ref) => ref.name), ...personList.map((person) => person.name)].filter(Boolean);
    return {
      resource_refs: [...crewRefs, ...keptResourceRefs(event)],
      assigned_user_ids: personList.map((person) => person.id),
      assigned_users: personList.map((person) => ({ id:person.id, name:person.name, role_ids:person.role_ids })),
      assigned_user_id: personList[0]?.id || '',
      assigned_user_name: personList[0]?.name || '',
      assignee_label: names.join(', ') || 'Unassigned',
    };
  }

  /* Replace an event's whole work-assignee set, keeping its equipment. `refs`
   * mixes groups and companies ({kind:'resource_group'|'organization_connection',
   * id, name, unit_id?}) and people ({kind:'organization_user', id, name});
   * [] unassigns. */
  function setEventWorkAssignees(event = {}, refs = []){
    const list = arrayValue(refs).map(objectValue);
    const isPerson = (ref) => resourceRefKind(ref.kind || ref.subject_type || ref.resource_kind) === 'organization_user';
    return { ...event, ...assigneeSetPayload(event, { crews:list.filter((ref) => !isPerson(ref)), people:list.filter(isPerson) }) };
  }

  /* Replace only the primary assignee ({kind, id, name, unit_id?}); every
   * other resource stays. A ref without an id unassigns every crew-role
   * assignee and keeps equipment and operators. */
  function setEventPrimaryAssignee(event = {}, ref = null){
    const resources = eventResources(event);
    const isWork = (entry) => ASSIGNEE_REF_KINDS.includes(entry.kind) && entry.role === 'crew';
    const next = workResourceRef(ref);
    if (!next || !ASSIGNEE_REF_KINDS.includes(next.kind)) return { ...event, resource_refs:resources.filter((entry) => !isWork(entry)) };
    const current = eventPrimaryAssignee(event);
    const replaced = [resourceRefKey(next), current ? resourceRefKey(current) : ''];
    return {
      ...event,
      resource_refs:[
        next,
        ...resources.filter((entry) => isWork(entry) && !replaced.includes(resourceRefKey(entry))),
        ...resources.filter((entry) => !isWork(entry)),
      ],
    };
  }

  function updateProjectEventRange(event, fields = {}){
    const start = toDate(fields.start || fields.start_at) || eventStart(event) || new Date();
    const end = toDate(fields.end || fields.end_at) || eventEnd(event) || addMinutes(start, eventDurationMinutes(event));
    const safeEnd = end > start ? end : addMinutes(start, 60);
    const resourceRefs = fields.resource_refs ?? fields.resourceRefs;
    return {
      ...event,
      ...(Array.isArray(resourceRefs) ? { resource_refs:resourceRefs } : {}),
      start_at: start.toISOString(),
      start: start.toISOString(),
      end_at: safeEnd.toISOString(),
      end: safeEnd.toISOString(),
      duration_minutes: Math.max(1, Math.round((safeEnd.getTime() - start.getTime()) / 60000)),
      all_day: fields.all_day ?? fields.allDay ?? event.all_day ?? false,
      start_date: cleanText(fields.start_date || fields.startDate || event.start_date),
      end_date: cleanText(fields.end_date || fields.endDate || event.end_date),
      schedule_granularity: cleanText(fields.schedule_granularity || fields.scheduleGranularity || event.schedule_granularity),
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

  /* ── Optimistic concurrency ──────────────────────────────────────────────
   * The server stamps every schedule item with event_revision. Saves send the
   * revision of the copy they edited (expected_event_revision); a newer
   * stored revision is refused with 409 `stale_event`, surfaced here as a
   * typed error (isStaleSaveError / error.stale === true, error.currentEvent
   * = the stored copy, error.deleted when it was removed). Revisions this page
   * produced itself never count as "someone else": a caller still holding the
   * pre-save copy is upgraded to the revision its own save returned. */
  const ownEventRevisions = new Map();

  function eventRevisionOf(event){
    const revision = Number(objectValue(event).event_revision);
    return Number.isFinite(revision) && revision > 0 ? Math.floor(revision) : 0;
  }

  function expectedRevisionFor(key, revision){
    const own = ownEventRevisions.get(key);
    return own && own.superseded.has(revision) ? own.latest : revision;
  }

  function recordOwnEventRevision(key, sent, saved){
    if (!key || !Number.isFinite(saved) || saved <= 0) return;
    const own = ownEventRevisions.get(key) || { latest:0, superseded:new Set() };
    if (Number.isFinite(sent)) own.superseded.add(sent);
    if (own.latest && own.latest !== saved) own.superseded.add(own.latest);
    own.latest = Math.max(own.latest, saved);
    own.superseded.delete(own.latest);
    ownEventRevisions.set(key, own);
  }

  function isStaleSaveError(error){
    if (!error) return false;
    if (error.stale === true && error.code === 'stale_event') return true;
    return Number(error.status) === 409 && cleanText(error.data?.error || error.data?.code || error.code) === 'stale_event';
  }

  function staleSaveError(error, fallbackEvent = null){
    const details = objectValue(error?.data?.details);
    const deleted = details.deleted === true;
    const message = deleted
      ? ((globalThis.PlatformLanguage?.text("platform-scheduling","m_stale_event_deleted","This item was deleted by someone else.") ?? "This item was deleted by someone else."))
      : ((globalThis.PlatformLanguage?.text("platform-scheduling","m_stale_event","Changed by someone else. This item was changed in another window; reload it and apply your change again.") ?? "Changed by someone else. This item was changed in another window; reload it and apply your change again."));
    const stale = new Error(message);
    stale.name = 'StaleScheduleEventError';
    stale.code = 'stale_event';
    stale.stale = true;
    stale.status = 409;
    stale.deleted = deleted;
    stale.currentEvent = details.current_event || null;
    stale.currentRevision = Number(details.current_event_revision || 0);
    stale.expectedRevision = Number(details.expected_event_revision || 0);
    stale.event = fallbackEvent;
    stale.data = error?.data || null;
    stale.cause = error;
    return stale;
  }

  /* R3-TG-9: views keep view-only shadow copies of an item's window (start /
   * end, __start / __end) and draft markers (__draft, __activeDraft, other
   * __* keys). Only start_at / end_at are stored; a stale shadow copy must
   * never be written back. (The server strips them too.) */
  function persistableEvent(event){
    const value = { ...objectValue(event) };
    if (!Object.prototype.hasOwnProperty.call(value, 'start_at') && cleanText(value.start)) value.start_at = value.start;
    if (!Object.prototype.hasOwnProperty.call(value, 'end_at') && cleanText(value.end)) value.end_at = value.end;
    delete value.start;
    delete value.end;
    Object.keys(value).forEach((key) => { if (key.startsWith('__')) delete value[key]; });
    return value;
  }

  /* R4-RAIL-2: a schedule save that has not answered after SAVE_TIMEOUT_MS
   * rejects with a typed timeout error (isSaveTimeoutError) so the UI can say
   * so and keep the draft, instead of showing "Saving…" forever. The request
   * itself is not cancelled: the server may still store the change, so the
   * message asks the user to check before trying again. */
  const SAVE_TIMEOUT_MS = 30000;
  function saveTimeoutError(){
    const error = new Error((globalThis.PlatformLanguage?.text("platform-scheduling","m_save_timeout","The server is taking too long to answer. Your change may still be saved — refresh to check before trying again.") ?? "The server is taking too long to answer. Your change may still be saved — refresh to check before trying again."));
    error.name = 'ScheduleSaveTimeoutError';
    error.code = 'save_timeout';
    error.timeout = true;
    error.status = 0;
    return error;
  }
  function isSaveTimeoutError(error){
    return !!error && (error.code === 'save_timeout' || error.name === 'ScheduleSaveTimeoutError');
  }
  function withSaveTimeout(promise, ms = SAVE_TIMEOUT_MS){
    let timer = null;
    const timeout = new Promise((resolve, reject) => { timer = setTimeout(() => reject(saveTimeoutError()), ms); });
    return Promise.race([Promise.resolve(promise), timeout]).finally(() => clearTimeout(timer));
  }

  async function saveProjectEvent(orgId, project, event, config = null){
    const normalizedProject = normalizeProject(project, config);
    const nextEvent = persistableEvent(normalizeEvent(event, config, normalizedProject));
    if (PlatformAPI?.projects?.scheduleEvent) {
      // Items already on the project send the revision of the copy the
      // caller edited (its own event_revision, else the cached one); new
      // items — including copies of another item — send none.
      const cached = arrayValue(normalizedProject.events).find((item) => cleanText(item?.id) === cleanText(nextEvent.id));
      const hasRevision = Object.prototype.hasOwnProperty.call(objectValue(event), 'event_revision');
      const revisionKey = `${cleanText(normalizedProject.id)}:${cleanText(nextEvent.id)}`;
      const expected = cached
        ? expectedRevisionFor(revisionKey, hasRevision ? eventRevisionOf(event) : eventRevisionOf(cached))
        : null;
      const payload = expected === null ? nextEvent : { ...nextEvent, expected_event_revision: expected };
      let result;
      try {
        result = await withSaveTimeout(PlatformAPI.projects.scheduleEvent(orgId, normalizedProject.id, payload, {
          branchId: config?.branch_id || config?.branchId || 'default'
        }));
      } catch (error) {
        if (isStaleSaveError(error)) throw staleSaveError(error, nextEvent);
        throw error;
      }
      // PlatformAPI answers {missing:true} when the project record is not on
      // the server; that is only a local draft for a brand-new item.
      if (result?.missing && cached) {
        const missing = new Error((globalThis.PlatformLanguage?.text("platform-scheduling","m_project_missing","The project could not be found, so the change was not saved.") ?? "The project could not be found, so the change was not saved."));
        missing.code = 'project_missing';
        missing.status = 404;
        // The project window shows its lasting "deleted" notice for this too.
        try { window.dispatchEvent(new CustomEvent('fm:project:deleted', { detail:{ projectId:normalizedProject.id } })); } catch (_) {}
        throw missing;
      }
      if (result?.event) recordOwnEventRevision(revisionKey, expected, eventRevisionOf(result.event));
      // Children the server re-placed carry a revision this save produced.
      arrayValue(result?.related_events).forEach((related) => {
        const relatedId = cleanText(related?.id);
        const held = arrayValue(normalizedProject.events).find((item) => cleanText(item?.id) === relatedId);
        if (relatedId) recordOwnEventRevision(`${cleanText(normalizedProject.id)}:${relatedId}`, held ? eventRevisionOf(held) : NaN, eventRevisionOf(related));
      });
      const savedProject = result?.document?.data
        ? { ...result.document.data, id: result.document.id }
        : result?.project || normalizedProject;
      return {
        event: result?.event ? normalizeEvent(result.event, config, savedProject) : nextEvent,
        project: normalizeProject(savedProject, config),
        document: result?.document || null,
        related_events: arrayValue(result?.related_events),
        blocked_children: arrayValue(result?.blocked_children),
        assignee_conflicts: arrayValue(result?.assignee_conflicts),
        equipment_conflicts: arrayValue(result?.equipment_conflicts),
        equipment_operator_warnings: arrayValue(result?.equipment_operator_warnings)
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

  /* Ask whether a draft event's assignees are already booked, without saving.
   * -> { mode:'warn'|'block'|'allow', assignee_conflicts:[...] } as the server
   * answers it (docs/architecture/schedule-events.md, "Overlap"). */
  async function checkAssigneeOverlap(orgId, { project_id = '', event = {} } = {}){
    if (!PlatformAPI?.projects?.scheduleOverlapCheck) throw new Error('Schedule overlap checks are not configured.');
    return PlatformAPI.projects.scheduleOverlapCheck(orgId, { project_id:cleanText(project_id), event:persistableEvent(event) });
  }

  /* Save a floating (non-project) calendar event with the same stale-save
   * protection as project items. Pass { isNew:true } for a brand-new event
   * or a copy of another one. Resolves to { event, document }; rejects with
   * the typed stale error (isStaleSaveError) when someone else saved first. */
  async function saveCalendarEvent(orgId, event, options = {}){
    const api = PlatformAPI?.calendarEvents;
    if (!api?.save) throw new Error('Calendar event persistence is not configured.');
    const value = objectValue(event);
    const id = cleanText(value.id);
    if (!id) throw new Error('A calendar event id is required.');
    const revisionKey = `calendar:${id}`;
    const expected = options.isNew === true ? null : expectedRevisionFor(revisionKey, eventRevisionOf(value));
    const data = { ...persistableEvent(value), ...(expected === null ? {} : { expected_event_revision: expected }) };
    let result;
    try {
      result = await withSaveTimeout(api.save(orgId, id, data, { kind:'calendar_event', ...(options.branchId || options.branch_id ? { branch_id:options.branchId || options.branch_id } : {}), ...objectValue(options.metadata) }));
    } catch (error) {
      if (isStaleSaveError(error)) throw staleSaveError(error, value);
      throw error;
    }
    if (result?.missing) {
      const missing = new Error((globalThis.PlatformLanguage?.text("platform-scheduling","m_calendar_save_failed","The calendar event could not be saved.") ?? "The calendar event could not be saved."));
      missing.code = 'calendar_event_missing';
      throw missing;
    }
    const saved = result?.document?.data ? { ...result.document.data, id:result.document.id || id } : { ...value };
    recordOwnEventRevision(revisionKey, expected, eventRevisionOf(saved));
    return { event:saved, document:result?.document || null, assignee_conflicts:Array.isArray(result?.document?.assignee_conflicts) ? result.document.assignee_conflicts : (Array.isArray(result?.assignee_conflicts) ? result.assignee_conflicts : []) };
  }

  async function removeProjectEvent(orgId, project, eventId, config = null){
    const normalizedProject = normalizeProject(project, config);
    const id = cleanText(eventId);
    if (!normalizedProject.id || !id) throw new Error('A project and event are required.');
    if (PlatformAPI?.projects?.removeEvent) {
      const result = await withSaveTimeout(PlatformAPI.projects.removeEvent(orgId, normalizedProject.id, id));
      const savedProject = result?.document?.data
        ? { ...result.document.data, id: result.document.id }
        : result?.project || { ...normalizedProject, events: arrayValue(normalizedProject.events).filter((event) => event.id !== id) };
      return { ...result, project: normalizeProject(savedProject, config) };
    }
    const events = arrayValue(normalizedProject.events).filter((event) => event.id !== id);
    const result = await PlatformAPI.documents.setField(orgId, 'projects', normalizedProject.id, 'events', events, {
      kind: 'project_events',
      updated_by: 'platform_scheduling',
    });
    const saved = result?.document?.data ? { ...result.document.data, id: result.document.id } : { ...normalizedProject, events };
    return { project: normalizeProject(saved, config), document: result?.document || null };
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
    normalizeAssignmentPolicy,
    assignmentPolicyForEventType,
    normalizeAssignableSubject,
    assignableMatchesRule,
    filterAssignableSubjects,
    normalizeEvent,
    normalizeProject,
    listUsers,
    listProjects,
    listCalendarEvents,
    isScheduleSourceError,
    persistableEvent,
    eventsFromProjects,
    availabilityWindow,
    eventStart,
    eventEnd,
    eventDurationMinutes,
    eventTypeId,
    eventKind,
    eventCategory,
    autoEventTitle,
    eventIsScheduled,
    eventIsLocked,
    eventConfirmation,
    confirmationState,
    confirmationSettings,
    setConfirmationSettings,
    confirmationVisible,
    visibleConfirmationState,
    eventListId,
    eventListPartId,
    eventResourceType,
    materialListId,
    eventPresentation,
    eventIsType,
    projectEvents,
    projectSalesAppointmentEvents,
    projectWorkEvents,
    intervalsOverlap,
    eventResources,
    eventAssignees,
    eventEquipment,
    eventPrimaryAssignee,
    eventAssigneeKeys,
    eventRequirementWarnings,
    availabilityForRole,
    availabilityForEquipment,
    availabilityForEventType,
    availableEventTypeTimeSlots,
    availableTimeSlots,
    addBusinessDays,
    normalizeDependency,
    eventDependencies,
    eventIsSpan,
    eventParentId,
    eventChildren,
    eventDescendants,
    eventAncestorIds,
    eventFamilyIds,
    normalizePlacement,
    evaluatePlacementExpression,
    evaluatePlacement,
    manualPlacement,
    placeChildren,
    scheduleGraph,
    cascadeDependentDrafts,
    dependencyRescheduleImpact,
    dependencyViolations,
    dependencyEarliestStart,
    orderByDependencies,
    eventIsAllDay,
    eventIsFixed,
    scheduleItemSpan,
    createScheduleGroupEvent,
    relatedScheduleRescheduleDrafts,
    relatedScheduleRescheduleImpact,
    createProjectEvent,
    createProjectWorkEvent,
    updateProjectEventRange,
    upsertProjectEvent,
    saveProjectEvent,
    checkAssigneeOverlap,
    saveCalendarEvent,
    removeProjectEvent,
    eventWorkAssignees,
    assigneeSetPayload,
    setEventWorkAssignees,
    setEventPrimaryAssignee,
    isStaleSaveError,
    isSaveTimeoutError,
    withSaveTimeout,
    SAVE_TIMEOUT_MS,
    ensureProjectSchedulingDefaults,
    localDateInput,
  };
})();
