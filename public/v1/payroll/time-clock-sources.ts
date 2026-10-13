import type { AccessPolicy } from "../platform/publication/contracts.js";
import { badRequest } from "../platform/errors.js";
import type { DataExport } from "../platform/publication/providers.js";
import { contentHash } from "../platform/publication/validation.js";
import { readDocument, type JsonObject } from "../platform/storage.js";
import { listCrewTimeEventPage, listCrewTimeShiftPage } from "../workforce/crew_storage.js";

/**
 * The time clock, published. A clock is data about when somebody worked, when
 * they clocked in and out, and where they were; it knows nothing about pay.
 * Everything it collects is here as selectable rows, so anything that wants
 * hours (a pay rule, a report, a document) states which rows it wants.
 *
 * Every row has a string `id`, an `assignee_key` and a `revision` that is a
 * hash of the row's content, so it changes whenever anything in the row does,
 * including a distance that moved because the project's location was corrected.
 */
const access: AccessPolicy = { scopes: ["organization"], permissions: ["manage_payroll|manage_company_settings"], capabilities: ["apps.payroll"] };
const rows = { type: "array", items: { type: "object", required: ["id"], additionalProperties: true } };
const text = (value: unknown) => String(value ?? "").trim();
const object = (value: unknown): JsonObject => value && typeof value === "object" && !Array.isArray(value) ? value as JsonObject : {};
const array = (value: unknown) => Array.isArray(value) ? value : [];
const finite = (value: unknown) => { const number = value === null || value === undefined || value === "" ? NaN : Number(value); return Number.isFinite(number) ? number : null; };
const withRevision = <T extends JsonObject>(row: T) => ({ ...row, revision: `sha256:${contentHash(JSON.parse(JSON.stringify(row)))}` });

/** Where a clock event was recorded, as the device reported it. */
export function eventLocation(eventValue: unknown) {
  const data = object(object(eventValue).data);
  const location = object(data.location || data.geolocation || data.geo);
  const latitude = finite(location.latitude ?? location.lat), longitude = finite(location.longitude ?? location.lng ?? location.lon);
  const accuracy = finite(location.accuracy_meters ?? location.accuracy);
  return {
    status: text(location.status || (latitude !== null && longitude !== null ? "captured" : "unavailable")),
    ...(latitude !== null && longitude !== null ? { latitude, longitude } : {}),
    ...(accuracy !== null ? { accuracy_meters: accuracy } : {}),
    captured_at: text(location.captured_at),
    reason: text(location.reason)
  };
}

export function distanceMeters(leftValue: unknown, rightValue: unknown) {
  const left = object(leftValue), right = object(rightValue);
  const lat1 = finite(left.latitude ?? left.lat), lon1 = finite(left.longitude ?? left.lng ?? left.lon);
  const lat2 = finite(right.latitude ?? right.lat), lon2 = finite(right.longitude ?? right.lng ?? right.lon);
  if (lat1 === null || lon1 === null || lat2 === null || lon2 === null) return null;
  const radians = (value: number) => value * Math.PI / 180;
  const dLat = radians(lat2 - lat1), dLon = radians(lon2 - lon1);
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(radians(lat1)) * Math.cos(radians(lat2)) * Math.sin(dLon / 2) ** 2;
  return Math.round(6_371_000 * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a)));
}

/** Where a project is, from its own record. */
export function projectLocation(documentValue: unknown) {
  const data = object(object(documentValue).data), measurement = object(data.measurement);
  const latitude = finite(data.latitude ?? data.lat ?? measurement.latitude ?? measurement.lat);
  const longitude = finite(data.longitude ?? data.lng ?? measurement.longitude ?? measurement.lng);
  return latitude === null || longitude === null ? {} : { latitude, longitude };
}

async function projectLocations(orgId: string, projectIds: string[]) {
  const found = new Map<string, JsonObject>();
  await Promise.all([...new Set(projectIds.filter(Boolean))].map(async (id) => {
    found.set(id, projectLocation(await readDocument(orgId, "projects", id).catch(() => null)));
  }));
  return found;
}

/** The place fields of one event, with how far it was from the project when both places are known. */
function place(event: unknown, project: JsonObject | undefined) {
  const location = eventLocation(event), distance = distanceMeters(location, project);
  return {
    location_status: location.status,
    ...("latitude" in location ? { latitude: location.latitude, longitude: location.longitude } : {}),
    ...("accuracy_meters" in location ? { accuracy_meters: location.accuracy_meters } : {}),
    location_captured_at: location.captured_at, location_reason: location.reason,
    ...(distance === null ? {} : { distance_to_project_meters: distance })
  };
}

function shiftRow(shift: JsonObject, locations: Map<string, JsonObject>) {
  const events = array(shift.events).map(object), metadata = object(shift.metadata), closed = text(shift.status) === "closed";
  const project = locations.get(text(shift.project_id));
  const punch = (action: string) => {
    const event = events.find((entry) => text(entry.action) === action);
    return event ? { event_id: text(event.id), occurred_at: text(event.occurred_at), ...place(event, project) } : { event_id: "", occurred_at: "", location_status: "unavailable", location_captured_at: "", location_reason: "not_recorded" };
  };
  const corrections = array(shift.audit).map(object).filter((entry) => text(entry.action) === "corrected");
  return withRevision({
    id: text(shift.id), shift_revision: Number(shift.revision || 1), user_id: text(shift.user_id), assignee_key: `organization_user:${text(shift.user_id)}`, project_id: text(shift.project_id),
    status: text(shift.status), timezone: text(metadata.timezone), source: text(metadata.source),
    clocked_in_at: text(shift.clocked_in_at), clocked_out_at: text(shift.clocked_out_at),
    on_break: shift.on_break === true, active_break_started_at: text(shift.active_break_started_at),
    // Finished breaks only. A break in progress is not counted until it ends.
    break_seconds: Math.max(0, Number(shift.finished_break_seconds || 0)), break_count: events.filter((entry) => text(entry.action) === "break_start").length,
    // A shift still on the clock has no duration here: it would change every second with nothing recording that it had.
    ...(closed ? { elapsed_seconds: Number(shift.elapsed_seconds || 0), worked_seconds: Number(shift.worked_seconds || 0) } : {}),
    approval_status: text(shift.approval_status), approved_at: text(shift.approved_at), approved_by_user_id: text(shift.approved_by_user_id),
    rejected_at: text(shift.rejected_at), rejected_by_user_id: text(shift.rejected_by_user_id), manager_note: text(shift.manager_note),
    corrected: corrections.length > 0, correction_count: corrections.length,
    last_corrected_at: text(corrections.at(-1)?.at), last_corrected_by_user_id: text(corrections.at(-1)?.actor_user_id),
    clock_in: punch("clock_in"), ...(closed ? { clock_out: punch("clock_out") } : {}),
    created_at: text(shift.created_at), updated_at: text(shift.updated_at)
  });
}

function eventRow(event: JsonObject, locations: Map<string, JsonObject>) {
  const data = object(event.data), shift = object(event.shift), request = object(data.request);
  // An event belongs to the project its shift is on now, so a corrected shift carries its events with it.
  const projectId = text(shift.project_id || data.project_id), seconds = finite(data.break_seconds);
  return withRevision({
    id: text(event.id), shift_id: text(event.shift_id), user_id: text(event.user_id), assignee_key: `organization_user:${text(event.user_id)}`, project_id: projectId,
    action: text(event.action), occurred_at: text(event.occurred_at),
    automatic: data.automatic === true, automatic_reason: data.automatic === true ? text(data.reason) : "",
    ...(seconds === null ? {} : { break_seconds: seconds }),
    ...place(event, locations.get(projectId)),
    timezone: text(data.timezone), source: text(data.source), client_path: text(data.client_path), ip_address: text(request.ip), user_agent: text(request.user_agent),
    shift_status: text(shift.status), shift_approval_status: text(shift.approval_status)
  });
}

function changeRows(shift: JsonObject) {
  return array(shift.audit).map(object).map((entry, index) => withRevision({
    // The trail is only ever added to, so a change's place in it is its identity.
    id: `${text(shift.id)}:${index + 1}`, shift_id: text(shift.id), user_id: text(shift.user_id), assignee_key: `organization_user:${text(shift.user_id)}`, project_id: text(shift.project_id),
    sequence: index + 1, action: text(entry.action), actor_user_id: text(entry.actor_user_id), at: text(entry.at), note: text(entry.note),
    ...(entry.before ? { before: object(entry.before) } : {}), ...(entry.after ? { after: object(entry.after) } : {})
  }));
}

const listOnly = (what: string) => async () => { throw badRequest("source_list_required", `List or select ${what}; there can be too many to read at once.`); };
const placeUnits = { accuracy_meters: "meters", distance_to_project_meters: "meters" };

export const TIME_CLOCK_EXPORTS = ["time_shifts", "time_clock_events", "time_shift_changes"] as const;
export function timeClockExports(): Record<typeof TIME_CLOCK_EXPORTS[number], DataExport> {
  return {
    time_shifts: {
      description: "Every time clock shift, one row each, including shifts still on the clock (`status` active or closed): who worked (`user_id`, `assignee_key`), `project_id`, `clocked_in_at`, `clocked_out_at`, finished `break_seconds` and `break_count`, `timezone`, and under `clock_in` and `clock_out` when and where each happened (`occurred_at`, `location_status` captured, denied or unavailable, `latitude`, `longitude`, `accuracy_meters`, `location_reason`, `distance_to_project_meters`). Review: `approval_status` (active, pending, approved, rejected), who approved or rejected it and when, `manager_note`, and whether and when it was corrected. `elapsed_seconds` and `worked_seconds` (net of breaks) are present only once a shift is closed. `revision` changes whenever anything in the row does.",
      schema: rows, schemaVersion: "2", access, units: { worked_seconds: "seconds", elapsed_seconds: "seconds", break_seconds: "seconds", "clock_in.accuracy_meters": "meters", "clock_in.distance_to_project_meters": "meters", "clock_out.accuracy_meters": "meters", "clock_out.distance_to_project_meters": "meters" },
      read: listOnly("time shifts"),
      list: async (ctx, _ref, page) => {
        const shifts = await listCrewTimeShiftPage(ctx.organizationId, { after: page.cursor, limit: page.limit + 1 });
        const shown = shifts.slice(0, page.limit) as JsonObject[];
        const locations = await projectLocations(ctx.organizationId, shown.map((shift) => text(shift.project_id)));
        return { items: shown.map((shift) => shiftRow(shift, locations)), ...(shifts.length > page.limit ? { nextCursor: text(shown.at(-1)!.id) } : {}) };
      }
    },
    time_clock_events: {
      description: "Every time clock event, one row each: `action` (clock_in, break_start, break_end, clock_out), `occurred_at`, the shift (`shift_id`, `shift_status`, `shift_approval_status`), who (`user_id`, `assignee_key`), `project_id`, where it was recorded (`location_status`, `latitude`, `longitude`, `accuracy_meters`, `location_captured_at`, `location_reason`, `distance_to_project_meters` when both places are known), `break_seconds` on a break's end, whether the clock made the event itself (`automatic`, `automatic_reason`), and what recorded it (`timezone`, `source`, `client_path`, `ip_address`, `user_agent`).",
      schema: rows, schemaVersion: "1", access, units: { break_seconds: "seconds", ...placeUnits },
      read: listOnly("time clock events"),
      list: async (ctx, _ref, page) => {
        const events = await listCrewTimeEventPage(ctx.organizationId, { after: page.cursor, limit: page.limit + 1 });
        const shown = events.slice(0, page.limit) as JsonObject[];
        const locations = await projectLocations(ctx.organizationId, shown.map((event) => text(object(event.shift).project_id || object(event.data).project_id)));
        return { items: shown.map((event) => eventRow(event, locations)), ...(events.length > page.limit ? { nextCursor: text(shown.at(-1)!.id) } : {}) };
      }
    },
    time_shift_changes: {
      description: "Everything a manager did to a shift after it was clocked, one row per change in order: `action` (corrected, approved, rejected, pending), `actor_user_id`, `at`, `note`, and for a correction the clock times, break and project `before` and `after`. Rows are only ever added.",
      schema: rows, schemaVersion: "1", access, units: { "before.break_seconds": "seconds", "after.break_seconds": "seconds" },
      read: listOnly("time shift changes"),
      list: async (ctx, _ref, page) => {
        // The cursor is the shift to resume in and how many of its changes were already returned.
        const [from, skipped] = (page.cursor || "").split("\t");
        let skip = Number(skipped || 0);
        const shifts = await listCrewTimeShiftPage(ctx.organizationId, { ...(from ? { from } : {}), limit: page.limit + 1 }) as JsonObject[];
        const items: JsonObject[] = [];
        for (const [index, shift] of shifts.entries()) {
          const changes = changeRows(shift).slice(skip);
          const room = page.limit - items.length;
          if (changes.length > room || index === page.limit) return { items: [...items, ...changes.slice(0, index === page.limit ? 0 : room)], nextCursor: `${text(shift.id)}\t${skip + (index === page.limit ? 0 : room)}` };
          items.push(...changes);
          skip = 0;
        }
        return { items };
      }
    }
  };
}
