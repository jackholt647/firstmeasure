import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import vm from 'node:vm';

// Behaviour of the shared scheduling model for depends_on links, bundle
// placement and group rollups (libraries/platform-scheduling).
const publicRoot = path.resolve(import.meta.dirname, '..', '..');
const source = await readFile(path.join(publicRoot, 'libraries/platform-scheduling/platform-scheduling.js'), 'utf8');
const context = { window:{ PlatformAPI:{} }, console, Date, Math, Set, Map };
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

test('bundle placement follows depends_on order, lags and each item\'s own duration', () => {
  const events = norm([
    { id:'gutters', title:'Gutters', event_type_default_id:'project_work', status:'unscheduled', duration_minutes:240, depends_on:fs('install') },
    { id:'install', title:'Install', event_type_default_id:'project_work', status:'unscheduled', duration_minutes:2880, all_day:true, schedule_granularity:'date', depends_on:fs('tearoff') },
    { id:'tearoff', title:'Tear-off', event_type_default_id:'project_work', status:'unscheduled', duration_minutes:1440, all_day:true, schedule_granularity:'date' },
  ]);
  assert.deepEqual(Array.from(Scheduling.orderByDependencies(events), (event) => event.id), ['tearoff', 'install', 'gutters']);
  const tearoff = events.find((event) => event.id === 'tearoff');
  const drafts = byId(Scheduling.interpretScheduleBundle(tearoff, events, at('2026-10-12'), { id:'p' }, [], { workdayStartMinute:8 * 60 }));
  assert.equal(drafts.tearoff.start.getTime(), at('2026-10-12').getTime());
  assert.equal(drafts.install.start.getTime(), at('2026-10-13').getTime(), 'install waits for the tear-off');
  assert.equal(drafts.install.end.getTime(), at('2026-10-15').getTime(), 'install keeps its two days');
  assert.equal(drafts.gutters.all_day, false, 'a 4-hour item stays timed');
  assert.equal(drafts.gutters.start.getTime(), at('2026-10-15', '08:00').getTime(), 'timed successors start at the workday start, not midnight');
  assert.equal(drafts.gutters.end.getTime(), at('2026-10-15', '12:00').getTime());
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

test('related reschedule impact combines scope rules with depends_on links', () => {
  const events = norm([
    { id:'a', ...allDay('2026-10-05', '2026-10-06') },
    { id:'b', ...allDay('2026-10-06', '2026-10-07'), depends_on:fs('a') },
  ]);
  const impact = Scheduling.relatedScheduleRescheduleImpact(events[0], events, { start:at('2026-10-06'), end:at('2026-10-07') }, { id:'p' }, []);
  assert.deepEqual(Array.from(impact.drafts, (draft) => draft.id), ['b']);
  assert.deepEqual(Array.from(Scheduling.relatedScheduleRescheduleDrafts(events[0], events, { start:at('2026-10-06'), end:at('2026-10-07') }, { id:'p' }, []), (draft) => draft.id), ['b']);
});

test('groups roll up their items, move them together and refuse locked contents', () => {
  const events = norm([
    { id:'g', title:'Group', is_schedule_group:true, schedule_rollup:'auto', status:'unscheduled' },
    { id:'one', parent_event_id:'g', ...allDay('2026-10-12', '2026-10-13') },
    { id:'two', parent_event_id:'g', ...timed('2026-10-14', '09:00', '13:00') },
  ]);
  const rolled = byId(Scheduling.applyGroupRollups(events));
  assert.equal(new Date(rolled.g.start_at).getTime(), at('2026-10-12').getTime());
  assert.equal(new Date(rolled.g.end_at).getTime(), at('2026-10-15').getTime(), 'an all-day group ends at the end of its last item\'s day');
  assert.equal(rolled.g.status, 'scheduled');
  const updates = Scheduling.groupRollupUpdates(events, ['g']);
  assert.equal(updates.length, 1);
  assert.equal(updates[0].all_day, true);
  assert.deepEqual(Array.from(Scheduling.eventAncestorGroupIds(events, [events[2]])), ['g']);
  const move = Scheduling.groupMoveDrafts(events, rolled.g, { start:at('2026-10-19'), end:at('2026-10-22') });
  assert.equal(move.resized, false);
  assert.equal(move.blocked.length, 0);
  const moved = byId(move.drafts);
  assert.equal(new Date(moved.one.start_at).getTime(), at('2026-10-19').getTime());
  assert.equal(new Date(moved.two.start_at).getTime(), at('2026-10-21', '09:00').getTime());
  const locked = events.map((event) => event.id === 'one' ? { ...event, locked:true } : event);
  assert.deepEqual(Array.from(Scheduling.groupMoveDrafts(locked, rolled.g, { start:at('2026-10-19'), end:at('2026-10-22') }).blocked, (event) => event.id), ['one']);
  assert.equal(Scheduling.groupMoveDrafts(events, rolled.g, { start:at('2026-10-12'), end:at('2026-10-20') }).resized, true);
});
