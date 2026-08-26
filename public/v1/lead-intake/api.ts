import { randomBytes } from "node:crypto";

import type { FastifyPluginAsync } from "fastify";
import { ZodError, z } from "zod";

import { isAppFlagEnabled } from "../platform/app_flags.js";
import { requirePlatformAuth } from "../platform/auth.js";
import { PlatformError, badRequest, forbidden, notFound } from "../platform/errors.js";
import { createPlatformLead } from "../platform/api.js";
import { escapeEmailHtml, sendTransactionalEmail } from "../email/outbound.js";
import { measureSolarRoof, previewSolarProperty } from "./solar.js";
import {
  listDocuments,
  listOrganizations,
  readBranchModule,
  saveBranchModule,
  type JsonObject
} from "../platform/storage.js";

const LEAD_INTAKE_MODULE_ID = "lead_intake";
const LEGACY_LEAD_IMPORT_MODULE_ID = "lead_import";
const SCHEDULING_MODULE_ID = "scheduling";
const STAGES_MODULE_ID = "stages";
const VARIABLE_MAPPING_MODULE_ID = "variable_mappings";
const DEFAULT_BRANCH_ID = "default";
const NEW_LEAD_STAGE_ID = "new_lead";
const DEFAULT_NOTIFICATION_ROLES = ["inside_sales", "sales_appointments"];
const DEFAULT_WEBSITE_FORM_FONT = "Montserrat";
const WEBSITE_FORM_FONTS = ["Montserrat", "Inter", "Roboto", "Open Sans", "Lato", "Poppins", "Source Sans 3"];

type EmbeddableFormAssignment = {
  orgId: string;
  branchId: string;
  data: JsonObject;
  form: JsonObject;
};

const objectBodySchema = z.object({}).passthrough();

function asObject(value: unknown): JsonObject {
  return value && typeof value === "object" && !Array.isArray(value) ? { ...(value as JsonObject) } : {};
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function cleanText(value: unknown) {
  return String(value ?? "").trim();
}

function normalizeEmail(value: unknown) {
  const email = cleanText(value).toLowerCase();
  return /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email) ? email : "";
}

function normalizeStringArray(value: unknown) {
  return [...new Set(asArray(value).map(cleanText).filter(Boolean))];
}

function nowIso() {
  return new Date().toISOString();
}

function generatedFormId() {
  return `form_${Date.now().toString(36)}${randomBytes(6).toString("hex")}`;
}

function getParam(params: unknown, key: string) {
  return cleanText(asObject(params)[key]);
}

function normalizeHexColor(value: unknown, fallback: string) {
  const raw = cleanText(value);
  return /^#[0-9a-f]{6}$/i.test(raw) ? raw : fallback;
}

function normalizeFormMode(value: unknown) {
  const mode = cleanText(value).toLowerCase().replace(/[^a-z0-9_-]+/g, "_").replace(/^_+|_+$/g, "");
  return mode || "appointment";
}

function defaultCopyForMode(mode: string, copy: JsonObject) {
  const isCall = mode === "call";
  const isEstimate = mode === "instant_estimate";
  const isSubmit = mode === "submit_form";
  return {
    headline: cleanText(copy.headline) || (isEstimate ? "Get a free instant estimate" : isSubmit ? "Tell us about your project" : isCall ? "Schedule a quick call" : "Schedule an appointment"),
    subheadline: cleanText(copy.subheadline) || (isEstimate ? "Answer a few questions and preview your project range." : "Tell us where to reach you and we will confirm the next step."),
    submit_label: cleanText(copy.submit_label) || (isEstimate ? "Get my estimate" : isSubmit ? "Submit request" : isCall ? "Request Call" : "Request Appointment"),
    fine_print: cleanText(copy.fine_print) || "By submitting, you agree to be contacted about your request.",
    success_title: cleanText(copy.success_title) || (isEstimate ? "Estimate ready" : "Request received"),
    success_body: cleanText(copy.success_body) || "We have your information and will follow up shortly.",
    start_label: cleanText(copy.start_label) || "Get started"
  };
}

export function normalizeEmbeddableForm(input: JsonObject = {}) {
  const mode = normalizeFormMode(input.mode);
  const copy = asObject(input.copy);
  const style = asObject(input.style);
  const scheduling = asObject(input.scheduling);
  const now = nowIso();
  return {
    schema_version: 1,
    id: cleanText(input.id) || generatedFormId(),
    enabled: input.enabled !== false,
    name: cleanText(input.name) || (mode === "instant_estimate" ? "Instant Estimate Form" : mode === "submit_form" ? "Submit Form" : mode === "call" ? "Website Call Request" : "Website Appointment Form"),
    tracking_key: cleanText(input.tracking_key || input.name || input.id) || "website-form",
    mode,
    copy: defaultCopyForMode(mode, copy),
    style: {
      primary_color: normalizeHexColor(style.primary_color, "#d93025"),
      secondary_color: normalizeHexColor(style.secondary_color, "#111827"),
      background_color: normalizeHexColor(style.background_color, "#ffffff"),
      text_color: normalizeHexColor(style.text_color, "#111827"),
      font_family: WEBSITE_FORM_FONTS.includes(cleanText(style.font_family)) ? cleanText(style.font_family) : DEFAULT_WEBSITE_FORM_FONT,
      use_company_colors: style.use_company_colors !== false,
      logo_enabled: style.logo_enabled === true,
      logo_url: cleanText(style.logo_url)
    },
    scheduling: {
      event_type_default_id: cleanText(scheduling.event_type_default_id) || (mode === "call" ? "contact_call" : "sales_appointment"),
      duration_minutes: Math.max(15, Math.min(240, Number(scheduling.duration_minutes || (mode === "call" ? 30 : 60)) || 60)),
      slot_minutes: Math.max(15, Math.min(120, Number(scheduling.slot_minutes || 30) || 30)),
      buffer_minutes: Math.max(0, Math.min(240, Number(scheduling.buffer_minutes || scheduling.travel_buffer_minutes || 30) || 0)),
      min_notice_minutes: Math.max(0, Math.min(10080, Number(scheduling.min_notice_minutes || 120) || 0)),
      available_days: Array.isArray(scheduling.available_days) && scheduling.available_days.length
        ? scheduling.available_days.map((day) => Number(day)).filter((day) => day >= 0 && day <= 6)
        : [1, 2, 3, 4, 5],
      start_time: /^\d{2}:\d{2}$/.test(cleanText(scheduling.start_time)) ? cleanText(scheduling.start_time) : "09:00",
      end_time: /^\d{2}:\d{2}$/.test(cleanText(scheduling.end_time)) ? cleanText(scheduling.end_time) : "17:00",
      required_role_ids: normalizeStringArray(scheduling.required_role_ids),
      allowed_role_ids: normalizeStringArray(scheduling.allowed_role_ids).length ? normalizeStringArray(scheduling.allowed_role_ids) : [mode === "call" ? "inside_sales" : "sales_appointments"]
    },
    fields: Array.isArray(input.fields) ? input.fields.map(asObject) : [],
    pages: Array.isArray(input.pages) ? input.pages.map(asObject) : [],
    questions: Array.isArray(input.questions) ? input.questions.map(asObject) : [],
    estimate: asObject(input.estimate),
    actions: asObject(input.actions),
    metadata: asObject(input.metadata),
    created_at: cleanText(input.created_at) || now,
    updated_at: now
  };
}

function normalizeEmbeddableForms(value: unknown) {
  return asArray(value).map(asObject).map(normalizeEmbeddableForm);
}

async function requireEmbeddableFormsFlag(orgId: string) {
  if (!(await isAppFlagEnabled(orgId, "platform", "website_embed_import"))) {
    throw forbidden("app_flag_disabled", "Website embeddable forms are not enabled for this organization.");
  }
}

function formCapabilityForMode(modeValue: unknown) {
  const mode = normalizeFormMode(modeValue);
  if (mode === "instant_estimate") return { group: "lead_forms", flag: "instant_estimate", label: "Instant estimate forms" };
  if (mode === "submit_form") return { group: "lead_forms", flag: "contact_form", label: "Contact forms" };
  return { group: "lead_forms", flag: "appointment_form", label: "Appointment forms" };
}

async function requireFormCapability(orgId: string, form: JsonObject) {
  const capability = formCapabilityForMode(form.mode);
  if (!(await isAppFlagEnabled(orgId, capability.group, capability.flag))) {
    throw forbidden("app_flag_disabled", `${capability.label} are not enabled for this organization.`);
  }
}

async function requireFormCapabilities(orgId: string, forms: JsonObject[]) {
  const modes = new Set(forms.map((form) => normalizeFormMode(form.mode)));
  for (const mode of modes) {
    await requireFormCapability(orgId, { mode });
  }
}

async function readLegacyLeadImportModule(orgId: string, branchId: string) {
  try {
    return await readBranchModule(orgId, branchId, LEGACY_LEAD_IMPORT_MODULE_ID);
  } catch {
    return null;
  }
}

async function removeLegacyWebsiteForms(orgId: string, branchId: string, legacyModule: JsonObject) {
  const legacyData = asObject(legacyModule.data);
  if (!Object.prototype.hasOwnProperty.call(legacyData, "website_forms")) return;
  const { website_forms: _removed, ...nextData } = legacyData;
  await saveBranchModule(orgId, branchId, LEGACY_LEAD_IMPORT_MODULE_ID, {
    data: nextData,
    metadata: {
      ...asObject(legacyModule.metadata),
      source: "lead_intake_migration"
    }
  }, { replace: true });
}

export async function ensureLeadIntakeSettings(orgId: string, branchId = DEFAULT_BRANCH_ID) {
  let existing: JsonObject | null = null;
  try {
    existing = await readBranchModule(orgId, branchId, LEAD_INTAKE_MODULE_ID);
  } catch {
    existing = null;
  }

  const legacy = await readLegacyLeadImportModule(orgId, branchId);
  const existingData = asObject(existing?.data);
  const legacyData = asObject(legacy?.data);
  const sourceForms = Array.isArray(existingData.forms)
    ? existingData.forms
    : Array.isArray(legacyData.website_forms)
      ? legacyData.website_forms
      : [];
  const now = nowIso();
  const data = {
    schema_version: 1,
    enabled: existingData.enabled ?? true,
    project_stage_id: cleanText(existingData.project_stage_id || legacyData.project_stage_id) || NEW_LEAD_STAGE_ID,
    notification_target_role_ids: Array.isArray(existingData.notification_target_role_ids)
      ? existingData.notification_target_role_ids
      : Array.isArray(legacyData.notification_target_role_ids)
        ? legacyData.notification_target_role_ids
        : DEFAULT_NOTIFICATION_ROLES,
    forms: normalizeEmbeddableForms(sourceForms),
    created_at: cleanText(existingData.created_at) || now,
    updated_at: now
  };

  const module = await saveBranchModule(orgId, branchId, LEAD_INTAKE_MODULE_ID, {
    data,
    metadata: { kind: "branch_lead_intake", source: existing ? "lead_intake_api" : "lead_intake_migration" }
  }, { replace: true });

  if (legacy) await removeLegacyWebsiteForms(orgId, branchId, legacy);
  return { module, data };
}

export async function patchLeadIntakeSettings(orgId: string, branchId: string, patch: JsonObject) {
  const { data: current } = await ensureLeadIntakeSettings(orgId, branchId);
  const nextForms = Array.isArray(patch.forms)
    ? normalizeEmbeddableForms(patch.forms)
    : Array.isArray(patch.website_forms)
      ? normalizeEmbeddableForms(patch.website_forms)
      : current.forms;
  await requireFormCapabilities(orgId, nextForms.map(asObject));
  const next = {
    ...current,
    enabled: patch.enabled === undefined ? current.enabled : patch.enabled !== false,
    project_stage_id: patch.project_stage_id === undefined ? current.project_stage_id : cleanText(patch.project_stage_id) || NEW_LEAD_STAGE_ID,
    notification_target_role_ids: Array.isArray(patch.notification_target_role_ids) ? patch.notification_target_role_ids.map(cleanText).filter(Boolean) : current.notification_target_role_ids,
    forms: nextForms,
    updated_at: nowIso()
  };
  const module = await saveBranchModule(orgId, branchId, LEAD_INTAKE_MODULE_ID, {
    data: next,
    metadata: { kind: "branch_lead_intake", source: "lead_intake_api" }
  }, { replace: true });
  return { module, data: next };
}

async function findEmbeddableFormAssignment(formId: string): Promise<EmbeddableFormAssignment | null> {
  const targetId = cleanText(formId);
  if (!targetId) return null;
  const orgs = await listOrganizations();
  for (const org of orgs) {
    const orgId = cleanText(asObject(org).id);
    if (!orgId) continue;
    let branches: JsonObject[] = [];
    try {
      branches = await listDocuments(orgId, "branch");
    } catch {
      branches = [];
    }
    if (!branches.length) branches = [{ id: DEFAULT_BRANCH_ID }];
    for (const branchDoc of branches) {
      const branchId = cleanText(branchDoc.id) || DEFAULT_BRANCH_ID;
      try {
        const { data } = await ensureLeadIntakeSettings(orgId, branchId);
        const form = asArray(data.forms).map(asObject).find((entry) => cleanText(entry.id) === targetId);
        if (form) return { orgId, branchId, data, form };
      } catch {
        // Missing or malformed branch data for one org should not break public lookup.
      }
    }
  }
  return null;
}

function publicEmbeddableForm(form: JsonObject) {
  const normalized = normalizeEmbeddableForm(form);
  return {
    id: normalized.id,
    enabled: normalized.enabled,
    name: normalized.name,
    tracking_key: normalized.tracking_key,
    mode: normalized.mode,
    copy: normalized.copy,
    style: normalized.style,
    scheduling: normalized.scheduling,
    fields: Array.isArray(normalized.fields) && normalized.fields.length
      ? normalized.fields
      : {
          name: { required: true },
          email: { required: false },
          phone: { required: true },
          address: { required: false },
          message: { required: false },
          preferred_start_at: { required: false }
        },
    pages: normalized.pages,
    questions: normalized.questions,
    estimate: normalized.estimate,
    actions: normalized.actions
  };
}

async function readSchedulingData(orgId: string, branchId: string) {
  try {
    const module = await readBranchModule(orgId, branchId, SCHEDULING_MODULE_ID);
    return asObject(module.data);
  } catch {
    return {};
  }
}

function minutesFromTime(value: unknown) {
  const match = cleanText(value).match(/^(\d{1,2}):(\d{2})/);
  if (!match) return 0;
  return Math.max(0, Math.min(24 * 60, Number(match[1]) * 60 + Number(match[2])));
}

function timeFromMinutes(value: number) {
  const mins = Math.max(0, Math.min(24 * 60 - 1, Number(value) || 0));
  return `${String(Math.floor(mins / 60)).padStart(2, "0")}:${String(mins % 60).padStart(2, "0")}`;
}

function dateInput(value: unknown) {
  const date = new Date(cleanText(value) || Date.now());
  if (!Number.isFinite(date.getTime())) return new Date().toISOString().slice(0, 10);
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}

function dateAtTime(date: string, time: string) {
  return new Date(`${date}T${time}:00`);
}

function intervalsOverlap(startA: Date, endA: Date, startB: Date, endB: Date) {
  return startA < endB && startB < endA;
}

function eventTypeFromScheduling(schedulingData: JsonObject, form: JsonObject) {
  const formScheduling = asObject(form.scheduling);
  const formMode = cleanText(form.mode) || "appointment";
  const eventTypeId = cleanText(formScheduling.event_type_default_id) || (formMode === "call" ? "contact_call" : "sales_appointment");
  const eventTypes = asObject(schedulingData.event_types);
  const eventType = asObject(eventTypes[eventTypeId]);
  const requiredRoleIds = normalizeStringArray(eventType.required_role_ids || formScheduling.required_role_ids || eventType.role_ids || formScheduling.role_ids || (eventTypeId === "sales_appointment" ? ["sales_appointments"] : []));
  const allowedRoleIds = normalizeStringArray(eventType.allowed_role_ids || formScheduling.allowed_role_ids || eventType.role_ids || formScheduling.role_ids || requiredRoleIds);
  const duration = Math.max(15, Math.min(240, Number(eventType.duration_minutes || asObject(schedulingData.availability).sales_appointment_duration_minutes || formScheduling.duration_minutes || (formMode === "call" ? 30 : 60)) || 60));
  const slotMinutes = Math.max(15, Math.min(120, Number(eventType.slot_minutes || asObject(schedulingData.availability).sales_appointment_slot_minutes || formScheduling.slot_minutes || 30) || 30));
  const bufferMinutes = Math.max(0, Math.min(240, Number(eventType.buffer_minutes || asObject(schedulingData.availability).sales_appointment_buffer_minutes || formScheduling.buffer_minutes || 30) || 0));
  return { id: eventTypeId, requiredRoleIds, allowedRoleIds, duration, slotMinutes, bufferMinutes };
}

function branchAvailabilityWindow(schedulingData: JsonObject, form: JsonObject, date: string, eventTypeId: string) {
  const availability = asObject(schedulingData.availability);
  const formScheduling = asObject(form.scheduling);
  const targetDay = dateAtTime(date, "12:00").getDay();
  const workingHours = asArray(availability.working_hours).map(asObject);
  const matching = workingHours.find((entry) => asArray(entry.days).map(Number).includes(targetDay)) || workingHours[0] || {};
  const eventWindows = asObject(availability.event_type_windows);
  const eventWindow = asObject(eventWindows[eventTypeId]);
  const startRaw = cleanText(eventWindow.start || eventWindow.start_time || matching.start || matching.start_time || availability[`${eventTypeId}_start_time`] || availability.sales_appointment_start_time || formScheduling.start_time || "09:00");
  const endRaw = cleanText(eventWindow.end || eventWindow.end_time || matching.end || matching.end_time || availability[`${eventTypeId}_end_time`] || availability.sales_appointment_end_time || formScheduling.end_time || "17:00");
  const days = asArray(matching.days).length ? asArray(matching.days).map(Number) : (Array.isArray(formScheduling.available_days) ? formScheduling.available_days.map(Number) : [1, 2, 3, 4, 5]);
  return {
    start: timeFromMinutes(minutesFromTime(startRaw || "09:00")),
    end: timeFromMinutes(minutesFromTime(endRaw || "17:00")),
    days
  };
}

function normalizeUserForAvailability(document: JsonObject) {
  const data = asObject(document.data || document);
  const roles = normalizeStringArray(data.roles);
  const role = cleanText(data.role || data.permission_level).toLowerCase();
  const adminRoles = ["owner", "admin", "super_admin"].includes(role) ? ["sales_appointments", "inside_sales"] : [];
  return {
    id: cleanText(document.id || data.id),
    name: cleanText(data.name || data.full_name || data.email),
    email: cleanText(data.email),
    status: cleanText(data.status),
    roles: roles.length ? roles : adminRoles
  };
}

function normalizeEventForAvailability(event: JsonObject, project: JsonObject) {
  const start = new Date(cleanText(event.start_at || event.start || event.starts_at));
  const duration = Math.max(1, Number(event.duration_minutes || event.duration || 60));
  const assignedUserIds = normalizeStringArray([event.assigned_user_id, event.user_id, ...asArray(event.assigned_user_ids), ...asArray(event.user_ids)]);
  const requiredRoleIds = normalizeStringArray(event.required_role_ids || event.role_ids || event.roles);
  const allowedRoleIds = normalizeStringArray(event.allowed_role_ids || event.role_ids || event.roles || requiredRoleIds);
  return {
    id: cleanText(event.id),
    start,
    end: new Date(start.getTime() + duration * 60000),
    assignedUserIds,
    requiredRoleIds,
    allowedRoleIds,
    projectId: cleanText(project.id)
  };
}

function roleAvailability(users: ReturnType<typeof normalizeUserForAvailability>[], events: ReturnType<typeof normalizeEventForAvailability>[], roleId: string, start: Date, duration: number, bufferMinutes = 0) {
  const end = new Date(start.getTime() + duration * 60000);
  const conflictStart = new Date(start.getTime() - Math.max(0, bufferMinutes) * 60000);
  const conflictEnd = new Date(end.getTime() + Math.max(0, bufferMinutes) * 60000);
  const roleUsers = users.filter((user) => user.status !== "disabled" && user.roles.includes(roleId));
  const overlapping = events.filter((event) => Number.isFinite(event.start.getTime()) && intervalsOverlap(conflictStart, conflictEnd, event.start, event.end));
  const busyAssigned = new Set(overlapping.flatMap((event) => event.assignedUserIds));
  const unassignedRoleConflicts = overlapping.filter((event) => !event.assignedUserIds.length && [...event.requiredRoleIds, ...event.allowedRoleIds].includes(roleId)).length;
  const availableUsers = roleUsers.filter((user) => !busyAssigned.has(user.id));
  return {
    role_id: roleId,
    available_count: Math.max(0, availableUsers.length - unassignedRoleConflicts),
    eligible_count: roleUsers.length,
    available_user_ids: availableUsers.map((user) => user.id)
  };
}

export async function embeddableFormAvailability(assignment: EmbeddableFormAssignment, query: JsonObject) {
  const form = normalizeEmbeddableForm(assignment.form);
  const schedulingData = await readSchedulingData(assignment.orgId, assignment.branchId);
  const eventType = eventTypeFromScheduling(schedulingData, form);
  const date = dateInput(query.date);
  const window = branchAvailabilityWindow(schedulingData, form, date, eventType.id);
  const stepMinutes = eventType.slotMinutes;
  const minNoticeMinutes = Math.max(0, Math.min(10080, Number(asObject(form.scheduling).min_notice_minutes || 120) || 0));
  const minTime = Date.now() + minNoticeMinutes * 60000;
  const users = (await listDocuments(assignment.orgId, "users")).map(normalizeUserForAvailability);
  const projects = await listDocuments(assignment.orgId, "projects");
  const events = projects.flatMap((document) => {
    const project = asObject({ ...asObject(document.data), id: cleanText(document.id) });
    return asArray(project.events).map(asObject).map((event) => normalizeEventForAvailability(event, project));
  });
  const slots = [];
  if (window.days.includes(dateAtTime(date, "12:00").getDay())) {
    for (let minute = minutesFromTime(window.start); minute + eventType.duration <= minutesFromTime(window.end); minute += stepMinutes) {
      const time = timeFromMinutes(minute);
      const start = dateAtTime(date, time);
      if (start.getTime() <= minTime) continue;
      const required = eventType.requiredRoleIds.map((roleId) => roleAvailability(users, events, roleId, start, eventType.duration, eventType.bufferMinutes));
      const allowed = eventType.allowedRoleIds.map((roleId) => roleAvailability(users, events, roleId, start, eventType.duration, eventType.bufferMinutes));
      const requiredOk = required.every((entry) => entry.available_count > 0);
      const allowedOk = allowed.length ? allowed.some((entry) => entry.available_count > 0) : true;
      const available = required.length ? requiredOk : allowedOk;
      slots.push({
        start: start.toISOString(),
        time,
        label: start.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" }),
        available,
        hasAvailability: available,
        eligible_count: Math.max(...allowed.map((entry) => entry.eligible_count), ...required.map((entry) => entry.eligible_count), 0),
        available_count: Math.max(...allowed.map((entry) => entry.available_count), ...required.map((entry) => entry.available_count), 0)
      });
    }
  }
  return {
    ok: true,
    form_id: form.id,
    date,
    event_type_id: eventType.id,
    duration_minutes: eventType.duration,
    slot_minutes: eventType.slotMinutes,
    buffer_minutes: eventType.bufferMinutes,
    window,
    slots
  };
}

function normalizePreferredStart(value: unknown) {
  const raw = cleanText(value);
  if (!raw) return "";
  const date = new Date(raw);
  return Number.isFinite(date.getTime()) ? date.toISOString() : "";
}

function money(value: number) {
  return Math.round(value);
}

function estimateNumber(value: unknown, fallback: number) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : fallback;
}

function estimatePayloadValue(body: JsonObject, key: string) {
  const answers = asObject(body.answers);
  return body[key] ?? body[key.replace(/_([a-z])/g, (_match, letter: string) => letter.toUpperCase())] ?? answers[key];
}

function instantEstimateFromMeasurement(form: JsonObject, body: JsonObject, measurement: JsonObject) {
  const estimate = asObject(form.estimate);
  const defaultSqft = estimateNumber(estimate.default_sqft, 2200);
  const measuredSqft = estimateNumber(measurement.roof_area_sqft, 0);
  const wasteFactor = Math.max(0, Math.min(100, Number(estimate.waste_factor_percent ?? 0) || 0));
  const sqft = Math.round((measuredSqft || defaultSqft) * (1 + wasteFactor / 100));
  const lowRate = estimateNumber(estimate.low_price_sqft, 6.75);
  const highRate = Math.max(lowRate, estimateNumber(estimate.high_price_sqft, 11.5));
  const minPrice = Math.max(0, Number(estimate.min_price ?? 0) || 0);
  const low = Math.max(minPrice, money(sqft * lowRate));
  const high = Math.max(low, money(sqft * highRate));
  return {
    status: "ready",
    currency: cleanText(estimate.currency) || "USD",
    low,
    high,
    low_price: low,
    high_price: high,
    roof_area_sqft: sqft,
    measured_roof_area_sqft: measuredSqft || null,
    default_roof_area_sqft: defaultSqft,
    price_per_sqft: { low: lowRate, high: highRate },
    waste_factor_percent: wasteFactor,
    source: measurement.ok === true ? cleanText(measurement.source) || "google_solar" : "fallback"
  };
}

function formatCurrency(value: unknown, currency = "USD") {
  const number = Number(value);
  if (!Number.isFinite(number)) return "";
  return new Intl.NumberFormat("en-US", { style: "currency", currency, maximumFractionDigits: 0 }).format(number);
}

function buildInstantEstimateEmail(form: JsonObject, body: JsonObject, result: JsonObject) {
  const copy = asObject(form.copy);
  const estimateSettings = asObject(form.estimate);
  const estimate = asObject(result.estimate);
  const measurement = asObject(result.measurement);
  const name = cleanText(body.name || body.customer_name);
  const address = cleanText(body.address);
  const currency = cleanText(estimate.currency) || "USD";
  const low = formatCurrency(estimate.low, currency);
  const high = formatCurrency(estimate.high, currency);
  const range = low && high ? `${low} - ${high}` : "your custom range";
  const subject = cleanText(estimateSettings.email_subject) || `Your instant estimate${address ? ` for ${address}` : ""}`;
  const intro = cleanText(estimateSettings.email_intro) || `Thanks${name ? `, ${name}` : ""}. Based on your submission, your preliminary project range is ${range}.`;
  const disclaimer = cleanText(estimateSettings.disclaimer) || cleanText(copy.fine_print) || "This is a preliminary estimate. Final pricing may change after inspection, measurements, materials, and scope review.";
  const ctaLabel = cleanText(estimateSettings.email_cta_label || estimateSettings.cta_label);
  const ctaUrl = cleanText(estimateSettings.email_cta_url || estimateSettings.cta_url);
  const details = [
    address ? `Address: ${address}` : "",
    `Estimated range: ${range}`,
    Number(estimate.roof_area_sqft) ? `Estimated roof area: ${estimate.roof_area_sqft} sq ft` : "",
    cleanText(measurement.imagery_quality) ? `Imagery quality: ${cleanText(measurement.imagery_quality)}` : ""
  ].filter(Boolean);
  const textBody = [
    intro,
    details.join("\n"),
    ctaLabel && ctaUrl ? `${ctaLabel}: ${ctaUrl}` : "",
    disclaimer
  ].filter(Boolean).join("\n\n");
  const htmlDetails = details.map((line) => `<li>${escapeEmailHtml(line)}</li>`).join("");
  const htmlBody = [
    `<div style="font-family:Arial,sans-serif;color:#111827;">`,
    `<p style="font-size:16px;line-height:1.5;">${escapeEmailHtml(intro)}</p>`,
    htmlDetails ? `<ul style="font-size:15px;line-height:1.6;">${htmlDetails}</ul>` : "",
    ctaLabel && ctaUrl ? `<p><a href="${escapeEmailHtml(ctaUrl)}" style="display:inline-block;padding:11px 16px;border-radius:8px;background:#111827;color:#ffffff;text-decoration:none;font-weight:700;">${escapeEmailHtml(ctaLabel)}</a></p>` : "",
    `<p style="font-size:12px;line-height:1.45;color:#6b7280;">${escapeEmailHtml(disclaimer)}</p>`,
    `</div>`
  ].join("");
  return { subject, textBody, htmlBody };
}

async function prepareInstantEstimateSubmission(form: JsonObject, body: JsonObject) {
  const latitude = estimatePayloadValue(body, "latitude") ?? estimatePayloadValue(body, "lat");
  const longitude = estimatePayloadValue(body, "longitude") ?? estimatePayloadValue(body, "lng");
  const measurement = asObject(await measureSolarRoof({ address: cleanText(body.address), latitude, longitude }));
  const estimate = instantEstimateFromMeasurement(form, body, measurement);
  return {
    status: "ready",
    measurement,
    estimate,
    calculated_at: nowIso()
  };
}

async function sendInstantEstimateEmail(form: JsonObject, body: JsonObject, result: JsonObject, created: JsonObject) {
  const email = normalizeEmail(body.email);
  if (!email) return { ok: false, success: false, error: "missing_customer_email" };
  const settings = asObject(form.estimate);
  if (settings.send_customer_email === false) return { ok: false, success: false, skipped: true, reason: "customer_email_disabled" };
  const message = buildInstantEstimateEmail(form, body, result);
  const project = asObject(created.project);
  return await sendTransactionalEmail({
    to: email,
    subject: message.subject,
    textBody: message.textBody,
    htmlBody: message.htmlBody,
    tag: "instant-estimate",
    metadata: {
      form_id: cleanText(form.id),
      project_id: cleanText(project.id)
    }
  });
}

async function previewInstantEstimate(form: JsonObject, body: JsonObject) {
  const latitude = estimatePayloadValue(body, "latitude") ?? estimatePayloadValue(body, "lat");
  const longitude = estimatePayloadValue(body, "longitude") ?? estimatePayloadValue(body, "lng");
  const [measurement, preview] = await Promise.all([
    measureSolarRoof({ address: cleanText(body.address), latitude, longitude }),
    previewSolarProperty({
      address: cleanText(body.address),
      latitude,
      longitude,
      tint: cleanText(body.tint || asObject(form.style).primary_color)
    })
  ]);
  const normalizedMeasurement = asObject(measurement);
  return {
    ok: true,
    status: "ready",
    measurement: normalizedMeasurement,
    estimate: instantEstimateFromMeasurement(form, body, normalizedMeasurement),
    preview: asObject(preview),
    calculated_at: nowIso()
  };
}

function leadEventsFromForm(form: JsonObject, body: JsonObject, schedulingData: JsonObject = {}) {
  const preferredStart = normalizePreferredStart(body.preferred_start_at || body.preferredStartAt);
  if (!preferredStart) return [];
  const eventType = eventTypeFromScheduling(schedulingData, form);
  return [{
    id: `event_${Date.now().toString(36)}${randomBytes(4).toString("hex")}`,
    event_type_default_id: eventType.id,
    type_id: eventType.id,
    title: eventType.id.replace(/_/g, " ").replace(/\b\w/g, (char) => char.toUpperCase()),
    start_at: preferredStart,
    duration_minutes: eventType.duration,
    buffer_minutes: eventType.bufferMinutes,
    required_role_ids: eventType.requiredRoleIds,
    allowed_role_ids: eventType.allowedRoleIds,
    assigned_user_ids: [],
    status: "requested",
    source: "embeddable_form"
  }];
}

export async function createProjectFromEmbeddableForm(assignment: EmbeddableFormAssignment, payload: JsonObject) {
  const form = normalizeEmbeddableForm(assignment.form);
  const schedulingData = await readSchedulingData(assignment.orgId, assignment.branchId);
  const name = cleanText(payload.name || payload.customer_name);
  const email = normalizeEmail(payload.email);
  const phone = cleanText(payload.phone);
  const address = cleanText(payload.address);
  const message = cleanText(payload.message || payload.notes || payload.project_info || payload.projectInfo);
  const contacts = name || email || phone ? [{ name, email, phone, phones: phone ? [phone] : [] }] : [];
  const targetRoleIds = Array.isArray(assignment.data.notification_target_role_ids)
    ? assignment.data.notification_target_role_ids.map(cleanText).filter(Boolean)
    : DEFAULT_NOTIFICATION_ROLES;
  const preferredStart = normalizePreferredStart(payload.preferred_start_at || payload.preferredStartAt);
  const sourceKind = form.mode === "instant_estimate" ? "instant_estimate" : form.mode === "submit_form" ? "submit_form" : "website_embed";
  return await createPlatformLead(assignment.orgId, {
    branch_id: assignment.branchId,
    stage_id: cleanText(assignment.data.project_stage_id) || NEW_LEAD_STAGE_ID,
    source_kind: sourceKind,
    address,
    title: address || name || cleanText(form.name) || "Website lead",
    summary: message,
    contacts,
    provider: "Embeddable Form",
    confidence: 1,
    events: form.mode === "appointment" || form.mode === "call" ? leadEventsFromForm(form, payload, schedulingData) : [],
    provider_fields: {
      form_id: form.id,
      form_name: form.name,
      tracking_key: form.tracking_key,
      mode: form.mode,
      preferred_start_at: preferredStart,
      page_url: cleanText(payload.page_url || payload.pageUrl),
      referrer: cleanText(payload.referrer),
      answers: asObject(payload.answers)
    },
    lead_source: {
      kind: sourceKind,
      provider: "Embeddable Form",
      form_id: form.id,
      form_name: form.name,
      tracking_key: form.tracking_key,
      mode: form.mode,
      preferred_start_at: preferredStart,
      page_url: cleanText(payload.page_url || payload.pageUrl),
      referrer: cleanText(payload.referrer),
      raw: payload
    },
    project_data: {
      embeddable_form: {
        id: form.id,
        name: form.name,
        tracking_key: form.tracking_key,
        mode: form.mode
      },
      website_form: {
        id: form.id,
        name: form.name,
        tracking_key: form.tracking_key,
        mode: form.mode
      },
      ...(form.mode === "instant_estimate" ? {
        instant_estimate: {
          status: "submitted",
          answers: asObject(payload.answers),
          result: asObject(payload.instant_estimate_result),
          measurement: asObject(asObject(payload.instant_estimate_result).measurement),
          estimate: asObject(asObject(payload.instant_estimate_result).estimate),
          estimate_settings: asObject(form.estimate)
        }
      } : {})
    },
    notification: {
      source: `${sourceKind}_lead_import`,
      title: form.mode === "instant_estimate" ? "New instant estimate lead" : form.mode === "call" ? "New website call request" : "New website form lead",
      body: address || name || message || "A website form was submitted.",
      target_role_ids: targetRoleIds,
      context: {
        form_id: form.id,
        tracking_key: form.tracking_key,
        preferred_start_at: preferredStart
      }
    }
  });
}

export async function publicFormConfigById(formId: string) {
  const assignment = await findEmbeddableFormAssignment(formId);
  if (!assignment) throw notFound("embeddable_form_not_found", "The requested embeddable form was not found.");
  await requireEmbeddableFormsFlag(assignment.orgId);
  await requireFormCapability(assignment.orgId, assignment.form);
  if (assignment.data.enabled === false || assignment.form.enabled === false) throw forbidden("embeddable_form_disabled", "This embeddable form is disabled.");
  return { ok: true, form: publicEmbeddableForm(assignment.form) };
}

export async function publicFormAvailabilityById(formId: string, query: JsonObject) {
  const assignment = await findEmbeddableFormAssignment(formId);
  if (!assignment) throw notFound("embeddable_form_not_found", "The requested embeddable form was not found.");
  await requireEmbeddableFormsFlag(assignment.orgId);
  await requireFormCapability(assignment.orgId, assignment.form);
  if (assignment.data.enabled === false || assignment.form.enabled === false) throw forbidden("embeddable_form_disabled", "This embeddable form is disabled.");
  return await embeddableFormAvailability(assignment, query);
}

export async function publicSolarPreviewByFormId(formId: string, body: JsonObject) {
  const assignment = await findEmbeddableFormAssignment(formId);
  if (!assignment) throw notFound("embeddable_form_not_found", "The requested embeddable form was not found.");
  await requireEmbeddableFormsFlag(assignment.orgId);
  await requireFormCapability(assignment.orgId, assignment.form);
  if (assignment.data.enabled === false || assignment.form.enabled === false) throw forbidden("embeddable_form_disabled", "This embeddable form is disabled.");
  const form = normalizeEmbeddableForm(assignment.form);
  if (form.mode !== "instant_estimate") throw badRequest("not_instant_estimate_form", "Solar preview is only available for instant estimate forms.");
  const style = asObject(form.style);
  return await previewSolarProperty({
    address: cleanText(body.address),
    latitude: body.latitude ?? body.lat,
    longitude: body.longitude ?? body.lng,
    tint: cleanText(body.tint || style.primary_color)
  });
}

export async function authenticatedInstantEstimatePreview(orgId: string, branchId: string, formId: string, body: JsonObject) {
  const { data } = await ensureLeadIntakeSettings(orgId, branchId || DEFAULT_BRANCH_ID);
  const targetId = cleanText(formId);
  const form = asArray(data.forms).map(asObject).find((entry) => cleanText(entry.id) === targetId);
  if (!form) throw notFound("embeddable_form_not_found", "The requested embeddable form was not found.");
  await requireFormCapability(orgId, form);
  const normalized = normalizeEmbeddableForm(form);
  if (normalized.mode !== "instant_estimate") throw badRequest("not_instant_estimate_form", "Instant estimate preview is only available for instant estimate forms.");
  if (!cleanText(body.address) && !cleanText(body.latitude || body.lat)) throw badRequest("missing_address", "Enter an address to preview the instant estimate.");
  return await previewInstantEstimate(normalized, body);
}

export async function submitPublicFormById(formId: string, body: JsonObject) {
  const assignment = await findEmbeddableFormAssignment(formId);
  if (!assignment) throw notFound("embeddable_form_not_found", "The requested embeddable form was not found.");
  await requireEmbeddableFormsFlag(assignment.orgId);
  await requireFormCapability(assignment.orgId, assignment.form);
  if (assignment.data.enabled === false || assignment.form.enabled === false) throw forbidden("embeddable_form_disabled", "This embeddable form is disabled.");
  const form = normalizeEmbeddableForm(assignment.form);
  const hasContact = cleanText(body.name || body.customer_name) || normalizeEmail(body.email) || cleanText(body.phone);
  const hasLeadData = hasContact || cleanText(body.address) || cleanText(body.message || body.notes || body.project_info || body.projectInfo);
  if (!hasLeadData) throw badRequest("lead_missing_contact_data", "A form submission needs a name, phone, email, address, or message.");
  const instantEstimateResult = form.mode === "instant_estimate" ? await prepareInstantEstimateSubmission(form, body) : null;
  const created = await createProjectFromEmbeddableForm({ ...assignment, form }, {
    ...body,
    ...(instantEstimateResult ? { instant_estimate_result: instantEstimateResult } : {})
  });
  const instantEstimateEmail = instantEstimateResult
    ? await sendInstantEstimateEmail(form, body, instantEstimateResult, asObject(created)).catch((error) => ({
        ok: false,
        success: false,
        error: error instanceof Error ? error.message : "email_send_failed"
      }))
    : null;
  return {
    ok: true,
    accepted: true,
    form: { id: form.id, name: form.name, tracking_key: form.tracking_key, mode: form.mode },
    project: created.project,
    contacts: created.contacts,
    notification: created.notification,
    ...(instantEstimateResult ? {
      instant_estimate: {
        ...instantEstimateResult,
        email: instantEstimateEmail
      }
    } : {})
  };
}

export const registerLeadIntakeApi: FastifyPluginAsync = async (app) => {
  app.setErrorHandler((error, _request, reply) => {
    if (error instanceof ZodError) {
      reply.code(400);
      return reply.send({ ok: false, error: "validation_error", issues: error.issues });
    }
    if (error instanceof PlatformError) {
      reply.code(error.statusCode);
      return reply.send({ ok: false, error: error.code, message: error.message, details: error.details ?? null });
    }
    app.log.error(error);
    reply.code(500);
    return reply.send({ ok: false, error: "internal_error", message: "An unexpected error occurred." });
  });

  app.get("/", async () => ({
    ok: true,
    api: "lead-intake",
    embeddableForms: {
      settings: "/v1/lead-intake/organizations/:orgId/branch/:branchId/settings",
      forms: "/v1/lead-intake/organizations/:orgId/branch/:branchId/forms",
      publicForm: "/v1/lead-intake/public/forms/:formId",
      publicAvailability: "/v1/lead-intake/public/forms/:formId/availability",
      publicSubmit: "/v1/lead-intake/public/forms/:formId/submit",
      publicSolarPreview: "/v1/lead-intake/public/forms/:formId/solar-preview",
      authenticatedInstantPreview: "/v1/lead-intake/organizations/:orgId/branch/:branchId/forms/:formId/instant-estimate-preview",
      instantEstimate: "POST /v1/lead-intake/public/forms/:formId/submit for forms with mode=instant_estimate"
    }
  }));

  app.get("/organizations/:orgId/branch/:branchId/settings", async (request) => {
    const orgId = getParam(request.params, "orgId");
    const branchId = getParam(request.params, "branchId") || DEFAULT_BRANCH_ID;
    await requirePlatformAuth(request, { orgId, permission: "manage_company_settings" });
    await requireEmbeddableFormsFlag(orgId);
    const { module, data } = await ensureLeadIntakeSettings(orgId, branchId);
    return { ok: true, settings: data, module };
  });

  app.patch("/organizations/:orgId/branch/:branchId/settings", async (request) => {
    const orgId = getParam(request.params, "orgId");
    const branchId = getParam(request.params, "branchId") || DEFAULT_BRANCH_ID;
    await requirePlatformAuth(request, { orgId, csrf: true, permission: "manage_company_settings" });
    await requireEmbeddableFormsFlag(orgId);
    const body = objectBodySchema.parse(request.body ?? {});
    const { module, data } = await patchLeadIntakeSettings(orgId, branchId, body);
    return { ok: true, settings: data, module };
  });

  app.get("/organizations/:orgId/branch/:branchId/forms", async (request) => {
    const orgId = getParam(request.params, "orgId");
    const branchId = getParam(request.params, "branchId") || DEFAULT_BRANCH_ID;
    await requirePlatformAuth(request, { orgId, permission: "manage_company_settings" });
    await requireEmbeddableFormsFlag(orgId);
    const { data } = await ensureLeadIntakeSettings(orgId, branchId);
    return { ok: true, forms: asArray(data.forms).map(asObject) };
  });

  app.put("/organizations/:orgId/branch/:branchId/forms", async (request) => {
    const orgId = getParam(request.params, "orgId");
    const branchId = getParam(request.params, "branchId") || DEFAULT_BRANCH_ID;
    await requirePlatformAuth(request, { orgId, csrf: true, permission: "manage_company_settings" });
    await requireEmbeddableFormsFlag(orgId);
    const body = objectBodySchema.parse(request.body ?? {});
    const forms = Array.isArray(body.forms) ? body.forms : [];
    const { data } = await patchLeadIntakeSettings(orgId, branchId, { forms });
    return { ok: true, forms: asArray(data.forms).map(asObject), settings: data };
  });

  app.post("/organizations/:orgId/branch/:branchId/forms/:formId/instant-estimate-preview", async (request) => {
    const orgId = getParam(request.params, "orgId");
    const branchId = getParam(request.params, "branchId") || DEFAULT_BRANCH_ID;
    await requirePlatformAuth(request, { orgId, csrf: true, permission: "manage_company_settings" });
    await requireEmbeddableFormsFlag(orgId);
    return authenticatedInstantEstimatePreview(orgId, branchId, getParam(request.params, "formId"), objectBodySchema.parse(request.body ?? {}));
  });

  app.get("/public/forms/:formId", async (request) => publicFormConfigById(getParam(request.params, "formId")));
  app.get("/public/forms/:formId/availability", async (request) => publicFormAvailabilityById(getParam(request.params, "formId"), asObject(request.query)));
  app.post("/public/forms/:formId/solar-preview", async (request) => {
    return publicSolarPreviewByFormId(getParam(request.params, "formId"), objectBodySchema.parse(request.body ?? {}));
  });
  app.post("/public/forms/:formId/submit", async (request, reply) => {
    const result = await submitPublicFormById(getParam(request.params, "formId"), objectBodySchema.parse(request.body ?? {}));
    reply.code(201);
    return result;
  });
};
