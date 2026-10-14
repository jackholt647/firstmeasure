import { z } from "zod";
import { badRequest } from "../platform/errors.js";
import { listDocuments, readBranchModule, type JsonObject } from "../platform/storage.js";
import { resolveOrganizationTimezone, zonedInstant } from "../platform/timezone.js";
import { contentHash } from "../platform/publication/validation.js";
import { listAssigneeBases } from "./base.js";
import { ASSIGNEE_KIND_BY_NAME, assigneeKey, assigneeRefSchema, parseAssigneeKey, type AssigneeKind } from "./contract.js";
import { loadAssigneeDirectory, type DirectoryRow } from "./directory.js";
import { describeInterval, evaluateStaffingRequirements, staffingRequirementListSchema, type StaffingRequirementResult, type SourcedStaffingRequirement } from "./staffing-requirements.js";
import { listTimeOff } from "./time-off.js";

/**
 * Who is actually on a piece of work. See docs/architecture/assignee-base.md.
 *
 * An assignment is a list. Each entry adds or removes one assignee, for the whole of the work or for part of it:
 * crew A; crew A plus Dan; crew A minus Ben; crew A plus crew B; Dan covering Tuesday only. Entries apply in order and
 * a later one wins where they overlap.
 *
 * The effective roster is the people that leaves: the members of the groups, plus the people added, minus the people
 * removed, minus anyone who is off. Everything is compared as exact intervals, so someone off for a morning is off for
 * that morning and on for the afternoon. A person who is in two assigned groups is one person. An outside company stays
 * one party: nothing is known about who it sends.
 */
export type Interval = { from: string; until: string };
const instant = z.string().trim().max(40).refine((value) => Number.isFinite(Date.parse(value)), "Use an ISO date-time.");
export const assignmentEntrySchema = z.object({
  op: z.enum(["add", "remove"]).default("add"),
  assignee: assigneeRefSchema,
  /** Left out, the entry holds from the start of the work. */
  from: instant.optional(),
  /** Left out, the entry holds to the end of the work. */
  until: instant.optional()
}).strict().refine((value) => !value.from || !value.until || Date.parse(value.from) < Date.parse(value.until), "An entry must end after it starts.");
export const assignmentSchema = z.array(assignmentEntrySchema).max(200);
export type AssignmentEntry = z.infer<typeof assignmentEntrySchema>;
export const rosterWindowSchema = z.object({ from: instant, until: instant }).strict().refine((value) => Date.parse(value.from) < Date.parse(value.until), "The window must end after it starts.");

type Span = [number, number];
const merge = (spans: Span[]): Span[] => {
  const out: Span[] = [];
  for (const [start, end] of [...spans].filter(([start, end]) => start < end).sort((a, b) => a[0] - b[0])) {
    const last = out.at(-1);
    if (last && start <= last[1]) last[1] = Math.max(last[1], end); else out.push([start, end]);
  }
  return out;
};
const subtract = (spans: Span[], cut: Span[]): Span[] => {
  let out = merge(spans);
  for (const [cutStart, cutEnd] of merge(cut)) out = out.flatMap(([start, end]): Span[] => (cutEnd <= start || cutStart >= end ? [[start, end]] : [[start, Math.min(end, cutStart)], [Math.max(start, cutEnd), end]])).filter(([start, end]) => start < end);
  return out;
};
const intersect = (spans: Span[], other: Span[]): Span[] => merge(spans.flatMap(([start, end]) => merge(other).map(([otherStart, otherEnd]): Span => [Math.max(start, otherStart), Math.min(end, otherEnd)])));
const intervals = (spans: Span[]): Interval[] => spans.map(([start, end]) => ({ from: new Date(start).toISOString(), until: new Date(end).toISOString() }));

/** What the resolver needs to know about one person. */
export type RosterPersonFacts = { id: string; user_id: string; name: string; status: string; type_ids: string[]; tag_ids: string[]; department_ids: string[]; group_ids: string[]; fields: Record<string, unknown> };
export type RosterDirectory = {
  /** Every assignee an entry can name, by key. `member_ids` are person keys. */
  assignees: Map<string, { id: string; kind: AssigneeKind; name: string; status: string; type_ids: string[]; tag_ids: string[]; member_ids: string[] }>;
  people: Map<string, RosterPersonFacts>;
};
/** One stretch in which an assignee cannot work, and where that is recorded. */
export type Unavailability = Interval & { assignee_id: string; reason: string; source: "time_off" | "schedule_exception"; source_id: string };
/** Another piece of work that holds people during the window. */
export type OtherWork = { id: string; title: string; project_id: string; from: string; until: string; assignment: AssignmentEntry[] };

export type RosterPerson = Omit<RosterPersonFacts, "status"> & {
  /** The entries' assignees that put them on the work: their own key, or the groups they came with. */
  via: string[];
  /** Exactly when they are on the work, inside the window. */
  present: Interval[];
  /** True when they are on it for the whole window. */
  whole_window: boolean;
  /** Stretches they were taken off by a `remove` entry. */
  removed: Interval[];
  /** Stretches they would have been on the work and are off. */
  unavailable: Array<Interval & { reason: string; source: string; source_id: string }>;
};
export type RosterAbsent = Omit<RosterPerson, "present" | "whole_window"> & { reason: "unavailable" | "removed" | "inactive" };
export type RosterConflict = { id: string; person_id: string; name: string; work: { id: string; title: string; project_id: string }; intervals: Interval[] };
export type Roster = {
  window: Interval;
  /** The assignees the list adds, in order, for saying who was assigned. */
  assigned: Array<{ id: string; kind: AssigneeKind; name: string }>;
  /** The people on the work for any part of the window. */
  people: RosterPerson[];
  /** People the list names who are not on the work at all, and why. */
  absent: RosterAbsent[];
  /** Outside companies on the work. Each is one party. */
  parties: Array<{ id: string; name: string; type_ids: string[]; tag_ids: string[]; present: Interval[]; unavailable: RosterPerson["unavailable"] }>;
  /** People who are on this work and on other work at the same time, with the exact overlap. A warning, never a refusal. */
  conflicts: RosterConflict[];
  /** Entries naming an assignee that does not exist or has been archived. */
  unknown: Array<{ id: string; op: string }>;
  /** The window cut wherever the roster changes: who is on the work in each stretch. */
  timeline: Array<Interval & { person_ids: string[]; party_ids: string[] }>;
  /** What is true of the roster as a whole, for duration formulas, pay and conditions. */
  facts: {
    /** People on the work at any time in the window. */
    count: number;
    /** The fewest and the most people on the work at one moment. */
    min_count: number; max_count: number;
    party_count: number;
    /** Person-hours on the work across the window. */
    person_hours: number;
    type_ids: string[]; tag_ids: string[];
    person_ids: string[];
    /** Each field any person has, as the list of their values. */
    fields: Record<string, unknown>;
  };
};

type Nominal = { present: Span[]; removed: Span[]; via: Set<string> };
/** Applies the entries in order. No time off yet: this is who the list itself puts on the work. */
function applyEntries(assignment: AssignmentEntry[], window: Span, directory: RosterDirectory, unknown?: Roster["unknown"]) {
  const people = new Map<string, Nominal>(), parties = new Map<string, Nominal>();
  const slot = (map: Map<string, Nominal>, key: string) => { if (!map.has(key)) map.set(key, { present: [], removed: [], via: new Set() }); return map.get(key)!; };
  for (const entry of assignment) {
    const key = assigneeKey(entry.assignee);
    const assignee = directory.assignees.get(key);
    if (!assignee || assignee.status === "archived") { unknown?.push({ id: key, op: entry.op }); continue; }
    const span: Span = [Math.max(window[0], entry.from ? Date.parse(entry.from) : window[0]), Math.min(window[1], entry.until ? Date.parse(entry.until) : window[1])];
    if (span[0] >= span[1]) continue;
    const targets: [Map<string, Nominal>, string][] = assignee.kind === "organization_connection" ? [[parties, key]] : assignee.kind === "resource_group" ? assignee.member_ids.map((id) => [people, id]) : [[people, key]];
    for (const [map, target] of targets) {
      const state = slot(map, target);
      if (entry.op === "remove") { state.removed = merge([...state.removed, ...intersect(state.present, [span])]); state.present = subtract(state.present, [span]); }
      else { state.present = merge([...state.present, span]); state.removed = subtract(state.removed, [span]); state.via.add(key); }
    }
  }
  return { people, parties };
}

function listFields(people: Array<Record<string, unknown>>) {
  const out: Record<string, unknown> = {};
  const scalar = (value: unknown) => ["string", "number", "boolean"].includes(typeof value);
  const add = (target: Record<string, unknown>, fields: Record<string, unknown>, depth: number) => {
    for (const [key, value] of Object.entries(fields)) {
      if (value === undefined || value === null) continue;
      if (scalar(value)) { if (!Array.isArray(target[key])) target[key] = []; (target[key] as unknown[]).push(value); }
      else if (Array.isArray(value)) { if (!Array.isArray(target[key])) target[key] = []; (target[key] as unknown[]).push(...value.filter(scalar)); }
      else if (depth < 6) { if (!target[key] || Array.isArray(target[key])) target[key] = {}; add(target[key] as Record<string, unknown>, value as Record<string, unknown>, depth + 1); }
    }
  };
  for (const fields of people) add(out, fields, 0);
  return out;
}

/**
 * The effective roster of an assignment over a window. Pure: it is given the directory, the time off and the other
 * work, and reads nothing. `loadRoster` gathers those from the stores.
 */
export function resolveRoster(input: { assignment: AssignmentEntry[]; window: Interval; directory: RosterDirectory; unavailable?: Unavailability[]; other_work?: OtherWork[] }): Roster {
  const window: Span = [Date.parse(input.window.from), Date.parse(input.window.until)];
  if (!(window[0] < window[1])) throw badRequest("roster_window_invalid", "The window must end after it starts.");
  const unknown: Roster["unknown"] = [];
  const nominal = applyEntries(input.assignment, window, input.directory, unknown);
  const off = new Map<string, Unavailability[]>();
  for (const entry of input.unavailable || []) off.set(entry.assignee_id, [...(off.get(entry.assignee_id) || []), entry]);
  const offDuring = (key: string, present: Span[]) => (off.get(key) || [])
    .flatMap((entry) => intersect(present, [[Date.parse(entry.from), Date.parse(entry.until)]]).map(([start, end]) => ({ from: new Date(start).toISOString(), until: new Date(end).toISOString(), reason: entry.reason, source: entry.source as string, source_id: entry.source_id })))
    .sort((a, b) => a.from.localeCompare(b.from));

  const people: Array<RosterPerson & { spans: Span[] }> = [], absent: RosterAbsent[] = [];
  for (const [key, state] of nominal.people) {
    const facts = input.directory.people.get(key);
    const { status, ...person } = facts || { id: key, user_id: parseAssigneeKey(key)?.id || key, name: parseAssigneeKey(key)?.id || key, status: "missing", type_ids: [], tag_ids: [], department_ids: [], group_ids: [], fields: {} };
    const unavailable = status === "active" ? offDuring(key, state.present) : [];
    const spans = status === "active" ? subtract(state.present, unavailable.map((entry): Span => [Date.parse(entry.from), Date.parse(entry.until)])) : [];
    const shared = { ...person, via: [...state.via].sort(), removed: intervals(state.removed), unavailable };
    if (spans.length) people.push({ ...shared, present: intervals(spans), whole_window: spans.length === 1 && spans[0]![0] === window[0] && spans[0]![1] === window[1], spans });
    // Someone the list never put on the work (a remove with no add before it) is simply not part of it.
    else if (state.via.size) absent.push({ ...shared, reason: status !== "active" ? "inactive" : unavailable.length ? "unavailable" : "removed" });
  }
  people.sort((a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id));
  absent.sort((a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id));

  const parties = [...nominal.parties].map(([key, state]) => {
    const assignee = input.directory.assignees.get(key)!;
    const unavailable = offDuring(key, state.present);
    const spans = subtract(state.present, unavailable.map((entry): Span => [Date.parse(entry.from), Date.parse(entry.until)]));
    return { id: key, name: assignee.name, type_ids: assignee.type_ids, tag_ids: assignee.tag_ids, present: intervals(spans), unavailable, spans };
  }).filter((party) => party.spans.length || party.unavailable.length).sort((a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id));

  // Other work holds a person when its own list puts them on it. Their time off is not asked: this is about being promised twice.
  const conflicts: RosterConflict[] = [];
  for (const work of input.other_work || []) {
    const other: Span = [Date.parse(work.from), Date.parse(work.until)];
    if (!(other[0] < window[1] && window[0] < other[1])) continue;
    const held = applyEntries(work.assignment, other, input.directory).people;
    for (const person of people) {
      const overlap = intersect(person.spans, held.get(person.id)?.present || []);
      if (overlap.length) conflicts.push({ id: `conflict:${contentHash([person.id, work.project_id, work.id, overlap]).slice(0, 24)}`, person_id: person.id, name: person.name, work: { id: work.id, title: work.title, project_id: work.project_id }, intervals: intervals(overlap) });
    }
  }
  conflicts.sort((a, b) => a.name.localeCompare(b.name) || a.intervals[0]!.from.localeCompare(b.intervals[0]!.from) || a.work.id.localeCompare(b.work.id));

  const edges = [...new Set([window[0], window[1], ...people.flatMap((person) => person.spans.flat()), ...parties.flatMap((party) => party.spans.flat())])].sort((a, b) => a - b);
  const timeline: Roster["timeline"] = [];
  for (let index = 0; index < edges.length - 1; index += 1) {
    const start = edges[index]!, end = edges[index + 1]!;
    const on = (spans: Span[]) => spans.some(([spanStart, spanEnd]) => spanStart <= start && spanEnd >= end);
    const segment = { from: new Date(start).toISOString(), until: new Date(end).toISOString(), person_ids: people.filter((person) => on(person.spans)).map((person) => person.id), party_ids: parties.filter((party) => on(party.spans)).map((party) => party.id) };
    const last = timeline.at(-1);
    if (last && last.person_ids.join("|") === segment.person_ids.join("|") && last.party_ids.join("|") === segment.party_ids.join("|")) last.until = segment.until; else timeline.push(segment);
  }
  const counts = timeline.map((segment) => segment.person_ids.length);
  const unique = (values: string[]) => [...new Set(values.filter(Boolean))].sort();
  const published = people.map(({ spans: _spans, ...person }) => person);
  // An assignee the list adds and then takes off again in full was not, in the end, assigned.
  const holds = (assignee: { id: string; kind: AssigneeKind; member_ids: string[] }) => (assignee.kind === "organization_connection" ? [nominal.parties.get(assignee.id)] : assignee.kind === "resource_group" ? assignee.member_ids.map((id) => nominal.people.get(id)) : [nominal.people.get(assignee.id)]).some((state) => !!state?.present.length);
  const added = input.assignment.filter((entry) => entry.op === "add").map((entry) => input.directory.assignees.get(assigneeKey(entry.assignee))).filter((assignee): assignee is NonNullable<typeof assignee> => !!assignee && assignee.status !== "archived" && holds(assignee));
  return {
    window: { from: new Date(window[0]).toISOString(), until: new Date(window[1]).toISOString() },
    assigned: [...new Map(added.map((assignee) => [assignee.id, { id: assignee.id, kind: assignee.kind, name: assignee.name }])).values()],
    people: published, absent,
    parties: parties.filter((party) => party.spans.length).map(({ spans: _spans, ...party }) => party),
    conflicts, unknown, timeline,
    facts: {
      count: published.length, min_count: Math.min(...counts), max_count: Math.max(...counts), party_count: parties.filter((party) => party.spans.length).length,
      person_hours: Math.round(people.reduce((total, person) => total + person.spans.reduce((sum, [start, end]) => sum + (end - start), 0), 0) / 36_000) / 100,
      type_ids: unique(published.flatMap((person) => person.type_ids)), tag_ids: unique(published.flatMap((person) => person.tag_ids)),
      person_ids: published.map((person) => person.id), fields: listFields(published.map((person) => person.fields))
    }
  };
}
/** Who is on the work at one instant. */
export function rosterAt(roster: Roster, at: string) {
  const moment = Date.parse(at);
  const segment = roster.timeline.find((entry) => Date.parse(entry.from) <= moment && moment < Date.parse(entry.until));
  return { person_ids: segment?.person_ids || [], party_ids: segment?.party_ids || [] };
}

// ---- Gathering what the resolver needs ----
const text = (value: unknown) => String(value ?? "").trim();
const obj = (value: unknown): JsonObject => (value && typeof value === "object" && !Array.isArray(value) ? value as JsonObject : {});

export function rosterDirectory(rows: DirectoryRow[]): RosterDirectory {
  return {
    assignees: new Map(rows.map((row) => [row.id, { id: row.id, kind: row.kind, name: row.name, status: row.status, type_ids: row.type_ids, tag_ids: row.tag_ids, member_ids: row.member_ids }])),
    people: new Map(rows.filter((row) => row.kind === "organization_user").map((row) => [row.id, { id: row.id, user_id: row.assignee_id, name: row.name, status: row.status, type_ids: row.type_ids, tag_ids: row.tag_ids, department_ids: row.department_ids, group_ids: row.group_ids, fields: row.fields }]))
  };
}

/**
 * The assignment list a schedule event carries. An event names its assignees in `resource_refs`; an entry there may
 * say `op: "remove"` and may carry `from` / `until`. People in `assigned_user_ids` are added for the whole event.
 * `changes` are events whose only job is to change the roster for their own range (a child event for "Dan covers
 * Tuesday"): their entries are limited to that range. Equipment is skipped. Pure.
 */
export function assignmentFromEvent(eventValue: unknown, changes: unknown[] = []): AssignmentEntry[] {
  const entries: AssignmentEntry[] = [];
  const read = (value: unknown, limit?: Interval) => {
    const event = obj(value);
    for (const raw of Array.isArray(event.resource_refs) ? event.resource_refs : []) {
      const ref = obj(raw), kind = ASSIGNEE_KIND_BY_NAME[text(ref.kind).toLowerCase()], id = text(ref.id);
      const parsed = kind && id ? assignmentEntrySchema.safeParse({ op: text(ref.op) === "remove" ? "remove" : "add", assignee: { type: kind, id }, ...(limit || {}), ...(text(ref.from) ? { from: text(ref.from) } : {}), ...(text(ref.until) ? { until: text(ref.until) } : {}) }) : null;
      if (parsed?.success) entries.push(parsed.data);
    }
    for (const userId of [...(Array.isArray(event.assigned_user_ids) ? event.assigned_user_ids : []), event.assigned_user_id].map(text).filter(Boolean)) {
      if (entries.some((entry) => entry.op === "add" && entry.assignee.type === "organization_user" && entry.assignee.id === userId && !entry.from && !entry.until)) continue;
      const parsed = assignmentEntrySchema.safeParse({ op: "add", assignee: { type: "organization_user", id: userId }, ...(limit || {}) });
      if (parsed.success) entries.push(parsed.data);
    }
  };
  read(eventValue);
  for (const change of changes) { const window = eventWindow(change); if (window) read(change, window); }
  return entries;
}
/** The range an event holds, or null when it holds none (unscheduled or cancelled). */
export function eventWindow(eventValue: unknown): Interval | null {
  const event = obj(eventValue);
  if (["unscheduled", "canceled", "cancelled"].includes(text(event.status).toLowerCase())) return null;
  const start = Date.parse(text(event.start_at));
  if (!Number.isFinite(start)) return null;
  const explicit = Date.parse(text(event.end_at));
  const end = Number.isFinite(explicit) && explicit > start ? explicit : start + Math.max(1, Number(event.duration_minutes || 60)) * 60_000;
  return { from: new Date(start).toISOString(), until: new Date(end).toISOString() };
}
/** Every scheduled event that touches the window and names an assignee, as other work. Reads only. */
export async function scheduledWork(orgId: string, window: Interval, excludeIds: string[] = []): Promise<OtherWork[]> {
  const found: OtherWork[] = [];
  const skip = new Set(excludeIds);
  const add = (eventValue: unknown, projectId: string, projectTitle: string) => {
    const event = obj(eventValue), range = eventWindow(event), id = text(event.id);
    if (!range || !id || skip.has(id) || !(Date.parse(range.from) < Date.parse(window.until) && Date.parse(window.from) < Date.parse(range.until))) return;
    const assignment = assignmentFromEvent(event);
    if (assignment.length) found.push({ id, title: text(event.title) || projectTitle, project_id: projectId, ...range, assignment });
  };
  for (const document of await listDocuments(orgId, "projects")) {
    const data = obj(document.data);
    for (const event of Array.isArray(data.events) ? data.events : []) add(event, document.id, text(data.title || data.customer_name || data.address));
  }
  for (const document of await listDocuments(orgId, "calendar_events")) add({ ...obj(document.data), id: document.id }, "", "");
  return found;
}
/**
 * Whole days marked unavailable in the scheduling settings (`resource_availability["<kind>:<id>"].exceptions`, each
 * `{ date, available: false }`), as the exact interval that local day covers. Reads only.
 */
export async function scheduleExceptions(orgId: string, branchId: string, window: Interval): Promise<Unavailability[]> {
  const module = await readBranchModule(orgId, branchId || "default", "scheduling").catch(() => null);
  const rules = obj(obj(obj(module).data).resource_availability);
  if (!Object.keys(rules).length) return [];
  const timezone = await resolveOrganizationTimezone(orgId, branchId || "default");
  const found: Unavailability[] = [];
  for (const [key, rule] of Object.entries(rules)) {
    const ref = parseAssigneeKey(key);
    if (!ref) continue;
    for (const exception of (Array.isArray(obj(rule).exceptions) ? obj(rule).exceptions as unknown[] : []).map(obj)) {
      const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(text(exception.date));
      if (!match || exception.available !== false) continue;
      const [year, month, day] = [Number(match[1]), Number(match[2]), Number(match[3])];
      const next = new Date(Date.UTC(year, month - 1, day + 1));
      const from = zonedInstant(year, month, day, 0, 0, timezone).toISOString(), until = zonedInstant(next.getUTCFullYear(), next.getUTCMonth() + 1, next.getUTCDate(), 0, 0, timezone).toISOString();
      if (from < window.until && window.from < until) found.push({ assignee_id: assigneeKey(ref), from, until, reason: text(exception.reason || exception.note) || "Day off", source: "schedule_exception", source_id: `${key}:${text(exception.date)}` });
    }
  }
  return found;
}

export const rosterInputSchema = z.object({
  assignment: assignmentSchema,
  from: instant,
  until: instant,
  /** Events that are this work itself or its family, which it can never conflict with. */
  exclude_event_ids: z.array(z.string().trim().min(1).max(200)).max(200).optional(),
  /** The branch whose scheduling settings hold day-off exceptions. */
  branch_id: z.string().trim().max(120).optional()
}).strict();
export type RosterSources = { other_work?: OtherWork[]; unavailable?: Unavailability[] };

/**
 * Resolves the roster from the stores: the assignee directory, the fields of the people involved, recorded time off,
 * the scheduling settings' day-off exceptions and everything else on the schedule in the window. Reads only. A caller
 * that already holds the schedule as it will be after a save passes it as `sources.other_work`.
 */
export async function loadRoster(orgId: string, input: unknown, sources: RosterSources = {}): Promise<{ roster: Roster; rows: DirectoryRow[]; timezone: string }> {
  const parsed = rosterInputSchema.parse(input);
  const window = rosterWindowSchema.parse({ from: parsed.from, until: parsed.until });
  // Only the people the list can reach have their fields read.
  const { rows } = await loadAssigneeDirectory(orgId, { fieldsFor: (records) => {
    const named = new Set<string>();
    for (const entry of parsed.assignment) {
      const record = records.get(assigneeKey(entry.assignee));
      if (record?.kind === "organization_user") named.add(record.ref.id);
      for (const member of record?.members || []) named.add(member.user_id);
    }
    return [...named];
  } });
  const branchId = parsed.branch_id || "default";
  const [timeOff, exceptions, otherWork, timezone] = await Promise.all([
    sources.unavailable ? [] : listTimeOff(orgId, window),
    sources.unavailable ? [] : scheduleExceptions(orgId, branchId, window),
    sources.other_work || scheduledWork(orgId, window, parsed.exclude_event_ids),
    resolveOrganizationTimezone(orgId, branchId)
  ]);
  const unavailable: Unavailability[] = sources.unavailable || [
    ...timeOff.map((entry): Unavailability => ({ assignee_id: entry.assignee_id, from: entry.from, until: entry.until, reason: entry.reason || "Time off", source: "time_off", source_id: entry.id })),
    ...exceptions
  ];
  return { roster: resolveRoster({ assignment: parsed.assignment, window, directory: rosterDirectory(rows), unavailable, other_work: otherWork }), rows, timezone };
}

// ---- "What is wrong with this assignment" ----
export const checkInputSchema = z.object({
  assignment: assignmentSchema, from: instant, until: instant,
  exclude_event_ids: z.array(z.string().trim().min(1).max(200)).max(200).optional(),
  branch_id: z.string().trim().max(120).optional(),
  /** The work's own staffing requirements. The standing ones of every group the list adds are checked as well. */
  staffing_requirements: staffingRequirementListSchema.optional(),
  /** Ids of warnings someone has already accepted. They are still returned, marked accepted. */
  accepted: z.array(z.string().trim().min(1).max(200)).max(500).optional()
}).strict();
export type AssignmentWarning = {
  id: string;
  kind: "staffing_requirement_unmet" | "double_booked" | "unavailable" | "unknown_assignee" | "nobody_assigned";
  message: string;
  accepted: boolean;
  person_id?: string; staffing_requirement_id?: string;
  intervals: Interval[];
};
export type AssignmentCheck = { ok: boolean; roster: Roster; staffing_requirements: StaffingRequirementResult[]; warnings: AssignmentWarning[]; timezone: string };

/**
 * Everything worth telling a scheduler about an assignment: staffing requirements that are not met, people promised to two
 * things at once, people who are off, and entries that name no one. These are warnings. Nothing here refuses or blocks
 * anything; `ok` only says whether any warning is still unaccepted.
 */
export async function checkAssignment(orgId: string, input: unknown, sources: RosterSources = {}): Promise<AssignmentCheck> {
  const { staffing_requirements: own = [], accepted = [], ...rosterInput } = checkInputSchema.parse(input);
  const { roster, timezone } = await loadRoster(orgId, rosterInput, sources);
  const groups = new Set(roster.assigned.filter((entry) => entry.kind === "resource_group").map((entry) => entry.id));
  const standing: SourcedStaffingRequirement[] = (await listAssigneeBases(orgId))
    .filter((base) => groups.has(assigneeKey(base.assignee)))
    .flatMap((base) => base.staffing_requirements.map((requirement) => ({ ...requirement, source: { kind: "assignee" as const, id: assigneeKey(base.assignee), name: roster.assigned.find((entry) => entry.id === assigneeKey(base.assignee))?.name || "" } })));
  const results = evaluateStaffingRequirements(roster, [...own.map((requirement) => ({ ...requirement, source: { kind: "work" as const } })), ...standing], { timezone });
  const list = (items: Interval[]) => items.map((interval) => describeInterval(interval, timezone)).join(", ");
  const empty = roster.timeline.filter((segment) => !segment.person_ids.length && !segment.party_ids.length).map(({ from, until }) => ({ from, until }));
  const warnings: Omit<AssignmentWarning, "accepted">[] = [
    ...results.filter((result) => !result.met).map((result) => ({ id: result.id, kind: "staffing_requirement_unmet" as const, message: result.reason, staffing_requirement_id: result.staffing_requirement_id, intervals: result.unmet.map(({ from, until }) => ({ from, until })) })),
    ...roster.conflicts.map((conflict) => ({ id: conflict.id, kind: "double_booked" as const, message: `${conflict.name} is also on ${conflict.work.title || "other work"} ${list(conflict.intervals)}.`, person_id: conflict.person_id, intervals: conflict.intervals })),
    ...[...roster.people, ...roster.absent].filter((person) => person.unavailable.length).map((person) => ({
      id: `unavailable:${contentHash([person.id, person.unavailable.map((entry) => [entry.from, entry.until])]).slice(0, 24)}`, kind: "unavailable" as const,
      message: `${person.name} is off ${list(person.unavailable)}${person.unavailable[0]!.reason ? ` (${person.unavailable[0]!.reason})` : ""} and is not counted on the work then.`, person_id: person.id, intervals: person.unavailable.map(({ from, until }) => ({ from, until }))
    })),
    ...roster.parties.filter((party) => party.unavailable.length).map((party) => ({ id: `unavailable:${contentHash([party.id, party.unavailable.map((entry) => [entry.from, entry.until])]).slice(0, 24)}`, kind: "unavailable" as const, message: `${party.name} is not available ${list(party.unavailable)}.`, intervals: party.unavailable.map(({ from, until }) => ({ from, until })) })),
    ...roster.unknown.map((entry) => ({ id: `unknown:${entry.id}`, kind: "unknown_assignee" as const, message: `${entry.id} is no longer available in this organization, so that entry puts no one on the work.`, intervals: [] })),
    ...(empty.length && rosterInput.assignment.length ? [{ id: `nobody:${contentHash(empty.map((interval) => [interval.from, interval.until])).slice(0, 24)}`, kind: "nobody_assigned" as const, message: `No one is on the work ${list(empty)}.`, intervals: empty }] : [])
  ];
  const marked = warnings.map((warning) => ({ ...warning, accepted: accepted.includes(warning.id) }));
  return { ok: marked.every((warning) => warning.accepted), roster, staffing_requirements: results, warnings: marked, timezone };
}
