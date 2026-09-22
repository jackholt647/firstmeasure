import { isPunchList } from "./punch_lists.js";
import { createHash, randomUUID } from "node:crypto";

import { badRequest, conflict, notFound } from "../platform/errors.js";
import type { JsonObject } from "../platform/storage.js";
import { getWorkforceDatabase, withWorkforceTransaction } from "./storage.js";

const CREW_SCHEMA_VERSION = 1;

function cleanText(value: unknown) {
  return String(value ?? "").trim();
}

function asObject(value: unknown): JsonObject {
  return value && typeof value === "object" && !Array.isArray(value) ? { ...(value as JsonObject) } : {};
}

function asArray(value: unknown) {
  return Array.isArray(value) ? value : [];
}

function json(value: unknown) {
  return JSON.stringify(value ?? {});
}

function parseJson(value: unknown, fallback: unknown = {}) {
  try {
    return cleanText(value) ? JSON.parse(cleanText(value)) : fallback;
  } catch {
    return fallback;
  }
}

function nowIso() {
  return new Date().toISOString();
}

function ensureCrewSchema() {
  const db = getWorkforceDatabase();


}

type ShiftRow = Record<string, unknown>;

function secondsBetween(startValue: unknown, endValue: unknown) {
  const start = Date.parse(cleanText(startValue));
  const end = Date.parse(cleanText(endValue));
  if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) return 0;
  return Math.max(0, Math.floor((end - start) / 1000));
}

function shiftView(rowValue: unknown, at = nowIso()) {
  if (!rowValue) return null;
  const row = asObject(rowValue);
  const activeBreakStartedAt = cleanText(row.active_break_started_at);
  const storedBreakSeconds = Math.max(0, Number(row.break_seconds || 0));
  const liveBreakSeconds = cleanText(row.status) === "active" && activeBreakStartedAt
    ? secondsBetween(activeBreakStartedAt, at)
    : 0;
  const endAt = cleanText(row.clocked_out_at) || at;
  const elapsedSeconds = secondsBetween(row.clocked_in_at, endAt);
  const breakSeconds = storedBreakSeconds + liveBreakSeconds;
  return {
    schema_version: CREW_SCHEMA_VERSION,
    id: cleanText(row.id),
    organization_id: cleanText(row.organization_id),
    user_id: cleanText(row.user_id),
    status: cleanText(row.status || "active"),
    clocked_in_at: cleanText(row.clocked_in_at),
    clocked_out_at: cleanText(row.clocked_out_at),
    active_break_started_at: activeBreakStartedAt,
    on_break: !!activeBreakStartedAt && cleanText(row.status) === "active",
    elapsed_seconds: elapsedSeconds,
    break_seconds: breakSeconds,
    worked_seconds: Math.max(0, elapsedSeconds - breakSeconds),
    metadata: asObject(parseJson(row.metadata_json)),
    revision: Number(row.revision || 1),
    created_at: cleanText(row.created_at),
    updated_at: cleanText(row.updated_at),
    deleted_at: cleanText(row.deleted_at)
  };
}

function timeEventView(rowValue: unknown) {
  const row = asObject(rowValue);
  return {
    id: cleanText(row.id),
    organization_id: cleanText(row.organization_id),
    user_id: cleanText(row.user_id),
    shift_id: cleanText(row.shift_id),
    action: cleanText(row.action),
    occurred_at: cleanText(row.occurred_at),
    data: asObject(parseJson(row.data_json)),
    created_at: cleanText(row.created_at)
  };
}

function timesheetState(metadataValue: unknown, statusValue: unknown) {
  const metadata = asObject(metadataValue);
  const timesheet = asObject(metadata.timesheet);
  if (cleanText(statusValue) === "active") return "active";
  return ["approved", "rejected", "pending"].includes(cleanText(timesheet.status)) ? cleanText(timesheet.status) : "pending";
}

function timesheetShiftView(rowValue: unknown, events: JsonObject[] = []) {
  const shift = shiftView(rowValue);
  if (!shift) return null;
  const metadata = asObject(shift.metadata);
  const timesheet = asObject(metadata.timesheet);
  return {
    ...shift,
    approval_status: timesheetState(metadata, shift.status),
    project_id: cleanText(metadata.project_id),
    manager_note: cleanText(timesheet.manager_note),
    approved_by_user_id: cleanText(timesheet.approved_by_user_id),
    approved_at: cleanText(timesheet.approved_at),
    rejected_by_user_id: cleanText(timesheet.rejected_by_user_id),
    rejected_at: cleanText(timesheet.rejected_at),
    payroll_entry_id: cleanText(timesheet.payroll_entry_id),
    audit: asArray(timesheet.audit).map(asObject),
    events
  };
}

async function activeShiftRow(orgId: string, userId: string) {
  ensureCrewSchema();
  return (await getWorkforceDatabase().prepare(`SELECT * FROM crew_time_shifts
    WHERE organization_id=? AND user_id=? AND status='active' ORDER BY clocked_in_at DESC LIMIT 1`).get(orgId, userId)) as ShiftRow | undefined;
}

async function latestShiftRow(orgId: string, userId: string) {
  ensureCrewSchema();
  return (await getWorkforceDatabase().prepare(`SELECT * FROM crew_time_shifts
    WHERE organization_id=? AND user_id=? ORDER BY clocked_in_at DESC LIMIT 1`).get(orgId, userId)) as ShiftRow | undefined;
}

export async function readCrewTimeClock(orgId: string, userId: string) {
  ensureCrewSchema();
  const currentRow = (await activeShiftRow(orgId, userId));
  const latestRow = currentRow || (await latestShiftRow(orgId, userId));
  const shiftId = cleanText(asObject(currentRow).id || asObject(latestRow).id);
  const events = shiftId
    ? (await getWorkforceDatabase().prepare(`SELECT * FROM crew_time_events WHERE organization_id=? AND shift_id=? ORDER BY occurred_at ASC`)
      .all(orgId, shiftId)).map(timeEventView)
    : [];
  return {
    active: !!currentRow,
    current_shift: shiftView(currentRow),
    latest_shift: shiftView(latestRow),
    events
  };
}

export async function readCrewTimeShift(orgId: string, shiftId: string) {
  ensureCrewSchema();
  const row = (await getWorkforceDatabase().prepare("SELECT * FROM crew_time_shifts WHERE organization_id=? AND id=?").get(orgId, shiftId));
  if (!row) throw notFound("time_shift_not_found", "The time shift was not found.");
  const events = (await getWorkforceDatabase().prepare(`SELECT * FROM crew_time_events
    WHERE organization_id=? AND shift_id=? ORDER BY occurred_at ASC`).all(orgId, shiftId)).map(timeEventView);
  return timesheetShiftView(row, events) as JsonObject;
}

export async function listCrewTimeShifts(orgId: string, options: JsonObject = {}) {
  ensureCrewSchema();
  const conditions = ["organization_id=?"];
  const params: Array<string | number> = [orgId];
  if (cleanText(options.user_id)) { conditions.push("user_id=?"); params.push(cleanText(options.user_id)); }
  if (cleanText(options.from)) { conditions.push("clocked_in_at>=?"); params.push(cleanText(options.from)); }
  if (cleanText(options.through)) { conditions.push("clocked_in_at<=?"); params.push(cleanText(options.through)); }
  if (cleanText(options.status)) { conditions.push("status=?"); params.push(cleanText(options.status)); }
  const limit = Math.min(1000, Math.max(1, Number(options.limit || 500)));
  const rows = (await getWorkforceDatabase().prepare(`SELECT * FROM crew_time_shifts WHERE ${conditions.join(" AND ")}
    ORDER BY clocked_in_at DESC LIMIT ?`).all(...params, limit));
  if (!rows.length) return [];
  const ids = rows.map((row) => cleanText(asObject(row).id));
  const placeholders = ids.map(() => "?").join(",");
  const events = (await getWorkforceDatabase().prepare(`SELECT * FROM crew_time_events WHERE organization_id=?
    AND shift_id IN (${placeholders}) ORDER BY occurred_at ASC`).all(orgId, ...ids)).map(timeEventView);
  const byShift = new Map<string, JsonObject[]>();
  for (const event of events) {
    const list = byShift.get(cleanText(event.shift_id)) || [];
    list.push(event);
    byShift.set(cleanText(event.shift_id), list);
  }
  return rows.map((row) => timesheetShiftView(row, byShift.get(cleanText(asObject(row).id)) || []));
}

export async function patchCrewTimeShift(orgId: string, shiftId: string, inputValue: unknown, actorUserId: string) {
  return (await getWorkforceDatabase().transaction(async () => {
  ensureCrewSchema();
  const input = asObject(inputValue);
  const row = (await getWorkforceDatabase().prepare("SELECT * FROM crew_time_shifts WHERE organization_id=? AND id=?").get(orgId, shiftId));
  if (!row) throw notFound("time_shift_not_found", "The time shift was not found.");
  const current = shiftView(row) as JsonObject;
  const expected = Number(input.expected_revision || 0);
  if (expected && expected !== Number(current.revision || 0)) {
    throw conflict("time_shift_revision_conflict", "The timesheet changed elsewhere. Reload and try again.", { current_revision: current.revision });
  }
  if (cleanText(current.status) === "active") throw conflict("active_time_shift_not_editable", "Clock the worker out before correcting this timesheet.");
  const start = cleanText(input.clocked_in_at || current.clocked_in_at);
  const end = cleanText(input.clocked_out_at || current.clocked_out_at);
  const startMs = Date.parse(start);
  const endMs = Date.parse(end);
  if (!Number.isFinite(startMs) || !Number.isFinite(endMs) || endMs <= startMs) {
    throw badRequest("time_shift_window_invalid", "Clock-out must be after clock-in.");
  }
  const elapsedSeconds = Math.floor((endMs - startMs) / 1000);
  const breakSeconds = Math.max(0, Math.round(Number(input.break_seconds ?? current.break_seconds ?? 0)));
  if (breakSeconds >= elapsedSeconds) throw badRequest("time_shift_break_invalid", "Break time must be shorter than the shift.");
  const metadata = asObject(current.metadata);
  const oldTimesheet = asObject(metadata.timesheet);
  const audit = asArray(oldTimesheet.audit).map(asObject);
  audit.push({
    action: "corrected", actor_user_id: actorUserId, at: nowIso(),
    before: { clocked_in_at: current.clocked_in_at, clocked_out_at: current.clocked_out_at, break_seconds: current.break_seconds, project_id: cleanText(metadata.project_id) },
    after: { clocked_in_at: start, clocked_out_at: end, break_seconds: breakSeconds, project_id: cleanText(input.project_id ?? metadata.project_id) },
    note: cleanText(input.manager_note)
  });
  const nextMetadata = {
    ...metadata,
    project_id: cleanText(input.project_id ?? metadata.project_id),
    timesheet: { status: "pending", manager_note: cleanText(input.manager_note), audit }
  };
  const now = nowIso();
  (await getWorkforceDatabase().prepare(`UPDATE crew_time_shifts SET clocked_in_at=?, clocked_out_at=?, break_seconds=?,
    metadata_json=?, revision=revision+1, updated_at=? WHERE organization_id=? AND id=?`)
    .run(start, end, breakSeconds, json(nextMetadata), now, orgId, shiftId));
  return (await readCrewTimeShift(orgId, shiftId));

  }));
}

export async function setCrewTimeShiftApproval(orgId: string, shiftId: string, inputValue: unknown, actorUserId: string) {
  return (await getWorkforceDatabase().transaction(async () => {
  ensureCrewSchema();
  const input = asObject(inputValue);
  const status = cleanText(input.status);
  if (!["approved", "rejected", "pending"].includes(status)) throw badRequest("timesheet_status_invalid", "Choose approved, rejected, or pending.");
  const current = (await readCrewTimeShift(orgId, shiftId));
  if (cleanText(current.status) === "active") throw conflict("active_time_shift_not_approvable", "Clock the worker out before reviewing this timesheet.");
  const expected = Number(input.expected_revision || 0);
  if (expected && expected !== Number(current.revision || 0)) {
    throw conflict("time_shift_revision_conflict", "The timesheet changed elsewhere. Reload and try again.", { current_revision: current.revision });
  }
  const metadata = asObject(current.metadata);
  const prior = asObject(metadata.timesheet);
  const audit = asArray(prior.audit).map(asObject);
  const at = nowIso();
  audit.push({ action: status, actor_user_id: actorUserId, at, note: cleanText(input.manager_note) });
  const timesheet = {
    ...prior,
    status,
    manager_note: cleanText(input.manager_note ?? prior.manager_note),
    audit,
    ...(status === "approved" ? { approved_by_user_id: actorUserId, approved_at: at, rejected_by_user_id: "", rejected_at: "" } : {}),
    ...(status === "rejected" ? { rejected_by_user_id: actorUserId, rejected_at: at, approved_by_user_id: "", approved_at: "" } : {}),
    ...(status === "pending" ? { approved_by_user_id: "", approved_at: "", rejected_by_user_id: "", rejected_at: "" } : {}),
    ...(Object.prototype.hasOwnProperty.call(input, "payroll_entry_id") ? { payroll_entry_id: cleanText(input.payroll_entry_id) } : {})
  };
  (await getWorkforceDatabase().prepare(`UPDATE crew_time_shifts SET metadata_json=?, revision=revision+1, updated_at=?
    WHERE organization_id=? AND id=?`).run(json({ ...metadata, timesheet }), at, orgId, shiftId));
  return (await readCrewTimeShift(orgId, shiftId));

  }));
}

async function insertTimeEvent(
  orgId: string,
  userId: string,
  shiftId: string,
  action: string,
  occurredAt: string,
  data: JsonObject = {}
) {
  const eventId = `time_event_${randomUUID()}`;
  (await getWorkforceDatabase().prepare(`INSERT INTO crew_time_events
    (id, organization_id, user_id, shift_id, action, occurred_at, data_json, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(eventId, orgId, userId, shiftId, action, occurredAt, json(data), occurredAt));
  return timeEventView((await getWorkforceDatabase().prepare("SELECT * FROM crew_time_events WHERE id=?").get(eventId)));
}

export async function performCrewTimeClockAction(
  orgId: string,
  userId: string,
  actionValue: unknown,
  metadataValue: unknown = {}
) {
  return (await getWorkforceDatabase().transaction(async () => {
  ensureCrewSchema();
  const action = cleanText(actionValue).toLowerCase();
  if (!["clock_in", "break_start", "break_end", "clock_out"].includes(action)) {
    throw badRequest("time_clock_action_invalid", "Choose clock_in, break_start, break_end, or clock_out.");
  }
  const metadata = asObject(metadataValue);
  return (await withWorkforceTransaction(async () => {
    const now = nowIso();
    let current = (await activeShiftRow(orgId, userId));
    let event: JsonObject | null = null;
    let autoBreakEvent: JsonObject | null = null;

    if (action === "clock_in") {
      if (current) throw conflict("time_clock_already_active", "This user is already clocked in.");
      const shiftId = `time_shift_${randomUUID()}`;
      (await getWorkforceDatabase().prepare(`INSERT INTO crew_time_shifts
        (id, organization_id, user_id, status, clocked_in_at, break_seconds, metadata_json, revision, created_at, updated_at)
        VALUES (?, ?, ?, 'active', ?, 0, ?, 1, ?, ?)`)
        .run(shiftId, orgId, userId, now, json(metadata), now, now));
      event = (await insertTimeEvent(orgId, userId, shiftId, action, now, metadata));
      current = (await activeShiftRow(orgId, userId));
    } else {
      if (!current) throw conflict("time_clock_not_active", "Clock in before using this action.");
      const shiftId = cleanText(current.id);
      const breakStartedAt = cleanText(current.active_break_started_at);
      if (action === "break_start") {
        if (breakStartedAt) throw conflict("time_clock_break_active", "A break is already active.");
        (await getWorkforceDatabase().prepare(`UPDATE crew_time_shifts SET active_break_started_at=?, revision=revision+1, updated_at=? WHERE id=?`)
          .run(now, now, shiftId));
        event = (await insertTimeEvent(orgId, userId, shiftId, action, now, metadata));
      }
      if (action === "break_end") {
        if (!breakStartedAt) throw conflict("time_clock_break_not_active", "Start a break before ending it.");
        const addedSeconds = secondsBetween(breakStartedAt, now);
        (await getWorkforceDatabase().prepare(`UPDATE crew_time_shifts SET active_break_started_at=NULL,
          break_seconds=break_seconds+?, revision=revision+1, updated_at=? WHERE id=?`)
          .run(addedSeconds, now, shiftId));
        event = (await insertTimeEvent(orgId, userId, shiftId, action, now, { ...metadata, break_seconds: addedSeconds }));
      }
      if (action === "clock_out") {
        let addedSeconds = 0;
        if (breakStartedAt) {
          addedSeconds = secondsBetween(breakStartedAt, now);
          autoBreakEvent = (await insertTimeEvent(orgId, userId, shiftId, "break_end", now, {
            automatic: true,
            reason: "clock_out",
            break_seconds: addedSeconds
          }));
        }
        (await getWorkforceDatabase().prepare(`UPDATE crew_time_shifts SET status='closed', clocked_out_at=?,
          active_break_started_at=NULL, break_seconds=break_seconds+?, revision=revision+1, updated_at=? WHERE id=?`)
          .run(now, addedSeconds, now, shiftId));
        event = (await insertTimeEvent(orgId, userId, shiftId, action, now, metadata));
      }
      current = (await activeShiftRow(orgId, userId));
    }

    const latest = (await latestShiftRow(orgId, userId));
    return {
      action,
      event,
      automatic_break_event: autoBreakEvent,
      active: !!current,
      current_shift: shiftView(current, now),
      shift: shiftView(latest, now),
      clocked_out: action === "clock_out"
    };
  }));

  }));
}

export const CHECKLIST_AUDIENCES = ["crew", "supervisor"] as const;
export const CHECKLIST_ITEM_TYPES = ["todo", "rating"] as const;
export const CHECKLIST_RATINGS = ["good", "neutral", "bad"] as const;

export type ProjectChecklistDefinition = {
  id?: string;
  key?: string;
  title: string;
  description?: string;
  kind?: string;
  audience?: string;
  crew_editable?: boolean;
  icon?: string;
  sort_order?: number;
  source?: string;
  source_key?: string;
  items?: Array<Record<string, unknown>>;
  metadata?: Record<string, unknown>;
  assignment_policy?: Record<string, unknown>;
  assigned_user_ids?: string[];
  assigned_role_ids?: string[];
  assigned_resource_group_ids?: string[];
  customer_access?: Record<string, unknown>;
};

// No blessed checklists: every checklist is data — instantiated from scope
// templates (checklists.initializeFromScope.v1), created manually from the
// project Checklists tab, or created on demand by the crew add-item path.

function checklistAudience(value: unknown) {
  const audience = cleanText(value).toLowerCase();
  return (CHECKLIST_AUDIENCES as readonly string[]).includes(audience) ? audience : "crew";
}

function checklistItemType(value: unknown) {
  const type = cleanText(value).toLowerCase();
  return (CHECKLIST_ITEM_TYPES as readonly string[]).includes(type) ? type : "todo";
}

function checklistRating(value: unknown) {
  const rating = cleanText(value).toLowerCase();
  return (CHECKLIST_RATINGS as readonly string[]).includes(rating) ? rating : "";
}

export function normalizeChecklistCustomerAccess(value: unknown, authorOnly = false) {
  const input = asObject(value);
  const visible = input.visible === true || cleanText(input.visibility).toLowerCase() === "visible";
  const canEditItems = visible && (
    input.can_edit_items === true
    || cleanText(input.item_editing).toLowerCase() === "customer"
  );
  const canComplete = visible && !authorOnly && (
    input.can_complete === true
    || cleanText(input.completion).toLowerCase() === "customer"
    || canEditItems
  );
  const voiceMode = !visible || !canComplete
    ? "off"
    : canEditItems ? "edit" : "complete";
  return {
    schema_version: 1,
    visible,
    can_complete: canComplete,
    can_edit_items: canEditItems,
    voice_mode: voiceMode
  };
}

function checklistView(rowValue: unknown) {
  const row = asObject(rowValue);
  const metadata = asObject(parseJson(row.metadata_json));
  return {
    schema_version: CREW_SCHEMA_VERSION,
    id: cleanText(row.id),
    organization_id: cleanText(row.organization_id),
    project_id: cleanText(row.project_id),
    title: cleanText(row.title),
    description: cleanText(row.description),
    kind: cleanText(row.kind || "todo"),
    audience: checklistAudience(row.audience),
    crew_editable: Number(row.crew_editable || 0) === 1,
    source: cleanText(row.source || "manual"),
    source_key: cleanText(row.source_key),
    icon: cleanText(row.icon),
    sort_order: Number(row.sort_order || 0),
    created_by_user_id: cleanText(row.created_by_user_id),
    assignment_policy: asObject(metadata.assignment_policy),
    assigned_user_ids: asArray(metadata.assigned_user_ids).map(cleanText).filter(Boolean),
    assigned_role_ids: asArray(metadata.assigned_role_ids).map(cleanText).filter(Boolean),
    assigned_resource_group_ids: asArray(metadata.assigned_resource_group_ids).map(cleanText).filter(Boolean),
    customer_access: normalizeChecklistCustomerAccess(metadata.customer_access, isPunchList({ metadata })),
    metadata,
    revision: Number(row.revision || 1),
    created_at: cleanText(row.created_at),
    updated_at: cleanText(row.updated_at),
    deleted_at: cleanText(row.deleted_at)
  };
}

function checklistItemView(rowValue: unknown) {
  const row = asObject(rowValue);
  const itemType = checklistItemType(row.item_type);
  const rating = checklistRating(row.rating);
  const completed = itemType === "rating" ? !!rating : cleanText(row.status) === "completed";
  return {
    schema_version: CREW_SCHEMA_VERSION,
    id: cleanText(row.id),
    organization_id: cleanText(row.organization_id),
    project_id: cleanText(row.project_id),
    checklist_id: cleanText(row.checklist_id),
    title: cleanText(row.title),
    description: cleanText(row.description),
    item_type: itemType,
    rating,
    note: cleanText(row.note),
    status: completed ? "completed" : "pending",
    completed,
    sort_order: Number(row.sort_order || 0),
    created_by_user_id: cleanText(row.created_by_user_id),
    completed_by_user_id: cleanText(row.completed_by_user_id),
    completed_at: cleanText(row.completed_at),
    metadata: asObject(parseJson(row.metadata_json)),
    revision: Number(row.revision || 1),
    created_at: cleanText(row.created_at),
    updated_at: cleanText(row.updated_at)
  };
}

async function activeChecklistRows(orgId: string, projectId: string) {
  return (await getWorkforceDatabase().prepare(`SELECT * FROM crew_checklists
    WHERE organization_id=? AND project_id=? AND deleted_at IS NULL ORDER BY sort_order ASC, created_at ASC`)
    .all(orgId, projectId));
}

async function insertChecklist(
  orgId: string,
  projectId: string,
  definition: ProjectChecklistDefinition,
  actorUserId: string
) {
  const now = nowIso();
  const id = cleanText(definition.id) || `checklist_${randomUUID()}`;
  const metadata = {
    ...asObject(definition.metadata),
    ...(definition.assignment_policy ? { assignment_policy: asObject(definition.assignment_policy) } : {}),
    ...(definition.assigned_user_ids ? { assigned_user_ids: definition.assigned_user_ids.map(cleanText).filter(Boolean) } : {}),
    ...(definition.assigned_role_ids ? { assigned_role_ids: definition.assigned_role_ids.map(cleanText).filter(Boolean) } : {}),
    ...(definition.assigned_resource_group_ids ? { assigned_resource_group_ids: definition.assigned_resource_group_ids.map(cleanText).filter(Boolean) } : {}),
    ...(definition.customer_access ? { customer_access: normalizeChecklistCustomerAccess(definition.customer_access) } : {})
  };
  (await getWorkforceDatabase().prepare(`INSERT INTO crew_checklists
    (id, organization_id, project_id, title, description, kind, audience, crew_editable, source, source_key,
     icon, sort_order, created_by_user_id, metadata_json, revision, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?)`)
    .run(
      id,
      orgId,
      projectId,
      cleanText(definition.title) || "Checklist",
      cleanText(definition.description),
      cleanText(definition.kind) === "quality" ? "quality" : "todo",
      checklistAudience(definition.audience),
      definition.crew_editable === true ? 1 : 0,
      cleanText(definition.source) || "manual",
      cleanText(definition.source_key),
      cleanText(definition.icon),
      Math.round(Number(definition.sort_order || 0)),
      cleanText(actorUserId),
      json(metadata),
      now,
      now
    ));
  for (const [index, itemValue] of (Array.isArray(definition.items) ? definition.items : []).entries()) {
    const item = asObject(itemValue);
    const title = cleanText(item.title || item.label || item.name);
    if (!title) continue;
    (await createProjectChecklistItem(orgId, projectId, id, {
      ...item,
      title,
      sort_order: Number(item.sort_order ?? (index + 1) * 10)
    }, actorUserId));
  }
  return checklistView((await getWorkforceDatabase().prepare("SELECT * FROM crew_checklists WHERE id=?").get(id)));
}

async function workChecklistId(orgId: string, projectId: string) {
  const rows = (await activeChecklistRows(orgId, projectId)).map(checklistView);
  const work = rows.find((row) => row.source_key.endsWith(":work"))
    || rows.find((row) => row.audience === "crew" && row.kind === "todo")
    || rows[0];
  return cleanText(work?.id);
}

export async function ensureProjectChecklists(
  orgId: string,
  projectId: string,
  options: { definitions?: ProjectChecklistDefinition[]; actorUserId?: string } = {}
) {
  return (await getWorkforceDatabase().transaction(async () => {
  ensureCrewSchema();
  const actorUserId = cleanText(options.actorUserId) || "system";
  return (await withWorkforceTransaction(async () => {
    const existing = (await activeChecklistRows(orgId, projectId)).map(checklistView);
    const existingKeys = new Set(existing.map((row) => row.source_key).filter(Boolean));
    const created: ReturnType<typeof checklistView>[] = [];
    for (const definition of Array.isArray(options.definitions) ? options.definitions : []) {
      const sourceKey = cleanText(definition.source_key)
        || (cleanText(definition.key) ? `scope:${cleanText(definition.key)}` : "");
      if (sourceKey && existingKeys.has(sourceKey)) continue;
      created.push((await insertChecklist(orgId, projectId, {
        ...definition,
        source: cleanText(definition.source) || "scope",
        source_key: sourceKey
      }, actorUserId)));
      if (sourceKey) existingKeys.add(sourceKey);
    }
    // Adopt legacy single-list items into the work checklist so nothing disappears.
    const targetId = (await workChecklistId(orgId, projectId));
    if (targetId) {
      (await getWorkforceDatabase().prepare(`UPDATE crew_checklist_items SET checklist_id=?, updated_at=?
        WHERE organization_id=? AND project_id=? AND checklist_id='' AND deleted_at IS NULL`)
        .run(targetId, nowIso(), orgId, projectId));
    }
    return { created, checklists: (await activeChecklistRows(orgId, projectId)).map(checklistView) };
  }));

  }));
}

export async function listProjectChecklists(
  orgId: string,
  projectId: string,
  options: { audiences?: readonly string[] | null } = {}
) {
  ensureCrewSchema();
  const audiences = Array.isArray(options.audiences) ? options.audiences.map((value) => checklistAudience(value)) : null;
  const checklists = (await activeChecklistRows(orgId, projectId)).map(checklistView)
    .filter((checklist) => !audiences || audiences.includes(checklist.audience));
  const items = (await getWorkforceDatabase().prepare(`SELECT * FROM crew_checklist_items
    WHERE organization_id=? AND project_id=? AND deleted_at IS NULL ORDER BY sort_order ASC, created_at ASC`)
    .all(orgId, projectId)).map(checklistItemView);
  return checklists.map((checklist) => {
    const checklistItems = items.filter((item) => item.checklist_id === checklist.id);
    return {
      ...checklist,
      items: checklistItems,
      total_items: checklistItems.length,
      completed_items: checklistItems.filter((item) => item.completed).length
    };
  });
}

export async function listDeletedProjectChecklists(orgId: string, projectId: string) {
  ensureCrewSchema();
  const checklists = (await getWorkforceDatabase().prepare(`SELECT * FROM crew_checklists
    WHERE organization_id=? AND project_id=? AND deleted_at IS NOT NULL ORDER BY deleted_at DESC`)
    .all(orgId, projectId)).map(checklistView);
  const items = (await getWorkforceDatabase().prepare(`SELECT * FROM crew_checklist_items
    WHERE organization_id=? AND project_id=? AND deleted_at IS NOT NULL ORDER BY sort_order ASC, created_at ASC`)
    .all(orgId, projectId)).map(checklistItemView);
  return checklists.map((checklist) => {
    const checklistItems = items.filter((item) => item.checklist_id === checklist.id);
    return {
      ...checklist,
      items:checklistItems,
      total_items:checklistItems.length,
      completed_items:checklistItems.filter((item) => item.completed).length
    };
  });
}

export async function createProjectChecklist(orgId: string, projectId: string, inputValue: unknown, actorUserId: string) {
  return (await getWorkforceDatabase().transaction(async () => {
  ensureCrewSchema();
  const input = asObject(inputValue);
  const title = cleanText(input.title || input.name);
  if (!title) throw badRequest("checklist_title_required", "A checklist title is required.");
  return (await insertChecklist(orgId, projectId, {
    title,
    description: cleanText(input.description),
    kind: cleanText(input.kind),
    audience: cleanText(input.audience),
    crew_editable: input.crew_editable === true,
    icon: cleanText(input.icon),
    sort_order: Number(input.sort_order || 0),
    source: "manual",
    items: Array.isArray(input.items) ? input.items.map(asObject) : [],
    metadata: asObject(input.metadata),
    assignment_policy: asObject(input.assignment_policy),
    assigned_user_ids: asArray(input.assigned_user_ids).map(cleanText).filter(Boolean),
    assigned_role_ids: asArray(input.assigned_role_ids).map(cleanText).filter(Boolean),
    assigned_resource_group_ids: asArray(input.assigned_resource_group_ids).map(cleanText).filter(Boolean),
    customer_access: asObject(input.customer_access)
  }, actorUserId));

  }));
}

async function readChecklistRow(orgId: string, projectId: string, checklistId: string) {
  ensureCrewSchema();
  const row = (await getWorkforceDatabase().prepare(`SELECT * FROM crew_checklists
    WHERE id=? AND organization_id=? AND project_id=? AND deleted_at IS NULL`).get(checklistId, orgId, projectId));
  if (!row) throw notFound("checklist_not_found", "Checklist was not found.");
  return checklistView(row);
}

export async function readProjectChecklist(orgId: string, projectId: string, checklistId: string) {
  return (await readChecklistRow(orgId, projectId, checklistId));
}

/**
 * Read a checklist WITH its items hydrated.
 *
 * readProjectChecklist returns the row only. Callers that reason about item
 * state (punch-list gates: "is every item done?", "is the list full?") must use
 * this — evaluating those questions against a missing `items` array silently
 * answers "yes, zero outstanding" and lets every gate through.
 */
export async function readProjectChecklistDetail(orgId: string, projectId: string, checklistId: string) {
  const checklist = (await readChecklistRow(orgId, projectId, checklistId));
  const items = (await getWorkforceDatabase().prepare(`SELECT * FROM crew_checklist_items
    WHERE organization_id=? AND project_id=? AND checklist_id=? AND deleted_at IS NULL
    ORDER BY sort_order ASC, created_at ASC`)
    .all(orgId, projectId, checklistId)).map(checklistItemView);
  return {
    ...checklist,
    items,
    total_items: items.length,
    completed_items: items.filter((item) => item.completed).length
  };
}

export async function patchProjectChecklist(orgId: string, projectId: string, checklistId: string, inputValue: unknown) {
  return (await getWorkforceDatabase().transaction(async () => {
  const current = (await readChecklistRow(orgId, projectId, checklistId));
  const input = asObject(inputValue);
  const expectedRevision = Number(input.expected_revision || 0);
  if (expectedRevision && expectedRevision !== current.revision) {
    throw conflict("checklist_revision_conflict", "Checklist revision does not match.", { current_revision: current.revision });
  }
  const has = (field: string) => Object.prototype.hasOwnProperty.call(input, field);
  const metadata = {
    ...current.metadata,
    ...(has("metadata") ? asObject(input.metadata) : {}),
    ...(has("assignment_policy") ? { assignment_policy: asObject(input.assignment_policy) } : {}),
    ...(has("assigned_user_ids") ? { assigned_user_ids: asArray(input.assigned_user_ids).map(cleanText).filter(Boolean) } : {}),
    ...(has("assigned_role_ids") ? { assigned_role_ids: asArray(input.assigned_role_ids).map(cleanText).filter(Boolean) } : {}),
    ...(has("assigned_resource_group_ids") ? { assigned_resource_group_ids: asArray(input.assigned_resource_group_ids).map(cleanText).filter(Boolean) } : {}),
    ...(has("customer_access") ? { customer_access: normalizeChecklistCustomerAccess(input.customer_access) } : {})
  };
  const title = has("title") ? cleanText(input.title) : current.title;
  if (!title) throw badRequest("checklist_title_required", "A checklist title is required.");
  (await getWorkforceDatabase().prepare(`UPDATE crew_checklists SET title=?, description=?, kind=?, audience=?,
    crew_editable=?, icon=?, sort_order=?, metadata_json=?, revision=revision+1, updated_at=?
    WHERE id=? AND organization_id=? AND project_id=?`)
    .run(
      title,
      has("description") ? cleanText(input.description) : current.description,
      has("kind") ? (cleanText(input.kind) === "quality" ? "quality" : "todo") : current.kind,
      has("audience") ? checklistAudience(input.audience) : current.audience,
      has("crew_editable") ? (input.crew_editable === true ? 1 : 0) : (current.crew_editable ? 1 : 0),
      has("icon") ? cleanText(input.icon) : current.icon,
      has("sort_order") ? Math.round(Number(input.sort_order || 0)) : current.sort_order,
      json(metadata),
      nowIso(),
      checklistId,
      orgId,
      projectId
    ));
  return checklistView((await getWorkforceDatabase().prepare("SELECT * FROM crew_checklists WHERE id=?").get(checklistId)));

  }));
}

export async function deleteProjectChecklist(orgId: string, projectId: string, checklistId: string, actorUserId: string) {
  return (await getWorkforceDatabase().transaction(async () => {
  const current = (await readChecklistRow(orgId, projectId, checklistId));
  const now = nowIso();
  (await getWorkforceDatabase().prepare(`UPDATE crew_checklists SET deleted_at=?, metadata_json=?, revision=revision+1, updated_at=?
    WHERE id=? AND organization_id=? AND project_id=?`)
    .run(now, json({ ...current.metadata, deleted_by_user_id:actorUserId }), now, checklistId, orgId, projectId));
  (await getWorkforceDatabase().prepare(`UPDATE crew_checklist_items SET deleted_at=?, revision=revision+1, updated_at=?
    WHERE organization_id=? AND project_id=? AND checklist_id=? AND deleted_at IS NULL`)
    .run(now, now, orgId, projectId, checklistId));
  return { id: checklistId, deleted: true, deleted_at: now };

  }));
}

export async function createProjectChecklistItem(
  orgId: string,
  projectId: string,
  checklistId: string,
  inputValue: unknown,
  actorUserId: string
) {
  return (await getWorkforceDatabase().transaction(async () => {
  ensureCrewSchema();
  const input = asObject(inputValue);
  const title = cleanText(input.title || input.label || input.name);
  if (!title) throw badRequest("checklist_title_required", "A checklist item title is required.");
  const itemType = checklistItemType(input.item_type || input.type);
  const rating = itemType === "rating" ? checklistRating(input.rating) : "";
  const completed = itemType === "rating"
    ? !!rating
    : input.completed === true || cleanText(input.status) === "completed";
  const now = nowIso();
  const id = cleanText(input.id) || `checklist_item_${randomUUID()}`;
  (await getWorkforceDatabase().prepare(`INSERT INTO crew_checklist_items
    (id, organization_id, project_id, checklist_id, title, description, status, item_type, rating, note,
      sort_order, created_by_user_id, completed_by_user_id, completed_at, metadata_json, revision, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?)`)
    .run(
      id,
      orgId,
      projectId,
      cleanText(checklistId),
      title,
      cleanText(input.description),
      completed ? "completed" : "pending",
      itemType,
      rating,
      cleanText(input.note || input.notes),
      Math.round(Number(input.sort_order || 0)),
      cleanText(actorUserId),
      completed ? cleanText(actorUserId) : null,
      completed ? now : null,
      json(asObject(input.metadata)),
      now,
      now
    ));
  return checklistItemView((await getWorkforceDatabase().prepare("SELECT * FROM crew_checklist_items WHERE id=?").get(id)));

  }));
}

export async function patchProjectChecklistItem(
  orgId: string,
  projectId: string,
  itemId: string,
  inputValue: unknown,
  actorUserId: string,
  manage: boolean
) {
  return (await getWorkforceDatabase().transaction(async () => {
  ensureCrewSchema();
  const input = asObject(inputValue);
  const row = (await getWorkforceDatabase().prepare(`SELECT * FROM crew_checklist_items
    WHERE id=? AND organization_id=? AND project_id=? AND deleted_at IS NULL`).get(itemId, orgId, projectId));
  if (!row) throw notFound("checklist_item_not_found", "Checklist item was not found.");
  const current = checklistItemView(row);
  const expectedRevision = Number(input.expected_revision || 0);
  if (expectedRevision && expectedRevision !== current.revision) {
    throw conflict("checklist_revision_conflict", "Checklist item revision does not match.", { current_revision: current.revision });
  }
  const has = (field: string) => Object.prototype.hasOwnProperty.call(input, field);
  const forbiddenFields = ["title", "description", "sort_order", "metadata", "item_type", "checklist_id"].filter(has);
  if (!manage && forbiddenFields.length) {
    throw badRequest("checklist_manage_required", "This user may complete checklist items but cannot edit their content.");
  }
  const itemType = manage && has("item_type") ? checklistItemType(input.item_type) : current.item_type;
  let rating = current.rating;
  if (has("rating")) {
    if (itemType !== "rating") throw badRequest("checklist_rating_invalid", "Only rating items accept a rating.");
    const value = cleanText(input.rating);
    rating = value ? checklistRating(value) : "";
    if (value && !rating) throw badRequest("checklist_rating_invalid", "Choose good, neutral, or bad.");
  }
  if (itemType !== "rating") rating = "";
  const note = has("note") || has("notes") ? cleanText(input.note ?? input.notes) : current.note;
  if (itemType === "rating" && rating === "bad" && !note) {
    throw badRequest("checklist_note_required", "Add a note explaining what needs attention before marking this item bad.");
  }
  const completed = itemType === "rating"
    ? !!rating
    : has("completed")
      ? input.completed === true
      : has("status")
        ? cleanText(input.status) === "completed"
         : current.completed;
  const metadata = manage && has("metadata")
    ? { ...current.metadata, ...asObject(input.metadata) }
    : current.metadata;
  if (completed) {
    const requirements = Array.isArray(metadata.required_attachments)
      ? metadata.required_attachments.map(asObject)
      : [];
    const attachments = Array.isArray(metadata.attachments)
      ? metadata.attachments.map(asObject)
      : [];
    const kindMatches = (requiredKind: string, attachment: Record<string, unknown>, allowedKinds: string[] = []): boolean => {
      const kind = cleanText(attachment.kind).toLowerCase();
      const contentType = cleanText(attachment.content_type).toLowerCase();
      if (allowedKinds.length) return allowedKinds.some((allowedKind) => kindMatches(allowedKind, attachment));
      if (requiredKind === "any") return true;
      if (requiredKind === "media") return ["photo", "video", "audio"].includes(kind);
      if (requiredKind === "photo") return kind === "photo" || contentType.startsWith("image/");
      if (requiredKind === "video") return kind === "video" || contentType.startsWith("video/");
      if (requiredKind === "audio") return kind === "audio" || contentType.startsWith("audio/");
      if (requiredKind === "document") {
        return kind === "document" || (!contentType.startsWith("image/") && !contentType.startsWith("video/") && !contentType.startsWith("audio/"));
      }
      return false;
    };
    const unmet = requirements.filter((requirement) => {
      const kind = cleanText(requirement.kind).toLowerCase() || "any";
      const minimum = Math.max(1, Math.min(20, Math.round(Number(requirement.min_count) || 1)));
      const requirementId = cleanText(requirement.id);
      const allowedKinds = asArray(requirement.allowed_kinds).map((value) => cleanText(value).toLowerCase()).filter(Boolean);
      const matches = attachments.filter((attachment) =>
        (!requirementId || !cleanText(attachment.requirement_id) || cleanText(attachment.requirement_id) === requirementId)
        && kindMatches(kind, attachment, allowedKinds)
      );
      return matches.length < minimum;
    });
    if (unmet.length) {
      throw badRequest(
        "checklist_attachments_required",
        "Add the required checklist evidence before marking this item complete.",
        { unmet_requirements: unmet }
      );
    }
  }
  const now = nowIso();
  const title = manage && has("title") ? cleanText(input.title) : current.title;
  if (!title) throw badRequest("checklist_title_required", "A checklist item title is required.");
  const completionChanged = completed !== current.completed || rating !== current.rating;
  (await getWorkforceDatabase().prepare(`UPDATE crew_checklist_items SET title=?, description=?, status=?, item_type=?,
    rating=?, note=?, sort_order=?, checklist_id=?, completed_by_user_id=?, completed_at=?, metadata_json=?,
    revision=revision+1, updated_at=?
    WHERE id=? AND organization_id=? AND project_id=?`)
    .run(
      title,
      manage && has("description") ? cleanText(input.description) : current.description,
      completed ? "completed" : "pending",
      itemType,
      rating,
      note,
      manage && has("sort_order") ? Math.round(Number(input.sort_order || 0)) : current.sort_order,
      manage && has("checklist_id") ? cleanText(input.checklist_id) : current.checklist_id,
      completed ? (completionChanged ? cleanText(actorUserId) : (current.completed_by_user_id || cleanText(actorUserId))) : null,
      completed ? (completionChanged ? now : (current.completed_at || now)) : null,
      json(metadata),
      now,
      itemId,
      orgId,
      projectId
    ));
  return checklistItemView((await getWorkforceDatabase().prepare("SELECT * FROM crew_checklist_items WHERE id=?").get(itemId)));

  }));
}

export async function addProjectChecklistItemAttachment(
  orgId: string,
  projectId: string,
  itemId: string,
  attachmentValue: unknown,
  actorUserId: string
) {
  return (await getWorkforceDatabase().transaction(async () => {
  const current = (await readProjectChecklistItem(orgId, projectId, itemId));
  const metadata = asObject(current.metadata);
  const attachments = Array.isArray(metadata.attachments) ? metadata.attachments.map(asObject) : [];
  const attachment: Record<string, unknown> = {
    ...asObject(attachmentValue),
    attached_by_user_id: cleanText(actorUserId),
    attached_at: nowIso()
  };
  const mediaId = cleanText(attachment.media_id);
  if (!mediaId) throw badRequest("checklist_attachment_invalid", "The checklist attachment is missing its media id.");
  const next = [...attachments.filter((entry) => cleanText(entry.media_id) !== mediaId), attachment];
  return (await patchProjectChecklistItem(orgId, projectId, itemId, {
    metadata: { ...metadata, attachments: next }
  }, actorUserId, true));

  }));
}

export async function readProjectChecklistItem(orgId: string, projectId: string, itemId: string) {
  ensureCrewSchema();
  const row = (await getWorkforceDatabase().prepare(`SELECT * FROM crew_checklist_items
    WHERE id=? AND organization_id=? AND project_id=? AND deleted_at IS NULL`).get(itemId, orgId, projectId));
  if (!row) throw notFound("checklist_item_not_found", "Checklist item was not found.");
  return checklistItemView(row);
}

export async function initializeProjectChecklistsFromScope(
  orgId: string,
  projectId: string,
  definitionValue: unknown,
  templateId: string
) {
  return (await getWorkforceDatabase().transaction(async () => {
  const definition = asObject(definitionValue);
  const configured = Array.isArray(definition.checklists) ? definition.checklists.map(asObject) : [];
  if (!configured.length) return null;
  const definitions = configured.map((entry, index) => ({
    ...entry,
    // Template-local checklist ids ("safety") must not become row primary
    // keys — derive a per-project id so the same scope can instantiate on
    // many projects.
    id: `checklist_${createHash("sha256").update(`${orgId}:${projectId}:${cleanText(templateId)}:${cleanText(entry.id || entry.key) || index}`).digest("hex").slice(0, 24)}`,
    title: cleanText(entry.title || entry.name) || "Checklist",
    source: "scope",
    source_key: `scope:${cleanText(templateId)}:${cleanText(entry.id || entry.key) || `checklist_${index + 1}`}`,
    sort_order: Number(entry.sort_order ?? (index + 1) * 10),
    items: Array.isArray(entry.items) ? entry.items.map(asObject) : []
  })) as ProjectChecklistDefinition[];
  return (await ensureProjectChecklists(orgId, projectId, { definitions }));

  }));
}

// Legacy single-list facade: preserved so older clients and routes keep working.
export async function listCrewChecklistItems(orgId: string, projectId: string) {
  ensureCrewSchema();
  return (await getWorkforceDatabase().prepare(`SELECT * FROM crew_checklist_items
    WHERE organization_id=? AND project_id=? AND deleted_at IS NULL ORDER BY sort_order ASC, created_at ASC`)
    .all(orgId, projectId)).map(checklistItemView);
}

export async function createCrewChecklistItem(orgId: string, projectId: string, inputValue: unknown, actorUserId: string) {
  return (await getWorkforceDatabase().transaction(async () => {
  (await ensureProjectChecklists(orgId, projectId, { actorUserId }));
  const input = asObject(inputValue);
  let checklistId = cleanText(input.checklist_id) || (await workChecklistId(orgId, projectId));
  if (!checklistId) {
    // The crew is adding a to-do on a project with no checklists yet: create
    // the container they are implicitly asking for.
    const created = (await createProjectChecklist(orgId, projectId, {
      title: "Work checklist",
      description: "Items the crew tracks during the job.",
      kind: "todo",
      audience: "crew",
      crew_editable: true,
      icon: "fa-list-check",
      source: "crew",
      source_key: "crew:manual"
    }, actorUserId));
    checklistId = cleanText((created as Record<string, unknown>).id as string);
  }
  return (await createProjectChecklistItem(orgId, projectId, checklistId, input, actorUserId));

  }));
}

export async function patchCrewChecklistItem(
  orgId: string,
  projectId: string,
  itemId: string,
  inputValue: unknown,
  actorUserId: string,
  manage: boolean
) {
  return (await getWorkforceDatabase().transaction(async () => {
  return (await patchProjectChecklistItem(orgId, projectId, itemId, inputValue, actorUserId, manage));

  }));
}

export async function deleteCrewChecklistItem(orgId: string, projectId: string, itemId: string, actorUserId: string) {
  return (await getWorkforceDatabase().transaction(async () => {
  ensureCrewSchema();
  const now = nowIso();
  const result = (await getWorkforceDatabase().prepare(`UPDATE crew_checklist_items SET deleted_at=?,
    metadata_json=?, revision=revision+1, updated_at=?
    WHERE id=? AND organization_id=? AND project_id=? AND deleted_at IS NULL`)
    .run(now, json({ deleted_by_user_id: actorUserId }), now, itemId, orgId, projectId));
  if (!Number(result.changes || 0)) throw notFound("checklist_item_not_found", "Checklist item was not found.");
  return { id: itemId, deleted: true, deleted_at: now };

  }));
}
