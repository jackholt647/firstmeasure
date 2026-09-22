import { createHash } from "node:crypto";

import { badRequest, notFound } from "./errors.js";
import { deleteDocument, listDocuments, readDocument, upsertDocument, type JsonObject } from "./storage.js";
import { emitWorkEvent } from "../work/engine.js";

const SERIES_COLLECTION = "recurrence_series";
const OCCURRENCE_COLLECTION = "recurrence_occurrences";
const PAYMENT_SCHEDULE_COLLECTION = "payment_schedules";
const PAYMENT_OBLIGATION_COLLECTION = "payment_obligations";
const PAYMENT_PAYABLE_COLLECTION = "payment_payables";

type Frequency = "daily" | "weekly" | "monthly" | "quarterly" | "yearly";

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

function recurrenceRule(input: JsonObject) {
  const raw = asObject(input.recurrence);
  return {
    frequency: frequency(raw.frequency || input.frequency),
    interval: Math.max(1, Math.min(120, Math.round(number(raw.interval ?? input.interval, 1)))),
    end_at: cleanText(raw.end_at || raw.endAt || input.end_at || input.endAt),
    occurrence_count: Math.max(0, Math.round(number(raw.occurrence_count ?? raw.count ?? input.occurrence_count, 0))) || null
  };
}

function dateOrThrow(value: unknown, label: string) {
  const date = new Date(cleanText(value));
  if (!Number.isFinite(date.getTime())) throw badRequest("invalid_recurrence_date", `${label} must be a valid ISO date/time.`);
  return date;
}

function daysInMonth(year: number, month: number) {
  return new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
}

function addMonths(date: Date, months: number) {
  const copy = new Date(date.getTime());
  const wantedDay = copy.getUTCDate();
  copy.setUTCDate(1);
  copy.setUTCMonth(copy.getUTCMonth() + months);
  copy.setUTCDate(Math.min(wantedDay, daysInMonth(copy.getUTCFullYear(), copy.getUTCMonth())));
  return copy;
}

function occurrenceDate(anchor: Date, rule: ReturnType<typeof recurrenceRule>, index: number) {
  const step = Math.max(0, index) * rule.interval;
  if (rule.frequency === "daily") return new Date(anchor.getTime() + step * 86_400_000);
  if (rule.frequency === "weekly") return new Date(anchor.getTime() + step * 7 * 86_400_000);
  if (rule.frequency === "quarterly") return addMonths(anchor, step * 3);
  if (rule.frequency === "yearly") return addMonths(anchor, step * 12);
  return addMonths(anchor, step);
}

function occurrenceKey(date: Date) {
  return date.toISOString().replace(/[.:-]/g, "").replace("Z", "z");
}

function finiteSeriesEnd(series: JsonObject) {
  const rule = recurrenceRule(series);
  if (rule.end_at) return dateOrThrow(rule.end_at, "End date");
  if (rule.occurrence_count) return occurrenceDate(dateOrThrow(series.start_at, "Start date"), rule, rule.occurrence_count - 1);
  return null;
}

function occurrenceCountThrough(anchor: Date, rule: ReturnType<typeof recurrenceRule>, end: Date) {
  let count = 0;
  for (let index = 0; index < 10_000; index += 1) {
    if (rule.occurrence_count && index >= rule.occurrence_count) break;
    const occurrence = occurrenceDate(anchor, rule, index);
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

function eventForOccurrence(series: JsonObject, start: Date, key: string) {
  const template = asObject(series.event_template);
  const duration = Math.max(1, Math.round(number(template.duration_minutes || template.duration, 60)));
  const end = new Date(start.getTime() + duration * 60_000);
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
    recurrence_series_id: cleanText(series.id),
    recurrence_occurrence_key: key,
    recurrence: asObject(series.recurrence),
    scope_piece_id: cleanText(series.scope_piece_id || template.scope_piece_id),
    scope_template_id: cleanText(series.scope_template_id || template.scope_template_id),
    recurring: true,
    created_at: nowIso(),
    updated_at: nowIso()
  };
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
  const doc = await readDocument(orgId, "projects", projectId);
  const project = asObject(doc.data);
  const events = (Array.isArray(project.events) ? project.events : []).map(asObject);
  const index = events.findIndex((item) => cleanText(item.id) === cleanText(event.id));
  if (index >= 0) {
    const current = events[index] as JsonObject;
    // Completion, skips, and reschedules belong to the concrete occurrence.
    events[index] = ["completed", "skipped"].includes(cleanText(current.status))
      ? { ...event, ...current, recurrence_series_id: cleanText(series.id) }
      : { ...current, ...event, recurrence_series_id: cleanText(series.id) };
  } else events.push(event);
  await upsertDocument(orgId, "projects", {
    id: projectId,
    data: { ...project, events, updated_at: nowIso() },
    metadata: asObject(doc.metadata)
  }, { replace: true });
  return index >= 0 ? events[index] as JsonObject : event;
}

function dueStatus(amount: number, dueAt: string) {
  if (!dueAt) return "scheduled";
  if (Date.parse(dueAt) > Date.now()) return "scheduled";
  return amount > 0 ? "due" : "void";
}

async function ensureRecurringFinance(orgId: string, series: JsonObject, start: Date, key: string) {
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
  for (let index = 0; index < 240; index += 1) {
    const billingAt = occurrenceDate(anchor, billingRule, index);
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

export async function materializeRecurrenceSeries(orgId: string, source: JsonObject, options: { horizonDays?: number } = {}) {
  const series = { ...source };
  if (cleanText(series.status || "active") !== "active") return { series, occurrences: [] as JsonObject[] };
  const rule = recurrenceRule(series);
  const anchor = dateOrThrow(series.start_at, "Start date");
  const endAt = rule.end_at ? dateOrThrow(rule.end_at, "End date") : null;
  const horizon = new Date(Date.now() + Math.max(30, Math.min(730, Math.round(options.horizonDays ?? 180))) * 86_400_000);
  const occurrences: JsonObject[] = [];
  for (let index = 0; index < 240; index += 1) {
    if (rule.occurrence_count && index >= rule.occurrence_count) break;
    const startsAt = occurrenceDate(anchor, rule, index);
    if (endAt && startsAt > endAt) break;
    if (startsAt > horizon) break;
    const key = occurrenceKey(startsAt);
    const occurrenceId = stableId("recurrence_occurrence", `${cleanText(series.id)}:${key}`);
    const existingDoc = await readDocument(orgId, OCCURRENCE_COLLECTION, occurrenceId).catch(() => null);
    const existing = existingDoc ? dataView(existingDoc) : {};
    const existingStatus = cleanText(existing.status);
    const event: JsonObject = existingDoc ? asObject(existing.event) : eventForOccurrence(series, startsAt, key);
    const savedEvent: JsonObject = existingDoc ? event : await saveProjectEvent(orgId, series, event);
    const occurrence = {
      schema_version: 1, id: occurrenceId, organization_id: orgId, recurrence_series_id: cleanText(series.id), project_id: cleanText(series.project_id), occurrence_key: key,
      starts_at: startsAt.toISOString(), ends_at: cleanText(savedEvent.end_at), status: existingStatus || "scheduled", event_id: cleanText(savedEvent.id), event: savedEvent,
      created_at: cleanText(existing.created_at || nowIso()), updated_at: nowIso()
    };
    const doc = await upsertDocument(orgId, OCCURRENCE_COLLECTION, { id: occurrenceId, data: occurrence, metadata: { kind: "recurrence_occurrence", project_id: cleanText(series.project_id), recurrence_series_id: cleanText(series.id) } }, { replace: true });
    occurrences.push(dataView(doc));
    if (!existingDoc) await ensureRecurringFinance(orgId, series, startsAt, key);
  }
  return { series, occurrences };
}

export async function createRecurrenceSeries(orgId: string, input: JsonObject, actorUserId = "") {
  const startAt = dateOrThrow(input.start_at || input.startAt, "Start date");
  const projectId = cleanText(input.project_id || input.projectId);
  if (projectId) await readDocument(orgId, "projects", projectId);
  const rule = recurrenceRule(input);
  const id = cleanText(input.id) || stableId("recurrence_series", `${orgId}:${projectId}:${cleanText(input.title)}:${startAt.toISOString()}:${Math.random()}`);
  const now = nowIso();
  const series = {
    schema_version: 1, id, organization_id: orgId, branch_id: cleanText(input.branch_id || input.branchId || "default") || "default", project_id: projectId,
    title: cleanText(input.title || "Recurring appointment"), status: "active", timezone: cleanText(input.timezone || "UTC") || "UTC", start_at: startAt.toISOString(), recurrence: rule,
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
  const generated = await materializeRecurrenceSeries(orgId, saved);
  return { series: saved, occurrences: generated.occurrences };
}

export async function listRecurrenceSeries(orgId: string, options: JsonObject = {}) {
  const projectId = cleanText(options.project_id || options.projectId);
  const includeCancelled = options.include_cancelled === true || options.includeCancelled === true;
  const series = (await listDocuments(orgId, SERIES_COLLECTION)).map(dataView)
    .filter((item) => !projectId || cleanText(item.project_id) === projectId)
    .filter((item) => includeCancelled || cleanText(item.status) === "active");
  await Promise.all(series.map((item) => materializeRecurrenceSeries(orgId, item).catch(() => null)));
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

export async function patchRecurrenceSeries(orgId: string, seriesId: string, patch: JsonObject, actorUserId = "") {
  const doc = await readDocument(orgId, SERIES_COLLECTION, seriesId).catch(() => { throw notFound("recurrence_series_not_found", "Recurring series was not found."); });
  const current = dataView(doc);
  const next = {
    ...current,
    ...patch,
    id: cleanText(current.id), organization_id: orgId, project_id: cleanText(patch.project_id ?? current.project_id),
    recurrence: Object.prototype.hasOwnProperty.call(patch, "recurrence") || Object.prototype.hasOwnProperty.call(patch, "frequency") ? recurrenceRule({ ...current, ...patch }) : asObject(current.recurrence),
    event_template: Object.prototype.hasOwnProperty.call(patch, "event_template") || Object.prototype.hasOwnProperty.call(patch, "event") ? asObject(patch.event_template || patch.event) : asObject(current.event_template),
    billing: Object.prototype.hasOwnProperty.call(patch, "billing") ? asObject(patch.billing) : asObject(current.billing),
    expenses: Object.prototype.hasOwnProperty.call(patch, "expenses") ? asObject(patch.expenses) : asObject(current.expenses),
    updated_by_user_id: actorUserId, updated_at: nowIso()
  };
  const saved = dataView(await upsertDocument(orgId, SERIES_COLLECTION, { id: seriesId, data: next, metadata: { ...asObject(doc.metadata), status: cleanText((next as JsonObject).status || "active") } }, { replace: true }));
  // Series edits apply forward. Preserve historical visits, but rebuild future
  // occurrences so an edited cadence cannot leave stale appointments or bills.
  if (cleanText(saved.status) === "active") {
    const now = nowIso();
    const oldOccurrences = await listRecurrenceOccurrences(orgId, seriesId);
    for (const occurrence of oldOccurrences.filter((item) => cleanText(item.starts_at) >= now && ["scheduled", "unscheduled"].includes(cleanText(item.status)))) {
      await saveProjectEvent(orgId, current, { ...asObject(occurrence.event), status: "cancelled", updated_at: now });
      await deleteDocument(orgId, OCCURRENCE_COLLECTION, cleanText(occurrence.id)).catch(() => null);
    }
    const financialCollections = [PAYMENT_OBLIGATION_COLLECTION, PAYMENT_PAYABLE_COLLECTION] as const;
    for (const collection of financialCollections) {
      for (const financialDoc of await listDocuments(orgId, collection)) {
        const value = dataView(financialDoc);
        if (cleanText(value.recurrence_series_id) !== seriesId || cleanText(value.due_at) < now || cleanText(value.status) === "paid") continue;
        await upsertDocument(orgId, collection, { id: cleanText(value.id), data: { ...value, status: "void", updated_at: now }, metadata: asObject(financialDoc.metadata) }, { replace: true });
      }
    }
  }
  const generated = await materializeRecurrenceSeries(orgId, saved);
  return { series: saved, occurrences: generated.occurrences };
}

export async function setRecurrenceOccurrenceStatus(orgId: string, seriesId: string, occurrenceId: string, status: "completed" | "skipped" | "cancelled", actorUserId = "") {
  const doc = await readDocument(orgId, OCCURRENCE_COLLECTION, occurrenceId).catch(() => { throw notFound("recurrence_occurrence_not_found", "Recurring occurrence was not found."); });
  const occurrence = dataView(doc);
  if (cleanText(occurrence.recurrence_series_id) !== seriesId) throw notFound("recurrence_occurrence_not_found", "Recurring occurrence was not found.");
  const event = { ...asObject(occurrence.event), status, completed_at: status === "completed" ? nowIso() : "", updated_at: nowIso() };
  const series = dataView(await readDocument(orgId, SERIES_COLLECTION, seriesId));
  await saveProjectEvent(orgId, series, event);
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
  const finance = await Promise.all([
    listDocuments(orgId, PAYMENT_OBLIGATION_COLLECTION),
    listDocuments(orgId, PAYMENT_PAYABLE_COLLECTION)
  ]);
  for (const doc of finance[0]) {
    const value = dataView(doc);
    if (cleanText(value.recurrence_series_id) === seriesId && cleanText(value.due_at) >= now && cleanText(value.status) !== "paid") {
      await upsertDocument(orgId, PAYMENT_OBLIGATION_COLLECTION, { id: cleanText(value.id), data: { ...value, status: "void", updated_at: now }, metadata: asObject(doc.metadata) }, { replace: true });
    }
  }
  for (const doc of finance[1]) {
    const value = dataView(doc);
    if (cleanText(value.recurrence_series_id) === seriesId && cleanText(value.due_at) >= now && cleanText(value.status) !== "paid") {
      await upsertDocument(orgId, PAYMENT_PAYABLE_COLLECTION, { id: cleanText(value.id), data: { ...value, status: "void", updated_at: now }, metadata: asObject(doc.metadata) }, { replace: true });
    }
  }
  return result.series;
}

export async function recurringMoneySummary(orgId: string, projectId: string) {
  const series = await listRecurrenceSeries(orgId, { project_id: projectId, include_cancelled: true });
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
  const seriesSummary = series.map((item) => {
    const id = cleanText(item.id);
    const seriesOccurrences = relatedOccurrences.filter((entry) => cleanText(entry.recurrence_series_id) === id);
    const seriesObligations = relatedObligations.filter((entry) => cleanText(entry.recurrence_series_id) === id);
    const seriesPayables = relatedPayables.filter((entry) => cleanText(entry.recurrence_series_id) === id);
    const rule = asObject(item.recurrence);
    const finiteEnd = finiteSeriesEnd(item);
    const finite = !!finiteEnd;
    const obligationTotal = seriesObligations.reduce((sum, entry) => sum + Math.max(0, Math.round(number(entry.amount_cents))), 0);
    const expenseTotal = seriesPayables.reduce((sum, entry) => sum + Math.max(0, Math.round(number(entry.amount_cents))), 0);
    const collected = seriesObligations.reduce((sum, entry) => sum + Math.max(0, Math.round(number(entry.allocated_cents))), 0);
    const paidExpenses = seriesPayables.reduce((sum, entry) => sum + Math.max(0, Math.round(number(entry.paid_cents))), 0);
    const nextItem = seriesOccurrences.filter((entry) => cleanText(entry.status) === "scheduled" && cleanText(entry.starts_at) >= nowIso()).sort((a, b) => cleanText(a.starts_at).localeCompare(cleanText(b.starts_at)))[0] || null;
    const eventRule = recurrenceRule(item);
    const billing = asObject(item.billing);
    const expenses = asObject(item.expenses);
    const eventCount = finiteEnd ? occurrenceCountThrough(dateOrThrow(item.start_at, "Start date"), eventRule, finiteEnd) : 0;
    const billingRule = recurrenceRule({ recurrence: { ...asObject(billing.recurrence), frequency: billing.frequency || eventRule.frequency, interval: billing.interval || eventRule.interval } });
    const billingCount = finiteEnd ? occurrenceCountThrough(dateOrThrow(billing.anchor_at || billing.anchorAt || item.start_at, "Billing anchor"), billingRule, finiteEnd) : 0;
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
