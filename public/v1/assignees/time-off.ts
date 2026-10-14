import { randomBytes } from "node:crypto";
import { z } from "zod";
import { badRequest, conflict } from "../platform/errors.js";
import { getAssigneeDatabase, requireActor, requireAssigneeRecord, type Actor } from "./base.js";
import { assigneeKey, assigneeRefSchema, type AssigneeKind, type AssigneeRef } from "./contract.js";

/**
 * Time off: when a person, or an outside company, cannot be given work. Each entry is one exact interval, stored as
 * two instants, so someone can be off for part of a day. Whether a screen shows that by the day or by the hour is the
 * screen's choice; everything that compares time off with work compares these instants.
 *
 * A group of users has no time off of its own: its people do. The older whole-day exceptions in the scheduling
 * settings (`resource_availability[...].exceptions`) are still read by the roster as whole local days.
 */
const instant = z.string().trim().max(40).refine((value) => Number.isFinite(Date.parse(value)), "Use an ISO date-time.");
export const timeOffInputSchema = z.object({
  id: z.string().trim().regex(/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,119}$/).optional(),
  assignee: assigneeRefSchema,
  /** The first instant they are off. */
  from: instant,
  /** The instant they are back. The interval does not include it. */
  until: instant,
  reason: z.string().trim().max(300).optional(),
  expected_revision: z.number().int().positive().optional()
}).strict().refine((value) => Date.parse(value.from) < Date.parse(value.until), "Time off must end after it starts.");
export type TimeOff = { id: string; assignee: AssigneeRef; assignee_id: string; from: string; until: string; reason: string; revision: number };

const text = (value: unknown) => String(value ?? "").trim();
const view = (row: Record<string, unknown>): TimeOff => {
  const assignee = { type: text(row.assignee_kind) as AssigneeKind, id: text(row.assignee_id) };
  return { id: text(row.id), assignee, assignee_id: assigneeKey(assignee), from: text(row.starts_at), until: text(row.ends_at), reason: text(row.reason), revision: Number(row.revision || 1) };
};
const iso = (value: string) => new Date(Date.parse(value)).toISOString();

/** Time off that touches a range, or all of it. Instants are stored as UTC ISO strings, so they compare as text. Reads only. */
export async function listTimeOff(orgId: string, range: { from?: string; until?: string; assignee?: AssigneeRef } = {}): Promise<TimeOff[]> {
  const where = ["organization_id=?"], values: string[] = [orgId];
  if (range.from) { where.push("ends_at > ?"); values.push(iso(range.from)); }
  if (range.until) { where.push("starts_at < ?"); values.push(iso(range.until)); }
  if (range.assignee) { where.push("assignee_kind=? AND assignee_id=?"); values.push(range.assignee.type, range.assignee.id); }
  return (await getAssigneeDatabase().prepare(`SELECT * FROM assignee_time_off WHERE ${where.join(" AND ")} ORDER BY starts_at ASC, id ASC`).all(...values)).map(view);
}
export async function saveTimeOff(orgId: string, input: unknown, actor: Actor): Promise<TimeOff> {
  requireActor(orgId, actor, "manage_schedule", "assignee_time_off_denied", "Recording time off requires schedule management access.");
  const parsed = timeOffInputSchema.parse(input);
  const record = await requireAssigneeRecord(orgId, parsed.assignee);
  if (record.traits.has_members) throw badRequest("assignee_time_off_group", "Record time off for the people in a group, not for the group.");
  return storeTimeOff(orgId, parsed, text(actor.userId));
}
/** The one writer of a time off entry. Callers authorize and check the assignee first. */
export async function storeTimeOff(orgId: string, parsed: z.infer<typeof timeOffInputSchema>, userId: string): Promise<TimeOff> {
  const id = parsed.id || `time_off_${randomBytes(9).toString("hex")}`;
  const now = new Date().toISOString();
  return getAssigneeDatabase().transaction(async (db) => {
    const current = await db.prepare("SELECT * FROM assignee_time_off WHERE organization_id=? AND id=?").get(orgId, id);
    if (parsed.expected_revision !== undefined && Number(current?.revision || 0) !== parsed.expected_revision) throw conflict("assignee_time_off_revision_conflict", "This time off changed elsewhere. Reload and try again.");
    if (current) await db.prepare("UPDATE assignee_time_off SET assignee_kind=?, assignee_id=?, starts_at=?, ends_at=?, reason=?, revision=revision+1, updated_at=?, updated_by_user_id=? WHERE organization_id=? AND id=?")
      .run(parsed.assignee.type, parsed.assignee.id, iso(parsed.from), iso(parsed.until), parsed.reason || "", now, userId, orgId, id);
    else await db.prepare("INSERT INTO assignee_time_off (organization_id, id, assignee_kind, assignee_id, starts_at, ends_at, reason, revision, created_at, updated_at, updated_by_user_id) VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?)")
      .run(orgId, id, parsed.assignee.type, parsed.assignee.id, iso(parsed.from), iso(parsed.until), parsed.reason || "", now, now, userId);
    return view((await db.prepare("SELECT * FROM assignee_time_off WHERE organization_id=? AND id=?").get(orgId, id))!);
  }, `${orgId}:time-off:${id}`);
}
export async function removeTimeOff(orgId: string, input: unknown, actor: Actor) {
  requireActor(orgId, actor, "manage_schedule", "assignee_time_off_denied", "Recording time off requires schedule management access.");
  const parsed = z.object({ id: z.string().trim().min(1).max(120) }).strict().parse(input);
  const result = await getAssigneeDatabase().prepare("DELETE FROM assignee_time_off WHERE organization_id=? AND id=?").run(orgId, parsed.id);
  if (!result.changes) throw badRequest("assignee_time_off_unknown", "This time off is unavailable.");
  return { id: parsed.id, removed: true };
}
