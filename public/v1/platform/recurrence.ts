import { createHash } from "node:crypto";

import { badRequest, notFound } from "./errors.js";
import { deleteDocument, listDocuments, readDocument, upsertDocument, type JsonObject } from "./storage.js";
import { resolveOrganizationTimezone, safeTimezone, zonedInstant, zonedParts } from "./timezone.js";
import { emitWorkEvent } from "../work/engine.js";
import { updateProjectData } from "./project_document_mutation.js";

const SERIES_COLLECTION = "recurrence_series";
const OCCURRENCE_COLLECTION = "recurrence_occurrences";
const PAYMENT_SCHEDULE_COLLECTION = "payment_schedules";
const PAYMENT_OBLIGATION_COLLECTION = "payment_obligations";
const PAYMENT_PAYABLE_COLLECTION = "payment_payables";
const MAX_OCCURRENCES = 240;

type Frequency = "daily" | "weekly" | "monthly" | "quarterly" | "yearly";
type RecurrenceRule = { frequency: Frequency; interval: number; end_at: string; occurrence_count: number | null };
export type OccurrenceStatusAction = "completed" | "skipped" | "cancelled" | "scheduled";

function asObject(value: unknown): JsonObject {
  return value && typeof value === "object" && !Array.isArray(value) ? { ...(value as JsonObject) } : {};
}

function cleanText(value: unknown) {
  return String(value ?? "").trim();
}

function number(value: unknown, fallback = 0) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function has(value: JsonObject, key: string) {
  return Object.prototype.hasOwnProperty.call(value, key);
}

function nowIso() {
  return new Date().toISOString();
}

function dataView(document: JsonObject): JsonObject {
  const data = asObject(document.data);
  return { ...data, id: cleanText(data.id || document.id), revision: number(document.revision), created_at: cleanText(document.created_at || data.created_at), updated_at: cleanText(document.updated_at || data.updated_at) };
}

function stableId(prefix: string, value: string) {
  return `${prefix}_${createHash("sha256").update(value).digest("hex").slice(0, 24)}`;
}

function frequency(value: unknown, fallback: Frequency = "monthly"): Frequency {
  const normalized = cleanText(value).toLowerCase();
  return (["daily", "weekly", "monthly", "quarterly", "yearly"] as const).includes(normalized as Frequency)
    ? normalized as Frequency
    : fallback;
}

function recurrenceRule(input: JsonObject): RecurrenceRule {
  const raw = asObject(input.recurrence);
  return {
    frequency: frequency(raw.frequency || input.frequency),
    interval: Math.max(1, Math.min(120, Math.round(number(raw.interval ?? input.interval, 1)))),
    end_at: cleanText(raw.end_at || raw.endAt || input.end_at || input.endAt),
    occurrence_count: Math.max(0, Math.round(number(raw.occurrence_count ?? raw.count ?? input.occurrence_count, 0))) || null
  };
}

/**
 * A patch only changes the recurrence keys it names. Omitting
 * `occurrence_count` (as the project dialog does) must not turn a finite
 * series into an endless one; clients clear a key by sending it empty.
 */
function mergedRecurrenceRule(current: JsonObject, patch: JsonObject): RecurrenceRule {
  const currentRule = recurrenceRule(current);
  const raw = asObject(patch.recurrence);
  const touched = has(patch, "recurrence") || has(patch, "frequency") || has(patch, "interval") || has(patch, "occurrence_count");
  if (!touched) return currentRule;
  const merged: JsonObject = { ...currentRule };
  if (has(patch, "frequency")) merged.frequency = patch.frequency;
  if (has(patch, "interval")) merged.interval = patch.interval;
  if (has(patch, "occurrence_count")) merged.occurrence_count = patch.occurrence_count;
  if (has(raw, "frequency")) merged.frequency = raw.frequency;
  if (has(raw, "interval")) merged.interval = raw.interval;
  if (has(raw, "end_at") || has(raw, "endAt")) merged.end_at = has(raw, "end_at") ? raw.end_at : raw.endAt;
  if (has(raw, "occurrence_count") || has(raw, "count")) merged.occurrence_count = has(raw, "occurrence_count") ? raw.occurrence_count : raw.count;
  return recurrenceRule({ recurrence: merged });
}

function dateOrThrow(value: unknown, label: string) {
  const date = new Date(cleanText(value));
  if (!Number.isFinite(date.getTime())) throw badRequest("invalid_recurrence_date", `${label} must be a valid ISO date/time.`);
  return date;
}

function daysInMonth(year: number, month: number) {
  return new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
}

function addUtcMonths(date: Date, months: number) {
  const copy = new Date(date.getTime());
  const wantedDay = copy.getUTCDate();
  copy.setUTCDate(1);
  copy.setUTCMonth(copy.getUTCMonth() + months);
  copy.setUTCDate(Math.min(wantedDay, daysInMonth(copy.getUTCFullYear(), copy.getUTCMonth())));
  return copy;
}

/** Wall-clock milliseconds (the local time read as if it were UTC). */
function wallClockMs(instant: Date, timezone: string) {
  const parts = zonedParts(instant, timezone);
  return Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute, parts.second) + instant.getUTCMilliseconds();
}

function instantFromWallClock(wallMs: number, timezone: string) {
  const wall = new Date(wallMs);
  const minute = zonedInstant(wall.getUTCFullYear(), wall.getUTCMonth() + 1, wall.getUTCDate(), wall.getUTCHours(), wall.getUTCMinutes(), timezone);
  return new Date(minute.getTime() + wall.getUTCSeconds() * 1000 + wall.getUTCMilliseconds());
}

/** Moves an instant by wall-clock minutes in a zone (07:00 stays 07:00 across DST). */
function shiftWallClock(instant: Date, minutes: number, timezone: string) {
  if (!minutes) return new Date(instant.getTime());
  return instantFromWallClock(wallClockMs(instant, timezone) + minutes * 60_000, timezone);
}

/**
 * The start of occurrence `index`. Steps are taken on the local calendar of
 * the series timezone, so a 07:00 meeting stays at 07:00 after a DST change
 * and monthly items keep their day of month (clamped to short months).
 */
export function occurrenceDate(anchor: Date, rule: RecurrenceRule, index: number, timezone = "UTC") {
  const step = Math.max(0, index) * rule.interval;
  if (!step) return new Date(anchor.getTime());
  const local = zonedParts(anchor, timezone);
  let year = local.year;
  let month = local.month - 1;
  let day = local.day;
  if (rule.frequency === "daily") day += step;
  else if (rule.frequency === "weekly") day += step * 7;
  else {
    const months = step * (rule.frequency === "quarterly" ? 3 : rule.frequency === "yearly" ? 12 : 1);
    const total = year * 12 + month + months;
    year = Math.floor(total / 12);
    month = total - year * 12;
    day = Math.min(day, daysInMonth(year, month));
  }
  const date = new Date(Date.UTC(year, month, day));
  const wall = Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate(), local.hour, local.minute, local.second) + anchor.getUTCMilliseconds();
  return instantFromWallClock(wall, timezone);
}

/** The pre-DST-fix stepping (fixed milliseconds / UTC months). Only used to recognise untouched legacy occurrences. */
function legacyOccurrenceDate(anchor: Date, rule: RecurrenceRule, index: number) {
  const step = Math.max(0, index) * rule.interval;
  if (rule.frequency === "daily") return new Date(anchor.getTime() + step * 86_400_000);
  if (rule.frequency === "weekly") return new Date(anchor.getTime() + step * 7 * 86_400_000);
  if (rule.frequency === "quarterly") return addUtcMonths(anchor, step * 3);
  if (rule.frequency === "yearly") return addUtcMonths(anchor, step * 12);
  return addUtcMonths(anchor, step);
}

function occurrenceKey(date: Date) {
  return date.toISOString().replace(/[.:-]/g, "").replace("Z", "z");
}

async function seriesTimezone(orgId: string, series: JsonObject) {
  // Series created before timezones were resolved stored a placeholder "UTC";
  // those follow the organization's configured zone like new series do.
  const stored = safeTimezone(series.timezone, "");
  if (stored && stored !== "UTC") return stored;
  const resolved = await resolveOrganizationTimezone(orgId, cleanText(series.branch_id) || "default").catch(() => "");
  return safeTimezone(resolved, "") || stored || "UTC";
}

function finiteSeriesEnd(series: JsonObject, timezone: string) {
  const rule = recurrenceRule(series);
  if (rule.end_at) return dateOrThrow(rule.end_at, "End date");
  if (rule.occurrence_count) return occurrenceDate(dateOrThrow(series.start_at, "Start date"), rule, rule.occurrence_count - 1, timezone);
  return null;
}

function occurrenceCountThrough(anchor: Date, rule: RecurrenceRule, end: Date, timezone: string) {
  let count = 0;
  for (let index = 0; index < 10_000; index += 1) {
    if (rule.occurrence_count && index >= rule.occurrence_count) break;
    const occurrence = occurrenceDate(anchor, rule, index, timezone);
    if (occurrence > end) break;
    count += 1;
  }
  return count;
}

function projectContact(project: JsonObject) {
  const contacts = Array.isArray(project.contacts) ? project.contacts.map(asObject) : [];
  const customer = asObject(project.customer);
  const primary = contacts.find((entry) => entry.primary === true || cleanText(entry.role).toLowerCase() === "primary") || contacts[0] || {};
  return {
    id: cleanText(primary.id || customer.id || project.customer_id),
    name: cleanText(primary.name || customer.name || project.customer_name || project.primary_contact_name),
    email: cleanText(primary.email || customer.email || project.customer_email).toLowerCase(),
    phone: cleanText(primary.phone || customer.phone || project.customer_phone)
  };
}

function templateDuration(template: JsonObject) {
  return Math.max(1, Math.round(number(template.duration_minutes || template.duration, 60)));
}

function eventForOccurrence(series: JsonObject, start: Date, key: string, timezone = "UTC") {
  const template = asObject(series.event_template);
  const duration = templateDuration(template);
  // All-day items span local days; timed items keep their exact length.
  const end = template.all_day === true ? shiftWallClock(start, duration, timezone) : new Date(start.getTime() + duration * 60_000);
  const eventType = cleanText(template.event_type_default_id || template.type_id || template.event_type_id || template.type || "project_work") || "project_work";
  return {
    ...template,
    id: stableId("recurring_event", `${cleanText(series.id)}:${key}`),
    title: cleanText(template.title || series.title || "Recurring appointment"),
    event_type_default_id: eventType,
    type_id: eventType,
    event_type_id: eventType,
    project_id: cleanText(series.project_id),
    status: "scheduled",
    start_at: start.toISOString(),
    end_at: end.toISOString(),
    duration_minutes: duration,
    ...(template.arrival_window_start_at && template.start_at ? {
      arrival_window_start_at: new Date(start.getTime() + Date.parse(String(template.arrival_window_start_at)) - Date.parse(String(template.start_at))).toISOString(),
      arrival_window_end_at: new Date(start.getTime() + Date.parse(String(template.arrival_window_end_at)) - Date.parse(String(template.start_at))).toISOString()
    } : {}),
    recurrence_series_id: cleanText(series.id),
    recurrence_occurrence_key: key,
    recurrence: asObject(series.recurrence),
    scope_piece_id: cleanText(series.scope_piece_id || template.scope_piece_id),
    scope_template_id: cleanText(series.scope_template_id || template.scope_template_id),
    recurring: true,
    created_at: nowIso(),
    updated_at: nowIso()
  } as JsonObject;
}

async function saveProjectEvent(orgId: string, series: JsonObject, event: JsonObject): Promise<JsonObject> {
  const projectId = cleanText(series.project_id);
  if (!projectId) {
    const doc = await upsertDocument(orgId, "calendar_events", {
      id: cleanText(event.id),
      data: event,
      metadata: { kind: "calendar_event", recurrence_series_id: cleanText(series.id) }
    }, { replace: true });
    return dataView(doc);
  }
  // Conditional, serialized write (see project_document_mutation.ts).
  let saved: JsonObject = event;
  await updateProjectData(orgId, projectId, (project) => {
    const events = (Array.isArray(project.events) ? project.events : []).map(asObject);
    const index = events.findIndex((item) => cleanText(item.id) === cleanText(event.id));
    if (index >= 0) {
      const current = events[index] as JsonObject;
      // Completion, skips, and reschedules belong to the concrete occurrence.
      events[index] = ["completed", "skipped"].includes(cleanText(current.status))
        ? { ...event, ...current, recurrence_series_id: cleanText(series.id) }
        : { ...current, ...event, recurrence_series_id: cleanText(series.id) };
    } else events.push(event);
    saved = index >= 0 ? events[index] as JsonObject : event;
    return { ...project, events, updated_at: nowIso() };
  });
  return saved;
}

/** The stored (possibly individually edited) calendar events of a series, by event id. */
async function loadConcreteEvents(orgId: string, series: JsonObject) {
  const events = new Map<string, JsonObject>();
  const projectId = cleanText(series.project_id);
  if (projectId) {
    const doc = await readDocument(orgId, "projects", projectId).catch(() => null);
    for (const entry of Array.isArray(asObject(doc?.data).events) ? asObject(doc?.data).events as unknown[] : []) {
      const event = asObject(entry);
      if (cleanText(event.id)) events.set(cleanText(event.id), event);
    }
    return events;
  }
  for (const doc of await listDocuments(orgId, "calendar_events")) {
    const event: JsonObject = { ...asObject(doc.data), id: cleanText(asObject(doc.data).id || doc.id) };
    if (cleanText(event.recurrence_series_id)) events.set(cleanText(event.id), event);
  }
  return events;
}

/** Replaces (never field-merges) concrete occurrence events and removes others, in one project write. */
async function writeConcreteEvents(orgId: string, projectIdValue: unknown, upserts: JsonObject[], removals: string[] = []) {
  if (!upserts.length && !removals.length) return;
  const projectId = cleanText(projectIdValue);
  const removed = new Set(removals.map(cleanText).filter(Boolean));
  if (projectId) {
    await updateProjectData(orgId, projectId, (project) => {
      const replacements = new Map(upserts.map((event) => [cleanText(event.id), event]));
      const events = (Array.isArray(project.events) ? project.events : []).map(asObject)
        .filter((event) => !removed.has(cleanText(event.id)))
        .map((event) => {
          const replacement = replacements.get(cleanText(event.id));
          if (!replacement) return event;
          replacements.delete(cleanText(event.id));
          return replacement;
        });
      events.push(...replacements.values());
      return { ...project, events, updated_at: nowIso() };
    });
    return;
  }
  for (const event of upserts) {
    const existing = await readDocument(orgId, "calendar_events", cleanText(event.id)).catch(() => null);
    await upsertDocument(orgId, "calendar_events", {
      id: cleanText(event.id),
      data: event,
      metadata: { ...asObject(existing?.metadata), kind: "calendar_event", recurrence_series_id: cleanText(event.recurrence_series_id) }
    }, { replace: true });
  }
  for (const id of removed) await deleteDocument(orgId, "calendar_events", id).catch(() => null);
}

function dueStatus(amount: number, dueAt: string) {
  if (!dueAt) return "scheduled";
  if (Date.parse(dueAt) > Date.now()) return "scheduled";
  return amount > 0 ? "due" : "void";
}

async function ensureRecurringFinance(orgId: string, series: JsonObject, start: Date, key: string, timezone = "UTC") {
  const projectId = cleanText(series.project_id);
  if (!projectId) return;
  const billing = asObject(series.billing);
  const expenses = asObject(series.expenses);
  const billingEnabled = billing.enabled === true && number(billing.amount_cents ?? billing.amount, 0) > 0;
  const expenseEnabled = expenses.enabled === true && number(expenses.amount_cents ?? expenses.amount, 0) > 0;
  const eventRule = recurrenceRule(series);
  const billingRule = recurrenceRule({ recurrence: { ...asObject(billing.recurrence), frequency: billing.frequency || eventRule.frequency, interval: billing.interval || eventRule.interval } });
  const anchor = dateOrThrow(billing.anchor_at || billing.anchorAt || series.start_at, "Billing anchor");
  // Calendar month arithmetic cannot be inferred from milliseconds. Match the billing cadence by walking its bounded horizon instead.
  let matchesBilling = false;
  for (let index = 0; index < MAX_OCCURRENCES; index += 1) {
    const billingAt = occurrenceDate(anchor, billingRule, index, timezone);
    if (billingAt.getTime() === start.getTime()) { matchesBilling = true; break; }
    if (billingAt > start) break;
  }
  if (billingEnabled && matchesBilling) {
    const amount = Math.max(0, Math.round(number(billing.amount_cents, number(billing.amount) * 100)));
    const scheduleId = stableId("recurring_schedule", cleanText(series.id));
    const projectDoc = await readDocument(orgId, "projects", projectId);
    const project = asObject(projectDoc.data);
    await upsertDocument(orgId, PAYMENT_SCHEDULE_COLLECTION, {
      id: scheduleId,
      data: {
        schema_version: 1, id: scheduleId, organization_id: orgId, branch_id: cleanText(series.branch_id || project.branch_id || "default"), project_id: projectId,
        title: `${cleanText(series.title || "Recurring service")} billing`, status: "active", currency: cleanText(billing.currency || "USD") || "USD",
        source: { type: "recurrence_series", id: cleanText(series.id) }, recurrence: billing, total_cents: null, contact_ref: projectContact(project), created_at: nowIso(), updated_at: nowIso()
      },
      metadata: { kind: "payment_schedule", project_id: projectId, recurrence_series_id: cleanText(series.id) }
    }, { replace: true });
    const dueOffsetDays = Math.round(number(billing.due_offset_days, 0));
    const dueAt = new Date(start.getTime() + dueOffsetDays * 86_400_000).toISOString();
    const obligationId = stableId("recurring_obligation", `${cleanText(series.id)}:${key}`);
    await upsertDocument(orgId, PAYMENT_OBLIGATION_COLLECTION, {
      id: obligationId,
      data: {
        schema_version: 1, id: obligationId, organization_id: orgId, branch_id: cleanText(series.branch_id || project.branch_id || "default"), project_id: projectId,
        schedule_id: scheduleId, recurrence_series_id: cleanText(series.id), recurrence_occurrence_key: key, direction: "inbound", label: cleanText(billing.label || series.title || "Recurring service"),
        amount_cents: amount, allocated_cents: 0, refunded_cents: 0, currency: cleanText(billing.currency || "USD") || "USD", due_rule: "recurring", due_at: dueAt,
        grace_days: Math.max(0, Math.round(number(billing.grace_days, 1))), status: dueStatus(amount, dueAt), metadata: { recurring: true }, created_at: nowIso(), updated_at: nowIso()
      },
      metadata: { kind: "payment_obligation", project_id: projectId, schedule_id: scheduleId, recurrence_series_id: cleanText(series.id) }
    }, { replace: true });
  }
  if (expenseEnabled) {
    const amount = Math.max(0, Math.round(number(expenses.amount_cents, number(expenses.amount) * 100)));
    const payableId = stableId("recurring_payable", `${cleanText(series.id)}:${key}`);
    await upsertDocument(orgId, PAYMENT_PAYABLE_COLLECTION, {
      id: payableId,
      data: {
        schema_version: 1, id: payableId, organization_id: orgId, branch_id: cleanText(series.branch_id || "default"), project_id: projectId,
        kind: cleanText(expenses.kind || "recurring_expense"), source: { type: "recurrence_series", id: cleanText(series.id) }, recurrence_series_id: cleanText(series.id), recurrence_occurrence_key: key,
        amount_cents: amount, paid_cents: 0, currency: cleanText(expenses.currency || "USD") || "USD", due_at: start.toISOString(), status: "open", notes: cleanText(expenses.notes), metadata: { recurring: true }, created_at: nowIso(), updated_at: nowIso()
      },
      metadata: { kind: "payment_payable", project_id: projectId, recurrence_series_id: cleanText(series.id) }
    }, { replace: true });
  }
}

/** Voids open (unpaid) obligations and payables of the given occurrence keys, or of every key from `dueFrom` on. */
async function voidSeriesFinance(orgId: string, seriesId: string, options: { keys?: Set<string>; dueFrom?: string }) {
  for (const collection of [PAYMENT_OBLIGATION_COLLECTION, PAYMENT_PAYABLE_COLLECTION] as const) {
    for (const financialDoc of await listDocuments(orgId, collection)) {
      const value = dataView(financialDoc);
      if (cleanText(value.recurrence_series_id) !== seriesId || cleanText(value.status) === "paid") continue;
      const matchesKey = options.keys ? options.keys.has(cleanText(value.recurrence_occurrence_key)) : true;
      const matchesDue = options.dueFrom ? cleanText(value.due_at) >= options.dueFrom : true;
      if (!matchesKey || !matchesDue) continue;
      await upsertDocument(orgId, collection, { id: cleanText(value.id), data: { ...value, status: "void", updated_at: nowIso() }, metadata: asObject(financialDoc.metadata) }, { replace: true });
    }
  }
}

async function seriesOccurrenceDocs(orgId: string, seriesId: string) {
  return (await listDocuments(orgId, OCCURRENCE_COLLECTION)).map(dataView)
    .filter((item) => cleanText(item.recurrence_series_id) === seriesId);
}

/** Which rule slot an occurrence belongs to (tolerates legacy UTC-stepped starts); -1 when none. */
function occurrenceIndexOf(series: JsonObject, timezone: string, occurrence: JsonObject) {
  const at = Date.parse(cleanText(occurrence.starts_at));
  if (!Number.isFinite(at)) return -1;
  const anchor = dateOrThrow(series.start_at, "Start date");
  const rule = recurrenceRule(series);
  const stored = Number(occurrence.occurrence_index);
  if (Number.isInteger(stored) && stored >= 0 && Math.abs(occurrenceDate(anchor, rule, stored, timezone).getTime() - at) < 60_000) return stored;
  let best = -1;
  let bestDiff = Number.POSITIVE_INFINITY;
  for (let index = 0; index < MAX_OCCURRENCES; index += 1) {
    const current = occurrenceDate(anchor, rule, index, timezone).getTime();
    const legacy = legacyOccurrenceDate(anchor, rule, index).getTime();
    const diff = Math.min(Math.abs(current - at), Math.abs(legacy - at));
    if (diff < 60_000) return index;
    if (diff < bestDiff) { bestDiff = diff; best = index; }
    if (Math.min(current, legacy) > at + 86_400_000) break;
  }
  return bestDiff <= 12 * 3_600_000 ? best : -1;
}

function indexOccurrences(docs: JsonObject[], series: JsonObject, timezone: string) {
  const byIndex = new Map<number, JsonObject>();
  const ordered = [...docs].sort((left, right) => cleanText(left.created_at).localeCompare(cleanText(right.created_at)));
  for (const doc of ordered) {
    const index = occurrenceIndexOf(series, timezone, doc);
    if (index >= 0 && !byIndex.has(index)) byIndex.set(index, doc);
  }
  return byIndex;
}

export async function materializeRecurrenceSeries(orgId: string, source: JsonObject, options: { horizonDays?: number; occurrences?: JsonObject[]; timezone?: string } = {}) {
  const series = { ...source };
  if (cleanText(series.status || "active") !== "active") return { series, occurrences: [] as JsonObject[] };
  const timezone = options.timezone || await seriesTimezone(orgId, series);
  const rule = recurrenceRule(series);
  const anchor = dateOrThrow(series.start_at, "Start date");
  const endAt = rule.end_at ? dateOrThrow(rule.end_at, "End date") : null;
  const horizon = new Date(Date.now() + Math.max(30, Math.min(730, Math.round(options.horizonDays ?? 180))) * 86_400_000);
  const docs = options.occurrences ?? await seriesOccurrenceDocs(orgId, cleanText(series.id));
  const byIndex = indexOccurrences(docs, series, timezone);
  const knownIds = new Set(docs.map((doc) => cleanText(doc.id)));
  const occurrences: JsonObject[] = [];
  for (let index = 0; index < MAX_OCCURRENCES; index += 1) {
    if (rule.occurrence_count && index >= rule.occurrence_count) break;
    const startsAt = occurrenceDate(anchor, rule, index, timezone);
    if (endAt && startsAt > endAt) break;
    if (startsAt > horizon) break;
    // Existing occurrences (including individually moved, edited, skipped or
    // deleted ones) are exceptions owned by the occurrence: never regenerate them.
    const existing = byIndex.get(index);
    if (existing) { occurrences.push(existing); continue; }
    let key = occurrenceKey(startsAt);
    if (knownIds.has(stableId("recurrence_occurrence", `${cleanText(series.id)}:${key}`))) key = `${key}i${index}`;
    const occurrenceId = stableId("recurrence_occurrence", `${cleanText(series.id)}:${key}`);
    const savedEvent = await saveProjectEvent(orgId, series, eventForOccurrence(series, startsAt, key, timezone));
    const occurrence = {
      schema_version: 1, id: occurrenceId, organization_id: orgId, recurrence_series_id: cleanText(series.id), project_id: cleanText(series.project_id), occurrence_key: key,
      occurrence_index: index, starts_at: startsAt.toISOString(), ends_at: cleanText(savedEvent.end_at), status: "scheduled", event_id: cleanText(savedEvent.id), event: savedEvent,
      created_at: nowIso(), updated_at: nowIso()
    };
    const doc = await upsertDocument(orgId, OCCURRENCE_COLLECTION, { id: occurrenceId, data: occurrence, metadata: { kind: "recurrence_occurrence", project_id: cleanText(series.project_id), recurrence_series_id: cleanText(series.id) } }, { replace: true });
    knownIds.add(occurrenceId);
    occurrences.push(dataView(doc));
    await ensureRecurringFinance(orgId, series, startsAt, key, timezone);
  }
  return { series, occurrences };
}

export async function createRecurrenceSeries(orgId: string, input: JsonObject, actorUserId = "") {
  const startAt = dateOrThrow(input.start_at || input.startAt, "Start date");
  const projectId = cleanText(input.project_id || input.projectId);
  if (projectId) await readDocument(orgId, "projects", projectId);
  const rule = recurrenceRule(input);
  const branchId = cleanText(input.branch_id || input.branchId || "default") || "default";
  const timezone = safeTimezone(input.timezone, "") || await resolveOrganizationTimezone(orgId, branchId).catch(() => "UTC");
  const id = cleanText(input.id) || stableId("recurrence_series", `${orgId}:${projectId}:${cleanText(input.title)}:${startAt.toISOString()}:${Math.random()}`);
  const now = nowIso();
  const series = {
    schema_version: 1, id, organization_id: orgId, branch_id: branchId, project_id: projectId,
    title: cleanText(input.title || "Recurring appointment"), status: "active", timezone, start_at: startAt.toISOString(), recurrence: rule,
    event_template: asObject(input.event_template || input.event || input.template), billing: asObject(input.billing), expenses: asObject(input.expenses), scope_piece_id: cleanText(input.scope_piece_id), scope_template_id: cleanText(input.scope_template_id),
    created_by_user_id: actorUserId, updated_by_user_id: actorUserId, created_at: now, updated_at: now
  };
  const doc = await upsertDocument(orgId, SERIES_COLLECTION, { id, data: series, metadata: { kind: "recurrence_series", project_id: projectId, status: "active" } }, { replace: true });
  const saved = dataView(doc);
  await emitWorkEvent({
    organization_id: orgId,
    branch_id: cleanText(series.branch_id) || "default",
    ...(projectId ? { project_id: projectId } : {}),
    type: "recurrence.series.created",
    idempotency_key: `recurrence.series.created:${id}`,
    payload: {
      series_id: id,
      ...(projectId ? { project_id: projectId } : {}),
      title: cleanText(series.title),
      frequency: cleanText(asObject(series.recurrence).frequency)
    },
    context: { actor_user_id: actorUserId }
  });
  const generated = await materializeRecurrenceSeries(orgId, saved, { timezone, occurrences: [] });
  return { series: saved, occurrences: generated.occurrences };
}

export async function listRecurrenceSeries(orgId: string, options: JsonObject = {}) {
  const projectId = cleanText(options.project_id || options.projectId);
  const includeCancelled = options.include_cancelled === true || options.includeCancelled === true || cleanText(options.include_cancelled) === "1" || cleanText(options.include_cancelled) === "true";
  const series = (await listDocuments(orgId, SERIES_COLLECTION)).map(dataView)
    .filter((item) => !projectId || cleanText(item.project_id) === projectId)
    .filter((item) => includeCancelled || cleanText(item.status) === "active");
  const occurrences = (await listDocuments(orgId, OCCURRENCE_COLLECTION)).map(dataView);
  // Sequential: series of one project share the project document.
  for (const item of series) {
    await materializeRecurrenceSeries(orgId, item, { occurrences: occurrences.filter((entry) => cleanText(entry.recurrence_series_id) === cleanText(item.id)) }).catch(() => null);
  }
  return series;
}

export async function listRecurrenceOccurrences(orgId: string, seriesId: string, options: JsonObject = {}) {
  const from = cleanText(options.from);
  const to = cleanText(options.to);
  return (await listDocuments(orgId, OCCURRENCE_COLLECTION)).map(dataView)
    .filter((item) => cleanText(item.recurrence_series_id) === seriesId)
    .filter((item) => !from || cleanText(item.starts_at) >= from)
    .filter((item) => !to || cleanText(item.starts_at) <= to)
    .sort((left, right) => cleanText(left.starts_at).localeCompare(cleanText(right.starts_at)));
}

const NON_CONTENT_KEYS = new Set([
  "id", "created_at", "updated_at", "status", "completed_at", "revision",
  "recurrence_series_id", "recurrence_occurrence_key", "recurrence_occurrence_status", "recurrence", "recurring",
  "start_at", "end_at", "start", "end", "duration_minutes"
]);

function canonical(value: unknown): unknown {
  if (value === undefined || value === null || value === "") return null;
  if (Array.isArray(value)) return value.length ? value.map(canonical) : null;
  if (typeof value === "object") {
    const entries = Object.entries(value as JsonObject)
      .map(([key, entry]) => [key, canonical(entry)] as const)
      .filter(([, entry]) => entry !== null)
      .sort(([left], [right]) => left.localeCompare(right));
    return entries.length ? Object.fromEntries(entries) : null;
  }
  return value;
}

function sameValue(left: unknown, right: unknown) {
  return JSON.stringify(canonical(left)) === JSON.stringify(canonical(right));
}

function sameInstant(left: unknown, right: unknown) {
  const a = Date.parse(cleanText(left));
  const b = Date.parse(cleanText(right));
  return Number.isFinite(a) && Number.isFinite(b) && Math.abs(a - b) < 1000;
}

function setEventTimes(event: JsonObject, start: string, end: string) {
  event.start_at = start;
  event.end_at = end;
  event.duration_minutes = Math.max(1, Math.round((Date.parse(end) - Date.parse(start)) / 60_000));
  if (has(event, "start")) event.start = start;
  if (has(event, "end")) event.end = end;
}

/**
 * Three-way merge of a template change into one concrete occurrence: a field
 * still equal to what the old template produced takes the new template value;
 * a field the occurrence changed on its own (title, crew, a moved time, ...)
 * is an exception and is kept.
 */
function mergeOccurrenceEvent(current: JsonObject, expected: JsonObject, expectedTimes: Array<[string, string]>, target: JsonObject, forced: { start?: string; end?: string } | null) {
  const merged: JsonObject = { ...current };
  const keys = new Set([...Object.keys(expected), ...Object.keys(target)].filter((key) => !NON_CONTENT_KEYS.has(key)));
  for (const key of keys) {
    if (!forced && !sameValue(current[key], expected[key])) continue;
    if (target[key] === undefined) delete merged[key];
    else merged[key] = target[key];
  }
  const currentStart = current.start_at ?? current.start;
  const currentEnd = current.end_at ?? current.end;
  const timeUntouched = expectedTimes.some(([start, end]) => sameInstant(currentStart, start) && sameInstant(currentEnd, end));
  if (forced?.start && forced.end) setEventTimes(merged, forced.start, forced.end);
  else if (timeUntouched) setEventTimes(merged, cleanText(target.start_at), cleanText(target.end_at));
  merged.recurrence_series_id = target.recurrence_series_id;
  merged.recurrence_occurrence_key = target.recurrence_occurrence_key;
  merged.recurrence = target.recurrence;
  merged.recurring = true;
  return merged;
}

function withoutTimestamps(event: JsonObject) {
  const { updated_at: _updated, revision: _revision, ...rest } = event;
  return rest;
}

type OccurrenceEntry = { index: number; doc: JsonObject };
type ForcedEdit = { index: number; start?: string; end?: string } | null;

/**
 * Moves occurrences (slot `index` of `from`) onto slot `index - offset` of
 * `to` (the same series for "all events", a new one for "this and following"),
 * merging the template change into each concrete event while preserving
 * per-occurrence exceptions: moves, edits, completions, skips and deletions.
 */
async function transferOccurrences(orgId: string, from: JsonObject, to: JsonObject, entries: OccurrenceEntry[], offset: number, timezone: string, concrete: Map<string, JsonObject>, forced: ForcedEdit) {
  const sameSeries = cleanText(from.id) === cleanText(to.id);
  const fromAnchor = dateOrThrow(from.start_at, "Start date");
  const fromRule = recurrenceRule(from);
  const toAnchor = dateOrThrow(to.start_at, "Start date");
  const toRule = recurrenceRule(to);
  const toEnd = toRule.end_at ? dateOrThrow(toRule.end_at, "End date") : null;
  const now = Date.now();
  const upserts: JsonObject[] = [];
  const removals: string[] = [];
  const retiredKeys = new Set<string>();
  const financeToCreate: Array<{ start: Date; key: string }> = [];
  for (const { index, doc } of entries) {
    const slot = index - offset;
    const originalStart = occurrenceDate(fromAnchor, fromRule, index, timezone);
    const legacyStart = legacyOccurrenceDate(fromAnchor, fromRule, index);
    const oldKey = cleanText(doc.occurrence_key) || occurrenceKey(originalStart);
    const expected = eventForOccurrence(from, originalStart, oldKey, timezone);
    const expectedLength = Date.parse(cleanText(expected.end_at)) - Date.parse(cleanText(expected.start_at));
    const expectedTimes: Array<[string, string]> = [
      [cleanText(expected.start_at), cleanText(expected.end_at)],
      [legacyStart.toISOString(), new Date(legacyStart.getTime() + expectedLength).toISOString()]
    ];
    const status = cleanText(doc.status) || "scheduled";
    const eventId = cleanText(doc.event_id);
    const current = concrete.get(eventId) || null;
    const nextStart = occurrenceDate(toAnchor, toRule, slot, timezone);
    const inBounds = slot >= 0 && slot < MAX_OCCURRENCES
      && (!toRule.occurrence_count || slot < toRule.occurrence_count)
      && (!toEnd || nextStart <= toEnd);
    const concreteStart = Date.parse(cleanText(current?.start_at ?? current?.start ?? doc.starts_at));
    if (!inBounds) {
      // The series got shorter: history stays, upcoming visits go away.
      if (status === "completed" || concreteStart < now) continue;
      if (current) removals.push(eventId);
      await deleteDocument(orgId, OCCURRENCE_COLLECTION, cleanText(doc.id)).catch(() => null);
      retiredKeys.add(oldKey);
      continue;
    }
    const nextKey = sameSeries ? oldKey : occurrenceKey(nextStart);
    const target = eventForOccurrence(to, nextStart, nextKey, timezone);
    const concreteStatus = cleanText(current?.status).toLowerCase();
    let nextStatus = status;
    let event: JsonObject;
    if (!current) {
      // Deleted (or skipped) on its own: remember it so no later series edit brings it back.
      if (!["completed", "skipped"].includes(nextStatus)) nextStatus = "cancelled";
      event = { ...asObject(doc.event), status: "cancelled", recurrence_series_id: cleanText(to.id), recurrence_occurrence_key: nextKey, recurrence: target.recurrence };
    } else if (["completed", "skipped", "cancelled"].includes(status) || ["completed", "cancelled", "canceled"].includes(concreteStatus)) {
      if (status === "scheduled") nextStatus = concreteStatus === "completed" ? "completed" : "cancelled";
      event = { ...current, recurrence_series_id: cleanText(to.id), recurrence_occurrence_key: nextKey, recurrence: target.recurrence, recurring: true };
    } else {
      const edit = forced && forced.index === index ? { start: forced.start, end: forced.end } : null;
      event = mergeOccurrenceEvent(current, expected, expectedTimes, target, edit);
    }
    if (current && !sameValue(withoutTimestamps(event), withoutTimestamps(current))) {
      event.updated_at = nowIso();
      upserts.push(event);
    }
    const occurrenceId = sameSeries ? cleanText(doc.id) : stableId("recurrence_occurrence", `${cleanText(to.id)}:${nextKey}`);
    const occurrence = {
      ...doc,
      id: occurrenceId, recurrence_series_id: cleanText(to.id), project_id: cleanText(to.project_id), occurrence_key: nextKey, occurrence_index: slot,
      starts_at: nextStart.toISOString(), ends_at: cleanText(event.end_at), status: nextStatus, event_id: eventId, event,
      created_at: sameSeries ? cleanText(doc.created_at || nowIso()) : nowIso(), updated_at: nowIso()
    };
    await upsertDocument(orgId, OCCURRENCE_COLLECTION, { id: occurrenceId, data: occurrence, metadata: { kind: "recurrence_occurrence", project_id: cleanText(to.project_id), recurrence_series_id: cleanText(to.id) } }, { replace: true });
    if (!sameSeries) {
      await deleteDocument(orgId, OCCURRENCE_COLLECTION, cleanText(doc.id)).catch(() => null);
      retiredKeys.add(oldKey);
      if (nextStatus === "scheduled") financeToCreate.push({ start: nextStart, key: nextKey });
    }
  }
  await writeConcreteEvents(orgId, to.project_id, upserts, removals);
  if (retiredKeys.size) await voidSeriesFinance(orgId, cleanText(from.id), { keys: retiredKeys });
  for (const item of financeToCreate) await ensureRecurringFinance(orgId, to, item.start, item.key, timezone);
}

async function refreshUpcomingFinance(orgId: string, series: JsonObject, timezone: string) {
  const now = nowIso();
  const docs = await seriesOccurrenceDocs(orgId, cleanText(series.id));
  const upcoming = docs.filter((doc) => cleanText(doc.starts_at) >= now && cleanText(doc.status) === "scheduled");
  await voidSeriesFinance(orgId, cleanText(series.id), { dueFrom: now });
  for (const doc of upcoming) await ensureRecurringFinance(orgId, series, dateOrThrow(doc.starts_at, "Occurrence"), cleanText(doc.occurrence_key), timezone);
}

const PATCH_CONTROL_KEYS = ["scope", "occurrence_id", "occurrence_key", "event_id", "occurrence_start_at", "occurrence_end_at"];

function patchScope(value: unknown) {
  const scope = cleanText(value).toLowerCase().replace(/[\s-]+/g, "_");
  return ["following", "this_and_following", "future"].includes(scope) ? "following" : "all";
}

/**
 * Edits a series.
 * - scope "all" (default): changes the template (and optionally the cadence)
 *   without moving the anchor unless a time change is carried by the edited
 *   occurrence (`occurrence_start_at`) or `start_at` is given without an
 *   occurrence; the total count stays unless `recurrence.occurrence_count`
 *   changes it. Per-occurrence exceptions are kept.
 * - scope "following" + an occurrence (`occurrence_id`, `event_id` or
 *   `occurrence_key`): ends this series before that occurrence and starts a
 *   new series from it with the remaining count or the same end date.
 * "This event" edits are ordinary event saves; they become exceptions.
 */
export async function patchRecurrenceSeries(orgId: string, seriesId: string, patchInput: JsonObject, actorUserId = "") {
  const doc = await readDocument(orgId, SERIES_COLLECTION, seriesId).catch(() => { throw notFound("recurrence_series_not_found", "Recurring series was not found."); });
  const current = dataView(doc);
  const patch = { ...asObject(patchInput) };
  const control: JsonObject = {};
  for (const key of PATCH_CONTROL_KEYS) { if (has(patch, key)) control[key] = patch[key]; delete patch[key]; }
  const scope = patchScope(control.scope);
  const timezone = await seriesTimezone(orgId, current);
  const nextStatus = cleanText(patch.status ?? current.status ?? "active") || "active";
  const currentTemplate = asObject(current.event_template);
  const templatePatch = has(patch, "event_template") || has(patch, "event") ? asObject(patch.event_template || patch.event) : {};
  delete patch.event;
  const nextTemplate: JsonObject = { ...currentTemplate, ...templatePatch };
  const base: JsonObject = {
    ...current,
    ...patch,
    id: cleanText(current.id), organization_id: orgId, project_id: cleanText(current.project_id), timezone,
    recurrence: mergedRecurrenceRule(current, patch),
    event_template: nextTemplate,
    billing: has(patch, "billing") ? asObject(patch.billing) : asObject(current.billing),
    expenses: has(patch, "expenses") ? asObject(patch.expenses) : asObject(current.expenses),
    status: nextStatus,
    updated_by_user_id: actorUserId, updated_at: nowIso()
  };
  // Recurrence settings live under `recurrence` only; stray top-level aliases would shadow it.
  for (const key of ["frequency", "interval", "occurrence_count", "end_at", "endAt"]) delete base[key];
  if (nextStatus !== "active") {
    const saved = dataView(await upsertDocument(orgId, SERIES_COLLECTION, { id: seriesId, data: base, metadata: { ...asObject(doc.metadata), status: nextStatus } }, { replace: true }));
    return { series: saved, occurrences: [] as JsonObject[] };
  }

  const docs = await seriesOccurrenceDocs(orgId, seriesId);
  const indexed = indexOccurrences(docs, current, timezone);
  const entries = [...indexed.entries()].map(([index, entry]) => ({ index, doc: entry })).sort((left, right) => left.index - right.index);
  const concrete = await loadConcreteEvents(orgId, current);
  const reference = cleanText(control.occurrence_id || control.event_id || control.occurrence_key);
  let targetIndex = -1;
  if (reference) {
    const match = entries.find((entry) => [cleanText(entry.doc.id), cleanText(entry.doc.event_id), cleanText(entry.doc.occurrence_key)].includes(reference));
    if (!match) throw notFound("recurrence_occurrence_not_found", "Recurring occurrence was not found.");
    targetIndex = match.index;
  }
  if (scope === "following" && targetIndex < 0) throw badRequest("recurrence_occurrence_required", "Choose the occurrence the change starts from.");

  // A time or length change made on the edited occurrence applies as a
  // wall-clock shift, measured from that occurrence's stored time so an
  // occurrence that was already moved on its own does not drag the series.
  let shiftMinutes = 0;
  let forced: ForcedEdit = null;
  if (targetIndex >= 0) {
    const targetDoc = indexed.get(targetIndex) as JsonObject;
    const stored = concrete.get(cleanText(targetDoc.event_id)) || asObject(targetDoc.event);
    const storedStart = Date.parse(cleanText(stored.start_at ?? stored.start));
    const storedEnd = Date.parse(cleanText(stored.end_at ?? stored.end));
    const editedStart = Date.parse(cleanText(control.occurrence_start_at));
    const editedEnd = Date.parse(cleanText(control.occurrence_end_at));
    forced = { index: targetIndex };
    if (Number.isFinite(editedStart) && Number.isFinite(storedStart)) {
      shiftMinutes = Math.round((wallClockMs(new Date(editedStart), timezone) - wallClockMs(new Date(storedStart), timezone)) / 60_000);
      const storedLength = Number.isFinite(storedEnd) && storedEnd > storedStart ? (storedEnd - storedStart) / 60_000 : templateDuration(currentTemplate);
      const editedLength = Number.isFinite(editedEnd) && editedEnd > editedStart ? (editedEnd - editedStart) / 60_000 : storedLength;
      nextTemplate.duration_minutes = Math.max(1, Math.round(templateDuration(currentTemplate) + editedLength - storedLength));
      forced = { index: targetIndex, start: new Date(editedStart).toISOString(), end: new Date(editedStart + editedLength * 60_000).toISOString() };
    }
  }
  const currentAnchor = dateOrThrow(current.start_at, "Start date");

  if (scope === "following" && targetIndex > 0) {
    const currentRule = recurrenceRule(current);
    const nextRule = recurrenceRule(base);
    const splitStart = occurrenceDate(currentAnchor, currentRule, targetIndex, timezone);
    const followingId = stableId("recurrence_series", `${seriesId}:following:${targetIndex}:${nowIso()}:${Math.random()}`);
    const truncatedRule = currentRule.occurrence_count
      ? { ...currentRule, occurrence_count: targetIndex }
      : { ...currentRule, end_at: new Date(splitStart.getTime() - 1000).toISOString() };
    const previous = dataView(await upsertDocument(orgId, SERIES_COLLECTION, {
      id: seriesId,
      data: { ...current, timezone, recurrence: truncatedRule, split_into_series_id: followingId, updated_by_user_id: actorUserId, updated_at: nowIso() },
      metadata: asObject(doc.metadata)
    }, { replace: true }));
    const followingRule = { ...nextRule, occurrence_count: nextRule.occurrence_count ? Math.max(1, nextRule.occurrence_count - targetIndex) : null };
    const following = {
      ...base,
      id: followingId, status: "active", start_at: shiftWallClock(splitStart, shiftMinutes, timezone).toISOString(), recurrence: followingRule,
      split_from_series_id: seriesId, split_into_series_id: "", created_by_user_id: actorUserId, created_at: nowIso()
    };
    const savedFollowing = dataView(await upsertDocument(orgId, SERIES_COLLECTION, { id: followingId, data: following, metadata: { kind: "recurrence_series", project_id: cleanText(current.project_id), status: "active" } }, { replace: true }));
    await emitWorkEvent({
      organization_id: orgId,
      branch_id: cleanText(savedFollowing.branch_id) || "default",
      ...(cleanText(current.project_id) ? { project_id: cleanText(current.project_id) } : {}),
      type: "recurrence.series.created",
      idempotency_key: `recurrence.series.created:${followingId}`,
      payload: { series_id: followingId, ...(cleanText(current.project_id) ? { project_id: cleanText(current.project_id) } : {}), title: cleanText(savedFollowing.title), frequency: cleanText(followingRule.frequency) },
      context: { actor_user_id: actorUserId }
    });
    await transferOccurrences(orgId, current, previous, entries.filter((entry) => entry.index < targetIndex), 0, timezone, concrete, null);
    await transferOccurrences(orgId, current, savedFollowing, entries.filter((entry) => entry.index >= targetIndex), targetIndex, timezone, concrete, forced);
    const generated = await materializeRecurrenceSeries(orgId, savedFollowing, { timezone });
    return { series: savedFollowing, previous_series: previous, occurrences: generated.occurrences };
  }

  const explicitAnchor = targetIndex < 0 && has(patch, "start_at") ? dateOrThrow(patch.start_at, "Start date") : null;
  const next = { ...base, start_at: (explicitAnchor || shiftWallClock(currentAnchor, shiftMinutes, timezone)).toISOString() };
  const saved = dataView(await upsertDocument(orgId, SERIES_COLLECTION, { id: seriesId, data: next, metadata: { ...asObject(doc.metadata), status: "active" } }, { replace: true }));
  await transferOccurrences(orgId, current, saved, entries, 0, timezone, concrete, forced);
  const cadenceChanged = !sameInstant(current.start_at, saved.start_at) || !sameValue(recurrenceRule(current), recurrenceRule(saved));
  if (cadenceChanged || !sameValue(current.billing, saved.billing) || !sameValue(current.expenses, saved.expenses)) {
    await refreshUpcomingFinance(orgId, saved, timezone);
  }
  const generated = await materializeRecurrenceSeries(orgId, saved, { timezone });
  return { series: saved, occurrences: generated.occurrences };
}

async function findOccurrenceDoc(orgId: string, seriesId: string, reference: string) {
  const direct = await readDocument(orgId, OCCURRENCE_COLLECTION, reference).catch(() => null);
  if (direct && cleanText(asObject(direct.data).recurrence_series_id) === seriesId) return direct;
  // Calendars know the event, not the occurrence document: accept its id or occurrence key too.
  return (await listDocuments(orgId, OCCURRENCE_COLLECTION)).find((entry) => {
    const data = asObject(entry.data);
    return cleanText(data.recurrence_series_id) === seriesId
      && (cleanText(data.event_id) === reference || cleanText(data.occurrence_key) === reference);
  }) || null;
}

export async function setRecurrenceOccurrenceStatus(orgId: string, seriesId: string, occurrenceRef: string, status: OccurrenceStatusAction, actorUserId = "") {
  const doc = await findOccurrenceDoc(orgId, seriesId, occurrenceRef);
  if (!doc) throw notFound("recurrence_occurrence_not_found", "Recurring occurrence was not found.");
  const occurrence = dataView(doc);
  const occurrenceId = cleanText(occurrence.id);
  const series = dataView(await readDocument(orgId, SERIES_COLLECTION, seriesId));
  // Start from the stored event so an earlier move or edit of this occurrence survives.
  const concrete = (await loadConcreteEvents(orgId, series)).get(cleanText(occurrence.event_id)) || null;
  const base = concrete || asObject(occurrence.event);
  // A skipped visit leaves the calendar like a cancelled one; the occurrence keeps "skipped".
  const eventStatus = status === "skipped" ? "cancelled" : status;
  const event: JsonObject = { ...base, status: eventStatus, completed_at: status === "completed" ? nowIso() : "", updated_at: nowIso() };
  if (status === "skipped") event.recurrence_occurrence_status = "skipped";
  else delete event.recurrence_occurrence_status;
  // Calendars show every stored floating calendar event, so a skipped or
  // cancelled floating occurrence leaves the collection; its occurrence keeps
  // the snapshot and "scheduled" restores it.
  const floating = !cleanText(series.project_id);
  if (floating && (status === "skipped" || status === "cancelled")) {
    if (concrete) await writeConcreteEvents(orgId, "", [], [cleanText(occurrence.event_id)]);
  } else if (concrete || status === "scheduled" || status === "completed") {
    await writeConcreteEvents(orgId, series.project_id, [event]);
  }
  const next = { ...occurrence, status, event, updated_by_user_id: actorUserId, updated_at: nowIso() };
  const savedOccurrence = dataView(await upsertDocument(orgId, OCCURRENCE_COLLECTION, { id: occurrenceId, data: next, metadata: asObject(doc.metadata) }, { replace: true }));
  if (status === "completed" || status === "skipped") {
    const occurrenceProjectId = cleanText(occurrence.project_id || series.project_id);
    await emitWorkEvent({
      organization_id: orgId,
      branch_id: cleanText(series.branch_id) || "default",
      ...(occurrenceProjectId ? { project_id: occurrenceProjectId } : {}),
      type: `recurrence.occurrence.${status}`,
      idempotency_key: `recurrence.occurrence.${status}:${occurrenceId}`,
      payload: {
        occurrence_id: occurrenceId,
        series_id: seriesId,
        ...(occurrenceProjectId ? { project_id: occurrenceProjectId } : {}),
        event_id: cleanText(occurrence.event_id),
        starts_at: cleanText(occurrence.starts_at),
        title: cleanText(series.title)
      },
      context: { actor_user_id: actorUserId }
    });
  }
  return savedOccurrence;
}

/**
 * Records that one occurrence's calendar event was deleted on its own, so the
 * series treats it as a cancelled exception instead of recreating it.
 */
export async function recordRecurrenceEventRemoved(orgId: string, eventValue: unknown) {
  const event = asObject(eventValue);
  const seriesId = cleanText(event.recurrence_series_id);
  const eventId = cleanText(event.id);
  if (!seriesId || !eventId) return null;
  const match = (await listDocuments(orgId, OCCURRENCE_COLLECTION)).find((entry) => {
    const data = asObject(entry.data);
    return cleanText(data.recurrence_series_id) === seriesId && cleanText(data.event_id) === eventId;
  });
  if (!match) return null;
  const occurrence = dataView(match);
  if (cleanText(occurrence.status) === "completed") return occurrence;
  return dataView(await upsertDocument(orgId, OCCURRENCE_COLLECTION, {
    id: cleanText(occurrence.id),
    data: { ...occurrence, status: "cancelled", removed_at: nowIso(), event: { ...asObject(occurrence.event), ...event, status: "cancelled" }, updated_at: nowIso() },
    metadata: asObject(match.metadata)
  }, { replace: true }));
}

export async function cancelRecurrenceSeries(orgId: string, seriesId: string, actorUserId = "") {
  const result = await patchRecurrenceSeries(orgId, seriesId, { status: "cancelled" }, actorUserId);
  const canceledProjectId = cleanText(result.series.project_id);
  await emitWorkEvent({
    organization_id: orgId,
    branch_id: cleanText(result.series.branch_id) || "default",
    ...(canceledProjectId ? { project_id: canceledProjectId } : {}),
    type: "recurrence.series.canceled",
    idempotency_key: `recurrence.series.canceled:${seriesId}`,
    payload: {
      series_id: seriesId,
      ...(canceledProjectId ? { project_id: canceledProjectId } : {}),
      title: cleanText(result.series.title)
    },
    context: { actor_user_id: actorUserId }
  });
  const now = nowIso();
  const future = (await listRecurrenceOccurrences(orgId, seriesId)).filter((item) => cleanText(item.starts_at) >= now && ["scheduled", "unscheduled"].includes(cleanText(item.status)));
  for (const occurrence of future) await setRecurrenceOccurrenceStatus(orgId, seriesId, cleanText(occurrence.id), "cancelled", actorUserId);
  await voidSeriesFinance(orgId, seriesId, { dueFrom: now });
  return result.series;
}

export async function recurringMoneySummary(orgId: string, projectId: string) {
  const series = await listRecurrenceSeries(orgId, { project_id: projectId, include_cancelled: true });
  const zones = await Promise.all(series.map((item) => seriesTimezone(orgId, item)));
  const [occurrences, obligations, payables] = await Promise.all([
    listDocuments(orgId, OCCURRENCE_COLLECTION), listDocuments(orgId, PAYMENT_OBLIGATION_COLLECTION), listDocuments(orgId, PAYMENT_PAYABLE_COLLECTION)
  ]);
  const relatedOccurrences = occurrences.map(dataView).filter((item) => cleanText(item.project_id) === projectId && !!cleanText(item.recurrence_series_id));
  const relatedObligations = obligations.map(dataView).filter((item) => cleanText(item.project_id) === projectId && !!cleanText(item.recurrence_series_id));
  const relatedPayables = payables.map(dataView).filter((item) => cleanText(item.project_id) === projectId && !!cleanText(item.recurrence_series_id));
  const next = relatedOccurrences.filter((item) => cleanText(item.status) === "scheduled" && cleanText(item.starts_at) >= nowIso()).sort((a, b) => cleanText(a.starts_at).localeCompare(cleanText(b.starts_at)))[0] || null;
  const revenueToDate = relatedObligations.reduce((sum, item) => sum + Math.max(0, Math.round(number(item.allocated_cents))), 0);
  const billedToDate = relatedObligations.reduce((sum, item) => sum + Math.max(0, Math.round(number(item.amount_cents))), 0);
  const expenseToDate = relatedPayables.reduce((sum, item) => sum + Math.max(0, Math.round(number(item.paid_cents))), 0);
  const seriesSummary = series.map((item, seriesIndex) => {
    const id = cleanText(item.id);
    const timezone = zones[seriesIndex] || "UTC";
    const seriesOccurrences = relatedOccurrences.filter((entry) => cleanText(entry.recurrence_series_id) === id);
    const seriesObligations = relatedObligations.filter((entry) => cleanText(entry.recurrence_series_id) === id);
    const seriesPayables = relatedPayables.filter((entry) => cleanText(entry.recurrence_series_id) === id);
    const finiteEnd = finiteSeriesEnd(item, timezone);
    const finite = !!finiteEnd;
    const obligationTotal = seriesObligations.reduce((sum, entry) => sum + Math.max(0, Math.round(number(entry.amount_cents))), 0);
    const expenseTotal = seriesPayables.reduce((sum, entry) => sum + Math.max(0, Math.round(number(entry.amount_cents))), 0);
    const collected = seriesObligations.reduce((sum, entry) => sum + Math.max(0, Math.round(number(entry.allocated_cents))), 0);
    const paidExpenses = seriesPayables.reduce((sum, entry) => sum + Math.max(0, Math.round(number(entry.paid_cents))), 0);
    const nextItem = seriesOccurrences.filter((entry) => cleanText(entry.status) === "scheduled" && cleanText(entry.starts_at) >= nowIso()).sort((a, b) => cleanText(a.starts_at).localeCompare(cleanText(b.starts_at)))[0] || null;
    const eventRule = recurrenceRule(item);
    const billing = asObject(item.billing);
    const expenses = asObject(item.expenses);
    const eventCount = finiteEnd ? occurrenceCountThrough(dateOrThrow(item.start_at, "Start date"), eventRule, finiteEnd, timezone) : 0;
    const billingRule = recurrenceRule({ recurrence: { ...asObject(billing.recurrence), frequency: billing.frequency || eventRule.frequency, interval: billing.interval || eventRule.interval } });
    const billingCount = finiteEnd ? occurrenceCountThrough(dateOrThrow(billing.anchor_at || billing.anchorAt || item.start_at, "Billing anchor"), billingRule, finiteEnd, timezone) : 0;
    const plannedRevenue = billing.enabled === true ? Math.max(0, Math.round(number(billing.amount_cents, number(billing.amount) * 100))) * billingCount : 0;
    const plannedExpense = expenses.enabled === true ? Math.max(0, Math.round(number(expenses.amount_cents, number(expenses.amount) * 100))) * eventCount : 0;
    return {
      ...item,
      past_instances: seriesOccurrences.filter((entry) => cleanText(entry.starts_at) < nowIso()).length,
      total_instances: seriesOccurrences.length,
      next_occurrence: nextItem,
      billed_to_date_cents: obligationTotal,
      revenue_to_date_cents: collected,
      expenses_to_date_cents: paidExpenses,
      projected_expenses_cents: expenseTotal,
      profit_to_date_cents: collected - paidExpenses,
      total_contract_value_cents: finite ? plannedRevenue : null,
      forecast_profit_cents: finite ? plannedRevenue - plannedExpense : null
    };
  });
  return { series: seriesSummary, past_instances: relatedOccurrences.filter((item) => cleanText(item.starts_at) < nowIso()).length, total_instances: relatedOccurrences.length, next_occurrence: next, billed_to_date_cents: billedToDate, revenue_to_date_cents: revenueToDate, expenses_to_date_cents: expenseToDate, profit_to_date_cents: revenueToDate - expenseToDate };
}
