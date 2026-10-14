import type { JsonObject } from "../platform/storage.js";

/**
 * What a schedule event stores about its resources, its list and its family. See
 * docs/architecture/schedule-events.md. Everything here is pure: it reads and shapes event objects and touches no store.
 */

export const ASSIGNEE_REF_KINDS = ["organization_user", "resource_group", "organization_connection"] as const;
export const EQUIPMENT_REF_KINDS = ["equipment_unit", "equipment_type"] as const;
export type AssigneeRefKind = typeof ASSIGNEE_REF_KINDS[number];
export type EquipmentRefKind = typeof EQUIPMENT_REF_KINDS[number];
export type ResourceRefKind = AssigneeRefKind | EquipmentRefKind;
export type ResourceRefRole = "crew" | "equipment" | "operator";

export type ResourceRef = {
  kind: ResourceRefKind;
  id: string;
  name: string;
  role: ResourceRefRole;
  /** The unit inside an assignee that does the work. Assignees only. */
  unit_id?: string;
  /** Equipment only. */
  quantity?: number;
};
export type AssigneeRef = ResourceRef & { kind: AssigneeRefKind };
export type EquipmentRef = ResourceRef & { kind: EquipmentRefKind };

/** Fields an event used to carry that said the same thing as `resource_refs` or `scope_resource_list_id`. Never stored. */
export const REMOVED_EVENT_FIELDS = [
  "work_resource_ref", "assigned_resource_kind", "assigned_resource_id", "assigned_resource_name", "resource_id", "resource_name",
  "assigned_crew_id", "assigned_crew_ids", "assigned_crew_name", "assigned_crew", "crew_id", "crew_name",
  "material_list_id", "labor_list_id", "equipment_list_id",
  "schedule_rule", "schedule_rollup", "is_schedule_group"
] as const;

const text = (value: unknown) => String(value ?? "").trim();
const obj = (value: unknown): JsonObject => (value && typeof value === "object" && !Array.isArray(value) ? value as JsonObject : {});
const list = (value: unknown): unknown[] => (Array.isArray(value) ? value : []);

/** Names a writer may use for an assignee kind. */
const KIND_ALIASES: Record<string, ResourceRefKind> = {
  crew: "resource_group", team: "resource_group", group: "resource_group",
  person: "organization_user", user: "organization_user",
  subcontractor: "organization_connection", connection: "organization_connection"
};
const ALL_KINDS = new Set<string>([...ASSIGNEE_REF_KINDS, ...EQUIPMENT_REF_KINDS]);

export function resourceRefKind(value: unknown): ResourceRefKind | "" {
  const kind = text(value).toLowerCase();
  const resolved = KIND_ALIASES[kind] || kind;
  return ALL_KINDS.has(resolved) ? resolved as ResourceRefKind : "";
}
export const isEquipmentKind = (kind: unknown): kind is EquipmentRefKind => (EQUIPMENT_REF_KINDS as readonly string[]).includes(text(kind));
export const isAssigneeKind = (kind: unknown): kind is AssigneeRefKind => (ASSIGNEE_REF_KINDS as readonly string[]).includes(text(kind));
export const resourceRefKey = (ref: { kind: string; id: string }) => `${ref.kind}:${ref.id.toLowerCase()}`;

/** One entry of `resource_refs`, or null when it names nothing usable. Dates on an entry are dropped: a resource has its event's range. */
export function normalizeResourceRef(value: unknown): ResourceRef | null {
  const ref = obj(value);
  const kind = resourceRefKind(ref.kind);
  const id = text(ref.id);
  if (!kind || !id) return null;
  const equipment = isEquipmentKind(kind);
  const role = text(ref.role).toLowerCase();
  const quantity = Math.max(1, Math.round(Number(ref.quantity || 1)) || 1);
  const unitId = equipment ? "" : text(ref.unit_id);
  return {
    kind,
    id,
    name: text(ref.name || ref.label),
    role: equipment ? "equipment" : role === "operator" ? "operator" : "crew",
    ...(unitId ? { unit_id: unitId } : {}),
    ...(equipment && (kind === "equipment_type" || quantity > 1) ? { quantity } : {})
  };
}

/** The event's resources, in stored order, without duplicates and never naming the event itself. */
export function eventResources(eventValue: unknown): ResourceRef[] {
  const event = obj(eventValue);
  const selfId = text(event.id);
  const seen = new Set<string>();
  const refs: ResourceRef[] = [];
  for (const entry of list(event.resource_refs)) {
    const ref = normalizeResourceRef(entry);
    if (!ref || ref.id === selfId) continue;
    const key = resourceRefKey(ref);
    if (seen.has(key)) continue;
    seen.add(key);
    refs.push(ref);
  }
  return refs;
}
/** The crews, people and companies doing the work. The first is the primary assignee. */
export const eventAssignees = (event: unknown) => eventResources(event).filter((ref): ref is AssigneeRef => isAssigneeKind(ref.kind));
export const eventEquipment = (event: unknown) => eventResources(event).filter((ref): ref is EquipmentRef => isEquipmentKind(ref.kind));
export const eventPrimaryAssignee = (event: unknown): AssigneeRef | null => eventAssignees(event).find((ref) => ref.role === "crew") || null;

/** People attached through `assigned_user_ids`, the sales appointment path. */
export function eventAssignedUserIds(eventValue: unknown): string[] {
  const event = obj(eventValue);
  const ids = [...list(event.assigned_user_ids), event.assigned_user_id].map(text).filter(Boolean);
  return [...new Set(ids)];
}

/** Everyone on the event as `type:id` keys, lower-cased: its assignees plus the people in `assigned_user_ids`. */
export function eventAssigneeKeys(eventValue: unknown): string[] {
  const keys = eventAssignees(eventValue).map(resourceRefKey);
  for (const userId of eventAssignedUserIds(eventValue)) keys.push(`organization_user:${userId.toLowerCase()}`);
  return [...new Set(keys)];
}

/** Returns the event without the fields that no longer exist, and with any dates removed from its resources. */
export function stripRemovedEventFields<T extends JsonObject>(eventValue: T): T {
  const event: JsonObject = { ...eventValue };
  for (const field of REMOVED_EVENT_FIELDS) delete event[field];
  const metadata = obj(event.metadata);
  if (Object.keys(metadata).length) {
    const next: JsonObject = { ...metadata };
    for (const field of [...REMOVED_EVENT_FIELDS, "scope_resource_list_id", "resource_type"]) delete next[field];
    event.metadata = next;
  }
  return event as T;
}

// ---- The list an event was made for ----
export const eventListId = (event: unknown) => text(obj(event).scope_resource_list_id);
export const eventListPartId = (event: unknown) => text(obj(event).list_part_id);
export const eventResourceType = (event: unknown) => text(obj(event).resource_type).toLowerCase();

// ---- Family ----
export const eventParentId = (event: unknown) => text(obj(event).parent_event_id);
/** A span: an event whose only job is to hold the range its children are placed against. */
export const eventIsSpan = (event: unknown) => text(obj(event).kind).toLowerCase() === "schedule_group";
export const eventIsChild = (event: unknown) => !!eventParentId(event);

export function eventChildren(events: unknown[], parentId: string): JsonObject[] {
  const id = text(parentId);
  return id ? events.map(obj).filter((event) => eventParentId(event) === id) : [];
}
/** Every event under this one, nearest first. Safe against a cycle in stored data. */
export function eventDescendants(events: unknown[], rootId: string): JsonObject[] {
  const found: JsonObject[] = [];
  const seen = new Set([text(rootId)]);
  const queue = [text(rootId)];
  while (queue.length) {
    for (const child of eventChildren(events, queue.shift()!)) {
      const id = text(child.id);
      if (!id || seen.has(id)) continue;
      seen.add(id);
      found.push(child);
      queue.push(id);
    }
  }
  return found;
}
/** Ids of the events above this one, nearest first. */
export function eventAncestorIds(events: unknown[], eventValue: unknown): string[] {
  const byId = new Map(events.map(obj).map((event) => [text(event.id), event]));
  const ids: string[] = [];
  let parentId = eventParentId(eventValue);
  while (parentId && !ids.includes(parentId) && parentId !== text(obj(eventValue).id)) {
    ids.push(parentId);
    parentId = eventParentId(byId.get(parentId));
  }
  return ids;
}
/** The ids an event can never conflict with: itself, everything above it and everything under it. */
export function eventFamilyIds(events: unknown[], eventValue: unknown): Set<string> {
  const id = text(obj(eventValue).id);
  return new Set([id, ...eventAncestorIds(events, eventValue), ...eventDescendants(events, id).map((event) => text(event.id))].filter(Boolean));
}
/** Refuses a parent that is the event itself or one of its own descendants. */
export function parentWouldCycle(events: unknown[], eventId: string, parentId: string) {
  const id = text(eventId), parent = text(parentId);
  if (!parent) return false;
  if (parent === id) return true;
  return !!id && eventDescendants(events, id).some((event) => text(event.id) === parent);
}

// ---- Range and state ----
export const eventStatus = (event: unknown) => text(obj(event).status).toLowerCase();
export const eventIsLocked = (event: unknown) => obj(event).locked === true || obj(obj(event).schedule_lock).locked === true;
/** Locked or finished work never moves as a side effect of something else moving. */
export const eventIsFixed = (event: unknown) => eventIsLocked(event) || ["completed", "complete", "done"].includes(eventStatus(event));
/** The range an event holds on the calendar, or null when it holds none. */
export function eventWindow(eventValue: unknown): { start: number; end: number } | null {
  const event = obj(eventValue);
  if (["unscheduled", "canceled", "cancelled"].includes(eventStatus(event))) return null;
  const start = Date.parse(text(event.start_at));
  if (!Number.isFinite(start)) return null;
  const explicitEnd = Date.parse(text(event.end_at));
  const end = Number.isFinite(explicitEnd) && explicitEnd > start ? explicitEnd : start + Math.max(1, Number(event.duration_minutes || 60)) * 60000;
  return { start, end };
}
