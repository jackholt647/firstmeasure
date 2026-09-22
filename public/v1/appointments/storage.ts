// Appointment confirmation storage: the send queue plus the branch-module
// settings that supply company defaults.
//
// One queue row is one appointment awaiting one customer's confirmation. Rows
// carry a `group_key` (organization + contact + local calendar day) so that a
// customer with three appointments on the same day receives a single message
// covering all three rather than three separate ones — the tick claims a whole
// group at once and every row in it shares the reply token.

import { createHash, randomUUID } from "node:crypto";
import path from "node:path";
import type { SQLInputValue } from "node:sqlite";
import { openSqlStore, ensureSqlColumn, type SqlStore } from "../platform/sql_store.js";

import { readBranchModule, saveBranchModule, type JsonObject } from "../platform/storage.js";
import { env } from "../src/config/env.js";

export const CONFIRMATION_MODULE_ID = "appointment_confirmations";

export function cleanText(value: unknown) {
  return String(value ?? "").trim();
}

export function asObject(value: unknown): JsonObject {
  return value && typeof value === "object" && !Array.isArray(value) ? { ...(value as JsonObject) } : {};
}

export function asArray(value: unknown) {
  return Array.isArray(value) ? value : [];
}

function parseJson(value: unknown, fallback: unknown = {}) {
  try {
    return value ? JSON.parse(String(value)) : fallback;
  } catch {
    return fallback;
  }
}

function json(value: unknown) {
  return JSON.stringify(value ?? {});
}

function nowIso() {
  return new Date().toISOString();
}

function clampInt(value: unknown, min: number, max: number, fallback: number) {
  const parsed = Math.round(Number(value));
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(max, Math.max(min, parsed));
}

// ── Database ────────────────────────────────────────────────────────────────

let database: SqlStore | null = null;
let databasePath = "";

function resolvedDatabasePath() {
  return path.resolve(process.cwd(), env.platformStorageRoot, "appointments.sqlite");
}

export async function closeAppointmentsDatabase() {
  const current = database;
  database = null;
  databasePath = "";
  return (await current?.close());
}

export function getAppointmentsDatabase() {
  const nextPath = resolvedDatabasePath();
  if (database && databasePath === nextPath) return database;
  void closeAppointmentsDatabase();
  database = openSqlStore({ id: "appointments", filename: nextPath, initialize: initializeSchema });
  databasePath = nextPath;
  return database;
}

async function initializeSchema(db: SqlStore) {
  (await db.exec(`
    CREATE TABLE IF NOT EXISTS appointment_confirmations (
      id TEXT PRIMARY KEY,
      organization_id TEXT NOT NULL,
      branch_id TEXT NOT NULL,
      project_id TEXT NOT NULL,
      event_id TEXT NOT NULL,
      contact_id TEXT,
      contact_name TEXT,
      contact_email TEXT,
      contact_phone TEXT,
      contact_key TEXT NOT NULL,
      group_key TEXT NOT NULL,
      local_day TEXT NOT NULL,
      timezone TEXT NOT NULL,
      token TEXT NOT NULL,
      status TEXT NOT NULL,
      channels_json TEXT NOT NULL DEFAULT '{}',
      config_json TEXT NOT NULL DEFAULT '{}',
      event_json TEXT NOT NULL DEFAULT '{}',
      send_at TEXT NOT NULL,
      starts_at TEXT NOT NULL,
      attempts INTEGER NOT NULL DEFAULT 0,
      lease_until TEXT,
      sent_at TEXT,
      responded_at TEXT,
      confirmed_at TEXT,
      declined_at TEXT,
      response_channel TEXT,
      response_message_id TEXT,
      response_text TEXT,
      resolution TEXT,
      last_error TEXT,
      message_ids_json TEXT NOT NULL DEFAULT '[]',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE UNIQUE INDEX IF NOT EXISTS idx_appointment_confirmations_event
      ON appointment_confirmations (organization_id, project_id, event_id);
    CREATE INDEX IF NOT EXISTS idx_appointment_confirmations_due
      ON appointment_confirmations (status, send_at);
    CREATE INDEX IF NOT EXISTS idx_appointment_confirmations_group
      ON appointment_confirmations (group_key, status);
    CREATE INDEX IF NOT EXISTS idx_appointment_confirmations_token
      ON appointment_confirmations (token);
    CREATE INDEX IF NOT EXISTS idx_appointment_confirmations_awaiting
      ON appointment_confirmations (organization_id, contact_key, status);

    CREATE TABLE IF NOT EXISTS appointment_slot_holds (
      id TEXT PRIMARY KEY,
      organization_id TEXT NOT NULL,
      branch_id TEXT NOT NULL,
      project_id TEXT NOT NULL,
      event_id TEXT NOT NULL,
      event_type_id TEXT NOT NULL,
      resource_key TEXT NOT NULL DEFAULT '',
      start_at TEXT NOT NULL,
      end_at TEXT NOT NULL,
      expires_at TEXT NOT NULL,
      source TEXT NOT NULL DEFAULT '',
      source_id TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_appointment_slot_holds_window
      ON appointment_slot_holds (organization_id, branch_id, start_at, end_at, expires_at);
    CREATE INDEX IF NOT EXISTS idx_appointment_slot_holds_event
      ON appointment_slot_holds (organization_id, project_id, event_id, expires_at);

    CREATE TABLE IF NOT EXISTS appointment_reschedule_sessions (
      id TEXT PRIMARY KEY,
      organization_id TEXT NOT NULL,
      branch_id TEXT NOT NULL,
      project_id TEXT NOT NULL,
      event_id TEXT NOT NULL,
      contact_key TEXT NOT NULL,
      channel TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'offered',
      options_json TEXT NOT NULL DEFAULT '[]',
      expires_at TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_appointment_reschedule_sessions_contact
      ON appointment_reschedule_sessions (organization_id, contact_key, status, expires_at);
  `));
}

export type AppointmentSlotHold = JsonObject & {
  id: string;
  organization_id: string;
  branch_id: string;
  project_id: string;
  event_id: string;
  event_type_id: string;
  resource_key: string;
  start_at: string;
  end_at: string;
  expires_at: string;
};

export async function listActiveSlotHolds(orgId: string, branchId: string, from: Date, to: Date) {
  const now = nowIso();
  (await getAppointmentsDatabase().prepare("DELETE FROM appointment_slot_holds WHERE expires_at <= ?").run(now));
  return (await getAppointmentsDatabase().prepare(`
    SELECT * FROM appointment_slot_holds
    WHERE organization_id=? AND branch_id=? AND expires_at>?
      AND start_at<? AND end_at>?
    ORDER BY start_at ASC
  `).all(cleanText(orgId), cleanText(branchId) || "default", now, to.toISOString(), from.toISOString()))
    .map((row) => ({ ...row } as AppointmentSlotHold));
}

export async function createSlotHold(input: JsonObject) {
  return (await getAppointmentsDatabase().transaction(async () => {
  const id = cleanText(input.id) || `slot_hold_${randomUUID().replace(/-/g, "").slice(0, 20)}`;
  const now = nowIso();
  const expiresAt = cleanText(input.expires_at) || new Date(Date.now() + 5 * 60_000).toISOString();
  (await getAppointmentsDatabase().prepare(`
    INSERT INTO appointment_slot_holds
      (id, organization_id, branch_id, project_id, event_id, event_type_id, resource_key,
       start_at, end_at, expires_at, source, source_id, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    id,
    cleanText(input.organization_id),
    cleanText(input.branch_id) || "default",
    cleanText(input.project_id),
    cleanText(input.event_id),
    cleanText(input.event_type_id),
    cleanText(input.resource_key),
    cleanText(input.start_at),
    cleanText(input.end_at),
    expiresAt,
    cleanText(input.source),
    cleanText(input.source_id),
    now
  ));
  return (await getAppointmentsDatabase().prepare("SELECT * FROM appointment_slot_holds WHERE id=?").get(id)) as AppointmentSlotHold;

  }));
}

export async function readSlotHold(id: string) {
  const row = (await getAppointmentsDatabase().prepare("SELECT * FROM appointment_slot_holds WHERE id=? AND expires_at>?")
    .get(cleanText(id), nowIso()));
  return row ? ({ ...row } as AppointmentSlotHold) : null;
}

export async function deleteSlotHold(id: string) {
  return (await getAppointmentsDatabase().transaction(async () => {
  return Number((await getAppointmentsDatabase().prepare("DELETE FROM appointment_slot_holds WHERE id=?").run(cleanText(id))).changes) > 0;

  }));
}

export async function upsertRescheduleSession(input: JsonObject) {
  return (await getAppointmentsDatabase().transaction(async () => {
  const db = getAppointmentsDatabase();
  const now = nowIso();
  const id = cleanText(input.id) || `reschedule_${randomUUID().replace(/-/g, "").slice(0, 20)}`;
  (await db.prepare("UPDATE appointment_reschedule_sessions SET status='superseded', updated_at=? WHERE organization_id=? AND contact_key=? AND status='offered'")
    .run(now, cleanText(input.organization_id), cleanText(input.contact_key)));
  (await db.prepare(`INSERT INTO appointment_reschedule_sessions
    (id, organization_id, branch_id, project_id, event_id, contact_key, channel, status, options_json, expires_at, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, 'offered', ?, ?, ?, ?)`)
    .run(id, cleanText(input.organization_id), cleanText(input.branch_id) || "default", cleanText(input.project_id), cleanText(input.event_id), cleanText(input.contact_key), cleanText(input.channel), json(input.options || []), cleanText(input.expires_at), now, now));
  return (await readRescheduleSession(id))!;

  }));
}

export async function readRescheduleSession(id: string): Promise<JsonObject | null> {
  const row = (await getAppointmentsDatabase().prepare("SELECT * FROM appointment_reschedule_sessions WHERE id=?").get(cleanText(id)));
  if (!row) return null;
  const value = asObject(row);
  return { ...value, options: parseJson(value.options_json, []) };
}

export async function activeRescheduleSession(orgId: string, contactKey: string): Promise<JsonObject | null> {
  const row = (await getAppointmentsDatabase().prepare(`SELECT * FROM appointment_reschedule_sessions
    WHERE organization_id=? AND contact_key=? AND status='offered' AND expires_at>?
    ORDER BY created_at DESC LIMIT 1`).get(cleanText(orgId), cleanText(contactKey), nowIso()));
  if (!row) return null;
  const value = asObject(row);
  return { ...value, options: parseJson(value.options_json, []) };
}

export async function patchRescheduleSession(id: string, patch: JsonObject) {
  return (await getAppointmentsDatabase().transaction(async () => {
  const current = (await readRescheduleSession(id));
  if (!current) return null;
  (await getAppointmentsDatabase().prepare(`UPDATE appointment_reschedule_sessions SET status=?, options_json=?, expires_at=?, updated_at=? WHERE id=?`)
    .run(cleanText(patch.status || current.status), json(patch.options || current.options), cleanText(patch.expires_at || current.expires_at), nowIso(), cleanText(id)));
  return (await readRescheduleSession(id));

  }));
}

// ── Settings ────────────────────────────────────────────────────────────────

export const DEFAULT_SMS_TEMPLATE = "Hi {{customer_first_name}}, this is {{company_name}} confirming your {{appointment_summary}}. Reply YES to confirm or NO if you need to reschedule.";
export const DEFAULT_EMAIL_SUBJECT = "Please confirm your appointment with {{company_name}}";
export const DEFAULT_EMAIL_BODY = "Hi {{customer_first_name}},\n\nWe're looking forward to seeing you for your {{appointment_summary}}.\n\nPlease confirm this appointment works for you:\n{{confirm_link}}\n\nYou can also just reply YES to this email to confirm, or NO if you need to reschedule.\n\nThank you,\n{{company_name}}";

const SCHEDULE_MODES = new Set(["morning_of", "time_of_day", "before_offset", "days_before"]);

/** Normalizes the per-appointment or per-company send-timing rule. */
export function normalizeConfirmationSchedule(value: unknown): JsonObject {
  const raw = asObject(value);
  const mode = cleanText(raw.mode).toLowerCase();
  return {
    // morning_of  — a fixed local time on the appointment's own day
    // time_of_day — a fixed local time N days before (days_before: 0 == same day)
    // before_offset — a rolling offset before the appointment start
    // days_before — a fixed local time some whole number of days earlier
    mode: SCHEDULE_MODES.has(mode) ? mode : "morning_of",
    time_of_day: normalizeTimeOfDay(raw.time_of_day ?? raw.time, "09:00"),
    offset_minutes: clampInt(raw.offset_minutes, 5, 43_200, 120),
    days_before: clampInt(raw.days_before, 0, 30, 1),
    // Never send in the middle of the night: a computed send time earlier than
    // this local hour rolls forward to it.
    earliest_hour: clampInt(raw.earliest_hour, 0, 23, 8),
    latest_hour: clampInt(raw.latest_hour, 0, 23, 20)
  };
}

export function normalizeTimeOfDay(value: unknown, fallback = "09:00") {
  const match = /^(\d{1,2}):(\d{2})$/.exec(cleanText(value));
  if (!match) return fallback;
  const hour = clampInt(match[1], 0, 23, 9);
  const minute = clampInt(match[2], 0, 59, 0);
  return `${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}`;
}

/** The confirmation block as it lives on a schedule event. */
export function normalizeEventConfirmation(value: unknown, defaults: JsonObject = {}): JsonObject {
  const raw = asObject(value);
  const channels = asObject(raw.channels);
  const defaultChannels = asObject(defaults.channels);
  const status = cleanText(raw.status).toLowerCase();
  return {
    required: raw.required === true,
    channels: {
      email: channels.email === undefined ? defaultChannels.email !== false : channels.email === true,
      sms: channels.sms === undefined ? defaultChannels.sms !== false : channels.sms === true
    },
    include_portal_link: raw.include_portal_link === undefined
      ? defaults.include_portal_link === true
      : raw.include_portal_link === true,
    no_response_action: ["keep_reserved", "notify_staff", "release_to_unscheduled", "cancel"].includes(cleanText(raw.no_response_action || defaults.no_response_action))
      ? cleanText(raw.no_response_action || defaults.no_response_action)
      : "keep_reserved",
    confirmation_deadline_minutes_before: clampInt(raw.confirmation_deadline_minutes_before ?? defaults.confirmation_deadline_minutes_before, 0, 43_200, 0),
    schedule: normalizeConfirmationSchedule(raw.schedule ?? defaults.schedule),
    status: CONFIRMATION_STATUSES.has(status) ? status : "not_required",
    requested_at: cleanText(raw.requested_at),
    scheduled_send_at: cleanText(raw.scheduled_send_at),
    sent_at: cleanText(raw.sent_at),
    confirmed_at: cleanText(raw.confirmed_at),
    declined_at: cleanText(raw.declined_at),
    confirmed_via: cleanText(raw.confirmed_via),
    confirmed_by: cleanText(raw.confirmed_by),
    response_text: cleanText(raw.response_text).slice(0, 500),
    channels_sent: asArray(raw.channels_sent).map((entry) => cleanText(entry)).filter(Boolean),
    last_error: cleanText(raw.last_error)
  };
}

export const CONFIRMATION_STATUSES = new Set([
  "not_required",
  "pending",
  "sent",
  "confirmed",
  "declined",
  "failed",
  "canceled"
]);

export function normalizeConfirmationSettings(value: unknown): JsonObject {
  const raw = asObject(value);
  const channels = asObject(raw.channels);
  const messages = asObject(raw.messages);
  const visibility = asObject(raw.visibility);
  const autoRules = asArray(raw.auto_rules).map((entry) => {
    const rule = asObject(entry);
    return {
      event_type_default_id: cleanText(rule.event_type_default_id),
      enabled: rule.enabled !== false,
      schedule: normalizeConfirmationSchedule(rule.schedule),
      channels: {
        email: asObject(rule.channels).email !== false,
        sms: asObject(rule.channels).sms !== false
      },
      include_portal_link: asObject(rule).include_portal_link === true
    };
  }).filter((rule) => !!rule.event_type_default_id).slice(0, 40);
  return {
    enabled: raw.enabled === true,
    // Applied to appointments that do not carry their own confirmation block.
    default_required: raw.default_required === true,
    channels: {
      email: channels.email !== false,
      sms: channels.sms !== false
    },
    include_portal_link: raw.include_portal_link === true,
    no_response_action: ["keep_reserved", "notify_staff", "release_to_unscheduled", "cancel"].includes(cleanText(raw.no_response_action))
      ? cleanText(raw.no_response_action)
      : "keep_reserved",
    confirmation_deadline_minutes_before: clampInt(raw.confirmation_deadline_minutes_before, 0, 43_200, 0),
    schedule: normalizeConfirmationSchedule(raw.schedule),
    timezone: cleanText(raw.timezone),
    // How long after sending we keep listening for a reply before giving up.
    response_window_hours: clampInt(raw.response_window_hours, 1, 168, 24),
    auto_rules: autoRules,
    messages: {
      sms_text: cleanText(messages.sms_text) || DEFAULT_SMS_TEMPLATE,
      email_subject: cleanText(messages.email_subject) || DEFAULT_EMAIL_SUBJECT,
      email_body: cleanText(messages.email_body) || DEFAULT_EMAIL_BODY
    },
    visibility: {
      // "everyone" — anyone who can see the schedule sees confirmation state.
      // "permission" — only users holding view_appointment_confirmation.
      mode: cleanText(visibility.mode).toLowerCase() === "permission" ? "permission" : "everyone",
      // Roles listed here always see it regardless of mode.
      role_ids: asArray(visibility.role_ids).map((entry) => cleanText(entry)).filter(Boolean).slice(0, 60),
      // When hidden, the appointment simply renders as normal (no dashed
      // border, no status) rather than showing a redacted placeholder.
      hide_style: cleanText(visibility.hide_style).toLowerCase() === "muted" ? "muted" : "none"
    }
  };
}

export async function readConfirmationSettings(orgId: string, branchId: string) {
  const normalizedBranch = cleanText(branchId) || "default";
  const module = await readBranchModule(orgId, normalizedBranch, CONFIRMATION_MODULE_ID).catch(() => (
    normalizedBranch === "default" ? null : readBranchModule(orgId, "default", CONFIRMATION_MODULE_ID).catch(() => null)
  ));
  return {
    settings: normalizeConfirmationSettings(asObject(module?.data)),
    revision: Number(module?.revision ?? 0)
  };
}

export async function writeConfirmationSettings(orgId: string, branchId: string, input: JsonObject) {
  const settings = normalizeConfirmationSettings(input);
  const saved = await saveBranchModule(orgId, cleanText(branchId) || "default", CONFIRMATION_MODULE_ID, {
    data: settings,
    metadata: { kind: "appointment_confirmations", source: cleanText(input.source) || "company_settings" },
    ...(input.expected_revision ? { expected_revision: input.expected_revision } : {})
  }, { replace: true });
  return { settings: normalizeConfirmationSettings(asObject(saved.data)), revision: Number(saved.revision ?? 0) };
}

// ── Queue rows ──────────────────────────────────────────────────────────────

export type ConfirmationRow = JsonObject & {
  id: string;
  organization_id: string;
  branch_id: string;
  project_id: string;
  event_id: string;
  status: string;
  token: string;
  group_key: string;
};

function mapRow(row: Record<string, unknown> | undefined): ConfirmationRow | null {
  if (!row) return null;
  return {
    ...row,
    channels: parseJson(row.channels_json, {}),
    config: parseJson(row.config_json, {}),
    event: parseJson(row.event_json, {}),
    message_ids: parseJson(row.message_ids_json, [])
  } as unknown as ConfirmationRow;
}

export function contactKeyFor(email: string, phone: string) {
  const parts = [cleanText(email).toLowerCase(), cleanText(phone)].filter(Boolean);
  return parts.length ? createHash("sha256").update(parts.join("|")).digest("hex").slice(0, 24) : "";
}

export function groupKeyFor(orgId: string, contactKey: string, localDay: string) {
  return createHash("sha256").update(`${orgId}:${contactKey}:${localDay}`).digest("hex").slice(0, 24);
}

export type UpsertConfirmationInput = {
  organization_id: string;
  branch_id: string;
  project_id: string;
  event_id: string;
  contact_id?: string;
  contact_name?: string;
  contact_email?: string;
  contact_phone?: string;
  timezone: string;
  local_day: string;
  send_at: string;
  starts_at: string;
  channels: JsonObject;
  config: JsonObject;
  event: JsonObject;
};

/**
 * Creates or re-times the queue row for one appointment. A row that has already
 * been answered is left alone unless the appointment moved, in which case the
 * caller cancels it first — confirmation of a time the customer no longer has
 * is worse than asking twice.
 */
export async function upsertConfirmationRow(input: UpsertConfirmationInput) {
  return (await getAppointmentsDatabase().transaction(async () => {
  const db = getAppointmentsDatabase();
  const now = nowIso();
  const contactKey = contactKeyFor(cleanText(input.contact_email), cleanText(input.contact_phone));
  const groupKey = groupKeyFor(input.organization_id, contactKey, input.local_day);
  const existing = (await readConfirmationByEvent(input.organization_id, input.project_id, input.event_id));
  if (existing) {
    (await db.prepare(`
      UPDATE appointment_confirmations
      SET branch_id=?, contact_id=?, contact_name=?, contact_email=?, contact_phone=?, contact_key=?,
          group_key=?, local_day=?, timezone=?, channels_json=?, config_json=?, event_json=?,
          send_at=?, starts_at=?, updated_at=?
      WHERE id=?
    `).run(
      cleanText(input.branch_id) || "default",
      cleanText(input.contact_id),
      cleanText(input.contact_name),
      cleanText(input.contact_email),
      cleanText(input.contact_phone),
      contactKey,
      groupKey,
      input.local_day,
      input.timezone,
      json(input.channels),
      json(input.config),
      json(input.event),
      input.send_at,
      input.starts_at,
      now,
      cleanText(existing.id)
    ));
    return (await readConfirmationRow(cleanText(existing.id)))!;
  }
  const id = `apptconf_${randomUUID().replace(/-/g, "").slice(0, 20)}`;
  // Every appointment in a day's group shares one token, so the single message
  // the customer receives — and the single reply they send — covers all of them.
  const groupToken = (await db.prepare(`
    SELECT token FROM appointment_confirmations
    WHERE group_key=? AND status IN ('pending','sent') LIMIT 1
  `).get(groupKey)) as Record<string, unknown> | undefined;
  (await db.prepare(`
    INSERT INTO appointment_confirmations
      (id, organization_id, branch_id, project_id, event_id, contact_id, contact_name, contact_email,
       contact_phone, contact_key, group_key, local_day, timezone, token, status, channels_json,
       config_json, event_json, send_at, starts_at, created_at, updated_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
  `).run(
    id,
    input.organization_id,
    cleanText(input.branch_id) || "default",
    input.project_id,
    input.event_id,
    cleanText(input.contact_id),
    cleanText(input.contact_name),
    cleanText(input.contact_email),
    cleanText(input.contact_phone),
    contactKey,
    groupKey,
    input.local_day,
    input.timezone,
    cleanText(groupToken?.token) || randomUUID(),
    "pending",
    json(input.channels),
    json(input.config),
    json(input.event),
    input.send_at,
    input.starts_at,
    now,
    now
  ));
  return (await readConfirmationRow(id))!;

  }));
}

export async function readConfirmationRow(id: string) {
  const row = (await getAppointmentsDatabase()
    .prepare("SELECT * FROM appointment_confirmations WHERE id=?")
    .get(cleanText(id))) as Record<string, unknown> | undefined;
  return mapRow(row);
}

export async function readConfirmationByEvent(orgId: string, projectId: string, eventId: string) {
  const row = (await getAppointmentsDatabase()
    .prepare("SELECT * FROM appointment_confirmations WHERE organization_id=? AND project_id=? AND event_id=?")
    .get(cleanText(orgId), cleanText(projectId), cleanText(eventId))) as Record<string, unknown> | undefined;
  return mapRow(row);
}

export async function readConfirmationsByToken(token: string) {
  const rows = (await getAppointmentsDatabase()
    .prepare("SELECT * FROM appointment_confirmations WHERE token=? ORDER BY starts_at ASC")
    .all(cleanText(token))) as Record<string, unknown>[];
  return rows.map(mapRow).filter(Boolean) as ConfirmationRow[];
}

export async function listConfirmationRows(filters: {
  organization_id?: string;
  project_id?: string;
  status?: string[];
  group_key?: string;
  limit?: number;
} = {}) {
  const clauses: string[] = [];
  const values: SQLInputValue[] = [];
  if (cleanText(filters.organization_id)) {
    clauses.push("organization_id=?");
    values.push(cleanText(filters.organization_id));
  }
  if (cleanText(filters.project_id)) {
    clauses.push("project_id=?");
    values.push(cleanText(filters.project_id));
  }
  if (cleanText(filters.group_key)) {
    clauses.push("group_key=?");
    values.push(cleanText(filters.group_key));
  }
  const statuses = (filters.status || []).map(cleanText).filter(Boolean);
  if (statuses.length) {
    clauses.push(`status IN (${statuses.map(() => "?").join(",")})`);
    values.push(...statuses);
  }
  const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
  const limit = clampInt(filters.limit, 1, 2000, 500);
  const rows = (await getAppointmentsDatabase()
    .prepare(`SELECT * FROM appointment_confirmations ${where} ORDER BY send_at ASC LIMIT ?`)
    .all(...values, limit)) as Record<string, unknown>[];
  return rows.map(mapRow).filter(Boolean) as ConfirmationRow[];
}

/**
 * Claims every due group for sending. Rows are leased rather than deleted so a
 * crashed tick re-runs them once the lease lapses; the whole group is claimed
 * together so a customer with several appointments gets exactly one message.
 */
export async function claimDueConfirmationGroups(now = new Date(), leaseSeconds = 120, maxGroups = 25) {
  return (await getAppointmentsDatabase().transaction(async () => {
  const db = getAppointmentsDatabase();
  const nowIsoValue = now.toISOString();
  const groups = (await db.prepare(`
    SELECT group_key FROM appointment_confirmations
    WHERE status='pending' AND send_at<=? AND (lease_until IS NULL OR lease_until<?)
    GROUP BY group_key
    ORDER BY MIN(send_at) ASC
    LIMIT ?
  `).all(nowIsoValue, nowIsoValue, maxGroups)) as Record<string, unknown>[];
  const leaseUntil = new Date(now.getTime() + leaseSeconds * 1000).toISOString();
  const claimed: ConfirmationRow[][] = [];
  for (const group of groups) {
    const groupKey = cleanText(group.group_key);
    if (!groupKey) continue;
    (await db.prepare(`
      UPDATE appointment_confirmations
      SET lease_until=?, attempts=attempts+1, updated_at=?
      WHERE group_key=? AND status='pending' AND send_at<=?
    `).run(leaseUntil, nowIsoValue, groupKey, nowIsoValue));
    const rows = (await db.prepare(`
      SELECT * FROM appointment_confirmations
      WHERE group_key=? AND status='pending' AND lease_until=?
      ORDER BY starts_at ASC
    `).all(groupKey, leaseUntil)) as Record<string, unknown>[];
    const mapped = rows.map(mapRow).filter(Boolean) as ConfirmationRow[];
    if (mapped.length) claimed.push(mapped);
  }
  return claimed;

  }));
}

export async function patchConfirmationRow(id: string, patch: JsonObject) {
  return (await getAppointmentsDatabase().transaction(async () => {
  const columns: string[] = [];
  const values: SQLInputValue[] = [];
  const assignable: Record<string, (value: unknown) => SQLInputValue> = {
    status: cleanText,
    send_at: cleanText,
    lease_until: (value) => (value === null ? null : cleanText(value)),
    sent_at: cleanText,
    responded_at: cleanText,
    confirmed_at: cleanText,
    declined_at: cleanText,
    response_channel: cleanText,
    response_message_id: cleanText,
    response_text: (value) => cleanText(value).slice(0, 1000),
    resolution: cleanText,
    last_error: (value) => cleanText(value).slice(0, 500),
    channels_json: (value) => json(value),
    config_json: (value) => json(value),
    event_json: (value) => json(value),
    message_ids_json: (value) => json(value)
  };
  for (const [key, transform] of Object.entries(assignable)) {
    if (!(key in patch)) continue;
    columns.push(`${key}=?`);
    values.push(transform(patch[key]));
  }
  if (!columns.length) return (await readConfirmationRow(id));
  columns.push("updated_at=?");
  values.push(nowIso());
  values.push(cleanText(id));
  (await getAppointmentsDatabase()
    .prepare(`UPDATE appointment_confirmations SET ${columns.join(", ")} WHERE id=?`)
    .run(...values));
  return (await readConfirmationRow(id));

  }));
}

export async function cancelConfirmationsForEvent(orgId: string, projectId: string, eventId: string, reason = "canceled") {
  return (await getAppointmentsDatabase().transaction(async () => {
  const existing = (await readConfirmationByEvent(orgId, projectId, eventId));
  if (!existing) return null;
  if (["confirmed", "declined"].includes(cleanText(existing.status))) return existing;
  return (await patchConfirmationRow(cleanText(existing.id), { status: "canceled", resolution: reason, lease_until: null }));

  }));
}

export async function deleteConfirmationsForEvent(orgId: string, projectId: string, eventId: string) {
  return (await getAppointmentsDatabase().transaction(async () => {
  (await getAppointmentsDatabase()
    .prepare("DELETE FROM appointment_confirmations WHERE organization_id=? AND project_id=? AND event_id=?")
    .run(cleanText(orgId), cleanText(projectId), cleanText(eventId)));

  }));
}

/**
 * Rows still listening for a reply from one contact address. Ordered so the
 * soonest appointment wins when a bare "yes" could apply to several.
 */
export async function awaitingConfirmationRows(orgId: string, options: { email?: string; phone?: string; contact_key?: string } = {}) {
  const contactKey = cleanText(options.contact_key)
    || contactKeyFor(cleanText(options.email), cleanText(options.phone));
  const db = getAppointmentsDatabase();
  const direct = contactKey
    ? (await db.prepare(`
        SELECT * FROM appointment_confirmations
        WHERE organization_id=? AND contact_key=? AND status='sent'
        ORDER BY starts_at ASC
      `).all(cleanText(orgId), contactKey)) as Record<string, unknown>[]
    : [];
  if (direct.length) return direct.map(mapRow).filter(Boolean) as ConfirmationRow[];
  // A customer may reply from a secondary address or a number formatted
  // differently than the one we stored; fall back to a per-field match.
  const email = cleanText(options.email).toLowerCase();
  const phone = cleanText(options.phone);
  if (!email && !phone) return [];
  const rows = (await db.prepare(`
    SELECT * FROM appointment_confirmations
    WHERE organization_id=? AND status='sent' AND (
      (?<>'' AND lower(contact_email)=?) OR (?<>'' AND contact_phone=?)
    )
    ORDER BY starts_at ASC
  `).all(cleanText(orgId), email, email, phone, phone)) as Record<string, unknown>[];
  return rows.map(mapRow).filter(Boolean) as ConfirmationRow[];
}

/** Sent rows whose response window has lapsed — they stop listening. */
export async function expiredConfirmationRows(now = new Date(), windowHoursDefault = 24, limit = 200) {
  const rows = (await getAppointmentsDatabase().prepare(`
    SELECT * FROM appointment_confirmations
    WHERE status='sent' AND sent_at<>'' ORDER BY sent_at ASC LIMIT ?
  `).all(limit)) as Record<string, unknown>[];
  return (rows.map(mapRow).filter(Boolean) as ConfirmationRow[]).filter((row) => {
    const config = asObject(row.config);
    const windowHours = clampInt(config.response_window_hours, 1, 168, windowHoursDefault);
    const sentAt = Date.parse(cleanText(row.sent_at));
    const startsAt = Date.parse(cleanText(row.starts_at));
    const confirmationDeadlineMinutes = clampInt(config.confirmation_deadline_minutes_before, 0, 43_200, 0);
    if (!Number.isFinite(sentAt)) return false;
    // Stop listening once the window lapses or the appointment itself starts,
    // whichever comes first — a "yes" after the visit means nothing.
    const deadline = Math.min(
      sentAt + windowHours * 3_600_000,
      Number.isFinite(startsAt)
        ? startsAt - confirmationDeadlineMinutes * 60_000
        : Number.POSITIVE_INFINITY
    );
    return now.getTime() >= deadline;
  });
}
