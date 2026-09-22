import { platformBackgroundAllowed } from "../platform/runtime.js";
// Appointment confirmation service.
//
// Flow: saving a scheduled appointment plans a queue row (`syncAppointmentConfirmation`)
// → the tick sends one message per customer per day (`runConfirmationTick`) through the
// same project comms path the Comms tab uses, so the outbound message and the customer's
// reply both land in the project thread → an inbound reply, or a click on the confirm
// link, resolves every appointment in that day's group (`resolveConfirmationRows`).
//
// The appointment itself carries the answer: `event.confirmation.status` is what the
// schedule views render (dashed border while unconfirmed), and it is the field a scope
// template seeds when it wants a whole class of appointments to require confirmation.

import { badRequest, notFound } from "../platform/errors.js";
import {
  readDocument,
  readGlobal,
  readOrganization,
  upsertDocument,
  type JsonObject
} from "../platform/storage.js";
import { env } from "../src/config/env.js";
import { isCapabilityEnabled } from "../platform/capabilities.js";
import { emitWorkEvent } from "../work/engine.js";
import {
  asArray,
  asObject,
  awaitingConfirmationRows,
  cancelConfirmationsForEvent,
  claimDueConfirmationGroups,
  cleanText,
  deleteConfirmationsForEvent,
  expiredConfirmationRows,
  listConfirmationRows,
  normalizeConfirmationSchedule,
  normalizeEventConfirmation,
  patchConfirmationRow,
  readConfirmationByEvent,
  readConfirmationSettings,
  readConfirmationsByToken,
  upsertConfirmationRow,
  type ConfirmationRow
} from "./storage.js";

export { readConfirmationSettings, writeConfirmationSettings } from "./storage.js";

const APPOINTMENT_CATEGORY_TYPES = new Set([
  "sales_appointment",
  "sales_follow_up",
  "appointment",
  "estimate",
  "consultation",
  "inspection",
  "service_call"
]);

// ── Timezone helpers (shared in platform/timezone.ts) ──────────────────────

import { resolveOrganizationTimezone, safeTimezone, zonedInstant, zonedParts } from "../platform/timezone.js";

export { zonedParts, zonedInstant };

export function localDayKey(instant: Date, timezone: string) {
  const parts = zonedParts(instant, timezone);
  return `${parts.year}-${String(parts.month).padStart(2, "0")}-${String(parts.day).padStart(2, "0")}`;
}

function parseTimeOfDay(value: string) {
  const match = /^(\d{1,2}):(\d{2})$/.exec(cleanText(value)) || ["", "9", "00"];
  return { hour: Number(match[1]) || 0, minute: Number(match[2]) || 0 };
}

function addDaysInZone(instant: Date, days: number, timezone: string, hour: number, minute: number) {
  const parts = zonedParts(instant, timezone);
  const shifted = new Date(Date.UTC(parts.year, parts.month - 1, parts.day + days));
  return zonedInstant(
    shifted.getUTCFullYear(),
    shifted.getUTCMonth() + 1,
    shifted.getUTCDate(),
    hour,
    minute,
    timezone
  );
}

/**
 * When the confirmation message for an appointment should go out.
 *
 * The four modes cover the phrasings people actually use: "morning of" (a fixed
 * local time on the day), "an hour before" (a rolling offset), "the previous
 * afternoon" (days_before with a time), and an explicit local time on the day.
 * The result is clamped into the allowed sending hours so nothing fires at 3am.
 */
export function computeSendAt(startAt: Date, schedule: JsonObject, timezone: string) {
  const rule = normalizeConfirmationSchedule(schedule);
  const mode = cleanText(rule.mode);
  const { hour, minute } = parseTimeOfDay(cleanText(rule.time_of_day));
  let sendAt: Date;
  if (mode === "before_offset") {
    sendAt = new Date(startAt.getTime() - Math.max(5, Number(rule.offset_minutes) || 120) * 60_000);
  } else if (mode === "days_before") {
    sendAt = addDaysInZone(startAt, -Math.max(0, Number(rule.days_before) || 0), timezone, hour, minute);
  } else {
    // morning_of and time_of_day are the same computation; they differ only in
    // the default time the settings UI offers.
    sendAt = addDaysInZone(startAt, 0, timezone, hour, minute);
  }
  // A rolling offset is deliberately literal — "an hour before" means an hour
  // before even if that is 7am. Only the fixed-time modes get clamped.
  if (mode !== "before_offset") {
    const parts = zonedParts(sendAt, timezone);
    const earliest = Math.max(0, Math.min(23, Number(rule.earliest_hour ?? 8)));
    const latest = Math.max(0, Math.min(23, Number(rule.latest_hour ?? 20)));
    if (parts.hour < earliest) {
      sendAt = zonedInstant(parts.year, parts.month, parts.day, earliest, 0, timezone);
    } else if (parts.hour > latest) {
      sendAt = zonedInstant(parts.year, parts.month, parts.day, latest, 0, timezone);
    }
  }
  // Never schedule past the appointment itself.
  if (sendAt.getTime() >= startAt.getTime()) {
    sendAt = new Date(startAt.getTime() - 15 * 60_000);
  }
  return sendAt;
}

// ── Context resolution ──────────────────────────────────────────────────────

export async function resolveConfirmationContext(orgId: string, branchId: string) {
  const normalizedBranch = cleanText(branchId) || "default";
  const [{ settings }, organization, global] = await Promise.all([
    readConfirmationSettings(orgId, normalizedBranch),
    readOrganization(orgId).catch(() => ({} as JsonObject)),
    readGlobal(orgId).catch(() => null)
  ]);
  const globalData = asObject(global?.data);
  let timezone = safeTimezone(settings.timezone, "");
  if (!timezone) timezone = await resolveOrganizationTimezone(orgId, normalizedBranch);
  return {
    settings,
    timezone,
    branchId: normalizedBranch,
    companyName: cleanText(organization.name || globalData.name) || "Our team"
  };
}

function projectPrimaryContact(project: JsonObject) {
  const contacts = asArray(project.contacts).map(asObject);
  const primary = contacts.find((entry) => entry.primary === true || cleanText(entry.role).toLowerCase() === "primary")
    || contacts[0]
    || {};
  const customer = asObject(project.customer);
  return {
    id: cleanText(primary.id || primary.contact_id || customer.id || project.contact_id),
    name: cleanText(primary.name || customer.name || project.customer_name || project.primary_contact_name),
    email: cleanText(primary.email || customer.email || project.customer_email || project.primary_contact_email).toLowerCase(),
    phone: cleanText(primary.phone || asArray(primary.phones)[0] || primary.mobile || customer.phone || project.customer_phone)
  };
}

export function isAppointmentEvent(event: JsonObject) {
  const typeId = cleanText(event.event_type_default_id || event.type_id || event.event_type_id).toLowerCase();
  const kind = cleanText(event.kind || event.schedule_item_kind).toLowerCase();
  if (kind === "material_delivery") return false;
  return APPOINTMENT_CATEGORY_TYPES.has(typeId) || typeId.includes("appointment");
}

/**
 * The effective confirmation config for one appointment: what the event itself
 * declares, falling back to a matching company auto-rule, falling back to the
 * company default. Scope templates set the event block, so a scope-generated
 * appointment arrives already configured.
 */
export function resolveEventConfirmationConfig(event: JsonObject, settings: JsonObject) {
  const declared = asObject(event.confirmation);
  const hasDeclaration = Object.keys(declared).length > 0 && declared.required !== undefined;
  const typeId = cleanText(event.event_type_default_id || event.type_id).toLowerCase();
  const rule = asArray(settings.auto_rules).map(asObject)
    .find((entry) => cleanText(entry.event_type_default_id).toLowerCase() === typeId && entry.enabled !== false);
  const defaults = rule
    ? {
      channels: asObject(rule.channels),
      include_portal_link: rule.include_portal_link === true,
      schedule: asObject(rule.schedule),
      no_response_action: cleanText(rule.no_response_action || settings.no_response_action),
      confirmation_deadline_minutes_before: Number(rule.confirmation_deadline_minutes_before ?? settings.confirmation_deadline_minutes_before) || 0
    }
    : {
      channels: asObject(settings.channels),
      include_portal_link: settings.include_portal_link === true,
      schedule: asObject(settings.schedule),
      no_response_action: cleanText(settings.no_response_action),
      confirmation_deadline_minutes_before: Number(settings.confirmation_deadline_minutes_before) || 0
    };
  const normalized = normalizeEventConfirmation(declared, defaults);
  if (!hasDeclaration) {
    normalized.required = settings.enabled === true && (!!rule || settings.default_required === true);
  }
  if (settings.enabled !== true) normalized.required = false;
  return normalized;
}

// ── Planning ────────────────────────────────────────────────────────────────

/**
 * Reconciles the queue with one appointment's current state and returns the
 * confirmation block to persist on the event. Called from the project-event
 * write path, so moving, unscheduling, or cancelling an appointment
 * automatically re-times or withdraws its pending confirmation request.
 */
export async function syncAppointmentConfirmation(
  orgId: string,
  branchId: string,
  projectId: string,
  event: JsonObject,
  project: JsonObject
) {
  const context = await resolveConfirmationContext(orgId, branchId);
  const config = resolveEventConfirmationConfig(event, context.settings);
  const eventId = cleanText(event.id);
  const status = cleanText(event.status).toLowerCase();
  const startAt = new Date(cleanText(event.start_at));
  const scheduled = !!cleanText(event.start_at)
    && Number.isFinite(startAt.getTime())
    && !["unscheduled", "canceled", "cancelled"].includes(status);

  if (!config.required || !scheduled) {
    (await cancelConfirmationsForEvent(orgId, projectId, eventId, config.required ? "unscheduled" : "not_required"));
    return {
      ...config,
      required: config.required,
      status: config.required ? "pending" : "not_required",
      scheduled_send_at: ""
    };
  }

  const contact = projectPrimaryContact(project);
  const wantsEmail = config.channels && asObject(config.channels).email === true && !!contact.email;
  const wantsSms = config.channels && asObject(config.channels).sms === true && !!contact.phone;
  if (!wantsEmail && !wantsSms) {
    (await cancelConfirmationsForEvent(orgId, projectId, eventId, "no_reachable_channel"));
    return {
      ...config,
      status: "failed",
      last_error: "No email address or mobile number is available for this customer.",
      scheduled_send_at: ""
    };
  }

  const existing = (await readConfirmationByEvent(orgId, projectId, eventId));
  const existingStart = cleanText(existing?.starts_at);
  const movedAfterAnswer = !!existing
    && ["confirmed", "declined"].includes(cleanText(existing.status))
    && existingStart !== startAt.toISOString();
  // A confirmed appointment that then moves is unconfirmed again: the customer
  // agreed to a time that no longer exists.
  if (movedAfterAnswer) (await deleteConfirmationsForEvent(orgId, projectId, eventId));
  const current = movedAfterAnswer ? null : existing;
  if (current && ["confirmed", "declined"].includes(cleanText(current.status))) {
    return {
      ...config,
      status: cleanText(current.status),
      sent_at: cleanText(current.sent_at),
      confirmed_at: cleanText(current.confirmed_at),
      declined_at: cleanText(current.declined_at),
      confirmed_via: cleanText(current.response_channel),
      confirmed_by: cleanText(current.contact_name) || contact.name,
      response_text: cleanText(current.response_text),
      scheduled_send_at: cleanText(current.send_at)
    };
  }
  // Already sent and still listening: leave the send alone, keep the row in sync.
  if (current && cleanText(current.status) === "sent" && existingStart === startAt.toISOString()) {
    return {
      ...config,
      status: "sent",
      sent_at: cleanText(current.sent_at),
      channels_sent: asArray(asObject(current.channels).sent).map(cleanText).filter(Boolean),
      scheduled_send_at: cleanText(current.send_at)
    };
  }

  const sendAt = computeSendAt(startAt, asObject(config.schedule), context.timezone);
  const row = (await upsertConfirmationRow({
    organization_id: orgId,
    branch_id: context.branchId,
    project_id: projectId,
    event_id: eventId,
    contact_id: contact.id,
    contact_name: contact.name,
    contact_email: wantsEmail ? contact.email : "",
    contact_phone: wantsSms ? contact.phone : "",
    timezone: context.timezone,
    local_day: localDayKey(startAt, context.timezone),
    send_at: sendAt.toISOString(),
    starts_at: startAt.toISOString(),
    channels: { email: wantsEmail, sms: wantsSms },
    config: {
      ...config,
      response_window_hours: Number(context.settings.response_window_hours) || 24,
      include_portal_link: config.include_portal_link === true
    },
    event: {
      id: eventId,
      title: cleanText(event.title),
      start_at: startAt.toISOString(),
      end_at: cleanText(event.end_at),
      duration_minutes: Number(event.duration_minutes) || 60,
      event_type_default_id: cleanText(event.event_type_default_id),
      project_address: cleanText(event.project_address || project.address)
    }
  }));
  // A row that had already been sent and is now re-timed starts listening again.
  if (cleanText(row.status) !== "pending") {
    (await patchConfirmationRow(cleanText(row.id), { status: "pending", lease_until: null, sent_at: "", resolution: "" }));
  }
  return {
    ...config,
    status: "pending",
    // A re-timed appointment carries no answer: whatever the customer said
    // applied to the old time.
    sent_at: "",
    confirmed_at: "",
    declined_at: "",
    confirmed_via: "",
    confirmed_by: "",
    response_text: "",
    channels_sent: [],
    last_error: "",
    requested_at: cleanText(row.created_at),
    scheduled_send_at: sendAt.toISOString()
  };
}

export async function withdrawAppointmentConfirmation(orgId: string, projectId: string, eventId: string) {
  return (await cancelConfirmationsForEvent(orgId, projectId, eventId, "event_deleted"));
}

// ── Message composition ─────────────────────────────────────────────────────

function firstName(value: string) {
  return cleanText(value).split(/\s+/)[0] || "";
}

function mergeFields(template: string, vars: Record<string, string>) {
  return String(template ?? "").replace(/\{\{\s*([a-zA-Z0-9_.-]+)\s*\}\}/g, (match, key: string) => (
    Object.prototype.hasOwnProperty.call(vars, key) ? vars[key] ?? "" : match
  )).trim();
}

export function confirmPublicUrl(token: string, baseUrl = "") {
  const base = cleanText(baseUrl) || cleanText(env.publicBaseUrl);
  return `${base.replace(/\/+$/, "")}/v1/appointments/public/${encodeURIComponent(token)}/app`;
}

function formatAppointmentTime(startAt: string, timezone: string, allDay = false) {
  const instant = new Date(cleanText(startAt));
  if (!Number.isFinite(instant.getTime())) return "";
  const day = new Intl.DateTimeFormat("en-US", {
    timeZone: timezone,
    weekday: "long",
    month: "long",
    day: "numeric"
  }).format(instant);
  if (allDay) return day;
  const time = new Intl.DateTimeFormat("en-US", {
    timeZone: timezone,
    hour: "numeric",
    minute: "2-digit"
  }).format(instant).replace(/\s/g, "").toLowerCase();
  return `${day} at ${time}`;
}

/** "appointment on Tuesday, March 4 at 9:00am", or a list when there are several. */
export function appointmentSummary(rows: ConfirmationRow[], timezone: string) {
  const entries = rows.map((row) => {
    const event = asObject(row.event);
    const label = cleanText(event.title) || "appointment";
    return { label, when: formatAppointmentTime(cleanText(event.start_at), cleanText(row.timezone) || timezone) };
  }).filter((entry) => entry.when);
  if (!entries.length) return "appointment";
  if (entries.length === 1) return `${entries[0]!.label} on ${entries[0]!.when}`;
  return `${entries.length} appointments on ${entries[0]!.when.split(" at ")[0]}`;
}

function appointmentLines(rows: ConfirmationRow[], timezone: string) {
  return rows.map((row) => {
    const event = asObject(row.event);
    const when = formatAppointmentTime(cleanText(event.start_at), cleanText(row.timezone) || timezone);
    const title = cleanText(event.title) || "Appointment";
    const address = cleanText(event.project_address);
    return `• ${title} — ${when}${address ? `\n  ${address}` : ""}`;
  }).join("\n");
}

async function portalLinkFor(orgId: string, projectId: string, baseUrl = "") {
  try {
    const { ensureCustomerPortalRecord } = await import("../platform/api.js");
    const record = await ensureCustomerPortalRecord(orgId, projectId, {}, baseUrl || cleanText(env.publicBaseUrl));
    return cleanText(asObject(asObject(record).portal).live_url);
  } catch {
    return "";
  }
}

// ── Sending ─────────────────────────────────────────────────────────────────

/**
 * Sends one message covering every appointment in a claimed group. All rows in
 * the group share a token, so one reply answers all of them.
 */
export async function sendConfirmationGroup(rows: ConfirmationRow[], options: { base_url?: string } = {}) {
  const first = rows[0]!;
  const orgId = cleanText(first.organization_id);
  const branchId = cleanText(first.branch_id) || "default";
  const projectId = cleanText(first.project_id);
  const context = await resolveConfirmationContext(orgId, branchId);
  const timezone = cleanText(first.timezone) || context.timezone;
  const token = cleanText(first.token);
  const config = asObject(first.config);
  const channels = asObject(first.channels);
  const wantsEmail = rows.some((row) => asObject(row.channels).email === true && !!cleanText(row.contact_email));
  const wantsSms = rows.some((row) => asObject(row.channels).sms === true && !!cleanText(row.contact_phone));
  const confirmLink = confirmPublicUrl(token, options.base_url);
  const portalLink = config.include_portal_link === true
    ? await portalLinkFor(orgId, projectId, options.base_url)
    : "";
  const vars = {
    customer_name: cleanText(first.contact_name) || "there",
    customer_first_name: firstName(cleanText(first.contact_name)) || "there",
    company_name: context.companyName,
    appointment_summary: appointmentSummary(rows, timezone),
    appointment_list: appointmentLines(rows, timezone),
    confirm_link: confirmLink,
    portal_link: portalLink
  };
  const messages = asObject(context.settings.messages);
  const sent: string[] = [];
  const messageIds: string[] = [];
  const errors: string[] = [];

  if (wantsSms) {
    try {
      const { sendProjectSms } = await import("../comms/service.js");
      let text = mergeFields(cleanText(messages.sms_text), vars);
      if (!text.includes(confirmLink)) text = `${text}\n${confirmLink}`;
      if (portalLink && !text.includes(portalLink)) text = `${text}\nYour project portal: ${portalLink}`;
      const result = await sendProjectSms(orgId, branchId, projectId, {
        to: cleanText(first.contact_phone),
        text,
        source: { type: "automation", id: "appointment_confirmation", automation_id: "appointments.requestConfirmation.v1" },
        idempotency_key: `appointment_confirmation_sms:${token}`
      }, { branchId } as never);
      sent.push("sms");
      const messageId = cleanText(asObject(asObject(result).message).id);
      if (messageId) messageIds.push(messageId);
    } catch (error) {
      errors.push(`sms: ${(error as Error).message}`);
    }
  }

  if (wantsEmail) {
    try {
      const { sendProjectEmail } = await import("../comms/service.js");
      let body = mergeFields(cleanText(messages.email_body), vars);
      if (!body.includes(confirmLink)) body = `${body}\n\nConfirm here: ${confirmLink}`;
      if (rows.length > 1 && !body.includes(vars.appointment_list)) {
        body = body.replace(vars.appointment_summary, `appointments:\n\n${vars.appointment_list}\n`);
      }
      if (portalLink && !body.includes(portalLink)) {
        body = `${body}\n\nYou can see everything about your project here: ${portalLink}`;
      }
      const result = await sendProjectEmail(orgId, branchId, projectId, {
        to: cleanText(first.contact_email),
        subject: mergeFields(cleanText(messages.email_subject), vars),
        text: body,
        source: { type: "automation", id: "appointment_confirmation", automation_id: "appointments.requestConfirmation.v1" },
        idempotency_key: `appointment_confirmation_email:${token}`
      }, { branchId } as never);
      sent.push("email");
      const messageId = cleanText(asObject(asObject(result).message).id);
      if (messageId) messageIds.push(messageId);
    } catch (error) {
      errors.push(`email: ${(error as Error).message}`);
    }
  }

  const now = new Date().toISOString();
  const failed = !sent.length;
  for (const row of rows) {
    (await patchConfirmationRow(cleanText(row.id), {
      status: failed ? "failed" : "sent",
      sent_at: failed ? "" : now,
      lease_until: null,
      last_error: errors.join("; "),
      channels_json: { ...channels, sent },
      message_ids_json: messageIds
    }));
    await writeEventConfirmation(orgId, cleanText(row.project_id), cleanText(row.event_id), failed
      ? { status: "failed", last_error: errors.join("; ") }
      : { status: "sent", sent_at: now, channels_sent: sent, scheduled_send_at: cleanText(row.send_at) });
  }

  if (!failed) {
    await emitWorkEvent({
      organization_id: orgId,
      branch_id: branchId,
      project_id: projectId,
      type: "appointment.confirmation.requested",
      idempotency_key: `appointment.confirmation.requested:${token}`,
      payload: {
        token,
        channels: sent,
        event_ids: rows.map((row) => cleanText(row.event_id)),
        confirm_link: confirmLink
      }
    }).catch(() => null);
  }
  return { ok: !failed, channels: sent, errors, message_ids: messageIds, confirm_link: confirmLink };
}

// ── Resolution ──────────────────────────────────────────────────────────────

const CONFIRM_PATTERNS = [
  /^\s*(y|ya|yes+|yep|yup|yeah|ok|okay|k|sure|confirm(ed)?|confirming|affirmative|sounds good|works|that works|see you (then|there)|we'?ll be (there|here)|i'?ll be (there|here)|👍|✅)\b/i,
  /\b(confirm(ed|ing)?|yes,? (that|this) works|still (good|on|works)|see you (then|there))\b/i
];

const DECLINE_PATTERNS = [
  /^\s*(n|no+|nope|nah|cancel|reschedule|can'?t|cannot)\b/i,
  /\b(cancel|reschedule|can'?t make it|cannot make it|won'?t work|does ?n'?t work|another (day|time)|different (day|time))\b/i,
  // "can we move it to Friday", "need to push this back" — a request to change
  // the time is a decline even when it opens with a polite "yes".
  /\b(move|push|shift|change)\b[^.?!]{0,20}\b(it|this|that|us|the (appointment|time)|back|out)\b/i
];

/** Reads a customer's free-text reply as confirm / decline / unclear. */
export function interpretResponse(text: string) {
  const value = cleanText(text).replace(/\s+/g, " ");
  if (!value) return "unclear";
  // Decline wins ties: "yes but can we reschedule" must not read as a confirm.
  if (DECLINE_PATTERNS.some((pattern) => pattern.test(value))) return "declined";
  if (CONFIRM_PATTERNS.some((pattern) => pattern.test(value))) return "confirmed";
  return "unclear";
}

async function writeEventConfirmation(orgId: string, projectId: string, eventId: string, patch: JsonObject) {
  try {
    const document = await readDocument(orgId, "projects", projectId);
    const data = asObject(document.data);
    const events = asArray(data.events).map(asObject);
    const index = events.findIndex((event) => cleanText(event.id) === cleanText(eventId));
    if (index < 0) return false;
    const current = asObject(events[index]!.confirmation);
    events[index] = {
      ...events[index]!,
      confirmation: { ...current, ...patch }
    };
    await upsertDocument(orgId, "projects", {
      id: projectId,
      data: { ...data, events, updated_at: new Date().toISOString() },
      metadata: document.metadata
    }, { replace: true });
    return true;
  } catch {
    return false;
  }
}

async function applyNoResponsePolicy(row: ConfirmationRow) {
  const config = asObject(row.config);
  const requested = cleanText(config.no_response_action) || "keep_reserved";
  const releaseEnabled = await isCapabilityEnabled(cleanText(row.organization_id), "scheduling.confirmation_release").catch(() => false);
  const action = ["release_to_unscheduled", "cancel"].includes(requested) && !releaseEnabled ? "keep_reserved" : requested;
  if (!["release_to_unscheduled", "cancel"].includes(action)) {
    await emitWorkEvent({
      organization_id: cleanText(row.organization_id),
      branch_id: cleanText(row.branch_id) || "default",
      project_id: cleanText(row.project_id),
      type: "appointment.confirmation.no_response",
      idempotency_key: `appointment.confirmation.no_response:${cleanText(row.id)}`,
      payload: { event_id: cleanText(row.event_id), action }
    }).catch(() => null);
    return action;
  }
  try {
    const document = await readDocument(cleanText(row.organization_id), "projects", cleanText(row.project_id));
    const data = asObject(document.data);
    const events = asArray(data.events).map(asObject);
    const index = events.findIndex((event) => cleanText(event.id) === cleanText(row.event_id));
    if (index < 0) return "missing_event";
    const event = events[index]!;
    const now = new Date().toISOString();
    events[index] = {
      ...event,
      status: action === "cancel" ? "cancelled" : "unscheduled",
      ...(action === "release_to_unscheduled" ? {
        previous_start_at: cleanText(event.start_at),
        previous_end_at: cleanText(event.end_at),
        start_at: "",
        end_at: ""
      } : {}),
      schedule_history: [...asArray(event.schedule_history).map(asObject), {
        action: "confirmation_no_response",
        policy_action: action,
        from_start_at: cleanText(event.start_at),
        source: "appointment_confirmation",
        at: now
      }],
      confirmation: { ...asObject(event.confirmation), status: "canceled", no_response: true, no_response_action: action }
    };
    await upsertDocument(cleanText(row.organization_id), "projects", {
      id: cleanText(document.id),
      expected_revision: Number(document.revision || 0),
      data: { ...data, events, updated_at: now },
      metadata: document.metadata
    }, { replace: true });
    await emitWorkEvent({
      organization_id: cleanText(row.organization_id),
      branch_id: cleanText(row.branch_id) || "default",
      project_id: cleanText(row.project_id),
      type: "appointment.confirmation.no_response",
      idempotency_key: `appointment.confirmation.no_response:${cleanText(row.id)}`,
      payload: { event_id: cleanText(row.event_id), action, released_start_at: cleanText(row.starts_at) }
    }).catch(() => null);
    return action;
  } catch {
    return "policy_failed";
  }
}

export type ConfirmationOutcome = "confirmed" | "declined";

/**
 * Applies one answer to a set of queue rows and mirrors it onto the appointments
 * themselves. Used by every resolution path: an inbound reply, the public
 * confirm page, and a staff member marking it by hand.
 */
export async function resolveConfirmationRows(
  rows: ConfirmationRow[],
  outcome: ConfirmationOutcome,
  meta: { channel?: string; message_id?: string; text?: string; by?: string; source?: string } = {}
) {
  const now = new Date().toISOString();
  const resolved: JsonObject[] = [];
  for (const row of rows) {
    if (["confirmed", "declined"].includes(cleanText(row.status))) continue;
    (await patchConfirmationRow(cleanText(row.id), {
      status: outcome,
      responded_at: now,
      confirmed_at: outcome === "confirmed" ? now : "",
      declined_at: outcome === "declined" ? now : "",
      response_channel: cleanText(meta.channel) || cleanText(meta.source) || "link",
      response_message_id: cleanText(meta.message_id),
      response_text: cleanText(meta.text),
      resolution: cleanText(meta.source) || "customer_response",
      lease_until: null
    }));
    await writeEventConfirmation(cleanText(row.organization_id), cleanText(row.project_id), cleanText(row.event_id), {
      status: outcome,
      confirmed_at: outcome === "confirmed" ? now : "",
      declined_at: outcome === "declined" ? now : "",
      confirmed_via: cleanText(meta.channel) || cleanText(meta.source) || "link",
      confirmed_by: cleanText(meta.by) || cleanText(row.contact_name),
      response_text: cleanText(meta.text).slice(0, 500)
    });
    resolved.push({
      id: row.id,
      project_id: row.project_id,
      event_id: row.event_id,
      organization_id: row.organization_id
    });
    await emitWorkEvent({
      organization_id: cleanText(row.organization_id),
      branch_id: cleanText(row.branch_id) || "default",
      project_id: cleanText(row.project_id),
      type: outcome === "confirmed" ? "appointment.confirmed" : "appointment.confirmation.declined",
      idempotency_key: `appointment.${outcome}:${cleanText(row.id)}`,
      payload: {
        event_id: cleanText(row.event_id),
        channel: cleanText(meta.channel) || cleanText(meta.source) || "link",
        response_text: cleanText(meta.text).slice(0, 500),
        starts_at: cleanText(row.starts_at)
      }
    }).catch(() => null);
  }
  return resolved;
}

/**
 * Listener hook: called for every inbound customer message. Matches the sender
 * against appointments still awaiting an answer and resolves them when the
 * reply reads as a yes or a no.
 */
export async function handleInboundConfirmationResponse(orgId: string, message: JsonObject) {
  const channel = cleanText(message.channel);
  if (channel !== "sms" && channel !== "email") return null;
  const sender = asObject(message.sender);
  const address = cleanText(sender.address);
  if (!address) return null;
  const rows = (await awaitingConfirmationRows(orgId, {
    email: channel === "email" ? address.toLowerCase() : "",
    phone: channel === "sms" ? address : ""
  }));
  if (!rows.length) return null;
  const text = `${cleanText(message.subject)} ${cleanText(message.text_body)}`.trim();
  const outcome = interpretResponse(text);
  if (outcome === "unclear") {
    // Leave the request open — a human reading the Comms tab can resolve it,
    // and a later, clearer reply still counts.
    return { matched: rows.length, outcome, resolved: [] };
  }
  const projectId = cleanText(asObject(message.context).project_id || message.project_id);
  // Only answer the appointments the reply could plausibly be about: same
  // project when we know it, otherwise the whole same-day group.
  const targeted = projectId ? rows.filter((row) => cleanText(row.project_id) === projectId) : rows;
  const scoped = targeted.length ? targeted : rows;
  const group = cleanText(scoped[0]!.group_key);
  const sameGroup = scoped.filter((row) => cleanText(row.group_key) === group);
  const resolved = await resolveConfirmationRows(sameGroup, outcome, {
    channel,
    message_id: cleanText(message.id),
    text,
    by: cleanText(sender.name),
    source: "customer_response"
  });
  return { matched: sameGroup.length, outcome, resolved };
}

// ── Tick ────────────────────────────────────────────────────────────────────

let running = false;

export async function runConfirmationTick(options: { now?: Date; base_url?: string } = {}) {
  if (running) return { sent: 0, expired: 0, skipped: true };
  running = true;
  try {
    const now = options.now || new Date();
    let sent = 0;
    for (const group of (await claimDueConfirmationGroups(now))) {
      try {
        const result = await sendConfirmationGroup(group, { base_url: options.base_url });
        if (result.ok) sent += 1;
      } catch (error) {
        for (const row of group) {
          (await patchConfirmationRow(cleanText(row.id), {
            status: Number(row.attempts) >= 3 ? "failed" : "pending",
            lease_until: null,
            last_error: (error as Error).message
          }));
        }
      }
    }
    let expired = 0;
    for (const row of (await expiredConfirmationRows(now))) {
      (await patchConfirmationRow(cleanText(row.id), { status: "sent", resolution: "no_response", lease_until: null }));
      const action = await applyNoResponsePolicy(row);
      if (!["release_to_unscheduled", "cancel"].includes(action)) {
        await writeEventConfirmation(cleanText(row.organization_id), cleanText(row.project_id), cleanText(row.event_id), {
          status: "sent",
          no_response: true,
          no_response_action: action
        });
      }
      expired += 1;
    }
    return { sent, expired, skipped: false };
  } finally {
    running = false;
  }
}

let timer: ReturnType<typeof setInterval> | null = null;

export function startConfirmationScheduler() {
  if (!platformBackgroundAllowed()) return;
  if (timer || process.env.APPOINTMENT_CONFIRMATIONS_DISABLED === "1" || process.env.PLATFORM_HEARTBEAT_DISABLED === "1") return;
  timer = setInterval(() => void runConfirmationTick().catch(() => null), 60_000);
  timer.unref?.();
}

export function stopConfirmationScheduler() {
  if (timer) clearInterval(timer);
  timer = null;
}

// ── Read models ─────────────────────────────────────────────────────────────

export function confirmationRowView(row: ConfirmationRow) {
  const event = asObject(row.event);
  return {
    id: cleanText(row.id),
    project_id: cleanText(row.project_id),
    event_id: cleanText(row.event_id),
    status: cleanText(row.status),
    resolution: cleanText(row.resolution),
    contact_name: cleanText(row.contact_name),
    contact_email: cleanText(row.contact_email),
    contact_phone: cleanText(row.contact_phone),
    channels: asObject(row.channels),
    timezone: cleanText(row.timezone),
    send_at: cleanText(row.send_at),
    starts_at: cleanText(row.starts_at),
    sent_at: cleanText(row.sent_at),
    responded_at: cleanText(row.responded_at),
    confirmed_at: cleanText(row.confirmed_at),
    declined_at: cleanText(row.declined_at),
    response_channel: cleanText(row.response_channel),
    response_text: cleanText(row.response_text),
    last_error: cleanText(row.last_error),
    attempts: Number(row.attempts) || 0,
    event: {
      title: cleanText(event.title),
      start_at: cleanText(event.start_at),
      event_type_default_id: cleanText(event.event_type_default_id)
    }
  };
}

export async function projectConfirmations(orgId: string, projectId: string) {
  return (await listConfirmationRows({ organization_id: orgId, project_id: projectId })).map(confirmationRowView);
}

export async function organizationConfirmations(orgId: string, filters: { status?: string[] } = {}) {
  return (await listConfirmationRows({ organization_id: orgId, status: filters.status })).map(confirmationRowView);
}

// ── Public confirm page ─────────────────────────────────────────────────────

export async function publicConfirmationView(token: string) {
  const rows = (await readConfirmationsByToken(token));
  if (!rows.length) throw notFound("appointment_confirmation_not_found", "This confirmation link is no longer available.");
  const first = rows[0]!;
  const orgId = cleanText(first.organization_id);
  const context = await resolveConfirmationContext(orgId, cleanText(first.branch_id));
  const timezone = cleanText(first.timezone) || context.timezone;
  const config = asObject(first.config);
  const branding = await confirmationBranding(orgId, cleanText(first.branch_id));
  const answered = rows.find((row) => ["confirmed", "declined"].includes(cleanText(row.status)));
  return {
    branding,
    company_name: context.companyName,
    customer_first_name: firstName(cleanText(first.contact_name)),
    appointments: rows.map((row) => {
      const event = asObject(row.event);
      return {
        id: cleanText(row.id),
        title: cleanText(event.title) || "Appointment",
        when: formatAppointmentTime(cleanText(event.start_at), cleanText(row.timezone) || timezone),
        address: cleanText(event.project_address)
      };
    }),
    portal_url: config.include_portal_link === true
      ? await portalLinkFor(orgId, cleanText(first.project_id))
      : "",
    state: {
      answered: !!answered,
      outcome: answered ? cleanText(answered.status) : "",
      answered_at: answered ? cleanText(answered.responded_at) : ""
    }
  };
}

export async function submitPublicConfirmation(token: string, outcome: ConfirmationOutcome, audit: JsonObject = {}) {
  const rows = (await readConfirmationsByToken(token));
  if (!rows.length) throw notFound("appointment_confirmation_not_found", "This confirmation link is no longer available.");
  if (outcome !== "confirmed" && outcome !== "declined") {
    throw badRequest("invalid_confirmation_outcome", "Choose whether the appointment works for you.");
  }
  const resolved = await resolveConfirmationRows(rows, outcome, {
    channel: "link",
    source: "confirmation_link",
    by: cleanText(rows[0]!.contact_name),
    text: cleanText(audit.note)
  });
  return { ok: true, outcome, resolved: resolved.length };
}

async function confirmationBranding(orgId: string, branchId: string) {
  try {
    const { feedbackBranding } = await import("../feedback/service.js");
    return await feedbackBranding(orgId, cleanText(branchId) || "default");
  } catch {
    return { company_name: "", logo: "", colors: { primary: "#2563EB", secondary: "#111111" } };
  }
}

/** Staff-side manual override, used by the schedule popup. */
export async function setAppointmentConfirmation(
  orgId: string,
  projectId: string,
  eventId: string,
  outcome: ConfirmationOutcome | "reset",
  actor: { user_id?: string; name?: string } = {}
) {
  const row = (await readConfirmationByEvent(orgId, projectId, eventId));
  if (outcome === "reset") {
    if (row) {
      (await patchConfirmationRow(cleanText(row.id), {
        status: "pending",
        sent_at: "",
        responded_at: "",
        confirmed_at: "",
        declined_at: "",
        resolution: "reset_by_user",
        lease_until: null
      }));
    }
    await writeEventConfirmation(orgId, projectId, eventId, {
      status: "pending",
      confirmed_at: "",
      declined_at: "",
      confirmed_via: "",
      confirmed_by: "",
      response_text: ""
    });
    return { ok: true, status: "pending" };
  }
  if (!row) {
    await writeEventConfirmation(orgId, projectId, eventId, {
      status: outcome,
      confirmed_at: outcome === "confirmed" ? new Date().toISOString() : "",
      declined_at: outcome === "declined" ? new Date().toISOString() : "",
      confirmed_via: "manual",
      confirmed_by: cleanText(actor.name)
    });
    return { ok: true, status: outcome };
  }
  await resolveConfirmationRows([row], outcome, {
    channel: "manual",
    source: "manual",
    by: cleanText(actor.name)
  });
  return { ok: true, status: outcome };
}

/**
 * Whether the viewer may see confirmation state. Companies that don't want,
 * say, salespeople seeing an unconfirmed flag switch visibility to "permission"
 * and grant the permission to the roles that should have it.
 */
export function canViewConfirmations(settings: JsonObject, ctx: { permissions?: JsonObject; roleIds?: string[] }) {
  const visibility = asObject(settings.visibility);
  if (cleanText(visibility.mode) !== "permission") return true;
  const roleIds = (ctx.roleIds || []).map(cleanText);
  const allowed = asArray(visibility.role_ids).map(cleanText);
  if (allowed.length && roleIds.some((roleId) => allowed.includes(roleId))) return true;
  const permissions = asObject(ctx.permissions);
  return permissions["*"] === true || permissions.view_appointment_confirmation === true;
}
