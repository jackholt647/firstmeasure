import { z } from "zod";
import { hasPermission, type PlatformAuthContext } from "../platform/auth.js";
import { forbidden } from "../platform/errors.js";
import { listDocuments, readBranchModule, upsertDocument, type JsonObject } from "../platform/storage.js";
import { ASSIGNEE_TYPES, assigneeSchema, requireAssignee } from "../labor/assignees.js";
import { listUnits } from "../labor/commitments.js";
import { eventAssignedUserIds, eventAssignees, eventWindow, resourceRefKey, type AssigneeRef } from "./event-model.js";

/**
 * Whether an assignee is already booked during a range, worked out from events and nothing else. See
 * docs/architecture/schedule-events.md. This is the only availability answer.
 */

export const OVERLAP_MODES = ["warn", "block", "allow"] as const;
export type OverlapMode = typeof OVERLAP_MODES[number];
export const ASSIGNEE_SCHEDULING_COLLECTION = "assignee_scheduling_settings";

const text = (value: unknown) => String(value ?? "").trim();
const obj = (value: unknown): JsonObject => (value && typeof value === "object" && !Array.isArray(value) ? value as JsonObject : {});
const overlapMode = (value: unknown, fallback: OverlapMode): OverlapMode => ((OVERLAP_MODES as readonly string[]).includes(text(value)) ? text(value) as OverlapMode : fallback);

/** What the organization does about an overlap unless an assignee says otherwise. */
export async function readOverlapDefault(orgId: string, branchId: string): Promise<OverlapMode> {
  const module = await readBranchModule(orgId, text(branchId) || "default", "scheduling").catch(() => null);
  return overlapMode(obj(obj(module).data).assignee_overlap, "warn");
}

// ---- One assignee's own setting ----
export const assigneeSchedulingSchema = z.object({
  assignee: assigneeSchema,
  /** `inherit` follows the organization default. */
  overlap: z.enum(["inherit", ...OVERLAP_MODES])
}).strict();
export type AssigneeSchedulingSetting = { assignee: { type: typeof ASSIGNEE_TYPES[number]; id: string }; overlap: "inherit" | OverlapMode; revision: number };
const settingId = (assignee: { type: string; id: string }) => `${assignee.type}.${assignee.id}`;

export async function listAssigneeSchedulingSettings(orgId: string): Promise<AssigneeSchedulingSetting[]> {
  return (await listDocuments(orgId, ASSIGNEE_SCHEDULING_COLLECTION)).map((document): AssigneeSchedulingSetting => ({
    assignee: document.data.assignee as unknown as AssigneeSchedulingSetting["assignee"],
    overlap: text(document.data.overlap) === "inherit" ? "inherit" : overlapMode(document.data.overlap, "warn"),
    revision: Number(document.revision || 0)
  })).filter((setting) => setting.assignee && (ASSIGNEE_TYPES as readonly string[]).includes(text(setting.assignee.type)));
}
export async function saveAssigneeSchedulingSetting(orgId: string, input: unknown, actor: PlatformAuthContext): Promise<AssigneeSchedulingSetting> {
  if (actor.orgId !== orgId || !hasPermission(actor, "manage_company_settings")) throw forbidden("permission_denied", "Company settings permission is required to change how an assignee is scheduled.");
  const parsed = assigneeSchedulingSchema.parse(input);
  await requireAssignee(orgId, parsed.assignee);
  const document = await upsertDocument(orgId, ASSIGNEE_SCHEDULING_COLLECTION, {
    id: settingId(parsed.assignee),
    data: { assignee: parsed.assignee, overlap: parsed.overlap, updated_by_user_id: text(actor.userId) } as unknown as JsonObject,
    metadata: { kind: "assignee_scheduling", subject_type: parsed.assignee.type, subject_id: parsed.assignee.id }
  }, { replace: true });
  return { assignee: parsed.assignee, overlap: parsed.overlap, revision: Number((document as { revision?: number }).revision || 0) };
}

// ---- The check ----
export type OverlappingEvent = { event_id: string; project_id: string; project_title: string; title: string; start_at: string; end_at: string; unit_id?: string };
export type AssigneeConflict = {
  /** The event being saved or checked. */
  event_id: string;
  assignee: { kind: string; id: string; name: string; unit_id?: string };
  /** `unit`: the same unit is on another event. `overlap`: the assignee has no free unit left in this range. */
  reason: "unit" | "overlap";
  /** How many jobs the assignee can hold at once. */
  capacity: number;
  mode: Exclude<OverlapMode, "allow">;
  conflicts: OverlappingEvent[];
};
export type OverlapSubject = {
  event: JsonObject;
  projectId: string;
  /** Ids in the same project that can never conflict with this event: itself, its ancestors and its descendants. */
  familyIds: Set<string>;
};
type Scheduled = { event: JsonObject; projectId: string; projectTitle: string; window: { start: number; end: number } };

/** Every event in the organization that holds a range, with one project's events replaced by the copy about to be written. */
async function scheduledEvents(orgId: string, replace?: { projectId: string; events: unknown[]; title?: string }): Promise<Scheduled[]> {
  const found: Scheduled[] = [];
  const add = (eventValue: unknown, projectId: string, projectTitle: string) => {
    const event = obj(eventValue);
    const window = eventWindow(event);
    if (window) found.push({ event, projectId, projectTitle, window });
  };
  for (const document of await listDocuments(orgId, "projects")) {
    const data = obj(document.data);
    const title = text(data.title || data.customer_name || data.address);
    if (replace && document.id === replace.projectId) continue;
    for (const event of Array.isArray(data.events) ? data.events : []) add(event, document.id, title);
  }
  if (replace) for (const event of replace.events) add(event, replace.projectId, text(replace.title));
  for (const document of await listDocuments(orgId, "calendar_events").catch(() => [])) add({ ...obj(document.data), id: document.id }, "", "");
  return found;
}

/**
 * How many jobs each assignee can hold at once: one for each of its units that has no units under it, and one for an
 * assignee with no units. Returns a lookup so a caller checking many assignees reads the units once.
 */
export async function assigneeCapacities(orgId: string) {
  const units = await listUnits(orgId);
  return (type: string, id: string) => {
    const own = units.filter((unit) => unit.assignee.type === type && unit.assignee.id.toLowerCase() === id.toLowerCase());
    return Math.max(1, own.filter((unit) => !own.some((other) => other.parent_unit_id === unit.id)).length);
  };
}

/** The most events from `others` that hold the same moment at once. */
function peakConcurrency(others: Scheduled[]) {
  const edges = others.flatMap((entry) => [[entry.window.start, 1], [entry.window.end, -1]] as [number, number][]).sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  let current = 0, peak = 0;
  for (const [, change] of edges) { current += change; peak = Math.max(peak, current); }
  return peak;
}

/**
 * Overlaps for each given event against everything else scheduled. `replace` supplies a project's events as they will
 * be after the write, so a child that is moving in the same save is judged where it is going.
 */
export async function assessAssigneeOverlap(orgId: string, branchId: string, subjects: OverlapSubject[], replace?: { projectId: string; events: unknown[]; title?: string }): Promise<{ mode: OverlapMode; assignee_conflicts: AssigneeConflict[] }> {
  const mode = await readOverlapDefault(orgId, branchId);
  const withAssignees = subjects.filter((subject) => eventWindow(subject.event) && (eventAssignees(subject.event).length || eventAssignedUserIds(subject.event).length));
  if (!withAssignees.length) return { mode, assignee_conflicts: [] };
  const settings = new Map((await listAssigneeSchedulingSettings(orgId)).map((setting) => [`${setting.assignee.type}:${setting.assignee.id.toLowerCase()}`, setting.overlap]));
  const modeFor = (key: string) => { const own = settings.get(key); return own && own !== "inherit" ? own : mode; };
  const everyone = withAssignees.flatMap((subject) => [...eventAssignees(subject.event), ...eventAssignedUserIds(subject.event).map((id): AssigneeRef => ({ kind: "organization_user", id, name: "", role: "crew" }))]);
  if (everyone.every((ref) => modeFor(resourceRefKey(ref)) === "allow")) return { mode, assignee_conflicts: [] };
  const [scheduled, capacityOf] = await Promise.all([scheduledEvents(orgId, replace), assigneeCapacities(orgId)]);
  const conflicts: AssigneeConflict[] = [];
  for (const subject of withAssignees) {
    const window = eventWindow(subject.event)!;
    const eventId = text(subject.event.id);
    const named = eventAssignees(subject.event);
    const people = eventAssignedUserIds(subject.event)
      .filter((id) => !named.some((ref) => ref.kind === "organization_user" && ref.id.toLowerCase() === id.toLowerCase()))
      .map((id): AssigneeRef => ({ kind: "organization_user", id, name: "", role: "crew" }));
    for (const ref of [...named, ...people]) {
      const key = resourceRefKey(ref);
      const refMode = modeFor(key);
      if (refMode === "allow") continue;
      const others = scheduled.filter((entry) => {
        if (entry.projectId === subject.projectId && subject.familyIds.has(text(entry.event.id))) return false;
        if (!subject.projectId && text(entry.event.id) === eventId) return false;
        if (!(entry.window.start < window.end && window.start < entry.window.end)) return false;
        return eventAssignees(entry.event).some((other) => resourceRefKey(other) === key)
          || (ref.kind === "organization_user" && eventAssignedUserIds(entry.event).some((id) => id.toLowerCase() === ref.id.toLowerCase()));
      });
      if (!others.length) continue;
      const unitOf = (entry: Scheduled) => text(eventAssignees(entry.event).find((other) => resourceRefKey(other) === key)?.unit_id);
      const sameUnit = ref.unit_id ? others.filter((entry) => unitOf(entry) === ref.unit_id) : [];
      const capacity = capacityOf(ref.kind, ref.id);
      const reason = sameUnit.length ? "unit" : peakConcurrency(others) >= capacity ? "overlap" : null;
      if (!reason) continue;
      conflicts.push({
        event_id: eventId,
        assignee: { kind: ref.kind, id: ref.id, name: ref.name, ...(ref.unit_id ? { unit_id: ref.unit_id } : {}) },
        reason,
        capacity,
        mode: refMode,
        conflicts: (reason === "unit" ? sameUnit : others).map((entry) => ({
          event_id: text(entry.event.id), project_id: entry.projectId, project_title: entry.projectTitle, title: text(entry.event.title),
          start_at: new Date(entry.window.start).toISOString(), end_at: new Date(entry.window.end).toISOString(),
          ...(unitOf(entry) ? { unit_id: unitOf(entry) } : {})
        }))
      });
    }
  }
  return { mode, assignee_conflicts: conflicts };
}
