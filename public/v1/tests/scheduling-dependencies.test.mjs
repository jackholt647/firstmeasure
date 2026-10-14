import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import vm from 'node:vm';

// Behaviour of the shared scheduling model for depends_on links, parents and
// children (placement) and event resources (libraries/platform-scheduling).
const publicRoot = path.resolve(import.meta.dirname, '..', '..');
const source = await readFile(path.join(publicRoot, 'libraries/platform-scheduling/platform-scheduling.js'), 'utf8');
const PlatformAPI = {};
const context = { window:{ PlatformAPI }, console, Date, Math, Set, Map, setTimeout, clearTimeout };
vm.runInNewContext(source, context);
const Scheduling = context.window.PlatformScheduling;

// Local wall-clock helpers (dates are built in the process time zone, as the
// library works in local calendar days).
const at = (ymd, hhmm = '00:00') => new Date(`${ymd}T${hhmm}:00`);
const allDay = (from, to) => ({ start_at:at(from).toISOString(), end_at:at(to).toISOString(), all_day:true, schedule_granularity:'date', status:'scheduled' });
const timed = (day, from, to, flags = true) => ({ start_at:at(day, from).toISOString(), end_at:at(day, to).toISOString(), ...(flags ? { all_day:false, schedule_granularity:'time' } : {}), status:'scheduled' });
const fs = (id, lag = 0) => [{ event_id:id, type:'finish_to_start', lag_minutes:lag }];
const byId = (list) => Object.fromEntries(Array.from(list, (item) => [item.id, item]));
const norm = (list) => list.map((event) => Scheduling.normalizeEvent(event));
const plain = (value) => JSON.parse(JSON.stringify(value));
const time = (value) => new Date(value).getTime();
const ids = (list) => Array.from(list, (item) => item.id);

test('events are ordered by their depends_on links', () => {
  const events = norm([
    { id:'gutters', title:'Gutters', event_type_default_id:'project_work', status:'unscheduled', duration_minutes:240, depends_on:fs('install') },
    { id:'install', title:'Install', event_type_default_id:'project_work', status:'unscheduled', duration_minutes:2880, all_day:true, schedule_granularity:'date', depends_on:fs('tearoff') },
    { id:'tearoff', title:'Tear-off', event_type_default_id:'project_work', status:'unscheduled', duration_minutes:1440, all_day:true, schedule_granularity:'date' },
  ]);
  assert.deepEqual(ids(Scheduling.orderByDependencies(events)), ['tearoff', 'install', 'gutters']);
});

test('moving a predecessor pushes violated successors later, keeps slack and time of day', () => {
  const events = norm([
    { id:'dry', ...allDay('2026-09-29', '2026-09-30') },
    { id:'install', ...allDay('2026-09-30', '2026-10-03'), depends_on:fs('dry') },
    { id:'cleanup', ...timed('2026-10-03', '09:00', '12:00'), depends_on:fs('install') },
    { id:'walk', ...timed('2026-10-04', '14:00', '15:00', false), depends_on:fs('cleanup') },
  ]);
  const later = Scheduling.dependencyRescheduleImpact(events, 'dry', { start:at('2026-09-30'), end:at('2026-10-01') });
  const drafts = byId(later.drafts);
  assert.deepEqual(Object.keys(drafts).sort(), ['cleanup', 'install'], 'the walkthrough still has slack and stays put');
  assert.equal(new Date(drafts.install.start_at).getTime(), at('2026-10-01').getTime());
  assert.equal(new Date(drafts.cleanup.start_at).getTime(), at('2026-10-04', '09:00').getTime(), 'timed successor keeps 09:00');
  const earlier = Scheduling.dependencyRescheduleImpact(events, 'install', { start:at('2026-10-01'), end:at('2026-10-04') });
  assert.equal(earlier.drafts.length, 1, 'only the cleanup is displaced');
  const pulled = Scheduling.cascadeDependentDrafts(events, 'dry', { start:at('2026-09-28'), end:at('2026-09-29') });
  assert.equal(pulled.length, 0, 'moving a predecessor earlier never pulls successors earlier');
});

test('locked and completed neighbours are reported instead of silently skipped', () => {
  const events = norm([
    { id:'tearoff', ...allDay('2026-09-27', '2026-09-29'), status:'completed', locked:true },
    { id:'dry', ...allDay('2026-09-29', '2026-09-30'), depends_on:fs('tearoff') },
    { id:'framing', ...allDay('2026-09-30', '2026-10-02'), locked:true, depends_on:fs('dry') },
    { id:'deck', ...allDay('2026-10-02', '2026-10-03'), depends_on:fs('framing', 1440) },
  ]);
  const forward = Scheduling.dependencyRescheduleImpact(events, 'dry', { start:at('2026-09-30'), end:at('2026-10-01') });
  assert.equal(forward.drafts.length, 0);
  assert.deepEqual(Array.from(forward.blocked, (entry) => [entry.event.id, entry.direction, entry.reason]), [['framing', 'successor', 'locked']]);
  const backward = Scheduling.dependencyRescheduleImpact(events, 'dry', { start:at('2026-09-28'), end:at('2026-09-29') });
  assert.deepEqual(Array.from(backward.blocked, (entry) => entry.event.id), ['tearoff']);
  assert.equal(Scheduling.dependencyViolations(events).length, 1, 'the one-day lag after framing is already violated');
});

// 2026-10-12 is a Monday.
const span = (id, from, to, extra = {}) => ({ id, kind:'schedule_group', title:id, ...allDay(from, to), ...extra });
const dayBefore = { anchor:'start', offset:{ value:-1, unit:'business_day' }, duration:{ value:1, unit:'day' }, all_day:true };

test('a start anchor with a negative business-day offset skips the weekend', () => {
  const events = norm([
    span('work', '2026-10-12', '2026-10-14'),
    { id:'delivery', parent_event_id:'work', placement:dayBefore, status:'unscheduled' },
  ]);
  const placed = Scheduling.placeChildren(events, 'work');
  assert.deepEqual(ids(placed.updated), ['delivery']);
  assert.equal(placed.blocked.length, 0);
  assert.equal(time(placed.updated[0].start_at), at('2026-10-09').getTime(), 'one business day before Monday is Friday');
  assert.equal(time(placed.updated[0].end_at), at('2026-10-10').getTime());
  assert.equal(placed.updated[0].status, 'scheduled');
  assert.equal(placed.updated[0].all_day, true);
  const adjusted = Scheduling.evaluatePlacement(
    { anchor:'start', offset:{ value:-2, unit:'day', adjust:{ calendar:'business_day', direction:'previous' } }, duration:{ value:1, unit:'day' }, all_day:true },
    { start:at('2026-10-12'), end:at('2026-10-14') }
  );
  assert.equal(adjusted.start.getTime(), at('2026-10-09').getTime(), 'a Saturday result moves back to Friday');
  const fromEnd = Scheduling.evaluatePlacement(
    { anchor:'end', offset:{ value:2, unit:'hours' }, duration:{ value:90, unit:'minute' }, all_day:false },
    { start:at('2026-10-12', '08:00'), end:at('2026-10-12', '16:00') }
  );
  assert.equal(fromEnd.start.getTime(), at('2026-10-12', '18:00').getTime());
  assert.equal(fromEnd.end.getTime(), at('2026-10-12', '19:30').getTime());
  assert.equal(fromEnd.all_day, false);
});

test('offsets and durations evaluate expressions over the parent and measurements', () => {
  const afterParent = { anchor:'start', offset:{ expression:{ ref:'parent.duration.days' }, unit:'day' }, all_day:true,
    duration:{ expression:{ operator:'ceil', left:{ operator:'divide', left:{ ref:'measurements.roof_squares' }, right:10 } }, unit:'day' } };
  const range = Scheduling.evaluatePlacement(afterParent, { start:at('2026-10-12'), end:at('2026-10-15') }, {}, { measurements:{ roof_squares:25 } });
  assert.equal(range.start.getTime(), at('2026-10-15').getTime(), 'three parent days after its start');
  assert.equal(range.end.getTime(), at('2026-10-18').getTime(), '25 squares at 10 a day is three days');
  assert.equal(Scheduling.evaluatePlacementExpression({ operator:'max', operands:[1, { ref:'parent.duration.minutes' }, { ref:'measurements.missing' }] }, { parent:{ duration:{ minutes:90 } } }), 90);
  assert.equal(Scheduling.evaluatePlacementExpression({ operator:'divide', left:4, right:0 }), 0);
  assert.deepEqual(plain(Scheduling.normalizePlacement({ anchor:'END', offset:2, duration:{ value:'3', unit:'Days' }, all_day:false })),
    { anchor:'end', offset:{ value:2, unit:'day' }, duration:{ unit:'day', value:3 }, all_day:false });
  assert.deepEqual(plain(Scheduling.normalizePlacement({ anchor:'span', offset:{ value:1 } })), { anchor:'span' });
  assert.equal(Scheduling.normalizePlacement({}), null);
});

test('a span-anchored child stretches when its parent is resized', () => {
  const events = norm([
    span('work', '2026-10-12', '2026-10-16'),
    { id:'lift', parent_event_id:'work', placement:{ anchor:'span' }, ...allDay('2026-10-12', '2026-10-14') },
  ]);
  const placed = Scheduling.placeChildren(events, 'work');
  assert.deepEqual(ids(placed.updated), ['lift']);
  assert.equal(time(placed.updated[0].start_at), at('2026-10-12').getTime());
  assert.equal(time(placed.updated[0].end_at), at('2026-10-16').getTime());
  assert.equal(placed.updated[0].duration_minutes, 4 * 1440);
});

test('locked and finished children stay put and are reported as blocked', () => {
  const events = norm([
    span('work', '2026-10-19', '2026-10-21'),
    { id:'locked', parent_event_id:'work', placement:dayBefore, ...allDay('2026-10-09', '2026-10-10'), locked:true },
    { id:'done', parent_event_id:'work', placement:dayBefore, ...allDay('2026-10-09', '2026-10-10'), status:'completed' },
    { id:'free', parent_event_id:'work', placement:dayBefore, ...allDay('2026-10-09', '2026-10-10') },
    { id:'under_locked', parent_event_id:'locked', placement:{ anchor:'span' }, ...allDay('2026-10-01', '2026-10-02') },
  ]);
  const placed = Scheduling.placeChildren(events, 'work');
  assert.deepEqual(ids(placed.blocked), ['locked', 'done']);
  assert.deepEqual(ids(placed.updated), ['free']);
  assert.equal(time(placed.updated[0].start_at), at('2026-10-16').getTime());
  assert.equal(time(events[1].start_at), at('2026-10-09').getTime(), 'the events passed in are not changed');
});

test('nested children follow, and a child without a placement does not', () => {
  const events = norm([
    span('work', '2026-10-19', '2026-10-23'),
    { id:'install', parent_event_id:'work', placement:{ anchor:'start', offset:{ value:1, unit:'day' }, all_day:true }, ...allDay('2026-10-13', '2026-10-15') },
    { id:'lift', parent_event_id:'install', placement:{ anchor:'span' }, ...allDay('2026-10-13', '2026-10-15') },
    { id:'loose', parent_event_id:'work', ...allDay('2026-10-13', '2026-10-14') },
    { id:'under_loose', parent_event_id:'loose', placement:{ anchor:'span' }, ...allDay('2026-10-01', '2026-10-02') },
  ]);
  const placed = byId(Scheduling.placeChildren(events, 'work').updated);
  assert.deepEqual(Object.keys(placed).sort(), ['install', 'lift']);
  assert.equal(time(placed.install.start_at), at('2026-10-20').getTime());
  assert.equal(time(placed.install.end_at), at('2026-10-22').getTime(), 'a placement without a duration keeps the child\'s length');
  assert.equal(time(placed.lift.start_at), at('2026-10-20').getTime());
  assert.equal(time(placed.lift.end_at), at('2026-10-22').getTime());
  assert.deepEqual(ids(Scheduling.eventDescendants(events, 'work')), ['install', 'loose', 'lift', 'under_loose']);
  assert.deepEqual(Array.from(Scheduling.eventAncestorIds(events, events[2])), ['install', 'work']);
  assert.deepEqual(Array.from(Scheduling.eventFamilyIds(events, events[1])).sort(), ['install', 'lift', 'work']);
  assert.equal(Scheduling.eventParentId(events[2]), 'install');
  assert.deepEqual(ids(Scheduling.eventChildren(events, 'work')), ['install', 'loose']);
  assert.equal(Scheduling.eventIsSpan(events[0]), true);
  assert.equal(Scheduling.eventIsSpan(events[1]), false);
});

test('an unscheduled parent unschedules its placed children', () => {
  const events = norm([
    { id:'work', kind:'schedule_group', status:'unscheduled' },
    { id:'install', parent_event_id:'work', placement:{ anchor:'span' }, ...allDay('2026-10-13', '2026-10-15') },
    { id:'lift', parent_event_id:'install', placement:{ anchor:'span' }, ...allDay('2026-10-13', '2026-10-15') },
    { id:'waiting', parent_event_id:'work', placement:{ anchor:'span' }, status:'unscheduled' },
  ]);
  const placed = Scheduling.placeChildren(events, 'work');
  assert.deepEqual(ids(placed.updated), ['install', 'lift']);
  placed.updated.forEach((child) => {
    assert.equal(child.status, 'unscheduled');
    assert.equal(child.start_at, '');
    assert.equal(child.end_at, '');
  });
});

test('a hand-moved child keeps its distance from the parent', () => {
  const parent = { start:at('2026-10-12'), end:at('2026-10-14') };
  const timedPlacement = Scheduling.manualPlacement({ start:at('2026-10-13', '09:00'), end:at('2026-10-13', '11:00'), all_day:false }, parent);
  assert.deepEqual(plain(timedPlacement), { anchor:'start', offset:{ value:33 * 60, unit:'minute' }, duration:{ value:120, unit:'minute' }, all_day:false, manual:true });
  const dayPlacement = Scheduling.manualPlacement({ start:at('2026-10-10'), end:at('2026-10-12'), all_day:true }, parent);
  assert.deepEqual(plain(dayPlacement), { anchor:'start', offset:{ value:-2, unit:'day' }, duration:{ value:2, unit:'day' }, all_day:true, manual:true });
  const movedParent = { start:at('2026-10-19'), end:at('2026-10-23') };
  const followed = Scheduling.evaluatePlacement(dayPlacement, movedParent);
  assert.equal(followed.start.getTime(), at('2026-10-17').getTime());
  assert.equal(followed.end.getTime(), at('2026-10-19').getTime(), 'it no longer stretches with the parent');
  assert.equal(Scheduling.normalizePlacement(timedPlacement).manual, true);
});

test('related reschedule impact places children and cascades depends_on links', () => {
  const linked = norm([
    { id:'a', ...allDay('2026-10-05', '2026-10-06') },
    { id:'b', ...allDay('2026-10-06', '2026-10-07'), depends_on:fs('a') },
  ]);
  const simple = Scheduling.relatedScheduleRescheduleImpact(linked[0], linked, { start:at('2026-10-06'), end:at('2026-10-07') }, { id:'p' });
  assert.deepEqual(ids(simple.drafts), ['b']);
  assert.deepEqual(ids(simple.dependents), ['b']);
  assert.equal(simple.children.length, 0);
  assert.deepEqual(ids(Scheduling.relatedScheduleRescheduleDrafts(linked[0], linked, { start:at('2026-10-06'), end:at('2026-10-07') }, { id:'p' })), ['b']);

  const events = norm([
    span('work', '2026-10-12', '2026-10-14'),
    { id:'install', parent_event_id:'work', placement:{ anchor:'span' }, ...allDay('2026-10-12', '2026-10-14') },
    { id:'delivery', parent_event_id:'work', placement:dayBefore, ...allDay('2026-10-09', '2026-10-10'), locked:true },
    { id:'cleanup', ...allDay('2026-10-14', '2026-10-15'), depends_on:fs('install') },
  ]);
  const impact = Scheduling.relatedScheduleRescheduleImpact(events[0], events, { start:at('2026-10-19'), end:at('2026-10-21') }, { id:'p' });
  assert.deepEqual(ids(impact.children), ['install']);
  assert.equal(time(impact.children[0].start_at), at('2026-10-19').getTime());
  assert.deepEqual(ids(impact.dependents), ['cleanup'], 'the cleanup waits for the re-placed install');
  assert.equal(time(impact.dependents[0].start_at), at('2026-10-21').getTime());
  assert.deepEqual(ids(impact.drafts), ['install', 'cleanup']);
  assert.deepEqual(Array.from(impact.blocked, (entry) => [entry.event.id, entry.direction, entry.reason, entry.related.id]), [['delivery', 'child', 'locked', 'work']]);
});

test('resources live in resource_refs only', () => {
  const event = {
    id:'e1',
    resource_refs:[
      { kind:'crew', id:'rg_1', name:'North team', unit_id:'unit_2' },
      { kind:'organization_connection', id:'conn_1', name:'Sub Co' },
      { kind:'equipment_type', id:'lift', name:'Boom lift', quantity:2, start_at:'2026-10-12T00:00:00.000Z', end_at:'2026-10-13T00:00:00.000Z' },
      { kind:'organization_user', id:'u_op', name:'Operator', role:'operator' },
      { kind:'resource_group', id:'RG_1', name:'Duplicate' },
      { kind:'resource_group', id:'e1', name:'Self' },
      { kind:'nonsense', id:'x' },
    ],
    assigned_user_ids:['U_2'],
    work_resource_ref:{ kind:'resource_group', id:'ignored' },
    assigned_crew_id:'ignored',
  };
  assert.deepEqual(plain(Scheduling.eventResources(event)), [
    { kind:'resource_group', id:'rg_1', name:'North team', role:'crew', unit_id:'unit_2' },
    { kind:'organization_connection', id:'conn_1', name:'Sub Co', role:'crew' },
    { kind:'equipment_type', id:'lift', name:'Boom lift', role:'equipment', quantity:2 },
    { kind:'organization_user', id:'u_op', name:'Operator', role:'operator' },
  ]);
  assert.deepEqual(ids(Scheduling.eventAssignees(event)), ['rg_1', 'conn_1', 'u_op']);
  assert.deepEqual(ids(Scheduling.eventEquipment(event)), ['lift']);
  assert.equal(Scheduling.eventPrimaryAssignee(event).id, 'rg_1');
  assert.equal(Scheduling.eventPrimaryAssignee({ resource_refs:[{ kind:'equipment_unit', id:'truck' }] }), null);
  assert.deepEqual(Array.from(Scheduling.eventAssigneeKeys(event)), ['resource_group:rg_1', 'organization_connection:conn_1', 'organization_user:u_op', 'organization_user:u_2']);
  assert.deepEqual(plain(Scheduling.eventWorkAssignees(event)), {
    crews:[{ kind:'resource_group', id:'rg_1', name:'North team', unit_id:'unit_2' }, { kind:'organization_connection', id:'conn_1', name:'Sub Co' }],
    people:[{ id:'U_2', name:'' }],
  });

  const reassigned = Scheduling.setEventWorkAssignees(event, [
    { kind:'resource_group', id:'rg_9', name:'South team', unit_id:'unit_7' },
    { kind:'person', id:'u_3', name:'Pat' },
  ]);
  assert.deepEqual(plain(reassigned.resource_refs), [
    { kind:'resource_group', id:'rg_9', name:'South team', role:'crew', unit_id:'unit_7' },
    { kind:'equipment_type', id:'lift', name:'Boom lift', role:'equipment', quantity:2 },
    { kind:'organization_user', id:'u_op', name:'Operator', role:'operator' },
  ]);
  assert.deepEqual(Array.from(reassigned.assigned_user_ids), ['u_3']);
  for (const field of ['crew_id', 'crew_name', 'assigned_crew_name', 'assigned_resource_id', 'resource_id']) assert.equal(field in reassigned, false, field);
  assert.deepEqual(ids(Scheduling.setEventWorkAssignees(event, []).resource_refs), ['lift', 'u_op']);

  const swapped = Scheduling.setEventPrimaryAssignee(event, { kind:'resource_group', id:'rg_5', name:'East team' });
  assert.deepEqual(ids(swapped.resource_refs), ['rg_5', 'conn_1', 'lift', 'u_op']);
  assert.deepEqual(ids(Scheduling.setEventPrimaryAssignee(event, null).resource_refs), ['lift', 'u_op']);

  const moved = Scheduling.updateProjectEventRange({ ...event, ...allDay('2026-10-12', '2026-10-13') }, { start:at('2026-10-14'), end:at('2026-10-15') });
  assert.equal(moved.resource_refs, event.resource_refs, 'a move leaves the resources alone');
  assert.equal('work_resource_ref' in Scheduling.createProjectEvent({ id:'p' }, 'project_work', { start:at('2026-10-12') }), false);

  const units = [{ id:'truck', subject_type:'equipment_unit' }];
  const booking = { id:'b1', ...allDay('2026-10-12', '2026-10-14'), resource_refs:[{ kind:'equipment_unit', id:'truck', start_at:at('2026-10-12').toISOString(), end_at:at('2026-10-13').toISOString() }] };
  const availability = Scheduling.availabilityForEquipment({ units, events:[booking], start:at('2026-10-13'), end:at('2026-10-14') });
  assert.equal(availability.hasAvailability, false, 'equipment is held for its event\'s whole range');
});

test('an event links to its list through scope_resource_list_id', () => {
  const delivery = { id:'d', scope_resource_list_id:'list_1', resource_type:'material', list_part_id:'part_2' };
  assert.equal(Scheduling.eventListId(delivery), 'list_1');
  assert.equal(Scheduling.eventListPartId(delivery), 'part_2');
  assert.equal(Scheduling.eventResourceType(delivery), 'material');
  assert.equal(Scheduling.materialListId(delivery), 'list_1');
  assert.equal(Scheduling.eventKind(delivery), 'material_delivery');
  assert.equal(Scheduling.eventKind({ scope_resource_list_id:'list_2', resource_type:'labor' }), 'project_work');
  assert.equal(Scheduling.eventKind({ material_list_id:'old', metadata:{ resource_type:'material' } }), 'custom');
  const group = Scheduling.createScheduleGroupEvent({ id:'p' }, { title:'Roof' });
  assert.equal(group.kind, 'schedule_group');
  assert.equal(Scheduling.eventIsSpan(group), true);
  assert.equal(Scheduling.eventCategory(group), 'production');
  for (const field of ['is_schedule_group', 'schedule_rollup', 'schedule_rule']) assert.equal(field in group, false, field);
});

test('a project event save passes the server\'s related results through', async () => {
  const calls = [];
  PlatformAPI.projects = {
    async scheduleEvent(orgId, projectId, event, options){
      calls.push(['save', orgId, projectId, event.id, options.branchId]);
      return {
        event:{ ...event, event_revision:2 },
        project:{ id:projectId, events:[{ ...event, event_revision:2 }] },
        related_events:[{ id:'child', event_revision:5, parent_event_id:event.id }],
        blocked_children:[{ id:'locked_child' }],
        assignee_conflicts:[{ event_id:event.id, assignee:{ kind:'resource_group', id:'rg_1', name:'North team' }, reason:'overlap', capacity:1, conflicts:[] }],
        equipment_conflicts:[],
      };
    },
    async scheduleOverlapCheck(orgId, payload){
      calls.push(['check', orgId, payload.project_id, payload.event.id, 'start' in payload.event, '__draft' in payload.event]);
      return { mode:'warn', assignee_conflicts:[{ event_id:payload.event.id }] };
    },
  };
  try {
    const project = { id:'p1', events:[{ id:'work', event_revision:1, ...allDay('2026-10-12', '2026-10-14') }, { id:'child', event_revision:4, parent_event_id:'work' }] };
    const saved = await Scheduling.saveProjectEvent('org', project, { ...project.events[0], ...allDay('2026-10-19', '2026-10-21') }, { branch_id:'east' });
    assert.deepEqual(plain(saved.related_events), [{ id:'child', event_revision:5, parent_event_id:'work' }]);
    assert.deepEqual(plain(saved.blocked_children), [{ id:'locked_child' }]);
    assert.equal(saved.assignee_conflicts[0].assignee.id, 'rg_1');
    assert.deepEqual(plain(saved.equipment_operator_warnings), []);
    const overlap = await Scheduling.checkAssigneeOverlap('org', { project_id:'p1', event:{ id:'draft', start:'2026-10-19T08:00:00.000Z', start_at:'2026-10-19T08:00:00.000Z', __draft:true } });
    assert.deepEqual(plain(overlap), { mode:'warn', assignee_conflicts:[{ event_id:'draft' }] });
    assert.deepEqual(calls, [['save', 'org', 'p1', 'work', 'east'], ['check', 'org', 'p1', 'draft', false, false]]);
  } finally {
    delete PlatformAPI.projects;
  }
});
