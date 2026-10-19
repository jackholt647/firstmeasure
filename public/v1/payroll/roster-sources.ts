/*
 * Who was, or will be, on each piece of scheduled work, published for pay rules and split rules
 * (docs/architecture/pay-rules.md "Split rules" and "Projected earnings").
 *
 * Every project schedule event that names an assignee is resolved by the schedule roster (`scheduling/roster.ts`
 * `readEventRosters`, the same answer `schedule-roster.events` publishes): who is on it, through which assignee, and
 * the exact intervals they are on it after removals, time off and unavailability. Each interval is one row. A row is
 * about one person (`assignee_key` `organization_user:<id>`) or one outside company, names the `project_id` and
 * `event_id`, and carries exact `from` and `until` instants and `seconds`. `revision` changes with anything in the row,
 * so a split that read it is worked out again when the roster changes.
 *
 * The same rows, from now on, are the time clock's projected reading (`time_shifts` with `projected: true`): each
 * future interval looks like an approved, closed shift of that length, so an hourly rule projects scheduled hours.
 */
import { assignmentFromEvent, eventWindow } from "../assignees/roster.js";
import type { PlatformAuthContext } from "../platform/auth.js";
import { contentHash } from "../platform/publication/validation.js";
import { listDocuments, type JsonObject } from "../platform/storage.js";

const text = (value: unknown) => String(value ?? "").trim();
const object = (value: unknown): JsonObject => value && typeof value === "object" && !Array.isArray(value) ? value as JsonObject : {};
const BATCH = 200;

export type RosterRow = JsonObject & { id: string; revision: string; assignee_key: string; project_id: string; event_id: string; from: string; until: string; seconds: number };

/** Rows for every project schedule event that touches `[from, until)` (all events when left out). Reads only. */
export async function workRosterRows(orgId: string, auth: PlatformAuthContext | null | undefined, window: { from?: string; until?: string } = {}): Promise<RosterRow[]> {
  const from = window.from ? Date.parse(window.from) : -Infinity, until = window.until ? Date.parse(window.until) : Infinity;
  const wanted: { project_id: string; event_id: string; title: string }[] = [];
  for (const document of await listDocuments(orgId, "projects")) {
    const data = object(document.data);
    for (const raw of Array.isArray(data.events) ? data.events : []) {
      const event = object(raw), range = eventWindow(event), id = text(event.id);
      if (!range || !id || !assignmentFromEvent(event).length) continue;
      if (!(Date.parse(range.from) < until && from < Date.parse(range.until))) continue;
      wanted.push({ project_id: document.id, event_id: id, title: text(event.title) || text(data.title || data.address) });
    }
  }
  const { readEventRosters } = await import("../scheduling/roster.js");
  const rows: RosterRow[] = [];
  for (let index = 0; index < wanted.length; index += BATCH) {
    const batch = wanted.slice(index, index + BATCH);
    const titles = new Map(batch.map((entry) => [`${entry.project_id}:${entry.event_id}`, entry.title]));
    const result = await readEventRosters(orgId, auth, "default", { events: batch.map(({ project_id, event_id }) => ({ project_id, event_id })), include_children: false });
    for (const read of result.events) {
      const title = titles.get(`${read.project_id}:${read.event_id}`) || "";
      const add = (who: { assignee_key: string; user_id: string; name: string; via: string[] }, present: { from: string; until: string }[]) => present.forEach((interval, at) => {
        const row = { id: `${read.project_id}:${read.event_id}:${who.assignee_key}:${at}`, ...who, project_id: read.project_id, event_id: read.event_id, parent_event_id: read.parent_event_id, title,
          from: interval.from, until: interval.until, seconds: Math.max(0, Math.round((Date.parse(interval.until) - Date.parse(interval.from)) / 1000)) };
        rows.push({ ...row, revision: contentHash(row) } as RosterRow);
      });
      for (const person of read.roster?.people || []) add({ assignee_key: `organization_user:${person.user_id}`, user_id: person.user_id, name: person.name, via: person.via }, person.present);
      for (const party of read.roster?.parties || []) add({ assignee_key: party.id, user_id: "", name: party.name, via: [] }, party.present);
    }
  }
  return rows.sort((a, b) => a.from.localeCompare(b.from) || a.id.localeCompare(b.id));
}

/** How far ahead the time clock's projected reading looks. */
export const PROJECTED_SHIFT_DAYS = 35;
/**
 * The time clock's projected reading: every person's scheduled time from now to `PROJECTED_SHIFT_DAYS` ahead, as the
 * approved, closed shifts it is expected to become (`projected: true`, `expected_from: schedule_event`). The part of an
 * interval already past is left to the real time clock. Reads only.
 */
export async function projectedShiftRows(orgId: string, auth: PlatformAuthContext | null | undefined, asOf = new Date().toISOString()): Promise<JsonObject[]> {
  const now = Date.parse(asOf), horizon = new Date(now + PROJECTED_SHIFT_DAYS * 86_400_000).toISOString();
  const rows = await workRosterRows(orgId, auth, { from: asOf, until: horizon });
  return rows.filter((row) => text(row.user_id) && Date.parse(row.until) > now).map((row) => {
    const start = new Date(Math.max(now, Date.parse(row.from))).toISOString(), end = new Date(Math.min(Date.parse(horizon), Date.parse(row.until))).toISOString();
    const seconds = Math.max(0, Math.round((Date.parse(end) - Date.parse(start)) / 1000));
    const shift = { id: `scheduled:${row.id}`, user_id: row.user_id, assignee_key: row.assignee_key, project_id: row.project_id, event_id: row.event_id, status: "closed", approval_status: "approved",
      clocked_in_at: start, clocked_out_at: end, break_seconds: 0, break_count: 0, elapsed_seconds: seconds, worked_seconds: seconds, projected: true, expected_from: "schedule_event", title: row.title };
    return { ...shift, revision: contentHash(shift) };
  });
}
