import { z } from "zod";
import type { PlatformAuthContext } from "../platform/auth.js";
import { listDocuments, readDocument, type JsonObject } from "../platform/storage.js";
import { resolveOrganizationTimezone, zonedInstant, zonedParts } from "../platform/timezone.js";
import { contentHash } from "../platform/publication/validation.js";
import { listAssigneeRecords } from "../assignees/base.js";
import { assignmentFromEvent, checkAssignment, eventWindow as rosterWindow, scheduleExceptions, type AssignmentCheck, type AssignmentEntry, type Interval, type OtherWork, type Unavailability } from "../assignees/roster.js";
import { describeInterval, staffingRequirementSchema, type StaffingRequirement } from "../assignees/staffing-requirements.js";
import { listTimeOff } from "../assignees/time-off.js";
import { assessAssigneeOverlap, type AssigneeConflict, type OverlapMode, type OverlapSubject } from "./occupancy.js";
import { eventDescendants, eventFamilyIds, eventParentId, isAssigneeKind, resourceRefKind } from "./event-model.js";
import { placeChildren } from "./placement.js";

/**
 * Who is on each schedule event, and what is wrong with it, from the assignee base's roster and check. See
 * docs/architecture/schedule-events.md ("Roster and warnings").
 *
 * Everything here reads. The answer is derived: it is returned beside the events and never written into them. Warnings
 * never block anything; what an overlap does (warn, block, allow) stays the organization's and the assignee's setting,
 * read by `assessAssigneeOverlap`, which is fed the roster's people so a person in two groups is counted once.
 */

const text = (value: unknown) => String(value ?? "").trim();
const obj = (value: unknown): JsonObject => (value && typeof value === "object" && !Array.isArray(value) ? value as JsonObject : {});
const list = (value: unknown): unknown[] => (Array.isArray(value) ? value : []);

export const MAX_ROSTER_EVENTS = 200;
const MAX_ROSTER_DAYS = 62;
const id = z.string().trim().min(1).max(200);
export const eventRosterInputSchema = z.object({
  /** Saved events to read, each by its project (left out for a calendar event with no project). */
  events: z.array(z.object({ project_id: z.string().trim().max(200).optional(), event_id: id }).strict()).max(MAX_ROSTER_EVENTS).optional(),
  /** A draft being placed: the event as it would be saved. Its children are re-placed against it, as the save would. */
  draft: z.object({ project_id: z.string().trim().max(200).optional(), event: z.record(z.unknown()) }).strict().optional(),
  /** Also answer for every event under each one asked for. Default true. */
  include_children: z.boolean().optional()
}).strict();
export type EventRosterInput = z.infer<typeof eventRosterInputSchema>;

export type RosterWarningKind = AssignmentCheck["warnings"][number]["kind"] | "assignee_overlap" | "missing_member";
export type EventRosterWarning = {
  id: string; kind: RosterWarningKind; message: string; accepted: boolean;
  /** `warn` for everything the roster says; an overlap carries the assignee's overlap setting (`warn` or `block`). */
  mode: Exclude<OverlapMode, "allow">;
  person_id?: string; assignee_id?: string; staffing_requirement_id?: string;
  intervals: Interval[];
};
export type EventRosterPerson = { id: string; user_id: string; name: string; via: string[]; whole_window: boolean; present: Interval[] };
export type EventRoster = {
  people: EventRosterPerson[];
  parties: Array<{ id: string; name: string; present: Interval[] }>;
  absent: Array<{ id: string; name: string; reason: string }>;
  count: number; party_count: number; min_count: number; max_count: number;
  /** Who is on the event on each local day it touches (organization timezone). */
  days: Array<{ date: string; person_ids: string[]; party_ids: string[] }>;
};
export type EventRosterRead = {
  event_id: string; project_id: string; parent_event_id: string;
  /** True for the draft and the children it re-placed: this is how it would be after a save. */
  draft: boolean;
  window: Interval | null;
  roster: EventRoster | null;
  staffing_requirements: AssignmentCheck["staffing_requirements"];
  warnings: EventRosterWarning[];
  assignee_conflicts: AssigneeConflict[];
  error: string;
};
export type EventRosterResult = { timezone: string; overlap_mode: OverlapMode; events: EventRosterRead[] };

type Item = { event: JsonObject; projectId: string; projectTitle: string; projectEvents: JsonObject[]; draft: boolean; project: JsonObject };

/** Which assignees the reader may see: every one, unless branch scope restricts them (docs/architecture/branches.md). */
async function visibleAssignees(orgId: string, auth: PlatformAuthContext | null | undefined): Promise<((key: string) => boolean)> {
  if (!auth) return () => true;
  const { branchScope, canSeeBranches } = await import("../workforce/branch-scope.js");
  const scope = branchScope(auth);
  if (!scope.restricted_view) return () => true;
  const visible = new Set((await listAssigneeRecords(orgId)).filter((record) => canSeeBranches(scope, record.branch_ids, record.kind === "organization_connection")).map((record) => record.key.toLowerCase()));
  return (key) => visible.has(key.toLowerCase());
}
/** The event with only the assignees the reader may see. Equipment is kept. */
function visibleEvent(event: JsonObject, visible: (key: string) => boolean): JsonObject {
  const refs = list(event.resource_refs).filter((raw) => {
    const ref = obj(raw), kind = resourceRefKind(ref.kind);
    return !isAssigneeKind(kind) || visible(`${kind}:${text(ref.id)}`);
  });
  const users = list(event.assigned_user_ids).map(text).filter((userId) => userId && visible(`organization_user:${userId}`));
  const single = text(event.assigned_user_id);
  return { ...event, resource_refs: refs, assigned_user_ids: users, ...(single && !visible(`organization_user:${single}`) ? { assigned_user_id: "" } : {}) };
}
const visibleEntries = (entries: AssignmentEntry[], visible: (key: string) => boolean) => entries.filter((entry) => visible(`${entry.assignee.type}:${entry.assignee.id}`));

/** The work's own staffing requirements: the event's, and those of the scope piece it was made for. Invalid entries are skipped. */
function eventStaffingRequirements(event: JsonObject, project: JsonObject): StaffingRequirement[] {
  const piece = list(obj(project.scope).pieces).map(obj).find((entry) => text(entry.id) && text(entry.id) === text(event.scope_piece_id));
  const found = new Map<string, StaffingRequirement>();
  for (const raw of [...list(event.staffing_requirements), ...list(piece?.staffing_requirements)]) {
    const parsed = staffingRequirementSchema.safeParse(raw);
    if (parsed.success && !found.has(parsed.data.id)) found.set(parsed.data.id, parsed.data);
  }
  return [...found.values()].slice(0, 50);
}
const projectTitle = (project: JsonObject) => text(project.title || project.customer_name || project.address);
/** The measurements a placement reads, as the project event write gathers them. */
const placementMeasurements = (project: JsonObject, event: JsonObject): JsonObject => {
  const scope = obj(project.scope);
  const piece = list(scope.pieces).map(obj).find((item) => text(item.id) === text(event.scope_piece_id));
  return { ...obj(scope.measurements), ...obj(project.measurements), ...obj(piece?.measurements) };
};

/** Who is on the event each local day, from the roster's timeline. */
function rosterDays(check: AssignmentCheck, timezone: string): EventRoster["days"] {
  const window = check.roster.window;
  const start = Date.parse(window.from), end = Date.parse(window.until);
  const days: EventRoster["days"] = [];
  let parts = zonedParts(new Date(start), timezone);
  for (let guard = 0; guard < MAX_ROSTER_DAYS; guard += 1) {
    const dayStart = zonedInstant(parts.year, parts.month, parts.day, 0, 0, timezone).getTime();
    const next = new Date(Date.UTC(parts.year, parts.month - 1, parts.day + 1));
    const dayEnd = zonedInstant(next.getUTCFullYear(), next.getUTCMonth() + 1, next.getUTCDate(), 0, 0, timezone).getTime();
    if (dayStart >= end) break;
    const segments = check.roster.timeline.filter((segment) => Date.parse(segment.from) < dayEnd && dayStart < Date.parse(segment.until));
    days.push({
      date: `${parts.year}-${String(parts.month).padStart(2, "0")}-${String(parts.day).padStart(2, "0")}`,
      person_ids: [...new Set(segments.flatMap((segment) => segment.person_ids))].sort(),
      party_ids: [...new Set(segments.flatMap((segment) => segment.party_ids))].sort()
    });
    parts = { ...parts, year: next.getUTCFullYear(), month: next.getUTCMonth() + 1, day: next.getUTCDate() };
  }
  return days;
}

/**
 * The roster and the warnings of each event asked for, with its children, and of a draft being placed. One read of the
 * schedule serves every event: other work is everything scheduled in the window the events cover, which the overlap
 * check reads as well (docs/optimization-backlog.md, "Schedule roster reads every project").
 */
export async function readEventRosters(orgId: string, auth: PlatformAuthContext | null | undefined, branchIdValue: string, input: unknown): Promise<EventRosterResult> {
  const parsed = eventRosterInputSchema.parse(input ?? {});
  const branchId = text(branchIdValue) || "default";
  const timezone = await resolveOrganizationTimezone(orgId, branchId);
  const includeChildren = parsed.include_children !== false;

  // ---- The events asked for ----
  const projects = new Map<string, JsonObject | null>();
  const project = async (projectId: string) => {
    if (!projects.has(projectId)) projects.set(projectId, await readDocument(orgId, "projects", projectId).then((document) => obj(document.data)).catch(() => null));
    return projects.get(projectId)!;
  };
  const items: Item[] = [];
  const seen = new Set<string>();
  const add = (item: Item) => { const key = `${item.projectId}:${text(item.event.id)}`; if (!text(item.event.id) || seen.has(key)) return; seen.add(key); items.push(item); };
  let replace: { projectId: string; events: JsonObject[]; title: string } | undefined;

  if (parsed.draft) {
    const projectId = text(parsed.draft.project_id);
    const data = projectId ? await project(projectId) : {};
    const stored = list(data?.events).map(obj);
    const draftId = text(parsed.draft.event.id) || "draft";
    const existing = stored.find((event) => text(event.id) === draftId) || {};
    const draft: JsonObject = { ...existing, ...(parsed.draft.event as JsonObject), id: draftId };
    let events = [...stored.filter((event) => text(event.id) !== draftId), draft];
    // The save re-places everything under the draft; answer for where it would go.
    const placed = projectId ? placeChildren(events, draftId, { timezone, measurements: placementMeasurements(data || {}, draft) }) : { updated: [], blocked: [] };
    const moved = new Map(placed.updated.map((child) => [text(child.id), child]));
    events = events.map((event) => moved.get(text(event.id)) || event);
    if (projectId) replace = { projectId, events, title: projectTitle(data || {}) };
    add({ event: draft, projectId, projectTitle: projectTitle(data || {}), projectEvents: events, draft: true, project: data || {} });
    if (includeChildren && projectId) for (const child of eventDescendants(events, draftId)) add({ event: child, projectId, projectTitle: projectTitle(data || {}), projectEvents: events, draft: moved.has(text(child.id)), project: data || {} });
  }
  for (const entry of parsed.events || []) {
    const projectId = text(entry.project_id);
    if (projectId) {
      const data = await project(projectId);
      if (!data) continue;
      const events = replace?.projectId === projectId ? replace.events : list(data.events).map(obj);
      const event = events.find((candidate) => text(candidate.id) === entry.event_id);
      if (!event) continue;
      add({ event, projectId, projectTitle: projectTitle(data), projectEvents: events, draft: false, project: data });
      if (includeChildren) for (const child of eventDescendants(events, entry.event_id)) add({ event: child, projectId, projectTitle: projectTitle(data), projectEvents: events, draft: false, project: data });
    } else {
      const document = await readDocument(orgId, "calendar_events", entry.event_id).catch(() => null);
      if (document) add({ event: { ...obj(document.data), id: document.id }, projectId: "", projectTitle: "", projectEvents: [], draft: false, project: {} });
    }
    if (items.length >= MAX_ROSTER_EVENTS) break;
  }
  items.splice(MAX_ROSTER_EVENTS);

  const visible = await visibleAssignees(orgId, auth);
  const windows = items.map((item) => rosterWindow(item.event));
  const scheduled = windows.filter((window): window is Interval => !!window);
  const empty: EventRosterResult = { timezone, overlap_mode: "warn", events: [] };
  if (!items.length) return empty;

  // ---- Everything the windows touch, read once ----
  const span: Interval | null = scheduled.length ? { from: scheduled.map((window) => window.from).sort()[0]!, until: scheduled.map((window) => window.until).sort().at(-1)! } : null;
  type Work = OtherWork & { family_key: string };
  const work: Work[] = [];
  let unavailable: Unavailability[] = [];
  if (span) {
    const touch = (eventValue: unknown, projectId: string, title: string) => {
      const event = obj(eventValue), range = rosterWindow(event), eventId = text(event.id);
      if (!range || !eventId || !(range.from < span.until && span.from < range.until)) return;
      const assignment = visibleEntries(assignmentFromEvent(event), visible);
      if (assignment.length) work.push({ id: eventId, title: text(event.title) || title, project_id: projectId, ...range, assignment, family_key: `${projectId}:${eventId}` });
    };
    for (const document of await listDocuments(orgId, "projects")) {
      const data = obj(document.data);
      const events = replace?.projectId === document.id ? replace.events : list(data.events);
      for (const event of events) touch(event, document.id, projectTitle(data));
    }
    for (const document of await listDocuments(orgId, "calendar_events").catch(() => [])) touch({ ...obj(document.data), id: document.id }, "", "");
    const [timeOff, exceptions] = await Promise.all([listTimeOff(orgId, span), scheduleExceptions(orgId, branchId, span)]);
    unavailable = [
      ...timeOff.map((entry): Unavailability => ({ assignee_id: entry.assignee_id, from: entry.from, until: entry.until, reason: entry.reason || "Time off", source: "time_off", source_id: entry.id })),
      ...exceptions
    ];
  }

  // ---- The roster and the check of each event ----
  const checks: Array<AssignmentCheck | null> = [];
  const errors: string[] = [];
  for (const [index, item] of items.entries()) {
    const window = windows[index];
    const shown = visibleEvent(item.event, visible);
    const requirements = eventStaffingRequirements(item.event, item.project);
    const assignment = assignmentFromEvent(shown);
    if (!window || (!assignment.length && !requirements.length)) { checks.push(null); errors.push(""); continue; }
    const family = item.projectId ? eventFamilyIds(item.projectEvents, item.event) : new Set([text(item.event.id)]);
    const otherWork = work.filter((entry) => !(entry.project_id === item.projectId && family.has(entry.id)) && entry.from < window.until && window.from < entry.until)
      .map(({ family_key: _key, ...entry }) => entry);
    try {
      checks.push(await checkAssignment(orgId, {
        assignment: assignment.slice(0, 200), from: window.from, until: window.until, branch_id: branchId,
        staffing_requirements: requirements,
        accepted: list(item.event.accepted_roster_warnings).map(text).filter(Boolean).slice(0, 500)
      }, { other_work: otherWork, unavailable }));
      errors.push("");
    } catch (error) {
      checks.push(null);
      errors.push(error instanceof Error && error.message ? error.message : "The roster could not be read.");
    }
  }

  // ---- The overlap check, fed the roster's people ----
  const subjects: OverlapSubject[] = items.map((item, index) => {
    const check = checks[index];
    const people = new Map((check?.roster.people || []).map((person) => [person.id, person]));
    return {
      event: visibleEvent(item.event, visible), projectId: item.projectId,
      familyIds: item.projectId ? eventFamilyIds(item.projectEvents, item.event) : new Set([text(item.event.id)]),
      rosterOverlaps: (check?.roster.conflicts || []).map((conflict) => ({ person_id: conflict.person_id, name: conflict.name, via: people.get(conflict.person_id)?.via || [], work: conflict.work, intervals: conflict.intervals }))
    };
  });
  const overlap = await assessAssigneeOverlap(orgId, branchId, subjects, replace);

  const events = items.map((item, index): EventRosterRead => {
    const check = checks[index];
    const eventId = text(item.event.id);
    // The overlap answer names events by id only; an id is unique within the events asked for in practice.
    const conflicts = overlap.assignee_conflicts.filter((conflict) => conflict.event_id === eventId);
    const accepted = new Set(list(item.event.accepted_roster_warnings).map(text));
    // The roster's own double booking is reported only where the overlap check kept it (a person through different assignees).
    const keptPersonConflicts = new Set(conflicts.filter((conflict) => conflict.reason === "person").flatMap((conflict) => conflict.conflicts.map((other) => `${conflict.assignee.kind}:${conflict.assignee.id}|${other.project_id}|${other.event_id}`)));
    const personMode = new Map(conflicts.filter((conflict) => conflict.reason === "person").map((conflict) => [`${conflict.assignee.kind}:${conflict.assignee.id}`, conflict.mode]));
    const rosterConflictIds = new Set((check?.roster.conflicts || []).filter((conflict) => keptPersonConflicts.has(`${conflict.person_id}|${conflict.work.project_id}|${conflict.work.id}`)).map((conflict) => conflict.id));
    const warnings: EventRosterWarning[] = [];
    for (const warning of check?.warnings || []) {
      if (warning.kind === "double_booked" && !rosterConflictIds.has(warning.id)) continue;
      warnings.push({ ...warning, mode: warning.kind === "double_booked" ? personMode.get(warning.person_id || "") || "warn" : "warn" });
    }
    for (const conflict of conflicts.filter((entry) => entry.reason !== "person")) {
      const name = conflict.assignee.name || conflict.assignee.id;
      const where = conflict.conflicts.map((other) => `${other.title || other.project_title || "other work"} ${describeInterval({ from: other.start_at, until: other.end_at }, timezone)}`).join("; ");
      const warningId = `assignee_overlap:${contentHash([conflict.assignee.kind, conflict.assignee.id, conflict.reason, conflict.conflicts.map((other) => [other.project_id, other.event_id, other.start_at, other.end_at])]).slice(0, 24)}`;
      warnings.push({
        id: warningId, kind: "assignee_overlap", accepted: accepted.has(warningId), mode: conflict.mode, assignee_id: `${conflict.assignee.kind}:${conflict.assignee.id}`,
        message: conflict.reason === "unit" ? `${name} has the same unit on ${where}.` : conflict.capacity > 1 ? `${name} has no free unit: also on ${where}.` : `${name} is also on ${where}.`,
        intervals: conflict.conflicts.map((other) => ({ from: other.start_at, until: other.end_at }))
      });
    }
    for (const person of (check?.roster.absent || []).filter((entry) => entry.reason === "inactive")) {
      const warningId = `missing_member:${contentHash([person.id, person.via]).slice(0, 24)}`;
      const groups = (check?.roster.assigned || []).filter((entry) => person.via.includes(entry.id)).map((entry) => entry.name);
      warnings.push({ id: warningId, kind: "missing_member", accepted: accepted.has(warningId), mode: "warn", person_id: person.id, message: `${person.name}${groups.length ? ` is in ${groups.join(" and ")} but` : ""} is no longer active, so they are not on the work.`, intervals: [] });
    }
    const roster: EventRoster | null = check ? {
      people: check.roster.people.map((person) => ({ id: person.id, user_id: person.user_id, name: person.name, via: person.via, whole_window: person.whole_window, present: person.present })),
      parties: check.roster.parties.map((party) => ({ id: party.id, name: party.name, present: party.present })),
      absent: check.roster.absent.map((person) => ({ id: person.id, name: person.name, reason: person.reason })),
      count: check.roster.facts.count, party_count: check.roster.facts.party_count,
      min_count: Number.isFinite(check.roster.facts.min_count) ? check.roster.facts.min_count : 0, max_count: Number.isFinite(check.roster.facts.max_count) ? check.roster.facts.max_count : 0,
      days: rosterDays(check, timezone)
    } : null;
    return {
      event_id: eventId, project_id: item.projectId, parent_event_id: eventParentId(item.event), draft: item.draft,
      window: windows[index] || null, roster, staffing_requirements: check?.staffing_requirements || [], warnings,
      assignee_conflicts: conflicts, error: errors[index] || ""
    };
  });
  return { timezone, overlap_mode: overlap.mode, events };
}
