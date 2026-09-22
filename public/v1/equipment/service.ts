import { isCapabilityEnabled } from "../platform/capabilities.js";
import { badRequest } from "../platform/errors.js";
import { listDocuments, upsertDocument } from "../platform/storage.js";
import type { JsonObject } from "./storage.js";
import {
  getEquipmentDatabase,
  countCategoriesWithSeedKey,
  latestCompletedWorkOrder,
  latestMeterEntry,
  listCategories,
  listMeterEntries,
  listPrograms,
  listTypes,
  listUnits,
  listWorkOrders,
  newId,
  nowIso,
  readProgram,
  readSettingsRow,
  readUnit,
  readWorkOrder,
  recordMeterEntry,
  saveCategory,
  saveWorkOrder,
  patchUnit,
  writeSettingsRow
} from "./storage.js";

function cleanText(value: unknown) {
  return String(value ?? "").trim();
}

/* Seeds --------------------------------------------------------------------- */

const SEED_CATEGORIES: Array<{ seed_key: string; name: string; icon: string }> = [
  { seed_key: "vehicles", name: "Vehicles", icon: "fa-truck-pickup" },
  { seed_key: "trailers", name: "Trailers", icon: "fa-trailer" },
  { seed_key: "heavy_equipment", name: "Heavy Equipment", icon: "fa-truck-monster" },
  { seed_key: "attachments", name: "Attachments", icon: "fa-plug" },
  { seed_key: "tools", name: "Tools", icon: "fa-screwdriver-wrench" },
  { seed_key: "site_services", name: "Site Services", icon: "fa-toilet-portable" },
  { seed_key: "facilities", name: "Facilities", icon: "fa-warehouse" }
];

export async function ensureEquipmentSeed(orgId: string) {
  return (await getEquipmentDatabase().transaction(async () => {
  if ((await countCategoriesWithSeedKey(orgId)) > 0) return;
  for (const [index, category] of SEED_CATEGORIES.entries()) {
    (await saveCategory(orgId, { name: category.name, icon: category.icon, sort_order: (index + 1) * 10, seed_key: category.seed_key }));
  }

  }));
}

/* Module settings ----------------------------------------------------------- */

export const DEFAULT_MODULE_SETTINGS = {
  tier: "",
  conflict_mode: "warn",
  auto_fulfill_single_unit: true,
  default_meter_units: "hours",
  downtime_auto_block: true,
  operator_enforcement: "warn",
  field_meter_entry: false
};

export async function readModuleSettings(orgId: string) {
  const { settings, revision } = (await readSettingsRow(orgId));
  return { settings: { ...DEFAULT_MODULE_SETTINGS, ...settings }, revision };
}

export async function writeModuleSettings(orgId: string, input: JsonObject) {
  const expected = Number(input.expected_revision || 0);
  const { settings } = (await readModuleSettings(orgId));
  const { expected_revision: _ignored, ...patch } = input;
  const next = { ...settings, ...patch };
  const saved = (await writeSettingsRow(orgId, next, expected));
  return { settings: { ...DEFAULT_MODULE_SETTINGS, ...saved.settings }, revision: saved.revision };
}

/* Fleet reads --------------------------------------------------------------- */

/** Units decorated with their type/category names for list surfaces. */
export async function fleetUnits(orgId: string, options: Parameters<typeof listUnits>[1] = {}) {
  const types = new Map((await listTypes(orgId, { includeArchived: true })).map((type) => [cleanText(type.id), type]));
  const categories = new Map((await listCategories(orgId, { includeArchived: true })).map((category) => [cleanText(category.id), category]));
  return (await listUnits(orgId, options)).map((unit): JsonObject => {
    const type = types.get(cleanText(unit.type_id));
    const category = type ? categories.get(cleanText(type.category_id)) : undefined;
    return {
      ...unit,
      type_name: cleanText(type?.name),
      type_kind: cleanText(type?.kind) || "other",
      type_icon: cleanText(type?.icon) || "fa-truck-pickup",
      type_tracking: cleanText(type?.tracking) || "unit",
      category_id: cleanText(type?.category_id),
      category_name: cleanText(category?.name)
    };
  });
}

export async function unitHistory(orgId: string, unitId: string) {
  const unit = (await readUnit(orgId, unitId));
  return {
    unit,
    meter_entries: (await listMeterEntries(orgId, unitId, { limit: 100 })),
    latest_meters: {
      hours: (await latestMeterEntry(orgId, unitId, "hours")),
      miles: (await latestMeterEntry(orgId, unitId, "miles"))
    },
    /* Booking history joins in a later phase from schedule events. */
    bookings: [] as JsonObject[],
    work_orders: (await listWorkOrders(orgId, { unitId }))
  };
}

/* Bookings, availability & conflicts ---------------------------------------- */

function asObj(value: unknown): JsonObject {
  return value && typeof value === "object" && !Array.isArray(value) ? { ...(value as JsonObject) } : {};
}

function asArr(value: unknown) {
  return Array.isArray(value) ? value : [];
}

/** Equipment-role refs (equipment_unit / equipment_type) on an event. */
export function eventEquipmentRefs(eventValue: unknown) {
  const event = asObj(eventValue);
  return asArr(event.resource_refs)
    .map(asObj)
    .filter((ref) => ["equipment_unit", "equipment_type"].includes(cleanText(ref.kind)))
    .map((ref) => ({
      kind: cleanText(ref.kind),
      id: cleanText(ref.id),
      name: cleanText(ref.name),
      role: cleanText(ref.role) || "equipment",
      quantity: Math.max(1, Number(ref.quantity || 1)),
      start_at: cleanText(ref.start_at || ref.start),
      end_at: cleanText(ref.end_at || ref.end)
    }))
    .filter((ref) => ref.id);
}

type ScheduledEvent = JsonObject & { __start: number; __end: number };

function equipmentRefOverlaps(event: ScheduledEvent, kind: string, id: string, start: number, end: number) {
  return eventEquipmentRefs(event).some((ref) => {
    if (ref.kind !== kind || ref.id !== id) return false;
    const refStart = Date.parse(ref.start_at) || event.__start;
    const refEnd = Date.parse(ref.end_at) || event.__end;
    return refStart < end && refEnd > start;
  });
}

function eventWindow(event: JsonObject): [number, number] | null {
  if (["unscheduled", "canceled", "cancelled"].includes(cleanText(event.status).toLowerCase())) return null;
  const start = Date.parse(cleanText(event.start_at || event.start));
  if (!Number.isFinite(start)) return null;
  const explicitEnd = Date.parse(cleanText(event.end_at || event.end));
  const durationMinutes = Math.max(1, Number(event.duration_minutes || event.duration || 60));
  const end = Number.isFinite(explicitEnd) && explicitEnd > start ? explicitEnd : start + durationMinutes * 60000;
  return [start, end];
}

/** Every scheduled event across the org that references equipment — project
 * bookings plus floating calendar events (equipment_downtime blocks included),
 * so downtime participates in conflict detection with no special casing. */
async function scheduledEquipmentEvents(orgId: string): Promise<ScheduledEvent[]> {
  const projects = await listDocuments(orgId, "projects");
  const events: ScheduledEvent[] = [];
  for (const document of projects) {
    const data = asObj(asObj(document).data);
    for (const eventValue of asArr(data.events)) {
      const event = asObj(eventValue);
      if (!eventEquipmentRefs(event).length) continue;
      const window = eventWindow(event);
      if (!window) continue;
      events.push({
        ...event,
        project_id: cleanText(event.project_id || document.id),
        project_title: cleanText(data.title || data.customer_name || event.project_title),
        __start: window[0],
        __end: window[1]
      });
    }
  }
  const floating = await listDocuments(orgId, "calendar_events").catch(() => []);
  for (const document of floating) {
    const event: JsonObject = { ...asObj(asObj(document).data), id: cleanText(asObj(document).id) };
    if (!eventEquipmentRefs(event).length) continue;
    const window = eventWindow(event);
    if (!window) continue;
    events.push({ ...event, project_title: cleanText(event.project_title || event.title), __start: window[0], __end: window[1] });
  }
  return events;
}

export type EquipmentConflict = {
  ref_kind: string;
  ref_id: string;
  ref_name: string;
  reason: "unit_unavailable" | "double_booked" | "pool_exceeded";
  message: string;
  events: Array<{ id: string; title: string; project_id: string; project_title: string; start_at: string; end_at: string; kind: string }>;
};

function conflictEventSummary(event: ScheduledEvent) {
  return {
    id: cleanText(event.id),
    title: cleanText(event.title),
    project_id: cleanText(event.project_id),
    project_title: cleanText(event.project_title),
    start_at: new Date(event.__start).toISOString(),
    end_at: new Date(event.__end).toISOString(),
    kind: cleanText(event.kind)
  };
}

/**
 * The shared conflict core: given a window and a set of equipment refs, what
 * clashes? Used by the availability endpoint, by event-write enforcement, and
 * mirrored client-side in platform-scheduling.js availabilityForEquipment().
 */
export async function assessEquipmentBooking(orgId: string, input: {
  refs: Array<{ kind: string; id: string; name?: string; quantity?: number }>;
  start: string | number;
  end: string | number;
  excludeEventId?: string;
}): Promise<EquipmentConflict[]> {
  const refs = asArr(input.refs).map(asObj)
    .map((ref) => ({ kind: cleanText(ref.kind), id: cleanText(ref.id), name: cleanText(ref.name), quantity: Math.max(1, Number(ref.quantity || 1)) }))
    .filter((ref) => ref.id && ["equipment_unit", "equipment_type"].includes(ref.kind));
  if (!refs.length) return [];
  const start = typeof input.start === "number" ? input.start : Date.parse(cleanText(input.start));
  const end = typeof input.end === "number" ? input.end : Date.parse(cleanText(input.end));
  if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) return [];
  const excludeEventId = cleanText(input.excludeEventId);
  const types = new Map((await listTypes(orgId, { includeArchived: true })).map((type) => [cleanText(type.id), type]));
  const events = (await scheduledEquipmentEvents(orgId))
    .filter((event) => cleanText(event.id) !== excludeEventId)
    .filter((event) => event.__start < end && event.__end > start);
  const conflicts: EquipmentConflict[] = [];
  for (const ref of refs) {
    if (ref.kind === "equipment_unit") {
      let unit: JsonObject | null = null;
      try {
        unit = (await readUnit(orgId, ref.id));
      } catch {
        unit = null;
      }
      const name = cleanText(unit?.name || ref.name) || ref.id;
      const status = cleanText(unit?.status);
      if (unit && ["down", "retired"].includes(status)) {
        conflicts.push({
          ref_kind: ref.kind,
          ref_id: ref.id,
          ref_name: name,
          reason: "unit_unavailable",
          message: `${name} is ${status === "down" ? "down for service" : "retired"}.`,
          events: []
        });
        continue;
      }
      const type = unit ? types.get(cleanText(unit.type_id)) : undefined;
      if (type?.allow_double_booking === true) continue;
      const overlapping = events.filter((event) => equipmentRefOverlaps(event, "equipment_unit", ref.id, start, end));
      if (overlapping.length) {
        conflicts.push({
          ref_kind: ref.kind,
          ref_id: ref.id,
          ref_name: name,
          reason: "double_booked",
          message: `${name} is already booked during this window.`,
          events: overlapping.map(conflictEventSummary)
        });
      }
    } else {
      const type = types.get(ref.id);
      if (!type || cleanText(type.tracking) !== "quantity") continue;
      const pool = Number(type.pool_quantity || 0);
      const booked = events.reduce((total, event) => total + eventEquipmentRefs(event)
        .filter((entry) => entry.kind === "equipment_type" && entry.id === ref.id)
        .filter((entry) => {
          const refStart = Date.parse(entry.start_at) || event.__start;
          const refEnd = Date.parse(entry.end_at) || event.__end;
          return refStart < end && refEnd > start;
        })
        .reduce((sum, entry) => sum + entry.quantity, 0), 0);
      if (pool > 0 && booked + ref.quantity > pool) {
        conflicts.push({
          ref_kind: ref.kind,
          ref_id: ref.id,
          ref_name: cleanText(type.name) || ref.id,
          reason: "pool_exceeded",
          message: `${cleanText(type.name) || ref.id}: ${booked} of ${pool} already booked; ${ref.quantity} more will not fit.`,
          events: events.filter((event) => equipmentRefOverlaps(event, "equipment_type", ref.id, start, end)).map(conflictEventSummary)
        });
      }
    }
  }
  return conflicts;
}

/** Per-unit availability for a window: bookings, conflicts, and status. */
export async function availabilityForEquipment(orgId: string, input: {
  start: string;
  end: string;
  typeId?: string;
  unitIds?: string[];
  excludeEventId?: string;
}) {
  const start = Date.parse(cleanText(input.start));
  const end = Date.parse(cleanText(input.end));
  const windowValid = Number.isFinite(start) && Number.isFinite(end) && end > start;
  const requestedIds = asArr(input.unitIds).map(cleanText).filter(Boolean);
  const units = (await fleetUnits(orgId, { ownership: "internal", typeId: cleanText(input.typeId) }))
    .filter((unit) => !requestedIds.length || requestedIds.includes(cleanText(unit.id)));
  const events = windowValid
    ? (await scheduledEquipmentEvents(orgId))
      .filter((event) => cleanText(event.id) !== cleanText(input.excludeEventId))
      .filter((event) => event.__start < end && event.__end > start)
    : [];
  return {
    start: windowValid ? new Date(start).toISOString() : "",
    end: windowValid ? new Date(end).toISOString() : "",
    units: units.map((unit) => {
      const unitId = cleanText(unit.id);
      const bookings = events
        .filter((event) => equipmentRefOverlaps(event, "equipment_unit", unitId, start, end))
        .map(conflictEventSummary);
      const unavailable = ["down", "retired"].includes(cleanText(unit.status));
      return {
        id: unitId,
        name: cleanText(unit.name),
        type_id: cleanText(unit.type_id),
        type_name: cleanText(unit.type_name),
        status: cleanText(unit.status),
        bookings,
        available: !unavailable && !bookings.length,
        reason: unavailable ? "unit_unavailable" : (bookings.length ? "double_booked" : "")
      };
    })
  };
}

/** Records a meter entry and rolls hours/miles into the unit's current meter. */
export async function logMeterEntry(orgId: string, input: JsonObject) {
  const entry = (await recordMeterEntry(orgId, input));
  const kind = cleanText(input.kind || "hours");
  if (["hours", "miles"].includes(kind)) {
    const unit = (await readUnit(orgId, cleanText(input.unit_id)));
    const meter = { ...asObj(unit.current_meter), [kind]: Number(input.value || 0), as_of: cleanText(entry.recorded_at) };
    (await patchUnit(orgId, cleanText(input.unit_id), { current_meter: meter }));
  }
  return entry;
}

/* Requirements → fulfillment --------------------------------------------------- */

function normalizeKey(value: unknown) {
  return cleanText(value).toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "");
}

/** Matches a scope equipment list item to a catalog type via the type's
 * scope_item_keys aliases (falling back to a name match). */
function matchTypeForItem(types: JsonObject[], item: JsonObject) {
  const itemKeys = [normalizeKey(item.id), normalizeKey(item.name)].filter(Boolean);
  return types.find((type) => {
    const aliases = asArr(type.scope_item_keys).map(normalizeKey).filter(Boolean);
    return itemKeys.some((key) => aliases.includes(key)) || itemKeys.includes(normalizeKey(type.name));
  }) || null;
}

/**
 * Scope-generated equipment events (materials/storage.ts) call this to attach
 * resource_requirements derived from the list items, and — in simple mode —
 * auto-fulfill requirements whose type has exactly one active unit.
 */
export async function equipmentScheduleAugment(orgId: string, listItems: unknown, existingEvent: unknown): Promise<JsonObject> {
  if (!(await isCapabilityEnabled(orgId, "equipment.requirements").catch(() => false))) return {};
  const types = (await listTypes(orgId));
  const items = asArr(listItems).map(asObj).filter((item) => Number(item.quantity ?? 1) !== 0);
  const requirements = items.map((item) => {
    const type = matchTypeForItem(types, item);
    return {
      equipment_type_id: cleanText(type?.id),
      label: cleanText(item.name || item.id),
      quantity: Math.max(1, Math.round(Number(item.quantity || 1)) || 1)
    };
  });
  if (!requirements.length) return {};
  const augment: JsonObject = { resource_requirements: requirements };
  const { settings } = (await readModuleSettings(orgId));
  const existingRefs = eventEquipmentRefs(existingEvent);
  if (settings.auto_fulfill_single_unit !== false) {
    const fulfilled: JsonObject[] = [];
    for (const requirement of requirements) {
      const typeId = cleanText(requirement.equipment_type_id);
      if (!typeId) continue;
      if (existingRefs.some((ref) => ref.kind === "equipment_unit")) break;
      const activeUnits = (await listUnits(orgId, { ownership: "internal", typeId }))
        .filter((unit) => !["retired", "down"].includes(cleanText(unit.status)));
      const onlyUnit = activeUnits.length === 1 ? activeUnits[0] : null;
      if (onlyUnit) {
        fulfilled.push({
          kind: "equipment_unit",
          id: cleanText(onlyUnit.id),
          name: cleanText(onlyUnit.name),
          role: "equipment"
        });
      }
    }
    if (fulfilled.length) {
      const eventValue = asObj(existingEvent);
      const otherRefs = asArr(eventValue.resource_refs).map(asObj)
        .filter((ref) => !["equipment_unit", "equipment_type"].includes(cleanText(ref.kind)));
      augment.resource_refs = [...otherRefs, ...fulfilled];
    }
  }
  return augment;
}

/* Operator requirements --------------------------------------------------------- */

export type OperatorIssue = {
  unit_id: string;
  unit_name: string;
  requirement: string;
  message: string;
};

/**
 * Advisory-then-enforced operator check: each assigned equipment unit's type
 * operator requirements (plus per-unit overrides) must be present on at least
 * one assigned user's workforce assignment tags.
 */
export async function assessOperatorRequirements(orgId: string, eventValue: unknown): Promise<OperatorIssue[]> {
  const refs = eventEquipmentRefs(eventValue).filter((ref) => ref.kind === "equipment_unit");
  if (!refs.length) return [];
  const event = asObj(eventValue);
  const assignedUserIds = asArr(event.assigned_user_ids).map(cleanText).filter(Boolean);
  const types = new Map((await listTypes(orgId, { includeArchived: true })).map((type) => [cleanText(type.id), type]));
  let userTags: Set<string> | null = null;
  const loadUserTags = async () => {
    if (userTags) return userTags;
    userTags = new Set<string>();
    const documents = await listDocuments(orgId, "users").catch(() => []);
    for (const document of documents) {
      if (!assignedUserIds.includes(cleanText(asObj(document).id))) continue;
      for (const tag of asArr(asObj(asObj(document).data).assignment_tag_ids)) {
        const value = normalizeKey(tag);
        if (value) userTags.add(value);
      }
    }
    return userTags;
  };
  const issues: OperatorIssue[] = [];
  for (const ref of refs) {
    let unit: JsonObject | null = null;
    try {
      unit = (await readUnit(orgId, ref.id));
    } catch {
      continue;
    }
    const type = types.get(cleanText(unit.type_id));
    const requirements = [
      ...asArr(type?.operator_requirements).map(asObj),
      ...asArr(unit.operator_tag_overrides).map(asObj)
    ];
    for (const requirement of requirements) {
      const tagId = normalizeKey(requirement.tag_id || requirement.label);
      if (!tagId) continue;
      const tags = await loadUserTags();
      if (!tags.has(tagId)) {
        issues.push({
          unit_id: cleanText(unit.id),
          unit_name: cleanText(unit.name),
          requirement: cleanText(requirement.label || requirement.tag_id),
          message: `${cleanText(unit.name)} requires an assigned operator with "${cleanText(requirement.label || requirement.tag_id)}".`
        });
      }
    }
  }
  return issues;
}

/* Custody ---------------------------------------------------------------------- */

export async function checkOutUnit(orgId: string, unitId: string, input: JsonObject, userId: string) {
  const unit = (await readUnit(orgId, unitId));
  if (cleanText((unit.custody as JsonObject).user_id)) {
    throw badRequest("equipment_already_checked_out", "This unit is already checked out. Check it in first.");
  }
  return (await patchUnit(orgId, unitId, {
    custody: {
      user_id: cleanText(input.user_id) || userId,
      user_name: cleanText(input.user_name),
      checked_out_at: nowIso(),
      expected_return_at: cleanText(input.expected_return_at),
      notes: cleanText(input.notes)
    }
  }));
}

export async function checkInUnit(orgId: string, unitId: string) {
  (await readUnit(orgId, unitId));
  return (await patchUnit(orgId, unitId, { custody: {} }));
}

/* Utilization ------------------------------------------------------------------- */

/** Booked vs idle plus cost-per-unit over a window (equipment.costing). */
export async function utilization(orgId: string, input: { start?: string; end?: string } = {}) {
  const end = Number.isFinite(Date.parse(cleanText(input.end))) ? Date.parse(cleanText(input.end)) : Date.now();
  const start = Number.isFinite(Date.parse(cleanText(input.start))) ? Date.parse(cleanText(input.start)) : end - 30 * 86400000;
  const windowDays = Math.max(1, (end - start) / 86400000);
  const events = (await scheduledEquipmentEvents(orgId)).filter((event) => event.__start < end && event.__end > start);
  const types = new Map((await listTypes(orgId, { includeArchived: true })).map((type) => [cleanText(type.id), type]));
  const units = await Promise.all((await fleetUnits(orgId, { ownership: "internal" })).map(async (unit) => {
    const unitId = cleanText(unit.id);
    const bookings = events.filter((event) => cleanText(event.kind) !== "equipment_downtime"
      && eventEquipmentRefs(event).some((ref) => ref.kind === "equipment_unit" && ref.id === unitId));
    const downtime = events.filter((event) => cleanText(event.kind) === "equipment_downtime"
      && eventEquipmentRefs(event).some((ref) => ref.kind === "equipment_unit" && ref.id === unitId));
    const clippedMs = (list: ScheduledEvent[]) => list.reduce((sum, event) => sum + Math.max(0, Math.min(event.__end, end) - Math.max(event.__start, start)), 0);
    const bookedMs = clippedMs(bookings);
    const bookedHours = bookedMs / 3600000;
    const type = types.get(cleanText(unit.type_id));
    const rates = { ...asObj(type?.default_rates), ...asObj(unit.rates) };
    const hourly = Number(rates.hourly_cents || 0);
    const daily = Number(rates.daily_cents || 0);
    const projectedCents = hourly > 0 ? Math.round(bookedHours * hourly) : Math.round((bookedMs / 86400000) * daily);
    const workOrders = (await listWorkOrders(orgId, { unitId, status: "completed" }))
      .filter((order) => {
        const at = Date.parse(cleanText(order.completed_at));
        return Number.isFinite(at) && at >= start && at <= end;
      });
    const serviceCents = workOrders.reduce((sum, order) => {
      const cost = asObj(order.cost);
      return sum + Number(cost.parts_cents || 0) + Number(cost.labor_cents || 0) + Number(cost.vendor_cents || 0);
    }, 0);
    const fuelCents = (await listMeterEntries(orgId, unitId, { kind: "fuel", limit: 500 }))
      .reduce((sum, entry) => {
        const at = Date.parse(cleanText(entry.recorded_at));
        return Number.isFinite(at) && at >= start && at <= end ? sum + Number(entry.cost_cents || 0) : sum;
      }, 0);
    return {
      id: unitId,
      name: cleanText(unit.name),
      type_name: cleanText(unit.type_name),
      status: cleanText(unit.status),
      booked_hours: Math.round(bookedHours * 10) / 10,
      booked_days: Math.round((bookedMs / 86400000) * 10) / 10,
      downtime_hours: Math.round((clippedMs(downtime) / 3600000) * 10) / 10,
      utilization_percent: Math.min(100, Math.round((bookedMs / (windowDays * 86400000)) * 100)),
      bookings: bookings.length,
      projected_cost_cents: projectedCents,
      service_cost_cents: serviceCents,
      fuel_cost_cents: fuelCents,
      total_cost_cents: serviceCents + fuelCents
    };
  }));
  return {
    start: new Date(start).toISOString(),
    end: new Date(end).toISOString(),
    window_days: Math.round(windowDays),
    units: units.sort((left, right) => right.booked_hours - left.booked_hours)
  };
}

/* Maintenance ----------------------------------------------------------------- */

/** Units a program applies to: its unit, or every active unit of its type. */
async function programUnits(orgId: string, program: JsonObject) {
  if (cleanText(program.unit_id)) {
    try {
      return [(await readUnit(orgId, cleanText(program.unit_id)))];
    } catch {
      return [];
    }
  }
  return (await listUnits(orgId, { ownership: "internal", typeId: cleanText(program.type_id) }))
    .filter((unit) => !["retired"].includes(cleanText(unit.status)));
}

export type DueServiceEntry = {
  program_id: string;
  program_name: string;
  program_kind: string;
  unit_id: string;
  unit_name: string;
  reason: "days" | "meter_hours" | "meter_miles";
  overdue: boolean;
  due_in_days: number | null;
  detail: string;
};

/** Due-soon computation: programs vs elapsed days and latest meter entries. */
export async function upcomingService(orgId: string, options: { horizonDays?: number } = {}) {
  const horizonDays = Math.max(1, Number(options.horizonDays || 30));
  const now = Date.now();
  const due: DueServiceEntry[] = [];
  for (const program of (await listPrograms(orgId))) {
    const trigger = program.trigger as JsonObject;
    const everyDays = Number(trigger.every_days || 0);
    const everyHours = Number(trigger.every_meter_hours || 0);
    const everyMiles = Number(trigger.every_meter_miles || 0);
    if (!everyDays && !everyHours && !everyMiles) continue;
    for (const unit of (await programUnits(orgId, program))) {
      const unitId = cleanText(unit.id);
      const lastCompleted = (await latestCompletedWorkOrder(orgId, unitId, cleanText(program.id)));
      const openOrders = (await listWorkOrders(orgId, { unitId, programId: cleanText(program.id) }))
        .filter((order) => !["completed", "canceled"].includes(cleanText(order.status)));
      if (openOrders.length) continue;
      const baselineAt = Date.parse(cleanText(lastCompleted?.completed_at || unit.created_at));
      if (everyDays && Number.isFinite(baselineAt)) {
        const elapsedDays = (now - baselineAt) / 86400000;
        const remaining = everyDays - elapsedDays;
        if (remaining <= horizonDays + Number(program.lead_time_days || 0)) {
          due.push({
            program_id: cleanText(program.id),
            program_name: cleanText(program.name),
            program_kind: cleanText(program.kind),
            unit_id: unitId,
            unit_name: cleanText(unit.name),
            reason: "days",
            overdue: remaining <= 0,
            due_in_days: Math.round(remaining),
            detail: remaining <= 0 ? `${Math.abs(Math.round(remaining))} days overdue` : `due in ${Math.round(remaining)} days`
          });
          continue;
        }
      }
      for (const [key, every, reason] of [["hours", everyHours, "meter_hours"], ["miles", everyMiles, "meter_miles"]] as const) {
        if (!every) continue;
        const latest = (await latestMeterEntry(orgId, unitId, key));
        const currentValue = Number(latest?.value ?? (unit.current_meter as JsonObject | undefined)?.[key] ?? 0);
        const baseline = Number((lastCompleted?.meter_at_service as JsonObject | undefined)?.[key] || 0);
        const used = currentValue - baseline;
        const remaining = every - used;
        // Meter intervals have no calendar horizon; surface within 10% of the interval.
        if (currentValue > 0 && remaining <= every * 0.1) {
          due.push({
            program_id: cleanText(program.id),
            program_name: cleanText(program.name),
            program_kind: cleanText(program.kind),
            unit_id: unitId,
            unit_name: cleanText(unit.name),
            reason,
            overdue: remaining <= 0,
            due_in_days: null,
            detail: remaining <= 0
              ? `${Math.abs(Math.round(remaining))} ${key} overdue`
              : `due in ${Math.round(remaining)} ${key}`
          });
          break;
        }
      }
    }
  }
  return due.sort((left, right) => Number(right.overdue) - Number(left.overdue) || (left.due_in_days ?? 0) - (right.due_in_days ?? 0));
}

/** Creates the work order a due-service entry (or a repair/inspection) needs. */
export async function openWorkOrder(orgId: string, input: JsonObject) {
  const unit = (await readUnit(orgId, cleanText(input.unit_id)));
  const program = cleanText(input.program_id) ? (await readProgram(orgId, cleanText(input.program_id))) : null;
  return (await saveWorkOrder(orgId, {
    ...input,
    id: "",
    unit_id: cleanText(unit.id),
    title: cleanText(input.title) || (program ? `${cleanText(program.name)} — ${cleanText(unit.name)}` : `Repair — ${cleanText(unit.name)}`),
    kind: cleanText(input.kind) || (program ? (cleanText(program.kind) === "inspection" ? "inspection" : "scheduled") : "repair"),
    status: "open"
  }));
}

/** Schedules a work order and (per settings) creates its downtime block: a
 * floating calendar event with an equipment_unit ref and kind
 * equipment_downtime, so it conflicts exactly like a project booking. */
export async function scheduleWorkOrder(orgId: string, workOrderId: string, input: JsonObject) {
  const workOrder = (await readWorkOrder(orgId, workOrderId));
  const unit = (await readUnit(orgId, cleanText(workOrder.unit_id)));
  const start = cleanText(input.start_at);
  const end = cleanText(input.end_at);
  if (!start || !end || !(Date.parse(end) > Date.parse(start))) {
    throw badRequest("equipment_work_order_window_invalid", "A valid start and end are required to schedule the work order.");
  }
  const { settings } = (await readModuleSettings(orgId));
  let downtimeEventId = cleanText(workOrder.downtime_event_id);
  if (settings.downtime_auto_block !== false) {
    downtimeEventId = downtimeEventId || newId("eqdown");
    await upsertDocument(orgId, "calendar_events", {
      id: downtimeEventId,
      data: {
        id: downtimeEventId,
        title: `Down: ${cleanText(unit.name)} — ${cleanText(workOrder.title)}`,
        kind: "equipment_downtime",
        event_type_default_id: "equipment_downtime",
        status: "scheduled",
        start_at: start,
        end_at: end,
        resource_refs: [{ kind: "equipment_unit", id: cleanText(unit.id), name: cleanText(unit.name), role: "equipment" }],
        equipment_work_order_id: cleanText(workOrder.id),
        color: "#64748b",
        icon: "fa-wrench",
        updated_at: nowIso()
      },
      metadata: { kind: "equipment_downtime", equipment_unit_id: cleanText(unit.id) }
    }, { replace: true });
  }
  return (await saveWorkOrder(orgId, {
    ...workOrder,
    status: "scheduled",
    scheduled_start_at: start,
    scheduled_end_at: end,
    downtime_event_id: downtimeEventId,
    expected_revision: Number(workOrder.revision || 0)
  }));
}

async function resolveDowntimeBlock(orgId: string, workOrder: JsonObject, status: string) {
  const downtimeEventId = cleanText(workOrder.downtime_event_id);
  if (!downtimeEventId) return;
  await upsertDocument(orgId, "calendar_events", {
    id: downtimeEventId,
    data: { status, updated_at: nowIso() }
  }, { replace: false }).catch(() => null);
}

/** Completes a work order: costs, meter-at-service (logged as a maintenance
 * meter entry), inspection outcomes (failed items can open a repair order and
 * set the unit down), and downtime release. */
export async function completeWorkOrder(orgId: string, workOrderId: string, input: JsonObject, userId = "") {
  const workOrder = (await readWorkOrder(orgId, workOrderId));
  if (["completed", "canceled"].includes(cleanText(workOrder.status))) {
    throw badRequest("equipment_work_order_closed", "This work order is already closed.");
  }
  const unit = (await readUnit(orgId, cleanText(workOrder.unit_id)));
  const meterAtService = asObj(input.meter_at_service);
  for (const key of ["hours", "miles"] as const) {
    const value = Number(meterAtService[key] || 0);
    if (value > 0) {
      (await logMeterEntry(orgId, {
        unit_id: cleanText(unit.id),
        kind: key,
        value,
        source: "maintenance",
        user_id: userId,
        notes: `Work order ${cleanText(workOrder.title)}`
      }));
    }
  }
  const checklistState = asArr(input.checklist_state).map(asObj);
  const failedItems = checklistState.filter((item) => item.passed === false);
  const completed = await Promise.resolve((await saveWorkOrder(orgId, {
    ...workOrder,
    status: "completed",
    completed_at: nowIso(),
    cost: asObj(input.cost),
    meter_at_service: meterAtService,
    checklist_state: checklistState,
    notes: cleanText(input.notes) || cleanText(workOrder.notes),
    expected_revision: Number(workOrder.revision || 0)
  })));
  await resolveDowntimeBlock(orgId, workOrder, "completed");
  let repairOrder: JsonObject | null = null;
  if (failedItems.length && input.open_repair !== false) {
    repairOrder = (await openWorkOrder(orgId, {
      unit_id: cleanText(unit.id),
      kind: "repair",
      title: `Repair — ${cleanText(unit.name)}: ${failedItems.map((item) => cleanText(item.label || item.id)).filter(Boolean).join(", ") || "failed inspection"}`,
      notes: `Opened by failed ${cleanText(workOrder.kind)} "${cleanText(workOrder.title)}".`
    }));
    if (input.set_unit_down === true) {
      (await patchUnit(orgId, cleanText(unit.id), { status: "down" }));
    }
  }
  return { work_order: completed, repair_order: repairOrder, failed_items: failedItems.length };
}

export async function cancelWorkOrder(orgId: string, workOrderId: string) {
  const workOrder = (await readWorkOrder(orgId, workOrderId));
  await resolveDowntimeBlock(orgId, workOrder, "canceled");
  return (await saveWorkOrder(orgId, {
    ...workOrder,
    status: "canceled",
    expected_revision: Number(workOrder.revision || 0)
  }));
}

export async function dashboard(orgId: string) {
  const units = (await fleetUnits(orgId, { ownership: "internal" }));
  const byStatus: Record<string, number> = {};
  for (const unit of units) {
    const status = cleanText(unit.status) || "available";
    byStatus[status] = (byStatus[status] || 0) + 1;
  }
  const types = (await listTypes(orgId));
  const openWorkOrders = (await listWorkOrders(orgId)).filter((order) => !["completed", "canceled"].includes(cleanText(order.status)));
  return {
    counts: {
      units: units.length,
      types: types.length,
      by_status: byStatus,
      checked_out: units.filter((unit) => cleanText((unit.custody as JsonObject | undefined)?.user_id)).length,
      open_work_orders: openWorkOrders.length
    },
    due_service: (await upcomingService(orgId)),
    open_work_orders: openWorkOrders,
    conflicts: [] as JsonObject[]
  };
}
