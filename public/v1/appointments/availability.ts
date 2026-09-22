import { randomUUID } from "node:crypto";

import { isCapabilityEnabled } from "../platform/capabilities.js";
import { badRequest, conflict, forbidden, notFound } from "../platform/errors.js";
import { listDocuments, readBranchModule, readDocument, upsertDocument, type JsonObject } from "../platform/storage.js";
import { resolveOrganizationTimezone, zonedInstant, zonedParts } from "../platform/timezone.js";
import { resolveAssignableSubjects } from "../workforce/service.js";
import { normalizeAssignmentPolicy } from "../workforce/assignability.js";
import { readScopeTemplate } from "../scopes/storage.js";
import {
  createSlotHold,
  deleteSlotHold,
  listActiveSlotHolds,
  readSlotHold,
  type AppointmentSlotHold
} from "./storage.js";

export const CUSTOMER_SCHEDULING_CAPABILITY = "scheduling.customer_rescheduling";
export const AUTOMATED_RESCHEDULING_CAPABILITY = "scheduling.automated_rescheduling";
export const RESOURCE_AVAILABILITY_CAPABILITY = "scheduling.resource_availability";
export const AGENT_AVAILABILITY_CAPABILITY = "scheduling.agent_availability";
export const CONFIRMATION_RELEASE_CAPABILITY = "scheduling.confirmation_release";

function cleanText(value: unknown) { return String(value ?? "").trim(); }
function asObject(value: unknown): JsonObject { return value && typeof value === "object" && !Array.isArray(value) ? { ...(value as JsonObject) } : {}; }
function asArray(value: unknown) { return Array.isArray(value) ? value : []; }
function unique(value: unknown) { return [...new Set(asArray(value).map(cleanText).filter(Boolean))]; }
function clamp(value: unknown, min: number, max: number, fallback: number) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.min(max, Math.max(min, parsed)) : fallback;
}
function bool(value: unknown, fallback = false) { return value === true ? true : value === false ? false : fallback; }

export type CustomerSchedulingPolicy = JsonObject & {
  enabled: boolean;
  actions: string[];
  min_notice_minutes: number;
  booking_horizon_days: number;
  max_reschedules: number;
  hold_minutes: number;
  assignment_mode: string;
  reschedule_approval: "automatic" | "required";
  reschedule_staff_notification: boolean;
  reschedule_review_todo: boolean;
  reschedule_review_role_ids: string[];
  reschedule_customer_notification: "none" | "sms" | "email" | "both";
};

export function normalizeCustomerSchedulingPolicy(value: unknown, defaults: unknown = {}): CustomerSchedulingPolicy {
  const base = asObject(defaults);
  const raw = asObject(value);
  const actions = unique(raw.actions ?? base.actions ?? ["reschedule"]).filter((entry) => ["schedule", "reschedule", "cancel"].includes(entry));
  return {
    ...base,
    ...raw,
    enabled: bool(raw.enabled, bool(base.enabled, false)),
    actions: actions.length ? actions : ["reschedule"],
    min_notice_minutes: Math.round(clamp(raw.min_notice_minutes ?? base.min_notice_minutes, 0, 43_200, 120)),
    booking_horizon_days: Math.round(clamp(raw.booking_horizon_days ?? base.booking_horizon_days, 1, 365, 45)),
    max_reschedules: Math.round(clamp(raw.max_reschedules ?? base.max_reschedules, 0, 20, 3)),
    hold_minutes: Math.round(clamp(raw.hold_minutes ?? base.hold_minutes, 1, 30, 5)),
    assignment_mode: ["preserve", "best_available", "customer_choice"].includes(cleanText(raw.assignment_mode || base.assignment_mode))
      ? cleanText(raw.assignment_mode || base.assignment_mode)
      : "best_available",
    reschedule_approval: cleanText(raw.reschedule_approval || base.reschedule_approval) === "required" ? "required" : "automatic",
    reschedule_staff_notification: bool(raw.reschedule_staff_notification, bool(base.reschedule_staff_notification, false)),
    reschedule_review_todo: bool(raw.reschedule_review_todo, bool(base.reschedule_review_todo, true)),
    reschedule_review_role_ids: unique(raw.reschedule_review_role_ids ?? base.reschedule_review_role_ids),
    reschedule_customer_notification: ["sms", "email", "both"].includes(cleanText(raw.reschedule_customer_notification || base.reschedule_customer_notification))
      ? cleanText(raw.reschedule_customer_notification || base.reschedule_customer_notification) as "sms" | "email" | "both"
      : "none",
    messages: {
      intro: cleanText(asObject(raw.messages).intro || asObject(base.messages).intro) || "Let's find another time that works.",
      slot_prompt: cleanText(asObject(raw.messages).slot_prompt || asObject(base.messages).slot_prompt) || "Reply with the number of the time you prefer, or use your project portal.",
      success: cleanText(asObject(raw.messages).success || asObject(base.messages).success) || "You're all set. Your appointment has been moved to {{appointment_time}}.",
      requested: cleanText(asObject(raw.messages).requested || asObject(base.messages).requested) || "Your request has been submitted. Your original appointment stays in place until our team reviews the change.",
      approved: cleanText(asObject(raw.messages).approved || asObject(base.messages).approved) || "Your appointment change has been confirmed for {{appointment_time}}.",
      declined: cleanText(asObject(raw.messages).declined || asObject(base.messages).declined) || "We couldn't approve the requested appointment change. Your original appointment is still reserved.",
      no_slots: cleanText(asObject(raw.messages).no_slots || asObject(base.messages).no_slots) || "We couldn't find an open time in that range. Our team will follow up."
    }
  } as CustomerSchedulingPolicy;
}

export function normalizeSchedulingAvailabilitySettings(value: unknown) {
  const raw = asObject(value);
  const self = asObject(raw.self_service);
  const travel = asObject(raw.travel);
  const routing = asObject(raw.routing);
  return {
    self_service: {
      enabled: bool(self.enabled, false),
      deterministic_workflow: bool(self.deterministic_workflow, false),
      portal_enabled: bool(self.portal_enabled, false),
      agent_read_enabled: bool(self.agent_read_enabled, false),
      agent_write_enabled: bool(self.agent_write_enabled, false),
      default_policy: normalizeCustomerSchedulingPolicy(self.default_policy),
      messages: asObject(self.messages)
    },
    travel: {
      enabled: bool(travel.enabled, false),
      average_speed_mph: clamp(travel.average_speed_mph, 5, 80, 28),
      multiplier: clamp(travel.multiplier, 1, 3, 1.25),
      minimum_minutes: clamp(travel.minimum_minutes, 0, 120, 10),
      fixed_buffer_minutes: clamp(travel.fixed_buffer_minutes, 0, 240, 0),
      default_minutes: clamp(travel.default_minutes ?? routing.default_travel_minutes, 0, 240, 20),
      slack_minutes: clamp(travel.slack_minutes ?? routing.travel_slack_minutes, 0, 120, 5)
    },
    redundancy: {
      reserve_count: Math.round(clamp(asObject(raw.redundancy).reserve_count, 0, 20, 0)),
      reserve_percent: clamp(asObject(raw.redundancy).reserve_percent, 0, 90, 0)
    },
    resource_availability: asObject(raw.resource_availability)
  };
}

export async function readSchedulingAvailabilitySettings(orgId: string, branchId: string) {
  const module = await readBranchModule(orgId, cleanText(branchId) || "default", "scheduling").catch(() => null);
  const scheduling = asObject(asObject(module).data);
  return {
    scheduling,
    settings: normalizeSchedulingAvailabilitySettings(scheduling),
    revision: Number(asObject(module).revision || 0)
  };
}

export function effectiveCustomerSchedulingPolicy(eventValue: unknown, eventTypeValue: unknown, schedulingValue: unknown) {
  const event = asObject(eventValue);
  const eventType = asObject(eventTypeValue);
  const settings = normalizeSchedulingAvailabilitySettings(schedulingValue);
  const eventDeclared = asObject(event.customer_scheduling);
  const typeDeclared = asObject(eventType.customer_scheduling);
  const inherited = normalizeCustomerSchedulingPolicy(typeDeclared, settings.self_service.default_policy);
  return normalizeCustomerSchedulingPolicy(eventDeclared, inherited);
}

function minutes(value: unknown, fallback = 0) {
  const match = /^(\d{1,2}):(\d{2})$/.exec(cleanText(value));
  return match ? Number(match[1]) * 60 + Number(match[2]) : fallback;
}

function localDateKey(instant: Date, timezone: string) {
  const parts = zonedParts(instant, timezone);
  return `${parts.year}-${String(parts.month).padStart(2, "0")}-${String(parts.day).padStart(2, "0")}`;
}

function localDayNumber(dateKey: string) {
  const [year, month, day] = dateKey.split("-").map(Number);
  return new Date(Date.UTC(year || 1970, (month || 1) - 1, day || 1)).getUTCDay();
}

function instantFor(dateKey: string, minute: number, timezone: string) {
  const [year, month, day] = dateKey.split("-").map(Number);
  return zonedInstant(year || 1970, month || 1, day || 1, Math.floor(minute / 60), minute % 60, timezone);
}

function addLocalDays(dateKey: string, amount: number) {
  const [year, month, day] = dateKey.split("-").map(Number);
  const shifted = new Date(Date.UTC(year || 1970, (month || 1) - 1, (day || 1) + amount));
  return `${shifted.getUTCFullYear()}-${String(shifted.getUTCMonth() + 1).padStart(2, "0")}-${String(shifted.getUTCDate()).padStart(2, "0")}`;
}

function availabilityWindow(availabilityValue: unknown, eventTypeId: string, dateKey: string) {
  const availability = asObject(availabilityValue);
  const day = localDayNumber(dateKey);
  const rows = asArray(availability.working_hours).map(asObject);
  const row = rows.find((entry) => asArray(entry.days).map(Number).includes(day));
  const eventWindow = asObject(asObject(availability.event_type_windows)[eventTypeId]);
  if (!row && rows.length) return null;
  const start = minutes(eventWindow.start || eventWindow.start_time || row?.start || row?.start_time || availability[`${eventTypeId}_start_time`] || availability.sales_appointment_start_time, 9 * 60);
  const end = minutes(eventWindow.end || eventWindow.end_time || row?.end || row?.end_time || availability[`${eventTypeId}_end_time`] || availability.sales_appointment_end_time, 17 * 60);
  return end > start ? { start, end } : null;
}

function intervalsOverlap(startA: Date, endA: Date, startB: Date, endB: Date) { return startA < endB && startB < endA; }

function eventRange(eventValue: unknown) {
  const event = asObject(eventValue);
  const start = new Date(cleanText(event.start_at || event.start));
  const explicitEnd = new Date(cleanText(event.end_at || event.end));
  const duration = Math.max(1, Number(event.duration_minutes || 60));
  const end = Number.isFinite(explicitEnd.getTime()) && explicitEnd > start ? explicitEnd : new Date(start.getTime() + duration * 60_000);
  return { start, end };
}

function eventResourceKeys(eventValue: unknown) {
  const event = asObject(eventValue);
  const keys = unique([event.assigned_user_id, event.user_id, ...asArray(event.assigned_user_ids), ...asArray(event.user_ids)])
    .map((id) => `organization_user:${id}`);
  const ref = asObject(event.work_resource_ref);
  const resourceId = cleanText(ref.id || event.assigned_resource_id || event.resource_id || event.assigned_crew_id || event.crew_id);
  const resourceKind = cleanText(ref.kind || event.assigned_resource_kind || (resourceId ? "resource_group" : ""));
  if (resourceId) keys.push(`${resourceKind || "resource_group"}:${resourceId}`);
  for (const row of asArray(event.resource_refs).map(asObject)) {
    if (cleanText(row.id) && cleanText(row.kind)) keys.push(`${cleanText(row.kind)}:${cleanText(row.id)}`);
  }
  return [...new Set(keys.map((entry) => entry.toLowerCase()))];
}

function subjectKey(subjectValue: unknown) {
  const subject = asObject(subjectValue);
  return `${cleanText(subject.subject_type || subject.resource_kind)}:${cleanText(subject.id || subject.resource_id)}`.toLowerCase();
}

export function subjectMemberIds(subjectValue: unknown) {
  return asArray(asObject(subjectValue).members).map(asObject)
    .filter((member) => cleanText(member.status || "active") === "active")
    .map((member) => cleanText(member.user_id || asObject(member.user).id)).filter(Boolean);
}

export function resourceAvailabilityRule(settings: ReturnType<typeof normalizeSchedulingAvailabilitySettings>, subjectValue: unknown) {
  const subject = asObject(subjectValue);
  const key = subjectKey(subject);
  const direct = asObject(settings.resource_availability[key]);
  const embedded = asObject(subject.scheduling || asObject(subject.attributes).scheduling || asObject(subject.metadata).scheduling);
  const raw = { ...embedded, ...direct };
  const subjectType = cleanText(subject.subject_type);
  return {
    enabled: raw.enabled !== false,
    capacity_mode: ["unit", "members", "quantity"].includes(cleanText(raw.capacity_mode)) ? cleanText(raw.capacity_mode) : (subjectType === "resource_group" ? "unit" : "unit"),
    capacity: Math.round(clamp(raw.capacity, 1, 100, 1)),
    minimum_members: Math.round(clamp(raw.minimum_members, 1, 100, 1)),
    working_hours: asArray(raw.working_hours),
    exceptions: asArray(raw.exceptions).map(asObject),
    buffer_minutes: clamp(raw.buffer_minutes, 0, 240, 0),
    travel_enabled: raw.travel_enabled !== false
  };
}

export function resourceAvailabilityCapacity(settings: ReturnType<typeof normalizeSchedulingAvailabilitySettings>, subjectValue: unknown) {
  const rule = resourceAvailabilityRule(settings, subjectValue);
  const members = subjectMemberIds(subjectValue);
  if (rule.capacity_mode === "members") return Math.max(0, members.length - (rule.minimum_members - 1));
  return rule.capacity;
}

/** Shared weekly + per-date availability model used by slot calculation and auto-routing. */
export function subjectUnavailableOnDate(schedulingValue: unknown, subjectIdValue: unknown, dateKey: string) {
  const scheduling = asObject(schedulingValue);
  const subjectId = cleanText(subjectIdValue);
  if (!subjectId || !/^\d{4}-\d{2}-\d{2}$/.test(dateKey)) return false;
  const weekdayMap = asObject(scheduling.availability_weekdays);
  const configuredDays = weekdayMap[subjectId];
  let unavailable = false;
  if (Array.isArray(configuredDays)) unavailable = !configuredDays.map(Number).includes(localDayNumber(dateKey));
  const overrides = asObject(scheduling.unavailability)[subjectId];
  const flipped = Array.isArray(overrides) && overrides.map(cleanText).includes(dateKey);
  return flipped ? !unavailable : unavailable;
}

function resourceWorking(subjectRule: ReturnType<typeof resourceAvailabilityRule>, dateKey: string, startMinute: number, endMinute: number) {
  const exception = subjectRule.exceptions.find((entry) => cleanText(entry.date) === dateKey);
  if (exception?.available === false) return false;
  const rows = subjectRule.working_hours.map(asObject);
  if (!rows.length) return true;
  const day = localDayNumber(dateKey);
  return rows.some((entry) => asArray(entry.days).map(Number).includes(day)
    && startMinute >= minutes(entry.start || entry.start_time, 0)
    && endMinute <= minutes(entry.end || entry.end_time, 24 * 60));
}

function coordinates(value: unknown) {
  const input = asObject(value);
  const lat = Number(input.lat || input.latitude || asObject(input.location).lat);
  const lng = Number(input.lng || input.longitude || asObject(input.location).lng);
  return Number.isFinite(lat) && Number.isFinite(lng) ? { lat, lng } : null;
}

function travelMinutes(fromValue: unknown, toValue: unknown, settings: ReturnType<typeof normalizeSchedulingAvailabilitySettings>) {
  const from = coordinates(fromValue);
  const to = coordinates(toValue);
  if (!settings.travel.enabled) return 0;
  if (!from || !to) return settings.travel.default_minutes + settings.travel.fixed_buffer_minutes;
  const radians = (value: number) => value * Math.PI / 180;
  const dLat = radians(to.lat - from.lat);
  const dLng = radians(to.lng - from.lng);
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(radians(from.lat)) * Math.cos(radians(to.lat)) * Math.sin(dLng / 2) ** 2;
  const miles = 3958.8 * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return Math.ceil(Math.max(settings.travel.minimum_minutes, miles / settings.travel.average_speed_mph * 60 * settings.travel.multiplier) + settings.travel.fixed_buffer_minutes);
}

type AvailabilityOptions = {
  project_id?: string;
  event_id?: string;
  event_type_id?: string;
  start_date?: string;
  end_date?: string;
  days?: number;
  duration_minutes?: number;
  min_notice_minutes?: number;
  scope_template_id?: string;
  address?: JsonObject;
  exclude_hold_id?: string;
  exclude_reschedule_request_id?: string;
  limit?: number;
};

export async function appointmentAvailability(orgId: string, branchIdValue: string, options: AvailabilityOptions = {}) {
  const branchId = cleanText(branchIdValue) || "default";
  const { scheduling, settings } = await readSchedulingAvailabilitySettings(orgId, branchId);
  const timezone = await resolveOrganizationTimezone(orgId, branchId);
  const projectId = cleanText(options.project_id);
  const eventId = cleanText(options.event_id);
  const projectDocument = projectId ? await readDocument(orgId, "projects", projectId).catch(() => null) : null;
  const project = asObject(projectDocument?.data);
  const sourceEvent = asArray(project.events).map(asObject).find((event) => cleanText(event.id) === eventId) || {};
  const eventTypeId = cleanText(options.event_type_id || sourceEvent.event_type_default_id || sourceEvent.type_id) || "sales_appointment";
  const eventType = asObject(asObject(scheduling.event_types)[eventTypeId]);
  const activeScope = asArray(asObject(project.work_projection).active_instances).map(asObject)[0] || {};
  const scopeTemplateId = cleanText(options.scope_template_id || sourceEvent.scope_template_id || project.scope_template_id || project.sales_scope_template_id || activeScope.template_id || activeScope.scope_template_id);
  const scopeTemplate = scopeTemplateId ? asObject((await Promise.resolve().then(async () => (await readScopeTemplate(orgId, branchId, scopeTemplateId))).catch(() => null))?.definition) : {};
  const scopePolicy = asObject(scopeTemplate.customer_scheduling);
  const policy = effectiveCustomerSchedulingPolicy({ ...sourceEvent, customer_scheduling:{ ...scopePolicy, ...asObject(sourceEvent.customer_scheduling), ...(options.min_notice_minutes == null ? {} : { min_notice_minutes:options.min_notice_minutes }) } }, eventType, scheduling);
  const durationMinutes = Math.round(clamp(options.duration_minutes || sourceEvent.duration_minutes || eventType.duration_minutes, 5, 1440, 60));
  const slotMinutes = Math.round(clamp(eventType.slot_minutes || asObject(scheduling.availability).sales_appointment_slot_minutes, 5, 240, 30));
  const bufferMinutes = clamp(eventType.buffer_minutes || asObject(scheduling.availability).sales_appointment_buffer_minutes, 0, 240, 0);
  const assignmentPolicy = normalizeAssignmentPolicy(eventType.assignment_policy || sourceEvent.assignment_policy || {
    allow_unassigned: eventType.allow_unassigned !== false,
    rules: unique(eventType.required_role_ids || eventType.allowed_role_ids || eventType.role_ids).length
      ? [{ subject_types: ["organization_user"], role_ids: unique(eventType.required_role_ids || eventType.allowed_role_ids || eventType.role_ids) }]
      : []
  });
  const resolved = await resolveAssignableSubjects(orgId, branchId, assignmentPolicy, { scope_template_id: scopeTemplateId });
  const subjects = resolved.subjects.map(asObject).filter((subject) => cleanText(subject.status || "active") !== "disabled" && cleanText(subject.status || "active") !== "archived");
  const startDate = /^\d{4}-\d{2}-\d{2}$/.test(cleanText(options.start_date)) ? cleanText(options.start_date) : localDateKey(new Date(), timezone);
  const requestedDays = Math.round(clamp(options.days, 1, 90, 14));
  const endDate = /^\d{4}-\d{2}-\d{2}$/.test(cleanText(options.end_date)) ? cleanText(options.end_date) : addLocalDays(startDate, requestedDays - 1);
  const from = instantFor(startDate, 0, timezone);
  const to = instantFor(addLocalDays(endDate, 1), 0, timezone);
  const projectDocs = await listDocuments(orgId, "projects");
  const scheduledEvents = projectDocs.flatMap((document) => {
    const data = asObject(document.data);
    return asArray(data.events).map(asObject).flatMap((event) => {
      const rows = [{ event, project: data, project_id: cleanText(document.id), request_id: "" }];
      const request = asObject(event.reschedule_request);
      if (cleanText(request.status) === "pending" && cleanText(request.requested_start_at)) {
        rows.push({
          event: applyAssignment({
            ...event,
            id: `${cleanText(event.id)}:reschedule-request:${cleanText(request.id)}`,
            start_at: cleanText(request.requested_start_at),
            end_at: cleanText(request.requested_end_at),
            status: "scheduled"
          }, cleanText(request.resource_key), [asObject(request.resource)]),
          project: data,
          project_id: cleanText(document.id),
          request_id: cleanText(request.id)
        });
      }
      return rows;
    });
  }).filter((entry) => {
    if (entry.project_id === projectId && cleanText(entry.event.id) === eventId) return false;
    if (cleanText(entry.request_id) && cleanText(entry.request_id) === cleanText(options.exclude_reschedule_request_id)) return false;
    const range = eventRange(entry.event);
    return Number.isFinite(range.start.getTime()) && range.start < to && range.end > from && !["cancelled", "canceled", "unscheduled"].includes(cleanText(entry.event.status).toLowerCase());
  });
  const holds = (await listActiveSlotHolds(orgId, branchId, from, to)).filter((hold) => cleanText(hold.id) !== cleanText(options.exclude_hold_id));
  const targetLocation = options.address || project;
  const travelEnabled = await isCapabilityEnabled(orgId, "scheduling.travel_time").catch(() => false);
  const slots: JsonObject[] = [];
  let dateKey = startDate;
  while (dateKey <= endDate && slots.length < Math.round(clamp(options.limit, 1, 500, 240))) {
    const window = availabilityWindow(scheduling.availability, eventTypeId, dateKey);
    if (window) {
      for (let minute = window.start; minute + durationMinutes <= window.end; minute += slotMinutes) {
        const start = instantFor(dateKey, minute, timezone);
        const end = new Date(start.getTime() + durationMinutes * 60_000);
        if (start.getTime() < Date.now() + policy.min_notice_minutes * 60_000) continue;
        const candidateRows: JsonObject[] = [];
        for (const subject of subjects) {
          const key = subjectKey(subject);
          const rule = resourceAvailabilityRule(settings, subject);
          if (subjectUnavailableOnDate(scheduling, subject.id || subject.resource_id, dateKey)) continue;
          if (!rule.enabled || !resourceWorking(rule, dateKey, minute, minute + durationMinutes)) continue;
          const memberKeys = subjectMemberIds(subject).map((id) => `organization_user:${id}`.toLowerCase());
          const relevantKeys = [key, ...(rule.capacity_mode === "members" ? memberKeys : [])];
          const conflicts = scheduledEvents.filter((entry) => {
            const range = eventRange(entry.event);
            const expandedStart = new Date(start.getTime() - (bufferMinutes + rule.buffer_minutes) * 60_000);
            const expandedEnd = new Date(end.getTime() + (bufferMinutes + rule.buffer_minutes) * 60_000);
            return eventResourceKeys(entry.event).some((assigned) => relevantKeys.includes(assigned))
              && intervalsOverlap(expandedStart, expandedEnd, range.start, range.end);
          });
          const holdConflicts = holds.filter((hold) => (!cleanText(hold.resource_key) || cleanText(hold.resource_key).toLowerCase() === key)
            && intervalsOverlap(start, end, new Date(hold.start_at), new Date(hold.end_at)));
          const capacity = resourceAvailabilityCapacity(settings, subject);
          let availableUnits = Math.max(0, capacity - conflicts.length - holdConflicts.length);
          let travel_before_minutes = 0;
          let travel_after_minutes = 0;
          if (availableUnits > 0 && travelEnabled && settings.travel.enabled && rule.travel_enabled) {
            const assigned = scheduledEvents.filter((entry) => eventResourceKeys(entry.event).some((assignedKey) => relevantKeys.includes(assignedKey)));
            const previous = assigned.filter((entry) => eventRange(entry.event).end <= start).sort((a, b) => eventRange(b.event).end.getTime() - eventRange(a.event).end.getTime())[0];
            const next = assigned.filter((entry) => eventRange(entry.event).start >= end).sort((a, b) => eventRange(a.event).start.getTime() - eventRange(b.event).start.getTime())[0];
            if (previous) {
              travel_before_minutes = travelMinutes(previous.project, targetLocation, settings);
              if (eventRange(previous.event).end.getTime() + (travel_before_minutes + settings.travel.slack_minutes) * 60_000 > start.getTime()) availableUnits = 0;
            }
            if (next) {
              travel_after_minutes = travelMinutes(targetLocation, next.project, settings);
              if (end.getTime() + (travel_after_minutes + settings.travel.slack_minutes) * 60_000 > eventRange(next.event).start.getTime()) availableUnits = 0;
            }
          }
          if (availableUnits > 0) candidateRows.push({
            resource_key: key,
            subject_type: cleanText(subject.subject_type),
            resource_id: cleanText(subject.id || subject.resource_id),
            name: cleanText(subject.name || subject.label || subject.id),
            available_units: availableUnits,
            capacity,
            travel_before_minutes,
            travel_after_minutes
          });
        }
        const unassignedReservations = scheduledEvents.filter((entry) => !eventResourceKeys(entry.event).length
          && cleanText(entry.event.event_type_default_id || entry.event.type_id) === eventTypeId
          && intervalsOverlap(new Date(start.getTime() - bufferMinutes * 60_000), new Date(end.getTime() + bufferMinutes * 60_000), eventRange(entry.event).start, eventRange(entry.event).end)).length
          + holds.filter((hold) => !cleanText(hold.resource_key) && intervalsOverlap(start, end, new Date(hold.start_at), new Date(hold.end_at))).length;
        const rawCount = candidateRows.reduce((sum, row) => sum + Number(row.available_units || 0), 0);
        const reserved = Math.max(settings.redundancy.reserve_count, Math.ceil(rawCount * settings.redundancy.reserve_percent / 100));
        const availableCount = Math.max(0, rawCount - unassignedReservations - reserved);
        slots.push({
          start_at: start.toISOString(),
          end_at: end.toISOString(),
          date: dateKey,
          label: new Intl.DateTimeFormat("en-US", { timeZone: timezone, weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }).format(start),
          available: availableCount > 0 || (!subjects.length && assignmentPolicy.allow_unassigned && unassignedReservations === 0),
          available_count: availableCount,
          eligible_count: rawCount,
          reserved_capacity: reserved,
          unassigned_reservations: unassignedReservations,
          candidates: candidateRows
        });
      }
    }
    dateKey = addLocalDays(dateKey, 1);
  }
  return {
    ok: true,
    organization_id: orgId,
    branch_id: branchId,
    project_id: projectId,
    event_id: eventId,
    event_type_id: eventTypeId,
    timezone,
    duration_minutes: durationMinutes,
    slot_minutes: slotMinutes,
    buffer_minutes: bufferMinutes,
    policy,
    assignment_policy: assignmentPolicy,
    slots
  };
}

export async function holdAppointmentSlot(orgId: string, branchId: string, input: JsonObject) {
  const startAt = new Date(cleanText(input.start_at));
  if (!Number.isFinite(startAt.getTime())) throw badRequest("invalid_slot", "Choose a valid appointment time.");
  const date = localDateKey(startAt, await resolveOrganizationTimezone(orgId, branchId));
  const result = await appointmentAvailability(orgId, branchId, {
    project_id: cleanText(input.project_id),
    event_id: cleanText(input.event_id),
    event_type_id: cleanText(input.event_type_id),
    start_date: date,
    end_date: date,
    duration_minutes: Number(input.duration_minutes) || undefined,
    address: asObject(input.address)
  });
  const slot = result.slots.find((entry) => cleanText(asObject(entry).start_at) === startAt.toISOString() && asObject(entry).available === true);
  if (!slot) throw conflict("appointment_slot_unavailable", "That appointment time is no longer available. Choose another time.");
  const requestedKey = cleanText(input.resource_key).toLowerCase();
  const candidates = asArray(asObject(slot).candidates).map(asObject);
  const candidate = requestedKey ? candidates.find((entry) => cleanText(entry.resource_key).toLowerCase() === requestedKey) : candidates[0];
  if (requestedKey && !candidate) throw conflict("appointment_resource_unavailable", "That team is no longer available at this time.");
  const policy = asObject(result.policy);
  const hold = (await createSlotHold({
    organization_id: orgId,
    branch_id: branchId,
    project_id: cleanText(input.project_id),
    event_id: cleanText(input.event_id),
    event_type_id: result.event_type_id,
    resource_key: cleanText(candidate?.resource_key),
    start_at: cleanText(asObject(slot).start_at),
    end_at: cleanText(asObject(slot).end_at),
    expires_at: new Date(Date.now() + Number(policy.hold_minutes || 5) * 60_000).toISOString(),
    source: cleanText(input.source) || "customer_portal",
    source_id: cleanText(input.source_id)
  }));
  return { ok: true, hold, slot };
}

function applyAssignment(event: JsonObject, resourceKey: string, candidates: JsonObject[]) {
  if (!resourceKey) return event;
  const [kind, id] = resourceKey.split(":", 2);
  const candidate = candidates.find((entry) => cleanText(entry.resource_key).toLowerCase() === resourceKey.toLowerCase());
  const name = cleanText(candidate?.name || id);
  if (kind === "organization_user") {
    return { ...event, assigned_user_id: id, assigned_user_ids: [id], assigned_resource_kind: kind, assigned_resource_id: id, assigned_resource_name: name, work_resource_ref: { kind, id, name } };
  }
  return { ...event, assigned_user_id: "", assigned_user_ids: [], assigned_resource_kind: kind, assigned_resource_id: id, assigned_resource_name: name, assigned_crew_id: kind === "resource_group" ? id : "", assigned_crew_name: kind === "resource_group" ? name : "", work_resource_ref: { kind, id, name } };
}

function customerName(project: JsonObject) {
  const primary = asArray(project.contacts).map(asObject).find((entry) => entry.primary === true) || asObject(asArray(project.contacts)[0]);
  return cleanText(primary.name || asObject(project.customer).name || project.customer_name || project.primary_contact_name) || "A customer";
}

function appointmentTimeLabel(value: unknown, timezone: string) {
  const date = new Date(cleanText(value));
  return Number.isFinite(date.getTime())
    ? new Intl.DateTimeFormat("en-US", { timeZone: timezone, weekday: "long", month: "long", day: "numeric", year: "numeric", hour: "numeric", minute: "2-digit" }).format(date)
    : cleanText(value);
}

function policyMessage(policy: CustomerSchedulingPolicy, key: string, appointmentTime: string) {
  return cleanText(asObject(policy.messages)[key]).replaceAll("{{appointment_time}}", appointmentTime);
}

async function createRescheduleStaffArtifacts(orgId: string, branchId: string, projectId: string, project: JsonObject, event: JsonObject, request: JsonObject, policy: CustomerSchedulingPolicy) {
  const timezone = await resolveOrganizationTimezone(orgId, branchId);
  const from = appointmentTimeLabel(request.original_start_at, timezone);
  const to = appointmentTimeLabel(request.requested_start_at, timezone);
  const name = customerName(project);
  const body = `${name} requested to move ${cleanText(event.title) || "an appointment"} from ${from} to ${to}.`;
  if (policy.reschedule_staff_notification) {
    try {
      const { createPlatformNotification } = await import("../platform/api.js");
      await createPlatformNotification(orgId, {
        id: `notification_reschedule_${cleanText(request.id)}`,
        title: policy.reschedule_approval === "required" ? `${name} requested an appointment change` : `${name} rescheduled an appointment`,
        body,
        kind: "appointment_reschedule",
        channel: "passive",
        push: true,
        manual_dismissible: true,
        branch_id: branchId,
        source: "appointment_rescheduling",
        target_role_ids: policy.reschedule_review_role_ids,
        frontend_action: { kind: "open_project", project_id: projectId, tab: "schedule", event_id: cleanText(event.id) },
        context: { project_id: projectId, event_id: cleanText(event.id), reschedule_request_id: cleanText(request.id), approval_required: policy.reschedule_approval === "required" }
      });
    } catch (error) { console.error("appointment reschedule notification failed", error); }
  }
  if (policy.reschedule_approval === "required" && policy.reschedule_review_todo) {
    try {
      const { createWorkPlan } = await import("../work/service.js");
      await createWorkPlan({
        organization_id: orgId,
        branch_id: branchId,
        project_id: projectId,
        source_type: "appointment_reschedule_review",
        source_id: cleanText(request.id),
        source_key: `appointment_reschedule_review:${cleanText(request.id)}`,
        title: `Review ${name}'s appointment change`,
        root_nodes: [{
          id: "review_reschedule",
          title: "Review requested appointment change",
          description: body,
          terminology_key: "work.task",
          actionable: true,
          show_in_todo_list: true,
          priority: 70,
          assigned_role_ids: policy.reschedule_review_role_ids,
          metadata: {
            kind: "appointment_reschedule_review",
            reschedule_request_id: cleanText(request.id),
            event_id: cleanText(event.id),
            frontend_action: { kind: "open_project", project_id: projectId, tab: "schedule", event_id: cleanText(event.id) },
            payload: { project_id: projectId, event_id: cleanText(event.id), reschedule_request_id: cleanText(request.id) }
          }
        }],
        context: { project_id: projectId, event_id: cleanText(event.id), reschedule_request_id: cleanText(request.id) },
        metadata: { hide_from_boards: true, kind: "appointment_reschedule_review" },
        start_immediately: true
      });
    } catch (error) { console.error("appointment reschedule review to-do failed", error); }
  }
}

async function resolveRescheduleReviewTodo(orgId: string, projectId: string, requestId: string, outcome: "approved" | "declined" | "canceled", actor: string) {
  try {
    const { listWorkTodos, transitionWorkNode } = await import("../work/service.js");
    const todo = (await listWorkTodos(orgId, { project_id: projectId, include_completed: true, include_future: true }))
      .find((entry) => cleanText(asObject(entry.metadata).reschedule_request_id) === requestId);
    if (todo && !["completed", "canceled", "skipped"].includes(cleanText(todo.status))) {
      await transitionWorkNode(orgId, cleanText(todo.id), outcome === "approved" ? "completed" : "canceled", { reason: `reschedule_${outcome}`, actor_user_id: actor });
    }
  } catch (error) { console.error("appointment reschedule review to-do resolution failed", error); }
}

async function sendRescheduleDecision(orgId: string, branchId: string, projectId: string, request: JsonObject, policy: CustomerSchedulingPolicy, approved: boolean) {
  if (policy.reschedule_customer_notification === "none") return [];
  const timezone = await resolveOrganizationTimezone(orgId, branchId);
  const text = policyMessage(policy, approved ? "approved" : "declined", appointmentTimeLabel(request.requested_start_at, timezone));
  const deliveries: JsonObject[] = [];
  try {
    const { sendProjectEmail, sendProjectSms } = await import("../comms/service.js");
    if (["sms", "both"].includes(policy.reschedule_customer_notification)) {
      const sent = await sendProjectSms(orgId, branchId, projectId, { text, source:{ type:"system", id:"appointment_reschedule_review" }, idempotency_key:`reschedule:${cleanText(request.id)}:${approved ? "approved" : "declined"}:sms` });
      deliveries.push({ channel:"sms", status:"sent", message_id:cleanText(asObject(sent.message).id) });
    }
    if (["email", "both"].includes(policy.reschedule_customer_notification)) {
      const sent = await sendProjectEmail(orgId, branchId, projectId, { subject:approved ? "Your appointment change is confirmed" : "Update on your appointment change", text, source:{ type:"system", id:"appointment_reschedule_review" }, idempotency_key:`reschedule:${cleanText(request.id)}:${approved ? "approved" : "declined"}:email` });
      deliveries.push({ channel:"email", status:"sent", message_id:cleanText(asObject(sent.message).id) });
    }
  } catch (error) {
    deliveries.push({ status:"failed", error:error instanceof Error ? error.message : cleanText(error) });
  }
  return deliveries;
}

export async function commitAppointmentReschedule(orgId: string, holdId: string, meta: JsonObject = {}) {
  const hold = (await readSlotHold(holdId));
  if (!hold || cleanText(hold.organization_id) !== cleanText(orgId)) throw conflict("appointment_hold_expired", "This time hold expired. Please choose the time again.");
  const document = await readDocument(orgId, "projects", cleanText(hold.project_id));
  const data = asObject(document.data);
  const events = asArray(data.events).map(asObject);
  const index = events.findIndex((event) => cleanText(event.id) === cleanText(hold.event_id));
  if (index < 0) throw notFound("appointment_not_found", "The appointment is no longer available.");
  const current = events[index]!;
  if (cleanText(asObject(current.reschedule_request).status) === "pending") throw conflict("appointment_reschedule_pending", "This appointment already has a change waiting for review.");
  const history = asArray(current.schedule_history).map(asObject);
  const date = localDateKey(new Date(hold.start_at), await resolveOrganizationTimezone(orgId, cleanText(hold.branch_id)));
  const availability = await appointmentAvailability(orgId, cleanText(hold.branch_id), {
    project_id: cleanText(hold.project_id),
    event_id: cleanText(hold.event_id),
    event_type_id: cleanText(hold.event_type_id),
    start_date: date,
    end_date: date,
    exclude_hold_id: cleanText(hold.id)
  });
  const policy = asObject(availability.policy) as CustomerSchedulingPolicy;
  if (!policy.enabled || !asArray(policy.actions).map(cleanText).includes("reschedule")) throw forbidden("customer_rescheduling_disabled", "This appointment cannot be rescheduled online.");
  if (Number(policy.max_reschedules) >= 0 && history.filter((entry) => cleanText(entry.action) === "customer_rescheduled").length >= Number(policy.max_reschedules)) {
    throw forbidden("appointment_reschedule_limit", "This appointment has reached its online rescheduling limit. Please contact the team.");
  }
  const slot = availability.slots.find((entry) => cleanText(asObject(entry).start_at) === cleanText(hold.start_at) && asObject(entry).available === true);
  if (!slot) throw conflict("appointment_slot_unavailable", "That appointment time was just taken. Choose another time.");
  const resourceKey = cleanText(hold.resource_key);
  const now = new Date().toISOString();
  const request: JsonObject = {
    id: `reschedule_${randomUUID()}`,
    status: "pending",
    original_start_at: cleanText(current.start_at),
    original_end_at: cleanText(current.end_at),
    requested_start_at: cleanText(hold.start_at),
    requested_end_at: cleanText(hold.end_at),
    resource_key: resourceKey,
    resource: asArray(asObject(slot).candidates).map(asObject).find((entry) => cleanText(entry.resource_key) === resourceKey) || {},
    requested_at: now,
    source: cleanText(meta.source) || cleanText(hold.source) || "customer_portal",
    actor: cleanText(meta.actor) || "customer"
  };
  const approvalRequired = policy.reschedule_approval === "required" && cleanText(meta.actor || "customer") !== "staff" && cleanText(meta.source) !== "staff";
  if (approvalRequired) {
    const nextEvent = {
      ...current,
      reschedule_request: request,
      schedule_history: [...history, { action:"customer_reschedule_requested", from_start_at:cleanText(current.start_at), to_start_at:cleanText(hold.start_at), source:request.source, actor:request.actor, request_id:request.id, at:now }]
    };
    events[index] = nextEvent;
    await upsertDocument(orgId, "projects", {
      id: cleanText(document.id),
      expected_revision: Number(document.revision || 0),
      data: { ...data, events, updated_at: now },
      metadata: document.metadata
    }, { replace: true });
    (await deleteSlotHold(cleanText(hold.id)));
    await createRescheduleStaffArtifacts(orgId, cleanText(hold.branch_id), cleanText(hold.project_id), data, nextEvent, request, policy);
    return { ok:true, status:"pending_approval", event:nextEvent, project_id:hold.project_id, hold_id:hold.id, request, message:policyMessage(policy, "requested", appointmentTimeLabel(hold.start_at, availability.timezone)) };
  }
  const nextEvent = applyAssignment({
    ...current,
    start_at: cleanText(hold.start_at),
    end_at: cleanText(hold.end_at),
    status: "scheduled",
    rescheduled_at: now,
    rescheduled_from: cleanText(current.start_at),
    schedule_history: [...history, {
      action: "customer_rescheduled",
      from_start_at: cleanText(current.start_at),
      to_start_at: cleanText(hold.start_at),
      source: cleanText(meta.source) || cleanText(hold.source) || "customer_portal",
      actor: cleanText(meta.actor) || "customer",
      request_id: cleanText(request.id),
      at: now
    }],
    confirmation: {
      ...asObject(current.confirmation),
      status: asObject(current.confirmation).required === true ? "pending" : "not_required",
      confirmed_at: "",
      declined_at: "",
      response_text: ""
    }
  }, resourceKey, asArray(asObject(slot).candidates).map(asObject));
  events[index] = nextEvent;
  await upsertDocument(orgId, "projects", {
    id: cleanText(document.id),
    expected_revision: Number(document.revision || 0),
    data: { ...data, events, updated_at: new Date().toISOString() },
    metadata: document.metadata
  }, { replace: true });
  (await deleteSlotHold(cleanText(hold.id)));
  await createRescheduleStaffArtifacts(orgId, cleanText(hold.branch_id), cleanText(hold.project_id), data, nextEvent, { ...request, status:"approved" }, policy);
  try {
    const { syncAppointmentConfirmation } = await import("./service.js");
    const confirmation = await syncAppointmentConfirmation(orgId, cleanText(hold.branch_id), cleanText(hold.project_id), nextEvent, data);
    // An appointment that was explicitly confirmation-required stays pending
    // after a move even if the company later disabled the global default.
    if (asObject(current.confirmation).required !== true || asObject(confirmation).required === true) nextEvent.confirmation = confirmation;
  } catch { /* The reschedule remains valid; the confirmation tick can reconcile later. */ }
  return { ok: true, status:"committed", event: nextEvent, project_id: hold.project_id, hold_id: hold.id };
}

export async function reviewAppointmentReschedule(orgId: string, projectId: string, eventId: string, decision: "approved" | "declined", meta: JsonObject = {}) {
  const document = await readDocument(orgId, "projects", projectId);
  const data = asObject(document.data);
  const events = asArray(data.events).map(asObject);
  const index = events.findIndex((event) => cleanText(event.id) === eventId);
  if (index < 0) throw notFound("appointment_not_found", "The appointment is no longer available.");
  const current = events[index]!;
  const request = asObject(current.reschedule_request);
  if (cleanText(request.status) !== "pending") throw conflict("reschedule_review_not_pending", "This appointment does not have a change waiting for review.");
  const branchId = cleanText(meta.branch_id || data.branch_id || "default") || "default";
  const availability = await appointmentAvailability(orgId, branchId, {
    project_id: projectId,
    event_id: eventId,
    event_type_id: cleanText(current.event_type_default_id || current.type_id),
    start_date: localDateKey(new Date(cleanText(request.requested_start_at)), await resolveOrganizationTimezone(orgId, branchId)),
    end_date: localDateKey(new Date(cleanText(request.requested_start_at)), await resolveOrganizationTimezone(orgId, branchId)),
    exclude_reschedule_request_id: cleanText(request.id)
  });
  const policy = asObject(availability.policy) as CustomerSchedulingPolicy;
  const now = new Date().toISOString();
  let nextEvent: JsonObject;
  if (decision === "approved") {
    const slot = availability.slots.find((entry) => cleanText(asObject(entry).start_at) === cleanText(request.requested_start_at) && asObject(entry).available === true);
    if (!slot) throw conflict("appointment_slot_unavailable", "That requested time is no longer available. Decline the request or ask the customer to choose another time.");
    nextEvent = applyAssignment({
      ...current,
      start_at: cleanText(request.requested_start_at),
      end_at: cleanText(request.requested_end_at),
      status: "scheduled",
      rescheduled_at: now,
      rescheduled_from: cleanText(request.original_start_at),
      reschedule_request: { ...request, status:"approved", reviewed_at:now, reviewed_by:cleanText(meta.actor), review_note:cleanText(meta.note) },
      schedule_history: [...asArray(current.schedule_history).map(asObject), { action:"customer_reschedule_approved", from_start_at:cleanText(request.original_start_at), to_start_at:cleanText(request.requested_start_at), request_id:cleanText(request.id), actor:cleanText(meta.actor), at:now }],
      confirmation: { ...asObject(current.confirmation), status:asObject(current.confirmation).required === true ? "pending" : "not_required", confirmed_at:"", declined_at:"", response_text:"" }
    }, cleanText(request.resource_key), asArray(asObject(slot).candidates).map(asObject));
  } else {
    nextEvent = {
      ...current,
      reschedule_request: { ...request, status:"declined", reviewed_at:now, reviewed_by:cleanText(meta.actor), review_note:cleanText(meta.note) },
      schedule_history: [...asArray(current.schedule_history).map(asObject), { action:"customer_reschedule_declined", from_start_at:cleanText(request.original_start_at), to_start_at:cleanText(request.requested_start_at), request_id:cleanText(request.id), actor:cleanText(meta.actor), at:now }]
    };
  }
  events[index] = nextEvent;
  await upsertDocument(orgId, "projects", { id:projectId, expected_revision:Number(document.revision || 0), data:{ ...data, events, updated_at:now }, metadata:document.metadata }, { replace:true });
  await resolveRescheduleReviewTodo(orgId, projectId, cleanText(request.id), decision, cleanText(meta.actor));
  const customer_deliveries = await sendRescheduleDecision(orgId, branchId, projectId, request, policy, decision === "approved");
  if (decision === "approved") {
    try { const { syncAppointmentConfirmation } = await import("./service.js"); await syncAppointmentConfirmation(orgId, branchId, projectId, nextEvent, data); } catch { /* reconciliation will retry */ }
  }
  return { ok:true, status:decision, event:nextEvent, project_id:projectId, request:{ ...request, status:decision }, customer_deliveries };
}

export async function cancelAppointmentRescheduleRequest(orgId: string, projectId: string, eventId: string, meta: JsonObject = {}) {
  const document = await readDocument(orgId, "projects", projectId);
  const data = asObject(document.data);
  const events = asArray(data.events).map(asObject);
  const index = events.findIndex((event) => cleanText(event.id) === eventId);
  if (index < 0) throw notFound("appointment_not_found", "The appointment is no longer available.");
  const current = events[index]!;
  const request = asObject(current.reschedule_request);
  if (cleanText(request.status) !== "pending") throw conflict("reschedule_request_not_pending", "This appointment change can no longer be canceled.");
  const branchId = cleanText(meta.branch_id || data.branch_id || "default") || "default";
  const { scheduling } = await readSchedulingAvailabilitySettings(orgId, branchId);
  const eventType = asObject(asObject(scheduling.event_types)[cleanText(current.event_type_default_id || current.type_id) || "sales_appointment"]);
  const activeScope = asArray(asObject(data.work_projection).active_instances).map(asObject)[0] || {};
  const scopeTemplateId = cleanText(current.scope_template_id || data.scope_template_id || data.sales_scope_template_id || activeScope.template_id || activeScope.scope_template_id);
  const scopeTemplate = scopeTemplateId ? asObject((await Promise.resolve().then(async () => (await readScopeTemplate(orgId, branchId, scopeTemplateId))).catch(() => null))?.definition) : {};
  const policy = effectiveCustomerSchedulingPolicy({ ...current, customer_scheduling:{ ...asObject(scopeTemplate.customer_scheduling), ...asObject(current.customer_scheduling) } }, eventType, scheduling);
  const now = new Date().toISOString();
  const canceledRequest = { ...request, status:"canceled", canceled_at:now, canceled_by:cleanText(meta.actor) || "customer" };
  const nextEvent = {
    ...current,
    reschedule_request:canceledRequest,
    schedule_history:[...asArray(current.schedule_history).map(asObject), {
      action:"customer_reschedule_request_canceled",
      from_start_at:cleanText(request.original_start_at),
      to_start_at:cleanText(request.requested_start_at),
      request_id:cleanText(request.id),
      source:cleanText(meta.source) || "customer_portal",
      actor:cleanText(meta.actor) || "customer",
      at:now
    }]
  };
  events[index] = nextEvent;
  await upsertDocument(orgId, "projects", { id:projectId, expected_revision:Number(document.revision || 0), data:{ ...data, events, updated_at:now }, metadata:document.metadata }, { replace:true });
  await resolveRescheduleReviewTodo(orgId, projectId, cleanText(request.id), "canceled", cleanText(meta.actor) || "customer");
  if (policy.reschedule_staff_notification) {
    try {
      const timezone = await resolveOrganizationTimezone(orgId, branchId);
      const { createPlatformNotification } = await import("../platform/api.js");
      await createPlatformNotification(orgId, {
        id:`notification_reschedule_canceled_${cleanText(request.id)}`,
        title:`${customerName(data)} canceled an appointment change request`,
        body:`The request to move ${cleanText(current.title) || "the appointment"} to ${appointmentTimeLabel(request.requested_start_at, timezone)} was canceled. The original appointment remains scheduled.`,
        kind:"appointment_reschedule_canceled",
        channel:"passive",
        push:true,
        manual_dismissible:true,
        branch_id:branchId,
        source:"appointment_rescheduling",
        target_role_ids:policy.reschedule_review_role_ids,
        frontend_action:{ kind:"open_project", project_id:projectId, tab:"schedule", event_id:eventId },
        context:{ project_id:projectId, event_id:eventId, reschedule_request_id:cleanText(request.id) }
      });
    } catch (error) { console.error("appointment reschedule cancellation notification failed", error); }
  }
  return { ok:true, status:"canceled", event:nextEvent, project_id:projectId, request:canceledRequest };
}

export function publicSchedulingPolicy(eventValue: unknown, eventTypeValue: unknown, schedulingValue: unknown) {
  const policy = effectiveCustomerSchedulingPolicy(eventValue, eventTypeValue, schedulingValue);
  return {
    enabled: policy.enabled,
    actions: policy.actions,
    min_notice_minutes: policy.min_notice_minutes,
    booking_horizon_days: policy.booking_horizon_days,
    max_reschedules: policy.max_reschedules,
    assignment_mode: policy.assignment_mode,
    reschedule_approval: policy.reschedule_approval,
    reschedule_customer_notification: policy.reschedule_customer_notification
  };
}

export function slotHoldView(hold: AppointmentSlotHold) {
  return {
    id: hold.id,
    start_at: hold.start_at,
    end_at: hold.end_at,
    expires_at: hold.expires_at,
    resource_key: hold.resource_key
  };
}
